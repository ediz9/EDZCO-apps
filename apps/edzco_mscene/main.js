'use strict';
/*
 * edzco_mscene ("M Scenes"): front end of the edzco-light tool over its control socket (JSON
 * lines, /run/edzco-light/ctl.sock). The app runs the active scene's timeline in-process and
 * sends the composite colour and brightness of every lit zone to the tool at FRAME_MS. The tool
 * holds the BDC UDS link and the 2-minute renewal that each write needs.
 *
 * Pages:
 *   scenes   - scene catalogue (Welcome, M Mode, Celebration, Sunset, Night Drive) as big cards
 *   freeform - a colour wheel + per-zone brightness sliders; what you pick stays until you pick again
 *   settings - auto-start on door open, respect ignition off, brightness cap, demo
 *
 * The app DOES NOT do UDS itself. It emits zone states to the tool; the tool packs them into
 * the BDC's INNENLICHT_FI_LIN_{1,2}_LAYERING writes and the car takes over by itself 254 s after
 * the last renewal.
 *
 *   -> { op: 'ping' }                                 liveness
 *   -> { op: 'get' }                                  tool state
 *   -> { op: 'set', zones: { <zone>: { rgb, brightness } } }    per-frame or one-off
 *   -> { op: 'stop' }                                 release every zone (car's own colour)
 *
 *   <- { reply: 'pong' }
 *   <- { state: { connected, lastWriteMs, zones: {...} } }
 *   <- { error: '...' }
 *
 * Attribution: the OnlineApp bootstrapping pattern is borrowed from IterioDev's iteriodev_ambient
 * (MIT, Copyright 2026 cauliflowermossgrape). The scene choreography is this app's own.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const util = require('util');
const { SCENES, ZONES } = require('./scenes.js');

const LOG = '[edzco_mscene]';
const CTL = process.env.EDZCO_LIGHT_CTL || '/run/edzco-light/ctl.sock';
const RETRY_MS = 2000;
const FRAME_MS = 100;                                  // 10 fps - plenty for ambient
const DATA = process.env.MSCENE_DATA || path.join('/var', 'opt', 'public', 'oap', 'data');
const LOG_FILE = path.join(DATA, 'edzco_mscene.log');
const STATE_FILE = path.join(DATA, 'edzco_mscene.state.json');

function log() {
    const line = [new Date().toISOString()].concat([].slice.call(arguments)
        .map((x) => (typeof x === 'string' ? x : util.inspect(x, { depth: 4 }).slice(0, 2000)))).join(' ');
    console.error(LOG, line);
    try { if (fs.statSync(LOG_FILE).size > 256 * 1024) fs.writeFileSync(LOG_FILE, ''); } catch (e) {}
    try { fs.mkdirSync(DATA, { recursive: true }); fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
}

// -------- interpolation ----------------------------------------------------
function hexToRgb(h) {
    const s = String(h || '').replace('#', '');
    if (s.length !== 6) return [0, 0, 0];
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
function rgbToHex(r, g, b) {
    const to = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return '#' + to(r) + to(g) + to(b);
}
function lerp(a, b, t) { return a + (b - a) * t; }
function lerpRgb(a, b, t) {
    const ra = hexToRgb(a), rb = hexToRgb(b);
    return rgbToHex(lerp(ra[0], rb[0], t), lerp(ra[1], rb[1], t), lerp(ra[2], rb[2], t));
}

/** Evaluate a scene at a time (0..1). Returns zones: { name: {rgb, brightness} }. */
function sampleScene(scene, u) {
    const kf = scene.keyframes;
    if (!kf || !kf.length) return {};
    if (u <= kf[0].t) return JSON.parse(JSON.stringify(kf[0].zones));
    if (u >= kf[kf.length - 1].t) return JSON.parse(JSON.stringify(kf[kf.length - 1].zones));
    // find straddling pair
    for (let i = 0; i < kf.length - 1; i++) {
        if (u >= kf[i].t && u <= kf[i + 1].t) {
            const span = kf[i + 1].t - kf[i].t;
            const tt = span > 0 ? (u - kf[i].t) / span : 0;
            const out = {};
            for (const z of ZONES) {
                const za = kf[i].zones[z], zb = kf[i + 1].zones[z];
                if (!za && !zb) continue;
                if (!za) { out[z] = JSON.parse(JSON.stringify(zb)); continue; }
                if (!zb) { out[z] = JSON.parse(JSON.stringify(za)); continue; }
                out[z] = {
                    rgb: lerpRgb(za.rgb, zb.rgb, tt),
                    brightness: Math.round(lerp(za.brightness, zb.brightness, tt)),
                };
            }
            return out;
        }
    }
    return {};
}

// -------- tool connection --------------------------------------------------
function Ctl() {
    const self = {
        sock: null, buf: '', pending: [], connected: false, onStateCb: null, onConnectCb: null,
        connect() {
            try { self.sock = net.connect(CTL); }
            catch (e) { log('connect threw', e.message); self.retry(); return; }
            self.sock.on('connect', () => { self.connected = true; log('connected', CTL); if (self.onConnectCb) self.onConnectCb(true); });
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
                    if (p) p.cb(msg);
                    if (msg.state && self.onStateCb) self.onStateCb(msg.state);
                }
            });
            self.sock.on('error', (e) => log('socket error', e.message));
            self.sock.on('close', () => {
                self.connected = false;
                if (self.onConnectCb) self.onConnectCb(false);
                self.pending.splice(0).forEach((p) => p.cb({ error: 'disconnected' }));
                self.retry();
            });
        },
        retry() { try { if (self.sock) self.sock.destroy(); } catch (e) {} self.sock = null; setTimeout(() => self.connect(), RETRY_MS); },
        send(msg, cb) {
            if (!self.connected || !self.sock) { if (cb) cb({ error: 'not connected' }); return; }
            if (cb) self.pending.push({ cb });
            try { self.sock.write(JSON.stringify(msg) + '\n'); } catch (e) { if (cb) cb({ error: 'write failed: ' + e.message }); }
        },
        onState(cb) { self.onStateCb = cb; },
        onConnect(cb) { self.onConnectCb = cb; },
    };
    return self;
}

// -------- state the app holds ---------------------------------------------
const INIT_SETTINGS = {
    autoWelcome: true,
    respectIgnition: false,
    brightnessCap: 100,
    activeScene: null,
    freeform: null,
};
function loadSettings() {
    try { return Object.assign({}, INIT_SETTINGS, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); }
    catch (e) { return Object.assign({}, INIT_SETTINGS); }
}
function saveSettings(s) {
    try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
    catch (e) { log('save failed', e.message); }
}

// -------- the runner -------------------------------------------------------
function Runner(ctl, settings) {
    let active = null;     // { scene, startedAt, cap_ms }
    let freeform = null;   // { zones } steady until changed
    let timer = null;

    function applyCap(z) {
        if (!z) return z;
        const out = {};
        const cap = Math.max(0, Math.min(100, settings.brightnessCap || 100));
        for (const k of Object.keys(z)) {
            out[k] = { rgb: z[k].rgb, brightness: Math.round((z[k].brightness || 0) * cap / 100) };
        }
        return out;
    }

    function tick() {
        if (!active && !freeform) return;
        let zones = null;
        if (active) {
            const now = Date.now();
            const elapsed = now - active.startedAt;
            if (active.cap_ms && elapsed > active.cap_ms) { stopScene(); return; }
            const u = (elapsed % active.scene.duration_ms) / active.scene.duration_ms;
            zones = sampleScene(active.scene, u);
            if (!active.scene.loop && elapsed >= active.scene.duration_ms) {
                // one-shot: send the last frame, then settle (no clear - the car takes over in 254 s)
                ctl.send({ op: 'set', zones: applyCap(zones) });
                active = null;
                log('scene finished');
                return;
            }
        } else if (freeform) {
            zones = freeform.zones;
        }
        if (zones) ctl.send({ op: 'set', zones: applyCap(zones) });
    }

    function startScene(id) {
        const scene = SCENES.find((s) => s.id === id);
        if (!scene) { log('no such scene:', id); return false; }
        active = { scene, startedAt: Date.now(), cap_ms: scene.cap_ms || 0 };
        freeform = null;
        if (!timer) timer = setInterval(tick, FRAME_MS);
        log('scene start:', id);
        settings.activeScene = id;
        settings.freeform = null;
        saveSettings(settings);
        return true;
    }

    function setFreeform(zones) {
        freeform = { zones };
        active = null;
        if (!timer) timer = setInterval(tick, FRAME_MS);
        tick();
        settings.activeScene = null;
        settings.freeform = zones;
        saveSettings(settings);
    }

    function stopScene() {
        active = null;
        freeform = null;
        clearInterval(timer); timer = null;
        ctl.send({ op: 'stop' });
        log('stopped');
        settings.activeScene = null;
        settings.freeform = null;
        saveSettings(settings);
    }

    return { startScene, setFreeform, stopScene, get active() { return active; }, get freeform() { return freeform; } };
}

// -------- CDS door handler -------------------------------------------------
function DoorWatcher(onAnyDoorOpen) {
    const s = { fl: false, fr: false, rl: false, rr: false };
    const update = (k, v) => {
        const wasAny = s.fl || s.fr || s.rl || s.rr;
        s[k] = !!v;
        const nowAny = s.fl || s.fr || s.rl || s.rr;
        if (!wasAny && nowAny) onAnyDoorOpen();
    };
    return { update };
}

// -------- app shell --------------------------------------------------------
function main() {
    log('starting');
    try { fs.mkdirSync(DATA, { recursive: true }); } catch (e) {}
    const settings = loadSettings();
    const ctl = Ctl();
    const runner = Runner(ctl, settings);
    const doorWatcher = DoorWatcher(() => {
        if (settings.autoWelcome && !runner.active && !runner.freeform) {
            log('auto-welcome on door open');
            runner.startScene('welcome');
        }
    });

    ctl.onConnect((up) => {
        if (up) ctl.send({ op: 'get' }, () => {});
        // restore the previous session's selection on connect
        if (up) {
            if (settings.activeScene) runner.startScene(settings.activeScene);
            else if (settings.freeform) runner.setFreeform(settings.freeform);
        }
    });

    const ui = {
        listScenes() { return SCENES.map((s) => ({ id: s.id, name: s.name, description: s.description, loop: s.loop })); },
        startScene(id) { return runner.startScene(id); },
        setFreeform(zones) { return runner.setFreeform(zones); },
        stop() { return runner.stopScene(); },
        getSettings() { return JSON.parse(JSON.stringify(settings)); },
        setSetting(k, v) {
            if (!(k in INIT_SETTINGS)) return false;
            settings[k] = v;
            saveSettings(settings);
            return true;
        },
        onLeave() { /* keep running - that is the point of ambient */ },
    };

    const signals = {
        statusDoorDriverFront:    (v) => doorWatcher.update('fl', v),
        statusDoorPassengerFront: (v) => doorWatcher.update('fr', v),
        statusDoorDriverRear:     (v) => doorWatcher.update('rl', v),
        statusDoorPassengerRear:  (v) => doorWatcher.update('rr', v),
        statusIgnition: (v) => { if (settings.respectIgnition && !v) runner.stopScene(); },
    };

    ctl.connect();
    log('ready');
    return { ui, signals };
}

module.exports = { main };

if (require.main === module) {
    main();
    process.on('SIGTERM', () => { log('SIGTERM'); process.exit(0); });
    process.on('SIGINT', () => { log('SIGINT'); process.exit(0); });
}
