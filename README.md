# EDZCO-apps

Custom apps and tools for BMW iDrive 7 / 8 (MGU) head units, installed through the community MGU Store.

Everything here is unofficial, not endorsed by BMW. Use at your own risk — you are responsible for your car and for how you use these apps. Don't let them distract you while driving.

## Apps

- **Pop-Bang** (`edzco_popbang`): hold the button, the exhaust valve opens; release, it closes. A watchdog closes it after 3 s regardless. Refuses to open unless the car is parked and the engine is on. Needs the `edzco-exhaust` tool (installed automatically with the app).
- **M Scenes** (`edzco_mscene`): choreographed interior ambient light shows. Welcome, M-Mode, Celebration, Sunset, Night Drive — each one orchestrates every lit zone of the cabin (dash, doors, footwell, console, seats, roof) through the BDC. Freeform mode: pick any colour and brightness per zone with a touch wheel. Needs the `edzco-light` tool.

## Install

1. On the car, open **MGU Store → Settings → Add source**.
2. Enter `EDZCO/EDZCO-apps` and save.
3. The apps appear in the list. Tap **Install** on the one you want; its tool is pulled in automatically.
4. Restart the head unit once (Store → Settings → Restart head unit). The app tile appears on the home screen.

## Safety and limits

- Pop-Bang needs the car **parked** and the **engine on** by default. Both checks live in `tools/edzco-exhaust/config.json → safety`; raising them is on you.
- Pop-Bang refuses to write unless a matching ECU row with a filled-in DID and payload is in `config.json`. The row shipped out of the box is a placeholder; you fill it from your own research against your own CAFD. See [docs/POPBANG_RESEARCH.md](docs/POPBANG_RESEARCH.md).
- M Scenes drives the BDC's workshop jobs `INNENLICHT_FI_LIN_1/2_LAYERING`. Every write lasts at most 254 s and the car takes over again by itself. Nothing is persisted on the car's own coding.
- Neither app flashes anything. Nothing here replaces or disables BMW's own control of a safety system.

## Dependencies

- [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) — the kit and the GPU renderer (cluster-render) other MGU apps draw through.
- [robertnisipeanu/mgu-store](https://github.com/robertnisipeanu/mgu-store) — the Store runtime and the tools' service manager (`mgu-deploy`).

Both are installed from the Store on the car; this repo only adds its own apps on top.

## License

MIT, see [LICENSE](LICENSE).

## What's still to do

- Pop-Bang DME payload rows for B48 / B58 / S55 / S58 / N55.
- M Scenes: on-car test of every scene (Welcome / M-Mode / Celebration / Sunset / Night Drive), on real Comfort Access and door signals.
- Both apps: per-VIN setting migration between sessions (nice to have, not blocking).
