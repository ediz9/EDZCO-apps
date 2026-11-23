# edzco-lights

The service behind [Lights](../../apps/edzco_lights/). Flashes the car's exterior lamps in patterns through BMW's own test functions.

## UDS it writes

| Target | Service | DID | Shape | Purpose |
|---|---|---|---|---|
| BDC 0x40 | 0x2F | 0xE3B5 | `LAYOUT + <output> + <on/off>` | `LICHT_AUSGANG_DIGITAL_STEUERN` — one lamp output on / off |
| BDC 0x40 | 0x2E | 0xD542 | `<fn hi> <fn lo> <time×10ms>` | `LEUCHTEN_FUNKTION` — lamp function for a time |
| FLM 0x43/0x44 | 0x2E | 0xD6DC | `00 <fn> <secs>` | `FLM_FUNKTION_LICHTVERTEILUNG` — headlight module function |
| BDC 0x40 | 0x22 | 0xE3B9 | — | `LICHT_AUSGANG_DIGITAL` read-back |

Session: `10 03` extended once, `3E 00` keep-alive every 2 s, `10 01` default back at stop. Every write that lights a lamp is time-limited at the ECU so if the tool dies mid-pattern every lamp is back on the car's own in a few seconds — no stuck lights.

## Why three write paths

The SGBD for the body controller names `LICHT_AUSGANG_DIGITAL_STEUERN` arguments but **not the layout**, and the G05 refused the two obvious guesses. The tool starts with a **lamp check** that tries five candidate layouts on the rear-left turn signal and keeps the first one the BDC takes. If none is taken (older firmware, LED cars), it falls back:

1. **BDC output** (0xE3B5) with the learnt layout — fastest, per-lamp.
2. **FLM function** (0xD6DC) on the lamp's module — for front lamps the BDC takes the output but doesn't actually light the LED (common on G05).
3. **BDC function** (0xD542) — both sides at once except turn signals (which have separate function ids per side).

The runner picks the first path a lamp answered during the check.

## Patterns

Each pattern is a timeline in [patterns.js](patterns.js):

- **Welcome** — DRL + fog + sequential turn chase. 6 s, one-shot. `parkedOnly`.
- **Goodbye** — DRL double pulse. 3 s, one-shot. `parkedOnly`.
- **Comfort Flash** — 5 both-sides turn signal flashes. 2.5 s. **Only non-parkedOnly pattern** (engine must still be on; the car refuses indicators above a few km/h anyway).
- **Sequential Chase** — turn signal sweep front-to-back both sides. Loops, 30 s cap. `parkedOnly`.
- **Hazard Dance** — fogs + chase + DRL pulse. 10 s one-shot. `parkedOnly`.
- **Lamp Check** — 50 s diagnostic cycle, one lamp at a time for 1.2 s. Learns the route per lamp.

## Safety

- `parkedOnly: true` on every pattern except Comfort Flash. The app forwards `parked: true` only when CDS says the gear is in P.
- Dangerous lamps (**high beams**) are marked `dangerous: true` in [lamps.js](lamps.js) and the pattern runner **never touches them** unless the app sends `danger: true` and the operator confirmed explicitly.
- Brake / tail / plate lights are in the `KEPT` list — the tool never drives them. The brake pedal works as always.
- The ECU self-times every write (2 s default here). The loop re-sends on each frame so lamps stay lit for the pattern; the moment the pattern ends or the tool dies, the lamps go back to the car in the ECU's own timeout.

## Control socket

`/run/edzco-lights/ctl.sock` — JSON lines:

```
-> { "op": "ping" }
-> { "op": "get" }
-> { "op": "play", "id": "welcome", "parked": true, "engineOn": true }
-> { "op": "lamp", "id": "fog_rear", "on": true }
-> { "op": "lamp_check" }
-> { "op": "stop" }

<- { "reply": "pong" }
<- { "state": { "connected": bool, "sessionActive": bool, "activePattern": id|null,
                 "layouts": {"bdcOut": "A"|"B"|...|null},
                 "capable": {"drl_l": {"ok": bool, "path": "bdc_out:A"}, ...},
                 "lastError": null|string } }
```

## Install (dev loop)

```sh
rsync -av tools/edzco-lights/ root@<car>:/opt/edzco-lights/
scp tools/edzco-lights/edzco-lights.service root@<car>:/etc/systemd/system/
ssh root@<car> 'systemctl daemon-reload && systemctl enable --now edzco-lights.service'
```

## Attribution

Lamp catalogue, UDS layouts, session plan, and the "learn the BDC layout from the rear-left turn signal" trick are from [eroobeeroo/idrive7-apps/light_show](https://github.com/eroobeeroo/idrive7-apps/tree/main/apps/light_show) (MIT, Copyright 2026 eroobeeroo, car-tested on a 2021 X5 xDrive45e G05).

The daemon, control socket, pattern timeline runner and safety wrapper are this tool's.
