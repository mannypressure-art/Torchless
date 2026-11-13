// Runs the shared scenarios (presh-shared/bench-spec/scenarios.json) against the web rig logic and the
// simulated rig, on a virtual clock. Prints PASS/FAIL lines with the exact titles from the spec.
// usage: node dist/bench/run.js [spec path] [scenario id ...] [-v] [--quiet-cancel]

import * as fs from "fs";
import * as path from "path";
import { SimWorld, SimCentral, Seen } from "./sim";
import { BLEManager } from "../src/rig/ble-manager";
import { RigController } from "../src/rig/rig-controller";
import { MemoryStore } from "../src/rig/storage";

interface Step { t: number | string; do?: string; args?: Record<string, unknown>; check?: string; expect?: string }
interface Rule { rule: string; expect: string }
interface Scenario {
  id: string; title: string; show?: boolean; allowedAppStarts?: number | string; finish: number;
  setup?: Record<string, unknown>; steps: Step[]; final: Rule[];
}
interface Spec { invariants: Rule[]; scenarios: Scenario[] }

const args = process.argv.slice(2);
const verbose = args.includes("-v");
const quietCancel = args.includes("--quiet-cancel");
const positional = args.filter(a => !a.startsWith("-"));
// The spec sits next to this project: ../bench-spec in the Torchless repo, ../presh-shared/bench-spec in project files.
const defaultSpec = [path.resolve(__dirname, "../../../bench-spec/scenarios.json"), path.resolve(__dirname, "../../../presh-shared/bench-spec/scenarios.json")]
  .find(p => fs.existsSync(p)) ?? "scenarios.json";
const specPath = positional[0]?.endsWith(".json") ? positional.shift()! : defaultSpec;
const spec: Spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const only = new Set(positional);

const randomInt = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));

function setPath(root: Record<string, any>, key: string, value: unknown) {
  // "sim.presetTemp[1]" / "app.parkAfterQuiet" / "world.writeLatency"
  const m = key.match(/^(\w+)\.(\w+)(?:\[(\d+)\])?$/);
  if (!m) throw new Error(`bad setup key ${key}`);
  const target = root[m[1]];
  if (target === undefined) throw new Error(`unknown setup object ${m[1]}`);
  if (m[3] !== undefined) target[m[2]][Number(m[3])] = value;
  else {
    if (!(m[2] in target)) throw new Error(`unknown setup field ${key}`);
    target[m[2]] = value;
  }
}

function runScenario(sc: Scenario): boolean {
  const world = new SimWorld();
  const clock = world.clock;
  const store = new MemoryStore();
  const failures: string[] = [];
  const out: string[] = [`=== ${sc.title}`];
  const say = (s: string) => out.push(s);

  // Saved settings first (the controller reads them when it starts), then the app, then the rig.
  store.set("lightShowEnabled", !!sc.show);
  const setup = sc.setup ?? {};
  for (const [k, v] of Object.entries(setup)) if (k.startsWith("saved.")) store.set(k.slice(6), v);
  if (quietCancel && sc.id === "linkLostGiveUp") setup["world.pendingCancelReportsDisconnect"] = false;

  const central = new SimCentral(world);
  const ble = new BLEManager(central, clock);
  const rig = new RigController(clock, store);
  rig.attach(ble);
  world.rig.power();
  const sim = world.rig;

  const roots: Record<string, any> = { sim, app: rig, ble, world };
  for (const [k, v] of Object.entries(setup)) if (!k.startsWith("saved.")) setPath(roots, k, v);

  let allowedAppStarts: number | string = sc.allowedAppStarts ?? 0;

  const context = () => {
    const received = sim.received;
    const b9s = received.filter(f => f.bytes[0] === 185);
    const saves = received.filter(f => [179, 183, 181].includes(f.bytes[0]));
    const stopsHeating = b9s.filter(f => f.bytes[10] === 0 && f.sessionWas !== 0);
    const count = (list: string[], s: string) => list.filter(x => x.includes(s)).length;
    let minGap = 99;
    for (let i = 1; i < received.length; i++) minGap = Math.min(minGap, received[i].time - received[i - 1].time);
    const firstStart = received.findIndex(f => f.bytes[0] === 185 && f.bytes[10] === 170);
    let lastSave = -1;
    received.forEach((f, i) => { if ([179, 183, 181].includes(f.bytes[0])) lastSave = i; });
    const savedProxy = new Proxy({}, { get: (_t, k) => store.get(String(k)) });
    return {
      sim, app: rig, ble,
      world: { peripheral: { connected: world.peripheral.connected } },
      saved: savedProxy,
      received, b9s, saves,
      stopsWhileHeating: stopsHeating.length,
      curveFrames: received.filter(f => [179, 183, 181, 186, 187].includes(f.bytes[0])),
      holdWrites: b9s.filter(f => f.sessionWas !== 0 && f.bytes[12] > 0),
      curveProblem: (steps: { t: number; f: number }[]) => RigController.curveProblem(steps),
      firstStopWhileHeating: stopsHeating[0] ?? null,
      firstB9Off: b9s.find(f => f.bytes[10] === 0) ?? null,
      appStarts: count(sim.events.map(e => e.what), "START by app frame"),
      starts: sim.events.filter(e => e.what.startsWith("START")),
      stops: sim.events.filter(e => e.what.startsWith("STOP")),
      indexOfFirstStartFrame: firstStart,
      indexOfLastSaveFrame: lastSave < 0 ? 99 : lastSave,
      minGapBetweenReceived: minGap,
      events: { count: (s: string) => count(sim.events.map(e => e.what), s) },
      log: { has: (s: string) => count(ble.logLines, s) > 0, count: (s: string) => count(ble.logLines, s) },
      allowedAppStarts: typeof allowedAppStarts === "number" ? allowedAppStarts : NaN,
      Math, randomInt,
    };
  };

  const evaluate = (expr: string): unknown => {
    const ctx = context();
    const names = Object.keys(ctx);
    // eslint-disable-next-line no-new-func
    return new Function(...names, `"use strict"; return (${expr});`)(...names.map(n => (ctx as any)[n]));
  };

  const check = (expr: string, what: string) => {
    let ok = false;
    try { ok = !!evaluate(expr); } catch (e) { what += ` (rule error: ${(e as Error).message})`; }
    if (ok) say(`    ok: ${what}`); else { failures.push(what); say(`    FAIL: ${what}   [${expr}]`); }
  };

  const at = (t: number, what: string, body: () => void) => clock.after(t, () => { say(`  t=${t.toFixed(1).padStart(5)}  ${what}`); body(); });

  const act = (name: string, a: Record<string, any> = {}) => {
    switch (name) {
      case "heatIt": rig.heatIt(); break;
      case "cutIt": rig.cutIt(); break;
      case "extendTen": rig.extendTen(); break;
      case "setLightMode": rig.setLightMode(a.mode); break;
      case "savePreset": rig.savePreset(a.slot, a.tempF, a.hold, a.profile); break;
      case "selectPreset": rig.selectPreset(a.slot); break;
      case "saveCurve": rig.saveCurve(a.slot, a.steps); break;
      case "saveCurveOnce": rig.saveCurveOnce(a.slot, a.steps); break;
      case "putBackNow": rig.putBackNow(); break;
      case "setHold": rig.setHold(a.on !== false); break;
      case "sim.whenRemaining": {
        // Once, on the first status that shows heat with exactly this many seconds left.
        const then: string[] = a.then ?? [];
        const delay: number = a.delay ?? 0;
        const prev = sim.afterStatus;
        sim.afterStatus = () => {
          prev?.();
          if (sim.session === 0 || sim.remaining !== a.remaining) return;
          sim.afterStatus = null;
          const run = () => then.forEach(n => act(n));
          if (delay > 0) clock.after(delay, run); else run();
        };
        break;
      }
      case "dialNudge": rig.dialNudge(a.by); break;
      case "setDialMode": rig.dialMode = a.mode; break;
      case "askDisconnect": rig.askDisconnect(); break;
      case "appMovedToBackground": rig.appMovedToBackground(); break;
      case "appBecameActive": rig.appBecameActive(); break;
      case "sim.buttonStart": sim.buttonStart(); break;
      case "sim.buttonStop": sim.buttonStop(); break;
      case "sim.sendStatus": sim.sendStatus(); break;
      case "sim.afterNextStatus": {
        const then: string[] = a.then ?? [];
        const delay: number = a.delay ?? 0;
        sim.afterStatus = () => {
          sim.afterStatus = null;
          const run = () => then.forEach(n => act(n));
          if (delay > 0) clock.after(delay, run); else run();
        };
        break;
      }
      case "world.loseLink": central.simLoseLink(); break;
      case "world.backInRange": central.simBackInRange(); break;
      case "world.bluetooth": central.simBluetooth(!!a.on); break;
      default: throw new Error(`unknown action ${name}`);
    }
  };

  // The default connect, then the scenario's steps in order.
  at(0.2, "scan", () => ble.startScan());
  at(0.6, "tap the rig in the list", () => {
    const d = ble.devices[0];
    if (d) ble.connect(d); else { failures.push("no rig found by scan"); say("    FAIL: no rig found by scan"); }
  });
  for (const st of sc.steps) {
    const t = typeof st.t === "number" ? st.t : Number(evaluate(st.t));
    if (st.do) at(t, st.do + (st.args ? " " + JSON.stringify(st.args) : ""), () => act(st.do!, st.args as any));
    if (st.check) at(t, "check", () => check(st.check!, st.expect ?? st.check!));
  }
  let done = false;
  at(sc.finish, "final checks", () => {
    for (const r of sc.final) check(r.rule, r.expect);
    if (typeof allowedAppStarts === "string") allowedAppStarts = Number(evaluate(allowedAppStarts));
    for (const r of spec.invariants) check(r.rule, r.expect);
    done = true;
  });
  clock.runUntil(sc.finish + 1, () => done);

  if (failures.length > 0 || verbose) {
    say("  --- rig events");
    for (const e of sim.events) say(`    ${e.time.toFixed(2)} ${e.what}`);
    say("  --- app log (no RX/CURVE)");
    for (const l of ble.logLines) if (!l.includes("] RX ") && !l.includes("CURVE")) say(`    ${l}`);
  }
  out.push(failures.length === 0 ? `PASS ${sc.title}` : `FAIL ${sc.title}: ${failures.length} problem(s)`);
  if (failures.length > 0 || verbose) console.log(out.join("\n"));
  else console.log(out[out.length - 1]);
  return failures.length === 0;
}

let pass = 0, total = 0;
for (const sc of spec.scenarios) {
  if (only.size > 0 && !only.has(sc.id)) continue;
  total += 1;
  if (runScenario(sc)) pass += 1;
}
console.log(`${pass} of ${total} scenarios passed`);
process.exit(pass === total ? 0 : 1);
