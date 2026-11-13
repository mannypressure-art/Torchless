# Presh web

The web version of Presh, for iPhone (in Bluefy) and Chrome. Phase 2 of the public release plan
(https://claude.ai/artifact/RaFjDqfR6UepAWDn5u4e84): the rig logic only, no screens yet.

## What is here

- `src/rig/frames.ts`, `ble-manager.ts`, `rig-controller.ts`: line-for-line ports of the iPhone app's
  `FrameDecoder.swift`, `BLEManager.swift` and `RigController.swift` (RigController md5 5397d398..., the build
  on the phone on 2026-11-11). Same heat logic, write queue, safety cut and away rule.
- `src/rig/central.ts`: the CoreBluetooth-shaped interface the logic talks to. The bench plugs in a simulated
  rig; phase 3 adds a Web Bluetooth version.
- `src/rig/clock.ts`, `storage.ts`: time and saved settings, swappable so the bench runs on a virtual clock.
- `bench/sim.ts`: the simulated rig (SIMRIG.md in `presh-shared/bench-spec`).
- `bench/run.ts`: reads `presh-shared/bench-spec/scenarios.json` directly and runs every scenario, so the web
  bench and the spec cannot drift apart.

## Run the bench

Needs Node 20 or later. Build in a local folder, not the network share:

```bash
cp -r presh-web /tmp/pw && cp -r presh-shared /tmp/presh-shared && cd /tmp/pw
npm install
npm run bench                                    # ends with "30 of 30 scenarios passed", under a second
node dist/bench/run.js linkLostGiveUp --quiet-cancel
node dist/bench/run.js basic -v                  # one scenario with the rig events and app log
python3 /tmp/presh-shared/bench-spec/check-parity.py <saved output>
```

`results-2026-11-11.txt` is the first full run. A bench pass is not a real-rig test.

## Keeping it in step with the iPhone app

Any change to the heat or Bluetooth logic goes into the Swift files and these files together, and both
benches must pass all 30 before either ships.

## Puffco Peak Pro (test build only)

Compatible with Puffco Peak Pro. Not affiliated with Puffco. Not tested on a real Peak yet.

- `src/rig/puffco/lorax.ts`: the Lorax protocol (UUIDs, packets, paths, login token, value parsing).
- `src/rig/puffco/peak-controller.ts`: link, login, 1 s polling, HEAT IT / CUT IT (checked, resent once) / boost,
  the four heat profiles, reconnect, and a full log (raw packets for the first 80 exchanges of each link, every
  state change, a heartbeat line). No SAFETY CUT for the Peak: button-started dabs are normal and the Peak ends
  its own cycle.
- `src/rig/puffco/web-lorax.ts`: Web Bluetooth transport, and the chooser routing (name first, then a service check).
- `src/rig/rig-view.ts`: the shared read-only shape the gauge, jar dab log and heat-up look read, for either rig.
- The normal build (`npm run app`) leaves the Peak off. `npm run peak` builds the test page to `public/peak/`
  (served at `/peak/`, same storage as the app).
- `npm run bench:peak`: 26 scenarios against a simulated Peak (`bench/peak-sim.ts`, our reading of public notes).
  `node test/peak-check.js public` is a headless page check with a fake Peak.
