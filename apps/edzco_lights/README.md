# Lights

Flashes the car's exterior lamps in patterns through the body controller's own test functions. Covers Welcome, Goodbye, Comfort Flash, Sequential Chase and Hazard Dance, plus a Freeform tab with every lamp as a single toggle.

Version 0.1.0 · iDrive 7 and 8 · package `edzco_lights` · needs the `edzco-lights` tool (installed with the app).

> [!NOTE]
> **Not car-tested yet.** The lamp catalogue, UDS layouts and routes are those [eroobeeroo/idrive7-apps/light_show](https://github.com/eroobeeroo/idrive7-apps/tree/main/apps/light_show) uses and were car-tested there on a G05 X5 xDrive45e. On your car run **Lamp Check** first (Freeform tab, top button) — it probes each lamp and lights the ones that answered in the UI.

## Patterns

- **Welcome** (5 s, parked-only, auto-fires on door open) — DRL + fog + sequential turn chase.
- **Goodbye** (3 s, parked-only, auto-fires on central-lock) — DRL double pulse to acknowledge the lock.
- **Comfort Flash** (2.5 s) — five both-side turn signal flashes. The only pattern that runs while the car can move; the car itself refuses indicators above a few km/h.
- **Sequential Chase** (loop, 30 s cap, parked-only) — turn signal sweep front-to-back both sides.
- **Hazard Dance** (10 s, parked-only) — fogs + chase + DRL pulse. Harmless but visible.

### Freeform

Every lamp Lamp Check found a route for is a toggle. Parked, engine off, no interaction needed from CDS beyond "is it parked".

### Lamp Check

The first run on a new car. Walks every lamp for 1.2 s and records which path the body controller took (direct output, headlight module function, or BDC function). Takes ~50 s. The result is stored in the tool and remembered across restarts.

## Safety

- The app refuses to start a pattern unless CDS says the gear is in P (`parkedOnly: true` patterns).
- Dangerous lamps (**high beams**) are off by default and skipped by every pattern. Freeform shows them greyed out unless you explicitly confirm. The UI never arms them on public roads.
- Brake / tail / plate / number plate lights are in the `KEPT` list — the tool never drives them. The brake pedal works as always.
- Every UDS write to a lamp asks for ≤2 seconds of lit; the loop refreshes each frame while the pattern runs. Stop the pattern or kill the tool and every lamp returns to the car within the ECU's own timeout.

## Attribution

Lamp catalogue, UDS layouts, session plan (10 03 extended + 3E keepalive + 10 01 close), "learn-layout-from-rear-left-turn-signal" probe, and the three fall-back routes (BDC output → FLM function → BDC function) come from [eroobeeroo/idrive7-apps/light_show](https://github.com/eroobeeroo/idrive7-apps/tree/main/apps/light_show) (MIT, Copyright 2026 eroobeeroo).

The pattern timeline runner, the UI tabs, the auto-welcome / auto-goodbye hooks and the state saving are this app's own.
