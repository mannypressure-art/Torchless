// Drives a Puffco Peak Pro over its Lorax protocol: link, login, polling, HEAT IT / CUT IT / boost, heat
// profiles, and a full log for the first real test. Not tested on a real Peak yet.
//
// It also shows itself in the same read-only shape the screens already read from the Switch controller
// (live, presets, sessionOn, linkFresh, connected), so the gauge, the jar dab log, the heat-up look and the
// battery maths work for either rig without changing the Switch code. See rig-view.ts.
//
// Safety rules for the Peak (differs from the Switch on purpose):
// - The Peak runs its own heat cycle and turns itself off at the end, so a dropped link never leaves it heating.
// - Dabs started on the Peak's own button are normal. Torchless logs them and leaves them alone (no SAFETY CUT).
// - CUT IT is checked: if the Peak still says it is heating 3 s later it is sent again, and after that the
//   app says so plainly and asks for the button.

import type { Clock, Cancel } from "../clock";
import { DISTANT_PAST } from "../clock";
import type { LiveStatus } from "../frames";
import type { PresetInfo } from "../rig-controller";
import {
  Op, opName, Path, Mode, State, stateName, isHeatingState, packet, readShortBody, writeShortBody, parseReply,
  parseTempC, parseSeconds, parseBattery, parseCount, cToF, hex, text, unlockToken,
} from "./lorax";

/** The Bluetooth side, so the bench can plug in a simulated Peak. web-lorax.ts is the Web Bluetooth one. */
export interface LoraxTransport {
  readonly id: string;
  readonly name: string | null;
  /** Connect, read the version characteristic (this is what triggers pairing), turn on reply and event
   *  notifications. done(null, versionBytes) or done(errorText, null). */
  open(done: (err: string | null, version: number[] | null) => void): void;
  /** One packet to the command characteristic. */
  send(bytes: number[]): void;
  close(): void;
  onReply: ((b: number[]) => void) | null;
  onEvent: ((b: number[]) => void) | null;
  onDrop: ((why: string) => void) | null;
}

export interface PeakProfile { n: number; name: string | null; tempC: number | null; seconds: number | null }

export type PeakLink = "none" | "connecting" | "unlocking" | "reading" | "ready" | "reconnecting" | "failed";

interface Job { op: number; body: number[]; what: string; quiet: boolean; cb: (r: { status: number; payload: number[] } | null) => void }

export class PeakController {
  static readonly replyTimeout = 2.5;
  static readonly pollEvery = 1.0;
  static readonly slowEvery = 15;            // polls between battery / profile reads
  static readonly freshFor = 4.0;
  static readonly startConfirm = 5.0;
  static readonly stopConfirm = 3.0;
  static readonly reconnectEvery = 3.0;
  static readonly reconnectFor = 90.0;
  static readonly rawLinesPerLink = 80;

  link: PeakLink = "none";
  transport: LoraxTransport | null = null;
  message: string | null = null;
  awayNote: string | null = null;
  onChange: () => void = () => {};

  // What the Peak reported
  protocolVersion: number | null = null;
  state: number | null = null;
  elapsed: number | null = null;
  total: number | null = null;
  tempC: number | null = null;
  activeProfile: number | null = null;
  activeTempC: number | null = null;
  activeSeconds: number | null = null;
  battery: number | null = null;
  chargeRaw: string | null = null;
  profiles: PeakProfile[] = [0, 1, 2, 3].map(n => ({ n, name: null, tempC: null, seconds: null }));
  info: Record<string, string> = {};
  lastReplyAt = DISTANT_PAST;

  startPendingAt: number | null = null;
  stopPendingAt: number | null = null;
  private stopTries = 0;

  private seq = 0;
  private queue: Job[] = [];
  private inFlight: { seq: number; job: Job; cancel: Cancel } | null = null;
  private gen = 0;
  private pollCancel: Cancel | null = null;
  private reconnectCancel: Cancel | null = null;
  private reconnectUntil = 0;
  private pollCount = 0;
  private rawLeft = PeakController.rawLinesPerLink;
  private timeoutsInARow = 0;
  private lastHeartbeat = DISTANT_PAST;
  private heatingAtDrop = false;
  private userClosed = false;

  constructor(private readonly clock: Clock, private readonly logSink: (s: string) => void) {}

  log(s: string) { this.logSink(`PEAK ${s}`); }
  private changed() { this.onChange(); }
  private say(m: string | null) { if (m) this.log(`Notice: ${m}`); this.message = m; this.changed(); }

  // MARK: The read-only view the screens use (same shape as the Switch controller)

  get connected(): boolean { return this.link === "ready"; }
  get linkFresh(): boolean { return this.connected && this.clock.now() - this.lastReplyAt < PeakController.freshFor; }
  get sessionOn(): boolean { return this.connected && isHeatingState(this.state); }
  get canControl(): boolean { return this.linkFresh && this.state !== null; }
  get canHeat(): boolean { return this.canControl && !this.sessionOn && this.startPendingAt === null && this.stopPendingAt === null; }
  get canStop(): boolean { return this.connected && (this.sessionOn || this.startPendingAt !== null); }
  get canBoost(): boolean { return this.canControl && this.state === State.ACTIVE; }
  get canPickProfile(): boolean { return this.canControl && !this.sessionOn && this.startPendingAt === null; }

  get targetC(): number | null {
    if (this.activeTempC !== null) return this.activeTempC;
    const p = this.activeProfile !== null ? this.profiles[this.activeProfile] : undefined;
    return p?.tempC ?? null;
  }
  get profileSeconds(): number | null {
    if (this.activeSeconds !== null) return this.activeSeconds;
    const p = this.activeProfile !== null ? this.profiles[this.activeProfile] : undefined;
    return p?.seconds ?? null;
  }
  get secondsLeft(): number {
    if (this.state === State.ACTIVE && this.total !== null && this.elapsed !== null) return Math.max(0, Math.round(this.total - this.elapsed));
    if (this.state === State.PREHEAT) return Math.round(this.profileSeconds ?? 0);
    return 0;
  }

  /** The Peak in the Switch's status shape. Temps in °F (the Peak reports °C). Profiles 1 to 4 = presets 1 to 4. */
  get live(): LiveStatus | null {
    if (!this.connected || this.state === null) return null;
    return {
      preset: this.activeProfile !== null ? this.activeProfile + 1 : 0,
      lightMode: 1, sessionByte: this.sessionOn ? 170 : 0, autoShutOff: 0, autoShutOffRemaining: 0,
      tempRaw: this.tempC !== null ? Math.round(cToF(this.tempC)) : 0, unitByte: 15,
      sessionTimeRemaining: this.secondsLeft, hapticsByte: 0, sessionExtend: 0,
      battery: this.battery ?? 0, chargingByte: 0, brightness: 0,
    };
  }
  get presets(): PresetInfo[] {
    const out: PresetInfo[] = [{}, {}, {}, {}, {}, {}];
    for (const p of this.profiles) {
      const active = p.n === this.activeProfile;
      const c = active && this.activeTempC !== null ? this.activeTempC : p.tempC;
      const s = active && this.activeSeconds !== null ? this.activeSeconds : p.seconds;
      const info: PresetInfo = {};
      if (c !== null) { info.tempC = Math.round(c); info.tempF = Math.round(cToF(c)); }
      if (s !== null) info.hold = Math.round(s);
      out[p.n + 1] = info;
    }
    return out;
  }
  profileName(n: number): string { return this.profiles[n]?.name || `Profile ${n + 1}`; }
  get phaseText(): string { return stateName(this.state); }

  // MARK: Link

  /** Start with a rig the user picked. */
  take(t: LoraxTransport) {
    this.dropTransport();
    this.transport = t;
    this.userClosed = false;
    this.message = null; this.awayNote = null;
    t.onReply = b => this.onReply(b);
    t.onEvent = b => this.log(`Event (not used yet): ${hex(b)}`);
    t.onDrop = why => this.onDrop(why);
    this.log(`Picked "${t.name ?? "(no name)"}" id ${t.id}. Torchless is not affiliated with Puffco.`);
    this.open("connecting");
  }

  /** The user's UNLINK: stop polling and let go. Never sends a heat command. */
  disconnect() {
    this.log("Unlink tapped.");
    this.userClosed = true;
    this.reconnectCancel?.(); this.reconnectCancel = null;
    this.resetLink();
    this.link = "none";
    this.transport?.close();
    this.changed();
  }

  private dropTransport() {
    if (!this.transport) return;
    this.transport.onReply = null; this.transport.onEvent = null; this.transport.onDrop = null;
    this.transport.close();
    this.transport = null;
    this.resetLink();
  }

  private resetLink() {
    this.gen += 1;
    this.pollCancel?.(); this.pollCancel = null;
    if (this.inFlight) { this.inFlight.cancel(); this.inFlight = null; }
    this.queue = [];
    this.startPendingAt = null; this.stopPendingAt = null;
  }

  private open(as: PeakLink) {
    const t = this.transport;
    if (!t) return;
    this.link = as;
    this.changed();
    const gen = ++this.gen;
    const startedAt = this.clock.now();
    this.log(as === "reconnecting" ? "Reconnecting…" : "Connecting…");
    t.open((err, version) => {
      if (gen !== this.gen || this.transport !== t) return;
      if (err !== null) {
        this.log(`Connect failed after ${(this.clock.now() - startedAt).toFixed(1)} s: ${err}`);
        if (this.link === "reconnecting") { this.scheduleReconnect(); return; }
        this.fail(/encrypt|auth|pair|bond|insufficient|security/i.test(err)
          ? "The Peak wouldn't pair. Put it in pairing mode (its light pulses blue), then LINK IT again."
          : `Couldn't connect to the Peak (${err}). Wake it, keep it close, and LINK IT again.`);
        return;
      }
      if (version && version.length >= 2) this.protocolVersion = version[0] | (version[1] << 8);
      this.log(`Connected in ${(this.clock.now() - startedAt).toFixed(1)} s. Version characteristic: ${version ? hex(version) : "(none)"}`
        + (this.protocolVersion !== null ? ` (Lorax protocol ${this.protocolVersion})` : ""));
      this.rawLeft = PeakController.rawLinesPerLink;
      this.timeoutsInARow = 0;
      this.unlock();
    });
  }

  private fail(msg: string) {
    this.resetLink();
    this.link = "failed";
    this.transport?.close();
    this.say(msg);
  }

  private unlock() {
    this.link = "unlocking";
    this.changed();
    this.request(Op.GET_ACCESS_SEED, [], "login step 1 (seed)", r => {
      if (!r) { this.fail("No answer from the Peak. If it's new to this phone, put it in pairing mode (light pulses blue) and LINK IT again."); return; }
      if (r.status !== 0 || r.payload.length < 16) {
        this.fail(`The Peak refused the login (step 1, status ${r.status}). Update it in Puffco's app, then try again.`);
        return;
      }
      const token = unlockToken(r.payload);
      this.log(`Seed ${hex(r.payload.slice(0, 16))} -> token ${hex(token)}`);
      this.request(Op.UNLOCK_ACCESS, token, "login step 2 (unlock)", r2 => {
        if (!r2) { this.fail("The Peak stopped answering during login. LINK IT again."); return; }
        if (r2.status !== 0) {
          this.fail(`The Peak refused the login (status ${r2.status}). Its firmware may be newer than Torchless knows. Tell Manny the firmware version from the Log.`);
          return;
        }
        this.log("Login OK.");
        this.readEverything();
      });
    });
  }

  private readEverything() {
    this.link = "reading";
    this.changed();
    const reads: [string, string][] = [
      [Path.name, "name"], [Path.firmware, "firmware"], [Path.serial, "serial"], [Path.chamber, "chamber"],
      [Path.dabs, "dabs"], [Path.battery, "battery"], [Path.charging, "charging"], [Path.activeProfile, "activeProfile"],
      [Path.activeTemp, "activeTemp"], [Path.activeTime, "activeTime"],
    ];
    for (let n = 0; n < 4; n++) reads.push([Path.profileName(n), `p${n}.name`], [Path.profileTemp(n), `p${n}.temp`], [Path.profileTime(n), `p${n}.time`]);
    reads.push([Path.state, "state"], [Path.elapsed, "elapsed"], [Path.total, "total"], [Path.heaterTemp, "temp"]);
    let left = reads.length;
    const gen = this.gen;
    for (const [path, key] of reads) {
      this.readPath(path, key, false, () => {
        if (gen !== this.gen) return;
        left -= 1;
        if (left > 0) return;
        this.link = "ready";
        this.lastHeartbeat = DISTANT_PAST;
        this.log(`Ready. ${this.summary()}`);
        this.log(`Profiles: ${this.profiles.map(p => `${p.n + 1} "${p.name ?? "?"}" ${p.tempC !== null ? Math.round(cToF(p.tempC)) + "°F" : "?"} ${p.seconds !== null ? Math.round(p.seconds) + "s" : "?"}`).join(" | ")}`);
        if (this.heatingAtDrop && !this.sessionOn) this.awayNote = "The Peak finished while the link was down. Heat is off.";
        else if (this.heatingAtDrop && this.sessionOn) this.awayNote = "Link is back. The Peak is still on its dab.";
        else this.awayNote = null;
        if (this.heatingAtDrop) this.log(`After the drop: ${this.awayNote}`);
        this.heatingAtDrop = false;
        this.changed();
        this.schedulePoll();
      });
    }
  }

  private onDrop(why: string) {
    const heating = isHeatingState(this.state);
    this.log(`Link lost: ${why}. Peak was ${this.phaseText}${heating ? " (it finishes its dab on its own and turns off)" : ""}.`);
    this.resetLink();
    if (this.userClosed) { this.link = "none"; this.changed(); return; }
    this.heatingAtDrop = heating;
    this.awayNote = heating ? "Link dropped mid-dab. The Peak finishes and turns itself off. Getting it back…" : null;
    this.reconnectUntil = this.clock.now() + PeakController.reconnectFor;
    this.link = "reconnecting";
    this.changed();
    this.scheduleReconnect(0.5);
  }

  private scheduleReconnect(delay = PeakController.reconnectEvery) {
    this.reconnectCancel?.();
    if (this.clock.now() + delay > this.reconnectUntil) {
      this.link = "none";
      this.log("Gave up reconnecting.");
      this.say("Lost the Peak. Tap LINK IT to connect again.");
      return;
    }
    this.link = "reconnecting";
    this.changed();
    this.reconnectCancel = this.clock.after(delay, () => { this.reconnectCancel = null; if (!this.userClosed) this.open("reconnecting"); });
  }

  // MARK: Requests (one at a time; the Peak answers in order)

  private request(op: number, body: number[], what: string, cb: Job["cb"], quiet = false, urgent = false) {
    // CUT IT goes to the front of the line, ahead of any polls waiting.
    if (urgent) this.queue.unshift({ op, body, what, quiet, cb }); else this.queue.push({ op, body, what, quiet, cb });
    this.pump();
  }

  private pump() {
    if (this.inFlight || this.queue.length === 0 || !this.transport) return;
    const job = this.queue.shift()!;
    this.seq = (this.seq + 1) & 0xffff;
    if (this.seq === 0) this.seq = 1;
    const seq = this.seq;
    const bytes = packet(seq, job.op, job.body);
    const gen = this.gen;
    const cancel = this.clock.after(PeakController.replyTimeout, () => {
      if (gen !== this.gen || this.inFlight?.seq !== seq) return;
      this.inFlight = null;
      this.timeoutsInARow += 1;
      this.log(`No answer to #${seq} ${job.what} after ${PeakController.replyTimeout} s (${this.timeoutsInARow} in a row).`);
      job.cb(null);
      this.changed();
      this.pump();
    });
    this.inFlight = { seq, job, cancel };
    if (!job.quiet || this.rawLeft > 0) this.raw(`TX #${seq} ${opName(job.op)} ${job.what}: ${hex(bytes)}`);
    this.transport.send(bytes);
  }

  private raw(line: string) {
    if (this.rawLeft > 0) this.rawLeft -= 1;
    this.log(line);
  }

  private onReply(b: number[]) {
    const r = parseReply(b);
    const f = this.inFlight;
    if (!r) { this.log(`Short reply ignored: ${hex(b)}`); return; }
    if (!f || r.seq !== f.seq) { this.log(`Reply #${r.seq} matches nothing waiting (${hex(b)})`); return; }
    f.cancel();
    this.inFlight = null;
    this.lastReplyAt = this.clock.now();
    this.timeoutsInARow = 0;
    if (!f.job.quiet || this.rawLeft > 0 || r.status !== 0) this.raw(`RX #${r.seq} status ${r.status}: ${hex(r.payload)}`);
    f.job.cb({ status: r.status, payload: r.payload });
    this.changed();
    this.pump();
  }

  private readPath(path: string, key: string, quiet: boolean, done?: () => void) {
    this.request(Op.READ_SHORT, readShortBody(path), `read ${path}`, r => {
      if (r && r.status === 0) this.store(key, path, r.payload, quiet);
      else if (r) this.log(`Read ${path} refused (status ${r.status}).`);
      done?.();
    }, quiet);
  }

  private writePath(path: string, value: number[], what: string, done?: (ok: boolean, status: number | null) => void, urgent = false) {
    this.log(`Write ${path} = ${hex(value)} (${what})`);
    this.request(Op.WRITE_SHORT, writeShortBody(path, value), `write ${path} (${what})`, r => {
      const ok = !!r && r.status === 0;
      this.log(r ? `Write ${path} ${ok ? "OK" : `refused (status ${r.status})`}` : `Write ${path}: no answer`);
      done?.(ok, r ? r.status : null);
    }, false, urgent);
  }

  /** Puts a value where it belongs. Values that don't parse are logged raw, never guessed. */
  private store(key: string, path: string, p: number[], quiet: boolean) {
    const note = (label: string, v: unknown) => { if (!quiet) this.log(`${label}: ${String(v)} (${hex(p)})`); };
    const bad = () => this.log(`Couldn't read ${path}: ${hex(p)} (left as it was)`);
    const m = key.match(/^p(\d)\.(name|temp|time)$/);
    if (m) {
      const prof = this.profiles[Number(m[1])];
      if (m[2] === "name") { prof.name = text(p) || null; note(`Profile ${prof.n + 1} name`, prof.name); }
      else if (m[2] === "temp") { const c = parseTempC(p); if (c === null) bad(); else { prof.tempC = c; note(`Profile ${prof.n + 1} temp °C`, c.toFixed(1)); } }
      else { const s = parseSeconds(p); if (s === null) bad(); else { prof.seconds = s; note(`Profile ${prof.n + 1} time s`, s); } }
      return;
    }
    switch (key) {
      case "name": case "firmware": case "serial": this.info[key] = text(p) || hex(p); note(key, this.info[key]); return;
      case "chamber": this.info.chamber = p.length ? String(p[0]) : "?"; note("chamber type", this.info.chamber); return;
      case "dabs": { const n = parseCount(p); if (n === null) bad(); else { this.info.dabs = String(n); note("dab count", n); } return; }
      case "battery": { const n = parseBattery(p); if (n === null) bad(); else { if (n !== this.battery && quiet) this.log(`Battery ${n}%`); this.battery = n; note("battery %", n); } return; }
      case "charging": { const v = hex(p); if (v !== this.chargeRaw && quiet) this.log(`Charge state raw ${v}`); this.chargeRaw = v; note("charge state (raw)", v); return; }
      case "activeProfile": {
        if (!p.length) { bad(); return; }
        const n = p[0];
        if (n > 3) { bad(); return; }
        if (n !== this.activeProfile && quiet) this.log(`Active profile now ${n + 1} (changed on the Peak)`);
        if (n !== this.activeProfile) { this.activeTempC = null; this.activeSeconds = null; }
        this.activeProfile = n; note("active profile", n + 1);
        return;
      }
      case "activeTemp": { const c = parseTempC(p); if (c === null) bad(); else { if (quiet && this.activeTempC !== null && Math.abs(c - this.activeTempC) > 0.4) this.log(`Active temp now ${Math.round(cToF(c))}°F`); this.activeTempC = c; note("active profile temp °C", c.toFixed(1)); } return; }
      case "activeTime": { const s = parseSeconds(p); if (s === null) bad(); else { this.activeSeconds = s; note("active profile time s", s); } return; }
      case "temp": { const c = parseTempC(p); if (c === null) { if (!quiet || this.rawLeft > 0) bad(); } else { this.tempC = c; note("heater °C", c.toFixed(1)); } return; }
      case "elapsed": { const s = parseSeconds(p); if (s !== null) { this.elapsed = s; note("elapsed s", s); } return; }
      case "total": {
        const s = parseSeconds(p);
        if (s !== null) {
          if (this.total !== null && this.state === State.ACTIVE && s > this.total + 1) this.log(`Session time went up: ${Math.round(this.total)} -> ${Math.round(s)} s (boost)`);
          this.total = s; note("total s", s);
        }
        return;
      }
      case "state": {
        if (!p.length) { bad(); return; }
        const s = p[0];
        if (s !== this.state) this.stateChanged(this.state, s);
        else note("state", `${s} ${stateName(s)}`);
        return;
      }
    }
  }

  private stateChanged(from: number | null, to: number) {
    this.state = to;
    const now = this.clock.now();
    const wasOn = isHeatingState(from), on = isHeatingState(to);
    this.log(`State ${from === null ? "?" : from} ${stateName(from)} -> ${to} ${stateName(to)} · ${this.summary()}`);
    if (on && !wasOn && this.link === "ready") {
      if (this.startPendingAt !== null) {
        this.log(`HEAT IT confirmed in ${(now - this.startPendingAt).toFixed(1)} s.`);
        this.startPendingAt = null;
      } else {
        this.log("Heat started on the Peak itself (its button or another app). Torchless leaves it alone.");
      }
      if (this.message && /didn't start|refused HEAT/.test(this.message)) this.message = null;
    }
    if (!on && wasOn && this.link === "ready") {
      if (this.stopPendingAt !== null) {
        this.log(`CUT IT confirmed in ${(now - this.stopPendingAt).toFixed(1)} s. Heat is off.`);
        this.stopPendingAt = null; this.stopTries = 0;
        if (this.message && /stopped/.test(this.message)) this.message = null;
      } else {
        this.log(`Dab ended on its own (now ${stateName(to)}).`);
      }
      this.awayNote = null;
    }
  }

  private summary(): string {
    const t = this.tempC !== null ? `${Math.round(cToF(this.tempC))}°F` : "?°F";
    const g = this.targetC !== null ? `${Math.round(cToF(this.targetC))}°F` : "?";
    return `${stateName(this.state)}, heater ${t}, goal ${g}, profile ${this.activeProfile !== null ? this.activeProfile + 1 : "?"}, `
      + `${this.secondsLeft} s left (elap ${this.elapsed ?? "?"} / tott ${this.total ?? "?"}), battery ${this.battery ?? "?"}%`;
  }

  // MARK: Polling

  private schedulePoll() {
    this.pollCancel?.();
    const gen = this.gen;
    this.pollCancel = this.clock.after(PeakController.pollEvery, () => {
      if (gen !== this.gen || this.link !== "ready") return;
      this.poll();
      this.schedulePoll();
    });
  }

  private poll() {
    // Don't stack polls behind a slow Peak: skip this round if the last one hasn't drained.
    if (this.queue.length > 6) { this.log(`Poll skipped: ${this.queue.length} requests still waiting.`); return; }
    this.pollCount += 1;
    this.readPath(Path.state, "state", true);
    this.readPath(Path.heaterTemp, "temp", true);
    if (isHeatingState(this.state) || this.stopPendingAt !== null || this.startPendingAt !== null) {
      this.readPath(Path.elapsed, "elapsed", true);
      this.readPath(Path.total, "total", true);
    }
    if (this.pollCount % PeakController.slowEvery === 0) {
      this.readPath(Path.battery, "battery", true);
      this.readPath(Path.charging, "charging", true);
      this.readPath(Path.activeProfile, "activeProfile", true);
      if (!this.sessionOn) { this.readPath(Path.activeTemp, "activeTemp", true); this.readPath(Path.activeTime, "activeTime", true); }
    }
    const now = this.clock.now();
    if (now - this.lastHeartbeat >= (this.sessionOn ? 5 : 30)) { this.lastHeartbeat = now; this.log(`Now: ${this.summary()}`); }
  }

  // MARK: Commands

  heatIt() {
    if (!this.canHeat) { this.log(`HEAT IT ignored (link ${this.link}, fresh ${this.linkFresh}, state ${this.phaseText}).`); return; }
    this.message = null;
    if (this.battery !== null && this.battery < 10) this.log(`Battery is ${this.battery}%: the Peak may refuse to heat.`);
    this.startPendingAt = this.clock.now();
    this.log(`HEAT IT tapped. ${this.summary()}`);
    const gen = this.gen;
    this.writePath(Path.modeCommand, [Mode.HEAT_START], "start heat cycle", (ok, status) => {
      if (gen !== this.gen) return;
      if (!ok && this.startPendingAt !== null && !this.sessionOn) {
        this.startPendingAt = null;
        this.say(status === null ? "The Peak didn't answer HEAT IT. Try again." : `The Peak refused HEAT IT (status ${status}).${this.battery !== null && this.battery < 15 ? " Battery may be too low." : ""}`);
      }
    });
    this.clock.after(PeakController.startConfirm, () => {
      if (gen !== this.gen || this.startPendingAt === null) return;
      this.startPendingAt = null;
      this.say("The Peak didn't start heating. Wake it with one tap of its button, check the battery, and try again.");
    });
    this.changed();
  }

  cutIt() {
    if (!this.connected) { this.log("CUT IT with no link: nothing sent. The Peak ends its own cycle."); return; }
    this.log(`CUT IT tapped. ${this.summary()}`);
    this.startPendingAt = null;
    this.stopPendingAt = this.clock.now();
    this.stopTries = 0;
    this.sendStop();
  }

  private sendStop() {
    const gen = this.gen;
    this.stopTries += 1;
    this.writePath(Path.modeCommand, [Mode.HEAT_ABORT], `stop heat cycle (try ${this.stopTries})`, undefined, true);
    this.readPath(Path.state, "state", true);
    this.clock.after(PeakController.stopConfirm, () => {
      if (gen !== this.gen || this.stopPendingAt === null) return;
      if (!isHeatingState(this.state)) { this.log("CUT IT: the Peak is not heating."); this.stopPendingAt = null; this.changed(); return; }
      if (this.stopTries < 2) { this.log("CUT IT not confirmed after 3 s. Sending it again."); this.sendStop(); return; }
      this.stopPendingAt = null;
      this.say("Couldn't confirm the Peak stopped. Press its button to stop it.");
    });
    this.changed();
  }

  boost() {
    if (!this.canBoost) { this.log(`Boost ignored (state ${this.phaseText}).`); return; }
    this.log(`+ BOOST tapped. ${this.summary()}`);
    this.writePath(Path.modeCommand, [Mode.HEAT_BOOST], "boost");
  }

  selectProfile(n: number) {
    if (n < 0 || n > 3) return;
    if (!this.canPickProfile) { this.log(`Profile ${n + 1} ignored (state ${this.phaseText}).`); return; }
    this.log(`Profile ${n + 1} tapped.`);
    this.writePath(Path.activeProfile, [n], `pick profile ${n + 1}`, ok => {
      if (!ok) { this.say(`The Peak didn't take profile ${n + 1}.`); return; }
      this.readPath(Path.activeProfile, "activeProfile", false);
      this.readPath(Path.activeTemp, "activeTemp", false);
      this.readPath(Path.activeTime, "activeTime", false);
    });
  }

  /** Lines for the Log's header, so a pasted log says what rig it came from. */
  headerLines(): string[] {
    return [
      `Rig: Puffco Peak (Lorax protocol ${this.protocolVersion ?? "?"})`,
      `Peak name: ${this.info.name ?? "?"} · firmware ${this.info.firmware ?? "?"} · serial ${this.info.serial ?? "?"} · chamber ${this.info.chamber ?? "?"} · dabs ${this.info.dabs ?? "?"}`,
      `Link: ${this.link}`,
    ];
  }
}
