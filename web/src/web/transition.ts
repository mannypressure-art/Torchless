// Full-screen mode transitions (front page -> rig Home, torch timer, jars). Display only.
// CONTRACT (do not change the signature): cover the screen, call swap() once while fully covered, reveal, resolve.
//
// Three code-drawn scenes on one canvas overlay, in the same family as heatfx.ts (soft sprites stamped
// with "lighter", nested flame cones, cyan gauge arcs):
//   torch  igniter spark at the tapped element, a blue-cored jet, fire eats the page, then burns away
//   rig    a cyan ring bursts from the tapped element, the gauge powers up (ticks sweep 270 degrees,
//          the needle pegs), then the view flies through the dial
//   jars   a gold iris closes, a jar lid unscrews with the mark on it, pops, and the iris opens
// The scenes are always dark, like a title card. Revealing a bright page is done as a wipe with a
// fading dark veil inside the opening, so there is no hard cut from black to white.
//
// Timing is by the clock (performance.now), never by frame count. A long frame only advances the
// scene by MAX_STEP, so a slow swap() cannot make the reveal skip.
//
// VIDEO SLOT. Put a URL in CLIPS to play a clip for that kind instead of the drawn scene.
// Clip spec:
//   - portrait 9:16 (1080x1920, or 720x1280 to save weight); it is shown with object-fit: cover, so
//     keep the action in the middle 80% of the frame
//   - about 1.2 s long (1.0 to 1.4), 30 fps, no audio track
//   - H.264 MP4 (yuv420p, "faststart" so it plays before it has fully loaded), under 1.5 MB
//   - first and last frames on near-black (#060708); the page is swapped at 55% of the clip, so the
//     frame there, and about 0.1 s either side of it, must cover the whole screen
//   - no strobing, and no baked-in logos, marks or product shots of any other brand
// If the clip has not started within 300 ms, or errors, the drawn scene plays instead.

export type TransitionKind = "rig" | "torch" | "jars";

export const CLIPS: Partial<Record<TransitionKind, string>> = {};

const BG = "#060708", BG_RGB = "6,7,8";
const LIVE = "25,227,255", GOLD = "232,178,74";
const MAX_STEP = 50;          // ms a single frame may advance the scene
const CLIP_START_MS = 300;    // a clip must be playing by then, or the drawn scene runs
const REDUCED_MS = 180;
const TAU = Math.PI * 2;

// MARK: small maths

const clamp01 = (v: number) => v < 0 ? 0 : v > 1 ? 1 : v;
const seg = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const easeOut = (p: number) => 1 - Math.pow(1 - p, 3);
const easeIn = (p: number) => p * p * p;
const easeInOut = (p: number) => p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
const easeOutBack = (p: number) => { const c = 1.9; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); };
const deg = (d: number) => d * Math.PI / 180;
const rnd = Math.random;
const farCorner = (x: number, y: number, w: number, h: number) =>
  Math.max(Math.hypot(x, y), Math.hypot(w - x, y), Math.hypot(x, h - y), Math.hypot(w - x, h - y));

// MARK: shared drawing

type Ctx = CanvasRenderingContext2D;

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
const SOFT: [number, number][] = [[0, 1], [1, 0]];
const PUFF: [number, number][] = [[0, 0.85], [0.3, 0.42], [0.65, 0.1], [1, 0]];
const DOT: [number, number][] = [[0, 1], [0.33, 0.25], [1, 0]];

function ring(ctx: Ctx, x: number, y: number, r: number, color: string, width: number, a0 = 0, a1 = TAU) {
  if (r <= 0) return;
  ctx.beginPath(); ctx.arc(x, y, r, a0, a1); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
}

function bloom(ctx: Ctx, x: number, y: number, r: number, rgb: string, a: number) {
  if (a <= 0.003 || r <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(${rgb},${a})`);
  g.addColorStop(0.45, `rgba(${rgb},${a * 0.32})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

/** The Torchless mark: a T inside a gauge ring that is open at the top. Drawn here, in gold. */
function drawMark(ctx: Ctx, x: number, y: number, r: number, alpha: number, rgb = GOLD) {
  if (alpha <= 0.004 || r <= 0) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.lineCap = "round";
  ring(ctx, x, y, r, `rgb(${rgb})`, Math.max(1, r * 0.11), deg(-60), deg(240));
  ctx.fillStyle = `rgb(${rgb})`;
  const bar = r * 0.78, th = r * 0.2, top = y - r * 0.46, bottom = y + r * 0.5;
  ctx.fillRect(x - bar / 2, top, bar, th);
  ctx.fillRect(x - th / 2, top, th, bottom - top);
  ctx.restore();
}

interface Scene {
  dur: number;      // whole length, ms
  swapAt: number;   // the screen is fully covered at this time
  hitAt: number;    // the beat (a short buzz on phones that have one)
  draw(ctx: Ctx, t: number, dt: number): void;
}
type SceneMaker = (w: number, h: number, ox: number, oy: number) => Scene;

// MARK: torch

interface Flame { x: number; y: number; vx: number; vy: number; life: number; max: number; s: number }
interface Ember { x: number; y: number; vx: number; vy: number; life: number; max: number; s: number; ph: number }
interface Spark { x: number; y: number; vx: number; vy: number; life: number; max: number }

const torchScene: SceneMaker = (w, h, ox, oy) => {
  const IGNITE = 140, COVERED = 520, BURN = 670, BURNT = 1190, DUR = 1250;
  const S = {
    f0: sprite("255,240,191", PUFF), f1: sprite("255,161,46", PUFF), f2: sprite("230,69,20", PUFF), f3: sprite("120,31,10", PUFF),
    hot: sprite("255,230,110", DOT), cool: sprite("255,170,90", DOT), blue: sprite("120,190,255", SOFT),
    violet: sprite("96,112,255", SOFT), white: sprite("236,248,255", SOFT),
  };

  // The jet points from the tapped element at the corner furthest from it.
  const corners: [number, number][] = [[w, 0], [0, 0], [w, h], [0, h]];
  let best = corners[0], bestD = -1;
  for (const c of corners) { const d = Math.hypot(c[0] - ox, c[1] - oy); if (d > bestD + 0.5) { bestD = d; best = c; } }
  const ux = (best[0] - ox) / bestD, uy = (best[1] - oy) / bestD;
  const AHEAD = 2.3;   // the fire runs this much faster along the jet than behind it
  const metric = (px: number, py: number) => {
    const a = px * ux + py * uy, b = px * uy - py * ux;
    const al = a > 0 ? a / AHEAD : a;
    return Math.hypot(al, b);
  };
  let maxM = 1;
  for (const c of [[0, 0], [w, 0], [0, h], [w, h]]) maxM = Math.max(maxM, metric(c[0] - ox, c[1] - oy));

  // A small mask the fire is worked out on, then stretched over the screen (soft edges for free).
  const ms = Math.max(2, Math.sqrt(w * h / 84000));
  const mw = Math.ceil(w / ms), mh = Math.ceil(h / ms);
  const mask = document.createElement("canvas");
  mask.width = mw; mask.height = mh;
  const mctx = mask.getContext("2d")!;
  const img = mctx.createImageData(mw, mh);
  const px = new Uint32Array(img.data.buffer);

  const G = 48, grid = new Float32Array(G * G);
  for (let i = 0; i < grid.length; i++) grid[i] = rnd();
  const noise = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    let fx = x - xi, fy = y - yi;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const x0 = ((xi % G) + G) % G, y0 = ((yi % G) + G) % G, x1 = (x0 + 1) % G, y1 = (y0 + 1) % G;
    return lerp(lerp(grid[y0 * G + x0], grid[y0 * G + x1], fx), lerp(grid[y1 * G + x0], grid[y1 * G + x1], fx), fy);
  };
  const vIn = new Float32Array(mw * mh), vOut = new Float32Array(mw * mh);
  // flick: a noise tile (it repeats exactly over the mask height) that scrolls upward through the colour
  // bands, so the fire has tongues that rise. Both are filled a few rows a frame while the igniter
  // clicks, so the tap itself costs nothing.
  const flick = new Int8Array(mw * mh);
  let row = 0;
  const prep = (rows: number) => {
    const end = Math.min(mh, row + rows);
    for (let y = row, i = row * mw; y < end; y++) for (let x = 0; x < mw; x++, i++) {
      const X = (x + 0.5) * ms, Y = (y + 0.5) * ms;
      vIn[i] = clamp01(0.86 * metric(X - ox, Y - oy) / maxM + 0.09 * noise(X / 70, Y / 70) + 0.05 * noise(X / 26 + 9, Y / 26 + 4));
      flick[i] = Math.round((noise(X / 22 + 21, y / mh * G) * 0.65 + noise(X / 10 + 5, y / mh * G * 2) * 0.35 - 0.5) * 2 * 127);
    }
    row = end;
  };

  // The burn-away pattern is only needed later, so it is worked out in the dark of the hold, not on the tap.
  let burnReady = false;
  const buildBurn = () => {
    burnReady = true;
    let lo = 1, hi = 0;
    for (let y = 0, i = 0; y < mh; y++) for (let x = 0; x < mw; x++, i++) {
      const X = (x + 0.5) * ms, Y = (y + 0.5) * ms;
      const v = 0.40 * noise(X / 70 + 31, Y / 70 + 7) + 0.20 * noise(X / 26 + 9, Y / 26 + 4) + 0.08 * noise(X / 11 + 3, Y / 11 + 17)
        + 0.36 * metric(X - ox, Y - oy) / maxM;
      vOut[i] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    for (let i = 0; i < vOut.length; i++) vOut[i] = (vOut[i] - lo) / (hi - lo || 1);   // so the burn runs the whole of its time
  };

  // Colour by depth behind the fire front: haze, white-hot, orange, deep red, char.
  const lut = new Uint32Array(256);
  const stops: [number, number, number, number, number][] = [
    [-0.6, 255, 110, 30, 0], [-0.12, 255, 128, 38, 0.34], [0, 255, 240, 200, 1], [0.08, 255, 222, 140, 1],
    [0.26, 255, 146, 38, 1], [0.5, 200, 58, 14, 1], [0.74, 84, 20, 8, 1], [1.0, 6, 7, 8, 1], [1.5, 6, 7, 8, 1],
  ];
  for (let i = 0; i < 256; i++) {
    const s = -0.6 + i / 255 * 2;
    let k = 0;
    while (k < stops.length - 2 && s > stops[k + 1][0]) k++;
    const A = stops[k], B = stops[k + 1], f = clamp01((s - A[0]) / (B[0] - A[0]));
    const r = lerp(A[1], B[1], f), g = lerp(A[2], B[2], f), b = lerp(A[3], B[3], f), a = lerp(A[4], B[4], f);
    lut[i] = ((Math.round(a * 255) << 24) | (Math.round(b) << 16) | (Math.round(g) << 8) | Math.round(r)) >>> 0;
  }
  const BAND_IN = 0.2, BAND_OUT = 0.1;
  const paint = (field: Float32Array, thr: number, band: number, sign: number, t: number, lick: number) => {
    const k = sign / band * 127.5, base = (0.6 - sign * thr / band) * 127.5, n = mw * mh;
    const roll = (Math.floor(t * 0.42 / ms) % mh) * mw, fk = lick / 127;
    for (let y = 0, i = 0; y < mh; y++) {
      for (let x = 0; x < mw; x++, i++) {
        let j = i + roll; if (j >= n) j -= n;
        let idx = (field[i] * k + base + flick[j] * fk) | 0;
        if (idx < 0) idx = 0; else if (idx > 255) idx = 255;
        px[i] = lut[idx];
      }
    }
    mctx.putImageData(img, 0, 0);
  };

  let flames: Flame[] = [], embers: Ember[] = [], sparks: Spark[] = [];
  let sparked = false;
  const mx = w / 2, my = h * 0.45, markR = Math.min(w, h) * 0.13;
  const jetMax = bestD * 1.12;

  return {
    dur: DUR, swapAt: 580, hitAt: IGNITE,
    draw(ctx, t, dtMs) {
      const dt = dtMs / 1000;
      const coverP = seg(t, IGNITE, COVERED);
      const thrIn = -0.1 + (0.5 * coverP + 0.5 * coverP * coverP) * 1.4;
      const burnP = seg(t, BURN, BURNT);
      const thrOut = -0.16 + (0.55 * burnP + 0.45 * easeInOut(burnP)) * 1.36;
      const endFade = 1 - seg(t, DUR - 150, DUR);

      if (row < mh) prep(t >= IGNITE - 20 ? mh : Math.ceil(mh / 5));

      // 1. the cover
      ctx.imageSmoothingEnabled = true;
      if (t >= IGNITE && t < COVERED) { paint(vIn, thrIn, BAND_IN, -1, t, 26); ctx.drawImage(mask, 0, 0, mw * ms, mh * ms); }
      else if (t >= COVERED && t < BURN) { ctx.fillStyle = BG; ctx.fillRect(0, 0, w, h); if (!burnReady) buildBurn(); }
      else if (t >= BURN && burnP < 1) {
        if (!burnReady) buildBurn(); paint(vOut, thrOut, BAND_OUT, 1, t, 12); ctx.drawImage(mask, 0, 0, mw * ms, mh * ms); }

      ctx.globalCompositeOperation = "lighter";

      // 2. igniter: a gas-blue bead, then the click spark
      if (t < IGNITE + 120) {
        const bead = seg(t, 0, IGNITE) * (1 - seg(t, IGNITE, IGNITE + 120));
        ctx.globalAlpha = 0.9 * bead;
        const br = 10 + 16 * bead;
        ctx.drawImage(S.blue, ox - br, oy - br, br * 2, br * 2);
        ctx.globalAlpha = 1;
      }
      if (!sparked && t >= 55) {
        sparked = true;
        for (let i = 0; i < 14; i++) {
          const a = rnd() * TAU, v = 160 + rnd() * 330;
          sparks.push({ x: ox, y: oy, vx: Math.cos(a) * v + ux * 120, vy: Math.sin(a) * v + uy * 120, life: 0, max: 0.16 + rnd() * 0.2 });
        }
      }
      if (t >= 55 && t < 230) {
        const k = 1 - seg(t, 55, 230), fr = 46 * (0.5 + k);
        ctx.globalAlpha = 0.85 * k;
        ctx.drawImage(S.f0, ox - fr, oy - fr, fr * 2, fr * 2);
        ctx.globalAlpha = 1;
      }
      if (sparks.length) {
        ctx.lineCap = "round"; ctx.lineWidth = 1.6;
        for (const s of sparks) {
          s.life += dt; s.vy += 620 * dt;
          const x0 = s.x, y0 = s.y;
          s.x += s.vx * dt; s.y += s.vy * dt;
          const a = 1 - s.life / s.max;
          if (a <= 0) continue;
          ctx.strokeStyle = `rgba(255,236,170,${a})`;
          ctx.beginPath(); ctx.moveTo(x0 - s.vx * 0.012, y0 - s.vy * 0.012); ctx.lineTo(s.x, s.y); ctx.stroke();
        }
        sparks = sparks.filter(s => s.life < s.max);
      }

      // 3. heat left hanging in the dark once the page is gone
      if (t >= IGNITE && t < BURN + 320) {
        const a = seg(t, IGNITE, COVERED) * (1 - seg(t, COVERED + 60, BURN + 320));
        bloom(ctx, ox + ux * bestD * 0.3, oy + uy * bestD * 0.3, bestD * 0.75, "255,96,24", 0.2 * a);
      }

      // 4. flames along the front, embers off it
      if (t >= IGNITE && t < COVERED) {
        let n = 200 * dt;
        while (n > 0 && flames.length < 90) {
          if (rnd() < n) {
            const a = rnd() * TAU, ex = Math.cos(a), ey = Math.sin(a);
            const al = ex * ux + ey * uy, be = ex * uy - ey * ux;
            const r = Math.max(0, thrIn) / 0.86 * maxM / Math.hypot(al > 0 ? al / AHEAD : al, be);
            const x = ox + ex * r, y = oy + ey * r;
            if (x > -50 && x < w + 50 && y > -50 && y < h + 50) {
              const v = 50 + rnd() * 130;
              flames.push({ x, y, vx: ex * v, vy: ey * v - 70, life: 0, max: 0.26 + rnd() * 0.3, s: 16 + rnd() * 24 });
              if (rnd() < 0.3 && embers.length < 90)
                embers.push({ x, y, vx: ex * 60 + (rnd() - 0.5) * 60, vy: ey * 60 - 60 - rnd() * 90, life: 0, max: 0.6 + rnd() * 0.7, s: 0.9 + rnd() * 1.6, ph: rnd() * 6 });
            }
          }
          n -= 1;
        }
      } else if (t >= COVERED && t < BURN + 120) {
        if (rnd() < 55 * dt && embers.length < 90)
          embers.push({ x: rnd() * w, y: h * (0.25 + rnd() * 0.8), vx: (rnd() - 0.5) * 40, vy: -50 - rnd() * 120, life: 0, max: 0.6 + rnd() * 0.7, s: 0.9 + rnd() * 1.6, ph: rnd() * 6 });
      }
      if (t >= BURN && burnP < 1 && burnReady) {
        for (let j = 0; j < 60; j++) {
          const i = (rnd() * mw * mh) | 0;
          const s = (vOut[i] - thrOut) / BAND_OUT;
          if (s < 0 || s > 0.7) continue;
          const x = (i % mw + 0.5) * ms, y = (Math.floor(i / mw) + 0.5) * ms;
          if (flames.length < 90) flames.push({ x, y, vx: (rnd() - 0.5) * 40, vy: -40 - rnd() * 80, life: 0, max: 0.16 + rnd() * 0.18, s: 7 + rnd() * 9 });
          if (rnd() < 0.5 && embers.length < 90)
            embers.push({ x, y, vx: (rnd() - 0.5) * 50, vy: -50 - rnd() * 110, life: 0, max: 0.5 + rnd() * 0.6, s: 0.9 + rnd() * 1.7, ph: rnd() * 6 });
        }
      }
      for (const f of flames) {
        f.life += dt; f.vy -= 260 * dt; f.vx *= 0.97;
        f.x += f.vx * dt; f.y += f.vy * dt;
        const k = f.life / f.max;
        if (k >= 1) continue;
        const rad = f.s * (1 + k * 1.7);
        ctx.globalAlpha = (1 - k) * 0.32 * endFade;
        ctx.drawImage(k < 0.2 ? S.f0 : k < 0.48 ? S.f1 : k < 0.78 ? S.f2 : S.f3, f.x - rad, f.y - rad * 1.5, rad * 2, rad * 2.8);
      }
      flames = flames.filter(f => f.life < f.max);
      for (const m of embers) {
        m.life += dt;
        m.x += (m.vx + Math.sin(m.life * 7 + m.ph) * 26) * dt; m.y += m.vy * dt; m.vx *= 0.985;
        const k = m.life / m.max;
        if (k >= 1) continue;
        const rad = m.s * (1 - k * 0.4);
        ctx.globalAlpha = Math.sin(Math.PI * Math.min(1, k * 1.15)) * 0.95 * endFade;
        ctx.drawImage(k < 0.5 ? S.hot : S.cool, m.x - rad * 3, m.y - rad * 3, rad * 6, rad * 6);
      }
      embers = embers.filter(m => m.life < m.max);
      ctx.globalAlpha = 1;

      // 5. the jet: blue haze, blue to orange body, cyan-white core, shock diamonds
      const jetA = seg(t, IGNITE - 20, IGNITE + 60) * (1 - seg(t, COVERED - 10, COVERED + 150));
      if (jetA > 0.01) {
        const grow = easeOut(seg(t, IGNITE - 20, IGNITE + 250));
        const len = jetMax * grow * (0.95 + rnd() * 0.07) * (0.55 + 0.45 * jetA);
        const wd = (0.55 + 0.45 * grow) * (0.94 + rnd() * 0.12);
        ctx.save();
        ctx.translate(ox, oy);
        ctx.rotate(Math.atan2(uy, ux));
        // soft stamps laid along the axis: violet-blue haze turning orange at the tip, a blue body, a white core
        const N = 18, gap = len / N;
        for (let i = 0; i < N; i++) {
          const f = (i + 0.5) / N, x = len * f, jit = 0.9 + rnd() * 0.2;
          const ow = 215 * wd * (1 - 0.72 * f) * jit, ol = Math.max(gap * 3, ow * 1.3);
          ctx.globalAlpha = 0.25 * jetA * (1 - f * 0.4);
          ctx.drawImage(f < 0.55 ? S.violet : S.f1, x - ol / 2, -ow / 2, ol, ow);
          if (f < 0.8) {
            const bw = 112 * wd * (1 - 0.95 * f / 0.8) * jit + 4, bl = Math.max(gap * 2.6, bw * 1.3);
            ctx.globalAlpha = 0.5 * jetA;
            ctx.drawImage(S.blue, x - bl / 2, -bw / 2, bl, bw);
          }
          if (f < 0.5) {
            const cw = 38 * wd * (1 - 0.9 * f / 0.5) + 3, cl = Math.max(gap * 2.4, cw * 1.3);
            ctx.globalAlpha = 0.85 * jetA;
            ctx.drawImage(S.white, x - cl / 2, -cw / 2, cl, cw);
          }
        }
        for (let i = 1; i <= 4; i++) {
          const dx = len * (0.04 + i * 0.07), dr = (17 - i * 2.6) * wd;
          ctx.globalAlpha = 0.55 * jetA * (1 - i * 0.15);
          ctx.drawImage(S.white, dx - dr * 1.3, -dr, dr * 2.6, dr * 2);
        }
        ctx.globalAlpha = 1;
        ctx.restore();
      }

      // 6. title beat: the mark, glowing like metal out of the flame
      const markA = seg(t, COVERED - 40, COVERED + 90) * (1 - seg(t, BURN + 60, BURN + 260));
      if (markA > 0.005) {
        const heat = 1 - seg(t, COVERED, BURN);
        bloom(ctx, mx, my, markR * 3.2, "255,150,50", 0.2 * markA * (0.5 + 0.5 * heat));
        ctx.globalCompositeOperation = "source-over";
        const sc = lerp(0.9, 1, easeOut(seg(t, COVERED - 40, COVERED + 160))) + 0.1 * seg(t, BURN + 60, BURN + 260);
        const g = Math.round(lerp(178, 214, heat)), b = Math.round(lerp(74, 130, heat));
        drawMark(ctx, mx, my, markR * sc, markA, `${Math.round(lerp(232, 255, heat))},${g},${b}`);
      }
      ctx.globalCompositeOperation = "source-over";
    },
  };
};

// MARK: rig

const rigScene: SceneMaker = (w, h, ox, oy) => {
  const BURST = 140, COVERED = 460, HIT = 660, OPEN = 690, DUR = 1150;
  const cx = w / 2, cy = h * 0.46, R = Math.min(w, h * 0.62) * 0.36;
  const far = farCorner(cx, cy, w, h), oFar = farCorner(ox, oy, w, h);
  const zMax = (far + 24) / (R * 0.8) - 1;
  const A0 = 135, SWEEP = 270, TICKS = 40;

  const gauge = (ctx: Ctx, t: number, s: number) => {
    const a = seg(t, 250, 380);
    if (a <= 0) return;
    const r = R * s, lw = Math.sqrt(s);
    const x = easeOut(seg(t, 300, 630));                       // how far the power-up has run round the dial
    const hit = 1 - seg(t, HIT, HIT + 280);                    // everything flares on the beat, then settles
    const flare = t >= HIT ? hit : 0;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.lineCap = "butt";
    ring(ctx, cx, cy, r * 1.06, "#15191D", 7 * lw);
    ring(ctx, cx, cy, r * 1.06 + 4 * lw, "#2C333B", 1 * lw);
    ring(ctx, cx, cy, r, "rgba(44,51,59,0.9)", 2 * lw, deg(A0), deg(A0 + SWEEP));
    ctx.lineCap = "round";
    for (let i = 0; i <= TICKS; i++) {
      const f = i / TICKS, major = i % 5 === 0;
      const lit = x >= f, fresh = lit ? Math.max(clamp01(1 - (x - f) * 5), flare) : 0;
      const ang = deg(A0 + SWEEP * f), c = Math.cos(ang), sn = Math.sin(ang);
      const r0 = r * (major ? 0.85 : 0.9), r1 = r * 0.96;
      ctx.beginPath(); ctx.moveTo(cx + c * r0, cy + sn * r0); ctx.lineTo(cx + c * r1, cy + sn * r1);
      ctx.lineWidth = (major ? 2.6 : 1.3) * lw;
      if (!lit) ctx.strokeStyle = major ? "rgba(201,209,219,0.22)" : "rgba(74,82,92,0.5)";
      else if (major) ctx.strokeStyle = `rgb(${Math.round(lerp(201, 150, fresh))},${Math.round(lerp(209, 245, fresh))},${Math.round(lerp(219, 255, fresh))})`;
      else ctx.strokeStyle = `rgb(${Math.round(lerp(74, 25, fresh))},${Math.round(lerp(82, 227, fresh))},${Math.round(lerp(92, 255, fresh))})`;
      ctx.stroke();
    }
    // the live arc that runs up the dial, as on the Home gauge when a rig links
    if (x > 0.005) {
      ctx.globalCompositeOperation = "lighter";
      ring(ctx, cx, cy, r * 1.0, `rgba(${LIVE},${0.22 + 0.2 * flare})`, 10 * lw, deg(A0), deg(A0 + SWEEP * x));
      ring(ctx, cx, cy, r * 1.0, `rgba(${LIVE},0.9)`, 3 * lw, deg(A0), deg(A0 + SWEEP * x));
      const ha = deg(A0 + SWEEP * x), hr = 13 * lw * (1 - seg(t, 600, 700));
      if (hr > 0.5) { const g = ctx.createRadialGradient(cx + Math.cos(ha) * r, cy + Math.sin(ha) * r, 0, cx + Math.cos(ha) * r, cy + Math.sin(ha) * r, hr);
        g.addColorStop(0, "rgba(200,250,255,0.9)"); g.addColorStop(1, "rgba(25,227,255,0)");
        ctx.fillStyle = g; ctx.fillRect(cx + Math.cos(ha) * r - hr, cy + Math.sin(ha) * r - hr, hr * 2, hr * 2); }
      ctx.globalCompositeOperation = "source-over";
    }
    // needle: swings up after the arc, overshoots, pegs
    const np = seg(t, 350, 650);
    const na = deg(A0 + SWEEP * clamp01(easeOutBack(np) * 0.985));
    const nc = Math.cos(na), ns = Math.sin(na), nw = 4.2 * lw;
    ctx.globalCompositeOperation = "lighter";
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + nc * r * 0.8, cy + ns * r * 0.8);
    ctx.strokeStyle = `rgba(${LIVE},${0.16 + 0.2 * flare})`; ctx.lineWidth = 12 * lw; ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
    ctx.beginPath();
    ctx.moveTo(cx - ns * nw - nc * r * 0.12, cy + nc * nw - ns * r * 0.12);
    ctx.lineTo(cx + nc * r * 0.82, cy + ns * r * 0.82);
    ctx.lineTo(cx + ns * nw - nc * r * 0.12, cy - nc * nw - ns * r * 0.12);
    ctx.closePath();
    ctx.fillStyle = `rgb(${Math.round(lerp(201, 25, seg(t, 350, 470)))},${Math.round(lerp(209, 227, seg(t, 350, 470)))},${Math.round(lerp(219, 255, seg(t, 350, 470)))})`;
    ctx.fill();
    const hub = ctx.createRadialGradient(cx - r * 0.03, cy - r * 0.035, 0, cx, cy, r * 0.1);
    hub.addColorStop(0, "#4B525B"); hub.addColorStop(0.6, "#1A1E23"); hub.addColorStop(1, "#0B0D10");
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.1, 0, TAU); ctx.fillStyle = hub; ctx.fill();
    ring(ctx, cx, cy, r * 0.1, "#2C333B", 1 * lw);
    // the mark, as a maker's badge in the open foot of the dial
    drawMark(ctx, cx, cy + r * 0.62, r * 0.15, seg(t, 400, 540));
    ctx.restore();
  };

  return {
    dur: DUR, swapAt: 520, hitAt: HIT,
    draw(ctx, t) {
      ctx.lineCap = "butt";
      const cp = easeInOut(seg(t, BURST, COVERED));
      const discR = lerp(13, oFar + 30, cp);
      const zp = seg(t, OPEN, DUR - 20);
      const s = 1 + easeIn(zp) * zMax;

      // anticipation: a ring draws in on the tapped element
      if (t < BURST + 60) {
        const k = easeOut(seg(t, 0, BURST)), a = k * (1 - seg(t, BURST, BURST + 60));
        ctx.globalCompositeOperation = "lighter";
        ring(ctx, ox, oy, lerp(46, 14, k), `rgba(${LIVE},${0.22 * a})`, 9);
        ring(ctx, ox, oy, lerp(46, 14, k), `rgba(${LIVE},${0.95 * a})`, 2.2);
        bloom(ctx, ox, oy, 40, LIVE, 0.3 * a);
        ctx.globalCompositeOperation = "source-over";
      }

      // the dark face spreads from the tap; the dial lives on it
      if (t >= BURST) {
        ctx.save();
        if (cp < 1) { ctx.beginPath(); ctx.arc(ox, oy, discR, 0, TAU); ctx.clip(); }
        ctx.fillStyle = BG; ctx.fillRect(0, 0, w, h);
        const face = ctx.createRadialGradient(cx, cy - R * 0.25, 0, cx, cy, R * 1.9 * s);
        face.addColorStop(0, "rgba(17,22,27,1)"); face.addColorStop(1, "rgba(6,7,8,0)");
        ctx.fillStyle = face; ctx.fillRect(0, 0, w, h);
        gauge(ctx, t, s);
        ctx.restore();
        if (cp < 1) {
          ctx.globalCompositeOperation = "lighter";
          ring(ctx, ox, oy, discR, `rgba(${LIVE},${0.2 * (1 - cp * 0.5)})`, 16);
          ring(ctx, ox, oy, discR, `rgba(${LIVE},0.95)`, 2.6);
          ring(ctx, ox, oy, discR * 0.86, `rgba(${LIVE},${0.3 * (1 - cp)})`, 1.4);
          ring(ctx, ox, oy, discR * 0.7, `rgba(${LIVE},${0.14 * (1 - cp)})`, 1);
          ctx.globalCompositeOperation = "source-over";
        }
      }

      // the beat: one soft cyan bloom as the needle pegs
      if (t >= HIT - 40 && t < HIT + 320) {
        const a = seg(t, HIT - 40, HIT + 20) * (1 - seg(t, HIT + 20, HIT + 320));
        ctx.globalCompositeOperation = "lighter";
        bloom(ctx, cx, cy, R * 2.4 * s, LIVE, 0.34 * a);
        ctx.globalCompositeOperation = "source-over";
      }

      // reveal: the face opens from the hub and the dial flies past
      if (t >= OPEN) {
        const hole = R * s * 0.8 * easeOut(seg(zp, 0, 0.34));
        ctx.globalCompositeOperation = "destination-out";
        ctx.beginPath(); ctx.arc(cx, cy, hole, 0, TAU); ctx.fillStyle = "#000"; ctx.fill();
        ctx.globalCompositeOperation = "source-over";
        const veil = 0.5 * (1 - seg(zp, 0.05, 0.6));
        if (veil > 0.004) { ctx.beginPath(); ctx.arc(cx, cy, hole, 0, TAU); ctx.fillStyle = `rgba(${BG_RGB},${veil})`; ctx.fill(); }
        const ra = 1 - seg(zp, 0.75, 1);
        ctx.globalCompositeOperation = "lighter";
        ring(ctx, cx, cy, hole, `rgba(${LIVE},${0.22 * ra})`, 14 * Math.sqrt(s));
        ring(ctx, cx, cy, hole, `rgba(${LIVE},${0.95 * ra})`, 2.6 * Math.sqrt(s));
        ring(ctx, cx, cy, hole * 0.9, `rgba(${LIVE},${0.25 * ra * (1 - zp)})`, 1.2);
        ctx.globalCompositeOperation = "source-over";
      }
    },
  };
};

// MARK: jars

interface Dust { x: number; y: number; vx: number; vy: number; life: number; max: number; s: number; ph: number }

const jarsScene: SceneMaker = (w, h, ox, oy) => {
  const CLOSE0 = 90, CLOSED = 500, HIT = 700, OPEN = 730, DUR = 1220;
  const cx = w / 2, cy = h * 0.46;
  const far = farCorner(cx, cy, w, h), aMax = far * 1.08;
  const N = 8, STEP = TAU / N, RL = Math.min(w, h * 0.62) * 0.27;
  const S = { gold: sprite("255,214,130", DOT), pale: sprite("255,240,205", DOT) };
  let dust: Dust[] = [];
  let puffed = false, popped = false;
  const add = (x: number, y: number, vx: number, vy: number, max: number) => {
    if (dust.length < 150) dust.push({ x, y, vx, vy, life: 0, max, s: 0.7 + rnd() * 1.7, ph: rnd() * 6 });
  };

  /** The iris: N dark blades with gold edges round an N-sided opening of inradius a. */
  const iris = (ctx: Ctx, a: number, phi: number, edgeA: number) => {
    const rv = a / Math.cos(STEP / 2), L = far * 2.4;
    const vx: number[] = [], vy: number[] = [];
    for (let i = 0; i < N; i++) { vx.push(cx + Math.cos(phi + i * STEP) * rv); vy.push(cy + Math.sin(phi + i * STEP) * rv); }
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.moveTo(vx[0], vy[0]);
    for (let i = 1; i < N; i++) ctx.lineTo(vx[i], vy[i]);
    ctx.closePath();
    ctx.fillStyle = BG;
    ctx.fill("evenodd");
    // blades: each is the wedge between its own edge and the run-on of the one before
    for (let i = 0; i < N; i++) {
      const ea = phi + i * STEP + Math.PI / 2 + STEP / 2;      // direction of the edge from vertex i to i+1
      const dx = Math.cos(ea), dy = Math.sin(ea), px = Math.cos(ea - STEP), py = Math.sin(ea - STEP);
      const nx = -dy, ny = dx;                                  // into the blade
      ctx.beginPath();
      ctx.moveTo(vx[i], vy[i]); ctx.lineTo(vx[i] + dx * L, vy[i] + dy * L); ctx.lineTo(vx[i] + px * L, vy[i] + py * L);
      ctx.closePath();
      const sgn = (px - dx) * nx + (py - dy) * ny > 0 ? 1 : -1;
      const g = ctx.createLinearGradient(vx[i], vy[i], vx[i] + nx * sgn * 150, vy[i] + ny * sgn * 150);
      g.addColorStop(0, "rgba(40,31,14,0.95)"); g.addColorStop(0.1, "rgba(21,19,14,0.9)"); g.addColorStop(1, "rgba(6,7,8,0)");
      ctx.fillStyle = g; ctx.fill();
    }
    if (edgeA > 0.004) {
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";
      for (let pass = 0; pass < 2; pass++) {
        ctx.beginPath();
        for (let i = 0; i < N; i++) {
          const ea = phi + i * STEP + Math.PI / 2 + STEP / 2;
          ctx.moveTo(vx[i], vy[i]); ctx.lineTo(vx[i] + Math.cos(ea) * L, vy[i] + Math.sin(ea) * L);
        }
        ctx.strokeStyle = pass ? `rgba(${GOLD},${0.9 * edgeA})` : `rgba(${GOLD},${0.16 * edgeA})`;
        ctx.lineWidth = pass ? 1.6 : 8;
        ctx.stroke();
      }
      ctx.globalCompositeOperation = "source-over";
    }
  };

  const lid = (ctx: Ctx, t: number) => {
    const inP = seg(t, 380, 560), lift = seg(t, OPEN, OPEN + 300);
    const a = inP * (1 - lift);
    if (a <= 0.004) return;
    const pop = seg(t, HIT - 30, HIT + 30) * (1 - seg(t, HIT + 30, HIT + 200));
    const sc = lerp(0.82, 1, easeOutBack(inP)) + 0.07 * pop + 0.85 * easeIn(lift);
    const rot = -2.3 * (1 - easeOut(seg(t, 390, 700)));       // unscrewing; the T ends upright
    const r = RL * sc;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    bloom(ctx, cx, cy, r * 2.6, GOLD, (0.1 + 0.2 * pop) * a);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = a;
    const face = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.4, 0, cx, cy, r * 1.1);
    face.addColorStop(0, "#2A2110"); face.addColorStop(0.55, "#161108"); face.addColorStop(1, "#0A0805");
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.1, 0, TAU); ctx.fillStyle = face; ctx.fill();
    ctx.translate(cx, cy); ctx.rotate(rot);
    ctx.lineCap = "butt";
    ctx.beginPath();
    for (let i = 0; i < 60; i++) {
      const an = i / 60 * TAU, c = Math.cos(an), s = Math.sin(an);
      ctx.moveTo(c * r * 1.005, s * r * 1.005); ctx.lineTo(c * r * 1.092, s * r * 1.092);
    }
    ctx.strokeStyle = `rgba(${GOLD},0.62)`; ctx.lineWidth = Math.max(1, r * 0.022); ctx.stroke();
    ring(ctx, 0, 0, r, `rgb(${GOLD})`, Math.max(1.5, r * 0.028));
    ring(ctx, 0, 0, r * 1.1, `rgba(${GOLD},0.85)`, Math.max(1, r * 0.016));
    ring(ctx, 0, 0, r * 0.84, `rgba(${GOLD},0.3)`, 1);
    drawMark(ctx, 0, 0, r * 0.5, 1);
    ctx.rotate(-rot);
    // a fixed light catches the rim as it turns
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    const ga = deg(-128 + 30 * Math.sin(rot * 2));
    ring(ctx, 0, 0, r * 1.1, "rgba(255,244,214,0.6)", Math.max(1.2, r * 0.02), ga, ga + 0.5);
    ring(ctx, 0, 0, r * 1.05, "rgba(255,226,160,0.14)", r * 0.1, ga + 0.08, ga + 0.42);
    ring(ctx, 0, 0, r, "rgba(255,244,214,0.4)", Math.max(1, r * 0.02), ga + Math.PI, ga + Math.PI + 0.35);
    ctx.restore();
  };

  return {
    dur: DUR, swapAt: 560, hitAt: HIT,
    draw(ctx, t, dtMs) {
      const dt = dtMs / 1000;
      const closeP = easeInOut(seg(t, CLOSE0, CLOSED)), openP = seg(t, OPEN, DUR - 20);
      const opening = t >= OPEN;
      const a = opening ? aMax * (0.25 * openP + 0.75 * easeIn(openP)) * 1.02 : aMax * (1 - closeP);
      const phi = -1.15 * (opening ? 1 + 0.75 * easeOut(openP) : closeP) + 0.3;

      if (t >= CLOSE0 || opening) {
        const edge = opening ? 1 - seg(openP, 0.8, 1) : seg(t, CLOSE0, CLOSE0 + 120) * (1 - 0.7 * seg(t, CLOSED - 40, CLOSED + 80));
        iris(ctx, a, phi, edge);
        if (opening && a > 0) {
          const veil = 0.55 * (1 - seg(openP, 0.05, 0.55));
          if (veil > 0.004) { ctx.beginPath(); ctx.arc(cx, cy, a / Math.cos(STEP / 2) + 2, 0, TAU); ctx.fillStyle = `rgba(${BG_RGB},${veil})`; ctx.fill(); }
        }
      }

      // anticipation: a gold ring breathes out of the tapped element
      if (t < 300) {
        const k = easeOut(seg(t, 0, 260)), al = seg(t, 0, 60) * (1 - seg(t, 150, 300));
        ctx.globalCompositeOperation = "lighter";
        ring(ctx, ox, oy, lerp(10, 44, k), `rgba(${GOLD},${0.9 * al})`, 2);
        ring(ctx, ox, oy, lerp(10, 44, k), `rgba(${GOLD},${0.2 * al})`, 9);
        bloom(ctx, ox, oy, 46, GOLD, 0.28 * al);
        ctx.globalCompositeOperation = "source-over";
      }

      lid(ctx, t);

      // gold dust
      if (!puffed) {
        puffed = true;
        for (let i = 0; i < 20; i++) { const an = rnd() * TAU, v = 30 + rnd() * 110; add(ox, oy, Math.cos(an) * v, Math.sin(an) * v - 20, 0.5 + rnd() * 0.5); }
      }
      if (!popped && t >= HIT) {
        popped = true;
        for (let i = 0; i < 64; i++) {
          const an = rnd() * TAU, v = 40 + rnd() * 240, c = Math.cos(an), s = Math.sin(an);
          add(cx + c * RL * 1.08, cy + s * RL * 1.08, c * v, s * v - 12, 0.4 + rnd() * 0.5);
        }
      }
      if (t > CLOSE0 + 60 && t < DUR - 320 && rnd() < 70 * dt) {
        const an = rnd() * TAU, rr = Math.min(Math.max(a, RL * 1.2), far * 0.75) * (0.75 + rnd() * 0.3), c = Math.cos(an), s = Math.sin(an);
        add(cx + c * rr, cy + s * rr, -s * 34 + (rnd() - 0.5) * 20, c * 34 - 10 + (rnd() - 0.5) * 20, 0.6 + rnd() * 0.6);
      }
      ctx.globalCompositeOperation = "lighter";
      const endFade = 1 - seg(t, DUR - 160, DUR);
      for (const d of dust) {
        d.life += dt; d.vx *= 0.965; d.vy = d.vy * 0.965 - 8 * dt;
        d.x += d.vx * dt; d.y += d.vy * dt;
        const k = d.life / d.max;
        if (k >= 1) continue;
        const rad = d.s * (1 - k * 0.3);
        ctx.globalAlpha = Math.sin(Math.PI * Math.min(1, k * 1.1)) * (0.6 + 0.4 * Math.sin(d.life * 16 + d.ph)) * endFade;
        ctx.drawImage(d.ph > 4.4 ? S.pale : S.gold, d.x - rad * 3, d.y - rad * 3, rad * 6, rad * 6);
      }
      dust = dust.filter(d => d.life < d.max);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    },
  };
};

const SCENES: Record<TransitionKind, SceneMaker> = { torch: torchScene, rig: rigScene, jars: jarsScene };

// MARK: the run

const CSS = `
.tx-overlay{position:fixed;left:0;top:0;width:100%;height:100%;z-index:2147483000;margin:0;padding:0;border:0;overflow:hidden;
  pointer-events:auto;touch-action:none;-webkit-user-select:none;user-select:none;background:transparent;contain:strict}
.tx-canvas{position:absolute;left:0;top:0;width:100%;height:100%;display:block}
.tx-video{position:absolute;left:0;top:0;width:100%;height:100%;display:block;object-fit:cover;background:#000;opacity:0;pointer-events:none}
.tx-fade{opacity:0}
`;

function ensureStyle() {
  if (document.getElementById("tx-style")) return;
  const s = document.createElement("style");
  s.id = "tx-style";
  s.textContent = CSS;
  (document.head ?? document.documentElement).append(s);
}

function pageBackground(): string {
  try {
    for (const el of [document.body, document.documentElement]) {
      const c = getComputedStyle(el).backgroundColor;
      if (c && c !== "transparent" && !/,\s*0\)$/.test(c)) return c;
    }
  } catch { /* fall through */ }
  return BG;
}

class Run {
  private done = false;
  private swapped = false;
  private raf = 0;
  private timers: number[] = [];
  private overlay: HTMLDivElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private video: HTMLVideoElement | null = null;
  private resolve!: () => void;
  readonly promise: Promise<void>;
  private onHide = () => { if (document.visibilityState === "hidden") this.finish(); };

  constructor(private kind: TransitionKind, private swap: () => void, private origin: HTMLElement | null) {
    this.promise = new Promise<void>(r => { this.resolve = r; });
  }

  start(): void {
    try {
      ensureStyle();
      const o = document.createElement("div");
      o.className = "tx-overlay";
      o.setAttribute("aria-hidden", "true");
      for (const ev of ["click", "pointerdown", "touchstart", "touchmove", "wheel", "contextmenu"])
        o.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); }, { passive: false });
      document.body.append(o);
      this.overlay = o;
      document.addEventListener("visibilitychange", this.onHide);
      this.later(() => this.finish(), 4500);   // whatever happens, the overlay does not outlive this

      if (document.visibilityState === "hidden") { this.finish(); return; }
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) { this.fade(); return; }
      const clip = CLIPS[this.kind];
      if (clip) this.playClip(clip); else this.playCanvas();
    } catch (e) {
      this.finish();
    }
  }

  private later(fn: () => void, ms: number): number {
    const id = window.setTimeout(() => { try { fn(); } catch { this.finish(); } }, ms);
    this.timers.push(id);
    return id;
  }

  private doSwap(): void {
    if (this.swapped) return;
    this.swapped = true;
    try { this.swap(); } catch (e) { console.error("transition swap failed", e); }
  }

  /** Ends now, wherever it has got to: swaps if it has not yet, removes everything, resolves. */
  finish(): void {
    if (this.done) return;
    this.done = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const id of this.timers) clearTimeout(id);
    this.timers = [];
    document.removeEventListener("visibilitychange", this.onHide);
    this.doSwap();
    this.dropVideo();
    if (this.canvas) { this.canvas.width = this.canvas.height = 0; this.canvas = null; }   // hands the memory back at once
    this.overlay?.remove();
    this.overlay = null;
    if (current === this) current = null;
    this.resolve();
  }

  /** Runs `step` each frame with scene time in ms. Scene time never jumps: it stops at swapAt for one painted frame. */
  private loop(dur: number, swapAt: number, step: (t: number, dt: number) => void, hitAt = -1): void {
    let t = 0, last = performance.now(), hit = hitAt < 0;
    const frame = (now: number) => {
      this.raf = 0;
      if (this.done) return;
      try {
        const dt = Math.min(MAX_STEP, Math.max(0, now - last));
        last = now;
        t += dt;
        if (!hit && t >= hitAt) { hit = true; try { navigator.vibrate?.(12); } catch { /* fine */ } }
        if (!this.swapped && t >= swapAt) {
          t = swapAt;
          step(t, dt);
          this.doSwap();
          last = performance.now();   // time spent building the next page is not scene time
        } else if (t >= dur) { this.finish(); return; }
        else step(t, dt);
        this.raf = requestAnimationFrame(frame);
      } catch (e) {
        this.finish();
      }
    };
    this.raf = requestAnimationFrame(frame);
  }

  private fade(): void {
    const o = this.overlay!;
    o.classList.add("tx-fade");
    o.style.background = pageBackground();
    const half = REDUCED_MS / 2;
    this.loop(REDUCED_MS, half, t => { o.style.opacity = String(t <= half ? t / half : 1 - (t - half) / half); });
  }

  private playCanvas(): void {
    const o = this.overlay;
    if (!o || this.done) return;
    try {
      const w = o.clientWidth || window.innerWidth, h = o.clientHeight || window.innerHeight;
      if (!(w > 0 && h > 0)) { this.finish(); return; }
      const c = document.createElement("canvas");
      c.className = "tx-canvas";
      // At most 2x (1.5x for the fire, which is all soft edges), and less on big screens so the fill
      // cost stays near a phone's. If frames still come slowly, the canvas drops to a lower scale mid-run.
      let dpr = Math.max(1, Math.min(this.kind === "torch" ? 1.5 : 2, window.devicePixelRatio || 1, Math.sqrt(2_400_000 / (w * h))));
      let slow = 0;
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      const ctx = c.getContext("2d");
      if (!ctx) { this.finish(); return; }
      let ox = w / 2, oy = h * 0.6;
      const r = this.origin?.isConnected ? this.origin.getBoundingClientRect() : null;
      if (r && r.width > 0 && r.height > 0) {
        ox = Math.min(w, Math.max(0, r.left + r.width / 2));
        oy = Math.min(h, Math.max(0, r.top + r.height / 2));
      }
      const scene = SCENES[this.kind](w, h, ox, oy);
      o.append(c);
      this.canvas = c;
      this.loop(scene.dur, scene.swapAt, (t, dt) => {
        if (dt > 30 && dpr > 1 && ++slow >= 4) {
          slow = 0;
          dpr = Math.max(1, dpr * 0.7);
          c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.clearRect(0, 0, w, h);
        scene.draw(ctx, t, dt);
      }, scene.hitAt);
    } catch (e) {
      this.finish();
    }
  }

  private dropVideo(): void {
    const v = this.video;
    if (!v) return;
    this.video = null;
    try { v.pause(); v.removeAttribute("src"); v.load(); } catch { /* fine */ }
    v.remove();
  }

  private playClip(url: string): void {
    const o = this.overlay!;
    const v = document.createElement("video");
    v.className = "tx-video";
    v.muted = true; v.defaultMuted = true; v.playsInline = true; v.preload = "auto";
    v.setAttribute("muted", ""); v.setAttribute("playsinline", ""); v.setAttribute("webkit-playsinline", "");
    v.disablePictureInPicture = true;
    this.video = v;
    let started = false, failed = false;
    const fail = () => {
      if (failed || this.done) return;
      failed = true;
      if (started) { this.finish(); return; }     // broke part-way: get out of the way
      this.dropVideo();
      this.playCanvas();
    };
    const startTimer = this.later(fail, CLIP_START_MS);
    v.addEventListener("error", fail);
    v.addEventListener("ended", () => this.finish());
    v.addEventListener("playing", () => {
      if (failed || started || this.done) return;
      started = true;
      clearTimeout(startTimer);
      const FADE_IN = 90, FADE_OUT = 0.16, t0 = performance.now();
      const tick = () => {
        this.raf = 0;
        if (this.done) return;
        const d = isFinite(v.duration) && v.duration > 0 ? v.duration : 1.2, at = v.currentTime;
        if (!this.swapped && at >= d * 0.55) this.doSwap();
        if (at >= d || v.ended) { this.finish(); return; }
        const a = Math.min(clamp01((performance.now() - t0) / FADE_IN), this.swapped ? clamp01((d - at) / FADE_OUT) : 1);
        v.style.opacity = String(a);
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    });
    v.src = url;
    o.append(v);
    const p = v.play();
    if (p && typeof p.catch === "function") p.catch(fail);
  }
}

let current: Run | null = null;

/** Plays the transition for `kind`. `swap` runs exactly once, while the screen is covered. `origin` is the tapped element (the motion may grow from it). */
export function playTransition(kind: TransitionKind, swap: () => void, origin?: HTMLElement | null): Promise<void> {
  try { current?.finish(); } catch { /* the old one is gone either way */ }
  if (typeof document === "undefined" || !document.body) {
    try { swap(); } catch (e) { console.error("transition swap failed", e); }
    return Promise.resolve();
  }
  const run = new Run(kind in SCENES ? kind : "rig", swap, origin ?? null);
  current = run;
  run.start();
  return run.promise;
}
