// Home faces from the iPhone app (ControlsView.swift): Digits, Scope and Pour, next to the Gauge.
// Display only. Every face shows the same live temp, target and time left; HEAT IT and CUT IT never move.

export interface Readout {
  tempText: string;
  targetText: string;
  /** 0...1 of the way from room temperature to the target. */
  fill: number;
  heating: boolean;
  secondsLeft: number;
  statusLine: string;
  presetLine: string;
}

export const FACES = [
  { id: "gauge", name: "GAUGE" }, { id: "digits", name: "DIGITS" },
  { id: "scope", name: "SCOPE" }, { id: "pour", name: "POUR" },
] as const;

export const DEMO: Readout = {
  tempText: "412°", targetText: "500°", fill: 0.79, heating: true, secondsLeft: 31,
  statusLine: "HEATING · 0:31 LEFT", presetLine: "PRESET 4 · STEADY",
};
export const DEMO_POINTS = [0.02, 0.04, 0.08, 0.14, 0.22, 0.32, 0.43, 0.54, 0.63, 0.70, 0.75, 0.78, 0.79];

export const clock = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;

/** Keeps the last couple of minutes of temperature for the Scope face. Starts over when a dab starts. */
export class TempTrace {
  points: number[] = [];
  private wasHeating = false;
  add(fill: number, heating: boolean): void {
    if (heating && !this.wasHeating) this.points = [];
    this.wasHeating = heating;
    this.points.push(fill);
    if (this.points.length > 240) this.points.splice(0, this.points.length - 240);
  }
}

const NS = "http://www.w3.org/2000/svg";
function el(tag: string, cls = "", text = ""): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}
const set = (e: Element, t: string) => { if (e.textContent !== t) e.textContent = t; };

export interface Face { root: HTMLElement; update(r: Readout, points: number[]): void }

export function makeFace(id: string): Face | null {
  if (id === "digits") return digits();
  if (id === "scope") return scope();
  if (id === "pour") return pour();
  return null;
}

function digits(): Face {
  const blocks = 30;
  const root = el("div", "face digits");
  const top = el("div", "fRow"); const st = el("span", "tag"); const pl = el("span", "tag"); top.append(st, pl);
  const big = el("div", "dBig");
  const bar = el("div", "dBar");
  const cells: HTMLElement[] = [];
  for (let i = 0; i < blocks; i++) { const c = el("i"); cells.push(c); bar.append(c); }
  bar.append(el("b"));
  const bottom = el("div", "fRow dFoot");
  const l = el("div"); l.append(el("span", "tag", "TIME LEFT")); const left = el("b"); l.append(left);
  const r = el("div"); r.style.textAlign = "right"; r.append(el("span", "tag", "TARGET")); const tgt = el("b", "gold"); r.append(tgt);
  bottom.append(l, r);
  root.append(top, big, bar, bottom);
  return { root, update(x) {
    set(st, x.statusLine); st.classList.toggle("goldTag", x.heating); set(pl, x.presetLine);
    set(big, x.tempText); big.classList.toggle("hot", x.heating);
    cells.forEach((c, i) => c.classList.toggle("on", i < x.fill * blocks));
    set(left, x.heating ? clock(x.secondsLeft) : "--"); set(tgt, x.targetText);
  } };
}

function scope(): Face {
  const root = el("div", "face scope");
  const W = 340, H = 300, top = 0.26, bottom = 0.88;
  const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", class: "scopeSvg" }) as SVGSVGElement;
  let grid = "";
  for (let x = 0; x <= W; x += 34) grid += `M${x} 0V${H}`;
  for (let y = 0; y <= H; y += 30) grid += `M0 ${y}H${W}`;
  s.append(svg("path", { d: grid, class: "sGrid" }));
  s.append(svg("path", { d: `M0 ${H * top}H${W}`, class: "sTarget" }));
  const line = svg("path", { d: "", class: "sTrace" });
  s.append(line);
  const now = el("div", "sNow"); now.append(el("span", "tag", "NOW")); const big = el("b"); now.append(big);
  const tgt = el("span", "tag goldTag sTgt");
  const foot = el("div", "fRow sFoot"); const st = el("span", "tag"); const pl = el("span", "tag"); foot.append(st, pl);
  root.append(s, now, tgt, foot);
  return { root, update(x, pts) {
    set(big, x.tempText); big.classList.toggle("hot", x.heating);
    set(tgt, "TARGET " + x.targetText);
    set(st, x.statusLine); st.classList.toggle("goldTag", x.heating); set(pl, x.presetLine);
    let d = "";
    if (pts.length > 1) {
      const span = Math.max(pts.length - 1, 90);
      pts.forEach((p, i) => {
        const v = Math.min(Math.max(p, 0), 1.15);
        const px = W * i / span, py = H * (bottom - (bottom - top) * v);
        d += (i ? "L" : "M") + px.toFixed(1) + " " + py.toFixed(1);
      });
    }
    line.setAttribute("d", d);
  } };
}

let pourCount = 0;
function pour(): Face {
  const root = el("div", "face pour");
  const W = 340, H = 300;
  const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", class: "pourSvg" });
  const defs = svg("defs", {});
  const gid = `pourGrad${++pourCount}`;   // one id per copy: the Look page shows a second Pour
  const g = svg("linearGradient", { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
  g.append(svg("stop", { offset: 0, "stop-color": "#FFD27A" }), svg("stop", { offset: 0.5, "stop-color": "#E8B24A" }), svg("stop", { offset: 1, "stop-color": "#8A5A12" }));
  defs.append(g); s.append(defs);
  const wave = svg("path", { d: "", fill: `url(#${gid})`, class: "pWave" });
  s.append(wave, svg("path", { d: `M0 ${H * 0.18}H${W}`, class: "sTarget" }));
  const top = el("div", "fRow pTop"); const st = el("span", "tag"); const tgt = el("span", "tag goldTag"); top.append(st, tgt);
  const mid = el("div", "pMid"); const big = el("b"); const line = el("span", "pLine"); mid.append(big, line);
  root.append(s, top, mid);
  return { root, update(x) {
    const level = 0.14 + 0.68 * x.fill;
    const y = H * (1 - level);
    wave.setAttribute("d", `M0 ${y}C${W * 0.17} ${y - 14} ${W * 0.33} ${y + 14} ${W * 0.5} ${y}C${W * 0.67} ${y - 14} ${W * 0.83} ${y + 14} ${W} ${y}L${W} ${H}L0 ${H}Z`);
    set(st, x.heating ? "HEATING" : x.statusLine); st.classList.toggle("goldTag", x.heating);
    set(tgt, "TARGET " + x.targetText);
    set(big, x.tempText);
    set(line, x.heating ? `${clock(x.secondsLeft)} LEFT · ${x.presetLine}` : x.presetLine);
    root.classList.toggle("inGold", x.fill > 0.5);
  } };
}
