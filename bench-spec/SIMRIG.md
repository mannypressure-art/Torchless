# The simulated rig and link

Each port rebuilds this exactly; it is the language-neutral version of
`switch app/sim-bench/stubs/CoreBluetooth.swift`. If the two ever disagree, the Swift file wins and this
page gets fixed.

## Link

- Scan reports the rig 0.1 s after it starts (name "Presh", service FEE7), if in range and Bluetooth is on.
- Connect completes 0.08 s after it is asked, if in range and Bluetooth is on. Service discovery,
  characteristic discovery, reads and notify setup each answer after 0.02 to 0.03 s.
- Characteristics: FEC1 (write), FEC2 (notify), 2A24 model "Switch 2", 2A29 maker "Dr.Dabber".
- A write reaches the rig after `writeLatency` (0.02 s). A write while not connected, or one that is
  in flight when the link drops, is lost.
- `loseLink`: out of range, link drops at once with the error "The connection has timed out unexpectedly."
- `backInRange`: in range again; a pending connect completes 0.08 s later.
- Cancelling a live connection reports a disconnect 0.02 s later. Cancelling a pending connect reports
  one only when `pendingCancelReportsDisconnect` is true.
- Bluetooth off drops the link and any pending connect without a disconnect callback, then reports the
  state change.

## Rig state at power-on

preset 1, lightMode 3, session 0, autoOff 10, unit 15, remaining 0, haptics 170, extend 0, battery 80,
brightness 50, temp 80 F. Slots 0 to 5: temps 480, 450, 500, 520, 550, 600; holds 30, 12, 30, 10, 45, 60;
profiles all 161. Preheat 2 s. Status every 0.5 s.

## Every 0.5 s (tick)

If heating: once past preheat, `remaining = max(0, total - whole seconds since countdown start)`. When
remaining hits 0, stop "by its own timer" after `lingerAfterZero` (0) unless `neverStops`. Temp rises 60 F
per tick toward the active slot's temp. If idle, temp falls 8 F per tick to 80. Then send a status frame.

Status frame (20 bytes): `169, 20, 0, preset, 0, 1, lightMode, session, autoOff, 0, temp>>8, temp&255,
unit, remaining, haptics, extend, battery, 0, brightness, 169`. After it goes out, run the
`afterStatus` hook if set.

Start: session 170, sessionStarts +1, `total = hold[preset] + 10 * extend`, remaining = min(total, 255),
countdown starts after preheat. Event "START by <cause>". Stop: session 0, remaining 0, extend 0.
Event "STOP by <cause>". Causes: "rig button", "app frame", "its own timer".

## Frames the rig accepts

Every received frame is recorded with time, bytes, session and remaining at that moment, and seconds since
the last status frame.

- 177 (hello): reports every slot (163 temp, 167 hold, 165 profile frames), then `225,7,1,2,3,4,225`,
  serial `195,11,"SW2-260929",195`, firmware `196,11,"V2.0.0  ",196`.
- 185 (control, must be 20 bytes or event "BAD B9 length"): `wantOn = bytes[10] == 170`. If heating and
  not wantOn and `ignoreStops > 0`: swallow it (event "STOP frame swallowed"), change nothing. Otherwise
  copy preset (3), lightMode (6), autoOff (8), unit (9), haptics (11), brightness (13). If heating: not
  wantOn stops it ("app frame"); a new extend (12) recomputes total and logs "EXTEND to n". If idle and
  wantOn: set extend, start ("app frame").
- 179 (slot temp, 8 bytes, slot <= 5): temp = bytes 3..4, event "TEMP slot n = t", reports 163.
- 183 (slot hold, 6 bytes): hold = bytes 3..4, reports 167.
- 181 (slot profile, 5 bytes): profile = byte 3, reports 165.
- 178: reports `162,13,0,5,0,63,0,121,0,210,0,0,162`.
- Anything else: event "UNEXPECTED frame n".

Slot temp report 163: `163, 8, slot, F>>8, F&255, C>>8, C&255, 163` with C = round((F - 32) * 5 / 9).

2026-11-12, matching the Swift sim (sim-bench/stubs/CoreBluetooth.swift, 2026-11-11):
- Ascent (profile 177): once the countdown runs, the target climbs 1 F a second from the set temp, up to the hold length.
- reportsLiveSlot = false by default. The connect dump lists presets 1 to 5 only, as the real rig does. presetsAndDial turns it on.

2026-11-13, matching the Swift sim (switch app/curve-bench/CoreBluetooth.swift d97deb29):
- `locksActiveTempMidDab` = true by default, as the real rig did (Log of 2026-11-12). A 179 frame for the slot
  the rig is heating from changes nothing: event "TEMP slot n refused (heating from it), still t", and the 163
  report carries the old temp. Other slots, and any slot while idle, are written as before.
  dialActivePresetIfRigFollows and dialAfterLinkDrop turn the lock off.
- 186 and 187 (Custom curve halves, 19 bytes: `cmd, 19, slot, 15 payload bytes, cmd`, slot 1 to 5). Wrong
  shape: event "BAD curve frame n". While heating: event "CURVE frame n refused (heating)", nothing stored,
  no report. Idle, 186: store the 15 bytes as `curveA[slot]`, event "CURVE A slot n", report
  `170, 19, slot, payload, 170`. Idle, 187: store as `curveB[slot]`, event "CURVE B slot n", report
  `171, 19, slot, payload, 171`; with `ignoreCurveB` on, store nothing, report nothing, event "CURVE B slot n lost".
- Payload: three steps of `F>>8, F&255, C>>8, C&255, seconds`; an unused step is five zeros.
- Custom (profile 241): once the countdown runs, the target follows the saved points (curveA then curveB, steps
  with F > 0): the first point's temp up to its time, a straight line between points, the last point's temp
  after it. No saved points: the slot temp, as Steady. This ramp is a guess; never seen on the real rig.
