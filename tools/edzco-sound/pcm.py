"""
pcm.py - edzco-sound's player. Writes a WAV into an ALSA PCM through libasound.so.2.

Why not aplay: the head unit's image is not known to carry alsa-utils, and moonride
(JustAnotherPU/moonride, car-tested on an X5 G05) does not use it either. It dlopen()s
libasound.so.2 and calls snd_pcm_open / snd_pcm_set_params / snd_pcm_writei on
plug:smartx:CarLifeMedia_CF_48_STEREO. This does the same calls through ctypes, with the
Python the MGU Store installs on every unit (mgu-python, /var/opt/mgu-python/current).

It stays running: sound.js starts it once and sends it one JSON line per request on stdin,
it answers one JSON line on stdout.

  -> {"op": "play", "file": "/path/x.wav", "device": "plug:smartx:...", "gain": 1.0}
  <- {"ok": true, "ms": 412, "frames": 19200, "waitedMs": 0, "eagain": 0}
  <- {"ok": false, "error": "...", "stage": "open|params|write|stall"}

  -> {"op": "probe", "device": "..."}         opens and configures the device, plays nothing
  <- {"ok": true, "libasound": "...", "open": "ok", "params": "ok"}

"stall" means the device took nothing for STALL_S: smartx only reads a source the
AudioManager has connected, so that is the route, not the file or the device.
"""
import ctypes
import json
import os
import sys
import time
import wave
from array import array

SND_PCM_STREAM_PLAYBACK = 0
SND_PCM_NONBLOCK = 1
SND_PCM_FORMAT_S16_LE = 2
SND_PCM_ACCESS_RW_INTERLEAVED = 3
EAGAIN = 11
RATE = 48000
CHANNELS = 2
LATENCY_US = 64000          # smartx: 1024-frame periods x 3, measured by moonride (MGU_ALSA_US)
PERIOD = 1024
STALL_S = 2.5               # nothing taken for this long: nobody is reading the source

_lib = None
_lib_error = None


def lib():
    global _lib, _lib_error
    if _lib is not None or _lib_error is not None:
        return _lib
    try:
        L = ctypes.CDLL('libasound.so.2')
    except OSError as e:
        _lib_error = 'libasound.so.2: ' + str(e)
        return None
    vp = ctypes.c_void_p
    L.snd_pcm_open.argtypes = [ctypes.POINTER(vp), ctypes.c_char_p, ctypes.c_int, ctypes.c_int]
    L.snd_pcm_open.restype = ctypes.c_int
    L.snd_pcm_set_params.argtypes = [vp, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint,
                                     ctypes.c_int, ctypes.c_uint]
    L.snd_pcm_set_params.restype = ctypes.c_int
    L.snd_pcm_writei.argtypes = [vp, vp, ctypes.c_ulong]
    L.snd_pcm_writei.restype = ctypes.c_long
    L.snd_pcm_recover.argtypes = [vp, ctypes.c_int, ctypes.c_int]
    L.snd_pcm_recover.restype = ctypes.c_int
    L.snd_pcm_delay.argtypes = [vp, ctypes.POINTER(ctypes.c_long)]
    L.snd_pcm_delay.restype = ctypes.c_int
    L.snd_pcm_close.argtypes = [vp]
    L.snd_pcm_close.restype = ctypes.c_int
    L.snd_strerror.argtypes = [ctypes.c_int]
    L.snd_strerror.restype = ctypes.c_char_p
    _lib = L
    return L


def errstr(L, rc):
    try:
        s = L.snd_strerror(rc)
        return (s or b'').decode('utf-8', 'replace') + ' (' + str(rc) + ')'
    except Exception:
        return str(rc)


def load_wav(file, gain):
    """The file as 48 kHz stereo S16, padded with silence to whole periods plus one, so the
    last partial period is not left in the plugin's buffer when the PCM closes."""
    w = wave.open(file, 'rb')
    try:
        ch, width, rate, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    finally:
        w.close()
    if width != 2:
        raise ValueError('only 16-bit WAV is supported, this is %d-bit' % (8 * width))
    if rate != RATE:
        raise ValueError('only 48000 Hz WAV is supported, this is %d Hz' % rate)
    s = array('h')
    s.frombytes(raw)
    if sys.byteorder != 'little':
        s.byteswap()
    if ch == 1:
        st = array('h', bytes(4 * len(s)))
        st[0::2] = s
        st[1::2] = s
        s = st
    elif ch != 2:
        raise ValueError('only mono or stereo WAV is supported, this has %d channels' % ch)
    if gain != 1.0:
        s = array('h', (max(-32768, min(32767, int(v * gain))) for v in s))
    frames = len(s) // 2
    pad = (PERIOD - frames % PERIOD) % PERIOD + PERIOD
    s.extend(array('h', bytes(4 * pad)))
    return s, frames


def open_pcm(L, device):
    pcm = ctypes.c_void_p()
    # nonblocking, as moonride: a source nobody has connected must not park this process
    rc = L.snd_pcm_open(ctypes.byref(pcm), device.encode('utf-8'), SND_PCM_STREAM_PLAYBACK, SND_PCM_NONBLOCK)
    if rc < 0:
        return None, 'open', errstr(L, rc)
    rc = L.snd_pcm_set_params(pcm, SND_PCM_FORMAT_S16_LE, SND_PCM_ACCESS_RW_INTERLEAVED,
                              CHANNELS, RATE, 1, LATENCY_US)
    if rc < 0:
        L.snd_pcm_close(pcm)
        return None, 'params', errstr(L, rc)
    return pcm, None, None


def play(msg):
    L = lib()
    if L is None:
        return {'ok': False, 'stage': 'libasound', 'error': _lib_error}
    try:
        samples, frames = load_wav(msg['file'], float(msg.get('gain') or 1.0))
    except Exception as e:
        return {'ok': False, 'stage': 'file', 'error': str(e)}

    pcm, stage, err = open_pcm(L, msg['device'])
    if pcm is None:
        return {'ok': False, 'stage': stage, 'error': err}

    t0 = time.monotonic()
    total = len(samples) // 2
    base = samples.buffer_info()[0]
    pos, eagain, recovered = 0, 0, 0
    last_progress = t0
    first_take = None
    try:
        while pos < total:
            n = min(PERIOD, total - pos)
            w = L.snd_pcm_writei(pcm, base + pos * 4, n)
            now = time.monotonic()
            if w == -EAGAIN:
                eagain += 1
                if now - last_progress > STALL_S:
                    return {'ok': False, 'stage': 'stall', 'eagain': eagain,
                            'error': 'device took %d of %d frames in %.1f s: the source is not connected'
                                     % (pos, total, now - t0)}
                time.sleep(0.004)
                continue
            if w < 0:
                rc = L.snd_pcm_recover(pcm, int(w), 1)
                recovered += 1
                if rc < 0 or recovered > 20:
                    return {'ok': False, 'stage': 'write', 'error': errstr(L, int(w))}
                continue
            if first_take is None:
                first_take = now
            pos += w
            last_progress = now
        # let what is in the device's buffer play out before close() drops it
        d = ctypes.c_long(0)
        end = time.monotonic() + 1.0
        while time.monotonic() < end:
            if L.snd_pcm_delay(pcm, ctypes.byref(d)) < 0 or d.value <= 0:
                break
            time.sleep(0.01)
    finally:
        L.snd_pcm_close(pcm)
    return {'ok': True, 'ms': int((time.monotonic() - t0) * 1000), 'frames': frames,
            'waitedMs': int(((first_take or t0) - t0) * 1000), 'eagain': eagain, 'recovered': recovered}


def probe(msg):
    L = lib()
    out = {'ok': L is not None, 'python': sys.version.split()[0],
           'libasound': 'loaded' if L is not None else _lib_error}
    if L is None:
        return out
    pcm, stage, err = open_pcm(L, msg['device'])
    if pcm is None:
        out['ok'] = False
        out[stage] = err
        return out
    L.snd_pcm_close(pcm)
    out['open'] = 'ok'
    out['params'] = 'ok'
    return out


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            op = msg.get('op')
            if op == 'play':
                r = play(msg)
            elif op == 'probe':
                r = probe(msg)
            else:
                r = {'ok': False, 'error': 'unknown op: %s' % op}
        except Exception as e:
            r = {'ok': False, 'stage': 'helper', 'error': '%s: %s' % (type(e).__name__, e)}
        sys.stdout.write(json.dumps(r) + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    main()
