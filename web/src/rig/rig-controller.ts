// Port of RigController.swift: the heat logic, write queue, safety cut, away rule, presets, light show
// and ride-the-dial test. Keep it line for line with the Swift file; the shared bench checks both.

import { Clock, Cancel, DISTANT_PAST } from "./clock";
import { Store } from "./storage";
import { LiveStatus, decodeFrame, hapticsOf } from "./frames";
import type { BLEManager } from "./ble-manager";

// MARK: Light modes

export interface LightMode { id: number; name: string }

export const LightModes = {
  basic: [{ id: 0, name: "Stealth" }, { id: 1, name: "Calm" }] as LightMode[],
  solid: [
    { id: 2, name: "Purple" }, { id: 3, name: "Blue" }, { id: 4, name: "Cyan" }, { id: 5, name: "Green" },
    { id: 6, name: "Yellow" }, { id: 7, name: "Orange" }, { id: 8, name: "Red" }, { id: 9, name: "Pink" },
  ] as LightMode[],
  themes: [
    { id: 10, name: "Cali Sunset" }, { id: 11, name: "Purple Haze" }, { id: 12, name: "Northern Lights" },
    { id: 13, name: "Vegas Nights" }, { id: 14, name: "Blue Dream" }, { id: 15, name: "Strawberry Cough" },
    { id: 16, name: "Florida Groves" }, { id: 17, name: "Lime Light" }, { id: 24, name: "Blue Cheese" },
    { id: 25, name: "Golden Goat" }, { id: 26, name: "Grape Ape" }, { id: 27, name: "Miami Vice" },
    { id: 28, name: "Purple Urkle" },
  ] as LightMode[],
  seasonal: [
    { id: 29, name: "Candy Corn" }, { id: 30, name: "Redrum" }, { id: 31, name: "Skull & Bones" },
    { id: 32, name: "Witches Brew" }, { id: 33, name: "Jack-O-Lantern" },
  ] as LightMode[],
  get all(): LightMode[] { return [...this.basic, ...this.solid, ...this.themes, ...this.seasonal]; },
  /** Modes this app offers (18 to 23 have no name and are never offered). */
  isOffered(m: number): boolean { return this.all.some(x => x.id === m); },
  name(m: number): string { return this.all.find(x => x.id === m)?.name ?? `Mode ${m}`; },
};

// MARK: Heat profiles and limits

export const HeatProfile = {
  /** Custom (241) is deliberately not writable. */
  writable: [
    { id: 161, name: "Steady" }, { id: 177, name: "Ascent" }, { id: 193, name: "Descent" },
    { id: 209, name: "Valley" }, { id: 225, name: "Hill" },
  ] as LightMode[],
  isWritable(b: number): boolean { return this.writable.some(x => x.id === b); },
  name(b: number): string {
    if (b === 241) return "Custom";
    return this.writable.find(x => x.id === b)?.name ?? `Unknown (${b})`;
  },
};

const inRange = (v: number, lo: number, hi: number) => v >= lo && v <= hi;

export const RigLimits = {
  tempF: [250, 650] as const,
  tempC: [121, 343] as const,
  hold: [10, 90] as const,
  brightness: [0, 100] as const,
  extend: [0, 9] as const,
  maxTotalHold: 90,
  celsius(f: number): number { return swiftRound((f - 32) * 5 / 9); },
};

/** Swift's .rounded(): halves away from zero. */
export function swiftRound(x: number): number { return x < 0 ? -Math.round(-x) : Math.round(x); }

// MARK: The one 0xB9 frame builder

export interface B9Fields {
  preset: number; lightMode: number; autoShutOff: number; unitByte: number;
  haptics: boolean; extend: number; brightness: number;
}

export type SessionIntent = "echo" | "start" | "stop";

export const RigFrames = {
  /** The ONLY place a 0xB9 frame is assembled. Session byte (index 10):
   *  start -> 170, stop -> 0, echo -> 170 only if the latest status showed a session running, else 0. */
  b9(f: B9Fields, session: SessionIntent, liveSessionByte: number): number[] | null {
    const values = [f.preset, f.lightMode, f.autoShutOff, f.unitByte, f.extend, f.brightness];
    if (!values.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) return null;
    // A Stop is never refused because the rig reported an odd-looking setting: it copies the rig's own
    // values straight back. Everything else has to be inside the known limits.
    if (session !== "stop") {
      if (!(inRange(f.preset, 0, 5) && inRange(f.lightMode, 0, 33) && inRange(f.brightness, 0, 100)
        && inRange(f.extend, 0, 9) && inRange(f.autoShutOff, 0, 60) && (f.unitByte === 15 || f.unitByte === 12))) return null;
    }
    const sessionByte = session === "start" ? 170 : session === "stop" ? 0 : liveSessionByte > 0 ? 170 : 0;
    return [185, 20, 0, f.preset, 0, 0, f.lightMode, 0, f.autoShutOff, f.unitByte, sessionByte,
      f.haptics ? 170 : 0, f.extend, f.brightness, 0, 0, 0, 0, 0, 185];
  },
};

export interface B9Change { preset?: number; lightMode?: number; brightness?: number; haptics?: boolean; extendPlusOne?: boolean }

// MARK: Presets and light show models

export interface PresetInfo {
  tempF?: number; tempC?: number; hold?: number; profile?: number;
  custom170?: number[]; custom171?: number[];
}

export interface CurveStep { t: number; f: number }

export interface ShowStep { id: string; atStart: boolean; secondsRemaining: number; lightMode: number; brightness: number }

export interface LightShow {
  steps: ShowStep[];
  flashEnabled: boolean; flashSeconds: number; flashHigh: number; flashLow: number;
}

let stepSeq = 0;
export const newStepID = () => `step-${Date.now().toString(36)}-${(stepSeq++).toString(36)}`;

export function defaultShow(): LightShow {
  return {
    steps: [
      { id: newStepID(), atStart: true, secondsRemaining: 0, lightMode: 3, brightness: 70 },
      { id: newStepID(), atStart: false, secondsRemaining: 30, lightMode: 10, brightness: 80 },
      { id: newStepID(), atStart: false, secondsRemaining: 10, lightMode: 8, brightness: 100 },
    ],
    flashEnabled: true, flashSeconds: 10, flashHigh: 100, flashLow: 20,
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export function sanitizeShow(s: LightShow): LightShow {
  return {
    steps: s.steps.slice(0, 6).map(st => ({
      id: st.id || newStepID(),
      atStart: !!st.atStart,
      secondsRemaining: clamp(st.secondsRemaining, 5, 90),
      brightness: clamp(st.brightness, 0, 100),
      lightMode: LightModes.isOffered(st.lightMode) ? st.lightMode : 3,
    })),
    flashEnabled: !!s.flashEnabled,
    flashSeconds: clamp(s.flashSeconds, 5, 30),
    flashHigh: clamp(s.flashHigh, 0, 100),
    flashLow: clamp(s.flashLow, 0, 100),
  };
}

// MARK: Write queue item

type WriteKind = { t: "b9"; change: B9Change; intent: SessionIntent } | { t: "raw"; bytes: number[] };

interface WriteItem {
  label: string;
  kind: WriteKind;
  gapBefore: number;
  requireSessionOn: boolean;
  requireSessionOff: boolean;
  onSent?: () => void;
  onDrop?: () => void;
  deferredSince: number | null;
  auto: boolean;
  born: number;
}

export type DialMode = "live" | "active";   // A: 0xB3 for slot 0 / B: 0xB3 for the active preset

type FireResult = "sent" | "dropped" | "deferred";

const emptyPresets = (): PresetInfo[] => Array.from({ length: 6 }, () => ({}));

// MARK: Controller

export class RigController {
  ble: BLEManager | null = null;
  onChange: (() => void) | null = null;

  // Live data
  live: LiveStatus | null = null;
  liveTime: number | null = null;
  linkFresh = false;
  presets: PresetInfo[] = emptyPresets();
  message: string | null = null;
  startPendingAt: number | null = null;
  previewing = false;
  flashing = false;

  // Away handling. The rule: never cut the dab that is running. Once it finishes, make sure heat is off.
  awayNote: string | null = null;
  disconnectWaiting = false;

  // Ride-the-dial test state
  static readonly dialStep = 5;
  dialMode: DialMode = "active";
  dialStart: number | null = null;
  dialCurrent: number | null = null;
  dialReadout = "No nudge yet";
  dialNumbers = "";

  private _show: LightShow;
  private _showEnabled: boolean;

  // Timings (plain fields so the bench can shorten them)
  parkAfterQuiet = 60;
  stuckAfterZero = 8;
  maxAwaySession = 300;

  // Queue
  private queue: WriteItem[] = [];
  private pumping = false;
  private gen = 0;
  private lastSend = DISTANT_PAST;
  private holdUntil = DISTANT_PAST;
  private waitingForStatus = false;
  private carry: { fields: B9Fields; time: number } | null = null;
  private stopPendingAt: number | null = null;
  private stopRetryToken = 0;
  private brightnessDebounce: Cancel | null = null;
  private messageToken = 0;

  // Watching for heat that came back on by accident
  private lastStartSentAt = DISTANT_PAST;
  private lastEchoOnAt = DISTANT_PAST;
  private lastEchoOnRemaining = 0;
  private lastEchoOnExtend = 0;
  private lastEchoOnCounting = false;
  private lastExtendSentAt = DISTANT_PAST;

  // Away private state
  private inBackground = false;
  private linkLostAt: number | null = null;
  private zeroSince: number | null = null;
  private lastAwayCutAt = DISTANT_PAST;
  private quietSince: number | null = null;

  // Ride-the-dial private state
  private dialStartPreset = 0;
  private dialLastTap = DISTANT_PAST;
  private dialTouched = new Set<number>();
  private dialRestoreQueued = new Set<number>();
  private dialSamples: { time: number; f: number }[] = [];
  private dialNudgeAt: number | null = null;
  private dialNudgeBase = 0;
  private dialBeforeSteady = false;
  private dialNudgeDir = 1;
  private dialNudgeTarget = 0;
  private dialBeforeSlope = 0;
  private dialWatchUntil = DISTANT_PAST;
  private dialLastB3 = -1;
  private _dialPending = new Map<number, number>();

  // Session tracking
  private prevOn = false;
  private sessionStartDate: number | null = null;
  private sessionPeakF = 0;
  private countdownSeen = false;
  private peakRemaining = 0;
  private counting = false;

  // Light show state
  private preSession: { mode: number; brightness: number } | null = null;
  private restoreTarget: { mode: number; brightness: number } | null = null;
  private _pendingRestore: { mode: number; brightness: number } | null = null;
  private restoreQueued = false;
  private lastRestoreTryAt = DISTANT_PAST;
  private restoreSentAt = DISTANT_PAST;
  private showRan = false;
  private appliedStepID: string | null = null;
  private flashHighPhase = false;
  private flashTicks = 0;
  private previewToken = 0;

  constructor(readonly clock: Clock, readonly store: Store) {
    const saved = store.get<LightShow>("lightShowV1");
    this._show = saved ? sanitizeShow(saved) : defaultShow();
    this._showEnabled = store.get<boolean>("lightShowEnabled") === true;
    const dp = store.get<Record<string, number>>("dialPendingV1");
    if (dp && typeof dp === "object") {
      const loaded = new Map<number, number>();
      for (const [k, v] of Object.entries(dp)) {
        const slot = Number(k);
        if (Number.isInteger(slot) && inRange(slot, 0, 5) && Number.isInteger(v) && inRange(v, 0, 65535)) loaded.set(slot, v);
      }
      this.dialPending = loaded;
    }
    const lr = store.get<number[]>("lightRestoreV1");
    if (Array.isArray(lr) && lr.length === 2 && inRange(lr[0], 0, 33) && inRange(lr[1], 0, 100)) {
      this.pendingRestore = { mode: lr[0], brightness: lr[1] };
    }
    this.watchdog();
  }

  // Persisted properties

  get show(): LightShow { return this._show; }
  set show(s: LightShow) { this._show = s; this.store.set("lightShowV1", s); this.changed(); }
  get showEnabled(): boolean { return this._showEnabled; }
  set showEnabled(v: boolean) {
    this._showEnabled = v;
    this.store.set("lightShowEnabled", v);
    if (!v) this.stopFlash();
    this.changed();
  }
  private get dialPending(): Map<number, number> { return this._dialPending; }
  private set dialPending(m: Map<number, number>) { this._dialPending = m; this.saveDialPending(); }
  private saveDialPending() {
    const out: Record<string, number> = {};
    for (const [k, v] of this._dialPending) out[String(k)] = v;
    this.store.set("dialPendingV1", out);
  }
  private get pendingRestore() { return this._pendingRestore; }
  private set pendingRestore(r: { mode: number; brightness: number } | null) {
    this._pendingRestore = r;
    if (r) this.store.set("lightRestoreV1", [r.mode, r.brightness]);
    else this.store.remove("lightRestoreV1");
  }

  attach(b: BLEManager) {
    this.ble = b;
    b.rig = this;
  }

  private changed() { this.onChange?.(); }
  private log(t: string) { this.ble?.log(t); }
  private now() { return this.clock.now(); }

  private say(t: string) {
    this.message = t;
    this.log(`NOTICE: ${t}`);
    this.messageToken += 1;
    const tok = this.messageToken;
    this.clock.after(6.0, () => {
      if (this.messageToken !== tok) return;
      this.message = null;
      this.changed();
    });
  }

  private watchdog() {
    this.clock.after(1.0, () => {
      this.watchdogTick();
      this.watchdog();
    });
  }

  private watchdogTick() {
    const now = this.now();
    const fresh = this.liveTime !== null ? now - this.liveTime <= 3.0 : false;
    if (this.linkFresh !== fresh) { this.linkFresh = fresh; this.changed(); }
    if (this.startPendingAt !== null && now - this.startPendingAt > 3.0) this.startPendingAt = null;

    if (this.waitingForStatus && this.queue.length > 0 && this.liveTime !== null && now - this.liveTime > 1.0) {
      this.waitingForStatus = false;
      this.pump();
    }

    const quiet = this.connected && !this.sessionOn && this.startPendingAt === null && this.queue.length === 0 && !this.pumping && !this.previewing;
    if (!quiet) {
      this.quietSince = null;
      return;
    }
    if (this.quietSince === null) this.quietSince = now;
    const quietFor = now - this.quietSince;
    if (this.disconnectWaiting && quietFor >= 2.0) {
      this.disconnectWaiting = false;
      this.log("Dab is done and everything is put back. Disconnecting now, as asked.");
      this.ble?.disconnect();
    } else if (this.inBackground && quietFor >= this.parkAfterQuiet) {
      this.quietSince = null;
      this.log("APP: left idle in the background. Letting go of the rig until you come back.");
      this.ble?.parkForBackground();
    }
  }

  // MARK: Derived

  get connected(): boolean { return this.ble?.isConnected ?? false; }
  get sessionOn(): boolean { return (this.live?.sessionByte ?? 0) > 0; }
  get canControl(): boolean { return this.connected && this.linkFresh && this.live !== null; }
  get canHeat(): boolean { return this.canControl && !this.sessionOn && this.startPendingAt === null && !this.previewing; }
  get canPreview(): boolean { return this.canControl && !this.sessionOn && !this.previewing && this.startPendingAt === null; }

  get heldHoldSeconds(): number | undefined {
    const s = this.live;
    if (!s || !inRange(s.preset, 0, 5)) return undefined;
    return this.presets[s.preset].hold;
  }

  get canExtend(): boolean {
    const s = this.live;
    const hold = this.heldHoldSeconds;
    if (!this.canControl || !s || s.sessionByte <= 0 || hold === undefined) return false;
    if (this.countdownSeen && s.sessionTimeRemaining <= 3) return false;
    const n = s.sessionExtend + 1;
    return n <= RigLimits.extend[1] && hold + 10 * n <= RigLimits.maxTotalHold;
  }

  private get linkRecovering(): boolean {
    return this.linkLostAt !== null && this.now() - this.linkLostAt < 600;
  }

  /** Nobody is at the controls: app in the background, link just recovered, or a disconnect is waiting. */
  private get away(): boolean { return this.inBackground || this.disconnectWaiting || this.linkRecovering; }

  // MARK: Incoming frames

  private u16(b: number[], i: number): number | null { return i + 1 < b.length ? (b[i] << 8) | b[i + 1] : null; }

  handle(b: number[]) {
    if (b.length === 0) return;
    const cmd = b[0];
    switch (cmd) {
      case 169: {
        const d = decodeFrame(b);
        if (d.kind === "status") this.onLive(d.status);
        break;
      }
      case 163: {
        const f = this.u16(b, 3), c = this.u16(b, 5);
        if (b.length >= 7 && b[2] <= 5 && f !== null && c !== null) {
          this.presets[b[2]].tempF = f;
          this.presets[b[2]].tempC = c;
          if (this.now() < this.dialWatchUntil || this.dialTouched.size > 0) {
            this.log(`DIAL TEST 163 report: slot ${b[2]} = ${f} F / ${c} C`);
          }
        }
        break;
      }
      case 165:
        if (b.length >= 4 && b[2] <= 5) this.presets[b[2]].profile = b[3];
        break;
      case 167: {
        const sec = this.u16(b, 3);
        if (b.length >= 5 && b[2] <= 5 && sec !== null) this.presets[b[2]].hold = sec;
        break;
      }
      case 170:
        if (b.length >= 3 && b[2] <= 5) this.presets[b[2]].custom170 = b;
        break;
      case 171:
        if (b.length >= 3 && b[2] <= 5) this.presets[b[2]].custom171 = b;
        break;
    }
    this.changed();
  }

  connectionChanged(isUp: boolean) {
    if (isUp) {
      this.presets = emptyPresets();
      this.changed();
      return;
    }
    const wasHeating = this.prevOn || this.startPendingAt !== null;
    if (this.prevOn && this.sessionStartDate !== null) {
      this.log(`SESSION END duration=${(this.now() - this.sessionStartDate).toFixed(0)} peak=${this.sessionPeakF} (link lost)`);
    }
    if (wasHeating) {
      this.linkLostAt = this.now();
      this.log("AWAY: lost the rig mid-dab. The rig finishes the dab on its own timer. When the link is back, the app makes sure heat is off.");
    }
    this.sessionStartDate = null;
    if (this.dialPending.size > 0) {
      this.log(`DIAL TEST: link lost with changed temps still to put back (slots [${[...this.dialPending.keys()].sort((a, b) => a - b).join(", ")}]). Will restore when a status shows no session.`);
    }
    const r = this.pendingRestore;
    if (r) this.log(`Lights still to put back (mode ${r.mode}, brightness ${r.brightness}). Will do it when a status shows no session.`);
    this.dialStart = null;
    this.dialCurrent = null;
    this.dialTouched.clear();
    this.dialRestoreQueued.clear();
    this.dialNudgeAt = null;
    this.dialSamples = [];
    this.dialReadout = "No nudge yet";
    this.dialNumbers = "";
    this.gen += 1;
    this.queue = [];
    this.pumping = false;
    this.waitingForStatus = false;
    this.stopRetryToken += 1;
    this.brightnessDebounce?.();
    this.stopFlash();
    this.restoreQueued = false;
    this.live = null;
    this.liveTime = null;
    this.linkFresh = false;
    this.prevOn = false;
    this.countdownSeen = false;
    this.counting = false;
    this.peakRemaining = 0;
    this.zeroSince = null;
    this.carry = null;
    this.startPendingAt = null;
    this.stopPendingAt = null;
    this.previewing = false;
    this.previewToken += 1;
    this.disconnectWaiting = false;
    this.quietSince = null;
    this.changed();
  }

  private onLive(s: LiveStatus) {
    const now = this.now();
    const wasOn = this.prevOn;
    const on = s.sessionByte > 0;
    this.live = s;
    this.liveTime = now;
    if (!this.linkFresh) this.linkFresh = true;
    if (on) this.startPendingAt = null;
    if (!on) {
      this.stopPendingAt = null;
      this.stopRetryToken += 1;
    }

    // Heat that came on right after one of our "session on" echoes, with no HEAT IT tap, is an accident.
    let accident: string | null = null;
    if (on && !wasOn && now - this.lastEchoOnAt < 1.5 && now - this.lastStartSentAt > 5.0) {
      accident = "a session started right after a light or time change, with no HEAT IT tap";
    }
    if (on && wasOn && this.lastEchoOnCounting && now - this.lastEchoOnAt < 1.2
      && now - this.lastExtendSentAt > 3.0 && s.sessionExtend === this.lastEchoOnExtend
      && s.sessionTimeRemaining >= this.lastEchoOnRemaining + 3) {
      accident = `the countdown jumped back up (${this.lastEchoOnRemaining} s to ${s.sessionTimeRemaining} s) right after a light change`;
    }

    if (on && !wasOn) this.sessionBegan();
    if (!on && wasOn) this.sessionEnded();
    this.prevOn = on;

    if (on) {
      if (s.sessionTimeRemaining > 0) this.countdownSeen = true;
      if (s.sessionTimeRemaining > this.peakRemaining) this.peakRemaining = s.sessionTimeRemaining;
      if (s.sessionTimeRemaining < this.peakRemaining) this.counting = true;
      this.curveTick(s);
      if (accident !== null) {
        this.safetyCut(accident);
      } else {
        this.dialTick(s);
        this.showTick(s);
        this.awayTick(s, now);
      }
    } else {
      this.countdownSeen = false;
      this.counting = false;
      this.peakRemaining = 0;
      this.zeroSince = null;
      if (this.pendingRestore === null && now - this.restoreSentAt > 1.0) {
        this.preSession = { mode: s.lightMode, brightness: s.brightness };
      }
      this.idleTick(now);
    }

    if (this.waitingForStatus) {
      this.waitingForStatus = false;
      this.pump();
    }
    this.changed();
  }

  private idleTick(now: number) {
    this.tryOwedRestore(now);
    this.dialRestorePending();
    if (this.linkLostAt !== null) {
      const recent = this.linkRecovering;
      this.linkLostAt = null;
      if (recent) this.confirmOff("the link dropped mid-dab and is back now, with nothing heating");
    }
  }

  // MARK: Gate

  private gate(allowStale = false, quiet = false): LiveStatus | null {
    let problem: string | null = null;
    let result: LiveStatus | null = null;
    const b = this.ble;
    if (b && b.isConnected) {
      if (b.fec1Ready) {
        if (this.live && this.liveTime !== null) {
          if (!allowStale && this.now() - this.liveTime > 3.0) {
            problem = "Status from the rig is older than 3 seconds. Wait for it to come back.";
          } else {
            result = this.live;
          }
        } else {
          problem = "No status from the rig yet. Wait a second.";
        }
      } else {
        problem = "The rig's control channel (FEC1) was not found.";
      }
    } else {
      problem = "Not connected to the rig.";
    }
    if (problem !== null) {
      if (quiet) this.log(`Not sent: ${problem}`); else this.say(problem);
    }
    return result;
  }

  // MARK: Queue

  private item(p: Partial<WriteItem> & { label: string; kind: WriteKind }): WriteItem {
    return {
      gapBefore: 0.12, requireSessionOn: false, requireSessionOff: false, deferredSince: null, auto: false,
      born: this.now(), ...p,
    };
  }

  private enqueue(item: WriteItem) {
    if (this.gate(false, item.auto) === null) { item.onDrop?.(); return; }
    this.queue.push(item);
    this.pump();
  }

  private pump() {
    if (this.pumping || this.queue.length === 0) return;
    const first = this.queue[0];
    this.pumping = true;
    const g = this.gen;
    const since = this.now() - this.lastSend;
    const hold = this.holdUntil - this.now();
    const wait = Math.max(0, Math.max(first.gapBefore - since, hold));
    this.clock.after(wait, () => {
      if (this.gen !== g) return;
      this.pumping = false;
      if (this.queue.length === 0) return;
      const item = this.queue.shift()!;
      const result = this.fire(item);
      if (result === "deferred") {
        if (item.deferredSince === null) item.deferredSince = this.now();
        this.queue.unshift(item);
        if (this.waitingForStatus) return;
        this.holdUntil = this.now() + 0.25;
      }
      this.pump();
      this.changed();
    });
  }

  private isStopItem(it: WriteItem) { return it.kind.t === "b9" && it.kind.intent === "stop"; }
  private isStartItem(it: WriteItem) { return it.kind.t === "b9" && it.kind.intent === "start"; }

  private effectiveFields(s: LiveStatus): B9Fields {
    if (this.carry && this.now() - this.carry.time < 1.5) return { ...this.carry.fields };
    return {
      preset: s.preset, lightMode: s.lightMode, autoShutOff: s.autoShutOff, unitByte: s.unitByte,
      haptics: hapticsOf(s), extend: s.sessionExtend, brightness: s.brightness,
    };
  }

  private fire(item: WriteItem): FireResult {
    const isStop = this.isStopItem(item);
    const s = this.gate(isStop, item.auto);
    if (s === null) { item.onDrop?.(); return "dropped"; }
    if (item.requireSessionOn && s.sessionByte === 0) {
      this.log(`Dropped [${item.label}]: session is not on.`);
      item.onDrop?.();
      return "dropped";
    }
    if (item.requireSessionOff && s.sessionByte > 0) {
      if (item.auto) this.log(`Dropped [${item.label}]: the rig is heating.`);
      else this.say("That only works when the rig is not heating.");
      item.onDrop?.();
      return "dropped";
    }
    // HEAT IT goes out promptly or not at all.
    if (this.isStartItem(item) && this.now() - item.born > 5.0) {
      this.say("HEAT IT waited too long behind other changes. Tap it again.");
      item.onDrop?.();
      return "dropped";
    }
    if (item.deferredSince !== null && this.now() - item.deferredSince > 5.0) {
      this.log(`Dropped [${item.label}]: waited over 5 s for the rig's status to settle.`);
      item.onDrop?.();
      return "dropped";
    }
    // Echo writes into a running session carry "session on" (170). Two guards keep the restart window small.
    if (item.kind.t === "b9" && item.kind.intent === "echo" && s.sessionByte > 0) {
      if (this.countdownSeen && s.sessionTimeRemaining <= 3) {
        if (item.requireSessionOn) {
          if (item.auto) this.log(`Dropped [${item.label}]: session is in its last 3 seconds.`);
          else this.say("Too late for that: the dab is in its last 3 seconds.");
          item.onDrop?.();
          return "dropped";
        }
        return "deferred";
      }
      if (this.liveTime !== null && this.now() - this.liveTime > 0.2) {
        this.waitingForStatus = true;
        return "deferred";
      }
    }
    // A Start or Stop is in flight and the status has not caught up: wait, so an echo can never undo it.
    if (!isStop && !this.isStartItem(item)) {
      if (this.startPendingAt !== null && this.now() - this.startPendingAt < 3.0 && s.sessionByte === 0) return "deferred";
      if (this.stopPendingAt !== null && this.now() - this.stopPendingAt < 3.0 && s.sessionByte > 0) return "deferred";
    }

    if (item.kind.t === "raw") {
      if (this.ble?.transmit(item.kind.bytes, item.label) !== true) { item.onDrop?.(); return "dropped"; }
      this.lastSend = this.now();
      item.onSent?.();
      return "sent";
    }

    const { change, intent } = item.kind;
    const f = this.effectiveFields(s);
    // Extra time belongs to the dab that is running. With heat off there is none, and a new dab starts at
    // 0, so a value from a frame sent a moment ago must not ride along. (Real rig, 2026-11-11: the
    // Restore lights frame after a +10 s dab still carried extend 1.)
    if (s.sessionByte === 0) f.extend = 0;
    if (change.preset !== undefined) f.preset = change.preset;
    if (change.lightMode !== undefined) f.lightMode = change.lightMode;
    if (change.brightness !== undefined) f.brightness = change.brightness;
    if (change.haptics !== undefined) f.haptics = change.haptics;
    if (change.extendPlusOne) {
      const n = f.extend + 1;
      const hold = this.presets[clamp(f.preset, 0, 5)].hold;
      if (hold === undefined || n > RigLimits.extend[1] || hold + 10 * n > RigLimits.maxTotalHold) {
        this.say("Can't add more time: hold plus extra can't go past 90 s.");
        item.onDrop?.();
        return "dropped";
      }
      f.extend = n;
    }
    if (intent === "start") {
      if (s.sessionByte !== 0) { this.say("Already heating."); item.onDrop?.(); return "dropped"; }
      if (!inRange(f.preset, 1, 5)) { this.say("Pick preset 1 to 5 first."); item.onDrop?.(); return "dropped"; }
    }
    const frame = RigFrames.b9(f, intent, s.sessionByte);
    if (frame === null) {
      this.say("Rig state looked odd (value out of range), so nothing was sent.");
      item.onDrop?.();
      return "dropped";
    }
    if (this.ble?.transmit(frame, item.label) !== true) { item.onDrop?.(); return "dropped"; }
    const now = this.now();
    this.lastSend = now;
    this.carry = { fields: f, time: now };
    if (intent === "start") {
      this.startPendingAt = now;
      this.stopPendingAt = null;
      this.lastStartSentAt = now;
    } else if (intent === "stop") {
      this.stopPendingAt = now;
      this.startPendingAt = null;
    } else if (s.sessionByte > 0) {
      this.lastEchoOnAt = now;
      this.lastEchoOnRemaining = s.sessionTimeRemaining;
      this.lastEchoOnExtend = f.extend;
      this.lastEchoOnCounting = this.counting;
      if (change.extendPlusOne) this.lastExtendSentAt = now;
    }
    item.onSent?.();
    return "sent";
  }

  // MARK: Actions: heat

  /** The ONLY call site that can send a session byte of 170 via start. */
  heatIt() {
    const s = this.gate();
    if (s === null) return;
    if (s.sessionByte !== 0) { this.say("Already heating."); return; }
    if (this.startPendingAt !== null) return;
    if (this.queue.some(it => this.isStartItem(it))) return;
    if (this.previewing) { this.say("Wait for the light preview to finish."); return; }
    if (inRange(s.preset, 1, 5)) {
      const t = this.presets[s.preset].tempF;
      if (t !== undefined && !inRange(t, RigLimits.tempF[0], RigLimits.tempF[1])) {
        this.say(`Preset ${s.preset} is set to ${t} F. This app only heats 250 to 650 F. Edit the preset first.`);
        return;
      }
    }
    this.log("HEAT IT tapped.");
    this.awayNote = null;
    this.enqueue(this.item({ label: "HEAT IT (start, session 170)", kind: { t: "b9", change: {}, intent: "start" }, requireSessionOff: true }));
  }

  /** CUT IT: drops everything waiting and sends Stop. */
  cutIt() {
    this.log("CUT IT tapped.");
    this.sendStop("CUT IT (stop, session 0)", true);
  }

  /** The ONLY place a Stop is created. A Stop jumps the queue, is never held back, and is resent if needed. */
  private sendStop(label: string, clearQueue: boolean, attempt = 0) {
    if (clearQueue) {
      const dropped = this.queue;
      this.queue = [];
      for (const it of dropped) it.onDrop?.();
      this.brightnessDebounce?.();
      this.stopFlash();
      this.previewToken += 1;
      this.previewing = false;
    }
    this.gen += 1;
    this.pumping = false;
    this.waitingForStatus = false;
    this.holdUntil = DISTANT_PAST;
    const heating = this.sessionOn;
    const shown = attempt === 0 ? label : `${label}, try ${attempt + 1}`;
    const it = this.item({ label: shown, kind: { t: "b9", change: {}, intent: "stop" }, gapBefore: 0.1 });
    it.onSent = () => {
      if (!heating || attempt >= 2) return;
      this.armStopRetry(label, attempt);
    };
    this.queue.unshift(it);
    this.pump();
  }

  private armStopRetry(label: string, attempt: number) {
    this.stopRetryToken += 1;
    const tok = this.stopRetryToken;
    this.clock.after(1.5, () => {
      if (this.stopRetryToken !== tok) return;
      const s = this.live;
      if (!this.connected || !s || s.sessionByte <= 0) return;
      this.log("Stop did not take after 1.5 s (rig still shows heating). Sending it again.");
      this.sendStop(label, false, attempt + 1);
    });
  }

  private safetyCut(why: string) {
    this.log(`SAFETY CUT: ${why}. Heat never starts on its own, so it is being cut.`);
    this.lastEchoOnAt = DISTANT_PAST;
    this.say("Heat came back on by itself. Cut it.");
    this.sendStop("SAFETY CUT (stop, session 0)", true);
  }

  extendTen() {
    const s = this.gate();
    if (s === null) return;
    if (s.sessionByte <= 0) { this.say("+10s only works while heating."); return; }
    if (this.heldHoldSeconds === undefined) { this.say("Can't add time: the rig hasn't reported this preset's hold time."); return; }
    if (this.countdownSeen && s.sessionTimeRemaining <= 3) { this.say("Too late for that: the dab is in its last 3 seconds."); return; }
    if (!this.canExtend) { this.say("Can't add more time: hold plus extra can't go past 90 s."); return; }
    this.enqueue(this.item({ label: "+10 s (session extend +1)", kind: { t: "b9", change: { extendPlusOne: true }, intent: "echo" }, requireSessionOn: true }));
  }

  // MARK: Away: leaving the app, losing the link, disconnecting mid-dab

  appMovedToBackground() {
    if (this.inBackground) return;
    this.inBackground = true;
    this.quietSince = null;
    this.ble?.appMovedToBackground();
    if (this.sessionOn || this.startPendingAt !== null) {
      this.log("APP: left the app mid-dab. Letting the dab finish. Heat gets confirmed off after.");
    } else {
      this.log("APP: left the app. Nothing heating.");
    }
  }

  appBecameActive() {
    if (!this.inBackground) return;
    this.inBackground = false;
    this.quietSince = null;
    this.log("APP: back in the app.");
    this.ble?.appBecameActive();
  }

  /** Disconnect button. Mid-dab the first tap waits for the dab to finish; a second tap drops the link now. */
  askDisconnect() {
    if (this.sessionOn && this.connected && this.linkFresh && !this.disconnectWaiting) {
      this.disconnectWaiting = true;
      this.log("Disconnect asked mid-dab. Letting the dab finish first, then disconnecting. A second tap disconnects right away.");
      this.changed();
      return;
    }
    if (this.disconnectWaiting) {
      this.log("Disconnect asked again. Dropping the link now. The rig finishes the dab on its own timer.");
    }
    this.disconnectWaiting = false;
    this.ble?.disconnect();
  }

  private confirmOff(why: string) {
    this.log(`AWAY: ${why}. Sending one stop to make sure heat is off.`);
    this.awayNote = "Dab finished on its own. Heat confirmed off.";
    this.sendStop("SAFE OFF (stop, session 0)", false);
  }

  private awayTick(s: LiveStatus, now: number) {
    if (!this.away) {
      this.zeroSince = null;
      return;
    }
    if (this.countdownSeen && s.sessionTimeRemaining === 0) {
      if (this.zeroSince === null) this.zeroSince = now;
    } else {
      this.zeroSince = null;
    }
    let why: string | null = null;
    if (this.zeroSince !== null && now - this.zeroSince >= this.stuckAfterZero) {
      why = `the countdown finished ${Math.trunc(this.stuckAfterZero)} s ago but the rig still shows heating`;
    }
    if (this.sessionStartDate !== null && now - this.sessionStartDate >= this.maxAwaySession) {
      why = `this session has run over ${Math.trunc(this.maxAwaySession)} s`;
    }
    if (why === null || now - this.lastAwayCutAt < 5.0) return;
    this.lastAwayCutAt = now;
    this.log(`AWAY CUT: nobody is at the app and ${why}. Cutting heat.`);
    this.awayNote = "The dab was over but the rig was still heating, so the app cut it.";
    this.sendStop("AWAY CUT (stop, session 0)", true);
  }

  // MARK: Actions: presets

  selectPreset(n: number) {
    if (!inRange(n, 1, 5)) return;
    if (this.gate() === null) return;
    this.enqueue(this.item({ label: `Select preset ${n}`, kind: { t: "b9", change: { preset: n }, intent: "echo" }, requireSessionOff: true }));
  }

  savePreset(p: number, tempF: number, hold: number, profile: number) {
    if (!inRange(p, 1, 5)) { this.say("Preset must be 1 to 5."); return; }
    if (!inRange(tempF, RigLimits.tempF[0], RigLimits.tempF[1])) { this.say("Temperature must be 250 to 650 F."); return; }
    const c = RigLimits.celsius(tempF);
    if (!inRange(c, RigLimits.tempC[0], RigLimits.tempC[1])) { this.say("Temperature out of range."); return; }
    if (!inRange(hold, RigLimits.hold[0], RigLimits.hold[1])) { this.say("Hold time must be 10 to 90 seconds."); return; }
    const s = this.gate();
    if (s === null) return;
    if (s.sessionByte !== 0) { this.say("Can't edit presets while heating."); return; }

    const tempFrame = [179, 8, p, tempF >> 8, tempF & 255, c >> 8, c & 255, 179];
    const holdFrame = [183, 6, p, hold >> 8, hold & 255, 183];
    this.log(`Saving preset ${p}: ${tempF} F / ${c} C, hold ${hold} s, profile ${HeatProfile.name(profile)}.`);

    this.enqueue(this.item({
      label: `Preset ${p} temp ${tempF}F`, kind: { t: "raw", bytes: tempFrame }, gapBefore: 0.12, requireSessionOff: true,
      onSent: () => { this.presets[p].tempF = tempF; this.presets[p].tempC = c; },
    }));
    this.enqueue(this.item({
      label: `Preset ${p} hold ${hold}s`, kind: { t: "raw", bytes: holdFrame }, gapBefore: 1.0, requireSessionOff: true,
      onSent: () => { this.presets[p].hold = hold; },
    }));
    if (HeatProfile.isWritable(profile)) {
      const profFrame = [181, 5, p, profile, 181];
      this.enqueue(this.item({
        label: `Preset ${p} profile ${HeatProfile.name(profile)}`, kind: { t: "raw", bytes: profFrame }, gapBefore: 1.0,
        requireSessionOff: true, onSent: () => { this.presets[p].profile = profile; },
      }));
    } else {
      this.log("Profile left unchanged (not a writable profile in this build).");
    }
  }

  // MARK: Actions: custom heat curve (ride planner). DRAFT: not in the shared bench spec yet.

  /** What the last saveCurve asked for, and whether the rig's own 0xAA/0xAB report matched it. */
  curveCheck: { preset: number; want: CurveStep[]; state: "sending" | "ok" | "mismatch" | "no report" } | null = null;

  /** Why these steps can't be saved, or null. 2 to 5 steps, first at 0 s, times rising, last 10 to 90 s,
   *  250 to 650 F, and no ramp steeper than the official editor allows (+10 F/s up, -3 F/s down). */
  static curveProblem(steps: CurveStep[]): string | null {
    if (steps.length < 2 || steps.length > 5) return "A curve needs 2 to 5 points.";
    if (steps[0].t !== 0) return "The first point must be at 0 seconds.";
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      if (!Number.isInteger(st.t) || !Number.isInteger(st.f)) return "Use whole seconds and whole degrees.";
      if (!inRange(st.f, RigLimits.tempF[0], RigLimits.tempF[1])) return "Temperature must be 250 to 650 F.";
      if (!inRange(RigLimits.celsius(st.f), RigLimits.tempC[0], RigLimits.tempC[1])) return "Temperature out of range.";
      if (i > 0) {
        const dt = st.t - steps[i - 1].t, df = st.f - steps[i - 1].f;
        if (dt <= 0) return "Each point must come later than the one before.";
        if (df > 10 * dt) return "That climb is too steep: at most 10 F a second.";
        if (df < -3 * dt) return "That drop is too steep: at most 3 F a second.";
      }
    }
    const last = steps[steps.length - 1].t;
    if (!inRange(last, RigLimits.hold[0], RigLimits.hold[1])) return "The curve must end between 10 and 90 seconds.";
    return null;
  }

  /** Saves a Custom (241) curve to a preset. Only while the rig is not heating. Same order and gaps as the
   *  official app: temp, hold, profile 241, then the two curve frames. Then checks the rig's read-back. */
  saveCurve(p: number, steps: CurveStep[]) {
    if (!inRange(p, 1, 5)) { this.say("Preset must be 1 to 5."); return; }
    const problem = RigController.curveProblem(steps);
    if (problem) { this.say(problem); return; }
    const s = this.gate();
    if (s === null) return;
    if (s.sessionByte !== 0) { this.say("Can't edit presets while heating."); return; }

    const f0 = steps[0].f, c0 = RigLimits.celsius(f0), hold = steps[steps.length - 1].t;
    const cell = (i: number): number[] => {
      const st = steps[i];
      if (!st) return [0, 0, 0, 0, 0];
      const c = RigLimits.celsius(st.f);
      return [st.f >> 8, st.f & 255, c >> 8, c & 255, st.t];
    };
    const frameA = [186, 19, p, ...cell(0), ...cell(1), ...cell(2), 186];
    const frameB = [187, 19, p, ...cell(3), ...cell(4), ...cell(5), 187];
    this.log(`Saving custom curve to preset ${p}: ${steps.map(x => `${x.f}F@${x.t}s`).join(", ")}.`);
    this.curveCheck = { preset: p, want: steps.map(x => ({ ...x })), state: "sending" };
    const drop = () => { if (this.curveCheck?.state === "sending") this.curveCheck = null; };

    this.enqueue(this.item({
      label: `Preset ${p} temp ${f0}F`, kind: { t: "raw", bytes: [179, 8, p, f0 >> 8, f0 & 255, c0 >> 8, c0 & 255, 179] },
      gapBefore: 0.12, requireSessionOff: true, onDrop: drop,
      onSent: () => { this.presets[p].tempF = f0; this.presets[p].tempC = c0; },
    }));
    this.enqueue(this.item({
      label: `Preset ${p} hold ${hold}s`, kind: { t: "raw", bytes: [183, 6, p, hold >> 8, hold & 255, 183] },
      gapBefore: 1.0, requireSessionOff: true, onDrop: drop, onSent: () => { this.presets[p].hold = hold; },
    }));
    this.enqueue(this.item({
      label: `Preset ${p} profile Custom`, kind: { t: "raw", bytes: [181, 5, p, 241, 181] },
      gapBefore: 1.0, requireSessionOff: true, onDrop: drop, onSent: () => { this.presets[p].profile = 241; },
    }));
    this.enqueue(this.item({
      label: `Preset ${p} curve part 1`, kind: { t: "raw", bytes: frameA }, gapBefore: 0.3, requireSessionOff: true, onDrop: drop,
      // Forget the old read-back so the check below only passes on a fresh report from the rig.
      onSent: () => { this.presets[p].custom170 = undefined; this.presets[p].custom171 = undefined; },
    }));
    this.enqueue(this.item({
      label: `Preset ${p} curve part 2`, kind: { t: "raw", bytes: frameB }, gapBefore: 0.3, requireSessionOff: true, onDrop: drop,
      onSent: () => {
        this.clock.after(2.5, () => {
          const cc = this.curveCheck;
          if (!cc || cc.preset !== p || cc.state !== "sending") return;
          const got = this.reportedCurve(p);
          if (got === null) { cc.state = "no report"; this.log(`CURVE CHECK preset ${p}: the rig sent no curve back.`); }
          else {
            const same = got.length === cc.want.length && got.every((g, i) => g.t === cc.want[i].t && g.f === cc.want[i].f);
            cc.state = same ? "ok" : "mismatch";
            this.log(`CURVE CHECK preset ${p}: ${same ? "ok, the rig reports the same curve" : `MISMATCH, rig reports ${got.map(x => `${x.f}F@${x.t}s`).join(", ")}`}.`);
          }
          this.changed();
        });
      },
    }));
  }

  /** The curve the rig last reported for a slot (0xAA + 0xAB), or null if it has not reported one. */
  reportedCurve(p: number): CurveStep[] | null {
    const pr = this.presets[p];
    if (!pr?.custom170) return null;
    const out: CurveStep[] = [];
    for (const fr of [pr.custom170, pr.custom171]) {
      if (!fr) continue;
      for (let o = 3; o + 4 < fr.length - 1; o += 5) {
        const f = (fr[o] << 8) | fr[o + 1];
        if (f === 0 && ((fr[o + 2] << 8) | fr[o + 3]) === 0) continue;
        out.push({ t: fr[o + 4], f });
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }

  // MARK: Actions: lights

  setLightMode(m: number) {
    if (!LightModes.isOffered(m)) { this.say("That light mode isn't available."); return; }
    this.enqueue(this.item({ label: `Light mode ${m} ${LightModes.name(m)}`, kind: { t: "b9", change: { lightMode: m }, intent: "echo" } }));
  }

  /** Slider-driven: waits 250 ms after the last change. */
  setBrightness(v: number) {
    const clamped = clamp(Math.round(v), RigLimits.brightness[0], RigLimits.brightness[1]);
    this.brightnessDebounce?.();
    this.brightnessDebounce = this.clock.after(0.25, () => {
      this.enqueue(this.item({ label: `Brightness ${clamped}`, kind: { t: "b9", change: { brightness: clamped }, intent: "echo" } }));
    });
  }

  setHaptics(on: boolean) {
    this.enqueue(this.item({ label: `Haptics ${on ? "on" : "off"}`, kind: { t: "b9", change: { haptics: on }, intent: "echo" } }));
  }

  private enqueueLight(o: { mode: number | null; brightness: number | null; label: string; requireOn: boolean; requireOff?: boolean; onSent?: () => void; onDrop?: () => void }) {
    const ch: B9Change = {};
    if (o.mode !== null && inRange(o.mode, 0, 33)) ch.lightMode = o.mode;
    if (o.brightness !== null) ch.brightness = clamp(o.brightness, 0, 100);
    this.enqueue(this.item({
      label: o.label, kind: { t: "b9", change: ch, intent: "echo" }, requireSessionOn: o.requireOn,
      requireSessionOff: o.requireOff ?? false, onSent: o.onSent, onDrop: o.onDrop, auto: true,
    }));
  }

  private tryOwedRestore(now: number) {
    const r = this.pendingRestore;
    if (!r || this.restoreQueued || this.previewing || now - this.lastRestoreTryAt < 2.0) return;
    this.lastRestoreTryAt = now;
    this.restoreQueued = true;
    this.log(`Restoring lights: mode ${r.mode}, brightness ${r.brightness}.`);
    this.enqueueLight({
      mode: r.mode, brightness: r.brightness, label: "Restore lights", requireOn: false, requireOff: true,
      onSent: () => { this.pendingRestore = null; this.restoreQueued = false; this.restoreSentAt = this.now(); },
      onDrop: () => { this.restoreQueued = false; },
    });
  }

  // MARK: Curve logging and temperature helpers

  private tempInF(s: LiveStatus): number {
    if (s.unitByte === 12) return swiftRound(s.tempRaw * 9 / 5 + 32);
    return s.tempRaw;
  }

  get liveTempF(): number | null { return this.live ? this.tempInF(this.live) : null; }

  private curveTick(s: LiveStatus) {
    if (this.sessionStartDate === null) return;
    const f = this.tempInF(s);
    if (f > this.sessionPeakF) this.sessionPeakF = f;
    const t = this.now() - this.sessionStartDate;
    this.log(`CURVE t=${t.toFixed(1)} temp=${f} remaining=${s.sessionTimeRemaining} preset=${s.preset}`);
  }

  // MARK: Ride the dial (test)

  private b3Frame(slot: number, f: number): number[] {
    const c = RigLimits.celsius(f);
    return [179, 8, slot, f >> 8, f & 255, c >> 8, c & 255, 179];
  }

  get dialDisabledReason(): string | null {
    if (!this.canControl) return "Connect to the rig first.";
    if (!this.sessionOn) return "Start a heat session with HEAT IT first. This only works while heating.";
    if (this.dialStart === null) return "Starting target unknown: the rig hasn't reported the active preset's temperature yet.";
    if (this.dialMode === "active") {
      const s = this.live;
      if (!s || !inRange(s.preset, 1, 5) || s.preset !== this.dialStartPreset) return "Active preset changed since the session began.";
    }
    return null;
  }

  dialNudge(delta: number) {
    if (Math.abs(delta) !== RigController.dialStep) return;
    const s = this.gate();
    if (s === null) return;
    if (s.sessionByte <= 0) { this.say("Dial test only works while a session is running."); return; }
    const start = this.dialStart, cur = this.dialCurrent;
    if (start === null || cur === null) { this.say("Starting target unknown, so the dial test is off."); return; }
    if (this.now() - this.dialLastTap < 1.0) { this.say("Wait 1 second between nudges."); return; }
    const newT = cur + delta;
    if (!inRange(newT, RigLimits.tempF[0], RigLimits.tempF[1])) { this.say("Dial test stays between 250 and 650 F."); return; }
    if (Math.abs(newT - start) > 50) { this.say(`Dial test stays within 50 F of where it started (${start} F).`); return; }

    let slot = 0;
    if (this.dialMode === "active") {
      if (!inRange(s.preset, 1, 5) || s.preset !== this.dialStartPreset) { this.say("Active preset changed since the session began."); return; }
      slot = s.preset;
    }

    if (!this.dialTouched.has(slot)) {
      this.dialTouched.add(slot);
      const original = slot === 0 ? this.presets[0].tempF : start;
      const owed = this.dialPending.get(slot);
      if (owed !== undefined) {
        // A temp is already owed back to this slot (taps before a link drop or an app relaunch).
        // What the rig reports now is the shifted temp, so the saved original must never be replaced.
        this.log(`DIAL TEST original for slot ${slot} stays ${owed} F (already owed from before the link dropped or the app restarted).`);
      } else if (original !== undefined) {
        this.dialPending.set(slot, original);
        this.saveDialPending();
        this.log(`DIAL TEST original for slot ${slot} = ${original} F. Will be put back when the session ends.`);
      } else {
        this.log("DIAL TEST original for slot 0 was unknown (no 163 report for slot 0 seen before the test). It will be left as is.");
      }
    }

    const label = `DIAL TEST nudge → target ${newT} (mode ${this.dialMode === "live" ? "A" : "B"})`;
    this.log(label);
    this.dialLastTap = this.now();
    this.dialCurrent = newT;
    const frame = this.b3Frame(slot, newT);
    this.enqueue(this.item({
      label, kind: { t: "raw", bytes: frame }, gapBefore: 0.12, requireSessionOn: true,
      onSent: () => this.dialNudgeSent(newT, delta),
      onDrop: () => { this.dialCurrent = cur; this.log(`DIAL TEST nudge not sent; target stays ${cur} F.`); },
    }));
  }

  private dialNudgeSent(newTarget: number, delta: number) {
    const now = this.now();
    /** F per second across the samples aged between `from` and `to` seconds; null when they span under 1.5 s. */
    const slopeBetween = (from: number, to: number): number | null => {
      const w = this.dialSamples.filter(x => { const age = now - x.time; return age <= from && age >= to; });
      const a = w[0], b = w[w.length - 1];
      if (!a || !b || b.time - a.time < 1.5) return null;
      return (b.f - a.f) / (b.time - a.time);
    };
    // What the temp was doing by itself before the tap. The verdict takes that off, because a preset can
    // climb with no help (Ascent rose 1 F a second on the real rig and was read as "yes"). A follow-up tap
    // inside the 6 s window keeps the first tap's measurement: by then the temp may be answering that tap.
    if (this.dialNudgeAt === null) {
      const recent = slopeBetween(4.0, 0);
      const earlier = slopeBetween(7.0, 4.0);
      this.dialBeforeSlope = recent ?? 0;
      // Still racing up to the preset, or only just levelled off: no fair comparison can be made.
      if (recent !== null && earlier !== null) this.dialBeforeSteady = Math.abs(recent) <= 3.0 && Math.abs(recent - earlier) <= 1.0;
      else this.dialBeforeSteady = false;
    }
    const slope = this.dialBeforeSlope;
    this.dialNudgeBase = this.dialSamples.length > 0 ? this.dialSamples[this.dialSamples.length - 1].f : (this.liveTempF ?? 0);
    this.dialNudgeDir = delta > 0 ? 1 : -1;
    this.dialNudgeTarget = newTarget;
    this.dialNudgeAt = now;
    this.dialWatchUntil = now + 20;
    this.dialLastB3 = this.live?.preset ?? -1;
    this.dialReadout = "Temp moving toward new target: too early";
    this.dialNumbers = `At nudge ${this.dialNudgeBase} F, new target ${newTarget} F, slope before ${slope.toFixed(1)} F/s`;
    this.log(`DIAL TEST sent. Temp at nudge ${this.dialNudgeBase} F, slope before ${slope.toFixed(2)} F/s. Watching A9 b3 (now ${this.dialLastB3}).`);
  }

  private dialTick(s: LiveStatus) {
    const now = this.now();
    const f = this.tempInF(s);
    if (this.dialStart === null && inRange(s.preset, 1, 5)) {
      const t = this.presets[s.preset].tempF;
      if (t !== undefined) {
        // If a temp is still owed back to this preset, the rig is reporting the shifted temp. The saved
        // original is the true starting point, so the 50 F limit is measured from it, not from the shift.
        this.dialStart = this.dialPending.get(s.preset) ?? t;
        this.dialCurrent = t;
        this.dialStartPreset = s.preset;
        this.log(`DIAL TEST ready: starting target ${t} F (preset ${s.preset}).`);
      }
    }
    this.dialSamples.push({ time: now, f });
    this.dialSamples = this.dialSamples.filter(x => now - x.time <= 12.0);

    if (now < this.dialWatchUntil && this.dialLastB3 >= 0 && s.preset !== this.dialLastB3) {
      this.log(`DIAL TEST A9 b3 changed ${this.dialLastB3} → ${s.preset}`);
      this.dialLastB3 = s.preset;
    }

    if (this.dialNudgeAt !== null) {
      const el = now - this.dialNudgeAt;
      const delta = f - this.dialNudgeBase;
      const sign = delta >= 0 ? "+" : "";
      const drift = this.dialBeforeSlope * el;
      const driftText = (drift >= 0 ? "+" : "") + drift.toFixed(1);
      const nums = `At nudge ${this.dialNudgeBase} F, now ${f} F (${sign}${delta} F in ${el.toFixed(1)} s, ${driftText} F expected with no tap), new target ${this.dialNudgeTarget} F, slope before ${this.dialBeforeSlope.toFixed(1)} F/s`;
      if (el < 6.0) {
        this.dialReadout = "Temp moving toward new target: too early";
        this.dialNumbers = nums;
      } else {
        // Movement toward the new target beyond what the temp was already doing.
        const extra = (delta - drift) * this.dialNudgeDir;
        const need = Math.max(2, Math.trunc((RigController.dialStep * 3) / 5));
        const verdict = !this.dialBeforeSteady ? "can't tell (temp was not steady before the tap)" : (extra >= need ? "yes" : "no");
        this.dialReadout = `Temp moving toward new target: ${verdict}`;
        this.dialNumbers = nums;
        this.log(`DIAL TEST result after 6 s: ${verdict}. ${nums}`);
        this.dialNudgeAt = null;
      }
    }
  }

  private dialRestorePending() {
    if (this.dialPending.size === 0 || this.sessionOn) return;
    for (const slot of [...this.dialPending.keys()].sort((a, b) => a - b)) {
      const f = this.dialPending.get(slot);
      if (this.dialRestoreQueued.has(slot) || f === undefined) continue;
      this.dialRestoreQueued.add(slot);
      const frame = this.b3Frame(slot, f);
      const label = `DIAL TEST restore slot ${slot} to ${f} F`;
      this.log(label);
      this.enqueue(this.item({
        label, kind: { t: "raw", bytes: frame }, gapBefore: 0.5, requireSessionOff: true, auto: true,
        onSent: () => {
          this.dialPending.delete(slot);
          this.saveDialPending();
          this.dialRestoreQueued.delete(slot);
          this.presets[slot].tempF = f;
          this.presets[slot].tempC = RigLimits.celsius(f);
          this.log(`DIAL TEST restore sent for slot ${slot}.`);
        },
        onDrop: () => { this.dialRestoreQueued.delete(slot); },
      }));
    }
  }

  // MARK: Session start and end

  private sessionBegan() {
    this.sessionStartDate = this.now();
    this.sessionPeakF = 0;
    const s = this.live;
    if (s) {
      const p: PresetInfo = inRange(s.preset, 0, 5) ? this.presets[s.preset] : {};
      const tgt = p.tempF !== undefined ? String(p.tempF) : "?";
      const hold = p.hold !== undefined ? String(p.hold) : "?";
      const prof = p.profile !== undefined ? HeatProfile.name(p.profile) : "?";
      this.log(`SESSION START target=${tgt} hold=${hold} profile=${prof}`);
    } else {
      this.log("SESSION START target=? hold=? profile=?");
    }
    this.dialStart = null;
    this.dialCurrent = null;
    this.dialTouched.clear();
    this.dialNudgeAt = null;
    this.dialSamples = [];
    this.dialReadout = "No nudge yet";
    this.dialNumbers = "";
    this.countdownSeen = false;
    this.counting = false;
    this.peakRemaining = 0;
    this.zeroSince = null;
    this.showRan = false;
    this.appliedStepID = null;
    this.flashHighPhase = false;
    this.flashTicks = 0;
    this.stopFlash();
    this.restoreTarget = this.pendingRestore ?? this.preSession;
    const r = this.restoreTarget;
    if (r) this.log(`Session started. Lights before session: mode ${r.mode}, brightness ${r.brightness}.`);
    else this.log("Session already running when connected; no earlier light settings known to restore.");
  }

  private sessionEnded() {
    if (this.sessionStartDate !== null) {
      this.log(`SESSION END duration=${(this.now() - this.sessionStartDate).toFixed(0)} peak=${this.sessionPeakF}`);
    }
    this.sessionStartDate = null;
    if (this.dialTouched.size > 0) this.log("DIAL TEST: session ended. Putting temps back.");
    this.dialStart = null;
    this.dialCurrent = null;
    this.dialTouched.clear();
    this.dialNudgeAt = null;
    this.dialSamples = [];
    this.stopFlash();
    this.queue = this.queue.filter(it => !it.requireSessionOn);
    this.showRan = false;
    this.log("Session ended.");
    if (this.away) {
      const why = this.inBackground ? "the dab finished while the app was in the background"
        : this.disconnectWaiting ? "the dab finished and a disconnect is waiting"
          : "the dab finished after the link dropped and came back";
      this.linkLostAt = null;
      this.confirmOff(why);
    }
  }

  // MARK: Light show

  private orderedSteps(): ShowStep[] {
    const starts = this.show.steps.filter(x => x.atStart);
    const timed = this.show.steps.filter(x => !x.atStart).sort((a, b) => b.secondsRemaining - a.secondsRemaining);
    return [...starts, ...timed];
  }

  private markShowRan() {
    if (this.showRan) return;
    this.showRan = true;
    if (this.pendingRestore === null && this.restoreTarget) this.pendingRestore = this.restoreTarget;
  }

  private showTick(s: LiveStatus) {
    if (!this.showEnabled) { this.stopFlash(); return; }
    const remaining = s.sessionTimeRemaining;
    const tail = this.countdownSeen && remaining <= 3;
    const sh = this.show;

    let target: ShowStep | null = null;
    for (const st of this.orderedSteps()) {
      if (st.atStart || (this.counting && remaining <= st.secondsRemaining)) target = st;
    }

    const wantFlash = sh.flashEnabled && this.counting && remaining > 3 && remaining <= sh.flashSeconds;
    if (wantFlash) {
      this.startFlash();
    } else if (this.flashing) {
      this.stopFlash();
      if (!tail) this.appliedStepID = null;
    }

    if (!tail && target && target.id !== this.appliedStepID) {
      this.appliedStepID = target.id;
      this.markShowRan();
      const br = this.flashing ? (this.flashHighPhase ? sh.flashHigh : sh.flashLow) : target.brightness;
      this.enqueueLight({
        mode: target.lightMode, brightness: br, label: `Show step: ${LightModes.name(target.lightMode)} @${br}`,
        requireOn: true, onDrop: () => { this.appliedStepID = null; },
      });
    }

    if (this.flashing && !tail) {
      this.flashTicks += 1;
      if (this.flashTicks % 2 === 0 && this.queue.length <= 2) {
        this.flashHighPhase = !this.flashHighPhase;
        const lvl = this.flashHighPhase ? sh.flashHigh : sh.flashLow;
        this.enqueueLight({ mode: null, brightness: lvl, label: `Flash brightness ${lvl}`, requireOn: true });
      }
    }
  }

  private startFlash() {
    if (this.flashing) return;
    this.flashing = true;
    this.flashTicks = 0;
    this.markShowRan();
    this.log("Slow-down flash started.");
  }

  private stopFlash() {
    if (this.flashing) this.log("Slow-down flash stopped.");
    this.flashing = false;
  }

  previewStep(st: ShowStep) {
    const s = this.gate();
    if (s === null) return;
    if (s.sessionByte !== 0) { this.say("Preview only works when the rig is not heating."); return; }
    if (this.startPendingAt !== null || this.previewing) return;
    if (this.pendingRestore !== null) { this.say("Hang on, putting the lights back first."); return; }
    if (!LightModes.isOffered(st.lightMode)) return;
    this.pendingRestore = { mode: s.lightMode, brightness: s.brightness };
    this.previewing = true;
    this.previewToken += 1;
    const tok = this.previewToken;
    this.log(`Preview step: ${LightModes.name(st.lightMode)} @${st.brightness} for 3 s.`);
    this.enqueueLight({
      mode: st.lightMode, brightness: st.brightness, label: "Preview step", requireOn: false, requireOff: true,
      onDrop: () => {
        if (this.previewToken !== tok) return;
        this.previewing = false;
        this.pendingRestore = null;
      },
    });
    this.clock.after(3.0, () => {
      if (this.previewToken !== tok || !this.previewing) return;
      this.previewing = false;
      this.changed();
    });
  }
}
