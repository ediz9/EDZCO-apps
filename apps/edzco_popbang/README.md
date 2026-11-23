# Pop-Bang

Hold the button on the central display, the exhaust valve opens. Release, it closes. Works only when the car is parked and the engine is on. A watchdog closes the valve after 3 s of held-open regardless.

Version 0.1.0 · iDrive 7 and 8 · package `edzco_popbang` · needs the `edzco-exhaust` tool (installed with the app).

> [!WARNING]
> **Not car-tested yet.** The DME DID and payload row that tell the tool what to write live in [../../tools/edzco-exhaust/config.json](../../tools/edzco-exhaust/config.json). The row shipped is a placeholder. You fill it from your own research against your own car's CAFD — the tool refuses to write anything without a filled-in row. See [docs/POPBANG_RESEARCH.md](../../docs/POPBANG_RESEARCH.md).

## How it works

- The UI is one page: a big HOLD button in the middle, three state dots at the top (engine running, parked, tool connected) and a short log strip at the bottom.
- The app talks to the `edzco-exhaust` tool over `/run/edzco-exhaust/ctl.sock` in JSON lines. It does **not** do UDS itself.
- Every hold sends `{ op: "popbang", hold: true, parked, engineOn }` the instant the touch starts; release sends the same with `hold: false`. The tool handles the UDS.
- If the user lets go, the app leaves the page, the socket drops, or 3 s go by — the tool closes the flap. Three layers, any one of them is enough.

## Safety

- The app refuses to start a hold unless CDS reports parked **and** engine on.
- The tool refuses to write unless the app includes both flags true in the message, and `tools/edzco-exhaust/config.json → safety.require_parked` and `.require_engine_on` are on (they are on by default).
- The tool's watchdog closes the valve after `safety.hold_max_ms` regardless (default 3000 ms).

Nothing in Pop-Bang changes car coding or writes anything that survives a shutdown.

## What the DME row looks like

Edit `tools/edzco-exhaust/config.json`:

```json
{
  "ecus": {
    "DME_B58": {
      "target_hex": "0x12",
      "popbang_open":  { "sid_hex": "0x2F", "did_hex": "0xXXXX", "payload_hex": "03" },
      "popbang_close": { "sid_hex": "0x2F", "did_hex": "0xXXXX", "payload_hex": "00" }
    }
  }
}
```

The DME target on G-series cars is 0x12 (verify with your own SGBD). The DID and the payload after it are engine-family specific. See [POPBANG_RESEARCH.md](../../docs/POPBANG_RESEARCH.md) for what to look for (search strings, E-Sys function blocks, candidates known in the community).

## Settings

None yet. The next version adds:
- preferred engine family (so the tool picks the right row without reading `vehicle.statusVehiclePartType` every tick)
- "quick blip" mode: open + close itself after 300 ms, for a single pop without holding
