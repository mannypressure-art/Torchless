# Presh shared bench spec

The one list of rig scenarios that every Presh version must pass before a release: the native iPhone app
(Swift), the web app for iPhone (TypeScript, Web Bluetooth), and the Android app (Kotlin). Phase 1 of the
public release plan (https://claude.ai/artifact/RaFjDqfR6UepAWDn5u4e84).

- `scenarios.json`: the 30 scenarios, with what each one does, when, and what must be true. Titles are the
  contract: every port prints `PASS <title>` with the title exactly as written here.
- `VOCAB.md`: the actions and observables the rules use, and the app log strings that are part of the contract.
- `SIMRIG.md`: the simulated rig and link every port rebuilds, in plain words.
- `check-parity.py`: `python3 check-parity.py <bench output>` says whether a port passed all 30.

Release rule: a heat or Bluetooth change ships on any platform only when all three ports pass all 30, plus
`linkLostGiveUp` a second time with `world.pendingCancelReportsDisconnect` false.

Changing the spec: add a scenario to the Swift bench (`switch app/sim-bench/harness/main.swift`) first,
then here, then to the other ports. The Swift bench is the reference while the iPhone app is the one on
the real rig.

What this is not: a bench pass is not a real-rig test. The simulated rig only behaves the way the
protocol notes say the real one does.
