# EDZCO-apps

Apps for BMW iDrive 7 (MGU), installed through the MGU Store.

- **Pop-Bang** — plays an overrun effect through the car's speakers when you lift off after a rev.
- **Lights** — flashes the exterior lamps in patterns through the body controller.

## Install

MGU Store → Settings → Add source → `EDZCO/EDZCO-apps`

The head unit builds the apps itself with [kit/](kit/) (the MGU App Kit, MIT) and its own
`oap-sdk`; each app brings its tool (`edzco-sound`, `edzco-lights`) along.

MIT.
