// Heat-up sound and motion, ported from HeatFX.swift (3e4eb24a). Display only: this reads the rig's live
// status (rig.live, sessionOn, presets) and never calls the controller or writes to the rig.
//
// Sound is made live from code in an AudioWorklet (heat-synth.worklet). Browsers need a tap before audio
// can start, so the audio context is unlocked on the first tap of any kind. Where the browser has
// navigator.audioSession (Safari) it is set to "ambient", like the iPhone app: it follows the silent
// switch and mixes with music already playing. Sound stops when the page is hidden.

import synthSource from "./heat-synth.worklet";
import { RigController } from "../rig/rig-controller";

export const HEAT_SOUNDS = [
  { id: "off", name: "OFF", line: "Silent. Motion and phone taps only." },
  { id: "chimes", name: "CHIMES", line: "A chime at temp, ticks in the last five seconds, a chord when done." },
  { id: "ember", name: "EMBER", line: "A warm low tone that opens up as it heats, with faint crackle." },
  { id: "ignition", name: "IGNITION", line: "A beat that builds with the temperature and drops at temp." },
  { id: "torch", name: "TORCH", line: "Igniter clicks and a roaring blowtorch with fire on the dial. Glass ting at temp." },
] as const;

export type HeatEvent = "start" | "ready" | "tick" | "done" | "cut" | "sweep";
const enum Phase { idle = 0, preheat = 1, hold = 2, cool = 3 }

const themeIndex = (t: string) => t === "off" ? 0 : t === "ember" ? 2 : t === "ignition" ? 3 : t === "torch" ? 4 : 1;

// MARK: Sound engine (main-thread side)

type Msg = { ctl?: [number, number, number, boolean]; ev?: [HeatEvent, number]; pv?: number };

class HeatSound {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private loading: Promise<void> | null = null;
  private waiting: Msg[] = [];
  private heating = false;
  private lastNeed = 0;
  private idleTimer = 0;
  private ctl: [number, number, number, boolean] = [1, 0, 0, false];

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
      if (!this.needed()) void this.ctx.suspend().catch(() => {});
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
  private needed() { return this.heating || performance.now() - this.lastNeed < 8000; }
  private start() {
    if (!this.ctx || document.visibilityState === "hidden") return;
    if (this.ctx.state !== "running") void this.ctx.resume().catch(() => {});
  }

  update(theme: string, phase: Phase, energy: number, lastFive: boolean): void {
    const t = themeIndex(theme);
    const next: [number, number, number, boolean] = [t, phase, energy, lastFive];
    if (next.some((v, i) => v !== this.ctl[i])) { this.ctl = next; this.send({ ctl: next }); }
    this.heating = phase === Phase.preheat || phase === Phase.hold;
    if (t !== 0 && this.heating) { this.lastNeed = performance.now(); this.start(); }
    else if (this.ctx?.state === "running" && performance.now() - this.lastNeed > 8000) this.stop();
  }

  play(e: HeatEvent, theme: string): void {
    const t = themeIndex(theme);
    if (t === 0) return;
    this.send({ ev: [e, t] });
    this.lastNeed = performance.now();
    this.start();
    this.scheduleIdleCheck();
  }

  /** Picker preview. Cuts off whatever is still sounding, then plays a short heat-up in this sound. */
  preview(theme: string): void {
    this.unlock();
    const t = themeIndex(theme);
    if (t === 0 && !this.ctx) return;
    this.send({ pv: t });
    this.lastNeed = performance.now() + 7000;   // the preview runs about 7 s
    this.start();
    this.scheduleIdleCheck();
  }

  /** Suspends once nothing is playing, even when no status frames arrive (rig not linked). */
  private scheduleIdleCheck() {
    clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      if (this.ctx?.state === "running" && !this.heating && performance.now() - this.lastNeed > 8000) this.stop();
    }, 16000);
  }

  stop(): void { if (this.ctx && this.ctx.state === "running") void this.ctx.suspend().catch(() => {}); }
}

export const heatSound = new HeatSound();

// MARK: Haptics (Android only; iPhone browsers have no vibration)

const buzz = (p: number | number[]) => { try { navigator.vibrate?.(p); } catch { /* fine */ } };
const Haptics = {
  light: () => buzz(10),
  heavy: () => buzz(45),
  success: () => buzz([18, 70, 28]),
  done: () => buzz([25, 150, 25]),
};

// MARK: Sprites (soft dots drawn once, then stamped with "lighter")

function sprite(rgb: string, stops: [number, number][]): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  for (const [at, a] of stops) g.addColorStop(at, `rgba(${rgb},${a})`);
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  return c;
}
let SPR: Record<string, HTMLCanvasElement> | null = null;
function sprites() {
  if (SPR) return SPR;
  const ember = [[0, 1], [0.33, 0.25], [1, 0]] as [number, number][];
  const flame = [[0, 1], [1, 0]] as [number, number][];
  SPR = {
    emberHot: sprite("255,230,110", ember), emberCool: sprite("255,190,110", ember), emberCyan: sprite("120,240,255", ember),
    f0: sprite("255,240,191", flame), f1: sprite("255,161,46", flame), f2: sprite("230,69,20", flame), f3: sprite("120,31,10", flame),
  };
  return SPR;
}

// MARK: What the rig is doing, turned into moments (HeatFXModel)

interface Ember { x: number; y: number; vx: number; vy: number; life: number; max: number; s: number; cyan: boolean; ph: number }
interface Flame { x: number; y: number; vx: number; vy: number; life: number; max: number; s: number }

const LIVE = "25,227,255", GOLD = "232,178,74";

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
  private sessionStart = -1e9;

  private energy = 0;
  private fire = 0;
  private glassGlow = 0;
  private embers: Ember[] = [];
  private flames: Flame[] = [];
  private shocks: number[] = [];
  private sweepAge: number | null = null;
  private holdFrac = 0;
  private lastFrame: number | null = null;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private reduce: MediaQueryList;

  constructor(host: HTMLElement, private theme: () => string, private face: () => string) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "heatFX";
    this.canvas.setAttribute("aria-hidden", "true");
    host.append(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this.reduce = matchMedia("(prefers-reduced-motion: reduce)");
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") { heatSound.stop(); this.halt(); }
      else this.kick();
    });
    window.addEventListener("pagehide", () => heatSound.stop());
  }

  /** Called on every rig change. */
  update(rig: RigController): void {
    const theme = this.theme();
    const connected = rig.connected;
    if (connected && !this.wasConnected && rig.live) {
      this.sweepAge = 0;
      heatSound.play("sweep", theme);
    }
    this.wasConnected = connected && !!rig.live;
    const s = rig.live;
    if (!s || !rig.linkFresh) {
      // No fresh word from the rig: go quiet rather than keep playing on old news.
      heatSound.update(theme, Phase.idle, 0, false);
      return;
    }
    const on = rig.sessionOn;
    const celsius = s.unitByte === 12;
    const room = celsius ? 21 : 70;
    let target: number | null = null;
    if (s.preset >= 0 && s.preset <= 5) {
      const ps = rig.presets[s.preset];
      const t = celsius ? ps?.tempC : ps?.tempF;
      if (t !== undefined) target = t;
    }
    const temp = s.tempRaw;
    const remaining = s.sessionTimeRemaining;

    if (on && !this.wasOn) {
      this.phase = Phase.preheat;
      this.readyFired = false;
      this.startRemaining = remaining;
      this.lastTick = 99;
      this.sessionStart = performance.now();
      heatSound.play("start", theme);
      Haptics.light();
    }
    if (on) {
      if (!this.readyFired) {
        const atTemp = target !== null && temp >= target - 4;
        if (remaining < this.startRemaining || atTemp) {
          this.readyFired = true;
          this.phase = Phase.hold;
          this.shocks.push(0, -0.14);
          heatSound.play("ready", theme);
          Haptics.success();
        }
      }
      if (this.readyFired) {
        if (remaining > this.lastRemaining + 5) { this.lastTick = 99; this.startRemaining = Math.max(this.startRemaining, remaining); }   // +10s
        if (remaining >= 1 && remaining <= 5 && remaining < this.lastTick) {
          this.lastTick = remaining;
          heatSound.play("tick", theme);
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
    if (!on && this.phase === Phase.cool && temp < room + 50) this.phase = Phase.idle;
    if (!on) this.energyGoal = 0;
    this.wasOn = on;
    this.lastRemaining = remaining;
    this.lastFive = this.readyFired && remaining <= 5;
    heatSound.update(theme, this.phase, this.energyGoal, this.lastFive);
    if (this.phase === Phase.preheat || this.phase === Phase.hold || this.sweepAge !== null || this.shocks.length) this.kick();
  }

  // MARK: frames (requestAnimationFrame only while something is moving and the page is showing)

  private kick() {
    if (this.raf || document.visibilityState === "hidden") return;
    this.raf = requestAnimationFrame(t => this.frame(t));
  }
  private halt() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; this.lastFrame = null; }
  private frame(now: number) {
    this.raf = 0;
    const c = this.canvas;
    const w = c.clientWidth, h = c.clientHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const busy = w > 0 ? this.draw(ctx, w, h, now) : false;
    if (busy) this.kick(); else { this.lastFrame = null; ctx.clearRect(0, 0, w, h); }
  }

  private draw(ctx: CanvasRenderingContext2D, w: number, h: number, nowMs: number): boolean {
    const now = nowMs / 1000;
    const dt = Math.min(0.05, Math.max(0, now - (this.lastFrame ?? now)));
    this.lastFrame = now;
    const reduce = this.reduce.matches;
    const theme = this.theme();
    const gauge = this.face() === "gauge";
    const cx = w / 2, cy = h / 2;
    const R = gauge ? 126 : Math.min(w, h) * 0.38;
    const heating = this.phase === Phase.preheat || this.phase === Phase.hold;
    const r = Math.random;
    const S = sprites();
    ctx.globalCompositeOperation = "lighter";

    this.energy += (this.energyGoal - this.energy) * Math.min(1, dt * (this.energyGoal > this.energy ? 3 : 1.2));
    const fireGoal = theme === "torch" && this.phase === Phase.preheat && nowMs - this.sessionStart > 250 ? 1 : 0;
    this.fire += (fireGoal - this.fire) * Math.min(1, dt * (fireGoal > this.fire ? 6 : 2.2));
    if (this.fire > 0.05) this.glassGlow = Math.min(1, this.glassGlow + dt * 0.5 * this.fire);
    else this.glassGlow = Math.max(0, this.glassGlow - dt * 0.12);
    const e = this.energy;

    // heat bloom
    if (e > 0.01) {
      const g = ctx.createRadialGradient(cx, cy + R * 0.3, 0, cx, cy + R * 0.3, R * 1.7);
      g.addColorStop(0, `rgba(${LIVE},${0.14 * e})`);
      g.addColorStop(0.5, `rgba(${GOLD},${0.05 * e})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    // embers
    if (!reduce) {
      let n = Math.pow(e, 1.6) * 46 * (heating ? 1 : 0.3) * dt;
      while (n > 0) {
        if (r() < n) {
          const a = r() * Math.PI * 2, rr = R * (0.6 + r() * 0.5);
          this.embers.push({ x: cx + Math.cos(a) * rr * 1.2, y: cy + Math.abs(Math.sin(a)) * rr * 0.6 + R * 0.2,
            vx: (r() - 0.5) * 14, vy: -(22 + r() * 46), life: 0, max: 1.4 + r() * 1.8, s: 0.8 + r() * 1.8, cyan: r() < 0.18, ph: r() * 6 });
        }
        n -= 1;
      }
      for (const m of this.embers) {
        m.life += dt;
        m.x += (m.vx + Math.sin(m.life * 3 + m.ph) * 10) * dt;
        m.y += m.vy * dt;
      }
      this.embers = this.embers.filter(m => m.life < m.max && m.y >= -10);
    } else this.embers = [];
    for (const m of this.embers) {
      const k = m.life / m.max, a = Math.sin(Math.PI * Math.min(1, k * 1.2)) * 0.9;
      const rad = m.s * (1 - k * 0.5);
      ctx.globalAlpha = Math.max(0, a);
      ctx.drawImage(m.cyan ? S.emberCyan : k < 0.5 ? S.emberHot : S.emberCool, m.x - rad * 3, m.y - rad * 3, rad * 6, rad * 6);
    }
    ctx.globalAlpha = 1;

    // torch fire: flames hug the rim (gauge) or rise from the bottom (other faces)
    const hitX = cx + R * 0.18, hitY = gauge ? cy + R + 4 : h - 6;
    if (!reduce) {
      let n = this.fire * 280 * dt;
      while (n > 0) {
        if (r() < n) {
          const side = r() < 0.5 ? -1 : 1;
          const x0 = gauge ? hitX + (r() - 0.5) * 16 : r() * w;
          this.flames.push({ x: x0, y: hitY + (r() - 0.5) * 6, vx: gauge ? side * (70 + r() * 110) : (r() - 0.5) * 40, vy: -(30 + r() * 70),
            life: 0, max: 0.7 + r() * 0.8, s: 5 + r() * 6 });
        }
        n -= 1;
      }
      for (const f of this.flames) {
        f.life += dt;
        f.vy -= 330 * dt;
        f.vx *= 0.975;
        f.x += f.vx * dt + (r() - 0.5) * 30 * dt;
        f.y += f.vy * dt;
        if (gauge) {
          const dx = f.x - cx, dy = f.y - cy, d = Math.hypot(dx, dy), lo = R + 9;
          if (d < lo && d > 0) { f.x = cx + dx / d * lo; f.y = cy + dy / d * lo; }
        }
      }
      this.flames = this.flames.filter(f => f.life < f.max);
    } else this.flames = [];
    for (const f of this.flames) {
      const k = f.life / f.max, rad = f.s * (1 + k * 2.4);
      ctx.globalAlpha = Math.max(0, (1 - k) * 0.75);
      ctx.drawImage(k < 0.18 ? S.f0 : k < 0.45 ? S.f1 : k < 0.75 ? S.f2 : S.f3, f.x - rad, f.y - rad, rad * 2, rad * 2);
    }
    ctx.globalAlpha = 1;
    ctx.lineCap = "round";

    const arc = (rad: number, a0: number, a1: number, color: string, width: number) => {
      ctx.beginPath(); ctx.arc(cx, cy, rad, a0, a1); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
    };
    const deg = (d: number) => d * Math.PI / 180;

    if (gauge) {
      // glass glowing where the torch hit it
      if (this.glassGlow > 0.01) {
        const gg = this.glassGlow, mid = Math.atan2(R + 6, R * 0.18);
        arc(R + 4, mid - 0.5 - gg * 0.5, mid + 0.5 + gg * 0.5, `rgba(255,110,31,${0.25 * gg})`, 18);
        arc(R + 4, mid - 0.5 - gg * 0.5, mid + 0.5 + gg * 0.5, `rgba(255,${Math.round(120 + 80 * gg)},41,${0.75 * gg})`, 7);
        arc(R + 4, mid - 0.25, mid + 0.25, `rgba(255,235,191,${0.6 * gg * gg})`, 3);
      }
      // hold ring: runs down the hold time
      if (this.phase === Phase.hold) {
        const ringR = R + 12, last = this.lastFive;
        ctx.globalCompositeOperation = "source-over";
        ctx.lineCap = "butt";
        arc(ringR, 0, Math.PI * 2, `rgba(${GOLD},0.15)`, 3);
        ctx.lineCap = "round";
        if (this.holdFrac > 0.002) {
          const end = deg(-90 + 360 * this.holdFrac);
          const pulse = last && !reduce ? 0.55 + 0.45 * Math.abs(Math.sin(Date.now() / 1000 * Math.PI)) : 1;
          if (last && !reduce) { ctx.globalCompositeOperation = "lighter"; arc(ringR, deg(-90), end, `rgba(${GOLD},${0.3 * pulse})`, 10); ctx.globalCompositeOperation = "source-over"; }
          arc(ringR, deg(-90), end, `rgba(${GOLD},${pulse})`, 3);
        }
        ctx.globalCompositeOperation = "lighter";
      }
      // link sweep: a light runs up the dial and back
      if (this.sweepAge !== null) {
        const a = this.sweepAge + dt;
        this.sweepAge = a < 1.9 ? a : null;
        if (!reduce && a < 1.9) {
          const x = a < 0.75 ? 1 - Math.pow(1 - a / 0.75, 3) : a < 1.0 ? 1 : 1 - Math.pow((a - 1.0) / 0.9, 2);
          if (x > 0.01) {
            arc(R - 2, deg(135), deg(135 + 270 * x), `rgba(${LIVE},0.25)`, 9);
            arc(R - 2, deg(135), deg(135 + 270 * x), `rgba(${LIVE},0.85)`, 3);
          }
        }
      }
    } else if (this.sweepAge !== null) {
      this.sweepAge = this.sweepAge + dt < 1.9 ? this.sweepAge + dt : null;
    }

    // at-temp shockwave
    if (this.shocks.length) {
      this.shocks = this.shocks.map(a => a + dt).filter(a => a <= 0.9);
      if (!reduce) for (const age of this.shocks) {
        if (age <= 0) continue;
        const a = Math.max(0, 1 - age * 1.1), rr = R + age * 1.6 * R * 0.9;
        ctx.lineCap = "butt";
        arc(rr, 0, Math.PI * 2, `rgba(${LIVE},${a})`, 2 + 4 * a);
      }
    }

    // torch jet, from the bottom right corner into the glass
    if (this.fire > 0.02) {
      const jx = w + 10, jy = h + 4;
      const dx = hitX - jx, dy = hitY - jy, L = Math.hypot(dx, dy);
      const flick = reduce ? 1 : 0.92 + r() * 0.1;
      const len = L * flick * Math.min(1, this.fire * 1.3);
      const a = this.fire;
      ctx.save();
      ctx.translate(jx, jy);
      ctx.rotate(Math.atan2(dy, dx));
      const cone = (l: number, wd: number, c0: string, c1: string) => {
        ctx.beginPath();
        ctx.moveTo(0, -wd * 0.35);
        ctx.quadraticCurveTo(l * 0.6, -wd, l, 0);
        ctx.quadraticCurveTo(l * 0.6, wd, 0, wd * 0.35);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, 0, l, 0);
        g.addColorStop(0, c0); g.addColorStop(1, c1);
        ctx.fillStyle = g; ctx.fill();
      };
      cone(len, 22, `rgba(110,120,255,${0.18 * a})`, "rgba(0,0,0,0)");
      cone(len, 13, `rgba(110,120,255,${0.35 * a})`, `rgba(255,140,61,${0.25 * a})`);
      cone(len * 0.55, 6, `rgba(171,230,255,${0.95 * a})`, `rgba(79,140,255,${0.5 * a})`);
      cone(len * 0.22, 3, `rgba(255,255,255,${a})`, `rgba(191,240,255,${0.6 * a})`);
      ctx.restore();
    }
    ctx.globalCompositeOperation = "source-over";

    return heating || this.embers.length > 0 || this.flames.length > 0 || this.sweepAge !== null || this.shocks.length > 0
      || this.glassGlow > 0.01 || this.energy > 0.01;
  }
}
