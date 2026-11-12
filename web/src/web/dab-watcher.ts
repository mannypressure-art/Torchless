// Port of DabWatcher (JarDabs.swift): turns what the rig reports into dabs logged to the current jar, and
// asks for a rating 15 s after heat stops. It only READS rig state. It never writes to the rig.

import { RigController, HeatProfile } from "../rig/rig-controller";
import { JarStore, JarDab, Dabs, uid } from "./jars";

export interface DabPrompt {
  /** null = no current jar was set; the pop-up asks which jar it was. */
  jarID: string | null;
  dab: JarDab;
}

export class DabWatcher {
  static readonly minSeconds = 20;
  static readonly coolF = 300;
  static readonly coolC = 149;
  /** The pop-up shows this long after heating stops (Manny, 2026-11-11). */
  static readonly promptDelay = 15_000;

  prompt: DabPrompt | null = null;
  onPrompt: () => void = () => {};

  private wasOn = false;
  private start: number | null = null;
  private goal: number | undefined;
  private peak = 0;
  private celsius = false;
  private profile: string | undefined;
  private waiting: { jarID: string | null; dab: JarDab; offAt: number } | null = null;
  private cooling: { jarID: string | null; dabID: string; offAt: number } | null = null;
  private checkedOpen = false;

  constructor(private readonly store: JarStore, private readonly now: () => number = Date.now,
              private readonly later: (fn: () => void, ms: number) => void = (fn, ms) => { setTimeout(fn, ms); }) {}

  /** Offers the newest unrated dab once when the app opens. */
  appOpened(): void {
    if (this.checkedOpen) return;
    this.checkedOpen = true;
    if (this.prompt || this.waiting) return;
    const o = this.store.unratedToOffer(this.now());
    if (!o) return;
    this.store.updateDab(o.jarID, o.dab.id, d => { d.asked = true; });
    this.show({ jarID: o.jarID, dab: o.dab });
  }

  /** Call on every status frame. */
  update(rig: RigController): void {
    const s = rig.live;
    if (!s || !rig.linkFresh) return;
    const on = rig.sessionOn;
    this.celsius = s.unitByte === 12;
    const temp = s.tempRaw;
    const now = this.now();

    if (on && !this.wasOn) {
      this.start = now; this.goal = undefined; this.peak = 0; this.profile = undefined;
      this.waiting = null;   // a new dab before the last was rated: that one stays unrated (RATE IT in its history)
      this.cooling = null;
    }
    if (on) {
      if (s.preset >= 0 && s.preset <= 5) {
        const ps = rig.presets[s.preset];
        const t = this.celsius ? ps.tempC : ps.tempF;
        if (t !== undefined) this.goal = t;
        if (ps.profile !== undefined) {
          const n = HeatProfile.name(ps.profile);
          this.profile = n.startsWith("Unknown") ? "Unknown" : n;
        }
      }
      this.peak = Math.max(this.peak, temp);
    }
    if (!on && this.wasOn && this.start !== null) {
      const secs = Math.round((now - this.start) / 1000);
      if (secs >= DabWatcher.minSeconds) {
        const dab: JarDab = { id: uid(), at: new Date(this.start).toISOString(), seconds: secs, unit: this.celsius ? "C" : "F" };
        if (this.goal !== undefined) dab.goal = this.goal;
        if (this.peak > 0) dab.peak = this.peak;
        if (this.profile !== undefined) dab.profile = this.profile;
        if (this.goal !== undefined && !Dabs.isFlat(dab) && this.peak > 0 && Math.abs(this.peak - this.goal) >= 3) dab.goalTop = this.peak;
        let jarID: string | null = null;
        const c = this.store.currentID;
        if (c && this.store.addDab(dab, c)) jarID = c;
        const offAt = now;
        this.waiting = { jarID, dab, offAt };
        this.cooling = { jarID, dabID: dab.id, offAt };
        this.later(() => {
          const w = this.waiting;
          if (!w || w.offAt !== offAt || this.wasOn) return;
          this.fire();
        }, DabWatcher.promptDelay);
      }
      this.start = null;
    }
    if (!on && this.cooling && temp <= (this.celsius ? DabWatcher.coolC : DabWatcher.coolF)) {
      const c = this.cooling;
      this.cooling = null;
      const cooled = Math.round((now - c.offAt) / 1000);
      if (c.jarID) this.store.updateDab(c.jarID, c.dabID, d => { d.cooledIn = cooled; });
      if (this.waiting?.dab.id === c.dabID) this.waiting.dab.cooledIn = cooled;
    }
    this.wasOn = on;
  }

  private fire(): void {
    const w = this.waiting;
    if (!w) return;
    this.waiting = null;
    if (w.jarID) this.store.updateDab(w.jarID, w.dab.id, d => { d.asked = true; });
    this.show({ jarID: w.jarID, dab: w.dab });
    try { navigator.vibrate?.(15); } catch { /* fine */ }
  }

  show(p: DabPrompt): void { this.prompt = p; this.onPrompt(); }
  close(): void { this.prompt = null; this.onPrompt(); }
}
