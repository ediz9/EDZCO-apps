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
const ROUTE_LINGER_MS = 1200;   // hold the route briefly, so a quick second lift does not
                                // pay the connect cost again

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
        sock: null, buf: '', pending: [], connected: false, onUp: null,
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
                    const cb = self.pending.shift();
                    if (cb) cb(msg);
                }
            });
            self.sock.on('error', () => {});
            self.sock.on('close', () => {
                self.connected = false;
                self.pending.splice(0).forEach((cb) => cb({ error: 'disconnected' }));
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
                self.pending.push(res);
                try { self.sock.write(JSON.stringify(msg) + '\n'); }
                catch (e) { res({ error: String(e.message || e) }); }
            });
        },
    };
    return self;
}

/* ------------------------------------------------------------- AudioManager */
function CarAudio(signals, log) {
    const st = { cmd: null, routing: null, id: null, up: false, q: Promise.resolve(), swept: false };

    async function proxyFor(iface) {
        // iDrive 7's oap-sdk takes the timeout as a plain number; { timeoutMs } times out
        // at once there (car-apps issue #37)
        return signals.proxy(iface, '1', 5000);
    }
    const setAvailable = (on) => signals.call(st.routing, 'hookSourceAvailablityStatusChange', {
        sourceID: AM_SRC,
        availability: { availability: on ? 'A_AVAILABLE' : 'A_UNAVAILABLE', availabilityReason: 0 },
    }).then(() => log.info('car audio: source ' + (on ? 'available' : 'unavailable')),
            (e) => log.warn('car audio availability: ' + e));

    async function sweep() {
        const r = await signals.call(st.cmd, 'getListMainConnections', {});
        if (!st.swept) { st.swept = true; log.info('car audio connections: ' + JSON.stringify(r).slice(0, 400)); }
        const list = Array.isArray(r) ? r : (r && Object.values(r).find(Array.isArray)) || [];
        for (const c of list.filter((c) => c && c.sourceID === AM_SRC)) {
            log.info('car audio: clearing leftover ' + c.mainConnectionID);
            await signals.call(st.cmd, 'disconnect', { mainConnectionID: c.mainConnectionID }).catch(() => {});
        }
    }
    async function ensure() {
        if (st.cmd && st.routing) return;
        st.cmd = await proxyFor(AM_IFACE);
        st.routing = await proxyFor(AMR_IFACE);
        await sweep().catch((e) => log.warn('car audio sweep: ' + e));
        await setAvailable(false);
    }

    return {
        up() {
            st.q = st.q.then(async () => {
                if (st.up) return;
                await ensure();
                await setAvailable(true);
                const r = await signals.call(st.cmd, 'connect', { sourceID: AM_SRC, sinkID: AM_SINK });
                const ok = r && (r.amError === 'E_OK' || r.amError === 'E_ALREADY_EXISTS' || r.amError === 0);
                st.id = ok && r.mainConnectionID != null ? r.mainConnectionID : null;
                st.up = !!ok;
                log.info('car audio: connect ' + (ok ? 'ok id=' + st.id : 'REFUSED ' + JSON.stringify(r)));
            }).catch((e) => log.warn('car audio up: ' + e));
            return st.q;
        },
        down() {
            st.q = st.q.then(async () => {
                if (!st.up) return;
                if (st.id != null) {
                    await signals.call(st.cmd, 'disconnect', { mainConnectionID: st.id }).catch(() => {});
                    st.id = null;
                } else await sweep().catch(() => {});
                await setAvailable(false);
                st.up = false;
            }).catch((e) => log.warn('car audio down: ' + e));
            return st.q;
        },
        get isUp() { return st.up; },
    };
}

/* --------------------------------------------------------------------- app */
mgu.run({
    async start(ctx) {
        const { ui, log, settings } = ctx;

        const ctl = Ctl(log);
        const carAudio = CarAudio(ctx.signals, log);

        let effects = [];
        let lastFired = null, lastAt = 0, lastPicked = null;
        let routeDownTimer = null;
        let testIdx = 0;

        ctl.onUp = () => ctl.send({ op: 'list' }).then((r) => {
            effects = (r && r.effects) || [];
            log.info('effects available: ' + effects.length);
            render().catch(() => {});
        });
        ctl.connect();

        /* ---- engine speed: the whole detector ---- */
        const detector = OverrunDetector({
            armRpm: () => Number(settings.get('armRpm')) || 3000,
            dropRpmPerSec: () => Number(settings.get('dropRpmPerSec')) || 1400,
            cooldownMs: () => Number(settings.get('cooldownMs')) || 2000,
        }, (info) => { fire(info).catch((e) => log.warn('fire: ' + e)); });

        const car = Vehicle.watch(ctx, { rpm: true, speed: true, pedal: true }, (what, v) => {
            if (what === 'rpm') detector.feed(v.rpm);
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

        async function play(fx, why) {
            clearTimeout(routeDownTimer);
            await carAudio.up();
            const r = await ctl.send({ op: 'play', id: fx.id });
            if (r && r.error) log.warn('play ' + fx.id + ': ' + r.error);
            lastFired = fx; lastAt = Date.now();
            routeDownTimer = setTimeout(() => carAudio.down(), (fx.durationMs || 600) + ROUTE_LINGER_MS);
            log.info('played ' + fx.id + ' (' + why + ')');
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
        function render() {
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
                ['Ses rotasi', carAudio.isUp ? '287 -> 1024' : 'kapali'],
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

            const test = effects[testIdx % Math.max(effects.length, 1)];
            cv.text('Dene: ' + (test ? (test.name || test.id) : '-')
                    + '   ·   Efekt: ' + (settings.get('effectMode') === 'random' ? 'rastgele'
                        : settings.get('effectMode') === 'level' ? 'cekise gore' : settings.get('effectMode')),
                    1050, 430, 15, t.dim, { align: 'center' });

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
