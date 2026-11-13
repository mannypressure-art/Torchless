# Bench vocabulary

Every port's harness implements these names so `scenarios.json` reads the same everywhere. Rules are
written as JavaScript-style expressions; a port may hand-translate them, but must not change what they test.

## Setup keys (`setup`)

| Key | Meaning |
| --- | --- |
| `show` (scenario field) | Light show on (`lightShowEnabled`) before the app starts |
| `app.parkAfterQuiet` | Seconds the app waits, idle in the background, before it lets go of the rig |
| `ble.linkLostWindow` | Seconds the app keeps trying to reconnect after an idle link loss |
| `world.writeLatency` | Seconds a write takes to reach the rig (default 0.02) |
| `world.pendingCancelReportsDisconnect` | Whether cancelling a pending connect reports a disconnect (default true) |
| `sim.*` | Any SimRig field before power-on, e.g. `sim.preset`, `sim.presetTemp[1]`, `sim.neverStops`, `sim.ignoreStops`, `sim.locksActiveTempMidDab`, `sim.ignoreCurveB` |
| `saved.<key>` | A value already in the app's saved settings at launch (e.g. `saved.lightRestoreV1`) |

Before each scenario the saved keys `lightShowV1`, `lightShowEnabled`, `dialPendingV1`, `lightRestoreV1` are cleared.

## Actions (`do`)

| Action | App call it maps to |
| --- | --- |
| `heatIt`, `cutIt`, `extendTen` | The HEAT IT, CUT IT and +10s buttons |
| `setLightMode {mode}` | Pick a light mode |
| `savePreset {slot, tempF, hold, profile}` | Save a preset slot |
| `saveCurve {slot, steps: [{t, f}]}` | Save a Custom heat curve to a slot: be at `f` degrees F when the hold has run `t` seconds |
| `selectPreset {slot}` | Make a slot active |
| `dialNudge {by}` | Ride the dial by +/- degrees F |
| `setDialMode {mode: "active"}` | Dial mode B (moves the active preset) instead of the live slot |
| `askDisconnect` | The Disconnect button |
| `appMovedToBackground`, `appBecameActive` | App leaves / returns to the foreground |
| `sim.buttonStart`, `sim.buttonStop` | The rig's own button |
| `sim.afterNextStatus {delay?, then[]}` | Right after the next status frame goes out, wait `delay` s (default 0) and run `then` on the rig |
| `sim.sendStatus` | Rig sends a status frame now |
| `world.loseLink`, `world.backInRange` | Rig walks out of range (link drops with an error) / comes back |
| `world.bluetooth {on}` | Phone Bluetooth off / on |

The default connect (scan at 0.2 s, tap the first rig at 0.6 s) runs in every scenario.

## Observables (rules)

| Name | Meaning |
| --- | --- |
| `sim.*` | SimRig state: `session` (0 or 170), `preset`, `lightMode`, `brightness`, `autoOff`, `remaining`, `temp`, `presetTemp[]`, `hold[]`, `profile[]`, `sessionStarts` |
| `app.*` | Controller state: `canHeat`, `canControl`, `canExtend`, `sessionOn`, `presets[i].tempF/.hold/.profile`, `curveCheckResult` (null, `'ok'`, `'MISMATCH'` or `'no report'`), `awayNote`, `message`, `disconnectWaiting`, `dialDisabledReason` |
| `ble.*` | Link state: `isConnected`, `reconnecting`, `connectionText` |
| `world.peripheral.connected` | The radio link really exists |
| `saved.<key>` | The app's saved setting, or null |
| `received` | Every frame the rig received: `{time, bytes, sessionWas, remainingWas, sinceStatus}` |
| `b9s` | `received` frames whose first byte is 185 (control frames) |
| `saves` | `received` frames whose first byte is 179, 183 or 181 (preset writes) |
| `curveFrames` | `received` frames whose first byte is 179, 183, 181, 186 or 187 (everything a curve save sends) |
| `curveProblem(steps)` | The app's own curve rule (Swift `CurveRules.problem`): the plain-words reason, or null when the curve is allowed |
| `stopsWhileHeating` | Count of `b9s` with `bytes[10] == 0` that arrived while `sessionWas != 0` |
| `firstStopWhileHeating` | The first such frame, or null |
| `firstB9Off` | The first `b9s` frame with `bytes[10] == 0`, or null |
| `appStarts` | `events.count('START by app frame')` |
| `starts`, `stops` | Rig events whose text starts with `START` / `STOP`, each with `time` |
| `indexOfFirstStartFrame` | Index in `received` of the first 185 frame with `bytes[10] == 170` (-1 if none) |
| `indexOfLastSaveFrame` | Index in `received` of the last 179/183/181 frame (99 if none) |
| `minGapBetweenReceived` | Smallest time between two consecutive `received` frames (99 if fewer than two) |
| `events.count(s)` | Rig events whose text contains `s` |
| `log.has(s)`, `log.count(s)` | App log lines containing `s` |

The app log strings the rules look for are part of the contract: `SAFETY CUT`, `AWAY CUT`, `AWAY`,
`SAFE OFF (stop, session 0)`, `(stop, session 0)`, `TX refused`, `Sending it again`,
`Slow-down flash started`, `HEAT IT waited too long`, `SESSION START`, `SESSION END`, `] RX `, `NOTICE:` (every message shown to
the user is also logged with this prefix), `result after 6 s: yes` / `no` / `can't tell`,
`CURVE CHECK preset n: ok` / `MISMATCH` / `no report`, `did not finish`.

Rig event strings the rules look for: `START by`, `STOP by`, `BAD`, `UNEXPECTED`, `refused (heating from it)`.
