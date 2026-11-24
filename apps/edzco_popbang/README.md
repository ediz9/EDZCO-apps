# Pop-Bang

Plays an overrun effect through the car's speakers the moment you lift off after a rev — when a real exhaust crackles.

Version 0.2.0 · iDrive 7 and 8 · package `edzco_popbang` · needs the `edzco-sound` tool (installed with the app).

> [!IMPORTANT]
> **Nothing is written to the engine.** No valve is moved, no DME request is sent, no coding changes. Your exhaust does exactly what it always does; this adds a sound on top of it, through the head unit's audio, at the right instant.

## How it decides to fire

The one signal every car publishes is engine speed. That turns out to be enough, because the derivative of rpm measures the thing we actually care about more directly than a pedal position would: **the throttle shutting is rpm falling.**

```
ARMED     rpm climbs past armRpm            you revved it
FIRE      rpm then falls faster than        you lifted
          dropRpmPerSec
COOLDOWN  hold off for cooldownMs           one lift is one effect
```

Which effect plays scales with how hard the lift was — peak rpm and how fast it is dropping pick a level 1–5:

| Peak rpm | Level | Typical effect |
|---|---|---|
| under 3000 | 1 | `tick`, `pop` |
| 3000–4000 | 2 | `double`, `crackle_light` |
| 4000–5200 | 3 | `crackle_med`, `burble_fast` |
| 5200–6200 | 4 | `crackle_heavy`, `bang` |
| 6200+ | 5 | `bang_tail` |

A drop faster than 2600 rpm/s pushes it up one more level.

## Settings

| | Default | |
|---|---|---|
| `armRpm` | 3200 | How far you have to rev before a lift counts. Lower it to make it eager. |
| `dropRpmPerSec` | 1400 | How fast rpm must fall to read as a lift rather than a coast. |
| `cooldownMs` | 2500 | Minimum gap between two effects. |
| `effectSet` | `auto` | `auto` picks by level; or pin one effect id. |
| `parkedOnly` | off | The point is doing it while driving, so this is off. |

The defaults are deliberately lazy: a lift from 3000 rpm dropping at 900 rpm/s is an ordinary gear change, and nobody wants an effect on every shift.

## The sound path

The effect goes out through the head unit's own audio, as a routed source:

- source **287** (SmartX `CarLifeMedia` — China-only, so free on our cars) → sink **1024** (main speaker)
- PCM `plug:smartx:CarLifeMedia_CF_48_STEREO`

The app brings that route up around each effect and drops it after; the `edzco-sound` service writes the PCM. See the [tool's README](../../tools/edzco-sound/README.md) for why that split exists and for the probe to run on a new car.

## The effects

Ten, synthesised rather than recorded — see [docs/SOUNDS.md](../../docs/SOUNDS.md) for the licensing survey, why a real overrun is not one bang, and how to drop your own recordings in.

## What is not tested yet

- The AudioManager route on **this** car. It is moonride's, car-tested on an X5 G05; a 3 Series may name the PCM differently. Run the tool's `probe` first.
- Whether the car ducks or stops the media source while the effect plays, and how that feels mid-song.
- The detector thresholds against real driving. The numbers above are reasoned, not measured — expect to tune `armRpm` and `dropRpmPerSec` after the first drive.
