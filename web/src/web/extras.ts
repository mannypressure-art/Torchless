// Rig extras that never write to the rig: heat-up countdown, at-temp moment, dabs left on this charge,
// clean reminders, and "do that again" (finds the preset that matches a top-rated dab; picking it is the
// same preset tap as on Home). Reads rig.live, rig.presets and the rig's own heat-cycle counter (0xA2).

import { RigController, HeatProfile } from "../rig/rig-controller";
import type { Jar, JarDab } from "./jars";

const K = {
  drops: "torchless.batteryDrops",       // battery points used per dab, newest last (max 12)
  cleanAt: "torchless.cleanAtCycles",    // the rig's heat-cycle count when it was last cleaned
  cleanLocal: "torchless.dabsSinceClean",// dabs this app saw since the last clean (when the counter is unknown)
  cleanEvery: "torchless.cleanEvery",    // remind after this many dabs
  cleanOn: "torchless.cleanOn",          // "0" = deep clean reminder off
};
const get = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const num = (k: string): number | null => { const v = get(k); const n = v === null ? NaN : Number(v); return Number.isFinite(n) ? n : null; };

/** Deep clean reminder: the user's pick (Dr. Dabber gives no number). */
export const CLEAN_CHOICES = [10, 20, 30, 50, 75, 100];

/** Heat cycles from the rig's analytics frame (0xA2, 19 or 20 bytes: u16 at bytes 6-7). Seen in the Logs of
 *  2026-11-11 and 2026-11-12 going 404 to 405 and 416 to 417 across one dab each. */
export function heatCyclesFrom(extra: Record<string, string>): number | null {
  for (const [k, v] of Object.entries(extra)) {
    if (!k.startsWith("Analytics")) continue;
    const named = /heat cycles (\d+)/.exec(v);
    if (named) return Number(named[1]);
    const raw = /raw: A2 (13|14) ((?:[0-9A-F]{2} ?)+)/.exec(v);
    if (raw) {
      const b = raw[2].trim().split(" ").map(x => parseInt(x, 16));
      if (b.length >= 6) return (b[4] << 8) | b[5];
    }
  }
  return null;
}

export class RigExtras {
  private wasOn = false;
  private startBattery: number | null = null;
  private startAt = 0;
  private samples: { t: number; v: number }[] = [];
  private readyAt: number | null = null;
  private sessionStartRemaining = 0;
  /** ms timestamp of the moment the rig reached temp in this dab, for the AT TEMP flash. */
  atTempAt: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Call on every rig change. */
  update(rig: RigController): void {
    const s = rig.live;
    if (!s || !rig.linkFresh) { this.samples = []; return; }
    const on = rig.sessionOn, t = this.now();
    if (on && !this.wasOn) {
      this.startBattery = s.battery; this.startAt = t; this.samples = []; this.readyAt = null; this.atTempAt = null;
      this.sessionStartRemaining = s.sessionTimeRemaining;
    }
    if (on && this.readyAt === null) {
      this.samples.push({ t, v: s.tempRaw });
      while (this.samples.length > 2 && t - this.samples[0].t > 2500) this.samples.shift();
      const target = this.target(rig);
      if (s.sessionTimeRemaining < this.sessionStartRemaining || (target !== null && s.tempRaw >= target - 4)) {
        this.readyAt = t; this.atTempAt = t;
        try { navigator.vibrate?.([18, 70, 28]); } catch { /* iPhone browsers have none */ }
      }
    }
    if (!on && this.wasOn) {
      const secs = (t - this.startAt) / 1000;
      if (secs >= 20 && this.startBattery !== null && !(s.chargingByte === 170)) {
        const drop = this.startBattery - s.battery;
        if (drop >= 0 && drop <= 25) {
          const list = this.drops();
          list.push(drop);
          set(K.drops, JSON.stringify(list.slice(-12)));
        }
      }
      if (secs >= 20) set(K.cleanLocal, String((num(K.cleanLocal) ?? 0) + 1));
      this.startBattery = null;
    }
    this.wasOn = on;
  }

  private target(rig: RigController): number | null {
    const s = rig.live;
    if (!s || s.preset < 0 || s.preset > 5) return null;
    const ps = rig.presets[s.preset];
    const v = s.unitByte === 12 ? ps.tempC : ps.tempF;
    return v ?? null;
  }

  /** Seconds until the rig reaches temp while heating up, or null when it can't tell (or is already there). */
  heatUpETA(rig: RigController): number | null {
    const s = rig.live;
    if (!s || !rig.sessionOn || this.readyAt !== null || this.samples.length < 3) return null;
    const a = this.samples[0], b = this.samples[this.samples.length - 1];
    const dt = (b.t - a.t) / 1000;
    if (dt < 0.8) return null;
    const rate = (b.v - a.v) / dt;
    const target = this.target(rig);
    if (target === null || rate < 2) return null;
    const eta = (target - 4 - b.v) / rate;
    return eta > 0 && eta < 120 ? Math.ceil(eta) : null;
  }
  get preheating(): boolean { return this.wasOn && this.readyAt === null; }

  private drops(): number[] {
    try { const v = JSON.parse(get(K.drops) ?? "[]"); return Array.isArray(v) ? v.filter(x => typeof x === "number") : []; } catch { return []; }
  }
  /** Dabs left on this charge from the battery used by the last dabs. Null until three dabs are known. */
  dabsLeft(rig: RigController): { left: number; per: number; seen: number } | null {
    const s = rig.live;
    const d = this.drops();
    if (!s || d.length < 3) return null;
    const per = d.reduce((x, y) => x + y, 0) / d.length;
    if (per <= 0.2) return null;
    return { left: Math.max(0, Math.floor(s.battery / per)), per, seen: d.length };
  }

  // Clean reminders

  get cleanEvery(): number { const n = num(K.cleanEvery); return n && CLEAN_CHOICES.includes(n) ? n : 50; }
  set cleanEvery(n: number) { set(K.cleanEvery, String(n)); }
  get cleanOn(): boolean { return num(K.cleanOn) !== 0; }
  set cleanOn(on: boolean) { set(K.cleanOn, on ? "1" : "0"); }
  /** Dabs since the last clean: the rig's own counter when known, else the dabs this app saw. */
  dabsSinceClean(cycles: number | null): number {
    const at = num(K.cleanAt);
    if (cycles !== null) {
      if (at === null || at > cycles) { set(K.cleanAt, String(Math.max(0, cycles - (num(K.cleanLocal) ?? 0)))); }
      return Math.max(0, cycles - (num(K.cleanAt) ?? cycles));
    }
    return num(K.cleanLocal) ?? 0;
  }
  cleaned(cycles: number | null): void {
    set(K.cleanLocal, "0");
    if (cycles !== null) set(K.cleanAt, String(cycles));
  }
}

// MARK: Do that again

export interface Again { dab: JarDab; preset: number | null; text: string }

/** The best-rated dab on this jar (7.0 or better), and the preset that matches it today, if one does. */
export function doThatAgain(jar: Jar | undefined, rig: RigController): Again | null {
  if (!jar) return null;
  const rated = (jar.dabs ?? []).filter(d => d.rating !== undefined && d.rating >= 7 && d.goal !== undefined);
  if (!rated.length) return null;
  rated.sort((a, b) => (b.rating! - a.rating!) || (b.at < a.at ? -1 : 1));
  const dab = rated[0];
  let preset: number | null = null;
  for (let n = 1; n <= 5; n++) {
    const p = rig.presets[n];
    const t = dab.unit === "C" ? p.tempC : p.tempF;
    const prof = p.profile !== undefined ? HeatProfile.name(p.profile) : undefined;
    if (t === dab.goal && (!dab.profile || dab.profile === "Unknown" || prof === dab.profile)) { preset = n; break; }
  }
  const range = dab.goalTop !== undefined ? `${Math.min(dab.goal!, dab.goalTop)}–${Math.max(dab.goal!, dab.goalTop)}°` : `${dab.goal}°`;
  return { dab, preset, text: `${range} ${dab.profile ?? ""}`.trim() };
}
