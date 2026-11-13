// A simulated Puffco Peak Pro (Lorax firmware) for the Peak bench. Built from the public protocol notes
// (project files puffco/Puffco-protocol-notes.md). It is our guess at the real rig, not a recording of one:
// the first real test may show differences, and the log is built to catch them.

import { VirtualClock } from "../src/rig/clock";
import type { LoraxTransport } from "../src/rig/puffco/peak-controller";
import { Op, Path, Mode, State, f32le, loraxKey, sha256, parseReply, hex } from "../src/rig/puffco/lorax";

export interface SimProfile { name: string; tempC: number; secs: number }
export interface Received { t: number; op: number; path?: string; value?: number[] }

export class SimPeak {
  state: number = State.IDLE;
  tempC = 22;
  elapsed = 0;
  total = 0;
  active = 0;
  battery = 80;
  profiles: SimProfile[] = [
    { name: "Shatter", tempC: 232, secs: 30 }, { name: "Live Resin", tempC: 260, secs: 45 },
    { name: "Rosin", tempC: 288, secs: 30 }, { name: "Hot", tempC: 316, secs: 20 },
  ];
  /** Bonded with this phone already. If false the first open fails unless pairingMode is on. */
  paired = true;
  pairingMode = false;
  inRange = true;
  /** Rig answers nothing at all (e.g. link not encrypted). */
  silent = false;
  refuseUnlock = false;
  /** How many abort commands to ignore (a stubborn rig). */
  ignoreAborts = 0;
  /** Status to answer a start command with (non-zero = refused, e.g. low battery). */
  startStatus = 0;
  /** Start commands are acknowledged but nothing happens. */
  startDoesNothing = false;
  /** Temperatures as tenths of a degree in an int32 instead of float32 (older firmware). */
  intTemps = false;
  replyLatency = 0.04;
  heatRate = 9;     // °C per second while preheating
  coolRate = 2.5;
  readonly received: Received[] = [];
  private unlocked = false;
  private seed: number[] = [];
  private fadeLeft = 0;
  link: SimLorax | null = null;

  constructor(readonly clock: VirtualClock) { this.tick(); }

  private target(): SimProfile { return this.profiles[this.active]; }

  private tick() {
    const dt = 0.25;
    if (this.state === State.PREHEAT) {
      this.tempC = Math.min(this.target().tempC, this.tempC + this.heatRate * dt);
      this.elapsed += dt;
      if (this.tempC >= this.target().tempC - 0.5) { this.state = State.ACTIVE; this.elapsed = 0; this.total = this.target().secs; }
    } else if (this.state === State.ACTIVE) {
      this.elapsed += dt;
      if (this.elapsed >= this.total) { this.state = State.FADE; this.fadeLeft = 3; }
    } else {
      this.tempC = Math.max(22, this.tempC - this.coolRate * dt);
      if (this.state === State.FADE) { this.fadeLeft -= dt; if (this.fadeLeft <= 0) this.state = State.IDLE; }
    }
    this.clock.after(dt, () => this.tick());
  }

  /** Someone pressed the Peak's own button. */
  button() {
    if (this.state === State.IDLE) { this.state = State.PREHEAT; this.elapsed = 0; this.total = 0; }
    else if (this.state === State.PREHEAT || this.state === State.ACTIVE) this.state = State.IDLE;
  }

  heatingCommandsSent(mode: number): number {
    return this.received.filter(r => r.path === Path.modeCommand && r.value?.[0] === mode).length;
  }

  private temp(c: number): number[] {
    if (!this.intTemps) return f32le(c);
    const v = Math.round(c * 10);
    return [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255];
  }

  private read(path: string): number[] | null {
    const p = this.profiles;
    switch (path) {
      case Path.state: return [this.state];
      case Path.elapsed: return f32le(this.elapsed);
      case Path.total: return f32le(this.total);
      case Path.heaterTemp: return this.temp(this.tempC);
      case Path.heaterTarget: return this.temp(this.target().tempC);
      case Path.activeProfile: return [this.active];
      case Path.activeTemp: return this.temp(this.target().tempC);
      case Path.activeTime: return f32le(this.target().secs);
      case Path.battery: return f32le(this.battery);
      case Path.charging: return [0];
      case Path.chamber: return [3];
      case Path.dabs: return f32le(1234);
      case Path.name: return Array.from(Buffer.from("Peak Pro 02743"));
      case Path.serial: return Array.from(Buffer.from("PP02743"));
      case Path.firmware: return Array.from(Buffer.from("AW-1d90ae"));
    }
    const m = path.match(/^\/u\/app\/hc\/(\d)\/(name|temp|time)$/);
    if (m && p[Number(m[1])]) {
      const prof = p[Number(m[1])];
      return m[2] === "name" ? Array.from(Buffer.from(prof.name)) : m[2] === "temp" ? this.temp(prof.tempC) : f32le(prof.secs);
    }
    return null;
  }

  /** One packet from the app. Answers on the reply channel after a short delay. */
  handle(b: number[]) {
    if (this.silent || !this.link) return;
    const r = parseReply(b);   // same layout: seq, opcode, body
    if (!r) return;
    const seq = r.seq, op = r.status, body = r.payload;
    const answer = (status: number, payload: number[] = []) => {
      const link = this.link;
      this.clock.after(this.replyLatency, () => { if (link === this.link) link?.onReply?.([seq & 255, seq >> 8, status, ...payload]); });
    };
    if (op === Op.GET_ACCESS_SEED) {
      this.seed = Array.from({ length: 16 }, (_, i) => (i * 37 + 11 + Math.floor(this.clock.now())) & 255);
      answer(0, this.seed); return;
    }
    if (op === Op.UNLOCK_ACCESS) {
      const want = sha256([...loraxKey(), ...this.seed]).slice(0, 16);
      const ok = !this.refuseUnlock && hex(want) === hex(body.slice(0, 16));
      this.unlocked = ok;
      answer(ok ? 0 : 4); return;
    }
    if (!this.unlocked) { answer(5); return; }
    if (op === Op.READ_SHORT) {
      const path = Buffer.from(body.slice(4)).toString("utf8");
      this.received.push({ t: this.clock.now(), op, path });
      const v = this.read(path);
      answer(v ? 0 : 2, v ?? []); return;
    }
    if (op === Op.WRITE_SHORT) {
      const rest = body.slice(3);
      const z = rest.indexOf(0);
      const path = Buffer.from(rest.slice(0, z)).toString("utf8");
      const value = rest.slice(z + 1);
      this.received.push({ t: this.clock.now(), op, path, value });
      if (path === Path.modeCommand) {
        const m = value[0];
        if (m === Mode.HEAT_START) {
          if (this.startStatus !== 0) { answer(this.startStatus); return; }
          if (!this.startDoesNothing && this.state !== State.PREHEAT && this.state !== State.ACTIVE) { this.state = State.PREHEAT; this.elapsed = 0; this.total = 0; }
        } else if (m === Mode.HEAT_ABORT) {
          if (this.ignoreAborts > 0) this.ignoreAborts -= 1;
          else if (this.state === State.PREHEAT || this.state === State.ACTIVE) { this.state = State.FADE; this.fadeLeft = 2; }
        } else if (m === Mode.HEAT_BOOST) {
          if (this.state === State.ACTIVE) this.total += 15;
        }
        answer(0); return;
      }
      if (path === Path.activeProfile) {
        if (this.state === State.PREHEAT || this.state === State.ACTIVE || value[0] > 3) { answer(3); return; }
        this.active = value[0]; answer(0); return;
      }
      answer(2); return;
    }
    answer(1);
  }

  /** The Bluetooth link drops (out of range). */
  dropLink() {
    this.inRange = false;
    const l = this.link;
    this.link = null;
    this.unlocked = false;
    l?.onDrop?.("the Peak disconnected");
  }
}

export class SimLorax implements LoraxTransport {
  readonly id = "PEAK-SIM-0001";
  readonly name: string | null = "Peak Pro 02743";
  onReply: ((b: number[]) => void) | null = null;
  onEvent: ((b: number[]) => void) | null = null;
  onDrop: ((why: string) => void) | null = null;
  opens = 0;
  constructor(private readonly peak: SimPeak) {}

  open(done: (err: string | null, version: number[] | null) => void): void {
    this.opens += 1;
    const pk = this.peak;
    pk.clock.after(0.3, () => {
      if (!pk.inRange) { done("GATT connect timed out after 15 s", null); return; }
      if (!pk.paired && !pk.pairingMode) { done("SecurityError: insufficient encryption", null); return; }
      pk.paired = true;
      pk.link = this;
      done(null, [3, 0, 1, 0]);
    });
  }
  send(bytes: number[]): void { this.peak.clock.after(0.01, () => { if (this.peak.link === this) this.peak.handle(bytes); }); }
  close(): void { if (this.peak.link === this) this.peak.link = null; }
}
