# Lights

Flashes the car's exterior lamps in patterns through the body controller's own lamp test functions.

Version 0.2.0 · iDrive 7 · package `edzco_lights` · no tool needed.

## How it reaches the lamps

From the app itself, over the head unit's diagnostic transport (`InternalTasu`, [kit/diag.js](../../kit/runtime/diag.js)):
UDS to the body controller (BDC, 0x40) and the LED headlight modules (FLM, 0x43 / 0x44). This is how
[light_show](https://github.com/eroobeeroo/idrive7-apps/tree/main/apps/light_show) (car-tested on an X5 G05) and
idrive7-apps' `ambient_config` (car-tested on a G20's BDC_G05) reach the body controller.

0.1.0 did this in a root tool through `/usr/bin/hmictl`. The head unit has no such program (IterioDev ships its own
inside its tools), so every request timed out and the lamp check found nothing. The `edzco-lights` tool is gone; if
it is still installed, remove it in the Store.

## Lamp check (first, parked)

Finds the output request layout the body controller takes, whether its outputs time themselves, then lights each
lamp for 1.2 s through its headlight module, its own output, or its lamp function, and keeps what worked in
`data/lamp-check.json`. Patterns leave out lamps that did not work. About a minute. The screen shows each step, each
lamp's result, and the link's request / reply counts with the last refusal.

## Patterns

| | Kind | |
|---|---|---|
| Welcome | parked, once | daytime lights, fogs, front turn signals in turn, reversing lights. Also on a door opening (setting) |
| Goodbye | parked, once | daytime lights twice, then the rear lamps. Also on locking and leaving (setting) |
| Comfort Flash | moving ≤ 90 km/h, once | five four-way flashes |
| Sequential Chase | parked, 30 s | turn signals round the car |
| Hazard Dance | parked, once | 10 s of fogs, turn signals, rear fogs |
| Piyasa | moving ≤ 30 km/h, once, high beams | left pair, right pair, both pair |
| Wig-Wag | moving ≤ 30 km/h, 15 s, high beams | left / right high beam in turn |
| Rear Alert | moving ≤ 50 km/h, 20 s | rear fogs pulsing (never the reversing lights while moving) |

Tap a pattern to choose it, tap it again (or Calistir / durdur) to run or stop it. High-beam patterns need a second
press within 5 s.

## Safety

- Parked patterns refuse unless the selector is in P (or the car stands still without a selector signal) and stop as
  soon as the car moves. Moving patterns stop above their ceiling, or when road speed is unknown.
- Moving patterns use only lamps that are normally off while driving, and give each back to the car between
  flashes (light_show's `emergency` kind).
- The brake, tail and number plate lights are never switched (lamps.js `KEPT`).
- Stop gives every lamp back and ends the session. If the app dies, the body controller drops the session within
  seconds (no tester present) and every lamp is the car's own again. "Lambalari birak" tries every give-back form on
  every lamp.

## Licences

`lamps.js` and `patterns.js` are light_show's, vendored unchanged, under the
[PolyForm Noncommercial License 1.0.0](LICENSE.light_show) (Required Notice: Copyright (C) 2026 eroobeeroo). They are
not covered by this repository's MIT licence, and this app may only be used noncommercially. `main.js` and
`edzco_patterns.js` are this repository's (MIT).
