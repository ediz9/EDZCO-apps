'use strict';
/*
 * edzco_lights ("Lights") - flashes the exterior lamps in patterns through the body
 * controller's own test functions.
 *
 * The app decides what should run and draws the screen; the edzco-lights service owns the
 * diagnostic link and writes the lamp functions. See that tool's README for the UDS.
 *
 * Patterns come in two groups:
 *   show    parked only; free to hold a lamp dark, because nobody reads it as a signal
 *   moving  may run while driving - only lamps normally off while driving, released
 *           between every flash, and each with its own speed ceiling
 *
 * Piyasa and Wig-Wag use the high beams, so they carry `danger` and need a confirm. That
 * confirm is a second press on the same card, not a dialog: there is no window.confirm in
 * this runtime, and a two-press confirm suits the iDrive knob better than a modal anyway.
 *
 * The car's state (selector, road speed, doors, locked-and-left) comes from
 * shared/edzco_vehicle.js, read and scaled the way the kit's own Car and parked do.
 */
const net = require('net');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Vehicle = require('./edzco_vehicle');

const CTL = process.env.EDZCO_LIGHTS_CTL || '/run/edzco-lights/ctl.sock';
const RETRY_MS = 2000;
const W = 1600, H = 520;
const CONFIRM_MS = 5000;     // a danger arm lapses, so a stray press never leaves one primed

/* ------------------------------------------------------------- lights service */
function Ctl(log) {
    const self = {
        sock: null, buf: '', pending: new Map(), seq: 0, connected: false, onUp: null,
        connect() {
            try { self.sock = net.connect(CTL); }
            catch (e) { self.retry(); return; }
            self.sock.on('connect', () => {
                self.connected = true;
                log.info('lights service connected');
                if (self.onUp) self.onUp();
            });
            self.sock.on('data', (c) => {
                self.buf += c.toString('utf8');
                let i;
                while ((i = self.buf.indexOf('\n')) >= 0) {
                    const line = self.buf.slice(0, i).trim();
                    self.buf = self.buf.slice(i + 1);
                    if (!line) continue;
                    let msg;
                    try { msg = JSON.parse(line); } catch (e) { continue; }
                    // the service answers requests as they finish, not in order: pair by seq
                    const cb = self.pending.get(msg.seq);
                    if (cb) { self.pending.delete(msg.seq); cb(msg); }
                }
            });
            self.sock.on('error', () => {});
            self.sock.on('close', () => {
                self.connected = false;
                const left = Array.from(self.pending.values());
                self.pending.clear();
                left.forEach((cb) => cb({ error: 'disconnected' }));
                self.retry();
            });
        },
        retry() {
            try { if (self.sock) self.sock.destroy(); } catch (e) {}
            self.sock = null;
            setTimeout(() => self.connect(), RETRY_MS);
        },
        send(msg) {
            return new Promise((res) => {
                if (!self.connected || !self.sock) { res({ error: 'not connected' }); return; }
                const seq = ++self.seq;
                self.pending.set(seq, res);
                try { self.sock.write(JSON.stringify(Object.assign({}, msg, { seq })) + '\n'); }
                catch (e) { self.pending.delete(seq); res({ error: String(e.message || e) }); }
            });
        },
    };
    return self;
}

/* --------------------------------------------------------------------- app */
mgu.run({
    async start(ctx) {
        const { ui, log, settings } = ctx;
        const ctl = Ctl(log);

        let patterns = [];          // from the tool
        let idx = 0;                // the focused pattern
        let playing = null;
        let armedDanger = null, armedAt = 0;
        let toolState = { connected: false, layouts: { bdcOut: null }, capable: {} };
        let note = '';
        let checkRunning = false;


        ctl.onUp = () => {
            ctl.send({ op: 'list_patterns' }).then((r) => {
                patterns = (r && r.patterns) || [];
                log.info('patterns: ' + patterns.length);
                render().catch(() => {});
            });
            poll();
        };
        ctl.connect();

        function poll() {
            ctl.send({ op: 'get' }).then((r) => {
                if (!r || !r.state) return;
                toolState = Object.assign(toolState, r.state);
                // the service runs the pattern: a pattern that ended on its own (or never started) is not playing
                playing = r.state.activePattern || null;
            });
        }
        setInterval(poll, 1000);

        /* ---- the car: the gates the service checks again on its side ---- */
        let doorsWere = null, awayWas = null;
        const car = Vehicle.watch(ctx, { speed: true, gear: true, doors: true, condition: true }, (what, v) => {
            if (what === 'doors') {
                // a door opening on a parked car with the ignition off: welcome
                if (doorsWere === false && v.doorsOpen && settings.get('autoWelcome') && v.parked() && !v.ignition()) {
                    log.info('auto-welcome on door open');
                    play(find('welcome'), true).catch(() => {});
                }
                doorsWere = v.doorsOpen;
            } else if (what === 'condition') {
                // locked and left: goodbye
                const away = v.away();
                if (awayWas === false && away && settings.get('autoGoodbye')) {
                    log.info('auto-goodbye on locked and left');
                    play(find('goodbye'), true).catch(() => {});
                }
                awayWas = away;
            }
        });

        const find = (id) => patterns.find((p) => p.id === id);

        /* ---- running a pattern ---- */
        async function play(p, auto) {
            if (!p) return;
            const msg = { op: 'play', id: p.id, parked: car.parked(), speed: car.speed };
            if (p.danger) msg.danger = true;              // the UI confirmed before calling
            const r = await ctl.send(msg);
            if (r && r.error) { note = r.error; log.warn('play ' + p.id + ': ' + r.error); }
            else { playing = p.id; note = (auto ? 'otomatik: ' : '') + p.name; }
            render().catch(() => {});
        }

        async function stop() {
            await ctl.send({ op: 'stop' });
            playing = null; note = 'durduruldu';
            render().catch(() => {});
        }

        /* ---- buttons, as declared in app.json "screens" ---- */
        ui.onClick('BTN_PLAY', () => {
            const p = patterns[idx];
            if (!p) return render();
            if (playing === p.id) { stop().catch(() => {}); return render(); }

            // high-beam patterns: a second press on the same one confirms
            if (p.danger && settings.get('confirmDanger')) {
                const fresh = armedDanger === p.id && Date.now() - armedAt < CONFIRM_MS;
                if (!fresh) {
                    armedDanger = p.id; armedAt = Date.now();
                    note = 'Selektor kullanir - onaylamak icin tekrar bas';
                    return render();
                }
            }
            armedDanger = null;
            play(p, false).catch(() => {});
            return render();
        });

        ui.onClick('BTN_PAGE', () => {
            if (patterns.length) idx = (idx + 1) % patterns.length;
            armedDanger = null;
            return render();
        });

        ui.onClick('BTN_ACTION', () => {
            if (checkRunning) return render();
            if (!car.parked()) { note = 'Lamp check sadece parkta'; return render(); }
            checkRunning = true;
            note = 'Lamp check calisiyor (~50 sn)';
            ctl.send({ op: 'lamp_check', parked: true }).then((r) => {
                checkRunning = false;
                if (r && r.state) toolState = Object.assign(toolState, r.state);
                note = r && r.error ? r.error : 'Lamp check bitti';
                render().catch(() => {});
            });
            return render();
        });

        ui.onClick('BTN_BACK', () => { stop().catch(() => {}); return render(); });

        /* ---- the screen ---- */
        async function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const p = patterns[idx];

            G.panel(cv, t, 40, 44, 520, 430, 'Patterns');
            if (!patterns.length) {
                cv.text(ctl.connected ? 'pattern yok' : 'edzco-lights servisi yok',
                        300, 240, 18, t.dim, { align: 'center' });
            } else {
                const first = Math.max(0, Math.min(idx - 2, patterns.length - 6));
                patterns.slice(first, first + 6).forEach((q, i) => {
                    const y = 116 + i * 58, on = (first + i) === idx;
                    if (on) cv.roundRect(60, y - 20, 480, 52, 6, t.sel || t.accent);
                    cv.text(q.name, 80, y, 19, on ? '#ffffff' : t.text, { font: on ? 'bold' : null });
                    const tag = (q.group === 'moving' ? 'HAREKET' : 'PARK')
                        + (q.maxSpeedKmh ? '  <=' + q.maxSpeedKmh + ' km/h' : '')
                        + (q.danger ? '  SELEKTOR' : '');
                    cv.text(tag, 80, y + 22, 13, on ? '#ffffff' : t.dim, { spacing: 1 });
                    if (playing === q.id) cv.text('>', 520, y, 20, on ? '#ffffff' : t.accent, { align: 'right' });
                });
            }

            G.panel(cv, t, 600, 44, 960, 430, p ? p.name : 'Lights');
            const big = playing ? 'CALIYOR' : (armedDanger ? 'ONAY' : 'HAZIR');
            cv.text(big, 1080, 160, 56, playing ? t.accent : (armedDanger ? t.warn : t.dim),
                    { align: 'center', font: 'bold', spacing: 5 });
            if (p) cv.text(p.description || '', 1080, 206, 16, t.dim, { align: 'center' });
            if (note) cv.text(note, 1080, 240, 16, armedDanger ? t.warn : t.dim, { align: 'center' });

            // what the car told us about its own lamps
            const lay = toolState.layouts && toolState.layouts.bdcOut;
            const good = Object.keys(toolState.capable || {})
                .filter((k) => toolState.capable[k] && toolState.capable[k].ok).length;
            const info = [
                ['Vites', car.stage || (car.parked() ? 'P (duruyor)' : '-')],
                ['Hiz', car.speed == null ? '-' : Math.round(car.speed) + ' km/h'],
                ['BDC duzeni', lay || (checkRunning ? '...' : 'bilinmiyor')],
                ['Cevap veren lamba', good ? String(good) : (checkRunning ? '...' : '-')],
            ];
            info.forEach((r, i) => {
                const x = 660 + (i % 2) * 460, y = 320 + Math.floor(i / 2) * 62;
                cv.text(r[0], x, y, 14, t.dim, { spacing: 1 });
                cv.text(r[1], x, y + 26, 22, t.text, { font: 'num' });
            });

            if (!ctl.connected) {
                cv.roundRect(600, 44, 960, 30, 6, t.crit || '#ef2b2d');
                cv.text('edzco-lights servisi yok - Store\'dan Exterior Lights aracini kur',
                        1080, 65, 16, '#ffffff', { align: 'center', font: 'bold' });
            }

            return ui.image('MAIN_GFX', cv);
        }

        ctx.loop('MAIN', 6, render);
        await render();
        log.info('ready');

        return { play, stop, patterns: () => patterns };
    },
});
