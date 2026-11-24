'use strict';
/*
 * sound.js - edzco-sound daemon. Plays short effects through the car's speakers.
 * Runs on the unit's /usr/bin/node (8.16.2): no syntax newer than that.
 *
 * How sound reaches the speakers on an MGU head unit
 * ---------------------------------------------------
 * Not by opening a hardware PCM. The head unit runs a GENIVI AudioManager, and anything
 * that wants the speakers has to be a *source* it has routed to a *sink*. The route used
 * here is the one moonride found and proved on a car:
 *
 *   source 287  SmartX CarLifeMedia  (CarLife is China-only, so the slot is free elsewhere)
 *   sink  1024  the main speaker
 *   PCM         plug:smartx:CarLifeMedia_CF_48_STEREO   (48 kHz stereo)
 *
 * The routing half lives in the app, because AudioManager is reached over SOME/IP and the
 * app is the half with those proxies. This daemon owns the other half: writing PCM into
 * that device.
 *
 * The writing is done by pcm.py, which calls libasound.so.2 the way moonride's audio.cpp
 * does (snd_pcm_open nonblocking, snd_pcm_set_params S16 2ch 48 kHz 64 ms, snd_pcm_writei),
 * with the Python the MGU Store installs on every unit. The unit is not known to have aplay;
 * aplay is used only when that Python is missing.
 *
 * Why a root daemon at all: an OAP app has no access to the audio devices (Zeiger's Sound
 * Test was removed for exactly this). A systemd service does.
 *
 * Control socket: /run/edzco-sound/ctl.sock, JSON lines.
 *   -> { "op": "ping" }
 *   -> { "op": "list" }                       the effects on disk
 *   -> { "op": "play", "id": "crackle_med" }  play one, now; answers when it has played
 *   -> { "op": "stop" }                       kill whatever is playing
 *   -> { "op": "probe" }                      what this head unit has for audio
 *   -> { "op": "status" }                     the backend and the last play's outcome
 *
 *   <- { "reply": "pong" }
 *   <- { "effects": [ { id, name, level, durationMs } ] }
 *   <- { "played": "crackle_med", "ms": 994, "backend": "pcm.py", "waitedMs": 0 }
 *   <- { "probe": { backend, python, libasound, open, params, aplay, pcms, ... } }
 *   <- { "error": "...", "stage": "open|params|stall|..." }
 *
 * A request's "seq" (any number) comes back on its reply.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execFile } = require('child_process');
const util = require('util');

const LOG = '[edzco-sound]';
const SOCKET = process.env.CTL_SOCKET || '/run/edzco-sound/ctl.sock';
const LOG_FILE = process.env.SOUND_LOG || '/var/opt/edzco-sound/data/sound.log';
const SOUND_DIR = process.env.SOUND_DIR || path.join(__dirname, 'sounds');
// the device moonride uses, car-tested on an X5 G05 (jap-moonride.service)
const DEVICE = process.env.EDZCO_PCM || 'plug:smartx:CarLifeMedia_CF_48_STEREO';
const PYTHON = process.env.EDZCO_PYTHON || '/var/opt/mgu-python/current/bin/python3';
const HELPER = path.join(__dirname, 'pcm.py');
const APLAY = process.env.APLAY || 'aplay';
const GAIN = Number(process.env.EDZCO_GAIN) || 1.0;
const PLAY_GUARD_MS = 6000;     // longest effect 1.7 s + up to 2.5 s waiting for the route

function log() {
    const line = [new Date().toISOString()].concat([].slice.call(arguments)
        .map((x) => (typeof x === 'string' ? x : util.inspect(x, { depth: 4 }).slice(0, 2000)))).join(' ');
    console.error(LOG, line);        // the journal: StandardError=journal in the unit
    try { if (fs.statSync(LOG_FILE).size > 256 * 1024) fs.writeFileSync(LOG_FILE, ''); } catch (e) {}
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
}

// -------- the effects on disk -------------------------------------------
function loadManifest() {
    try {
        const raw = fs.readFileSync(path.join(SOUND_DIR, 'sounds.json'), 'utf8');
        const m = JSON.parse(raw);
        return Array.isArray(m.effects) ? m.effects : [];
    } catch (e) {
        // no manifest: fall back to whatever .wav files are there, so a hand-dropped
        // recording still works
        try {
            return fs.readdirSync(SOUND_DIR)
                .filter((f) => f.toLowerCase().endsWith('.wav'))
                .map((f) => ({ id: path.basename(f, path.extname(f)), name: f, level: 3, file: f }));
        } catch (e2) { return []; }
    }
}

// -------- pcm.py: one long-lived Python, one JSON line per request -------
function Helper() {
    const self = {
        child: null, buf: '', waiting: null,
        available() { return fs.existsSync(PYTHON) && fs.existsSync(HELPER); },
        start() {
            const child = spawn(PYTHON, ['-I', '-u', HELPER], { stdio: ['pipe', 'pipe', 'pipe'] });
            self.child = child; self.buf = '';
            child.stdout.on('data', (c) => {
                self.buf += c.toString('utf8');
                let i;
                while ((i = self.buf.indexOf('\n')) >= 0) {
                    const line = self.buf.slice(0, i).trim();
                    self.buf = self.buf.slice(i + 1);
                    const w = self.waiting; self.waiting = null;
                    if (!w) continue;
                    let r;
                    try { r = JSON.parse(line); } catch (e) { r = { ok: false, stage: 'helper', error: 'bad reply: ' + line.slice(0, 200) }; }
                    w(r);
                }
            });
            child.stderr.on('data', (c) => log('pcm.py:', c.toString('utf8').trim().slice(0, 1000)));
            const gone = (why) => {
                if (self.child !== child) return;
                self.child = null;
                const w = self.waiting; self.waiting = null;
                if (w) w({ ok: false, stage: 'helper', error: 'pcm.py ' + why });
            };
            child.on('error', (e) => gone('failed to start: ' + e.message));
            child.on('exit', (code, sig) => gone('exited ' + (sig || code)));
            child.stdin.on('error', () => {});
        },
        request(msg, timeoutMs) {
            return new Promise((resolve) => {
                if (!self.child) self.start();
                if (self.waiting) { resolve({ ok: false, stage: 'helper', error: 'busy' }); return; }
                const t = setTimeout(() => {
                    if (!self.waiting) return;
                    self.waiting = null;
                    log('pcm.py did not answer in ' + timeoutMs + ' ms, restarting it');
                    self.kill();
                    resolve({ ok: false, stage: 'timeout', error: 'pcm.py did not answer in ' + timeoutMs + ' ms' });
                }, timeoutMs);
                self.waiting = (r) => { clearTimeout(t); resolve(r); };
                try { self.child.stdin.write(JSON.stringify(msg) + '\n'); }
                catch (e) { self.waiting = null; clearTimeout(t); resolve({ ok: false, stage: 'helper', error: String(e.message || e) }); }
            });
        },
        busy() { return !!self.waiting; },
        kill() {
            const c = self.child; self.child = null;
            const w = self.waiting; self.waiting = null;
            if (c) { try { c.kill('SIGKILL'); } catch (e) {} }
            if (w) w({ ok: false, stage: 'stopped', error: 'stopped' });
        },
    };
    return self;
}

// -------- aplay, only without the Python ---------------------------------
function aplayFile(file) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        let err = '', done = false;
        const child = spawn(APLAY, ['-D', DEVICE, '-q', file], { stdio: ['ignore', 'ignore', 'pipe'] });
        const finish = (r) => { if (done) return; done = true; clearTimeout(guard); resolve(r); };
        const guard = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} finish({ ok: false, stage: 'stall', error: 'aplay did not finish in ' + PLAY_GUARD_MS + ' ms' }); }, PLAY_GUARD_MS);
        child.stderr.on('data', (c) => { err += c.toString('utf8'); });
        child.on('error', (e) => finish({ ok: false, stage: 'aplay', error: 'aplay: ' + e.message }));
        child.on('exit', (code) => finish(code === 0 ? { ok: true, ms: Date.now() - t0 }
            : { ok: false, stage: 'aplay', error: 'aplay exit ' + code + (err ? ': ' + err.trim().slice(0, 300) : '') }));
    });
}

// -------- playback -------------------------------------------------------
function Player() {
    const helper = Helper();
    const self = {
        helper,
        backend() { return helper.available() ? 'pcm.py' : 'aplay'; },
        last: null,      // { id, at, ok, ms, error, stage, backend }

        play(effect) {
            const file = path.join(SOUND_DIR, effect.file || (effect.id + '.wav'));
            if (!fs.existsSync(file)) return Promise.reject(new Error('no such file: ' + file));
            const backend = self.backend();
            // one at a time: a second pop stepping on the first sounds like a glitch
            if (backend === 'pcm.py' && helper.busy()) helper.kill();
            const p = backend === 'pcm.py'
                ? helper.request({ op: 'play', file, device: DEVICE, gain: GAIN }, PLAY_GUARD_MS)
                : aplayFile(file);
            return p.then((r) => {
                self.last = Object.assign({ id: effect.id, at: Date.now(), backend }, r);
                if (!r.ok) {
                    const e = new Error((r.stage ? r.stage + ': ' : '') + r.error);
                    e.stage = r.stage;
                    throw e;
                }
                return Object.assign({ backend }, r);
            });
        },

        stop() { helper.kill(); },
    };
    return self;
}

// -------- probe ----------------------------------------------------------
function probe(player) {
    const run = (cmd, args) => new Promise((res) => {
        execFile(cmd, args, { timeout: 4000 }, (e, so, se) =>
            res(e ? { ok: false, out: String((se || e.message || '')).slice(0, 2000) }
                  : { ok: true, out: String(so || '').slice(0, 4000) }));
    });
    const py = player.helper.available()
        ? player.helper.request({ op: 'probe', device: DEVICE }, 5000)
        : Promise.resolve({ ok: false, error: 'no ' + PYTHON + ' (mgu-python)' });

    return Promise.all([py, run(APLAY, ['--version']), run(APLAY, ['-L']), run('cat', ['/proc/asound/cards'])])
        .then(([p, ver, pcms, cards]) => ({
            backend: player.backend(),
            device: DEVICE,
            python: p,
            aplay: ver.ok ? ver.out.trim().split('\n')[0] : 'NOT FOUND',
            pcms: pcms.ok ? pcms.out : '(no aplay)',
            cards: cards.ok ? cards.out : '(' + cards.out.trim() + ')',
            soundDir: SOUND_DIR,
            effects: loadManifest().length,
            last: player.last,
        }));
}

// -------- control socket -------------------------------------------------
function handle(sess, msg) {
    if (!msg || typeof msg !== 'object') return Promise.reject(new Error('bad msg'));

    if (msg.op === 'ping') return Promise.resolve({ reply: 'pong' });

    if (msg.op === 'list') {
        return Promise.resolve({ effects: sess.effects.map((e) => ({
            id: e.id, name: e.name, level: e.level, durationMs: e.durationMs })) });
    }

    if (msg.op === 'play') {
        const fx = sess.effects.find((e) => e.id === msg.id);
        if (!fx) return Promise.reject(new Error('no such effect: ' + msg.id));
        return sess.player.play(fx).then((r) => {
            log('played', fx.id, r.ms + ' ms via ' + r.backend
                + (r.waitedMs ? ', waited ' + r.waitedMs + ' ms for the route' : ''));
            return { played: fx.id, ms: r.ms, backend: r.backend, waitedMs: r.waitedMs };
        }, (e) => {
            log('play', fx.id, 'FAILED', e.message);
            throw e;
        });
    }

    if (msg.op === 'stop') { sess.player.stop(); return Promise.resolve({ stopped: true }); }

    if (msg.op === 'status') return Promise.resolve({ backend: sess.player.backend(), device: DEVICE, last: sess.player.last });

    if (msg.op === 'probe') return probe(sess.player).then((p) => {
        log('probe', p);
        return { probe: p };
    });

    return Promise.reject(new Error('unknown op: ' + msg.op));
}

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
                // requests run concurrently, so every reply carries its request's seq
                const seq = msg && msg.seq;
                handle(sess, msg).then(
                    (reply) => sock.write(JSON.stringify(Object.assign({ seq }, reply)) + '\n'),
                    (err) => sock.write(JSON.stringify({ seq, error: String(err.message || err), stage: err.stage }) + '\n'));
            }
        });
        sock.on('error', () => {});
    });
    srv.listen(SOCKET, () => { fs.chmodSync(SOCKET, 0o666); log('listening on', SOCKET); });
}

function main() {
    try { fs.mkdirSync(path.dirname(LOG_FILE)); } catch (e) {}
    const sess = { effects: loadManifest(), player: Player() };
    log('edzco-sound started', {
        socket: SOCKET, device: DEVICE, soundDir: SOUND_DIR, effects: sess.effects.length,
        backend: sess.player.backend(), python: PYTHON,
    });
    if (!sess.effects.length) log('WARNING: no effects found in ' + SOUND_DIR);
    serve(sess);
    // what this unit has, in the journal at every start: no SSH needed to read it back
    probe(sess.player).then((p) => log('probe at start', p), (e) => log('probe at start failed', String(e)));

    const shutdown = () => { try { sess.player.stop(); } catch (e) {} process.exit(0); };
    process.on('SIGTERM', () => { log('SIGTERM'); shutdown(); });
    process.on('SIGINT', () => { log('SIGINT'); shutdown(); });
}

if (require.main === module) main();

module.exports = { loadManifest, probe, Player, DEVICE };
