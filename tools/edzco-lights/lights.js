'use strict';
/*
 * lights.js - edzco-lights daemon.
 *
 * Drives the car's exterior lamps through BMW's own test functions on the body controller
 * (BDC, 0x40) and the LED headlight modules (FLM, 0x43 / 0x44). Runs patterns from
 * patterns.js over the lamp catalogue in lamps.js. The gateway is reached through hmictl
 * the same way edzco-exhaust reaches the DME.
 *
 * Control socket: /run/edzco-lights/ctl.sock, JSON lines.
 *   -> { "op": "ping" }
 *   -> { "op": "get" }
 *   -> { "op": "play", "id": "<patternId>", "parked": true|false, "engineOn": true|false }
 *   -> { "op": "stop" }
 *   -> { "op": "lamp_check" }       starts the 50 s lamp-check routine; results in state.layouts / state.capable
 *   -> { "op": "lamp", "id": "<lampId>", "on": true|false }    freeform single-lamp toggle
 *
 *   <- { "reply": "pong" }
 *   <- { "state": { "connected", "sessionActive", "activePattern", "layouts": {...}, "capable": {...},
 *                   "lastError": null|string } }
 *   <- { "error": "..." }
 *
 * Safety:
 *   - 10 03 extended session is opened once a request comes in, and 10 01 is sent at the end
 *     (or when stop_all fires). 3E 00 every 2 s while the session is open.
 *   - Every lamp write is either 2E (LEUCHTEN_FUNKTION / FLM_FUNKTION_LICHTVERTEILUNG) with its
 *     own time byte (0..254 x 10 ms) that the ECU self-times, or 2F (LICHT_AUSGANG_DIGITAL_STEUERN)
 *     paired with an explicit return-to-ECU after the pattern frame. If the daemon dies mid-
 *     pattern, every lamp is back at the car's own within a few seconds (BDC drops the default
 *     session) - no stuck lights.
 *   - parkedOnly patterns refuse to run unless the caller flag parked=true; danger patterns
 *     need danger=true in addition.
 *
 * Attribution: lamp catalogue, UDS layouts and session plan are adapted from eroobeeroo/
 * idrive7-apps/light_show (MIT, Copyright 2026 eroobeeroo, car-tested on a 2021 X5 G05).
 * The UDS transport (uds.js) + control socket + pattern runner are this tool's.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const util = require('util');
const { Uds, SUB, hexToBytes } = require('./uds.js');
const { BDC, FLM_L, FLM_R, LAYOUTS, BDC_FUNC, FLM_FUNC, LAMPS, BY_ID } = require('./lamps.js');
const { PATTERNS } = require('./patterns.js');

const LOG = '[edzco-lights]';
const SOCKET = process.env.CTL_SOCKET || '/run/edzco-lights/ctl.sock';
const LOG_FILE = process.env.LIGHTS_LOG || '/var/log/edzco-lights/lights.log';
const HMICTL = process.env.HMICTL || '/usr/bin/hmictl';

const DID_BDC_OUT    = [0xE3, 0xB5];      // LICHT_AUSGANG_DIGITAL_STEUERN
const DID_BDC_FUNC   = [0xD5, 0x42];      // LEUCHTEN_FUNKTION
const DID_BDC_READ   = [0xE3, 0xB9];      // LICHT_AUSGANG_DIGITAL read
const DID_FLM_FUNC   = [0xD6, 0xDC];      // FLM_FUNKTION_LICHTVERTEILUNG

const LAMP_ON_SECS = 2;                   // every lamp write asks for 2 s of lit; refreshed each frame
const KEEPALIVE_MS = 2000;
const DEFAULT_SESSION = 0x01;
const EXT_SESSION = 0x03;

function log() {
    const line = [new Date().toISOString()].concat([].slice.call(arguments)
        .map((x) => (typeof x === 'string' ? x : util.inspect(x, { depth: 4 }).slice(0, 2000)))).join(' ');
    console.error(LOG, line);
    try { if (fs.statSync(LOG_FILE).size > 256 * 1024) fs.writeFileSync(LOG_FILE, ''); } catch (e) {}
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
}

// -------- hmictl plumbing (shared with edzco-exhaust / edzco-light) --------
function Hmi() {
    const self = {
        proc: null, pendings: [], eventCb: null,
        start() {
            self.proc = spawn(HMICTL, ['serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
            self.proc.on('error', (e) => log('hmictl spawn error', e.message));
            self.proc.on('exit', (code) => { log('hmictl exit', code); self.proc = null; });
            let buf = '';
            self.proc.stdout.on('data', (chunk) => {
                buf += chunk.toString('utf8');
                let i;
                while ((i = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, i).trim();
                    buf = buf.slice(i + 1);
                    if (!line) continue;
                    if (line.startsWith('ev ')) {
                        const parts = line.split(/\s+/);
                        if (self.eventCb && parts[3]) self.eventCb(parts[3]);
                    } else {
                        const p = self.pendings.shift();
                        if (p) { line.startsWith('error') ? p.rej(new Error(line)) : p.res(line); }
                    }
                }
            });
            self.proc.stderr.on('data', (c) => log('hmictl stderr', c.toString('utf8').trim()));
            self.call(SUB).catch((e) => log('subscribe failed', e.message));
        },
        call(cmd) {
            return new Promise((res, rej) => {
                if (!self.proc) { rej(new Error('hmictl not running')); return; }
                self.pendings.push({ res, rej });
                self.proc.stdin.write(cmd + '\n');
            });
        },
        onEvent(cb) { self.eventCb = cb; },
    };
    return self;
}

// -------- session management ----------------------------------------------
function Session(uds) {
    const self = {
        open: false,
        keepalive: null,
        async start() {
            if (self.open) return;
            try {
                await uds.send(BDC, 0x10, [EXT_SESSION], 2000);  // extended session
                self.open = true;
                log('ext session opened on BDC');
                self.keepalive = setInterval(() => {
                    uds.send(BDC, 0x3E, [0x00], 1500).catch(() => {});
                }, KEEPALIVE_MS);
            } catch (e) { log('ext session failed', e.message); throw e; }
        },
        async stop() {
            if (!self.open) return;
            clearInterval(self.keepalive); self.keepalive = null;
            try { await uds.send(BDC, 0x10, [DEFAULT_SESSION], 1500); } catch (e) {}
            self.open = false;
            log('session closed on BDC');
        },
    };
    return self;
}

// -------- lamp output drive ----------------------------------------------
// With a learnt layout, BDC output = 0xE3B5 + layout(out, on). Without, fall back to the
// lamp's FLM function (per side) or the BDC function (both sides unless side-specific).
//
// `state` is one of:
//   'on'       light it and hold it (the ECU still self-times, so patterns refresh)
//   'off'      hold it dark - we keep the output, so the car cannot light it either
//   'release'  hand the output back to the ECU; the car owns the lamp again at once
//
// 'off' and 'release' look the same from outside on a parked car, but they are not the
// same thing while driving: after 'off' the driver's own indicator stalk does nothing,
// after 'release' everything behaves normally. Moving patterns must use 'release'.
async function driveLamp(sess, lamp, state) {
    if (!lamp) return { ok: false, reason: 'no such lamp' };
    if (state === true) state = 'on';
    if (state === false) state = 'off';
    const on = state === 'on';
    const release = state === 'release';
    const layout = sess.layouts.bdcOut;

    // 1) BDC output, if the lamp has one AND we have a learnt layout.
    //    Return-control is its own request shape: 2F E3B5 00 <output>.
    if (lamp.out != null && layout) {
        const row = LAYOUTS.find((l) => l.id === layout);
        const data = release
            ? DID_BDC_OUT.concat([0x00, lamp.out])
            : DID_BDC_OUT.concat(row.build(lamp.out, on ? 1 : 0));
        try {
            await sess.uds.send(BDC, 0x2F, data, 1500);
            return { ok: true, path: 'bdc_out:' + layout, state };
        } catch (e) { /* fall through */ }
    }

    // 2) FLM function (one side, a few lamps have one). A function written with 0 seconds
    //    expires immediately, which is the module's own way of handing the lamp back.
    if (lamp.flm) {
        const data = DID_FLM_FUNC.concat([0x00, lamp.flm.fn, on ? LAMP_ON_SECS : 0]);
        try {
            await sess.uds.send(lamp.flm.ecu, 0x2E, data, 1500);
            return { ok: true, path: 'flm:' + (lamp.flm.ecu === FLM_L ? 'L' : 'R'), state };
        } catch (e) { /* fall through */ }
    }

    // 3) BDC function (both sides unless the function row names a side). Same story: a
    //    time of 0 ends our hold and the car takes the lamp back.
    if (lamp.fn) {
        const time10ms = on ? LAMP_ON_SECS * 100 : 0;
        const data = DID_BDC_FUNC.concat([lamp.fn.hi, lamp.fn.lo, time10ms & 0xFF]);
        try {
            await sess.uds.send(BDC, 0x2E, data, 1500);
            return { ok: true, path: 'bdc_fn', state };
        } catch (e) {
            return { ok: false, reason: e.message };
        }
    }

    return { ok: false, reason: 'no route' };
}

// -------- lamp check: learn layout + probe routes -------------------------
async function runLampCheck(sess) {
    await sess.sess.start();
    log('lamp check: starting layout probe on rear-left turn signal');
    sess.layouts.bdcOut = null;
    for (const layout of LAYOUTS) {
        const row = LAYOUTS.find((l) => l.id === layout.id);
        const data = DID_BDC_OUT.concat(row.build(0x1a, 1));   // turn_rl output byte, on
        try {
            await sess.uds.send(BDC, 0x2F, data, 1200);
            sess.layouts.bdcOut = layout.id;
            log('layout', layout.id, 'accepted by BDC');
            // return control
            await sess.uds.send(BDC, 0x2F, DID_BDC_OUT.concat([0x00, 0x1a]), 1200).catch(() => {});
            break;
        } catch (e) { /* try next */ }
    }
    if (!sess.layouts.bdcOut) log('lamp check: no BDC output layout taken; falling back to functions');

    // probe each lamp: try to drive on, then off, note which path worked
    sess.capable = {};
    for (const lamp of LAMPS) {
        const r = await driveLamp(sess, lamp, true);
        sess.capable[lamp.id] = r;
        await new Promise((res) => setTimeout(res, 1200));                 // see it
        await driveLamp(sess, lamp, false).catch(() => {});
        await new Promise((res) => setTimeout(res, 200));
    }
    log('lamp check done', sess.capable);
}

// -------- pattern runner --------------------------------------------------
function PatternRunner(sess) {
    let current = null;
    let frameTimer = null;
    let idx = 0;
    let startedAt = 0;
    // every lamp this run has driven, so the release sweep touches exactly those and not
    // the whole catalogue
    const touched = new Set();

    async function start(id) {
        const p = PATTERNS.find((x) => x.id === id);
        if (!p) throw new Error('no such pattern: ' + id);
        if (p.id === 'lamp_check') {
            await runLampCheck(sess);
            return;
        }
        await sess.sess.start();
        current = p;
        idx = 0;
        startedAt = Date.now();
        tick();
    }

    function tick() {
        if (!current) return;
        const now = Date.now();
        const elapsed = now - startedAt;
        // fire every step whose atMs has passed since last tick
        while (idx < current.steps.length && current.steps[idx].atMs <= elapsed) {
            const step = current.steps[idx++];
            // 'on' | 'off' | 'release'; anything else is treated as 'off' so an unknown
            // verb can never leave a lamp lit
            const state = step.fn === 'on' ? 'on' : step.fn === 'release' ? 'release' : 'off';
            for (const lid of step.lamps) {
                const lamp = BY_ID[lid];
                if (!lamp) continue;
                touched.add(lid);
                driveLamp(sess, lamp, state).catch(() => {});
            }
        }
        if (idx >= current.steps.length) {
            if (current.loop && elapsed < (current.cap_ms || Infinity)) {
                // wrap around
                idx = 0;
                startedAt = now;
            } else {
                // done - release everything we touched
                log('pattern', current.id, 'done');
                releaseAll().catch(() => {});
                current = null;
                return;
            }
        }
        frameTimer = setTimeout(tick, 50);
    }

    async function releaseAll() {
        // Hand every lamp this run touched back to the car. Two things matter here:
        //
        //  - 'release', not 'off': after a pattern the car must own its lamps again, or the
        //    driver's own indicators and flash-to-pass stay dead until the ECU times out.
        //  - dangerous lamps are NOT skipped. The `dangerous` flag gates lighting a lamp,
        //    never releasing one; skipping them here left the high beams lit after a
        //    high-beam pattern, which is the exact opposite of what the flag is for.
        const ids = touched.size ? Array.from(touched) : LAMPS.map((l) => l.id);
        for (const id of ids) {
            const lamp = BY_ID[id];
            if (!lamp) continue;
            await driveLamp(sess, lamp, 'release').catch(() => {});
        }
        touched.clear();
    }

    function stop() {
        if (!current) return;
        clearTimeout(frameTimer); frameTimer = null;
        log('pattern', current.id, 'stopped by user');
        releaseAll().catch(() => {});
        current = null;
    }

    return { start, stop, get active() { return current; } };
}

// -------- control socket --------------------------------------------------
function serve(sess) {
    try { fs.unlinkSync(SOCKET); } catch (e) {}
    const srv = net.createServer((sock) => {
        let buf = '';
        sock.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i).trim();
                buf = buf.slice(i + 1);
                if (!line) continue;
                let msg;
                try { msg = JSON.parse(line); } catch (e) { sock.write(JSON.stringify({ error: 'bad json' }) + '\n'); continue; }
                handle(sess, msg).then((reply) => sock.write(JSON.stringify(reply) + '\n'),
                                       (err) => sock.write(JSON.stringify({ error: String(err.message || err) }) + '\n'));
            }
        });
        sock.on('error', () => {});
    });
    srv.listen(SOCKET, () => { fs.chmodSync(SOCKET, 0o666); log('listening on', SOCKET); });
}

function currentState(sess) {
    return {
        connected: !!sess.hmi.proc,
        sessionActive: sess.sess.open,
        activePattern: sess.runner.active ? sess.runner.active.id : null,
        layouts: sess.layouts,
        capable: sess.capable,
        lastError: sess.lastError,
    };
}

function handle(sess, msg) {
    if (!msg || typeof msg !== 'object') return Promise.reject(new Error('bad msg'));
    if (msg.op === 'ping') return Promise.resolve({ reply: 'pong' });
    if (msg.op === 'get')  return Promise.resolve({ state: currentState(sess) });

    if (msg.op === 'play') {
        const p = PATTERNS.find((x) => x.id === msg.id);
        if (!p) return Promise.reject(new Error('no such pattern: ' + msg.id));

        // show group: parked, full stop
        if (p.parkedOnly && !msg.parked) {
            return Promise.reject(new Error('refused: pattern needs parked'));
        }
        // moving group: a speed ceiling instead of a parked gate. An unknown speed is
        // treated as too fast - we would rather refuse than guess, and the app always
        // has CDS speed when it has anything at all.
        if (p.maxSpeedKmh != null && !msg.parked) {
            const v = typeof msg.speed === 'number' ? msg.speed : null;
            if (v === null) {
                return Promise.reject(new Error('refused: no road speed from the car'));
            }
            if (v > p.maxSpeedKmh) {
                return Promise.reject(new Error(
                    `refused: ${Math.round(v)} km/h is over this pattern's ${p.maxSpeedKmh} km/h limit`));
            }
        }
        if (p.danger && !msg.danger) {
            return Promise.reject(new Error('refused: pattern needs explicit danger flag'));
        }
        return sess.runner.start(msg.id).then(() => ({ state: currentState(sess) }));
    }

    if (msg.op === 'stop') {
        sess.runner.stop();
        return sess.sess.stop().then(() => ({ state: currentState(sess) }));
    }

    if (msg.op === 'lamp_check') {
        return sess.runner.start('lamp_check').then(() => ({ state: currentState(sess) }));
    }

    if (msg.op === 'lamp') {
        const lamp = BY_ID[msg.id];
        if (!lamp) return Promise.reject(new Error('no such lamp: ' + msg.id));
        return sess.sess.start().then(() => driveLamp(sess, lamp, !!msg.on))
            .then((r) => ({ state: currentState(sess), route: r }));
    }

    return Promise.reject(new Error('unknown op: ' + msg.op));
}

// -------- start -----------------------------------------------------------
function main() {
    try { fs.mkdirSync('/var/log/edzco-lights', { recursive: true }); } catch (e) {}
    const hmi = Hmi();
    const uds = new Uds((line) => hmi.call(line), log);
    hmi.onEvent((hex) => uds.onEvent(hex));
    hmi.start();
    const sess = {
        hmi, uds,
        sess: null,
        runner: null,
        layouts: { bdcOut: null },
        capable: {},
        lastError: null,
    };
    sess.sess = Session(uds);
    sess.runner = PatternRunner(sess);
    serve(sess);
    log('edzco-lights started', { socket: SOCKET });

    const shutdown = async () => {
        try { sess.runner.stop(); } catch (e) {}
        try { await sess.sess.stop(); } catch (e) {}
        setTimeout(() => process.exit(0), 500);
    };
    process.on('SIGTERM', () => { log('SIGTERM'); shutdown(); });
    process.on('SIGINT',  () => { log('SIGINT');  shutdown(); });
}

if (require.main === module) main();

module.exports = { driveLamp, runLampCheck };
