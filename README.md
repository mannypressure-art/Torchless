# Torchless

Rig control for the Dr. Dabber Switch 2 over Bluetooth. Not affiliated with Dr. Dabber.

- `web/`: the web version (TypeScript). Runs in Chrome and, on iPhone, in Bluefy. See `web/README.md`.
- `bench-spec/`: the 30 rig scenarios every version must pass before release, with the simulated rig.
- `docs/`: the built web app (and the rig test page under `docs/test/`), served by GitHub Pages.

Status: phase 4b. The web app has the Gauge screens (Link it, Home, Jars, Lights, Rig) and the jar library from the iPhone app: current jar, rating after each dab, dab history by temp, flavors, price log and spend, all kept on the device with a backup file. Sign-in is not in the web app yet. The page has a manifest asking for full screen and a Torchless home screen icon; on iPhone it opens in Bluefy.

