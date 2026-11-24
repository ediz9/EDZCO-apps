# EDZCO-apps

Apps for BMW iDrive 7 / 8 (MGU), installed through the MGU Store.

- **Pop-Bang** — plays an overrun effect through the car's speakers when you lift off after a rev.
- **Lights** — flashes the exterior lamps in patterns through the body controller.

## Install

MGU Store → Settings → Add source → `EDZCO/EDZCO-apps`

## Note

The two tools (`edzco-sound`, `edzco-lights`) install and run as they are. The apps need BMW's
`oap-sdk`, extracted from your own head unit, before the Store can build them — see
[kit/build.js](kit/build.js).

MIT.
