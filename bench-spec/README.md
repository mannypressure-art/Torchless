# Presh shared bench spec

The one list of rig scenarios that every Presh version must pass before a release: the native iPhone app
(Swift), the web app for iPhone (TypeScript, Web Bluetooth), and the Android app (Kotlin). Phase 1 of the
public release plan (https://claude.ai/artifact/RaFjDqfR6UepAWDn5u4e84).

- `scenarios.json`: the 42 scenarios (30 until 2026-11-12; dialOnClimbingPreset, dialDuringHeatUp and extraTimeNotCarried added with RigController a51d4a83; dialAfterLinkDrop and dialOwedAfterRelaunch added with d1c73db8; on 2026-11-13 dialActivePreset changed to the real rig's refusal, and dialActivePresetIfRigFollows plus six customCurve scenarios added with 9c54e613), with what each one does, when, and what must be true. Titles are the
  contract: every port prints `PASS <title>` with the title exactly as written here.
- `VOCAB.md`: the actions and observables the rules use, and the app log strings that are part of the contract.
- `SIMRIG.md`: the simulated rig and link every port rebuilds, in plain words.
- `check-parity.py`: `python3 check-parity.py <bench output>` says whether a port passed all 42.

Release rule: a heat or Bluetooth change ships on any platform only when all three ports pass all 42, plus
`linkLostGiveUp` a second time with `world.pendingCancelReportsDisconnect` false.

Changing the spec: add a scenario to the Swift bench (`switch app/sim-bench/harness/main.swift`; the 2026-11-13 additions are in `switch app/curve-bench/main.swift`) first,
then here, then to the other ports. The Swift bench is the reference while the iPhone app is the one on
the real rig.

What this is not: a bench pass is not a real-rig test. The simulated rig only behaves the way the
protocol notes say the real one does.
