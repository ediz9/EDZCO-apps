'use strict';
/*
 * light.js - edzco-light daemon. The service behind M Scenes.
 *
 * Writes the BDC's interior ambient layering jobs through the head unit's diagnostic gateway
 * (TASU, SOME/IP 0xF8A6 instance 128). Protocol:
 *
 *   write (LIN 1):  2E DA 5E <NAD> <on 1> <brightness 0-100> <R> <G> <B> <secs 0-254>
 *   write (LIN 2):  2E E3 D1 <NAD> <on 1> <brightness 0-100> <R> <G> <B> <secs 0-254>
 *   off:            <NAD> 00 00 00 00 00 00 (car's own colour at once)
 *
 * NAD = the record's place (1-based) in the BDC's layering table for that LIN bus.
 * Colour bytes are capped at 0xFE (0xFF means "no change"); every write lasts up to 254 s
 * and the car's own colour takes over after that unless renewed.
 *
 *   -> { "op": "ping" }                                      liveness
 *   -> { "op": "get" }                                       tool state
 *   -> { "op": "set", "zones": { "dash": {"rgb": "#RRGGBB", "brightness": 0-100}, ... } }
 *   -> { "op": "stop" }                                      release every zone to the car
 *
 *   <- { "reply": "pong" }
 *   <- { "state": { "connected", "lastWriteMs", "probedZones", "zones": {...} } }
 *   <- { "error": "..." }
 *
 * Renewal: when the app stops sending `set` for RENEW_MS the tool resends the last state
 * once to keep the car from taking over. When the app disconnects or asks Stop, the tool
 * sends the OFF payload for every NAD it has driven and goes idle.
 *
 * Attribution: the ambient job sequence + zone map + 254 s layering trick are IterioDev's
 * iteriodev-comfort (MIT, Copyright 2026 cauliflowermossgrape, car-tested on an M4 2026-11-07).
 * The control socket, scene timeline driver and probe cache are this tool's.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const util = require('util');
const { Uds, SUB, hexToBytes } = require('./uds.js');
const { ZONES, nadsOf } = require('./zones.js');

const LOG = '[edzco-light]';
const SOCKET = process.env.CTL_SOCKET || '/run/edzco-light/ctl.sock';
const LOG_FILE = process.env.LIGHT_LOG || '/var/log/edzco-light/light.log';
const HMICTL = process.env.HMICTL || '/usr/bin/hmictl';
const BDC_TARGET = 0x40;
const DID_LIN1_WRITE = [0xda, 0x5e];
const DID_LIN2_WRITE = [0xe3, 0xd1];
const HOLD_SECS = 254;                     // the layering job's maximum
const RENEW_MS = 120000;                   // renew every 2 minutes
const PROBE_MS = 1500;                     // a NAD probe's answer time
const PROBE_RATE_MS = 60000;               // retry probes once a minute
const QUEUE_SOFT_MAX = 64;                 // if the queue grows past this, drop oldest frames

function log() {
    const line = [new Date().toISOString()].concat([].slice.call(arguments)
        .map((x) => (typeof x === 'string' ? x : util.inspect(x, { depth: 4 }).slice(0, 2000)))).join(' ');
    console.error(LOG, line);
    try { if (fs.statSync(LOG_FILE).size > 256 * 1024) fs.writeFileSync(LOG_FILE, ''); } catch (e) {}
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
}

// -------- hmictl child process (one `serve` session, shared stdin/stdout) --
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

// -------- rgb helpers ------------------------------------------------------
function hexRgb(h) {
    const s = String(h || '').replace('#', '');
    if (s.length !== 6) return [0, 0, 0];
    return [
        Math.min(0xfe, parseInt(s.slice(0, 2), 16)),
        Math.min(0xfe, parseInt(s.slice(2, 4), 16)),
        Math.min(0xfe, parseInt(s.slice(4, 6), 16)),
    ];
}

// -------- probe which NADs answer ------------------------------------------
// A quick single-NAD write at brightness 0, hold 1 s. If the gateway answers
// negatively (NRC 31 requestOutOfRange, 33 security, 22 conditionsNotCorrect)
// that NAD is marked unavailable and skipped next time. The probe runs lazily:
// first time a zone is used on this session.
function Probe(uds) {
    const good = new Set();                   // key: `${bus}:${nad}`
    const bad = new Set();
    const lastProbedAt = new Map();

    async function probe(bus, nad) {
        const key = bus + ':' + nad;
        if (good.has(key) || bad.has(key)) return good.has(key);
        const now = Date.now();
        const lastAt = lastProbedAt.get(key) || 0;
        if (now - lastAt < PROBE_RATE_MS) return false;
        lastProbedAt.set(key, now);
        const did = (bus === 'lin1') ? DID_LIN1_WRITE : DID_LIN2_WRITE;
        const data = [...did, nad, 0, 0, 0, 0, 0, 1]; // off, hold 1 s - a harmless touch
        try {
            await uds.send(BDC_TARGET, 0x2e, data.slice(2), PROBE_MS);
            good.add(key);
            return true;
        } catch (e) {
            bad.add(key);
            return false;
        }
    }

    function knownGood(bus, nad) { return good.has(bus + ':' + nad); }
    function statsByZone() {
        const out = {};
        for (const z of ZONES) {
            out[z] = { lin1: 0, lin2: 0 };
            for (const bus of ['lin1', 'lin2']) {
                for (const nad of nadsOf(z, bus)) if (good.has(bus + ':' + nad)) out[z][bus]++;
            }
        }
        return out;
    }
    return { probe, knownGood, statsByZone };
}

// -------- apply a zones snapshot ------------------------------------------
// Builds the UDS writes for every known-good NAD in every zone present. One
// write per NAD; we rely on the gateway's queue, not any SOME/IP fan-out.
function applyFrame(sess, zones) {
    const writes = [];
    for (const z of Object.keys(zones)) {
        if (!ZONES.includes(z)) continue;
        const zone = zones[z];
        const [r, g, b] = hexRgb(zone.rgb || '#000000');
        const br = Math.max(0, Math.min(100, (zone.brightness == null ? 100 : zone.brightness) | 0));
        const on = br >= 10 ? 1 : 0;
        for (const bus of ['lin1', 'lin2']) {
            const did = (bus === 'lin1') ? DID_LIN1_WRITE : DID_LIN2_WRITE;
            for (const nad of nadsOf(z, bus)) {
                writes.push({ bus, nad, did, payload: [nad, on, br, r, g, b, HOLD_SECS] });
            }
        }
    }
    // soft queue cap: too many writes outstanding -> drop frame
    if (sess.pendingWrites + writes.length > QUEUE_SOFT_MAX) {
        return;
    }
    sess.lastZones = zones;
    sess.lastWriteMs = Date.now();
    sess.pendingWrites += writes.length;
    for (const w of writes) {
        sess.probe.probe(w.bus, w.nad).then((ok) => {
            if (!ok) { sess.pendingWrites--; return; }
            sess.uds.send(BDC_TARGET, 0x2e, w.payload, 2000)
                .catch(() => {})
                .finally(() => sess.pendingWrites--);
        });
    }
}

// -------- Stop: send OFF to every NAD we've been driving ------------------
function stopAll(sess) {
    const seen = {};
    for (const z of Object.keys(sess.lastZones || {})) seen[z] = true;
    for (const z of Object.keys(seen)) {
        for (const bus of ['lin1', 'lin2']) {
            const did = (bus === 'lin1') ? DID_LIN1_WRITE : DID_LIN2_WRITE;
            for (const nad of nadsOf(z, bus)) {
                if (!sess.probe.knownGood(bus, nad)) continue;
                const payload = [nad, 0, 0, 0, 0, 0, 0];
                sess.uds.send(BDC_TARGET, 0x2e, payload, 1500).catch(() => {});
            }
        }
    }
    sess.lastZones = {};
    sess.lastWriteMs = 0;
}

// -------- renewal ---------------------------------------------------------
function startRenewal(sess) {
    setInterval(() => {
        if (!sess.lastZones || !Object.keys(sess.lastZones).length) return;
        if (Date.now() - sess.lastWriteMs < RENEW_MS - 5000) return;  // app is live, no need
        log('renewing');
        applyFrame(sess, sess.lastZones);
    }, 5000);
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
        sock.on('close', () => { /* keep lastZones - another client may reconnect */ });
    });
    srv.listen(SOCKET, () => { fs.chmodSync(SOCKET, 0o666); log('listening on', SOCKET); });
}

function handle(sess, msg) {
    if (!msg || typeof msg !== 'object') return Promise.reject(new Error('bad msg'));
    if (msg.op === 'ping') return Promise.resolve({ reply: 'pong' });
    if (msg.op === 'get')  return Promise.resolve({
        state: {
            connected: !!sess.hmi.proc,
            lastWriteMs: sess.lastWriteMs,
            probedZones: sess.probe.statsByZone(),
            zones: sess.lastZones || {},
        },
    });
    if (msg.op === 'set') {
        if (!msg.zones || typeof msg.zones !== 'object') return Promise.reject(new Error('set: zones missing'));
        applyFrame(sess, msg.zones);
        return Promise.resolve({ state: { lastWriteMs: sess.lastWriteMs, zones: msg.zones } });
    }
    if (msg.op === 'stop') { stopAll(sess); return Promise.resolve({ state: { stopped: true } }); }
    return Promise.reject(new Error('unknown op: ' + msg.op));
}

// -------- start -----------------------------------------------------------
function main() {
    try { fs.mkdirSync('/var/log/edzco-light', { recursive: true }); } catch (e) {}
    const hmi = Hmi();
    const uds = new Uds((line) => hmi.call(line), log);
    hmi.onEvent((hex) => uds.onEvent(hex));
    hmi.start();
    const sess = {
        hmi, uds,
        probe: Probe(uds),
        lastZones: {},
        lastWriteMs: 0,
        pendingWrites: 0,
    };
    serve(sess);
    startRenewal(sess);
    log('edzco-light started', { socket: SOCKET });

    process.on('SIGTERM', () => { log('SIGTERM; stopping all'); try { stopAll(sess); } catch (e) {} setTimeout(() => process.exit(0), 500); });
    process.on('SIGINT',  () => { log('SIGINT; stopping all');  try { stopAll(sess); } catch (e) {} setTimeout(() => process.exit(0), 500); });
}

if (require.main === module) main();

module.exports = { applyFrame, stopAll };
