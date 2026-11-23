'use strict';
/*
 * edzco_popbang ("Pop-Bang"): front end of the edzco-exhaust tool over its control socket (JSON
 * lines, /run/edzco-exhaust/ctl.sock). The app shows one page: a big held-to-fire button, three
 * state dots (engine running, parked, tool connected) and a short log strip.
 *
 * The app DOES NOT do UDS itself. It only forwards the user's intent to the tool and shows what
 * the tool reports back. The tool is the one that gates writes on safety, holds the HMI diagnostic
 * link, and watchdog-closes the flap. Keeping that split means a bug in the app can at worst send
 * a stale 'hold' - the tool will refuse it or close the flap itself after HOLD_MAX_MS.
 *
 *   -> { op: 'ping' }                                  liveness
 *   -> { op: 'get' }                                   read tool state
 *   -> { op: 'popbang', hold, parked, engineOn }       the moment the user starts / stops holding
 *
 *   <- { reply: 'pong' }
 *   <- { state: { connected, engineRunning, parked, flap, lastError } }
 *   <- { error: '...' }                                any op can come back as an error
 *
 * Attribution: the OnlineApp bootstrapping pattern is borrowed from IterioDev's iteriodev_seats
 * (MIT, Copyright 2026 cauliflowermossgrape) and nickgcode's ng_gsdash shell (MIT, Copyright 2026
 * Nick G). Button / state painting is this app's own.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const util = require('util');

const LOG = '[edzco_popbang]';
const CTL = process.env.EDZCO_EXHAUST_CTL || '/run/edzco-exhaust/ctl.sock';
const RETRY_MS = 2000;
const POLL_MS = 1000;                 // read tool state once a second while the app is on screen
const HOLD_MAX_MS = 3000;             // local cap; the tool has one of its own and wins
const DATA = process.env.POPBANG_DATA || path.join('/var', 'opt', 'public', 'oap', 'data');
const LOG_FILE = path.join(DATA, 'edzco_popbang.log');

function log() {
    const line = [new Date().toISOString()].concat([].slice.call(arguments)
        .map((x) => (typeof x === 'string' ? x : util.inspect(x, { depth: 4 }).slice(0, 2000)))).join(' ');
    console.error(LOG, line);
    try { if (fs.statSync(LOG_FILE).size > 256 * 1024) fs.writeFileSync(LOG_FILE, ''); } catch (e) {}
    try { fs.mkdirSync(DATA, { recursive: true }); fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
}

// -------- tool connection (one Unix socket, auto-reconnect, JSON lines) ----
function Ctl() {
    const self = {
        sock: null,
        buf: '',
        pending: [],
        connected: false,
        onStateCb: null,
        onConnectCb: null,
        connect() {
            try { self.sock = net.connect(CTL); }
            catch (e) { log('connect threw', e.message); self.retry(); return; }
            self.sock.on('connect', () => {
                self.connected = true;
                log('connected', CTL);
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
                    try { msg = JSON.parse(line); }
                    catch (e) { log('bad json from tool', line); continue; }
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
        retry() {
            try { if (self.sock) self.sock.destroy(); } catch (e) {}
            self.sock = null;
            setTimeout(() => self.connect(), RETRY_MS);
        },
        send(msg, cb) {
            if (!self.connected || !self.sock) { cb({ error: 'not connected' }); return; }
            self.pending.push({ cb });
            try { self.sock.write(JSON.stringify(msg) + '\n'); }
            catch (e) { cb({ error: 'write failed: ' + e.message }); }
        },
        onState(cb) { self.onStateCb = cb; },
        onConnect(cb) { self.onConnectCb = cb; },
    };
    return self;
}

// -------- state the app shows, with reasons the Hold button is disabled ----
const INIT_STATE = { connected: false, engineRunning: false, parked: false, flap: 'unknown', lastError: null };

function reasonOffline(s) {
    if (!s.connected) return 'Exhaust tool not connected (service running?).';
    if (!s.engineRunning) return 'Engine not running.';
    if (!s.parked) return 'Not parked.';
    if (s.lastError) return s.lastError;
    return null;
}

// -------- CDS signal state for parked / engine-on, forwarded to the tool ---
function CdsState(onChange) {
    const s = { gear: null, engine: null, speed: null };
    const parked = () => s.gear === 'P' || s.gear === 1; // the CDS enum: 1 is usually park, also string "P" on some branches
    const engineOn = () => s.engine === true || s.engine === 1;
    const update = (k, v) => { s[k] = v; if (onChange) onChange({ parked: parked(), engineOn: engineOn(), speed: s.speed || 0 }); };
    return { update, parked, engineOn };
}

// -------- app shell ---------------------------------------------------------
function main() {
    log('starting');
    try { fs.mkdirSync(DATA, { recursive: true }); } catch (e) {}

    const ctl = Ctl();
    let toolState = Object.assign({}, INIT_STATE);
    let held = false;
    let holdSince = 0;
    let holdTimer = null;

    const cds = CdsState((flags) => {
        // push a "get" to the tool - noop but refreshes state server-side with our latest flags
        // We do not auto-hold on CDS: hold is a user action only.
    });

    ctl.onConnect((up) => {
        toolState.connected = up;
        if (up) ctl.send({ op: 'get' }, (m) => { if (m.state) toolState = m.state; });
    });
    ctl.onState((st) => { toolState = Object.assign(toolState, st); });

    // -------- UI event hooks (filled in by the OAP host wrapper) -----------
    // The real OAP host provides a renderer and a CDS proxy wired through SOME/IP; see
    // online-host.js. For local VM / bench use the tool is not around and the button simply
    // shows what it would do.
    const ui = {
        onHoldStart() {
            if (held) return;
            const reason = reasonOffline(toolState);
            if (reason) { log('refused hold:', reason); return; }
            held = true;
            holdSince = Date.now();
            log('HOLD start');
            ctl.send({
                op: 'popbang', hold: true,
                parked: cds.parked(), engineOn: cds.engineOn(),
            }, (m) => { if (m.error) log('tool error on hold:', m.error); });
            // safety cap in the app too - the tool has one that wins
            clearTimeout(holdTimer);
            holdTimer = setTimeout(() => {
                if (held) ui.onHoldEnd('timeout');
            }, HOLD_MAX_MS);
        },
        onHoldEnd(reason) {
            if (!held) return;
            held = false;
            clearTimeout(holdTimer);
            log('HOLD end (' + (reason || 'release') + ') after', Date.now() - holdSince, 'ms');
            ctl.send({
                op: 'popbang', hold: false,
                parked: cds.parked(), engineOn: cds.engineOn(),
            }, (m) => { if (m.error) log('tool error on close:', m.error); });
        },
        onGetState() { return { tool: toolState, held, holdSinceMs: held ? (Date.now() - holdSince) : 0 }; },
        onLeave() { if (held) ui.onHoldEnd('app leaving'); },
    };

    // CDS wiring (actual SOME/IP subscriptions are done by online-host.js at bootstrap)
    const signals = {
        statusGearPosition: (v) => cds.update('gear', v),
        statusEngineRunning: (v) => cds.update('engine', v),
        statusCarSpeed: (v) => cds.update('speed', v),
    };

    // poll the tool for liveness and keep the state card fresh
    setInterval(() => { if (ctl.connected) ctl.send({ op: 'get' }, () => {}); }, POLL_MS);

    ctl.connect();
    log('ready');

    return { ui, signals, reasonOffline: () => reasonOffline(toolState) };
}

module.exports = { main };

// --- running under oap-sdk/OnlineApp: online-host.js calls main() at app start
if (require.main === module) {
    main();
    process.on('SIGTERM', () => { log('SIGTERM'); process.exit(0); });
    process.on('SIGINT', () => { log('SIGINT'); process.exit(0); });
}
