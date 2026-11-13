// The Peak bench: runs PeakController against the simulated Peak (peak-sim.ts) on a virtual clock.
// npm run bench:peak   (or: node dist/bench/peak-run.js -v  for every scenario's log)
// A pass here is not a real-Peak test: the simulated Peak is our reading of public notes.

import { createHash } from "crypto";
import { VirtualClock } from "../src/rig/clock";
import { PeakController } from "../src/rig/puffco/peak-controller";
import {
  sha256, unlockToken, loraxKey, packet, readShortBody, writeShortBody, Path, Mode, State, Op,
  parseTempC, parseBattery, parseSeconds, f32le, hex, looksLikePuffco,
} from "../src/rig/puffco/lorax";
import { SimPeak, SimLorax } from "./peak-sim";
import { DabWatcher } from "../src/web/dab-watcher";
import { JarStore, MemoryJarBackend } from "../src/web/jars";

const verbose = process.argv.includes("-v");
const only = process.argv.slice(2).find(a => !a.startsWith("-"));

interface World { clock: VirtualClock; peak: SimPeak; link: SimLorax; app: PeakController; log: string[]; taps: { heat: number } }

function world(setup?: (p: SimPeak) => void): World {
  const clock = new VirtualClock();
  const peak = new SimPeak(clock);
  setup?.(peak);
  const log: string[] = [];
  const app = new PeakController(clock, s => log.push(`[${clock.now().toFixed(2)}] ${s}`));
  const link = new SimLorax(peak);
  return { clock, peak, link, app, log, taps: { heat: 0 } };
}
function linkUp(w: World, secs = 8) { w.app.take(w.link); w.clock.runUntil(w.clock.now() + secs); }
function run(w: World, secs: number) { w.clock.runUntil(w.clock.now() + secs); }
function heat(w: World) { w.taps.heat += 1; w.app.heatIt(); }
const has = (w: World, s: string) => w.log.some(l => l.includes(s));

type Check = (w: World | null, fail: (m: string) => void) => World | null;
const scenarios: { id: string; title: string; run: Check }[] = [];
const add = (id: string, title: string, run: Check) => scenarios.push({ id, title, run });

// MARK: Protocol pieces

add("sha", "SHA-256 and the login token match Node's crypto", (_, fail) => {
  for (const s of ["", "abc", "x".repeat(200)]) {
    const mine = hex(sha256(Array.from(Buffer.from(s))));
    const node = hex(createHash("sha256").update(s).digest());
    if (mine !== node) fail(`sha256("${s.slice(0, 8)}") ${mine} != ${node}`);
  }
  if (loraxKey().length !== 16) fail("key is not 16 bytes");
  const seed = Array.from({ length: 16 }, (_, i) => i * 7);
  const want = hex(createHash("sha256").update(Buffer.from([...loraxKey(), ...seed])).digest().subarray(0, 16));
  if (hex(unlockToken(seed)) !== want) fail("unlock token differs from Node's");
  return null;
});

add("packets", "Packets are laid out as the public notes say", (_, fail) => {
  const r = packet(0x0102, Op.READ_SHORT, readShortBody("/p/app/mc", 64));
  if (hex(r) !== hex([0x02, 0x01, 0x10, 0, 0, 64, 0, ...Buffer.from("/p/app/mc")])) fail(`read: ${hex(r)}`);
  const wr = packet(5, Op.WRITE_SHORT, writeShortBody(Path.modeCommand, [Mode.HEAT_START]));
  if (hex(wr) !== hex([5, 0, 0x11, 0, 0, 0, ...Buffer.from("/p/app/mc"), 0, 7])) fail(`write: ${hex(wr)}`);
  return null;
});

add("values", "Temperatures, times and battery parse in every form seen in public code", (_, fail) => {
  const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 0.01;
  if (!near(parseTempC(f32le(232.2)), 232.2)) fail("float temp");
  if (!near(parseTempC([0x12, 0x09, 0, 0]), 232.2)) fail("tenths int temp");
  if (parseTempC([0xff, 0xff, 0xff, 0x7f]) !== null) fail("junk temp should be null, not a guess");
  if (parseBattery(f32le(76)) !== 76 || parseBattery([76]) !== 76 || parseBattery([76, 0, 0, 0]) !== 76) fail("battery forms");
  if (!near(parseSeconds(f32le(45)), 45) || parseSeconds([45, 0, 0, 0]) !== 45) fail("seconds forms");
  if (!looksLikePuffco("Peak Pro 02743") || looksLikePuffco("Switch 2")) fail("name check");
  return null;
});

// MARK: Link and login

add("link", "Links, logs in, reads the four profiles, shows them as presets 1 to 4 in °F", (_, fail) => {
  const w = world(); linkUp(w);
  if (w.app.link !== "ready") fail(`link is ${w.app.link}`);
  if (!w.app.linkFresh || !w.app.canHeat) fail("not ready to heat");
  const p = w.app.presets;
  if (p[1].tempF !== 450 || p[2].tempF !== 500 || p[4].tempF !== 601 || p[1].hold !== 30) fail(`presets ${JSON.stringify(p.slice(1, 5))}`);
  const live = w.app.live!;
  if (live.preset !== 1 || live.unitByte !== 15 || live.sessionByte !== 0 || live.battery !== 80) fail(`live ${JSON.stringify(live)}`);
  for (const s of ["Login OK", "firmware: AW-1d90ae", "Profiles: 1 \"Shatter\" 450°F 30s", "not affiliated with Puffco"]) if (!has(w, s)) fail(`log lacks "${s}"`);
  if (w.peak.heatingCommandsSent(Mode.HEAT_START) !== 0) fail("sent a heat start while linking");
  return w;
});

add("notPaired", "Peak not paired and not in pairing mode: says how to pair, never heats", (_, fail) => {
  const w = world(p => { p.paired = false; }); linkUp(w);
  if (w.app.link !== "failed") fail(`link ${w.app.link}`);
  if (!/pairing mode/.test(w.app.message ?? "")) fail(`message: ${w.app.message}`);
  heat(w); run(w, 2);
  if (w.peak.received.length) fail("sent commands without a link");
  return w;
});

add("pairingMode", "Peak in pairing mode the first time: pairs and links", (_, fail) => {
  const w = world(p => { p.paired = false; p.pairingMode = true; }); linkUp(w);
  if (w.app.link !== "ready") fail(`link ${w.app.link}`);
  return w;
});

add("silent", "Peak answers nothing (link not encrypted): no-answer message, can't heat", (_, fail) => {
  const w = world(p => { p.silent = true; }); linkUp(w);
  if (w.app.link !== "failed" || !/No answer/.test(w.app.message ?? "")) fail(`link ${w.app.link}, message ${w.app.message}`);
  if (w.app.canHeat) fail("canHeat with no login");
  return w;
});

add("unlockRefused", "Login refused (newer firmware): plain message, nothing else sent", (_, fail) => {
  const w = world(p => { p.refuseUnlock = true; }); linkUp(w);
  if (w.app.link !== "failed" || !/refused the login/.test(w.app.message ?? "")) fail(`link ${w.app.link}, message ${w.app.message}`);
  if (w.peak.received.length) fail("sent reads or writes after a refused login");
  return w;
});

// MARK: Heat

add("dab", "HEAT IT: preheat, at temp, counts down, ends on its own; heat start sent once", (_, fail) => {
  const w = world(); linkUp(w);
  heat(w); run(w, 2);
  if (!w.app.sessionOn || w.app.phaseText !== "preheat") fail(`after 2 s: ${w.app.phaseText}`);
  if (!has(w, "HEAT IT confirmed")) fail("start not confirmed in the log");
  run(w, 30);
  if (w.app.phaseText !== "active") fail(`after 32 s: ${w.app.phaseText}`);
  const left1 = w.app.secondsLeft; run(w, 5); const left2 = w.app.secondsLeft;
  if (!(left2 < left1)) fail(`countdown didn't move: ${left1} -> ${left2}`);
  run(w, 40);
  if (w.app.sessionOn) fail("still heating after the profile time");
  if (!has(w, "Dab ended on its own")) fail("end not logged");
  if (w.peak.heatingCommandsSent(Mode.HEAT_START) !== 1) fail(`heat starts sent: ${w.peak.heatingCommandsSent(Mode.HEAT_START)}`);
  if (w.peak.heatingCommandsSent(Mode.HEAT_ABORT) !== 0) fail("sent an abort nobody asked for");
  return w;
});

add("cut", "CUT IT mid-dab: abort sent, heat off confirmed within 3 s", (_, fail) => {
  const w = world(); linkUp(w);
  heat(w); run(w, 30);
  const at = w.clock.now(); w.app.cutIt(); run(w, 3);
  if (w.app.sessionOn) fail("still heating 3 s after CUT IT");
  if (!has(w, "CUT IT confirmed")) fail("not confirmed");
  const aborts = w.peak.received.filter(r => r.value?.[0] === Mode.HEAT_ABORT);
  if (aborts.length !== 1 || aborts[0].t - at > 0.5) fail(`aborts ${aborts.length}, first after ${aborts[0] ? (aborts[0].t - at).toFixed(2) : "-"} s`);
  return w;
});

add("cutStubborn", "Peak ignores the first CUT IT: sent again and confirmed", (_, fail) => {
  const w = world(p => { p.ignoreAborts = 1; }); linkUp(w);
  heat(w); run(w, 30); w.app.cutIt(); run(w, 8);
  if (w.app.sessionOn) fail("still heating");
  if (w.peak.heatingCommandsSent(Mode.HEAT_ABORT) !== 2) fail(`aborts: ${w.peak.heatingCommandsSent(Mode.HEAT_ABORT)}`);
  if (w.app.message) fail(`unexpected message ${w.app.message}`);
  return w;
});

add("cutIgnored", "Peak ignores CUT IT twice: tells you to press its button", (_, fail) => {
  const w = world(p => { p.ignoreAborts = 5; }); linkUp(w);
  heat(w); run(w, 30); w.app.cutIt(); run(w, 8);
  if (!/Press its button/.test(w.app.message ?? "")) fail(`message: ${w.app.message}`);
  if (w.peak.heatingCommandsSent(Mode.HEAT_ABORT) !== 2) fail(`aborts: ${w.peak.heatingCommandsSent(Mode.HEAT_ABORT)}`);
  return w;
});

add("button", "Dab started on the Peak's own button: logged, shown, never cut", (_, fail) => {
  const w = world(); linkUp(w);
  w.peak.button(); run(w, 20);
  if (!w.app.sessionOn) fail("app doesn't show the button dab");
  if (!has(w, "Heat started on the Peak itself")) fail("not logged");
  run(w, 60);
  if (w.peak.heatingCommandsSent(Mode.HEAT_ABORT) !== 0 || w.peak.heatingCommandsSent(Mode.HEAT_START) !== 0) fail("sent heat commands for a button dab");
  return w;
});

add("refused", "Peak refuses HEAT IT (low battery): says so, nothing pending", (_, fail) => {
  const w = world(p => { p.startStatus = 3; p.battery = 6; }); linkUp(w);
  heat(w); run(w, 2);
  if (!/refused HEAT IT/.test(w.app.message ?? "") || !/Battery/.test(w.app.message ?? "")) fail(`message: ${w.app.message}`);
  if (w.app.startPendingAt !== null || !w.app.canHeat) fail("still pending");
  return w;
});

add("noStart", "HEAT IT answered but nothing heats: says so after 5 s", (_, fail) => {
  const w = world(p => { p.startDoesNothing = true; }); linkUp(w);
  heat(w); run(w, 6);
  if (!/didn't start heating/.test(w.app.message ?? "")) fail(`message: ${w.app.message}`);
  if (!w.app.canHeat) fail("HEAT IT stays locked");
  return w;
});

add("boost", "Boost while at temp adds time (logged); ignored while idle", (_, fail) => {
  const w = world(); linkUp(w);
  w.app.boost(); run(w, 1);
  if (w.peak.heatingCommandsSent(Mode.HEAT_BOOST) !== 0) fail("boost sent while idle");
  heat(w); run(w, 30);
  const before = w.app.secondsLeft; w.app.boost(); run(w, 2);
  if (w.peak.heatingCommandsSent(Mode.HEAT_BOOST) !== 1) fail("boost not sent");
  if (!(w.app.secondsLeft > before)) fail(`time left ${before} -> ${w.app.secondsLeft}`);
  if (!has(w, "Session time went up")) fail("boost not logged");
  return w;
});

add("profile", "Picking a profile while idle sets it; locked while heating", (_, fail) => {
  const w = world(); linkUp(w);
  w.app.selectProfile(2); run(w, 2);
  if (w.peak.active !== 2 || w.app.live?.preset !== 3) fail(`peak ${w.peak.active}, app preset ${w.app.live?.preset}`);
  if (w.app.presets[3].tempF !== 550) fail(`goal ${w.app.presets[3].tempF}`);
  heat(w); run(w, 3);
  w.app.selectProfile(0); run(w, 2);
  if (w.peak.active !== 2) fail("profile changed mid-dab");
  return w;
});

add("profileOnPeak", "Profile changed on the Peak itself shows up within the slow poll", (_, fail) => {
  const w = world(); linkUp(w);
  w.peak.active = 3; run(w, 20);
  if (w.app.live?.preset !== 4) fail(`preset ${w.app.live?.preset}`);
  if (!has(w, "changed on the Peak")) fail("not logged");
  return w;
});

// MARK: Link trouble (the away rule: the Peak finishes its own dab; we never cut because the link went)

add("dropMidDab", "Link drops mid-dab, back after the dab: no commands while away, says heat is off", (_, fail) => {
  const w = world(); linkUp(w);
  heat(w); run(w, 30);
  const sent = w.peak.received.length;
  w.peak.dropLink();
  if (!/finishes and turns itself off/.test(w.app.awayNote ?? "")) fail(`away note: ${w.app.awayNote}`);
  run(w, 40);
  if (w.peak.received.length !== sent) fail("sent something while the link was down");
  w.peak.inRange = true; run(w, 8);
  if (w.app.link !== "ready") fail(`link ${w.app.link}`);
  if (!/finished while the link was down/.test(w.app.awayNote ?? "")) fail(`away note: ${w.app.awayNote}`);
  if (w.peak.heatingCommandsSent(Mode.HEAT_ABORT) !== 0) fail("cut the dab because of the link");
  return w;
});

add("dropBackMidDab", "Link drops and comes back while still heating: shows the dab, no cut", (_, fail) => {
  const w = world(p => { p.profiles[0].secs = 90; }); linkUp(w);
  heat(w); run(w, 30); w.peak.dropLink(); run(w, 4); w.peak.inRange = true; run(w, 6);
  if (w.app.link !== "ready" || !w.app.sessionOn) fail(`link ${w.app.link}, on ${w.app.sessionOn}`);
  if (!/still on its dab/.test(w.app.awayNote ?? "")) fail(`away note ${w.app.awayNote}`);
  if (w.peak.heatingCommandsSent(Mode.HEAT_ABORT) !== 0) fail("cut it");
  return w;
});

add("giveUp", "Peak gone for good: stops trying after 90 s and says so", (_, fail) => {
  const w = world(); linkUp(w);
  w.peak.dropLink(); run(w, 120);
  if (w.app.link !== "none" || !/Lost the Peak/.test(w.app.message ?? "")) fail(`link ${w.app.link}, message ${w.app.message}`);
  const opens = w.link.opens; run(w, 60);
  if (w.link.opens !== opens) fail("kept trying after giving up");
  return w;
});

add("stale", "Peak stops answering without a drop: HEAT IT locks within 4 s, CUT IT still sends", (_, fail) => {
  const w = world(); linkUp(w);
  heat(w); run(w, 30);
  w.peak.silent = true; run(w, 5);
  if (w.app.linkFresh || w.app.canHeat) fail("still fresh");
  w.app.cutIt(); run(w, 2.6);
  if (!w.log.some(l => l.includes("TX #") && l.includes("stop heat cycle (try 1)"))) fail("CUT IT not sent within 2.6 s");
  return w;
});

add("unlink", "UNLINK: lets go, no reconnect, sends no heat command", (_, fail) => {
  const w = world(); linkUp(w);
  w.app.disconnect(); run(w, 30);
  if (w.app.link !== "none" || w.link.opens !== 1) fail(`link ${w.app.link}, opens ${w.link.opens}`);
  if (w.peak.heatingCommandsSent(Mode.HEAT_ABORT) + w.peak.heatingCommandsSent(Mode.HEAT_START) !== 0) fail("heat command on unlink");
  return w;
});

add("intTemps", "Older firmware sending tenths as ints: same °F on screen", (_, fail) => {
  const w = world(p => { p.intTemps = true; }); linkUp(w);
  if (w.app.presets[1].tempF !== 450) fail(`preset 1 ${w.app.presets[1].tempF}`);
  return w;
});

// MARK: The adapter: screens that read the shared shape

add("jarLog", "A Peak dab lands in the current jar (time, goal °F, peak) through the same DabWatcher", (_, fail) => {
  const w = world(); linkUp(w);
  const store = new JarStore(new MemoryJarBackend());
  store.jars = [{ id: "j1", strain: "Test", producer: "Bench", review: "", finished: false, added: new Date(0).toISOString(), updated: new Date(0).toISOString() }];
  store.currentID = "j1";
  let t = 0;
  const watcher = new DabWatcher(store, () => w.clock.wallMs() + t, () => {});
  w.app.onChange = () => watcher.update(w.app);
  heat(w); run(w, 80);
  const dabs = store.jar("j1")?.dabs ?? [];
  if (dabs.length !== 1) { fail(`dabs logged: ${dabs.length}`); return w; }
  const d = dabs[0];
  if (d.goal !== 450 || d.unit !== "F" || !(d.seconds >= 30) || !(d.peak! >= 445)) fail(`dab ${JSON.stringify(d)}`);
  return w;
});

add("logShape", "The log has what a first real test needs: raw packets, states, heartbeat, header", (_, fail) => {
  const w = world(); linkUp(w); heat(w); run(w, 40); w.app.cutIt(); run(w, 5);
  for (const s of ["TX #", "RX #", "State 5 idle -> 7 preheat", "State 7 preheat -> 8 active", "Now: ", "Seed ", "Version characteristic"]) if (!has(w, s)) fail(`log lacks "${s}"`);
  const head = w.app.headerLines().join("\n");
  if (!/firmware AW-1d90ae/.test(head) || !/Lorax protocol 3/.test(head)) fail(`header: ${head}`);
  if (w.log.length > 1500) fail(`log too chatty: ${w.log.length} lines for one dab`);
  return w;
});

let passed = 0;
const list = only ? scenarios.filter(s => s.id === only) : scenarios;
for (const sc of list) {
  const fails: string[] = [];
  let w: World | null = null;
  try { w = sc.run(null, m => fails.push(m)); } catch (e) { fails.push(`threw: ${e instanceof Error ? e.stack : e}`); }
  if (fails.length === 0) passed += 1;
  console.log(`${fails.length ? "FAIL" : "PASS"} ${sc.title}`);
  for (const f of fails) console.log(`     ${f}`);
  if ((verbose || fails.length) && w) console.log(w.log.map(l => "       " + l).join("\n"));
}
console.log(`${passed} of ${list.length} Peak scenarios passed`);
if (passed !== list.length) process.exitCode = 1;
void State;
