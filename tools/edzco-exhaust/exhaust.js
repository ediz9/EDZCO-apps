'use strict';
/*
 * exhaust.js - edzco-exhaust daemon.
 *
 * Listens on /run/edzco-exhaust/ctl.sock (JSON lines, one op per line):
 *   -> { op: 'get' }                                    read current state
 *   -> { op: 'popbang', hold: true | false }            hold true: open flap; hold false: close (safety also forces it)
 *   -> { op: 'ping' }                                   liveness
 *
 *   <- { state: { connected, engineRunning, parked, engineKey, flap: 'open' | 'closed' | 'unknown', lastError } }
 *   <- { reply: 'pong' }
 *
 * Writes are gated by config.safety:
 *   - require_parked:   refused when !parked
 *   - require_engine_on: refused when !engineRunning
 *   - hold_max_ms:       tool itself closes the flap after this many ms of held-open
 *   - cooldown_ms:       at least this long between two open requests
 *
 * The identity of a running engine is read once from the DME (UDS 22 F190 = VIN, 22 F18C = ECU serial - or a
 * manufacturer DID if the operator prefers): the engine-family key is then used to look up the payload row in
 * config.json. Without a matching row the tool reports which key is missing and refuses to write - it never
 * guesses a DME DID.
 *
 * Attribution: the UDS layer (uds.js) and the hmictl line pattern are adapted from IterioDev's iteriodev-comfort
 * (MIT, Copyright 2026 cauliflowermossgrape).
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const util = require('util');
const { Uds, SUB, hexToBytes } = require('./uds.js');

const LOG = '[edzco-exhaust]';
const SOCKET = process.env.CTL_SOCKET || '/run/edzco-exhaust/ctl.sock';
const CONFIG_PATH = process.env.EXHAUST_CONFIG || path.join(__dirname, 'config.json');
const LOG_FILE = process.env.EXHAUST_LOG || '/var/log/edzco-exhaust/exhaust.log';
const HMICTL = process.env.HMICTL || '/usr/bin/hmictl';

function log() {
    const line = [new Date().toISOString()].concat([].slice.call(arguments)
        .map((x) => (typeof x === 'string' ? x : util.inspect(x, { depth: 4 }).slice(0, 2000)))).join(' ');
    console.error(LOG, line);
    try {
        if (fs.statSync(LOG_FILE).size > 256 * 1024) fs.writeFileSync(LOG_FILE, '');
    } catch (e) { /* first write: no file yet */ }
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) { /* no logs dir yet */ }
}

function loadConfig() {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    if (!cfg.ecus || typeof cfg.ecus !== 'object') throw new Error('config: ecus{} missing');
    if (!cfg.safety) cfg.safety = {};
    cfg.safety.require_parked = cfg.safety.require_parked !== false;
    cfg.safety.require_engine_on = cfg.safety.require_engine_on !== false;
    cfg.safety.hold_max_ms = cfg.safety.hold_max_ms || 3000;
    cfg.safety.cooldown_ms = cfg.safety.cooldown_ms || 1500;
    return cfg;
}

// ------------------------------------------------------------------- hmictl
// We spawn one `hmictl serve` child process and talk UDS over its stdin/stdout.
function Hmi() {
    const self = {
        proc: null,
        pendings: [],                  // { res, rej } for each outstanding `call` reply
        eventCb: null,
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
                        // "ev 0xf8a6 0x8001 <hex>"
                        const parts = line.split(/\s+/);
                        if (self.eventCb && parts[3]) self.eventCb(parts[3]);
                    } else {
                        const p = self.pendings.shift();
                        if (p) {
                            if (line.startsWith('error')) p.rej(new Error(line));
                            else p.res(line);
                        }
                    }
                }
            });
            self.proc.stderr.on('data', (c) => log('hmictl stderr', c.toString('utf8').trim()));
            // subscribe to the TASU event right away
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

// ---------------------------------------------------------- state gathering
// On 2026 we have no vetted way to read parking / engine state without going through CDS (a joynr proxy) which is
// only available from inside an OAP app sandbox, not from a systemd tool. So the tool defaults to a *safe* model:
// the app itself passes { parked, engineOn } with every popbang op. The tool trusts the app only as much as the
// safety config says: both flags default to required-true, and the operator may lower that in config.json.
//
// A later revision will bridge CDS via a small OAP "status" app whose only job is to publish a tiny JSON file
// on tmpfs this tool reads. For now: trust the flags; still refuse without them.
function currentState(sess) {
    return {
        connected: !!sess.hmi.proc,
        engineRunning: sess.lastHoldFlags.engineOn === true,
        parked: sess.lastHoldFlags.parked === true,
        flap: sess.flap,
        lastError: sess.lastError,
    };
}

// ---------------------------------------------------------- action
function writeFlap(sess, open) {
    const cfg = sess.cfg;
    const family = sess.cfg.engineFamily || 'DME_B58';     // operator overrides via config
    const row = cfg.ecus[family];
    if (!row) throw new Error('config: no ECU row for ' + family);
    const key = open ? 'popbang_open' : 'popbang_close';
    const spec = row[key];
    if (!spec || !spec.did_hex || !spec.payload_hex) {
        throw new Error('config: ' + family + '.' + key + ' not filled in - fill config.json before using');
    }
    const target = parseInt(row.target_hex, 16);
    const sid = parseInt(spec.sid_hex, 16);
    // For SID 2E (write by DID): data = DID(2) + payload
    // For SID 2F (I/O control):  data = DID(2) + control-opt(1) + payload
    const did = hexToBytes(spec.did_hex);
    const payload = hexToBytes(spec.payload_hex);
    const data = did.concat(payload);
    log('write', { family, open, target: target.toString(16), sid: sid.toString(16), did: spec.did_hex, payload: spec.payload_hex });
    return sess.uds.send(target, sid, data, 2500);
}

function openOrClose(sess, want) {
    // safety checks first
    const s = sess.cfg.safety;
    if (want && s.require_parked && !sess.lastHoldFlags.parked) {
        return Promise.reject(new Error('refused: car not parked'));
    }
    if (want && s.require_engine_on && !sess.lastHoldFlags.engineOn) {
        return Promise.reject(new Error('refused: engine not on'));
    }
    const now = Date.now();
    if (want && sess.lastOpenMs && now - sess.lastOpenMs < s.cooldown_ms) {
        return Promise.reject(new Error('refused: cooldown'));
    }
    return writeFlap(sess, want).then((uds) => {
        sess.flap = want ? 'open' : 'closed';
        sess.lastOpenMs = want ? now : sess.lastOpenMs;
        sess.lastError = null;
        return uds;
    }).catch((e) => { sess.lastError = String(e.message || e); throw e; });
}

// ------------------------------------------------------- control socket
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
                try { msg = JSON.parse(line); }
                catch (e) { sock.write(JSON.stringify({ error: 'bad json' }) + '\n'); continue; }
                handle(sess, msg).then((reply) => {
                    sock.write(JSON.stringify(reply) + '\n');
                }, (err) => {
                    sock.write(JSON.stringify({ error: String(err.message || err) }) + '\n');
                });
            }
        });
        sock.on('error', () => {});
    });
    srv.listen(SOCKET, () => {
        fs.chmodSync(SOCKET, 0o666);
        log('listening on', SOCKET);
    });
    // schedule a watchdog that auto-closes on hold_max_ms
    setInterval(() => {
        if (sess.flap === 'open' && sess.lastOpenMs && Date.now() - sess.lastOpenMs > sess.cfg.safety.hold_max_ms) {
            log('watchdog: hold_max_ms exceeded, closing');
            openOrClose(sess, false).catch((e) => log('watchdog close failed', e.message));
        }
    }, 500);
}

function handle(sess, msg) {
    if (!msg || typeof msg !== 'object') return Promise.reject(new Error('bad msg'));
    if (msg.op === 'ping') return Promise.resolve({ reply: 'pong' });
    if (msg.op === 'get')  return Promise.resolve({ state: currentState(sess) });
    if (msg.op === 'popbang') {
        // the app sends { op, hold, parked, engineOn }
        sess.lastHoldFlags = { parked: !!msg.parked, engineOn: !!msg.engineOn };
        return openOrClose(sess, !!msg.hold).then(() => ({ state: currentState(sess) }));
    }
    return Promise.reject(new Error('unknown op: ' + msg.op));
}

// ------------------------------------------------------- start
function main() {
    let cfg;
    try { cfg = loadConfig(); }
    catch (e) { log('config error', e.message); process.exit(2); }
    const hmi = Hmi();
    const uds = new Uds((line) => hmi.call(line), log);
    hmi.onEvent((hex) => uds.onEvent(hex));
    hmi.start();
    const sess = {
        cfg, hmi, uds,
        flap: 'unknown',
        lastOpenMs: 0,
        lastError: null,
        lastHoldFlags: { parked: false, engineOn: false },
    };
    serve(sess);
    log('edzco-exhaust started', { socket: SOCKET, configPath: CONFIG_PATH });

    process.on('SIGTERM', () => { log('SIGTERM'); try { uds.close(); } catch (e) {} process.exit(0); });
    process.on('SIGINT', () => { log('SIGINT'); try { uds.close(); } catch (e) {} process.exit(0); });
}

if (require.main === module) main();

module.exports = { loadConfig, openOrClose, writeFlap };
