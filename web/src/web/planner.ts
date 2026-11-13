// Ride planner: draw your own heat curve (a Custom preset) on the same chart as the preset curves, keep
// it in a small library or on a jar, and send it to a preset. Sending goes through rig.saveCurve, which
// only writes while the rig is idle and then checks the rig's own read-back (RigController.saveCurve).
// Nothing here starts heat.

import { RigController, RigLimits, type CurveStep, type CurveResult } from "../rig/rig-controller";
import { h, tag, openSheet, topBar, textBtn } from "./jar-ui";

const W = 340, H = 220, L = 40, Rm = 14, T = 22, B = 30;
const F_LO = 350, F_HI = 650;          // the editing window: a fixed scale so points don't jump while dragged
const SNAP_F = 5;

export interface PlannedCurve { name: string; steps: CurveStep[] }

/** Starting shapes. Each one passes RigController.curveProblem. */
export const CURVE_TEMPLATES: PlannedCurve[] = [
  { name: "FLAT", steps: [{ t: 0, f: 480 }, { t: 30, f: 480 }] },
  { name: "SLOW START", steps: [{ t: 0, f: 450 }, { t: 15, f: 450 }, { t: 30, f: 500 }] },
  { name: "CLIMB", steps: [{ t: 0, f: 465 }, { t: 45, f: 520 }] },
  { name: "DIP", steps: [{ t: 0, f: 480 }, { t: 15, f: 465 }, { t: 30, f: 480 }] },
  { name: "HOT START", steps: [{ t: 0, f: 540 }, { t: 30, f: 500 }] },
  { name: "WAVE", steps: [{ t: 0, f: 470 }, { t: 12, f: 500 }, { t: 24, f: 480 }, { t: 36, f: 510 }, { t: 48, f: 490 }] },
];

// MARK: Storage (this device only; same prefs store as the rest of the web app)

const KEY_LIB = "torchless.curveLibrary", KEY_JAR = "torchless.jarCurves";
function readJSON<T>(k: string, fallback: T): T {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : fallback; } catch { return fallback; }
}
function writeJSON(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }
const clean = (s: CurveStep[]) => s.map(x => ({ t: Math.round(x.t), f: Math.round(x.f) }));

export const curveLibrary = {
  all(): PlannedCurve[] { return readJSON<PlannedCurve[]>(KEY_LIB, []).filter(c => c && Array.isArray(c.steps) && !RigController.curveProblem(c.steps)); },
  save(name: string, steps: CurveStep[]) {
    const list = this.all().filter(c => c.name !== name);
    list.unshift({ name, steps: clean(steps) });
    writeJSON(KEY_LIB, list.slice(0, 24));
  },
  remove(name: string) { writeJSON(KEY_LIB, this.all().filter(c => c.name !== name)); },
  forJar(id: string): CurveStep[] | null {
    const s = readJSON<Record<string, CurveStep[]>>(KEY_JAR, {})[id];
    return s && !RigController.curveProblem(s) ? s : null;
  },
  setJar(id: string, steps: CurveStep[] | null) {
    const all = readJSON<Record<string, CurveStep[]>>(KEY_JAR, {});
    if (steps) all[id] = clean(steps); else delete all[id];
    writeJSON(KEY_JAR, all);
  },
};

// MARK: Drawing

interface Geo { span: number; px(t: number): number; py(f: number): number; tOf(x: number): number; fOf(y: number): number }
function geo(span: number): Geo {
  const iw = W - L - Rm, ih = H - T - B;
  return {
    span,
    px: t => L + (t / span) * iw,
    py: f => T + (1 - (f - F_LO) / (F_HI - F_LO)) * ih,
    tOf: x => ((x - L) / iw) * span,
    fOf: y => F_LO + (1 - (y - T) / ih) * (F_HI - F_LO),
  };
}
const spanFor = (steps: CurveStep[]) => Math.min(100, Math.max(30, Math.ceil((steps[steps.length - 1].t + 8) / 10) * 10));

/** Which segments break the slope rules, so they can be drawn in the warning colour. */
function badSegments(steps: CurveStep[]): boolean[] {
  return steps.slice(1).map((s, i) => {
    const dt = s.t - steps[i].t, df = s.f - steps[i].f;
    return dt <= 0 || df > 10 * dt || df < -3 * dt;
  });
}

function svgFor(steps: CurveStep[], g: Geo, sel: number, celsius: boolean): string {
  const n = (x: number) => x.toFixed(1);
  const base = H - B;
  const shown = (f: number) => celsius ? RigLimits.celsius(f) : f;
  let s = `<defs><linearGradient id="plA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="cvStopTop"/><stop offset="1" class="cvStopBottom"/></linearGradient></defs>`;
  for (let f = 400; f <= 600; f += 50) {
    s += `<line class="cvGrid" x1="${L}" x2="${W - Rm}" y1="${n(g.py(f))}" y2="${n(g.py(f))}"/>`;
    s += `<text class="cvAxis" x="${L - 7}" y="${n(g.py(f) + 3.4)}" text-anchor="end">${shown(f)}°</text>`;
  }
  s += `<line class="cvBase" x1="${L}" x2="${W - Rm}" y1="${base}" y2="${base}"/>`;
  for (let t = 0; t <= g.span; t += 10) {
    s += `<line class="cvTick" x1="${n(g.px(t))}" x2="${n(g.px(t))}" y1="${base}" y2="${base + 4}"/>`;
    s += `<text class="cvAxis" x="${n(g.px(t))}" y="${H - 12}" text-anchor="${t === 0 ? "start" : "middle"}">${t === 0 ? "0s" : t}</text>`;
  }
  const line = steps.map((p, i) => `${i ? "L" : "M"}${n(g.px(p.t))} ${n(g.py(p.f))}`).join(" ");
  const last = steps[steps.length - 1];
  s += `<path d="${line} L${n(g.px(last.t))} ${base} L${n(g.px(0))} ${base} Z" fill="url(#plA)"/>`;
  s += `<path class="cvGlow" d="${line}"/>`;
  const bad = badSegments(steps);
  steps.slice(1).forEach((p, i) => {
    const a = steps[i];
    s += `<path class="${bad[i] ? "plBad" : "cvLine"}" d="M${n(g.px(a.t))} ${n(g.py(a.f))} L${n(g.px(p.t))} ${n(g.py(p.f))}"/>`;
  });
  s += `<line class="cvExtEdge" x1="${n(g.px(last.t))}" x2="${n(g.px(last.t))}" y1="${T - 6}" y2="${base}"/>`;
  steps.forEach((p, i) => {
    const x = g.px(p.t), y = g.py(p.f), on = i === sel;
    s += `<circle class="plHalo${on ? " on" : ""}" cx="${n(x)}" cy="${n(y)}" r="16"/>`;
    s += `<circle class="cvPt${on ? " plSel" : ""}" cx="${n(x)}" cy="${n(y)}" r="${on ? 6.5 : 5}"/>`;
    const below = y < T + 22;
    s += `<text class="cvVal" x="${n(Math.min(Math.max(x, L + 14), W - Rm - 14))}" y="${n(below ? y + 22 : y - 12)}" text-anchor="middle">${shown(p.f)}°</text>`;
  });
  return s;
}

// MARK: The planner sheet

export interface PlannerHooks {
  rig: RigController;
  /** The preset the Home screen has selected (1 to 5), or 0. */
  selected(): number;
  celsius(): boolean;
  /** The current jar, if there is one: its id and a short name. */
  currentJar(): { id: string; name: string } | null;
  confirm(title: string, body: string, yes: string, onYes: () => void): void;
}

/** Opens the planner on `start` (the selected preset's curve, a jar's curve or a template). Returns a
 *  function the app calls on every rig change while the sheet is open. */
export function openPlanner(hooks: PlannerHooks, start: CurveStep[]): () => void {
  let steps: CurveStep[] = clean(start.length >= 2 ? start : CURVE_TEMPLATES[1].steps);
  let sel = 0;
  let span = spanFor(steps);
  let target = Math.min(5, Math.max(1, hooks.selected() || 1));
  let sending = false;
  let status = "";
  /** THIS DAB: one dab, then the preset goes back. KEEP: the preset keeps the curve. */
  let once = true;
  let redraw = () => {};
  let closeIt = () => {};
  let open = true;

  openSheet(close => {
    closeIt = () => { open = false; close(); };
    const body = h("div", { class: "pageBody" });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("class", "plSvg");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Your heat curve. Drag a point to move it.");
    const head = h("div", { class: "curveHead" });
    const stats = h("div", { class: "curveStats" });
    const problemLine = h("p", { class: "mono plProblem", role: "status" });
    const pointRow = h("div", { class: "plPointRow" });
    const tools = h("div", { class: "row", style: "gap:8px;flex-wrap:wrap" });
    const tmplRow = h("div", { class: "plChips" });
    const libBox = h("div", { class: "stackS" });
    const sendBox = h("div", { class: "stackS" });
    const nameBox = h("input", { class: "plName", type: "text", maxlength: "24", "aria-label": "Curve name", autocomplete: "off" }) as HTMLInputElement;

    // Dragging: the first point stays at 0 s (temp only); the others stay between their neighbours.
    let drag: { i: number; id: number } | null = null;
    const toLocal = (e: PointerEvent) => {
      const r = svg.getBoundingClientRect();
      return { x: (e.clientX - r.left) * W / Math.max(r.width, 1), y: (e.clientY - r.top) * H / Math.max(r.height, 1) };
    };
    const nearest = (x: number, y: number) => {
      const g = geo(span);
      let best = -1, d = 26 * 26;
      steps.forEach((p, i) => { const dx = g.px(p.t) - x, dy = g.py(p.f) - y, dd = dx * dx + dy * dy; if (dd < d) { d = dd; best = i; } });
      return best;
    };
    const place = (i: number, x: number, y: number) => {
      const g = geo(span);
      const f = Math.round(Math.min(F_HI, Math.max(RigLimits.tempF[0], g.fOf(y))) / SNAP_F) * SNAP_F;
      let t = steps[i].t;
      if (i > 0) {
        const lo = steps[i - 1].t + 1;
        const hi = i < steps.length - 1 ? steps[i + 1].t - 1 : RigLimits.hold[1];
        t = Math.round(Math.min(hi, Math.max(lo, g.tOf(x))));
      }
      steps[i] = { t, f: Math.min(RigLimits.tempF[1], f) };
    };
    svg.addEventListener("pointerdown", e => {
      const p = toLocal(e);
      const i = nearest(p.x, p.y);
      if (i < 0) return;
      sel = i; drag = { i, id: e.pointerId };
      try { svg.setPointerCapture(e.pointerId); } catch { /* fine */ }
      e.preventDefault();
      redraw();
    });
    svg.addEventListener("pointermove", e => {
      if (!drag || drag.id !== e.pointerId) return;
      const p = toLocal(e);
      place(drag.i, p.x, p.y);
      status = "";
      drawChart();
    });
    const endDrag = () => { if (drag) { drag = null; span = spanFor(steps); redraw(); } };
    svg.addEventListener("pointerup", endDrag);
    svg.addEventListener("pointercancel", endDrag);

    const drawChart = () => {
      svg.innerHTML = svgFor(steps, geo(span), sel, hooks.celsius());
      const deg = (f: number) => `${hooks.celsius() ? RigLimits.celsius(f) : f}°`;
      const fs = steps.map(s => s.f), lo = Math.min(...fs), hi = Math.max(...fs);
      head.replaceChildren(
        h("div", {}, tag(`CUSTOM · PRESET ${target}`, "font-size:9.5px"), h("div", { class: "curveTitle" }, `${steps.length} POINTS`)),
        h("div", { class: "curveHero" }, h("small", {}, lo === hi ? "HOLDS AT" : "RANGE"), h("span", {}, lo === hi ? deg(hi) : `${hooks.celsius() ? RigLimits.celsius(lo) : lo}–${deg(hi)}`)));
      stats.replaceChildren(...([["START", deg(steps[0].f)], ["PEAK", deg(hi)], ["LOW", deg(lo)], ["HOLD", `${steps[steps.length - 1].t}s`]] as const)
        .map(([k, v]) => h("div", {}, tag(k, "font-size:8.5px"), h("b", {}, v))));
      const why = RigController.curveProblem(steps);
      problemLine.textContent = why ?? "";
      problemLine.hidden = !why;
      const p = steps[sel];
      pointRow.replaceChildren(
        stepper(`POINT ${sel + 1} · TEMP`, deg(p.f), "temperature", () => nudge(0, -SNAP_F), () => nudge(0, SNAP_F)),
        stepper(sel === 0 ? "TIME · 0 S" : `POINT ${sel + 1} · TIME`, `${p.t}s`, "time", () => nudge(-1, 0), () => nudge(1, 0), sel === 0));
    };
    const stepper = (label: string, v: string, what: string, down: () => void, up: () => void, locked = false) =>
      h("div", { class: "plStep" }, h("span", { class: "tag", style: "font-size:8.5px" }, label),
        h("button", { class: "btn2", "aria-label": `Lower ${what}`, disabled: locked, onclick: down }, "−"),
        h("b", { class: "cond" }, v),
        h("button", { class: "btn2", "aria-label": `Raise ${what}`, disabled: locked, onclick: up }, "+"));
    const nudge = (dt: number, df: number) => {
      const p = steps[sel];
      const lo = sel > 0 ? steps[sel - 1].t + 1 : 0, hi = sel > 0 ? (sel < steps.length - 1 ? steps[sel + 1].t - 1 : RigLimits.hold[1]) : 0;
      steps[sel] = { t: Math.min(hi, Math.max(lo, p.t + dt)), f: Math.min(RigLimits.tempF[1], Math.max(RigLimits.tempF[0], p.f + df)) };
      span = spanFor(steps); status = "";
      redraw();
    };

    const addPoint = () => {
      if (steps.length >= 5) return;
      // Split the longest stretch in half.
      let at = 1, gap = -1;
      for (let i = 1; i < steps.length; i++) { const d = steps[i].t - steps[i - 1].t; if (d > gap) { gap = d; at = i; } }
      if (gap < 2) return;
      const a = steps[at - 1], b = steps[at];
      steps.splice(at, 0, { t: Math.round((a.t + b.t) / 2), f: Math.round((a.f + b.f) / 2 / SNAP_F) * SNAP_F });
      sel = at; status = "";
      redraw();
    };
    const removePoint = () => {
      if (steps.length <= 2 || sel === 0) return;
      steps.splice(sel, 1);
      sel = Math.min(sel, steps.length - 1); span = spanFor(steps); status = "";
      redraw();
    };

    const send = () => {
      const why = RigController.curveProblem(steps);
      if (why || sending) return;
      const p = target, one = once;
      hooks.confirm(one ? `Use on P${p} for one dab?` : `Replace P${p}?`,
        one ? `P${p} goes back after the dab.` : `P${p} keeps this curve.`,
        "SEND", () => {
          sending = true; status = "Sending…"; redraw();
          const done = (r: CurveResult) => {
            sending = false;
            status = r === "ok" ? (one ? `Ready. Heat P${p}.` : `P${p} saved.`)
              : r === "MISMATCH" ? `Rig didn't match. Check P${p}.`
              : r === "no report" ? `Sent. Rig didn't confirm.`
              : `Didn't finish. Try again.`;
            if (open) redraw();
          };
          const copy = steps.map(s => ({ ...s }));
          const went = one ? hooks.rig.saveCurveOnce(p, copy, done) : hooks.rig.saveCurve(p, copy, done);
          window.setTimeout(() => { if (sending) done("dropped"); }, 15000);
          if (!went) { sending = false; status = ""; }
          redraw();
        });
    };

    redraw = () => {
      drawChart();
      tools.replaceChildren(
        h("button", { class: "chip", disabled: steps.length >= 5, onclick: addPoint }, "+ POINT"),
        h("button", { class: "chip", disabled: steps.length <= 2 || sel === 0, onclick: removePoint }, "− POINT"));
      tmplRow.replaceChildren(...CURVE_TEMPLATES.map(c => h("button", { class: "chip", onclick: () => {
        steps = clean(c.steps); sel = 0; span = spanFor(steps); status = ""; redraw();
      } }, c.name)));

      const jar = hooks.currentJar();
      const lib = curveLibrary.all();
      const jarCurve = jar ? curveLibrary.forJar(jar.id) : null;
      const ok = !RigController.curveProblem(steps);
      nameBox.placeholder = `CURVE ${lib.length + 1}`;
      libBox.replaceChildren(...[
        nameBox,
        h("div", { class: "row", style: "gap:8px" },
          h("button", { class: "btn2", style: "flex:1", disabled: !ok, onclick: () => {
            const name = (nameBox.value || `CURVE ${lib.length + 1}`).trim().toUpperCase().slice(0, 24);
            curveLibrary.save(name, steps); nameBox.value = ""; status = `Saved as ${name}.`; redraw();
          } }, "SAVE CURVE"),
          jar ? h("button", { class: "btn2", style: "flex:1", disabled: !ok, onclick: () => {
            curveLibrary.setJar(jar.id, steps); status = `Saved on ${jar.name}.`; redraw();
          } }, "SAVE ON JAR") : null),
        jar && jarCurve ? h("button", { class: "soundRow", onclick: () => { steps = clean(jarCurve); sel = 0; span = spanFor(steps); status = ""; redraw(); } },
          h("div", { style: "flex:1;min-width:0" }, h("b", { class: "cond" }, `${jar.name.toUpperCase()}'S CURVE`), h("small", { class: "mono" }, summary(jarCurve))), tag("LOAD", "font-size:9px")) : null,
        ...lib.map(c => h("div", { class: "row", style: "gap:8px" },
          h("button", { class: "soundRow", style: "flex:1", onclick: () => { steps = clean(c.steps); sel = 0; span = spanFor(steps); status = ""; redraw(); } },
            h("div", { style: "flex:1;min-width:0" }, h("b", { class: "cond" }, c.name), h("small", { class: "mono" }, summary(c.steps))), tag("LOAD", "font-size:9px")),
          h("button", { class: "textBtn", "aria-label": `Delete ${c.name}`, onclick: () => { curveLibrary.remove(c.name); redraw(); } }, "✕"))),
      ].filter((x): x is HTMLElement => x !== null));

      const rig = hooks.rig;
      const linked = rig.connected && !!rig.live && rig.linkFresh;
      const heating = rig.sessionOn;
      const owed = rig.curveRestore;
      const why = !linked ? "Link the rig first." : heating ? "Wait for heat to stop." : RigController.curveProblem(steps)
        ?? (once ? rig.oneDabProblem(target) : null);
      sendBox.replaceChildren(...[
        h("div", { class: "seg", style: "grid-template-columns:1fr 1fr;margin-top:0" },
          h("button", { class: once ? "on" : "", "aria-pressed": String(once), onclick: () => { once = true; status = ""; redraw(); } }, "THIS DAB"),
          h("button", { class: once ? "" : "on", "aria-pressed": String(!once), onclick: () => { once = false; status = ""; redraw(); } }, "KEEP")),
        h("div", { class: "seg", style: "grid-template-columns:repeat(5,1fr);margin-top:0" },
          ...[1, 2, 3, 4, 5].map(n => h("button", { class: n === target ? "on" : "", "aria-label": `Preset ${n}`, onclick: () => { target = n; status = ""; redraw(); } }, `P${n}`))),
        h("button", { class: "btn2 tall wide", style: "color:var(--gold);border-color:var(--gold)", disabled: !!why || sending, onclick: send },
          sending ? "SENDING…" : `SEND TO P${target}`),
        h("p", { class: "mono dim", style: "font-size:10px;margin:0" },
          status || why || (once ? "Goes back after the dab." : "Stays on the preset.")),
        owed ? h("div", { class: "row", style: "gap:8px;align-items:center" },
          h("p", { class: "mono", style: "font-size:10px;margin:0;flex:1" }, owed.used ? `P${owed.p} goes back when idle.` : `P${owed.p} is set for one dab.`),
          h("button", { class: "chip", disabled: !linked || heating, onclick: () => { rig.putBackNow(); } }, "PUT BACK")) : null,
      ].filter((x): x is HTMLElement => x !== null));
    };

    body.append(
      topBar(textBtn("Done", () => { closeIt(); }), h("b", { class: "cond", style: "font-size:20px;letter-spacing:2px" }, "RIDE PLANNER"), null),
      h("div", { class: "curveCard", style: "margin-top:4px" }, head, svg, stats, problemLine,
        h("p", { class: "mono dim", style: "font-size:10px;margin:8px 0 0" }, "Drag the points.")),
      pointRow, tools,
      tag("START FROM", "font-size:9.5px;margin-top:4px"), tmplRow,
      tag("MY CURVES", "font-size:9.5px;margin-top:4px"), libBox,
      tag("SEND", "font-size:9.5px;margin-top:4px"), sendBox,
    );
    redraw();
    return body;
  });
  return () => { if (open) redraw(); };
}

function summary(steps: CurveStep[]): string {
  return steps.map(s => `${s.f}° @ ${s.t}s`).join(" → ");
}
