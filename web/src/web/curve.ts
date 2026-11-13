// Preset curve chart: draws the heat curve the rig itself reports for a preset (the 0xAA / 0xAB
// waypoint frames it sends on connect and after every preset save). Read-only: nothing is sent.

import type { PresetInfo } from "../rig/rig-controller";

export interface Waypoint { t: number; f: number; c: number }

/** Waypoints from the rig's two curve frames: {tempF u16, tempC u16, time u8} x3 from byte 3, per frame. */
export function waypointsOf(p: PresetInfo): Waypoint[] {
  const out: Waypoint[] = [];
  for (const fr of [p.custom170, p.custom171]) {
    if (!fr) continue;
    for (let o = 3; o + 4 < fr.length - 1; o += 5) {
      const f = (fr[o] << 8) | fr[o + 1], c = (fr[o + 2] << 8) | fr[o + 3], t = fr[o + 4];
      if (f === 0 && c === 0) continue;
      out.push({ t, f, c });
    }
  }
  out.sort((a, b) => a.t - b.t);
  // The rig only ever reports a curve that starts at 0 s. Anything else is a frame we don't understand.
  return out.length && out[0].t === 0 ? out : [];
}

export interface CurveView {
  /** SVG markup for the chart body (viewBox 0 0 W H). */
  svg: string;
  start: number; peak: number; low: number; end: number;
  seconds: number;
  /** For the touch readout: time and temp under a point given as a 0..1 share of the SVG's width. */
  probe(share: number): { t: number; v: number; x: number; y: number } | null;
}

export const CURVE_W = 340, CURVE_H = 168;
const W = CURVE_W, H = CURVE_H, L = 38, R = 14, T = 26, B = 26;

function niceStep(span: number): number {
  for (const s of [5, 10, 20, 25, 50, 100]) if (span / s <= 4) return s;
  return 100;
}

/** elapsed = seconds into the hold while heating at temp, or null. extend = +10 s taps this dab.
 *  keepsRamp: extra time continues the last slope (seen on the rig with Ascent); otherwise it is drawn flat. */
export function drawCurve(pts: Waypoint[], celsius: boolean, elapsed: number | null, extend: number, keepsRamp: boolean): CurveView | null {
  if (pts.length === 0) return null;
  const v = (p: Waypoint) => (celsius ? p.c : p.f);
  const last = pts[pts.length - 1];
  const prev = pts.length > 1 ? pts[pts.length - 2] : last;
  const slope = keepsRamp && last.t > prev.t ? (v(last) - v(prev)) / (last.t - prev.t) : 0;
  const extra = 10 * Math.max(1, extend);
  const extV = v(last) + slope * extra;
  const span = Math.max(last.t, 1) + extra;
  const vals = pts.map(v);
  const minV = Math.min(...vals), maxV = Math.max(...vals);
  const dMin = Math.min(minV, extV), dMax = Math.max(maxV, extV);
  // A flat hold gets a window around it so the line sits mid-chart instead of on an edge.
  const pad = Math.max(celsius ? 8 : 14, (dMax - dMin) * 0.38);
  const step = niceStep(dMax - dMin + 2 * pad);
  const lo = Math.floor((dMin - pad) / step) * step, hi = Math.ceil((dMax + pad) / step) * step;
  const px = (t: number) => L + (t / span) * (W - L - R);
  const py = (val: number) => T + (1 - (val - lo) / (hi - lo)) * (H - T - B);
  const at = (t: number): number => {
    if (t >= last.t) return v(last) + slope * (t - last.t);
    for (let i = 1; i < pts.length; i++) {
      if (t <= pts[i].t) {
        const a = pts[i - 1], b = pts[i];
        return b.t === a.t ? v(b) : v(a) + (v(b) - v(a)) * (t - a.t) / (b.t - a.t);
      }
    }
    return v(last);
  };
  const n = (x: number) => x.toFixed(1);
  const uid = `cv${Math.round(minV)}${Math.round(maxV)}${last.t}${pts.length}`;
  const base = H - B;
  const line = pts.map((p, i) => `${i ? "L" : "M"}${n(px(p.t))} ${n(py(v(p)))}`).join(" ");
  const area = `${line} L${n(px(last.t))} ${base} L${n(px(0))} ${base} Z`;
  const xe = px(last.t), xs = px(span);

  let s = `<defs>
    <linearGradient id="${uid}a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="cvStopTop"/><stop offset="1" class="cvStopBottom"/></linearGradient>
    <linearGradient id="${uid}e" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="cvExtTop"/><stop offset="1" class="cvStopBottom"/></linearGradient>
    <clipPath id="${uid}c"><rect x="${L}" y="${T - 8}" width="${W - L - R}" height="${base - T + 8}"/></clipPath>
  </defs>`;
  // Grid: hairlines at round temps, labels in the gutter.
  for (let g = lo; g <= hi + 0.01; g += step) {
    if (g === lo) continue;
    s += `<line class="cvGrid" x1="${L}" x2="${W - R}" y1="${n(py(g))}" y2="${n(py(g))}"/>`;
    s += `<text class="cvAxis" x="${L - 7}" y="${n(py(g) + 3.4)}" text-anchor="end">${g}°</text>`;
  }
  s += `<line class="cvBase" x1="${L}" x2="${W - R}" y1="${base}" y2="${base}"/>`;
  // Time axis: a tick every 10 s, labels where they fit.
  const tickEvery = span > 70 ? 20 : 10;
  for (let t = 0; t <= last.t; t += 10) {
    s += `<line class="cvTick" x1="${n(px(t))}" x2="${n(px(t))}" y1="${base}" y2="${base + (t % tickEvery === 0 ? 5 : 3)}"/>`;
    if (t % tickEvery === 0 && px(last.t) - px(t) > 16 || t === 0) s += `<text class="cvAxis" x="${n(px(t))}" y="${H - 6}" text-anchor="${t === 0 ? "start" : "middle"}">${t === 0 ? "0s" : t}</text>`;
  }
  if (last.t % tickEvery !== 0 || true) s += `<text class="cvAxis cvAxisStrong" x="${n(xe)}" y="${H - 6}" text-anchor="middle">${last.t}s</text>`;
  // Extra-time zone.
  s += `<rect class="cvExtZone${extend > 0 ? " on" : ""}" x="${n(xe)}" y="${T - 8}" width="${n(xs - xe)}" height="${n(base - T + 8)}" fill="url(#${uid}e)"/>`;
  s += `<line class="cvExtEdge" x1="${n(xe)}" x2="${n(xe)}" y1="${T - 8}" y2="${base}"/>`;
  s += `<text class="cvExtTag" x="${n((xe + xs) / 2)}" y="${T - 12}" text-anchor="middle">+${extra}s</text>`;
  // The curve.
  s += `<g clip-path="url(#${uid}c)"><path d="${area}" fill="url(#${uid}a)"/>`;
  s += `<path class="cvGlow" d="${line}"/><path class="cvLine" d="${line}"/>`;
  s += `<path class="cvExt${extend > 0 ? " on" : ""}" d="M${n(xe)} ${n(py(v(last)))} L${n(xs)} ${n(py(extV))}"/></g>`;
  // Waypoints with a surface ring, and a value on the start, the end and each turn.
  pts.forEach((p, i) => {
    const x = px(p.t), y = py(v(p));
    s += `<circle class="cvPt" cx="${n(x)}" cy="${n(y)}" r="4"/>`;
    const before = i > 0 ? v(pts[i - 1]) : v(p), after = i < pts.length - 1 ? v(pts[i + 1]) : v(p);
    const isDip = v(p) < before && v(p) <= after || v(p) <= before && v(p) < after && i > 0 && i < pts.length - 1;
    const flatRepeat = i > 0 && v(p) === before && (i === pts.length - 1 ? pts.length > 2 || true : v(p) === after);
    if (flatRepeat && !(i === pts.length - 1 && minV !== maxV)) return;
    const below = isDip && i > 0 && i < pts.length - 1;
    const anchor = i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle";
    const dx = i === 0 ? -2 : i === pts.length - 1 ? 2 : 0;
    s += `<text class="cvVal" x="${n(x + dx)}" y="${n(below ? y + 17 : y - 9)}" text-anchor="${anchor}">${Math.round(v(p))}°</text>`;
  });
  // Where the dab is right now.
  if (elapsed !== null) {
    const t = Math.min(Math.max(elapsed, 0), span), x = px(t), y = py(at(t));
    s += `<line class="cvNow" x1="${n(x)}" x2="${n(x)}" y1="${T - 8}" y2="${base}"/>`;
    s += `<circle class="cvDotHalo" cx="${n(x)}" cy="${n(y)}" r="9"/><circle class="cvDot" cx="${n(x)}" cy="${n(y)}" r="4.5"/>`;
  }
  // Touch readout, moved by the page.
  s += `<g id="cvScrub" visibility="hidden"><line class="cvScrubLine" y1="${T - 8}" y2="${base}"/><circle class="cvScrubDot" r="4.5"/>
    <g id="cvScrubTip"><rect class="cvTipBox" width="74" height="22" rx="7"/><text class="cvTipText" x="37" y="15" text-anchor="middle"></text></g></g>`;
  s += `<rect id="cvHit" x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent"/>`;

  return {
    svg: s, start: v(pts[0]), peak: maxV, low: minV, end: v(last), seconds: last.t,
    probe(share: number) {
      const xx = share * W;
      if (xx < L - 6 || xx > W - R + 6) return null;
      const t = Math.round(Math.min(Math.max((xx - L) / (W - L - R), 0), 1) * span);
      return { t, v: at(t), x: px(t), y: py(at(t)) };
    },
  };
}
