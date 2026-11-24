#!/usr/bin/env python3
"""
make_sounds.py - synthesise ten overrun effects as 48 kHz stereo WAVs.

Target device is the head unit's CarLifeMedia PCM (plug:smartx:CarLifeMedia_CF_48_STEREO),
which is 48 kHz stereo, so everything is rendered natively at that rate.

Why synthesised and not recorded
--------------------------------
A recorded exhaust is someone's car and someone's licence, and the CC0 clips that do exist
("backfire" on Freesound) are single one-shot bangs - a car alarm sort of noise - not the
irregular stutter a real overrun makes. See docs/SOUNDS.md for the licensing survey and for
how to drop in your own recordings instead.

What an overrun actually sounds like, and what that means here
--------------------------------------------------------------
On a lift-off the throttle shuts, the engine pumps air, and fuel that did not burn in the
cylinder lights in the hot exhaust. So:

  * it is never ONE pop - it is a run of them, as each cylinder's charge goes off
  * the spacing is irregular. Evenly spaced pops read as a machine gun, not a car
  * it decays: the revs are falling, so the pops thin out and quieten
  * each pop is a transient (the crack) + the pipe ringing (the body) + a pressure thump
  * the pipe resonance barely moves between pops - it is the same pipe - but the crack's
    brightness varies a lot with how much fuel went off

Every effect below is built from those parts. `burst()` is the shared engine; the ten
effects are different settings of it.

Run:  python docs/make_sounds.py
Out:  tools/edzco-sound/sounds/*.wav  +  sounds.json (the manifest the app reads)
"""
from __future__ import annotations

import json
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE.parent / "tools" / "edzco-sound" / "sounds"
SR = 48_000


# ---------------------------------------------------------------- dsp
def _biquad(x, b, a):
    """Direct form I, vectorised over the two recursive taps via lfilter if SciPy is
    around, else a plain loop. Kept dependency-free on purpose."""
    try:
        from scipy.signal import lfilter          # noqa: PLC0415
        return lfilter(b, a, x)
    except Exception:
        y = np.zeros_like(x)
        x1 = x2 = y1 = y2 = 0.0
        for i, xi in enumerate(x):
            yi = b[0] * xi + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2
            y[i] = yi
            x2, x1 = x1, xi
            y2, y1 = y1, yi
        return y


def bandpass(x, f0, q, sr=SR):
    w0 = 2 * np.pi * f0 / sr
    al = np.sin(w0) / (2 * q)
    b = np.array([al, 0.0, -al])
    a = np.array([1 + al, -2 * np.cos(w0), 1 - al])
    return _biquad(x, b / a[0], a / a[0])


def highpass(x, f0, q=0.707, sr=SR):
    w0 = 2 * np.pi * f0 / sr
    al = np.sin(w0) / (2 * q)
    c = np.cos(w0)
    b = np.array([(1 + c) / 2, -(1 + c), (1 + c) / 2])
    a = np.array([1 + al, -2 * c, 1 - al])
    return _biquad(x, b / a[0], a / a[0])


def pop(rng, f0, q, thump_f, decay_ms, bright, length_ms=260.0):
    """One report: crack + pipe resonance + pressure thump."""
    n = int(SR * length_ms / 1000)
    src = rng.standard_normal(n)
    t = np.arange(n) / SR

    body = bandpass(src, f0, q)
    body /= np.max(np.abs(body)) + 1e-9
    body *= np.exp(-t / (decay_ms / 1000.0 * 0.38))

    crack = highpass(src, 2200.0)
    crack /= np.max(np.abs(crack)) + 1e-9
    crack *= np.exp(-t / (decay_ms / 1000.0 * 0.07))     # very short: it is a transient

    thump = np.sin(2 * np.pi * thump_f * t) * np.exp(-t / (decay_ms / 1000.0 * 0.26))

    sig = body + crack * bright + thump * 0.52
    # a soft knee stops the sum from spiking past the transient we want
    return np.tanh(sig * 1.25)


def burst(rng, count, pipe_f=300.0, pipe_q=2.3,
          gap_ms=(42, 110), decay_ms=(45, 110), bright=(0.45, 0.95),
          thump_f=(58, 105), fade=0.86, jitter=0.55, tail_ms=240):
    """A run of pops with irregular spacing, thinning out as it goes.

    count    how many reports
    pipe_f   the pipe's resonance - the SAME pipe for every pop, so it barely varies
    gap_ms   (min, max) spacing; the irregularity is what makes it read as an engine
    fade     gain multiplier per pop, so the run decays like falling revs
    jitter   0..1, how far the gaps wander toward the max
    """
    parts, t, gain = [], 0.0, 1.0
    for i in range(count):
        # the pipe hardly moves; the crack's brightness and the thump do
        f0 = pipe_f * rng.uniform(0.93, 1.08)
        p = pop(rng,
                f0=f0,
                q=pipe_q * rng.uniform(0.88, 1.15),
                thump_f=rng.uniform(*thump_f),
                decay_ms=rng.uniform(*decay_ms),
                bright=rng.uniform(*bright),
                length_ms=min(320.0, decay_ms[1] * 2.6))
        parts.append((t, p, gain * rng.uniform(0.62, 1.0)))
        lo, hi = gap_ms
        span = lo + (hi - lo) * jitter
        t += rng.uniform(lo, max(lo + 1.0, span))
        gain *= fade

    total = int(SR * (t + tail_ms) / 1000)
    buf = np.zeros(total)
    for off_ms, sig, g in parts:
        i = int(SR * off_ms / 1000)
        j = min(i + len(sig), total)
        if j > i:
            buf[i:j] += sig[: j - i] * g
    return buf


def stereo(mono, rng, width=0.0016):
    """A small inter-channel delay so it spreads across the cabin instead of collapsing
    into the middle. Kept short - a long delay would smear the transient."""
    d = max(int(SR * width), 1)
    left = mono
    right = np.concatenate([np.zeros(d), mono[:-d]])
    right = right * 0.94 + np.roll(right, 11) * 0.06
    return np.stack([left, right], axis=1)


def write_wav(path, data, peak=0.88):
    m = np.max(np.abs(data)) + 1e-9
    data = data / m * peak
    f = min(int(SR * 0.004), len(data) // 4)
    if f > 0:
        ramp = np.linspace(0.0, 1.0, f)[:, None]
        data[:f] *= ramp
        data[-f:] *= ramp[::-1]
    pcm = np.clip(data * 32767.0, -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    return len(data) / SR * 1000.0


# ---------------------------------------------------------------- the ten
# `level` is what the app matches against how hard the lift was: a gentle lift off 2500 rpm
# picks a 1, a hard lift off the limiter picks a 5.
EFFECTS = [
    dict(id="tick", name="Tick", level=1,
         note="Two soft ticks. A gentle lift at low revs.",
         make=lambda r: burst(r, 2, pipe_f=380, pipe_q=3.2, gap_ms=(70, 120),
                              decay_ms=(28, 46), bright=(0.3, 0.5), fade=0.8)),

    dict(id="pop", name="Pop", level=1,
         note="One clean report.",
         make=lambda r: burst(r, 1, pipe_f=300, pipe_q=2.2, decay_ms=(150, 170),
                              bright=(0.45, 0.55), tail_ms=200)),

    dict(id="double", name="Double", level=2,
         note="Two, the second deeper - how a real pair lands.",
         make=lambda r: burst(r, 2, pipe_f=320, pipe_q=2.4, gap_ms=(120, 150),
                              decay_ms=(140, 190), bright=(0.45, 0.65), fade=0.86)),

    dict(id="crackle_light", name="Crackle · Light", level=2,
         note="A short stutter, bright and thin.",
         make=lambda r: burst(r, 7, pipe_f=560, pipe_q=4.2, gap_ms=(40, 92),
                              decay_ms=(26, 52), bright=(0.65, 1.0),
                              thump_f=(92, 135), fade=0.90, jitter=0.7)),

    dict(id="crackle_med", name="Crackle · Medium", level=3,
         note="The everyday overrun: a dozen irregular cracks fading out.",
         make=lambda r: burst(r, 13, pipe_f=480, pipe_q=3.6, gap_ms=(36, 104),
                              decay_ms=(30, 68), bright=(0.6, 1.0),
                              thump_f=(84, 128), fade=0.91, jitter=0.85)),

    dict(id="crackle_heavy", name="Crackle · Heavy", level=4,
         note="Long and busy, the way a tuned car carries on after the lift.",
         make=lambda r: burst(r, 22, pipe_f=430, pipe_q=3.2, gap_ms=(30, 118),
                              decay_ms=(32, 82), bright=(0.55, 1.0),
                              thump_f=(78, 122), fade=0.945, jitter=1.0)),

    dict(id="burble_slow", name="Burble · Slow", level=2,
         note="Low and round, loafing. Less crack, more chest.",
         make=lambda r: burst(r, 9, pipe_f=185, pipe_q=1.9, gap_ms=(70, 140),
                              decay_ms=(80, 150), bright=(0.18, 0.34),
                              thump_f=(46, 68), fade=0.93, jitter=0.8)),

    dict(id="burble_fast", name="Burble · Fast", level=3,
         note="The same depth, closer together.",
         make=lambda r: burst(r, 15, pipe_f=210, pipe_q=2.1, gap_ms=(44, 92),
                              decay_ms=(60, 120), bright=(0.22, 0.42),
                              thump_f=(50, 76), fade=0.94, jitter=0.75)),

    dict(id="bang", name="Bang", level=4,
         note="One big one. Deep, slow to let go.",
         make=lambda r: burst(r, 1, pipe_f=175, pipe_q=1.7, decay_ms=(300, 330),
                              bright=(0.72, 0.8), thump_f=(48, 56), tail_ms=320)),

    dict(id="bang_tail", name="Bang · Tail", level=5,
         note="A big one, then the small ones falling away behind it.",
         make=lambda r: np.concatenate([
             burst(r, 1, pipe_f=180, pipe_q=1.7, decay_ms=(290, 320),
                   bright=(0.7, 0.8), thump_f=(46, 56), tail_ms=20),
             burst(r, 11, pipe_f=520, pipe_q=4.0, gap_ms=(34, 110),
                   decay_ms=(28, 60), bright=(0.6, 1.0),
                   thump_f=(88, 130), fade=0.87, jitter=0.9) * 0.6,
         ])),
]


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"48 kHz stereo -> {OUT_DIR}")
    manifest = []
    for fx in EFFECTS:
        # fixed seed per effect, so a rebuild is byte-identical and the repo does not churn
        rng = np.random.default_rng(sum(ord(c) * (i + 7) for i, c in enumerate(fx["id"])))
        mono = fx["make"](rng)
        path = OUT_DIR / f"{fx['id']}.wav"
        ms = write_wav(path, stereo(mono, rng))
        kb = path.stat().st_size // 1024
        print(f"  {fx['id']:<16} L{fx['level']}  {ms:6.0f} ms  {kb:>4} KB   {fx['note']}")
        manifest.append({
            "id": fx["id"], "name": fx["name"], "level": fx["level"],
            "note": fx["note"], "file": f"{fx['id']}.wav",
            "durationMs": round(ms),
        })

    mf = OUT_DIR / "sounds.json"
    mf.write_text(json.dumps({"sampleRate": SR, "channels": 2, "effects": manifest},
                             indent=2), encoding="utf-8")
    print(f"\nwrote {mf.name}  ({len(manifest)} effects)")


if __name__ == "__main__":
    main()
