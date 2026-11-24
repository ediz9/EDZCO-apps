# edzco-sound

The service behind [Pop-Bang](../../apps/edzco_popbang/). Plays short effects through the car's speakers.

## How sound reaches the speakers on an MGU

Not by opening a hardware PCM. The head unit runs a GENIVI AudioManager, and anything that wants the speakers has to be a **source** it has routed to a **sink**:

| | |
|---|---|
| Source | **287** — SmartX `CarLifeMedia`. CarLife is China-only, so the slot is free on our cars. |
| Sink | **1024** — the main speaker. |
| PCM | `plug:smartx:CarLifeMedia_CF_48_STEREO` — 48 kHz stereo; the `plug:` prefix converts anything else. |

The catch, and the reason this is not obvious: source 287 is `A_UNAVAILABLE` without a CarLife phone, and a `connect` to it then sits in `CS_CONNECTING` for ever. It has to be marked available on the **routing** interface first:

```
hookSourceAvailablityStatusChange(287, A_AVAILABLE)   org.genivi.am.routinginterface.RoutingControlObserver
connect(sourceID: 287, sinkID: 1024)                  org.genivi.am.commandinterface.CommandControl
  ... write PCM to the device ...
disconnect(mainConnectionID)
hookSourceAvailablityStatusChange(287, A_UNAVAILABLE)
```

The routing half lives in the **app**, because AudioManager is reached over SOME/IP and the app is the half with those proxies. This service owns the other half: writing the PCM.

### Why a root service

[Zeiger](https://github.com/vucko-adv/apps) shipped a "Sound Test" app to answer exactly this question and then removed it: *"on the car the app found no way to play sound (the app has no access to the audio devices, and the head unit has no player or PulseAudio it may use)."* That is true **of an OAP app**. A systemd service does have access, which is why the split exists.

The route itself is [moonride](https://github.com/JustAnotherPU/moonride)'s, car-tested on an X5 G05.

### Writing the PCM: pcm.py, not aplay

0.1.0 played through `aplay`. On the G20 (2026-11-24) the route came up (CarPlay paused, the
media icon showed) but nothing was heard: the PCM side never delivered. The unit is not known
to carry alsa-utils, and moonride does not use them either: its `audio.cpp` dlopens
`libasound.so.2` and calls `snd_pcm_open` (nonblocking), `snd_pcm_set_params` (S16_LE,
interleaved, 2 ch, 48 kHz, 64 ms) and `snd_pcm_writei`.

`pcm.py` makes the same calls through `ctypes`, with the Python the Store installs on every unit
(`/var/opt/mgu-python/current/bin/python3`, hence `"requires": {"mgu-python": ...}`). It stays
running; `sound.js` sends it one JSON line per sound. It upmixes mono files, pads the end to whole
1024-frame periods so the tail is not left in the plugin, and reports `stall` when the device takes
nothing for 2.5 s: that is a source the AudioManager has not connected. `aplay` is used only when
that Python is missing.

## First run on a new car

```sh
echo '{"op":"probe"}' | nc -U /run/edzco-sound/ctl.sock -q 2
```

Reports whether `libasound.so.2` loads and the device opens and takes the parameters (`python`),
whether `aplay` exists, and `/proc/asound/cards`. The service also writes this to the journal at
every start. If `CarLifeMedia_CF_48_STEREO` is named differently on your firmware, override it in
the unit:

```
Environment=EDZCO_PCM=plug:smartx:<name>
```

`EDZCO_GAIN` (default 1.0) scales the samples.

## Control socket

`/run/edzco-sound/ctl.sock` — JSON lines:

```
-> { "op": "ping" }
-> { "op": "list" }                       the effects on disk
-> { "op": "play", "id": "crackle_med" }
-> { "op": "stop" }
-> { "op": "probe" }
-> { "op": "status" }                     the backend and the last play's outcome

<- { "reply": "pong" }
<- { "effects": [ { "id", "name", "level", "durationMs" } ] }
<- { "played": "crackle_med", "ms": 994, "backend": "pcm.py", "waitedMs": 0 }
<- { "probe": { "backend", "device", "python": { "libasound", "open", "params" }, "aplay", "cards", "last" } }
<- { "error": "...", "stage": "libasound|open|params|stall|write|file" }
```

A request's `seq` comes back on its reply.

One sound at a time — a second pop stepping on the first reads as a glitch, not as two pops.

## The effects

Ten, in `sounds/`, with `sounds.json` as the manifest. `level` 1–5 is how hard a lift they suit; the app picks by level unless you pin one.

| Level | Effects |
|---|---|
| 1 | `tick`, `pop` |
| 2 | `double`, `crackle_light`, `burble_slow` |
| 3 | `crackle_med`, `burble_fast` |
| 4 | `crackle_heavy`, `bang` |
| 5 | `bang_tail` |

They are synthesised, not recorded — see [docs/SOUNDS.md](../../docs/SOUNDS.md) for why, and for how to drop your own recordings in instead. Rebuild them with `python docs/make_sounds.py`.

## Logs

- `journalctl -u edzco-sound.service -f`
- `/var/opt/edzco-sound/data/sound.log` (rotated at 256 KB)
