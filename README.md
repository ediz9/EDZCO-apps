# EDZCO-apps

Apps for BMW iDrive 7 (MGU), installed through the MGU Store.

- **Pop-Bang** — plays an overrun effect through the car's speakers when you lift off after a rev.
- **Lights** — flashes the exterior lamps in patterns through the body controller.

## Install

MGU Store → Settings → Add source → `github.com/ediz9/EDZCO-apps/tree/main`

The head unit builds the apps itself with [kit/](kit/) (the MGU App Kit, MIT) and its own
`oap-sdk`. Pop-Bang brings its tool (`edzco-sound`) along; Lights needs none.

Lights' lamp control (`apps/edzco_lights/lamps.js`, `patterns.js`) is light_show's by eroobeeroo, under the
PolyForm Noncommercial License 1.0.0 (see that folder); the rest of the repository is MIT.

