# edzco-exhaust

The service behind [Pop-Bang](../../apps/edzco_popbang/). Opens and closes the DME's exhaust valve over UDS (service 2E / 2F) through the head unit's diagnostic gateway (TASU, SOME/IP 0xF8A6 instance 128) via `hmictl`.

## What it exposes

A JSON-lines control socket at `/run/edzco-exhaust/ctl.sock`. One op per line:

```
-> { "op": "ping" }                                      liveness
-> { "op": "get" }                                       state
-> { "op": "popbang", "hold": true|false,
                       "parked": true|false,
                       "engineOn": true|false }

<- { "reply": "pong" }
<- { "state": { "connected": bool, "engineRunning": bool, "parked": bool,
                "flap": "open"|"closed"|"unknown", "lastError": null|string } }
<- { "error": "..." }
```

Read-only op (`get`) never writes UDS; `popbang` with `hold: true` writes, `hold: false` reads the closed payload back to the ECU.

## Safety

Every write is gated by `config.json → safety`:

- `require_parked` (default true): refused unless the message includes `parked: true`
- `require_engine_on` (default true): refused unless `engineOn: true`
- `hold_max_ms` (default 3000): the service itself closes the valve after this many ms held open, even if the app never sends `hold: false`
- `cooldown_ms` (default 1500): the minimum gap between two open requests

Lowering any of these is on the operator.

## Filling in your DME row

The tool ships with a placeholder row only. The real DME DID and payload are engine-family specific and are **not** committed here — you fill in `config.json` from your own CAFD research. See [../../docs/POPBANG_RESEARCH.md](../../docs/POPBANG_RESEARCH.md).

```json
{
  "ecus": {
    "DME_B58": {
      "label": "B58 / B48 straight-six / four",
      "target_hex": "0x12",
      "popbang_open":  { "sid_hex": "0x2F", "did_hex": "0xXXXX", "payload_hex": "03" },
      "popbang_close": { "sid_hex": "0x2F", "did_hex": "0xXXXX", "payload_hex": "00" }
    }
  }
}
```

Without a filled-in row for the connected DME, the service refuses to write and `state.lastError` says which row is missing. The app surfaces that error on screen.

## Install from source (dev loop on the car)

With SSH + the per-VIN key:

```sh
rsync -av tools/edzco-exhaust/ root@<car>:/opt/edzco-exhaust/
scp tools/edzco-exhaust/edzco-exhaust.service root@<car>:/etc/systemd/system/
ssh root@<car> 'systemctl daemon-reload && systemctl enable --now edzco-exhaust.service'
ssh root@<car> 'systemctl status edzco-exhaust.service --no-pager'
```

Through the Store the service is installed and started by mgu-deploy when the Pop-Bang app is installed; nothing of the above is needed.

## Logs

- Service log: `journalctl -u edzco-exhaust.service -f`
- Tool's own log file: `/var/log/edzco-exhaust/exhaust.log` (rotated at 256 KB)

## Attribution

The UDS layer (`uds.js`) and the `hmictl` line shape are adapted from IterioDev's `iteriodev-comfort` (MIT, Copyright 2026 cauliflowermossgrape). The safety wrapper and the control socket are original.
