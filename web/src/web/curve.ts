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
  /** SVG markup for the chart body (viewBox 0 0 320 120). */
  svg: string;
  /** "465–480°" or "465°". */
  range: string;
  seconds: number;
}

const W = 320, H = 120, L = 34, R = 10, T = 12, B = 22;

/** elapsed = seconds into the hold while heating at temp, or null. extend = +10 s taps this dab. */
export function drawCurve(pts: Waypoint[], celsius: boolean, elapsed: number | null, extend: number, keepsRamp: boolean): CurveView | null {
  if (pts.length === 0) return null;
  const v = (p: Waypoint) => (celsius ? p.c : p.f);
  const last = pts[pts.length - 1];
  const end = Math.max(last.t, 1);
  // What +10 s does: seen on the rig, Steady stays flat and Ascent keeps climbing at its slope.
  // Other shapes have not been seen with extra time, so they are drawn flat.
  const prev = pts.length > 1 ? pts[pts.length - 2] : last;
  const slope = keepsRamp && last.t > prev.t ? (v(last) - v(prev)) / (last.t - prev.t) : 0;
  const extra = 10 * Math.max(1, extend);
  const extV = v(last) + slope * extra;
  const vals = pts.map(v).concat(extV);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max(10, (hi - lo) * 0.25);
  lo = Math.floor((lo - pad) / 5) * 5; hi = Math.ceil((hi + pad) / 5) * 5;
  const span = end + extra;
  const x = (t: number) => L + (t / span) * (W - L - R);
  const y = (val: number) => T + (1 - (val - lo) / (hi - lo)) * (H - T - B);
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
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(v(p)).toFixed(1)}`).join(" ");
  const area = `${line} L${x(last.t).toFixed(1)} ${H - B} L${x(0).toFixed(1)} ${H - B} Z`;
  const minV = Math.min(...pts.map(v)), maxV = Math.max(...pts.map(v));
  let s = "";
  // Grid: min and max lines with their temps, time ticks.
  for (const g of minV === maxV ? [maxV] : [minV, maxV]) {
    s += `<line class="cvGrid" x1="${L}" x2="${W - R}" y1="${y(g).toFixed(1)}" y2="${y(g).toFixed(1)}"/>`;
    s += `<text class="cvAxis" x="${L - 5}" y="${(y(g) + 3.5).toFixed(1)}" text-anchor="end">${Math.round(g)}°</text>`;
  }
  const ticks = new Set<number>([0, ...pts.map(p => p.t)]);
  for (const t of ticks) s += `<text class="cvAxis" x="${x(t).toFixed(1)}" y="${H - 7}" text-anchor="middle">${t}s</text>`;
  s += `<text class="cvAxis cvPlus" x="${x(span).toFixed(1)}" y="${H - 7}" text-anchor="end">+${extra}s</text>`;
  s += `<line class="cvBase" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>`;
  s += `<path class="cvArea" d="${area}"/><path class="cvLine" d="${line}"/>`;
  s += `<path class="cvExt${extend > 0 ? " on" : ""}" d="M${x(last.t).toFixed(1)} ${y(v(last)).toFixed(1)} L${x(span).toFixed(1)} ${y(extV).toFixed(1)}"/>`;
  for (const p of pts) s += `<circle class="cvPt" cx="${x(p.t).toFixed(1)}" cy="${y(v(p)).toFixed(1)}" r="3"/>`;
  if (elapsed !== null) {
    const t = Math.min(Math.max(elapsed, 0), span);
    s += `<line class="cvNow" x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="${T}" y2="${H - B}"/>`;
    s += `<circle class="cvDot" cx="${x(t).toFixed(1)}" cy="${y(at(t)).toFixed(1)}" r="4.5"/>`;
  }
  const range = minV === maxV ? `${Math.round(maxV)}°` : `${Math.round(minV)}–${Math.round(maxV)}°`;
  return { svg: s, range, seconds: last.t };
}
