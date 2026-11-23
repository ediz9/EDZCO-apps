# edzco-light

The service behind [M Scenes](../../apps/edzco_mscene/). Drives the BDC's interior ambient layering jobs so the app can paint any colour on any zone the car has.

## UDS it writes

- Service: **0x2E** (WriteDataByIdentifier) at the BDC (**target 0x40**)
- LIN 1 DID: **0xDA5E** — payload `<NAD> <on 1> <brightness 0-100> <R> <G> <B> <secs 0-254>`
- LIN 2 DID: **0xE3D1** — same payload shape
- OFF: `<NAD> 00 00 00 00 00 00` — the car's own colour returns at once

Every write lasts up to 254 s; the tool renews every 120 s while a scene is active. Nothing on the car's own coding is changed. This is the same mechanism the BDC uses for its own layered ambient (BDC_G05 `INNENLICHT_FI_LIN_1_LAYERING` and `_LIN_2_LAYERING`).

## Control socket

`/run/edzco-light/ctl.sock` — JSON lines, one op per line:

```
-> { "op": "ping" }
-> { "op": "get" }
-> { "op": "set", "zones": { "dash": {"rgb": "#RRGGBB", "brightness": 0-100}, ... } }
-> { "op": "stop" }

<- { "reply": "pong" }
<- { "state": { "connected": bool, "lastWriteMs": number,
                 "probedZones": {"dash":{"lin1":n,"lin2":n},...},
                 "zones": {...} } }
<- { "error": "..." }
```

`set` is **idempotent per frame** — the tool resends the last frame every 120 s on its own. `stop` sends the OFF payload for every NAD the tool has driven in this session.

## Zones

The six zones M Scenes addresses are a reduction of BDC_G05's full location map:

| Zone | NAD (LIN 1) | NAD (LIN 2) |
|---|---|---|
| dash | 0x13-0x18, 0x4F-0x50 | — |
| doors | 0x05-0x12, 0x21-0x2A, 0x3F-0x46, 0x4D-0x4E, 0x51-0x5E, 0x62-0x65 | — |
| footwell | 0x01-0x04 | 0x23-0x24 |
| console | 0x1D-0x20, 0x2B-0x32, 0x47-0x4C, 0x5F-0x61 | — |
| seats | 0x19-0x1C, 0x33-0x34 | 0x71-0x74 |
| roof | 0x35-0x3E | — |

A NAD the car doesn't have is marked bad after a failed probe (NRC 31 requestOutOfRange) and skipped next time.

## Safety

- The tool never writes while the car is moving — the app is required to pause scenes once the gear leaves P; the tool trusts the app on this because the ambient job itself is harmless, but a bright flash while driving is distracting. Scene timelines cap brightness at 70 %.
- Every write is time-limited to 254 s on the car side; the tool's own renewal has a 120 s cadence. If the tool dies or disconnects, the car takes over inside 254 s.
- `stop` sweeps every known-good NAD with the OFF payload before the tool goes idle.

## Install from source (dev loop on the car)

```sh
rsync -av tools/edzco-light/ root@<car>:/opt/edzco-light/
scp tools/edzco-light/edzco-light.service root@<car>:/etc/systemd/system/
ssh root@<car> 'systemctl daemon-reload && systemctl enable --now edzco-light.service'
ssh root@<car> 'systemctl status edzco-light.service --no-pager'
```

Through the Store the service is installed and started by mgu-deploy when M Scenes is installed.

## Logs

- `journalctl -u edzco-light.service -f`
- `/var/log/edzco-light/light.log` (rotated at 256 KB)

## Attribution

The BDC ambient job sequence + zone map + 254 s layering trick are from IterioDev's [iteriodev-comfort](https://github.com/IterioDev/car-apps/blob/main/tools/iteriodev-comfort/ambient.js) (MIT, Copyright 2026 cauliflowermossgrape, car-tested on an M4 2026-11-07).

The control socket, probe cache, and the scene-timeline renewal driver are original.
