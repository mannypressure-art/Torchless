// Heat-up sound and motion, ported from HeatFX.swift (b85d09fa). Display only: this reads the rig's live
// status (rig.live, sessionOn, presets) and never calls the controller or writes to the rig.
//
// Motion: the approved Heat Motion page (heat-motion.html, built from project files heatfx/app-motion and
// heatfx/motion-prototype/layers; never hand-edit it) runs in a see-through frame over the Home face, the
// same page the iPhone app shows in its web view. This file tells it what the rig is doing (TL.set / TL.ev).
//
// Sound: each look's own sound is made live from code in an AudioWorklet (heat-synth.worklet). Or one of
// Manny's two recorded tracks plays in step with the dab (HeatTrack). Browsers need a tap before audio can
// start, so the audio context is unlocked on the first tap of any kind. Where the browser has
// navigator.audioSession (Safari) it is set to "ambient", like the iPhone app: it follows the silent
// switch and mixes with music already playing. Sound stops when the page is hidden.

import synthSource from "./heat-synth.worklet";
import { RigController } from "../rig/rig-controller";

export const HEAT_SOUNDS = [
  { id: "off", name: "OFF", line: "Silent. Motion and phone taps only." },
  { id: "chimes", name: "CLEAN", line: "Clean, simple motion. Soft music-box notes climb with the heat, a chime at temp." },
  { id: "ember", name: "EMBER", line: "A warm low tone that opens up as it heats, with faint crackle." },
  { id: "ignition", name: "IGNITION", line: "A beat that builds with the temperature and drops at temp." },
  { id: "torch", name: "TORCH", line: "Igniter clicks and a roaring blowtorch with fire on the dial. Glass ticks as it cools." },
  { id: "arcade", name: "ARCADE", line: "8-bit power-up as a little bot eats gold bytes round the dial. Level-up at temp." },
  { id: "reactor", name: "REACTOR", line: "A sci-fi core spinning up, warp boom at temp, radar pings while it holds." },
  { id: "kettle", name: "KETTLE", line: "Bubbles build to a boil and the kettle whistles at temp." },
  { id: "storm", name: "STORM", line: "Rain builds with the heat, thunder and lightning at temp, rain fades as it cools." },
] as const;

/** What plays while the rig heats: the look's own made-from-code sound, or one of Manny's own tracks
 *  (made by him on a paid Suno plan; three short files each: build, main, outro). */
export const HEAT_TRACKS = [
  { id: "look", name: "THE LOOK'S OWN SOUND", line: "Each look plays its own sound, made live from the temperature." },
  { id: "backroom", name: "BACK ROOM", line: "The beat builds while it heats, drops at temp, and sinks away as it cools." },
  { id: "jademoney", name: "JADE MONEY", line: "A slower build, the drop at temp, and the track's own ending for cooldown." },
] as const;

/** Lo-Fi and Zen are shelved (Manny, 2026-11-12). Their synth code stays, but a saved pick of either plays as Clean. */
export const validSound = (id: string | null): string => HEAT_SOUNDS.some(c => c.id === id) ? id! : "chimes";
export const validTrack = (id: string | null): string => HEAT_TRACKS.some(c => c.id === id) ? id! : "look";

export type HeatEvent = "start" | "ready" | "tick" | "done" | "cut" | "sweep" | "cooled";
const enum Phase { idle = 0, preheat = 1, hold = 2, cool = 3 }

const THEMES: Record<string, number> = { off: 0, chimes: 1, ember: 2, ignition: 3, torch: 4, lofi: 5, arcade: 6, reactor: 7, kettle: 8, zen: 9, storm: 10 };
const themeIndex = (t: string) => THEMES[t] ?? 1;

// MARK: Sound engine (main-thread side)

type Msg = { ctl?: [number, number, number, boolean]; ev?: [HeatEvent, number]; pv?: number };

class HeatSound {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private loading: Promise<void> | null = null;
  private waiting: Msg[] = [];
  private busy = false;
  private lastNeed = 0;
  private idleTimer = 0;
  private ctl: [number, number, number, boolean] = [1, 0, 0, false];
  private unlocked = false;
  private previewUntil = 0;
  private torchUntil = 0;
  private lastPhase = Phase.idle;
  private coolSince = -1e9;

  /** The shared audio context, once a tap has made one. The soundtrack plays through it too. */
  context(): AudioContext | null { return this.ctx; }

  /** Called from the first tap of any kind (and every tap after), since audio needs a user gesture. */
  unlock(): void {
    if (!this.ctx) {
      const W = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
      const AC = W.AudioContext ?? W.webkitAudioContext;
      if (!AC) return;
      try {
        const nav = navigator as Navigator & { audioSession?: { type: string } };
        if (nav.audioSession) nav.audioSession.type = "ambient";
      } catch { /* not there */ }
      try { this.ctx = new AC({ latencyHint: "interactive" }); } catch { return; }
      if (!this.ctx.audioWorklet) { this.ctx = null; return; }   // AudioWorklet only (Safari 14.1+, Chrome 66+)
      this.load();
    }
    if (!this.unlocked) {
      // WebKit only lets audio start inside a real activation (touchend/click), so resume here,
      // then park it again if nothing needs sound right now.
      this.unlocked = true;
      const ctx = this.ctx;
      void ctx.resume().then(() => { if (!this.needed()) void ctx.suspend().catch(() => {}); }, () => { this.unlocked = false; });
      return;
    }
    // "interrupted" (a call, Siri) or a suspend we didn't ask for: pick back up on a tap when sound is wanted.
    if (this.ctx.state !== "running" && this.needed()) void this.ctx.resume().catch(() => {});
  }

  private load(): void {
    const ctx = this.ctx!;
    const url = URL.createObjectURL(new Blob([synthSource], { type: "text/javascript" }));
    this.loading = ctx.audioWorklet.addModule(url).then(() => {
      const node = new AudioWorkletNode(ctx, "heat-synth", { numberOfInputs: 0, outputChannelCount: [1] });
      const gain = ctx.createGain();
      gain.gain.value = 0.9;
      node.connect(gain).connect(ctx.destination);
      this.node = node;
      node.port.postMessage({ ctl: this.ctl });
      for (const m of this.waiting) node.port.postMessage(m);
      this.waiting = [];
    }).catch(() => { this.ctx = null; }).finally(() => URL.revokeObjectURL(url));
  }

  private send(m: Msg) { if (this.node) this.node.port.postMessage(m); else if (this.waiting.length < 32) this.waiting.push(m); }
  private needed() { return this.busy || performance.now() - this.lastNeed < 8000; }
  private start() {
    if (!this.ctx || document.visibilityState === "hidden") return;
    if (this.ctx.state !== "running") void this.ctx.resume().catch(() => {});
  }

  /** Torch mode's timer drives the sound while it runs (phase: 0 idle, 1 torch on, 3 cooling). Rig updates wait
   *  until about a second after the last call here, so the two never fight over the controls. */
  torch(theme: string, phase: 0 | 1 | 3, energy: number, lastFive: boolean): void {
    const live = phase !== 0 && themeIndex(theme) !== 0;
    if (live) this.lastNeed = performance.now();   // keeps audio awake through a quiet cool-down, for the cues
    this.torchUntil = 0;
    this.update(theme, phase as Phase, energy, lastFive);
    if (phase !== 0) this.torchUntil = performance.now() + 1200;
    if (live) this.start();
  }
  /** Something else (the soundtrack) is sounding through the context: keep it awake for now. */
  keep(ms = 0): void { this.lastNeed = Math.max(this.lastNeed, performance.now() + ms); this.start(); this.scheduleIdleCheck(); }

  update(theme: string, phase: Phase, energy: number, lastFive: boolean): void {
    if (performance.now() < this.torchUntil) return;   // only ever set by torch() above
    const t = themeIndex(theme);
    const now = performance.now();
    if (phase === Phase.cool && this.lastPhase !== Phase.cool) this.coolSince = now;
    this.lastPhase = phase;
    const next: [number, number, number, boolean] = [t, phase, energy, lastFive];
    if (next.some((v, i) => v !== this.ctl[i])) { this.ctl = next; if (now >= this.previewUntil) this.send({ ctl: next }); }
    const cooling = phase === Phase.cool && now - this.coolSince < 14000;
    this.busy = t !== 0 && (phase === Phase.preheat || phase === Phase.hold || cooling);
    if (this.busy) { this.lastNeed = Math.max(this.lastNeed, now); this.start(); }
    else if (this.ctx?.state === "running" && now - this.lastNeed > 8000) this.stop();
  }

  play(e: HeatEvent, theme: string): void {
    const t = themeIndex(theme);
    if (t === 0) return;
    this.lastNeed = Math.max(this.lastNeed, performance.now());
    // While the page is hidden or audio is parked, drop the moment rather than let a pile of chimes
    // play all at once on resume. The start sound is kept: it is what wakes the audio.
    const running = this.ctx?.state === "running" && document.visibilityState !== "hidden";
    if (running || (e === "start" && document.visibilityState !== "hidden")) this.send({ ev: [e, t] });
    this.start();
    this.scheduleIdleCheck();
  }

  /** Picker preview. Cuts off whatever is still sounding, then plays a short heat-up, hold and cooldown in this sound. */
  preview(theme: string): void {
    this.unlock();
    const t = themeIndex(theme);
    if (t === 0 && !this.ctx) return;
    this.send({ pv: t });
    if (t === 0) { this.previewUntil = 0; this.send({ ctl: this.ctl }); return; }
    this.lastNeed = performance.now() + 11000;   // the preview runs about 11 s
    // The preview overwrites the live controls inside the worklet; send them again when it ends.
    const until = performance.now() + 11300;
    this.previewUntil = until;
    window.setTimeout(() => { if (this.previewUntil === until) { this.previewUntil = 0; this.send({ ctl: this.ctl }); } }, 11400);
    this.start();
    this.scheduleIdleCheck();
  }

  /** Suspends once nothing is playing, even when no status frames arrive (rig not linked). */
  private scheduleIdleCheck() {
    clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      if (this.ctx?.state !== "running" || this.busy) return;
      if (performance.now() - this.lastNeed > 8000) this.stop(); else this.scheduleIdleCheck();
    }, 16000);
  }

  stop(): void {
    if (heatTrack.sounding && document.visibilityState !== "hidden") return;
    if (this.ctx && this.ctx.state === "running") void this.ctx.suspend().catch(() => {});
  }
}

export const heatSound = new HeatSound();

// MARK: Soundtrack (recorded tracks)

interface Part { buf: AudioBuffer; lead: number; len: number }
interface Playing { src: AudioBufferSourceNode; gain: GainNode }

/** Plays a recorded track in step with the dab: "build" loops while heating, "main" starts on the drop the
 *  moment the rig reaches temp and loops through the hold, "outro" plays once when the heat stops.
 *  Same rules as the made-from-code sounds: plays through the same audio context, stops when the page is
 *  hidden. Display side only; it never touches the rig. */
class HeatTrack {
  private parts = new Map<string, Part | null>();
  private fetching = new Map<string, Promise<Part | null>>();
  private current: Playing | null = null;
  private stage = 0;          // 0 silent, 1 build, 2 main, 3 outro, 9 picker preview
  private token = 0;

  get sounding(): boolean { return this.current !== null; }

  private part(name: string): Promise<Part | null> {
    const have = this.fetching.get(name);
    if (have) return have;
    const ctx = heatSound.context();
    if (!ctx) return Promise.resolve(null);
    const p = fetch(`audio/${name}.m4a`).then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status))))
      .then(raw => new Promise<AudioBuffer>((ok, no) => { const q = ctx.decodeAudioData(raw, ok, no); if (q && typeof q.then === "function") q.then(ok, no); }))
      .then(buf => {
        // Some browsers leave the encoder's short silent lead-in on the decoded sound. Skip it, so the
        // drop lands on time and the loop comes round without a gap.
        const d = buf.getChannelData(0);
        const max = Math.min(d.length, Math.floor(buf.sampleRate * 0.06));
        let i = 0;
        while (i < max && Math.abs(d[i]) < 0.0015) i++;
        const lead = i >= max ? 0 : i / buf.sampleRate;
        const exact = TRACK_SECONDS[name];
        const len = exact && lead + exact <= buf.duration + 0.002 ? exact : buf.duration - lead;
        const part: Part = { buf, lead, len };
        this.parts.set(name, part);
        return part as Part | null;
      })
      .catch(() => { this.fetching.delete(name); return null; });
    this.fetching.set(name, p);
    return p;
  }

  /** Fetches a track's three files ahead of the dab, so the drop is not late. */
  warm(track: string): void {
    if (track === "look") return;
    for (const k of ["build", "main", "outro"]) void this.part(`${track}-${k}`);
  }

  /** Called on every status frame from the rig. */
  update(track: string, phase: Phase): void {
    if (track === "look") {
      if (this.stage >= 1 && this.stage <= 3) this.silence(0.3);
      return;
    }
    if (phase === Phase.preheat) { if (this.stage !== 1) this.go(1, track); }
    else if (phase === Phase.hold) { if (this.stage !== 2) this.go(2, track); }
    else if (phase === Phase.cool) { if (this.stage === 1 || this.stage === 2) this.go(3, track); }
    else if (this.stage === 1 || this.stage === 2) this.silence(0.6);
    if (this.stage !== 0) heatSound.keep();
  }

  private fadeOut(p: Playing | null, seconds: number) {
    if (!p) return;
    const ctx = heatSound.context();
    try {
      if (!ctx || seconds <= 0) { p.src.stop(); return; }
      const now = ctx.currentTime;
      p.gain.gain.cancelScheduledValues(now);
      p.gain.gain.setValueAtTime(p.gain.gain.value, now);
      p.gain.gain.linearRampToValueAtTime(0, now + seconds);
      p.src.stop(now + seconds + 0.05);
    } catch { /* already stopped */ }
  }

  private go(s: number, track: string) {
    const ctx = heatSound.context();
    if (!ctx || document.visibilityState === "hidden") return;
    this.token += 1;
    const mine = this.token;
    const asked = performance.now();
    this.stage = s;
    heatSound.keep(1500);
    const names = s === 1 ? [`${track}-build`, `${track}-main`] : s === 3 ? [`${track}-outro`] : [`${track}-main`];
    this.warm(track);
    void Promise.all(names.map(n => this.part(n))).then(found => {
      if (this.token !== mine) return;
      const part = found.find(x => x !== null) ?? null;
      const late = (performance.now() - asked) / 1000;
      // The outro is a fade-away: if its file only arrives seconds later, silence is better than a late start.
      if (!part || (s === 3 && late > 2)) { this.silence(0.5); return; }
      const old = this.current;
      const src = ctx.createBufferSource();
      const gain = ctx.createGain();
      src.buffer = part.buf;
      const loops = s === 1 || s === 2;
      if (loops) { src.loop = true; src.loopStart = part.lead; src.loopEnd = part.lead + part.len; }
      src.connect(gain).connect(ctx.destination);
      const me: Playing = { src, gain };
      src.onended = () => { if (this.current === me) { this.current = null; this.stage = 0; } };
      this.current = me;
      this.fadeOut(old, s === 2 ? 0.06 : 0.5);
      try { if (loops) src.start(0, part.lead); else src.start(0, part.lead, part.len); } catch { this.current = null; this.stage = 0; return; }
      heatSound.keep(s === 9 ? 9500 : s === 3 ? part.len * 1000 : 1500);
    });
  }

  silence(seconds: number): void {
    this.token += 1;
    const old = this.current;
    this.current = null;
    this.stage = 0;
    this.fadeOut(old, seconds);
  }

  /** Picker preview: about eight seconds from the drop. "look" just stops a preview that is playing. */
  preview(track: string): void {
    heatSound.unlock();
    if (this.stage >= 1 && this.stage <= 3) return;       // a dab is playing the real thing
    if (track === "look") { if (this.stage === 9) this.silence(0.2); return; }
    this.go(9, track);
    const mine = this.token;
    window.setTimeout(() => { if (this.token === mine && this.stage === 9) this.silence(1.0); }, 8000);
  }

  stopPreview(): void { if (this.stage === 9) this.silence(0.15); }
}

/** Exact lengths of the cut files (project files heatfx/soundtrack), for a gap-free loop. */
const TRACK_SECONDS: Record<string, number> = {
  "backroom-build": 10.773991, "backroom-main": 29.629002, "backroom-outro": 11.38,
  "jademoney-build": 16.748005, "jademoney-main": 30.146009, "jademoney-outro": 11.0,
};

export const heatTrack = new HeatTrack();

// MARK: Haptics (Android only; iPhone browsers have no vibration)

const buzz = (p: number | number[]) => { try { navigator.vibrate?.(p); } catch { /* fine */ } };
const Haptics = {
  light: () => buzz(10),
  heavy: () => buzz(45),
  success: () => buzz([18, 70, 28]),
  done: () => buzz([25, 150, 25]),
};

// MARK: What the rig is doing, turned into moments

interface MotionWindow extends Window { TL?: { set(o: Record<string, unknown>): void; ev(name: string): void } }

export class HeatFX {
  private phase = Phase.idle;
  private energyGoal = 0;
  private wasOn = false;
  private wasConnected = false;
  private readyFired = false;
  private startRemaining = 0;
  private lastRemaining = 0;
  private lastTick = 99;
  private lastFive = false;
  private tempFracGoal = 0;
  private coolFrac = 0;
  private holdFrac = 0;
  private tempNow = 70;
  private targetNow = 520;

  private frame: HTMLIFrameElement;
  private ready = false;
  private pending: Record<string, unknown> | null = null;
  private reduce: MediaQueryList;

  constructor(host: HTMLElement, private look: () => string, private track: () => string, private face: () => string) {
    // The page that draws the motion: see-through, takes no touches, hidden from screen readers.
    this.frame = document.createElement("iframe");
    this.frame.className = "heatFX";
    this.frame.setAttribute("aria-hidden", "true");
    this.frame.setAttribute("tabindex", "-1");
    this.frame.setAttribute("title", "");
    this.frame.addEventListener("load", () => {
      this.ready = !!this.win()?.TL;
      if (this.ready && this.pending) { const o = this.pending; this.pending = null; this.state(o); }
    });
    this.frame.src = "heat-motion.html";
    host.append(this.frame);
    this.reduce = matchMedia("(prefers-reduced-motion: reduce)");
    const left = () => { heatTrack.silence(0); heatSound.stop(); };
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") left(); });
    window.addEventListener("pagehide", left);
  }

  private win(): MotionWindow | null { try { return this.frame.contentWindow as MotionWindow | null; } catch { return null; } }
  /** Latest rig state. Kept until the page has loaded, so nothing is lost at launch. */
  private state(o: Record<string, unknown>) {
    if (!this.ready) { this.pending = o; return; }
    try { this.win()?.TL?.set(o); } catch { /* the page only draws; a miss is one frame */ }
  }
  private event(name: string) { if (this.ready) { try { this.win()?.TL?.ev(name); } catch { /* same */ } } }

  /** Called on every rig change. */
  update(rig: RigController): void {
    const look = validSound(this.look()), track = validTrack(this.track());
    // with a recorded track picked, the look keeps its motion and the made-from-code sound stays quiet
    const theme = track === "look" ? look : "off";
    const connected = rig.connected;
    if (connected && !this.wasConnected && rig.live) {
      this.event("sweep");
      heatSound.play("sweep", theme);
      heatTrack.warm(track);
    }
    this.wasConnected = connected && !!rig.live;
    const s = rig.live;
    if (!s || !rig.linkFresh) {
      // No fresh word from the rig: go quiet rather than keep playing on old news.
      // The web also rests the motion (HeatFX.swift leaves it running), so the page stops drawing.
      heatSound.update(theme, Phase.idle, 0, false);
      heatTrack.update(track, Phase.idle);
      if (this.phase !== Phase.idle) { this.phase = Phase.idle; this.energyGoal = 0; this.push(look); }
      return;
    }
    const on = rig.sessionOn;
    const celsius = s.unitByte === 12;
    const room = celsius ? 21 : 70;
    const lo = celsius ? 100 : 200, hi = celsius ? 350 : 700;
    let target: number | null = null;
    if (s.preset >= 0 && s.preset <= 5) {
      const ps = rig.presets[s.preset];
      const t = celsius ? ps?.tempC : ps?.tempF;
      if (t !== undefined && t !== null) target = t;
    }
    const temp = s.tempRaw;
    this.tempNow = temp;
    if (target !== null) this.targetNow = target;
    this.tempFracGoal = Math.min(1, Math.max(0, (temp - lo) / (hi - lo)));
    const remaining = s.sessionTimeRemaining;

    if (on && !this.wasOn) {
      this.phase = Phase.preheat;
      this.readyFired = false;
      this.startRemaining = remaining;
      this.lastTick = 99;
      heatSound.play("start", theme);
      Haptics.light();
    }
    if (on && this.wasOn && this.phase === Phase.idle) this.phase = this.readyFired ? Phase.hold : Phase.preheat;   // link back mid-dab
    if (on) {
      if (!this.readyFired) {
        const atTemp = target !== null && temp >= target - 4;
        if (remaining < this.startRemaining || atTemp) {
          this.readyFired = true;
          this.phase = Phase.hold;
          heatSound.play("ready", theme);
          Haptics.success();
        }
      }
      if (this.readyFired) {
        if (remaining > this.lastRemaining + 5) { this.lastTick = 99; this.startRemaining = Math.max(this.startRemaining, remaining); }   // +10s
        if (remaining >= 1 && remaining <= 5 && remaining < this.lastTick) {
          this.lastTick = remaining;
          heatSound.play("tick", theme);
          this.event("tick");
        }
        this.holdFrac = this.startRemaining > 0 ? Math.min(1, remaining / this.startRemaining) : 0;
      }
      if (target !== null && target > room) this.energyGoal = this.readyFired ? 1 : Math.min(1, Math.max(0, (temp - room) / (target - room)));
      else this.energyGoal = this.readyFired ? 1 : 0.5;
    }
    if (!on && this.wasOn) {
      if (this.lastRemaining <= 2) { heatSound.play("done", theme); Haptics.done(); }
      else { heatSound.play("cut", theme); Haptics.heavy(); }
      this.phase = Phase.cool;
      this.energyGoal = 0;
    }
    if (!on) {
      this.coolFrac = target !== null && target > room + 50 ? Math.min(1, Math.max(0, (temp - room - 50) / (target - room - 50))) : 0;
    }
    if (!on && this.phase === Phase.cool && temp < room + 50) {
      this.phase = Phase.idle;
      heatSound.play("cooled", theme);
      Haptics.light();
    }
    if (!on) this.energyGoal = 0;
    this.wasOn = on;
    this.lastRemaining = remaining;
    this.lastFive = this.readyFired && remaining <= 5;
    const soundEnergy = this.phase === Phase.cool ? this.coolFrac : this.energyGoal;
    heatSound.update(theme, this.phase, soundEnergy, this.lastFive);
    heatTrack.update(track, this.phase);
    this.push(look);
  }

  /** Tells the page what the rig is doing. The page works out the moments (at temp, done, cool again)
   *  from the phase changes and eases between updates. */
  private push(theme: string) {
    const look = theme !== "off" && theme !== "chimes" ? theme : "clean";
    const n = (v: number) => Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0;
    this.state({
      look, reduce: this.reduce.matches, R: this.face() === "gauge" ? 126 : 114,
      phase: this.phase, energy: n(this.energyGoal), temp: n(this.tempNow), target: n(this.targetNow),
      tempFrac: n(this.tempFracGoal), holdFrac: n(this.holdFrac), holdDur: Math.max(1, this.startRemaining),
      secondsLeft: Math.max(0, this.lastRemaining), coolFrac: n(this.coolFrac), lastFive: this.lastFive,
    });
  }
}
