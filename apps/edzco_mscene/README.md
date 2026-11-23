# M Scenes

Choreographed interior ambient light scenes. Each scene drives every lit zone the car has (dash, doors, footwell, console, seats, roof) through the BDC.

Version 0.1.0 · iDrive 7 and 8 · package `edzco_mscene` · needs the `edzco-light` tool.

> [!NOTE]
> **Not car-tested yet.** The scene timelines in [scenes.js](scenes.js) are a first cut designed around a full ambient lighting option (M Sport interior lighting). On a car without every zone the tool skips the missing ones with no fuss; the scene just reads thinner.

## Scenes

- **Welcome** · 5 s one-shot. Lights the cabin corner to corner (footwell → seats → doors → console → dash → roof), settling on a warm amber. Auto-fires on door open when the setting is on.
- **M Mode** · a settled M-tricolour pattern: blue on the driver side, dark blue in the centre, red on the passenger side. No animation — a signature steady state.
- **Celebration** · 8-second rainbow wave looped for 30 s cap. Each zone is 60° phase-shifted so the whole cabin reads as one moving spectrum. Use for parties / handover / that-moment-a-friend-sees-it-first.
- **Sunset** · warm amber at the floor shading up to cool magenta on the roof. 3 s fade, then steady.
- **Night Drive** · a dim, warm amber steady state (nothing above 25 %). Pairs well with highway night runs.

### Freeform

A colour wheel + per-zone brightness sliders. What you pick stays until you pick again or stop.

### Settings

- **Auto-welcome** (default on): Welcome plays by itself when any door opens.
- **Respect ignition off** (default off): every scene stops when the ignition goes off.
- **Brightness cap** (default 100): every scene's brightness is multiplied by this before being sent.
- **Demo** (not yet): plays each scene for a few seconds in the car's showroom, parked only.

## How it works

The app runs the active scene's timeline in-process at 10 fps and sends the composite `{ op: "set", zones: { dash: {rgb, brightness}, ... } }` every frame to the Light tool. The tool packs each frame into the BDC's `INNENLICHT_FI_LIN_1_LAYERING` and `_FI_LIN_2_LAYERING` workshop jobs (UDS 2E DA5E / E3D1), one layering write per LIN bus per renewal. Each write lasts 254 s; the tool renews every 120 s while the scene is active, and stops renewing when the user picks Stop or `respectIgnition` says to. No coding is changed.

## UDS protocol reference

See the [edzco-light tool's README](../../tools/edzco-light/README.md). The layering job and the location map are the ones IterioDev's [iteriodev-comfort](https://github.com/IterioDev/car-apps/blob/main/tools/iteriodev-comfort/ambient.js) uses.

## Attribution

The BDC ambient job sequence and zone map follow IterioDev's `iteriodev-comfort` (MIT, Copyright 2026 cauliflowermossgrape). Scene design and the timeline runner are original.
