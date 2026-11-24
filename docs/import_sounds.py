#!/usr/bin/env python3
"""
import_sounds.py - bring recorded exhaust pops in from a folder of OGG/WAV/MP3 files,
pick the strongest ones, and convert them to the head unit's native format.

Written for the EX_POP_*.ogg set, but it takes any folder: it decodes everything with
ffmpeg, measures each clip, ranks them, and writes the top N as 48 kHz stereo WAVs next
to the synthesised effects.

Ranking - "longest and hardest"
-------------------------------
Picking by file size would mostly rank by how well the encoder did. Instead each clip is
scored on what actually makes a pop sound big:

  duration    a longer tail reads as a bigger pipe
  peak        how hard the transient hits
  body        energy below 500 Hz - the chest thump, which is what "hard" really means
  attack      how fast it gets to peak; a slow swell is not a pop

and penalised for near-silence and for clipping (already-squashed clips sound worse once
the car's own volume is on top).

Run:  python docs/import_sounds.py <folder> [--count 10] [--prefix ex]
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE.parent / "tools" / "edzco-sound" / "sounds"
SR = 48_000
AUDIO_EXT = {".ogg", ".wav", ".mp3", ".flac", ".m4a", ".aac", ".opus"}


def ffmpeg_bin():
    exe = shutil.which("ffmpeg")
    if not exe:
        sys.exit("ffmpeg not found on PATH - needed to decode the source clips")
    return exe


def decode(path, ff):
    """Decode to mono float32 at SR, for measuring."""
    cmd = [ff, "-v", "error", "-i", str(path),
           "-f", "f32le", "-acodec", "pcm_f32le", "-ac", "1", "-ar", str(SR), "-"]
    out = subprocess.run(cmd, capture_output=True)
    if out.returncode != 0:
        return None
    return np.frombuffer(out.stdout, dtype="<f4").astype(np.float64)


def low_energy(x, cutoff=500.0, sr=SR):
    """Share of the energy under `cutoff` - the thump rather than the crack."""
    n = 1 << int(np.ceil(np.log2(max(len(x), 2))))
    spec = np.abs(np.fft.rfft(x, n)) ** 2
    freqs = np.fft.rfftfreq(n, 1 / sr)
    total = spec.sum() + 1e-12
    return float(spec[freqs <= cutoff].sum() / total)


def measure(x):
    if x is None or len(x) < 64:
        return None
    peak = float(np.max(np.abs(x)))
    if peak < 1e-4:
        return None
    rms = float(np.sqrt(np.mean(x ** 2)))
    dur = len(x) / SR

    # attack: time from the start of audible signal to the peak
    thr = peak * 0.5
    above = np.nonzero(np.abs(x) >= thr)[0]
    attack_ms = (above[0] / SR * 1000.0) if len(above) else 999.0

    # clipping: samples sitting right at full scale
    clipped = float(np.mean(np.abs(x) > 0.985))

    return dict(dur=dur, peak=peak, rms=rms, body=low_energy(x),
                attack_ms=attack_ms, clipped=clipped)


def score(m):
    """Bigger is better. Weights chosen so duration and body dominate, because that is
    what 'long and hard' means for an exhaust pop - a short bright tick can be loud
    without sounding big."""
    dur = min(m["dur"], 2.5) / 2.5                 # cap: past ~2.5 s it is a different thing
    body = m["body"]
    hit = m["rms"] / (m["peak"] + 1e-9)            # dense rather than one spike
    fast = 1.0 - min(m["attack_ms"], 120.0) / 120.0

    s = (dur * 3.0) + (body * 2.6) + (m["peak"] * 1.4) + (hit * 1.2) + (fast * 0.8)
    s -= m["clipped"] * 4.0                        # already squashed: sounds worse loud
    return s


def to_wav(src, dst, ff, peak=0.88):
    """Decode to 48 kHz, normalise, short fades, write 16-bit.

    Written mono when both channels are identical. Most of these packs are mono sources
    that a decoder duplicated, and shipping the same samples twice doubles the file for
    nothing - ALSA's `plug:` fans mono out to the stereo device anyway.
    """
    cmd = [ff, "-v", "error", "-i", str(src),
           "-f", "f32le", "-acodec", "pcm_f32le", "-ac", "2", "-ar", str(SR), "-"]
    out = subprocess.run(cmd, capture_output=True)
    if out.returncode != 0:
        return None
    data = np.frombuffer(out.stdout, dtype="<f4").astype(np.float64).reshape(-1, 2)
    if not len(data):
        return None

    # dual mono? compare the channels against the signal's own level, not an absolute
    spread = np.abs(data[:, 0] - data[:, 1]).mean() / (np.abs(data).mean() + 1e-9)
    if spread < 0.02:
        data = data[:, :1]

    m = np.max(np.abs(data)) + 1e-9
    data = data / m * peak
    f = min(int(SR * 0.004), len(data) // 4)
    if f > 0:
        ramp = np.linspace(0.0, 1.0, f)[:, None]
        data[:f] *= ramp
        data[-f:] *= ramp[::-1]

    pcm = np.clip(data * 32767.0, -32768, 32767).astype("<i2")
    with wave.open(str(dst), "wb") as w:
        w.setnchannels(data.shape[1])
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    return len(data) / SR * 1000.0


def level_for(rank, total):
    """Spread the kept clips evenly across the app's 1-5 lift scale, strongest first.

    Deliberately not weighted by loudness or low end any further: the ranking already
    sorted on exactly those, and adding a second bonus on top collapsed almost everything
    into level 5 (every clip in a pack of exhaust pops has a lot of low end - that is what
    it is). Even buckets keep a gentle lift from firing the biggest bang in the set.
    """
    if total <= 1:
        return 5
    # rank 0 (best) -> 5, last -> 1
    pos = rank / (total - 1)
    return int(max(1, min(5, round(5 - pos * 4))))


def effect_id(prefix, stem):
    """`--prefix ex` on a file called EX_POP_30 should give ex_pop_30, not ex_ex_pop_30."""
    s = stem.lower().strip("_")
    p = prefix.lower().strip("_")
    if not p:
        return s
    if s == p or s.startswith(p + "_"):
        return s
    return f"{p}_{s}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder", help="folder of source clips")
    ap.add_argument("--count", type=int, default=10, help="how many to keep")
    ap.add_argument("--prefix", default="ex", help="id prefix for the imported effects")
    args = ap.parse_args()

    ff = ffmpeg_bin()
    src_dir = Path(args.folder)
    files = sorted(p for p in src_dir.iterdir()
                   if p.is_file() and p.suffix.lower() in AUDIO_EXT)
    if not files:
        sys.exit(f"no audio files in {src_dir}")

    print(f"measuring {len(files)} clips from {src_dir}")
    scored = []
    for p in files:
        m = measure(decode(p, ff))
        if m is None:
            print(f"  skip {p.name} (silent or undecodable)")
            continue
        scored.append((score(m), p, m))
    scored.sort(key=lambda t: -t[0])

    print(f"\ntop {args.count} by duration + low-end body + transient:")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    imported = []
    keep = scored[: args.count]
    for rank, (s, p, m) in enumerate(keep):
        eid = effect_id(args.prefix, p.stem)
        dst = OUT_DIR / f"{eid}.wav"
        ms = to_wav(p, dst, ff)
        if ms is None:
            print(f"  convert failed: {p.name}")
            continue
        lv = level_for(rank, len(keep))
        print(f"  {p.name:<16} score {s:5.2f}  {m['dur']*1000:6.0f} ms  "
              f"body {m['body']:.2f}  peak {m['peak']:.2f}  -> L{lv}  {dst.name}")
        imported.append({
            "id": eid,
            "name": p.stem.replace("_", " ").title(),
            "level": lv,
            "note": f"Recorded sample ({m['dur']*1000:.0f} ms, low-end {m['body']:.0%}).",
            "file": dst.name,
            "durationMs": round(ms),
            "source": "imported",
        })

    # merge into the manifest, keeping the synthesised entries
    mf = OUT_DIR / "sounds.json"
    try:
        data = json.loads(mf.read_text(encoding="utf-8"))
    except Exception:
        data = {"sampleRate": SR, "channels": 2, "effects": []}
    kept = [e for e in data.get("effects", []) if e.get("source") != "imported"]
    data["effects"] = kept + imported
    data["sampleRate"] = SR
    data["channels"] = 2
    mf.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(f"\n{len(kept)} synthesised + {len(imported)} imported = "
          f"{len(data['effects'])} effects in {mf.name}")


if __name__ == "__main__":
    main()
