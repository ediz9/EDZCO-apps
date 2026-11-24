'use strict';
/*
 * edzco_popbang ("Pop-Bang") - plays an overrun effect through the car's speakers when you
 * lift off the throttle after a rev, the moment a real exhaust crackles.
 *
 * It does NOT touch the engine. Nothing is written to the DME, no valve is moved, no coding
 * changes. The car's exhaust does what it always does; this adds a sound on top of it, at
 * the right instant.
 *
 * Two halves
 *   this app      watches engine speed, decides a lift happened, brings the AudioManager
 *                 route up and down around the sound, and draws the screen
 *   edzco-sound   writes the PCM into the routed device. A root service, because an OAP app
 *                 has no access to the audio devices - Zeiger's Sound Test was removed over
 *                 exactly this.
 *
 * The audio route (moonride's, car-tested on an X5 G05)
 *   source 287  SmartX CarLifeMedia - China-only, so the slot is free on our cars
 *   sink  1024  the main speaker
 * Source 287 is A_UNAVAILABLE without a CarLife phone, and a connect to it then hangs in
 * CS_CONNECTING for ever, so it is marked available on the routing side FIRST, connected,
 * and put back to unavailable after. Leftovers from a crash are swept at start.
 *
 * Detecting the lift
 * Arm once engine speed passes armRpm. With the accelerator pedal signal
 * (AcceleratorPedal.AngleAcceleratorPedal, as idrive7-apps' live_data reads it), fire the
 * moment the pedal comes up from a press to closed - the instant the real crackle starts.
 * A unit without that interface falls back to engine speed: fire when rpm drops faster than
 * dropRpmPerSec. Either way a cooldown makes one lift one effect.
 *
 * Signals are read and scaled by shared/edzco_vehicle.js the way the kit's own Car does.
 */
const net = require('net');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Vehicle = require('./edzco_vehicle');

const CTL = process.env.EDZCO_SOUND_CTL || '/run/edzco-sound/ctl.sock';
const RETRY_MS = 2000;
const W = 1600, H = 520;

// AudioManager, as moonride uses it
const AM_IFACE = 'org.genivi.am.commandinterface.CommandControl';
const AMR_IFACE = 'org.genivi.am.routinginterface.RoutingControlObserver';
const AM_SRC = 287;      // SmartX CarLifeMedia
const AM_SINK = 1024;    // main speaker
const ROUTE_LINGER_MS = 4000;   // hold the route after a sound, so a quick second lift does
                                // not pay the connect cost again
const PREWARM_RETRY_MS = 5000;  // a route that would not come up is not retried on every rpm sample

/* ------------------------------------------------------------------ detector */
/**
 * Calls onLift({ peakRpm, dropRate, level }) when a rev-then-lift is seen. It timestamps
 * its own samples, so an irregular publish rate does not skew the derivative.
 */
const PEDAL_PRESSED = 25;   // % - a real press, not resting a foot on it
const PEDAL_CLOSED = 4;     // % - lifted

function OverrunDetector(cfg, onLift) {
    let lastRpm = null, lastAt = 0, peak = 0, armed = false, lastFireAt = -Infinity, rate = 0;
    let pedalLive = false, pressed = false;

    function fire(now, how) {
        armed = false;
        if (now - lastFireAt < cfg.cooldownMs()) { peak = 0; return; }
        lastFireAt = now;
        const drop = Math.max(0, -rate);
        onLift({ peakRpm: Math.round(peak), dropRate: Math.round(drop), level: level(peak, drop), by: how });
        peak = 0; rate = 0;
    }

    function level(peakRpm, drop) {
        let l = 1;
        if (peakRpm >= 3000) l = 2;
        if (peakRpm >= 4000) l = 3;
        if (peakRpm >= 5200) l = 4;
        if (peakRpm >= 6200) l = 5;
        if (drop >= 2600 && l < 5) l += 1;   // a sharp lift counts for one more
        return l;
    }

    return {
        feed(rpm, nowMs) {
            const now = typeof nowMs === 'number' ? nowMs : Date.now();
            if (typeof rpm !== 'number' || !(rpm >= 0)) return;
            if (lastRpm === null) { lastRpm = rpm; lastAt = now; return; }
            const dt = (now - lastAt) / 1000;
            if (dt <= 0.001) return;                       // the same sample twice
            rate = rate * 0.6 + ((rpm - lastRpm) / dt) * 0.4;   // light smoothing: raw rpm is steppy
            lastRpm = rpm; lastAt = now;
            if (rpm > peak) peak = rpm;

            if (!armed) { if (rpm >= cfg.armRpm()) { armed = true; peak = rpm; } return; }

            // with a live pedal, the pedal decides the instant; rpm only arms
            if (!pedalLive && rate <= -cfg.dropRpmPerSec()) { fire(now, 'rpm'); return; }
            // fell back below the arm point without a sharp lift: forget it
            if (rpm < cfg.armRpm() * 0.72) { armed = false; peak = 0; }
        },
        /** accelerator pedal, 0-100 %; live = the signal is arriving */
        pedal(pct, live, nowMs) {
            const now = typeof nowMs === 'number' ? nowMs : Date.now();
            pedalLive = !!live;
            if (!pedalLive || typeof pct !== 'number') { pressed = false; return; }
            if (pct >= PEDAL_PRESSED) { pressed = true; return; }
            if (pct <= PEDAL_CLOSED && pressed) {
                pressed = false;
                if (armed) fire(now, 'pedal');
            }
        },
        reset() { lastRpm = null; peak = 0; armed = false; rate = 0; pressed = false; },
        get armed() { return armed; },
        get peak() { return peak; },
        get rate() { return rate; },
    };
}

/* -------------------------------------------------------------- sound service */
function Ctl(log) {
    const self = {
        sock: null, buf: '', pending: new Map(), seq: 0, connected: false, onUp: null,
        connect() {
            try { self.sock = net.connect(CTL); }
            catch (e) { self.retry(); return; }
            self.sock.on('connect', () => {
                self.connected = true;
                log.info('sound service connected');
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

/* ------------------------------------------------------------- AudioManager */
/*
 * moonride's sequence (apps/jap_moonride/main.js, car-tested): proxies waited for until their
 * provider is there (a fresh proxy answers "Service unavailable" before that), leftovers swept,
 * 287 marked available, connect, and the connection is CS_CONNECTED "in < 1 s". The sound
 * goes out only once it is: before that smartx takes no PCM from the source.
 */
const CONNECTED_WAIT_MS = 2500;

function connectionsOf(r) {
    if (Array.isArray(r)) return r;
    if (r && Array.isArray(r.listConnections)) return r.listConnections;
    return (r && Object.values(r).find(Array.isArray)) || [];
}
const isConnected = (c) => c && (c.connectionState === 'CS_CONNECTED' || c.connectionState === 2);

function CarAudio(signals, log, onChange) {
    const st = { cmd: null, routing: null, id: null, up: false, q: Promise.resolve(), swept: false,
                 state: 'kapali', error: null };
    const set = (state, error) => {
        st.state = state;
        if (error !== undefined) st.error = error;
        if (onChange) onChange();
    };

    async function proxyFor(iface) {
        const p = await signals.proxy(iface, '1');
        let avail = false;
        await new Promise((res) => {
            const t = setTimeout(res, 5000);
            Promise.resolve(signals.onAvailable(p, (a) => { if (a) { avail = true; clearTimeout(t); res(); } }))
                .catch(() => {});
        });
        if (!avail) log.warn('car audio: ' + iface + ' not available after 5 s, trying anyway');
        return p;
    }
    const setAvailable = (on) => signals.call(st.routing, 'hookSourceAvailablityStatusChange', {
        sourceID: AM_SRC,
        availability: { availability: on ? 'A_AVAILABLE' : 'A_UNAVAILABLE', availabilityReason: 0 },
    }).then(() => log.info('car audio: source ' + (on ? 'available' : 'unavailable')));

    async function list() {
        return connectionsOf(await signals.call(st.cmd, 'getListMainConnections', {}));
    }
    async function sweep() {
        const r = await signals.call(st.cmd, 'getListMainConnections', {});
        if (!st.swept) { st.swept = true; log.info('car audio connections: ' + JSON.stringify(r).slice(0, 600)); }
        for (const c of connectionsOf(r).filter((c) => c && c.sourceID === AM_SRC)) {
            log.info('car audio: clearing leftover ' + c.mainConnectionID);
            await signals.call(st.cmd, 'disconnect', { mainConnectionID: c.mainConnectionID }).catch(() => {});
        }
    }
    async function ensure() {
        if (st.cmd && st.routing) return;
        set('proxy');
        try {
            st.cmd = await proxyFor(AM_IFACE);
            st.routing = await proxyFor(AMR_IFACE);
        } catch (e) {
            st.cmd = st.routing = null;
            throw e;
        }
        await sweep().catch((e) => log.warn('car audio sweep: ' + e));
        await setAvailable(false).catch((e) => log.warn('car audio availability: ' + e));
    }
    async function waitConnected() {
        const until = Date.now() + CONNECTED_WAIT_MS;
        let last = null;
        while (Date.now() < until) {
            const c = (await list().catch(() => [])).find((c) => c && c.sourceID === AM_SRC
                && (st.id == null || c.mainConnectionID === st.id));
            last = c ? c.connectionState : 'none';
            if (isConnected(c)) return { ok: true, state: last };
            await new Promise((r) => setTimeout(r, 100));
        }
        return { ok: false, state: last };
    }

    return {
        /** resolves once the route is connected (or has given up; the sound is tried anyway) */
        up() {
            st.q = st.q.then(async () => {
                if (st.up) return;
                const t0 = Date.now();
                await ensure();
                set('baglaniyor');
                await setAvailable(true);
                const r = await signals.call(st.cmd, 'connect', { sourceID: AM_SRC, sinkID: AM_SINK });
                const ok = r && (r.amError === 'E_OK' || r.amError === 'E_ALREADY_EXISTS' || r.amError === 0);
                if (!ok) {
                    log.warn('car audio: connect REFUSED ' + JSON.stringify(r));
                    set('RED', 'connect: ' + JSON.stringify(r).slice(0, 80));
                    await setAvailable(false).catch(() => {});
                    return;
                }
                st.id = r.mainConnectionID != null ? r.mainConnectionID : null;
                st.up = true;
                const w = await waitConnected();
                log.info('car audio: connect id=' + st.id + ', ' + w.state + ' after ' + (Date.now() - t0) + ' ms');
                set(w.ok ? 'bagli' : 'bagli degil', w.ok ? null : 'baglanti ' + w.state);
            }).catch((e) => {
                log.warn('car audio up: ' + e);
                // a failed call leaves nothing worth keeping: start over from the proxies
                st.cmd = st.routing = null; st.up = false; st.id = null;
                set('hata', String(e.message || e).slice(0, 80));
            });
            return st.q;
        },
        down() {
            st.q = st.q.then(async () => {
                if (!st.up) return;
                if (st.id != null) {
                    await signals.call(st.cmd, 'disconnect', { mainConnectionID: st.id }).catch(() => {});
                    st.id = null;
                } else await sweep().catch(() => {});
                await setAvailable(false).catch(() => {});
                st.up = false;
                set('kapali');
            }).catch((e) => { st.up = false; log.warn('car audio down: ' + e); set('kapali'); });
            return st.q;
        },
        get isUp() { return st.up; },
        get state() { return st.state; },
        get error() { return st.error; },
    };
}

/** text cut into lines of at most n characters, at spaces where it can */
function wrap(text, n) {
    const out = [];
    let rest = String(text);
    while (rest.length > n) {
        let cut = rest.lastIndexOf(' ', n);
        if (cut < n * 0.5) cut = n;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out;
}

/* --------------------------------------------------------------------- app */
mgu.run({
    async start(ctx) {
        const { ui, log, settings } = ctx;

        const ctl = Ctl(log);
        const carAudio = CarAudio(ctx.signals, log, () => render().catch(() => {}));

        let effects = [];
        let lastFired = null, lastAt = 0, lastPicked = null;
        let lastResult = null;           // what the sound service said about the last play
        let routeDownTimer = null;
        let testIdx = 0;

        // the device check at every connect: its outcome goes on the screen, so whether this
        // unit can play at all is visible without a PC
        let device = null;           // { ok, text }
        function readProbe(p) {
            if (!p) return { ok: false, text: 'servis cevap vermedi' };
            const py = p.python || {};
            if (p.backend === 'pcm.py') {
                if (py.ok) return { ok: true, text: 'hazir (pcm.py, ' + (p.device || '') + ')' };
                const e = py.error || (py.libasound !== 'loaded' && py.libasound) || py.open || py.params || 'bilinmeyen';
                return { ok: false, text: (py.libasound !== 'loaded' ? 'libasound: ' : py.open ? 'open: ' : py.params ? 'params: ' : '') + e };
            }
            return { ok: !/NOT FOUND/.test(p.aplay || ''), text: 'aplay: ' + (p.aplay || '?') + ' (mgu-python yok)' };
        }
        ctl.onUp = () => {
            ctl.send({ op: 'list' }).then((r) => {
                effects = (r && r.effects) || [];
                log.info('effects available: ' + effects.length);
                render().catch(() => {});
            });
            device = { ok: null, text: 'kontrol ediliyor' };
            ctl.send({ op: 'probe' }).then((r) => {
                device = r && r.error ? { ok: false, text: 'probe: ' + r.error } : readProbe(r && r.probe);
                log.info('sound device: ' + JSON.stringify(r).slice(0, 1500));
                render().catch(() => {});
            });
        };
        ctl.connect();

        /* ---- engine speed: the whole detector ---- */
        const detector = OverrunDetector({
            armRpm: () => Number(settings.get('armRpm')) || 3000,
            dropRpmPerSec: () => Number(settings.get('dropRpmPerSec')) || 1400,
            cooldownMs: () => Number(settings.get('cooldownMs')) || 2000,
        }, (info) => { fire(info).catch((e) => log.warn('fire: ' + e)); });

        const car = Vehicle.watch(ctx, { rpm: true, speed: true, pedal: true }, (what, v) => {
            if (what === 'rpm') { detector.feed(v.rpm); prewarm(); }
            else if (what === 'pedal') detector.pedal(v.pedal, true);
        });
        // a pedal that goes quiet hands the decision back to engine speed
        setInterval(() => { if (!car.pedalLive()) detector.pedal(null, false); }, 500);

        /* ---- which effect plays ---- */
        function pickEffect(level) {
            if (!effects.length) return null;
            const mode = settings.get('effectMode') || 'random';

            if (mode !== 'random' && mode !== 'level') {
                const exact = effects.find((e) => e.id === mode);
                if (exact) return exact;          // pinned; a stale pin falls through to random
            }
            if (mode === 'level') {
                let best = effects[0], bestD = Infinity;
                for (const e of effects) {
                    const d = Math.abs((e.level || 3) - level) + ((e.level || 3) > level ? 0.5 : 0);
                    if (d < bestD) { bestD = d; best = e; }
                }
                return best;
            }
            // random, never twice running - a repeat is what makes a sample sound like one
            if (effects.length === 1) return effects[0];
            let pick;
            do { pick = effects[Math.floor(Math.random() * effects.length)]; }
            while (lastPicked && pick.id === lastPicked);
            lastPicked = pick.id;
            return pick;
        }

        // the route is held for a while after a sound and while armed, so the next lift does
        // not wait for a connect
        function holdRoute(ms) {
            clearTimeout(routeDownTimer);
            routeDownTimer = setTimeout(() => {
                if (detector.armed) { holdRoute(ROUTE_LINGER_MS); return; }
                carAudio.down();
            }, ms);
        }

        // armed = a lift is coming: bring the route up now, so the sound is on time. A connect
        // takes up to a second (moonride: "CS_CONNECTED in < 1 s"), a pop is over in less.
        let prewarmAt = 0;
        function prewarm() {
            if (!detector.armed || carAudio.isUp || !settings.get('enabled') || settings.get('prewarm') === false) return;
            if (settings.get('parkedOnly') && (car.speed === null || car.moving())) return;
            if (Date.now() - prewarmAt < PREWARM_RETRY_MS) return;
            prewarmAt = Date.now();
            carAudio.up().then(() => { if (carAudio.isUp) holdRoute(ROUTE_LINGER_MS); });
        }

        async function play(fx, why) {
            clearTimeout(routeDownTimer);
            lastFired = fx; lastAt = Date.now();
            lastResult = { text: 'rota aciliyor', ok: null };
            render().catch(() => {});
            await carAudio.up();
            lastResult = { text: 'caliyor', ok: null };
            const r = await ctl.send({ op: 'play', id: fx.id });
            if (r && r.error) {
                log.warn('play ' + fx.id + ': ' + r.error);
                lastResult = { text: r.error, ok: false };
            } else {
                log.info('played ' + fx.id + ' (' + why + ') ' + (r.ms || 0) + ' ms via ' + r.backend
                         + (r.waitedMs ? ', device waited ' + r.waitedMs + ' ms' : ''));
                lastResult = { text: 'calindi ' + (r.ms || 0) + ' ms (' + r.backend + ')', ok: true };
            }
            lastAt = Date.now();
            holdRoute(ROUTE_LINGER_MS);
            render().catch(() => {});
        }

        async function fire(info) {
            if (!settings.get('enabled')) return;
            if (settings.get('parkedOnly') && (car.speed === null || car.moving())) return;
            const fx = pickEffect(info.level);
            if (!fx) { log.warn('lift seen but no effects loaded'); return; }
            log.info('lift: peak ' + info.peakRpm + ' rpm, dropping ' + info.dropRate + ' rpm/s -> L' + info.level + ' by ' + info.by);
            await play(fx, 'L' + info.level);
        }

        /* ---- buttons, as declared in app.json "screens" ---- */
        ui.onClick('BTN_ACTION', () => {
            settings.set('enabled', !settings.get('enabled'));
            return render();
        });
        ui.onClick('BTN_PLAY', () => {
            const fx = effects[testIdx % Math.max(effects.length, 1)];
            if (fx) play(fx, 'test').catch(() => {});
            return render();
        });
        ui.onClick('BTN_PAGE', () => {
            if (effects.length) testIdx = (testIdx + 1) % effects.length;
            return render();
        });

        /* ---- the screen ---- */
        async function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const on = !!settings.get('enabled');
            const armed = detector.armed;

            G.panel(cv, t, 40, 44, 460, 430, 'Motor');
            cv.text(car.rpm == null ? '--' : String(Math.round(car.rpm)), 270, 170, 76,
                    armed ? t.warn : t.text, { align: 'center', font: 'num' });
            cv.text('RPM', 270, 198, 14, t.dim, { align: 'center', spacing: 3 });

            const span = Math.min(1, (car.rpm || 0) / 7000);
            cv.roundRect(80, 226, 380, 10, 5, t.track || '#1b212b');
            if (span > 0) cv.roundRect(80, 226, 380 * span, 10, 5, armed ? t.warn : t.accent);
            const armX = 80 + 380 * Math.min(1, (Number(settings.get('armRpm')) || 3000) / 7000);
            cv.fillRect(armX - 1, 222, 2, 18, t.warn);

            const rows = [
                ['Durum', armed ? 'KURULDU' : (on ? 'bekliyor' : 'kapali')],
                ['Degisim', Math.round(detector.rate) + ' rpm/s'],
                ['Tepe', detector.peak ? String(Math.round(detector.peak)) : '-'],
                ['Efekt', effects.length ? String(effects.length) : 'yok'],
                ['Ses rotasi', carAudio.state],
            ];
            rows.forEach((r, i) => {
                const y = 282 + i * 36;
                cv.text(r[0], 80, y, 15, t.dim, { spacing: 1 });
                cv.text(r[1], 460, y, 16, t.text, { align: 'right', font: 'num' });
            });

            G.panel(cv, t, 540, 44, 1020, 430, on ? 'Pop-Bang acik' : 'Pop-Bang kapali');
            const big = armed ? 'KURULDU' : (on ? 'HAZIR' : 'KAPALI');
            cv.text(big, 1050, 180, 64, armed ? t.warn : (on ? t.text : t.dim),
                    { align: 'center', font: 'bold', spacing: 6 });
            cv.text(armed ? 'simdi gazi birak' : (on ? 'gaz ver, sonra birak' : 'Ac / Kapat ile ac'),
                    1050, 220, 17, t.dim, { align: 'center' });

            if (lastFired && Date.now() - lastAt < 4000) {
                cv.text(lastFired.name || lastFired.id, 1050, 300, 30, t.accent,
                        { align: 'center', font: 'bold' });
                cv.text('L' + (lastFired.level || '?') + '  ·  ' + (lastFired.durationMs || 0) + ' ms',
                        1050, 332, 15, t.dim, { align: 'center' });
            }

            // diagnostics on screen: the car has no other place to read them
            const crit = t.crit || '#ef2b2d';
            const colour = (ok) => (ok === false ? crit : ok ? t.accent : t.dim);
            const diag = [];
            if (ctl.connected && device) diag.push(['Cihaz: ' + device.text, colour(device.ok)]);
            if (lastResult) diag.push(['Ses: ' + lastResult.text, colour(lastResult.ok)]);
            if (carAudio.error) diag.push(['Rota: ' + carAudio.error, crit]);
            const lines = [];
            diag.forEach((d) => wrap(d[0], 100).slice(0, 2).forEach((l) => lines.push([l, d[1]])));
            lines.slice(0, 4).forEach((l, i) => cv.text(l[0], 1050, 360 + i * 20, 14, l[1], { align: 'center' }));

            const test = effects[testIdx % Math.max(effects.length, 1)];
            cv.text('Dene: ' + (test ? (test.name || test.id) : '-')
                    + '   ·   Efekt: ' + (settings.get('effectMode') === 'random' ? 'rastgele'
                        : settings.get('effectMode') === 'level' ? 'cekise gore' : settings.get('effectMode')),
                    1050, 448, 15, t.dim, { align: 'center' });

            if (!ctl.connected) {
                cv.roundRect(540, 44, 1020, 30, 6, t.crit || '#ef2b2d');
                cv.text('edzco-sound servisi yok - Store\'dan Sound aracini kur', 1050, 65, 16, '#ffffff',
                        { align: 'center', font: 'bold' });
            }

            return ui.image('MAIN_GFX', cv);
        }

        ctx.loop('MAIN', 6, render);
        await render();
        log.info('ready');

        return { detector, play, pickEffect, carAudio };
    },
});
