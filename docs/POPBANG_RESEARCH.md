# Pop-Bang — what to research before the car

The Pop-Bang tool refuses to write unless you have filled in `tools/edzco-exhaust/config.json → ecus.<FAMILY>` with real values for your engine. This is the research you do once per engine family.

## What you need to find

Three fields per engine, in order of importance:

1. **ECU target address** — the DME's address byte on the gateway. On G-series cars this is almost always **0x12** (verify on E-Sys: `DME_...` SGBD → network connection).
2. **DID** (Data Identifier) — the 2-byte key the valve state lives behind. Different per engine family and sometimes per I-step. **This is the value that is not safely guessable.**
3. **Payload bytes** — what to write to open, and what to write to close.

## Where to look

In order of "most likely to work":

### 1. E-Sys / ISTA-P

- Open the DME's CAFD (your car's SGBD export).
- Search the function tree for **`ABGAS_KLAPPE`**, **`FGS_Abgasklappe`**, **`ABGAS_FLAP`**, **`EXHAUST_FLAP`**, **`AGK`**, or **`Abgasklappe_IOControl`**.
- The matching function block gives you the DID and the payload table.
- Note both the "open" and "close" variants; some families also have a "pulse" (open + close itself after a timer).

### 2. Community forks that ship exhaust-flap code

- **evangoyuk/mgu-store-apps** — advertises an exhaust flap control app in its README. Clone it, read its UDS payloads, and bring the DID and payload bytes across into `config.json`. (Confirm the engine family matches yours before using.)
- **The Pop-Bang mod thread on g20.bimmerpost.com** — known to list DIDs for B58, S58, S55. Cross-reference, do not just trust a single post.

### 3. Logging from your car

If you have an INPA / ISTA-D session with the DME:

- Trigger the valve via the car's own Sport mode (where it does open briefly on upshifts).
- Capture the UDS traffic (`inpa.log`, ISTA's trace mode, or a CAN tap).
- Look for an SID 2E write near that moment and copy the DID and payload.

### 4. Doing it without any of the above

Don't. Pop-Bang does not need the valve badly enough to guess at DIDs — the tool will refuse to write without a filled-in row, and the only way an **unknown** 2E write to the DME can misbehave is by hitting a different DID. Leave the row empty, or ask the forum.

## Once you have the values

```json
{
  "ecus": {
    "DME_B58": {
      "label": "B58 straight-six (G20 M340i, G30 540i, …)",
      "target_hex": "0x12",
      "popbang_open":  { "sid_hex": "0x2F", "did_hex": "0x?????", "payload_hex": "0300" },
      "popbang_close": { "sid_hex": "0x2F", "did_hex": "0x?????", "payload_hex": "0000" },
      "read_status":   { "sid_hex": "0x22", "did_hex": "0x?????" }
    }
  }
}
```

- **SID 2F (InputOutputControlByIdentifier)** is the safer option when the family supports it — the DME knows to stop IO control when the connection drops. Payload is usually `<control option (1 byte)> <values...>` where control option is `03` for "ShortTermAdjustment" and `00` for "ReturnControlToECU".
- **SID 2E (WriteDataByIdentifier)** is the fallback when the family only exposes the setting as a coding value. Then the tool itself has to send the "close" value — the DME holds the open state until something tells it to stop.
- Use **2F** whenever both are known to work.

## When the tool rejects what you wrote

- **`NRC 31` (requestOutOfRange)** — the DID is wrong for this family, or it is right but the I-step on this car has moved it. Check the SGBD version.
- **`NRC 22` (conditionsNotCorrect)** — the car thinks the preconditions aren't met (engine off, gear not in P, DME in a mode that disallows it). Match what Sport mode does — it's the same precondition set.
- **`NRC 33` (securityAccessDenied)** — the DID needs an unlocked session. Pop-Bang does **not** do SecurityAccess on its own; that is out of scope. If a family needs it, document it here as "not supported yet" and don't write.

The tool's own log (`/var/log/edzco-exhaust/exhaust.log`) prints the NRC on every rejection with the DID and the payload that caused it.
