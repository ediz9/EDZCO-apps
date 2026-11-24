'use strict';
/*
 * sound.js - edzco-sound daemon. Plays short effects through the car's speakers.
 *
 * How sound reaches the speakers on an MGU head unit
 * ---------------------------------------------------
 * Not by opening a hardware PCM. The head unit runs a GENIVI AudioManager, and anything
 * that wants the speakers has to be a *source* it has routed to a *sink*. The route used
 * here is the one moonride found and proved on a car:
 *
 *   source 287  SmartX CarLifeMedia  (CarLife is China-only, so the slot is free elsewhere)
 *   sink  1024  the main speaker
 *   PCM         plug:smartx:CarLifeMedia_CF_48_STEREO   (48 kHz stereo; `plug:` converts)
 *
 * The routing half lives in the app, because AudioManager is reached over SOME/IP and the
 * app is the half with those proxies. This daemon owns the other half: writing PCM into
 * that device. It plays only when the app says the route is up.
 *
 * Why a root daemon at all: Zeiger tried to play sound from inside an OAP app and found it
 * has no access to the audio devices (its Sound Test app was removed for exactly this).
 * A systemd service does have access.
 *
 * Control socket: /run/edzco-sound/ctl.sock, JSON lines.
 *   -> { "op": "ping" }
 *   -> { "op": "list" }                       the effects on disk
 *   -> { "op": "play", "id": "crackle_med" }  play one, now
 *   -> { "op": "stop" }                       kill whatever is playing
 *   -> { "op": "probe" }                      what this head unit has for audio
 *
 *   <- { "reply": "pong" }
 *   <- { "effects": [ { id, name, level, durationMs } ] }
 *   <- { "played": "crackle_med", "ms": 994 }
 *   <- { "probe": { aplay, devices, pcms, device, deviceOk } }
 *   <- { "error": "..." }
 *
 * `probe` matters on a new car: if the CarLifeMedia PCM is named differently, or the head
 * unit has no aplay, this is what tells you before anything else is debugged.
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
const APLAY = process.env.APLAY || 'aplay';
const MAX_CONCURRENT_MS = 4000;          // nothing we ship is longer; a guard against a stuck child

function log() {
    const line = [new Date().toISOString()].concat([].slice.call(arguments)
        .map((x) => (typeof x === 'string' ? x : util.inspect(x, { depth: 4 }).slice(0, 2000)))).join(' ');
    console.error(LOG, line);        // the journal: StandardOutput=journal in the unit
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

// -------- playback -------------------------------------------------------
function Player() {
    const self = {
        child: null,
        startedAt: 0,
        currentId: null,

        play(effect) {
            return new Promise((resolve, reject) => {
                const file = path.join(SOUND_DIR, effect.file || (effect.id + '.wav'));
                if (!fs.existsSync(file)) { reject(new Error('no such file: ' + file)); return; }

                // one at a time: a second pop stepping on the first sounds like a glitch,
                // not like two pops. The app's own cooldown should prevent this anyway.
                self.stop();

                const args = ['-D', DEVICE, '-q', file];
                let done = false;
                const child = spawn(APLAY, args, { stdio: ['ignore', 'ignore', 'pipe'] });
                self.child = child;
                self.startedAt = Date.now();
                self.currentId = effect.id;

                let err = '';
                child.stderr.on('data', (c) => { err += c.toString('utf8'); });
                const guard = setTimeout(() => {
                    if (!done) { log('play guard fired, killing', effect.id); self.stop(); }
                }, MAX_CONCURRENT_MS);

                child.on('error', (e) => {
                    if (done) return;
                    done = true; clearTimeout(guard);
                    self.child = null; self.currentId = null;
                    reject(new Error('aplay: ' + e.message));
                });
                child.on('exit', (code) => {
                    if (done) return;
                    done = true; clearTimeout(guard);
                    const ms = Date.now() - self.startedAt;
                    self.child = null; self.currentId = null;
                    if (code === 0) { resolve({ ms }); }
                    else reject(new Error('aplay exit ' + code + (err ? ': ' + err.trim().slice(0, 300) : '')));
                });
            });
        },

        stop() {
            if (self.child) {
                try { self.child.kill('SIGKILL'); } catch (e) {}
                self.child = null;
                self.currentId = null;
            }
        },
    };
    return self;
}

// -------- probe ----------------------------------------------------------
// Run once on a new car. Zeiger's removed Sound Test did the same job; the difference is
// that this runs as root, where the devices are actually reachable.
function probe() {
    const run = (cmd, args) => new Promise((res) => {
        execFile(cmd, args, { timeout: 4000 }, (e, so, se) =>
            res(e ? { ok: false, out: String((se || e.message || '')).slice(0, 2000) }
                  : { ok: true, out: String(so || '').slice(0, 4000) }));
    });

    return Promise.all([
        run(APLAY, ['--version']),
        run(APLAY, ['-l']),
        run(APLAY, ['-L']),
    ]).then(([ver, list, pcms]) => {
        const pcmText = pcms.ok ? pcms.out : '';
        // does the device we intend to use actually exist on this unit?
        const want = DEVICE.replace(/^plug:/, '');
        const deviceOk = pcmText.split('\n').some((l) => l.trim() === want || l.trim() === DEVICE);
        return {
            aplay: ver.ok ? ver.out.trim().split('\n')[0] : 'NOT FOUND (' + ver.out.trim() + ')',
            device: DEVICE,
            deviceOk,
            devices: list.ok ? list.out : '(aplay -l failed: ' + list.out + ')',
            pcms: pcmText || '(aplay -L failed: ' + pcms.out + ')',
            soundDir: SOUND_DIR,
            effects: loadManifest().length,
        };
    });
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
            log('played', fx.id, r.ms + ' ms');
            return { played: fx.id, ms: r.ms };
        });
    }

    if (msg.op === 'stop') { sess.player.stop(); return Promise.resolve({ stopped: true }); }

    if (msg.op === 'probe') return probe().then((p) => {
        log('probe', p.aplay, 'device ' + (p.deviceOk ? 'FOUND' : 'NOT LISTED'));
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
                    (err) => sock.write(JSON.stringify({ seq, error: String(err.message || err) }) + '\n'));
            }
        });
        sock.on('error', () => {});
    });
    srv.listen(SOCKET, () => { fs.chmodSync(SOCKET, 0o666); log('listening on', SOCKET); });
}

function main() {
    try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch (e) {}
    const sess = { effects: loadManifest(), player: Player() };
    log('edzco-sound started', {
        socket: SOCKET, device: DEVICE, soundDir: SOUND_DIR, effects: sess.effects.length,
    });
    if (!sess.effects.length) log('WARNING: no effects found in ' + SOUND_DIR);
    serve(sess);

    const shutdown = () => { try { sess.player.stop(); } catch (e) {} process.exit(0); };
    process.on('SIGTERM', () => { log('SIGTERM'); shutdown(); });
    process.on('SIGINT', () => { log('SIGINT'); shutdown(); });
}

if (require.main === module) main();

module.exports = { loadManifest, probe, DEVICE };
