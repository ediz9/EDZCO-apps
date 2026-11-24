'use strict';
/*
 * edzco_popbang ("Pop-Bang"): plays an overrun effect through the car's speakers when you
 * lift off the throttle after a rev - the moment a real exhaust crackles.
 *
 * It does NOT touch the engine. Nothing is written to the DME, no valve is moved, no coding
 * changes. The car's own exhaust does whatever it always does; this adds a sound on top of
 * it, through the head unit's audio, at the right instant.
 *
 * Two halves
 * ----------
 *   this app      watches engine speed, decides when a lift happened, and brings the
 *                 AudioManager route up and down around the sound
 *   edzco-sound   writes the PCM into the routed device (a root service: an OAP app has no
 *                 access to the audio devices - Zeiger's Sound Test was removed over this)
 *
 * The audio route (moonride's, car-tested on an X5 G05)
 * -----------------------------------------------------
 *   source 287  SmartX CarLifeMedia - China-only, so the slot is free on our cars
 *   sink  1024  the main speaker
 *
 * Source 287 is A_UNAVAILABLE without a CarLife phone, and a connect to it then hangs in
 * CS_CONNECTING for ever. So it has to be marked available on the routing side FIRST, then
 * connected, and put back to unavailable after. Leftover connections from a crash are swept
 * at start.
 *
 * Detecting the lift
 * ------------------
 * The one signal every car gives us is engine speed (CDS statusEngineSpeed2); there is no
 * accelerator-pedal signal in the vendored interfaces. That turns out to be fine, because
 * the derivative of rpm is a more direct measure of the thing we care about than pedal
 * position is: the throttle shutting IS rpm falling.
 *
 *   ARMED    rpm climbed past armRpm (you revved it)
 *   FIRE     rpm then falls faster than dropRpmPerSec (you lifted)
 *   COOLDOWN hold off, so one lift is one effect and not a burst of them
 *
 * Which effect plays scales with how hard the lift was: peak rpm and how fast it is
 * dropping pick a level 1-5, and the app takes an effect at that level.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const util = require('util');

const LOG = '[edzco_popbang]';
const CTL = process.env.EDZCO_SOUND_CTL || '/run/edzco-sound/ctl.sock';
const RETRY_MS = 2000;
const DATA = process.env.POPBANG_DATA || path.join('/var', 'opt', 'public', 'oap', 'data');
const LOG_FILE = path.join(DATA, 'edzco_popbang.log');
const STATE_FILE = path.join(DATA, 'edzco_popbang.state.json');

// AudioManager, as moonride uses it
const AM_IFACE = 'org.genivi.am.commandinterface.CommandControl';
const AMR_IFACE = 'org.genivi.am.routinginterface.RoutingControlObserver';
const AM_SRC = 287;      // SmartX CarLifeMedia
const AM_SINK = 1024;    // main speaker
const ROUTE_LINGER_MS = 1200;   // keep the route up this long after a sound, so a quick
                                // second lift does not pay the connect cost again

function log() {
    const line = [new Date().toISOString()].concat([].slice.call(arguments)
        .map((x) => (typeof x === 'string' ? x : util.inspect(x, { depth: 4 }).slice(0, 2000)))).join(' ');
    console.error(LOG, line);
    try { if (fs.statSync(LOG_FILE).size > 256 * 1024) fs.writeFileSync(LOG_FILE, ''); } catch (e) {}
    try { fs.mkdirSync(DATA, { recursive: true }); fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
}

// -------- settings ------------------------------------------------------
/*
 * Every adjustable setting is a short list of STEPS, not a continuous range.
 *
 * This is for the iDrive controller. Plenty of these cars have no touchscreen, so the only
 * way to change a setting is to turn a knob - and a knob is a terrible way to cross a
 * 46-position slider. A handful of named steps is one or two clicks to anything, which is
 * also how BMW's own menus behave.
 */
const STEPS = {
    armRpm: {
        label: 'Kurulma deviri',
        unit: 'rpm',
        note: 'How far you have to rev before a lift counts',
        values: [2000, 2500, 3000, 3500, 4000, 4500, 5000],
        labels: ['2000', '2500', '3000', '3500', '4000', '4500', '5000'],
    },
    dropRpmPerSec: {
        label: 'Hassasiyet',
        unit: '',
        note: 'How fast rpm must fall to read as a lift rather than a coast',
        values: [800, 1400, 2200, 3000],
        labels: ['Hassas', 'Normal', 'Geç', 'Çok geç'],
    },
    cooldownMs: {
        label: 'Bekleme',
        unit: '',
        note: 'Minimum gap between two effects',
        values: [500, 1000, 2000, 3000, 5000],
        labels: ['0.5 s', '1 s', '2 s', '3 s', '5 s'],
    },
};

const INIT_SETTINGS = {
    enabled: true,
    // Defaults are deliberately lazy: a lift from 3000 rpm dropping at 900 rpm/s is an
    // ordinary gear change, and we do not want an effect on every shift.
    armRpm: 3000,              // rpm you have to reach before a lift counts
    dropRpmPerSec: 1400,       // how fast rpm must fall to read as a lift
    cooldownMs: 2000,          // minimum gap between two effects
    parkedOnly: false,         // the point is doing it while driving
    /*
     * effectMode decides which of the twenty plays:
     *   'random'      a different one every lift - the default, because hearing the same
     *                 sample on every lift is what makes an effect sound fake
     *   'level'       matched to how hard the lift was (gentle lift, small pop)
     *   '<effect id>' pinned: always that one
     */
    effectMode: 'random',
};

/** nearest step index for a stored value, so a hand-edited state file still lands on a step */
function stepIndex(key, value) {
    const s = STEPS[key];
    if (!s) return -1;
    let best = 0, bestD = Infinity;
    s.values.forEach((v, i) => { const d = Math.abs(v - value); if (d < bestD) { bestD = d; best = i; } });
    return best;
}

function loadSettings() {
    try { return Object.assign({}, INIT_SETTINGS, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); }
    catch (e) { return Object.assign({}, INIT_SETTINGS); }
}
function saveSettings(s) {
    try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
    catch (e) { log('save failed', e.message); }
}

// -------- the sound service ---------------------------------------------
function Ctl() {
    const self = {
        sock: null, buf: '', pending: [], connected: false, onConnectCb: null,
        connect() {
            try { self.sock = net.connect(CTL); }
            catch (e) { log('connect threw', e.message); self.retry(); return; }
            self.sock.on('connect', () => {
                self.connected = true; log('sound service connected');
                if (self.onConnectCb) self.onConnectCb(true);
            });
            self.sock.on('data', (chunk) => {
                self.buf += chunk.toString('utf8');
                let i;
                while ((i = self.buf.indexOf('\n')) >= 0) {
                    const line = self.buf.slice(0, i).trim();
                    self.buf = self.buf.slice(i + 1);
                    if (!line) continue;
                    let msg;
                    try { msg = JSON.parse(line); } catch (e) { log('bad json', line); continue; }
                    const p = self.pending.shift();
                    if (p) p(msg);
                }
            });
            self.sock.on('error', (e) => log('socket error', e.message));
            self.sock.on('close', () => {
                self.connected = false;
                if (self.onConnectCb) self.onConnectCb(false);
                self.pending.splice(0).forEach((cb) => cb({ error: 'disconnected' }));
                self.retry();
            });
        },
        retry() { try { if (self.sock) self.sock.destroy(); } catch (e) {} self.sock = null; setTimeout(() => self.connect(), RETRY_MS); },
        send(msg) {
            return new Promise((res) => {
                if (!self.connected || !self.sock) { res({ error: 'not connected' }); return; }
                self.pending.push(res);
                try { self.sock.write(JSON.stringify(msg) + '\n'); }
                catch (e) { res({ error: 'write failed: ' + e.message }); }
            });
        },
        onConnect(cb) { self.onConnectCb = cb; },
    };
    return self;
}

// -------- AudioManager routing ------------------------------------------
/**
 * `signals` is the app host's SOME/IP interface, with proxy(iface, instance), call(proxy,
 * method, args) and onAvailable(proxy, cb) - the same shape moonride uses. Passing it in
 * keeps this testable off the car.
 */
function CarAudio(signals) {
    const st = { cmd: null, routing: null, id: null, up: false, q: Promise.resolve(), swept: false };

    async function proxyFor(iface) {
        const p = await signals.proxy(iface, '1');
        // a fresh proxy answers "Service unavailable" until the provider is found
        await new Promise((res) => {
            const t = setTimeout(res, 5000);
            signals.onAvailable(p, (a) => { if (a) { clearTimeout(t); res(); } });
        });
        return p;
    }

    const setAvailable = (on) => signals.call(st.routing, 'hookSourceAvailablityStatusChange', {
        sourceID: AM_SRC,
        availability: { availability: on ? 'A_AVAILABLE' : 'A_UNAVAILABLE', availabilityReason: 0 },
    }).then(() => log('car audio: source ' + (on ? 'available' : 'unavailable')),
            (e) => log('car audio availability failed:', String(e)));

    /** a 287 connection left by a crash, a connect timeout or a power-off */
    async function sweep() {
        const r = await signals.call(st.cmd, 'getListMainConnections', {});
        if (!st.swept) { st.swept = true; log('car audio connections:', JSON.stringify(r).slice(0, 600)); }
        const list = Array.isArray(r) ? r : (r && Object.values(r).find(Array.isArray)) || [];
        for (const c of list.filter((c) => c && c.sourceID === AM_SRC)) {
            log('car audio: clearing leftover', c.mainConnectionID);
            await signals.call(st.cmd, 'disconnect', { mainConnectionID: c.mainConnectionID }).catch(() => {});
        }
    }

    async function ensureProxies() {
        if (st.cmd && st.routing) return;
        st.cmd = await proxyFor(AM_IFACE);
        st.routing = await proxyFor(AMR_IFACE);
        await sweep().catch((e) => log('car audio sweep failed:', String(e)));
        await setAvailable(false);
    }

    function up() {
        st.q = st.q.then(async () => {
            if (st.up) return;
            await ensureProxies();
            await setAvailable(true);
            const r = await signals.call(st.cmd, 'connect', { sourceID: AM_SRC, sinkID: AM_SINK });
            const ok = r && (r.amError === 'E_OK' || r.amError === 'E_ALREADY_EXISTS' || r.amError === 0);
            st.id = ok && r.mainConnectionID != null ? r.mainConnectionID : null;
            st.up = !!ok;
            log('car audio: connect ' + (ok ? 'ok id=' + st.id : 'REFUSED ' + JSON.stringify(r)));
        }).catch((e) => log('car audio up failed:', String(e)));
        return st.q;
    }

    function down() {
        st.q = st.q.then(async () => {
            if (!st.up) return;
            if (st.id != null) {
                await signals.call(st.cmd, 'disconnect', { mainConnectionID: st.id }).catch(() => {});
                st.id = null;
            } else {
                await sweep().catch(() => {});
            }
            await setAvailable(false);
            st.up = false;
        }).catch((e) => log('car audio down failed:', String(e)));
        return st.q;
    }

    return { up, down, get isUp() { return st.up; }, sweep: () => st.q.then(sweep) };
}

// -------- overrun detection ---------------------------------------------
/**
 * Watches engine speed and calls onLift({ peakRpm, dropRate, level }) when a rev-then-lift
 * is seen. Fed by whatever rate the car publishes rpm at; it timestamps its own samples so
 * an irregular rate does not skew the derivative.
 */
function OverrunDetector(settings, onLift) {
    let lastRpm = null;
    let lastAt = 0;
    let peak = 0;
    let armed = false;
    let lastFireAt = 0;
    // a little smoothing: raw rpm from the bus is steppy, and a single noisy sample should
    // not look like a lift
    let rate = 0;

    function level(peakRpm, dropRate) {
        // peak carries most of the character, the drop rate sharpens it
        let l = 1;
        if (peakRpm >= 3000) l = 2;
        if (peakRpm >= 4000) l = 3;
        if (peakRpm >= 5200) l = 4;
        if (peakRpm >= 6200) l = 5;
        if (dropRate >= 2600 && l < 5) l += 1;
        return l;
    }

    function feed(rpm, nowMs) {
        const now = typeof nowMs === 'number' ? nowMs : Date.now();
        if (typeof rpm !== 'number' || !(rpm >= 0)) return;
        if (lastRpm === null) { lastRpm = rpm; lastAt = now; return; }

        const dt = (now - lastAt) / 1000;
        if (dt <= 0.001) return;                     // same sample twice
        const inst = (rpm - lastRpm) / dt;           // rpm per second
        rate = rate * 0.6 + inst * 0.4;              // light smoothing
        lastRpm = rpm; lastAt = now;

        if (rpm > peak) peak = rpm;

        if (!armed) {
            if (rpm >= settings.armRpm) { armed = true; peak = rpm; }
            return;
        }

        // falling fast enough to be a lift rather than a coast
        if (rate <= -settings.dropRpmPerSec) {
            const since = now - lastFireAt;
            if (since >= settings.cooldownMs) {
                lastFireAt = now;
                const drop = -rate;
                const lv = level(peak, drop);
                onLift({ peakRpm: Math.round(peak), dropRate: Math.round(drop), level: lv });
            }
            armed = false;
            peak = 0;
            rate = 0;
            return;
        }

        // dropped back below the arm point without a sharp lift: forget it
        if (rpm < settings.armRpm * 0.72) { armed = false; peak = 0; }
    }

    function reset() { lastRpm = null; peak = 0; armed = false; rate = 0; }
    return { feed, reset, get armed() { return armed; }, get peak() { return peak; } };
}

// -------- app shell ------------------------------------------------------
function main(host) {
    log('starting');
    try { fs.mkdirSync(DATA, { recursive: true }); } catch (e) {}

    const settings = loadSettings();
    const ctl = Ctl();
    const signals = host && host.signals;
    const carAudio = signals ? CarAudio(signals) : null;
    if (!carAudio) log('no signals host: car-audio routing disabled (bench mode)');

    let effects = [];
    let routeDownTimer = null;
    const cds = { rpm: null, gear: null, speed: null };

    ctl.onConnect((up) => {
        if (!up) return;
        ctl.send({ op: 'list' }).then((r) => {
            effects = (r && r.effects) || [];
            log('effects available:', effects.length);
        });
    });

    /** pick the effect for a lift of this level - see settings.effectMode */
    let lastPicked = null;
    function pickEffect(level) {
        if (!effects.length) return null;
        const mode = settings.effectMode || 'random';

        // pinned to one effect
        if (mode !== 'random' && mode !== 'level') {
            const exact = effects.find((e) => e.id === mode);
            if (exact) return exact;
            // a pin that no longer exists (the file was removed): fall through to random
        }

        if (mode === 'level') {
            // nearest level, preferring the same or one below so a gentle lift is never a bang
            let best = effects[0], bestD = Infinity;
            for (const e of effects) {
                const d = Math.abs((e.level || 3) - level) + ((e.level || 3) > level ? 0.5 : 0);
                if (d < bestD) { bestD = d; best = e; }
            }
            return best;
        }

        // random, but never the same one twice running - a repeat is the thing that makes
        // a sample sound like a sample
        if (effects.length === 1) return effects[0];
        let pick;
        do { pick = effects[Math.floor(Math.random() * effects.length)]; }
        while (lastPicked && pick.id === lastPicked);
        lastPicked = pick.id;
        return pick;
    }

    async function fire(info) {
        if (!settings.enabled) return;
        if (settings.parkedOnly && cds.gear !== 'P' && cds.gear !== 1) return;
        const fx = pickEffect(info.level);
        if (!fx) { log('lift seen but no effects loaded'); return; }

        log(`lift: peak ${info.peakRpm} rpm, dropping ${info.dropRate} rpm/s -> L${info.level} ${fx.id}`);

        clearTimeout(routeDownTimer);
        if (carAudio) await carAudio.up();
        const r = await ctl.send({ op: 'play', id: fx.id });
        if (r && r.error) log('play failed:', r.error);

        // hold the route a moment: a second lift right after should not re-connect
        if (carAudio) {
            routeDownTimer = setTimeout(() => carAudio.down(), (fx.durationMs || 600) + ROUTE_LINGER_MS);
        }
    }

    const detector = OverrunDetector(settings, (info) => { fire(info).catch((e) => log('fire failed:', String(e))); });

    const ui = {
        listEffects() { return effects.slice(); },
        getSettings() { return JSON.parse(JSON.stringify(settings)); },
        /** the step lists the settings page renders, so the knob has something to click through */
        steps() { return JSON.parse(JSON.stringify(STEPS)); },
        /** master on/off - the only control that matters while driving */
        setEnabled(on) { settings.enabled = !!on; saveSettings(settings); return settings.enabled; },
        toggleEnabled() { return ui.setEnabled(!settings.enabled); },
        /** tap an effect to pin it; tap the pinned one again to go back to random */
        pinEffect(id) {
            settings.effectMode = (settings.effectMode === id) ? 'random' : id;
            saveSettings(settings);
            return settings.effectMode;
        },
        /** step a setting by +1 / -1 on its own list */
        nudge(key, dir) {
            const st = STEPS[key];
            if (!st) return null;
            const i = Math.max(0, Math.min(st.values.length - 1, stepIndex(key, settings[key]) + (dir > 0 ? 1 : -1)));
            settings[key] = st.values[i];
            saveSettings(settings);
            if (key === 'armRpm' || key === 'dropRpmPerSec') detector.reset();
            return { value: settings[key], label: st.labels[i], index: i };
        },
        setSetting(k, v) {
            if (!(k in INIT_SETTINGS)) return false;
            settings[k] = v;
            saveSettings(settings);
            if (k === 'armRpm' || k === 'dropRpmPerSec') detector.reset();
            return true;
        },
        /** play one now, for trying effects out in the settings page */
        test(id) {
            return (async () => {
                clearTimeout(routeDownTimer);
                if (carAudio) await carAudio.up();
                const r = await ctl.send({ op: 'play', id });
                if (carAudio) {
                    const fx = effects.find((e) => e.id === id);
                    routeDownTimer = setTimeout(() => carAudio.down(), ((fx && fx.durationMs) || 600) + ROUTE_LINGER_MS);
                }
                return r;
            })();
        },
        probe() { return ctl.send({ op: 'probe' }); },
        state() {
            return {
                connected: ctl.connected,
                effects: effects.length,
                rpm: cds.rpm,
                armed: detector.armed,
                peak: detector.peak,
                routeUp: carAudio ? carAudio.isUp : false,
            };
        },
    };

    const signalHandlers = {
        statusEngineSpeed2: (v) => {
            const rpm = typeof v === 'object' && v !== null ? (v.value != null ? v.value : v.engineSpeed) : v;
            cds.rpm = rpm;
            detector.feed(rpm);
        },
        statusGearPosition: (v) => { cds.gear = v; },
        statusCarSpeed: (v) => { cds.speed = v; },
    };

    ctl.connect();
    log('ready');
    return { ui, signals: signalHandlers };
}

module.exports = { main, OverrunDetector, CarAudio, INIT_SETTINGS, AM_SRC, AM_SINK };

if (require.main === module) {
    main(null);
    process.on('SIGTERM', () => { log('SIGTERM'); process.exit(0); });
    process.on('SIGINT', () => { log('SIGINT'); process.exit(0); });
}
