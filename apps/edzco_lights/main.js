'use strict';
/*
 * edzco_lights ("Lights"): front end of the edzco-lights tool.
 *
 * The app shows three tabs:
 *   Patterns   - cards for Welcome, Goodbye, Comfort Flash, Sequential Chase, Hazard Dance
 *   Freeform   - every learnt lamp as a toggle; Lamp Check button at the top
 *   Settings   - auto-welcome on door open, auto-goodbye on central lock, brightness cap stub
 *
 * The app enforces the UI gate (parked? ignition? danger confirm?) and forwards flags to the
 * tool; the tool enforces the same flags on its side. The app never does UDS.
 *
 *   -> { "op": "play", "id": <patternId>, "parked": bool, "engineOn": bool, "danger": bool? }
 *   -> { "op": "lamp", "id": <lampId>, "on": bool }
 *   -> { "op": "lamp_check" }
 *   -> { "op": "stop" }
 *
 * Auto-run: with autoWelcome on, any door opening while parked + engine off fires Welcome.
 * With autoGoodbye on, central-lock going to locked fires Goodbye.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const util = require('util');

const LOG = '[edzco_lights]';
const CTL = process.env.EDZCO_LIGHTS_CTL || '/run/edzco-lights/ctl.sock';
const RETRY_MS = 2000;
const POLL_MS = 1000;
const DATA = process.env.LIGHTS_DATA || path.join('/var', 'opt', 'public', 'oap', 'data');
const LOG_FILE = path.join(DATA, 'edzco_lights.log');
const STATE_FILE = path.join(DATA, 'edzco_lights.state.json');

function log() {
    const line = [new Date().toISOString()].concat([].slice.call(arguments)
        .map((x) => (typeof x === 'string' ? x : util.inspect(x, { depth: 4 }).slice(0, 2000)))).join(' ');
    console.error(LOG, line);
    try { if (fs.statSync(LOG_FILE).size > 256 * 1024) fs.writeFileSync(LOG_FILE, ''); } catch (e) {}
    try { fs.mkdirSync(DATA, { recursive: true }); fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
}

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

const INIT_SETTINGS = {
    autoWelcome: true,
    autoGoodbye: true,
    confirmDanger: true,
};
function loadSettings() {
    try { return Object.assign({}, INIT_SETTINGS, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); }
    catch (e) { return Object.assign({}, INIT_SETTINGS); }
}
function saveSettings(s) {
    try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
    catch (e) { log('save failed', e.message); }
}

function CdsState(onChange) {
    const s = { gear: null, engine: null, lock: null, speed: null,
                doors: { fl: false, fr: false, rl: false, rr: false } };
    const parked = () => s.gear === 'P' || s.gear === 1;
    const engineOn = () => s.engine === true || s.engine === 1;
    /** road speed in km/h, or null when the car has not reported one yet. The moving
     *  patterns refuse on null rather than assuming standstill. */
    const speed = () => (typeof s.speed === 'number' ? s.speed : null);
    const anyDoorOpen = () => s.doors.fl || s.doors.fr || s.doors.rl || s.doors.rr;
    const locked = () => s.lock === 'LOCKED' || s.lock === 1;
    const update = (k, v) => {
        const prev = JSON.parse(JSON.stringify(s));
        s[k] = v;
        if (onChange) onChange({ s, prev, parked: parked(), engineOn: engineOn(),
                                 speed: speed(), anyDoorOpen: anyDoorOpen(), locked: locked() });
    };
    const updateDoor = (which, v) => {
        const prev = anyDoorOpen();
        s.doors[which] = !!v;
        const now = anyDoorOpen();
        if (onChange && !prev && now) onChange({ event: 'doorOpen', parked: parked(), engineOn: engineOn() });
    };
    return { update, updateDoor, parked, engineOn, speed };
}

function main() {
    log('starting');
    try { fs.mkdirSync(DATA, { recursive: true }); } catch (e) {}
    const settings = loadSettings();
    const ctl = Ctl();
    let toolState = { connected: false, sessionActive: false, activePattern: null, layouts: { bdcOut: null }, capable: {}, lastError: null };

    const cds = CdsState((ev) => {
        if (ev.event === 'doorOpen' && settings.autoWelcome && ev.parked && !ev.engineOn) {
            log('auto-welcome on door open');
            ctl.send({ op: 'play', id: 'welcome', parked: true, engineOn: false }, (m) => { if (m.error) log('autoWelcome error:', m.error); });
        }
        if (ev.s && ev.s.lock === 'LOCKED' && ev.prev && ev.prev.lock !== 'LOCKED' && settings.autoGoodbye) {
            log('auto-goodbye on central lock');
            ctl.send({ op: 'play', id: 'goodbye', parked: true, engineOn: false }, (m) => { if (m.error) log('autoGoodbye error:', m.error); });
        }
    });

    ctl.onConnect((up) => { if (up) ctl.send({ op: 'get' }, () => {}); });
    ctl.onState((st) => { toolState = Object.assign(toolState, st); });

    const ui = {
        listPatterns() {
            return require('../../tools/edzco-lights/patterns.js').PATTERNS.map((p) => ({
                id: p.id, name: p.name, description: p.description, parkedOnly: p.parkedOnly, danger: p.danger,
            }));
        },
        getState() { return { tool: toolState, settings: JSON.parse(JSON.stringify(settings)) }; },
        /** Start a pattern. The tool re-checks every gate on its side, so this forwards the
         *  car's state truthfully rather than asserting anything. `confirmedDanger` is the
         *  UI's record that the user acknowledged a high-beam pattern. */
        play(id, confirmedDanger) {
            const msg = {
                op: 'play',
                id,
                parked: cds.parked(),
                engineOn: cds.engineOn(),
                speed: cds.speed(),
            };
            if (confirmedDanger) msg.danger = true;
            return new Promise((res) => ctl.send(msg, res));
        },
        lamp(id, on) { return new Promise((res) => ctl.send({ op: 'lamp', id, on: !!on }, res)); },
        lampCheck() { return new Promise((res) => ctl.send({ op: 'lamp_check' }, res)); },
        stop() { return new Promise((res) => ctl.send({ op: 'stop' }, res)); },
        setSetting(k, v) {
            if (!(k in INIT_SETTINGS)) return false;
            settings[k] = v;
            saveSettings(settings);
            return true;
        },
    };

    const signals = {
        statusDoorDriverFront:    (v) => cds.updateDoor('fl', v),
        statusDoorPassengerFront: (v) => cds.updateDoor('fr', v),
        statusDoorDriverRear:     (v) => cds.updateDoor('rl', v),
        statusDoorPassengerRear:  (v) => cds.updateDoor('rr', v),
        statusGearPosition:       (v) => cds.update('gear', v),
        statusIgnition:           (v) => cds.update('engine', v),
        statusCentralLock:        (v) => cds.update('lock', v),
        statusCarSpeed:           (v) => cds.update('speed', v),
    };

    setInterval(() => { if (ctl.connected) ctl.send({ op: 'get' }, () => {}); }, POLL_MS);
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
