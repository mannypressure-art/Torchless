// Torch mode: a heat-up and cool-down timer for people using a glass banger and a butane torch. No rig, no Bluetooth.
// CONTRACT (do not change the signatures): mountTorch renders into `root` and returns the handle below.
//
// The app cannot see the glass, so nothing here shows a temperature: only the times the user picked.
// Every countdown is kept as an absolute end time (Date.now), because a locked phone or a background tab
// freezes page JavaScript. One tick() works out where the run is from the clock alone, so coming back to the
// page always lands in the right state. Sound goes through the app's heat sound engine (pref "heatSound").

import { JarStore, JarDab, uid, photoURLs } from "./jars";
import { DabWatcher } from "./dab-watcher";
import { heatSound } from "./heatfx";
import { h, tag, icon } from "./jar-ui";

export interface TorchDeps {
  jars: JarStore;
  watcher: DabWatcher;
  prefs: { get(k: string): string | null; set(k: string, v: string): void };
  /** Ask the app to keep the screen awake (true) or let it sleep (false). */
  keepAwake(on: boolean): void;
  /** Open the Jars tab. */
  openJars(): void;
}

export interface TorchUI {
  /** The Torch tab became visible (true) or hidden (false). */
  setVisible(on: boolean): void;
  /** True while a heat-up or cool-down countdown is running. */
  readonly running: boolean;
  /** Redraw after jars changed (current jar strip). */
  renderJar(): void;
}

// MARK: Setups (saved times)

type Style = "hot" | "cold" | "gauge";
/** One stretch of torching. A setup has one to three: a slurper might go BOTTOM, MIDDLE, BOTTOM. */
interface Step { cue: string; secs: number }
interface Setup {
  name: string;
  style: Style;
  /** Hot dab: torch steps, run back to back. */
  steps: Step[];
  /** Seconds of cool-down for a hot dab. */
  cool: number;
  /** Cold start: the seconds of the last time DONE TORCHING was tapped (a guide mark on the dial), if any. */
  cold?: number;
  /** Gauge: the user's own "dab at" number for their banger thermometer (°F). Not a reading: the app never sees it. */
  dabAt: number;
  /** Gauge: optional "torch to" number (°F). */
  torchTo?: number;
}

const LIMITS = { torch: [5, 120], cool: [0, 180], cold: [1, 90], dabAt: [300, 900], torchTo: [300, 1000] } as const;
const GAUGE_DAB = 500, GAUGE_TORCH = 650;
const tens = (v: unknown, d: number, lim: readonly [number, number]) => Math.round(num(v, d, lim) / 10) * 10;
const MAX_SETUPS = 4;
const MAX_STEPS = 3;
const NAME_MAX = 18;
/** Cold start counts up and stops here, whatever happens. */
const COLD_CAP = 90;
/** The heads-up before the torch or the cool-down ends. */
const WARN_AT = 10;
const CUES = ["ALL OVER", "BOTTOM", "MIDDLE", "TOP", "WALLS"];
/** Starting points for a new setup. Only a guide: every time stays editable. */
const TEMPLATES: { name: string; label: string; steps: Step[]; cool: number }[] = [
  { name: "THIN QUARTZ", label: "THIN QUARTZ", steps: [{ cue: "ALL OVER", secs: 25 }], cool: 45 },
  { name: "THICK 25MM", label: "THICK 25MM QUARTZ", steps: [{ cue: "ALL OVER", secs: 45 }], cool: 60 },
  { name: "SLURPER", label: "SLURPER · 3 STEPS", steps: [{ cue: "BOTTOM", secs: 40 }, { cue: "MIDDLE", secs: 40 }, { cue: "BOTTOM", secs: 20 }], cool: 60 },
];
/** Small torch: this much more heat on the first step. */
const SMALL_TORCH = 15;
/** The rating pop-up shows this long after DAB IT, same wait as a rig dab. DONE shows it at once. */
const PROMPT_DELAY = DabWatcher.promptDelay;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, d: number, [lo, hi]: readonly [number, number]) =>
  typeof v === "number" && Number.isFinite(v) ? clamp(Math.round(v), lo, hi) : d;
const torchTotal = (s: { steps: Step[] }) => s.steps.reduce((a, x) => a + x.secs, 0);

function freshSetup(name: string): Setup { return { name, style: "gauge", steps: [{ cue: "ALL OVER", secs: 30 }], cool: 45, dabAt: GAUGE_DAB }; }

function readSetups(raw: string | null): Setup[] {
  let list: Setup[] = [];
  try {
    const data: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(data)) {
      list = data.slice(0, MAX_SETUPS).filter((x): x is Record<string, unknown> => !!x && typeof x === "object").map((x, i) => {
        const raw = Array.isArray(x.steps) ? x.steps.slice(0, MAX_STEPS).filter((y): y is Record<string, unknown> => !!y && typeof y === "object") : [];
        let steps: Step[] = raw.map(y => ({ cue: typeof y.cue === "string" && CUES.includes(y.cue) ? y.cue : "ALL OVER", secs: num(y.secs, 30, LIMITS.torch) }));
        if (!steps.length) steps = [{ cue: "ALL OVER", secs: num(x.torch, 30, LIMITS.torch) }];   // first version kept one "torch" number
        const s: Setup = {
          name: (typeof x.name === "string" ? x.name.trim().slice(0, NAME_MAX) : "") || `SETUP ${i + 1}`,
          style: x.style === "cold" ? "cold" : x.style === "gauge" ? "gauge" : "hot",
          steps, cool: num(x.cool, 45, LIMITS.cool), dabAt: tens(x.dabAt, GAUGE_DAB, LIMITS.dabAt),
        };
        if (typeof x.torchTo === "number") s.torchTo = tens(x.torchTo, GAUGE_TORCH, LIMITS.torchTo);
        // The first version kept a fixed cold-start time; a count-up only keeps a guide, and only once it was tapped.
        if (typeof x.cold === "number" && Array.isArray(x.steps)) s.cold = num(x.cold, 10, LIMITS.cold);
        return s;
      });
    }
  } catch { /* bad JSON: start over */ }
  return list.length ? list : [freshSetup("MY BANGER")];
}

const clock = (s: number) => s < 60 ? String(s) : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const secs = (s: number) => s < 60 ? `${s}s` : clock(s);
function ago(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 90 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
}
const buzz = (p: number | number[]) => { try { navigator.vibrate?.(p); } catch { /* fine */ } };

// MARK: Look (one style element; the rest of the look comes from the app's own classes)

const CSS = `
.tm-root > * + * { margin-top: 14px; }
.tm-card { position: relative; height: 300px; border-radius: 30px; overflow: hidden; display: grid; place-items: center; transition: border-color .4s, box-shadow .4s; }
.tm-dial { width: 252px; height: 252px; overflow: visible; }
.tm-track { fill: none; stroke: var(--edge); stroke-width: 6; }
.tm-arc { fill: none; stroke: var(--live); stroke-width: 6; stroke-linecap: round; }
.tm-fx { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 2; }
.tm-read { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 196px; text-align: center; pointer-events: none; z-index: 3; }
.tm-top { display: block; font-size: 9.5px; letter-spacing: 2px; white-space: nowrap; }
.tm-num { display: block; margin: 5px 0 6px; font: 700 100px/.9 var(--cond); font-variant-numeric: tabular-nums; letter-spacing: 1px; color: var(--ink); }
.tm-num.tm-long { font-size: 82px; }
.tm-num.tm-word { font-size: 70px; letter-spacing: 3px; color: var(--live); text-shadow: 0 0 22px color-mix(in srgb, var(--live) 55%, transparent); }
.tm-status { font: 600 10px/1.2 var(--mono); letter-spacing: 2px; color: var(--dim); white-space: nowrap; }
.tm-corner { z-index: 3; }
.tm-corner b small { font: 600 13px var(--cond); margin-left: 1px; color: var(--dim); }
.tm-gold { color: var(--gold); }
.tm-on .tm-card { border-color: color-mix(in srgb, var(--tm-fire) 45%, var(--edge)); }
.tm-dab .tm-card { border-color: var(--live); box-shadow: 0 0 26px color-mix(in srgb, var(--live) 28%, transparent); }
.tm-pop { animation: tm-pop .55s cubic-bezier(.2, 1.5, .4, 1) both; }
@keyframes tm-pop { 0% { transform: scale(.55); opacity: 0; } 60% { opacity: 1; } 100% { transform: scale(1); } }
.tm-keys { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 8px; }
.tm-keys .key { min-width: 0; padding: 4px 2px; }
.tm-keys .key small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 4px; text-transform: uppercase; }
.tm-keys .key span { display: block; font-size: 22px; white-space: nowrap; }
.tm-keys .tm-add span { color: var(--gold); font-size: 28px; }
.tm-edit { position: relative; }
.tm-edit::after { content: ""; position: absolute; inset: -7px -6px; }
.tm-say { margin: 8px 2px 0; font: 500 11px/1.5 var(--mono); color: var(--sub); }
.tm-note { margin: 10px 6px 0; text-align: center; font: 500 10.5px/1.55 var(--mono); color: var(--sub); }
.tm-go { color: var(--liveInk); background: linear-gradient(#5FF0FF, var(--liveFill), #10B9D0); box-shadow: 0 0 16px color-mix(in srgb, var(--liveFill) 35%, transparent); }
.tm-stop { flex: 1; color: var(--goldInk); background: linear-gradient(#FFD27A, var(--goldFill), #C98F25); box-shadow: 0 0 16px color-mix(in srgb, var(--goldFill) 35%, transparent); }
.tm-side { width: 74px; flex: none; min-height: 84px; text-align: center; }
.tm-side b { display: block; font: 700 28px/1 var(--cond); color: var(--live); margin-bottom: 5px; }
.tm-off { width: 100%; min-height: 58px; margin-top: 10px; border-radius: 16px; border: 1px solid color-mix(in srgb, var(--warn) 60%, transparent); color: var(--warn); font: 700 22px var(--cond); letter-spacing: 3px; }
.tm-mid { font-size: 30px; letter-spacing: 3px; }
.tm-off .ico { width: 20px; height: 20px; margin-right: 8px; vertical-align: -3px; }
.tm-status.tm-capIt { margin-top: 2px; font-size: 13px; letter-spacing: 5px; color: var(--gold); }
.tm-stepMark { stroke: var(--sub); stroke-width: 2.5; stroke-linecap: round; }
.tm-refMark { stroke: var(--gold); stroke-width: 3; stroke-linecap: round; }
.tm-refTip { fill: var(--gold); }
.tm-next { margin-top: 22px; padding: 14px; border-radius: 18px; }
.tm-nextRow { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 10px; }
.tm-nextKey { min-height: 48px; border-radius: 12px; border: 1px solid var(--edge); background: var(--cardBottom); color: var(--sub); font: 600 17px var(--cond); letter-spacing: 1px; white-space: nowrap; }
.tm-nextKey.on { color: var(--goldInk); background: var(--goldFill); border-color: var(--goldFill); }
.tm-next .tm-say { min-height: 1.5em; }
.tm-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.tm-sheet .seg { margin-top: 8px; }
.tm-sheet .sheetBody { max-height: calc(100vh - 16px); overflow-y: auto; overscroll-behavior: contain; }
.tm-sheet .field .row { gap: 8px; }
.tm-sheet .field > .row + .row { margin-top: 8px; }
.tm-sheet select.tm-cue { width: auto; flex: 1; min-width: 0; max-width: 170px; margin: 0; min-height: 44px; font-size: 16px; }
.tm-sheet .tm-x { flex: none; display: grid; place-items: center; color: var(--sub); }
.tm-sheet .tm-x .ico { width: 18px; height: 18px; }
.tm-sheet .tm-addStep { margin: -4px 0 16px; color: var(--gold); border-style: dashed; border-color: color-mix(in srgb, var(--gold) 60%, transparent); }
.tm-sheet .catGrid { margin-top: 8px; }
.tm-sheet .catKey { font-size: 15px; padding: 0 6px; }
.tm-sheet input[type=range] { flex: 1; min-width: 0; }
.tm-sheet .textLine { margin-top: 8px; text-transform: uppercase; }
.tm-sheet .field b small { font: 600 15px var(--cond); color: var(--dim); margin-left: 3px; }
:root { --tm-fire: #FF7A1A; }
:root[data-theme="light"] { --tm-fire: #D6540A; }
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { --tm-fire: #D6540A; } }
@media (prefers-reduced-motion: reduce) { .tm-pop { animation: none; } .tm-card { transition: none; } }
`;

type RGB = [number, number, number];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const rgba = (c: RGB, a: number) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
function parseColor(v: string, fallback: RGB): RGB {
  const m = /^#([0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

/** A soft round dot, drawn once and stamped many times. */
function dot(c: RGB, stops: [number, number][]): HTMLCanvasElement {
  const el = document.createElement("canvas");
  el.width = el.height = 64;
  const x = el.getContext("2d")!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  for (const [at, a] of stops) g.addColorStop(at, rgba(c, a));
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  return el;
}

interface Mote { x: number; y: number; vx: number; vy: number; life: number; max: number; s: number; kind: number; ph: number }

type Phase = "ready" | "torch" | "cool" | "dab";
interface Run {
  style: Style;
  /** Which saved setup this run came from (the editor is shut while a run is on, so it stays put). */
  setupIdx: number;
  startAt: number;
  /** Hot dab: the steps and when each one ends (absolute ms). Cold start: none. */
  steps: Step[];
  stepEnds: number[];
  /** Hot dab: the end of the last step. Cold start: the safety cap. */
  torchEnd: number;
  /** Ring length of the torch phase (ms): the planned torch, or the cap for a cold start. */
  torchPlan: number;
  /** Cold start: the guide mark (s) at the start of this run. */
  coldRef?: number;
  /** Planned cool-down (s). */
  coolSecs: number;
  /** Torch time actually run (ms), set when the torch phase ends. */
  torchMs: number;
  coolStart: number;
  coolEnd: number;
  /** Dial heat (0 to 1) when the torch came off. */
  heatOff: number;
  lastTick: number;
  dabAt: number;
  /** The step the user was last told about. */
  step: number;
  warnedTorch: boolean;
  warnedCool: boolean;
  passedRef: boolean;
  capped: boolean;
  /** After DAB IT: the one-tap "next time" nudge. */
  next: { orig: number; pick: -1 | 0 | 1 | null; note: string } | null;
}

export function mountTorch(root: HTMLElement, deps: TorchDeps): TorchUI {
  if (!document.getElementById("tm-style")) document.head.append(h("style", { id: "tm-style" }, CSS));
  root.classList.add("tm-root");

  // MARK: State
  let setups = readSetups(deps.prefs.get("torch.setups"));
  let sel = clamp(Number(deps.prefs.get("torch.setup") ?? 0) || 0, 0, setups.length - 1);
  const setup = () => setups[sel];
  const saveSetups = () => { deps.prefs.set("torch.setups", JSON.stringify(setups)); deps.prefs.set("torch.setup", String(sel)); };

  let phase: Phase = "ready";
  let run: Run | null = null;
  let pending: { jarID: string | null; dab: JarDab; at: number } | null = null;
  let shown = true;
  let timer = 0;
  let note: { tag: string; text: string } | null = null;
  const theme = () => deps.prefs.get("heatSound") ?? "chimes";
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  /** A moment that passed more than this long ago (the page was away) gets no sound. */
  const FRESH = 1500;

  // MARK: The dial card
  const NS = "http://www.w3.org/2000/svg";
  const C = 2 * Math.PI * 106;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 260 260");
  svg.setAttribute("class", "tm-dial");
  svg.setAttribute("aria-hidden", "true");
  let ticks = "";
  for (let i = 0; i < 60; i++) {
    const major = i % 5 === 0;
    ticks += `<line x1="130" y1="4" x2="130" y2="${major ? 13 : 8}" class="${major ? "tickMajor" : "tickMinor"}" transform="rotate(${i * 6} 130 130)"/>`;
  }
  svg.innerHTML =
    `<defs><radialGradient id="tmFace" cx="50%" cy="38%" r="70%"><stop offset="0" style="stop-color:var(--faceTop)"/><stop offset="1" style="stop-color:var(--faceBottom)"/></radialGradient>` +
    `<radialGradient id="tmHeat" cx="50%" cy="50%" r="50%"><stop offset=".5" stop-opacity="0"/><stop offset=".84" stop-opacity=".3"/><stop offset="1" stop-opacity=".8"/></radialGradient></defs>` +
    `<circle cx="130" cy="130" r="138" class="bezelEdge"/><circle cx="130" cy="130" r="137" class="bezel"/>` +
    `<circle cx="130" cy="130" r="130" fill="url(#tmFace)"/><circle id="tmHeatDisc" cx="130" cy="130" r="130" fill="url(#tmHeat)" opacity="0"/>` +
    ticks + `<circle cx="130" cy="130" r="106" class="tm-track"/>` +
    `<circle id="tmArc" cx="130" cy="130" r="106" class="tm-arc" transform="rotate(-90 130 130)" stroke-dasharray="0 ${C}" visibility="hidden"/>` +
    `<g id="tmMarks"></g>`;
  const arc = svg.querySelector("#tmArc") as SVGCircleElement;
  const heatDisc = svg.querySelector("#tmHeatDisc") as SVGCircleElement;
  const heatStops = Array.from(svg.querySelectorAll("#tmHeat stop")) as SVGStopElement[];
  const marks = svg.querySelector("#tmMarks") as SVGGElement;
  let marksKey = "";

  const canvas = h("canvas", { class: "tm-fx", "aria-hidden": "true" }) as HTMLCanvasElement;
  const g2 = canvas.getContext("2d");
  const topEl = tag("", ""); topEl.classList.add("tm-top");
  const numEl = h("b", { class: "tm-num" });
  const statusEl = h("div", { class: "tm-status" });
  const read = h("div", { class: "tm-read", role: "timer", "aria-live": "off" }, topEl, numEl, statusEl);
  const corner = (pos: string, label: string, gold = false) => {
    const b = h("b", { class: gold ? "tm-gold" : "" });
    const t = tag(label, "font-size:9px");
    return { el: h("div", { class: `corner tm-corner ${pos}` }, t, b), b, t };
  };
  const cTorch = corner("tl", "TORCH", true), cCool = corner("tr", "COOL DOWN"), cStyle = corner("bl", "STYLE"), cTotal = corner("br", "TOTAL");
  const card = h("div", { class: "tm-card panel" });
  card.append(svg, canvas, read, cTorch.el, cCool.el, cStyle.el, cTotal.el);
  const sr = h("div", { class: "tm-sr", "aria-live": "assertive" });
  const say = (t: string) => { sr.textContent = t; };

  // A note above the dial: "While you were away", or the cold-start safety cap.
  const noteTag = tag("");
  const noteText = h("p", {});
  const noteBox = h("div", { class: "notice note", hidden: true },
    h("span", { class: "icon", style: "color:var(--gold)" }, icon("check")),
    h("div", {}, noteTag, noteText),
    h("button", { class: "gotIt", onclick: () => { note = null; paint(); } }, "GOT IT"));
  const away = (text: string) => { note = { tag: "WHILE YOU WERE AWAY", text }; };

  // MARK: Controls
  const segHot = h("button", { onclick: () => setStyle("hot") }, "TIMER");
  const segCold = h("button", { onclick: () => setStyle("cold") }, "COLD START");
  const segGauge = h("button", { onclick: () => setStyle("gauge") }, "TEMP");
  const readyNote = h("p", { class: "tm-note" });
  const styleSay = h("p", { class: "tm-say" });
  const keys = h("div", { class: "tm-keys" });
  const readyBox = h("div", { class: "tm-ready" },
    h("div", { class: "seg", style: "grid-template-columns:.8fr .8fr 1fr;margin-top:0", role: "group", "aria-label": "Style" }, segGauge, segHot, segCold),
    styleSay,
    h("div", { class: "row", style: "margin-top:14px" }, tag("SETUPS", "font-size:9.5px"),
      h("button", { class: "edit tm-edit", onclick: () => editSetup(sel) }, "EDIT")),
    keys,
    readyNote);

  const goBtn = h("button", { class: "bigBtn tm-go", onclick: start }, icon("torch"), "TORCH IT");
  const logBtn = h("button", { class: "bigBtn tm-go", hidden: true, onclick: logGauge }, icon("check"), "LOG DAB");
  const torchRow = h("div", { hidden: true },
    h("button", { class: "bigBtn tm-stop", onclick: stop }, icon("stop"), "STOP"),
    h("button", { class: "tm-off", onclick: torchOffNow }, "TORCH OFF NOW"));
  // Cold start: the big button is the one they tap when it bubbles. STOP is there, but smaller.
  const coldRow = h("div", { hidden: true },
    h("button", { class: "bigBtn tm-go tm-mid", onclick: torchOffNow }, icon("check"), "DONE TORCHING"),
    h("button", { class: "tm-off", onclick: stop }, icon("stop"), "STOP"));
  const coolRow = h("div", { class: "row", style: "gap:10px", hidden: true },
    h("button", { class: "bigBtn tm-stop", onclick: stop }, icon("stop"), "STOP"),
    h("button", { class: "panel tm-side", "aria-label": "5 seconds less cool-down", onclick: () => nudge(-5) }, h("b", {}, "−5s"), tag("LESS", "font-size:8.5px")),
    h("button", { class: "panel tm-side", "aria-label": "5 seconds more cool-down", onclick: () => nudge(5) }, h("b", {}, "+5s"), tag("MORE", "font-size:8.5px")));
  const doneBtn = h("button", { class: "bigBtn tm-go", hidden: true, onclick: done }, icon("check"), "DONE");
  const hint = h("div", { class: "hint" });

  // After DAB IT: how was the heat? One tap tunes the saved setup for next time.
  const nextKeys = ([[1, "TOO HOT"], [0, "JUST RIGHT"], [-1, "TOO COOL"]] as const).map(([k, label]) =>
    h("button", { class: "tm-nextKey", "data-k": String(k), onclick: () => pickNext(k) }, label));
  const nextSay = h("p", { class: "tm-say", style: "margin-top:10px" });
  const nextBox = h("div", { class: "panel tm-next", hidden: true },
    tag("NEXT TIME", "font-size:9px"), h("div", { class: "tm-nextRow", role: "group", "aria-label": "Next time" }, ...nextKeys), nextSay);
  const actions = h("div", {}, goBtn, logBtn, torchRow, coldRow, coolRow, doneBtn, hint, nextBox);

  const jarBox = h("div", { class: "curJar panel" });
  root.replaceChildren(noteBox, card, readyBox, actions, jarBox, sr);

  // MARK: Setups on the Ready screen
  function setStyle(s: Style) {
    if (phase !== "ready" || setup().style === s) return;
    setup().style = s;
    saveSetups();
    paint();
  }
  function keyText(s: Setup) { return s.style === "gauge" ? `${s.dabAt}°` : s.style === "cold" ? (s.cold !== undefined ? `~${s.cold}s` : "COUNT") : `${torchTotal(s)}/${s.cool}`; }
  function keyLabel(s: Setup) {
    if (s.style === "gauge") return `${s.name}: gauge, dab at ${s.dabAt} degrees` + (s.torchTo !== undefined ? `, torch to ${s.torchTo}` : "");
    if (s.style === "cold") return `${s.name}: cold start, counts up` + (s.cold !== undefined ? `, last time ${s.cold} seconds` : "");
    const st = s.steps.length > 1 ? s.steps.map(x => `${x.cue.toLowerCase()} ${x.secs}`).join(", ") + " seconds" : `${s.steps[0].secs} seconds`;
    return `${s.name}: torch ${st}, cool down ${s.cool} seconds`;
  }
  function renderKeys() {
    const kids = setups.map((s, i) => h("button", {
      class: "key" + (i === sel ? " on" : ""), "aria-pressed": String(i === sel), "aria-label": keyLabel(s),
      onclick: () => { sel = i; saveSetups(); paint(); },
    }, h("small", {}, s.name), h("span", {}, keyText(s))));
    if (setups.length < MAX_SETUPS) {
      kids.push(h("button", { class: "key tm-add", "aria-label": "Add a setup", onclick: () => editSetup(-1) }, h("small", {}, "NEW"), h("span", {}, "+")));
    }
    keys.replaceChildren(...kids);
  }

  /** The setup editor: a bottom sheet with steppers and sliders, like the preset editor on Home. */
  function editSetup(index: number) {
    if (phase !== "ready") return;
    const isNew = index < 0;
    const src = isNew ? freshSetup(`SETUP ${setups.length + 1}`) : setups[index];
    const d: Setup = { ...src, steps: src.steps.map(x => ({ ...x })) };
    let named = !isNew;            // a template may name a new setup until the user types a name
    let tpl = -1, small = false;
    const host = document.getElementById("sheets") ?? document.body;
    const body = h("div", { class: "sheetBody" });
    const sheet = h("div", { class: "sheet tm-sheet", onclick: (e: Event) => { if (e.target === sheet) close(); } }, body);
    const close = () => { sheet.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);

    /** A seconds value with − and + keys and a slider between them. */
    function stepper(head: HTMLElement[], get: () => number, put: (v: number) => void, [lo, hi]: readonly [number, number], what: string, tail: HTMLElement | null = null, inc = 1, unit = "S"): HTMLElement {
      const val = h("b", { style: "margin-left:auto" });
      const range = h("input", { type: "range", min: lo, max: hi, step: inc, "aria-label": what, oninput: () => set(Number(range.value)) }) as HTMLInputElement;
      const set = (v: number) => {
        put(clamp(Math.round(v / inc) * inc, lo, hi));
        const x = get();
        range.value = String(x);
        val.replaceChildren(x === 0 ? "NONE" : String(x), x === 0 ? "" : h("small", {}, unit));
      };
      set(get());
      return h("div", { class: "field" },
        h("div", { class: "row" }, ...head, val, tail),
        h("div", { class: "row" },
          h("button", { class: "step", "aria-label": `${what}: ${inc === 1 ? "1 second" : `${inc} degrees`} less`, onclick: () => set(get() - inc) }, "−"),
          range,
          h("button", { class: "step", "aria-label": `${what}: ${inc === 1 ? "1 second" : `${inc} degrees`} more`, onclick: () => set(get() + inc) }, "+")));
    }

    function useTemplate(i: number) {
      const t = TEMPLATES[i];
      tpl = i;
      d.style = "hot";
      d.steps = t.steps.map(x => ({ ...x }));
      d.cool = t.cool;
      if (small) d.steps[0].secs = clamp(d.steps[0].secs + SMALL_TORCH, ...LIMITS.torch);
      if (!named) d.name = t.name;
      draw();
    }
    function toggleSmall() {
      small = !small;
      d.steps[0].secs = clamp(d.steps[0].secs + (small ? SMALL_TORCH : -SMALL_TORCH), ...LIMITS.torch);
      draw();
    }

    function draw() {
      const name = h("input", { class: "panel textLine", type: "text", maxlength: NAME_MAX, value: d.name, placeholder: "25MM QUARTZ",
        autocomplete: "off", "aria-label": "Setup name", oninput: () => { d.name = name.value; named = true; } }) as HTMLInputElement;
      const pick = (s: Style, label: string) => h("button", { class: d.style === s ? "on" : "", "aria-pressed": String(d.style === s),
        onclick: () => { d.style = s; draw(); } }, label);
      const save = () => {
        d.name = d.name.trim().slice(0, NAME_MAX) || `SETUP ${(isNew ? setups.length : index) + 1}`;
        if (isNew) { setups.push(d); sel = setups.length - 1; } else setups[index] = d;
        saveSetups(); close(); paint();
      };
      const remove = () => {
        setups.splice(index, 1);
        sel = clamp(sel > index ? sel - 1 : sel, 0, setups.length - 1);
        saveSetups(); close(); paint();
      };
      const kids: (HTMLElement | null)[] = [
        h("h3", {}, isNew ? "New setup" : "Setup"),
        h("div", { class: "field" }, tag("NAME"), name),
        h("div", { class: "field" }, tag("STYLE"),
          h("div", { class: "seg", style: "grid-template-columns:.8fr .8fr 1fr" }, pick("gauge", "TEMP"), pick("hot", "TIMER"), pick("cold", "COLD START"))),
      ];
      const chip = (label: string, on: boolean, onclick: () => void) =>
        h("button", { class: "catKey" + (on ? " on" : ""), "aria-pressed": String(on), onclick }, label);
      const gaugeChip = () => chip(`TEMP ${GAUGE_DAB}`, tpl === 99, () => {
        tpl = 99; d.style = "gauge"; d.dabAt = GAUGE_DAB; delete d.torchTo;
        if (!named) d.name = `TEMP ${GAUGE_DAB}`;
        draw();
      });
      if (isNew && d.style === "gauge") {
        kids.push(h("div", { class: "field" }, tag("STARTING POINT, TUNE IT", "color:var(--gold)"),
          h("div", { class: "catGrid" }, ...TEMPLATES.map((t, i) => chip(t.label, false, () => useTemplate(i))), gaugeChip())));
      }
      if (d.style === "gauge") {
        kids.push(h("p", { class: "tm-say", style: "margin:0 0 12px" },
          "For a banger thermometer. Your gauge's numbers: Torchless can't read your glass. No timers."));
        kids.push(stepper([tag("DAB AT")], () => d.dabAt, v => { d.dabAt = v; }, LIMITS.dabAt, "Dab at", null, 10, "°F"));
        if (d.torchTo === undefined) {
          kids.push(h("button", { class: "btn2 wide tm-addStep", onclick: () => { d.torchTo = Math.max(GAUGE_TORCH, d.dabAt + 50); draw(); } }, "+ TORCH TO"));
        } else {
          const x = h("button", { class: "step tm-x", "aria-label": "Remove torch to", onclick: () => { delete d.torchTo; draw(); } }, icon("close"));
          kids.push(stepper([tag("TORCH TO")], () => d.torchTo ?? GAUGE_TORCH, v => { d.torchTo = v; }, LIMITS.torchTo, "Torch to", x, 10, "°F"));
        }
      } else if (d.style === "hot") {
        if (isNew) {
          kids.push(h("div", { class: "field" }, tag("STARTING POINT, TUNE IT", "color:var(--gold)"),
            h("div", { class: "catGrid" }, ...TEMPLATES.map((t, i) => chip(t.label, tpl === i, () => useTemplate(i))),
              chip(`SMALL TORCH +${SMALL_TORCH}S`, small, toggleSmall), gaugeChip())));
        }
        const n = d.steps.length;
        d.steps.forEach((st, i) => {
          const head: HTMLElement[] = n === 1 ? [tag("TORCH TIME")] : [
            tag(`STEP ${i + 1}`),
            h("select", { class: "tm-cue", "aria-label": `Step ${i + 1}: where to torch`,
              onchange: (e: Event) => { st.cue = (e.target as HTMLSelectElement).value; } },
              ...CUES.map(c => h("option", { value: c, selected: c === st.cue }, c))),
          ];
          const x = n === 1 ? null : h("button", { class: "step tm-x", "aria-label": `Remove step ${i + 1}`, onclick: () => { d.steps.splice(i, 1); draw(); } }, icon("close"));
          kids.push(stepper(head, () => st.secs, v => { st.secs = v; }, LIMITS.torch, n === 1 ? "Torch time" : `Step ${i + 1} torch time`, x));
        });
        if (n < MAX_STEPS) {
          kids.push(h("button", { class: "btn2 wide tm-addStep", onclick: () => {
            if (n === 1 && d.steps[0].cue === "ALL OVER") d.steps[0].cue = "BOTTOM";
            d.steps.push({ cue: ["BOTTOM", "MIDDLE", "BOTTOM"][n], secs: 20 });
            draw();
          } }, "+ ADD STEP"));
        }
        kids.push(stepper([tag("COOL DOWN")], () => d.cool, v => { d.cool = v; }, LIMITS.cool, "Cool-down"));
      } else {
        kids.push(h("p", { class: "tm-say", style: "margin:0 0 12px" },
          `Load first. TORCH IT counts up: torch until it bubbles, then tap DONE TORCHING. It stops at ${COLD_CAP} s. No cool-down.`));
        if (d.cold !== undefined) {
          kids.push(h("div", { class: "row field", style: "justify-content:space-between" },
            h("div", {}, tag("LAST TIME"), h("b", { class: "cond", style: "display:block;font-size:28px;color:var(--gold)" }, `${d.cold} S`)),
            h("button", { class: "btn2", onclick: () => { delete d.cold; draw(); } }, "FORGET IT")));
        }
      }
      kids.push(h("div", { class: "row", style: "gap:10px" },
        !isNew && setups.length > 1 ? h("button", { class: "btn2 danger", onclick: remove }, "DELETE") : null,
        h("button", { class: "btn2", style: "flex:1", onclick: close }, "Cancel"),
        h("button", { class: "btn2", style: "flex:1;background:var(--goldFill);color:var(--goldInk);border-color:var(--goldFill)", onclick: save }, "SAVE")));
      const top = body.scrollTop;
      body.replaceChildren(...kids.filter((k): k is HTMLElement => !!k));
      body.scrollTop = top;
    }
    draw();
    host.append(sheet);
  }

  // MARK: The run
  const isRunning = () => phase === "torch" || phase === "cool";

  function setTimer(on: boolean) {
    if (on && !timer) timer = window.setInterval(tick, 200);
    if (!on && timer) { clearInterval(timer); timer = 0; }
  }

  /** GAUGE: no timer. One dab at the user's own "dab at" number, then the rating pop-up, same as DONE. */
  function logGauge() {
    const s = setup();
    if (phase !== "ready" || s.style !== "gauge") return;
    const dab: JarDab = { id: uid(), at: new Date().toISOString(), seconds: 0, unit: "F", profile: "Torch", medium: "torch", goal: s.dabAt };
    let jarID: string | null = null;
    const c = deps.jars.currentID;
    if (c && deps.jars.addDab(dab, c)) jarID = c;
    pending = { jarID, dab, at: Date.now() };
    buzz([18, 70, 28]);
    say("Dab logged.");
    offerRating();
    paint();
  }

  function start() {
    if (phase !== "ready") return;
    const s = setup();
    if (s.style === "gauge") return;
    const now = Date.now();
    const cold = s.style === "cold";
    const steps = cold ? [] : s.steps.map(x => ({ ...x }));
    const stepEnds: number[] = [];
    let t = now;
    for (const x of steps) { t += x.secs * 1000; stepEnds.push(t); }
    const torchEnd = cold ? now + COLD_CAP * 1000 : t;
    run = { style: s.style, setupIdx: sel, startAt: now, steps, stepEnds, torchEnd, torchPlan: torchEnd - now, coldRef: cold ? s.cold : undefined,
      coolSecs: cold ? 0 : s.cool, torchMs: 0, coolStart: 0, coolEnd: 0, heatOff: 1, lastTick: 99, dabAt: 0, step: 0,
      warnedTorch: torchEnd - now <= (WARN_AT + 2) * 1000, warnedCool: false, passedRef: false, capped: false, next: null };
    pending = null;
    note = null;
    phase = "torch";
    fx.reset();
    deps.keepAwake(true);
    heatSound.unlock();
    heatSound.play("start", theme());
    buzz(12);
    if (cold) say("Torch on. Torch until it bubbles, then tap done torching.");
    else say(steps.length > 1 ? `Torch on. ${steps[0].cue.toLowerCase()}, ${steps[0].secs} seconds.` : `Torch on. ${steps[0].secs} seconds.`);
    setTimer(true);
    tick();
  }

  /** The heads-up 10 s before the torch or the cool-down ends: a rising sweep, not a tick. */
  function warnCue(text: string) {
    heatSound.play("sweep", theme());
    buzz([30, 60, 30, 60, 30]);
    fx.pulse(true);
    say(text);
  }

  /** The torch phase is over at `at` (the planned end, the cap, or now for TORCH OFF NOW / DONE TORCHING). */
  function torchOff(at: number, late: number, now: number) {
    const r = run!;
    r.torchMs = Math.max(0, at - r.startAt);
    r.heatOff = heatAt(at);
    if (r.style === "cold" || r.coolSecs === 0) { reachDab(at, late); return; }
    phase = "cool";
    r.coolStart = at;
    r.coolEnd = at + r.coolSecs * 1000;
    r.lastTick = 99;
    r.warnedCool = r.coolSecs <= WARN_AT + 2;
    if (now >= r.coolEnd) return;   // the cool-down ran out while away too: tick() goes straight on to DAB IT
    if (late > FRESH) away(`Torch time ended ${ago(late)}. Cool-down is running.`);
    heatSound.play("ready", theme());
    buzz([220, 90, 220]);
    say(`Torch off. Cool-down, ${r.coolSecs} seconds.`);
  }

  function reachDab(at: number, late: number) {
    const r = run!;
    phase = "dab";
    r.dabAt = Date.now();
    const cooled = r.coolStart ? Math.max(0, Math.round((at - r.coolStart) / 1000)) : undefined;
    const ran = Math.max(1, Math.round(r.torchMs / 1000));
    const s = setups[r.setupIdx];
    if (r.capped) note = { tag: "SAFETY CAP", text: late > FRESH ? `Stopped at ${COLD_CAP} s, ${ago(late)}. Torch off.` : `Stopped at ${COLD_CAP} s. Torch off.` };
    else if (late > FRESH) away(`${r.coolStart ? "Cool-down" : "Torch time"} ended ${ago(late)}.`);
    // Cold start: the time they tapped is the guide mark for next time. A run that hit the cap isn't a time they chose.
    if (r.style === "cold" && !r.capped && s) { s.cold = clamp(ran, ...LIMITS.cold); saveSetups(); }
    if (s) {
      const orig = r.style === "cold" ? s.cold : s.cool;
      if (orig !== undefined) r.next = { orig, pick: null, note: "" };
    }
    deps.keepAwake(false);
    heatSound.torch(theme(), 0, 0, false);
    if (r.capped) { heatSound.play("cut", theme()); buzz([200, 100, 200, 100, 200]); say(`Stopped at ${COLD_CAP} seconds. Torch off.`); }
    else { heatSound.play("done", theme()); buzz([40, 70, 40, 70, 160]); say("Dab it. Cap it."); }
    fx.celebrate();

    // One dab for the current jar. No temps: the app never saw the glass.
    const dab: JarDab = { id: uid(), at: new Date(r.startAt).toISOString(), seconds: ran, unit: "F", profile: "Torch", medium: "torch" };
    if (cooled !== undefined) dab.cooledIn = cooled;
    let jarID: string | null = null;
    const c = deps.jars.currentID;
    if (c && deps.jars.addDab(dab, c)) jarID = c;
    pending = { jarID, dab, at: r.dabAt + PROMPT_DELAY };
  }

  /** TOO HOT, JUST RIGHT, TOO COOL: sets the saved setup from what it was before this run, so a change of mind just re-picks. */
  function pickNext(k: -1 | 0 | 1) {
    const r = run, nx = r?.next, s = r ? setups[r.setupIdx] : undefined;
    if (phase !== "dab" || !r || !nx || !s) return;
    nx.pick = k;
    if (r.style === "cold") {
      const v = clamp(nx.orig - k * 3, ...LIMITS.cold);
      s.cold = v;
      nx.note = k === 0 ? `Kept: aim for about ${v} s.` : v === nx.orig ? `Already at the limit: ${v} s.` : `Next time: aim for about ${v} s (was ${nx.orig} s).`;
    } else {
      const v = clamp(nx.orig + k * 10, ...LIMITS.cool);
      s.cool = v;
      nx.note = k === 0 ? `Kept: ${v} s cool-down.` : v === nx.orig ? `Cool-down is already at its limit: ${v} s.` : `Next time: ${v} s cool-down (was ${nx.orig} s).`;
    }
    saveSetups();
    buzz(10);
    say(nx.note);
    paint();
  }

  /** Shows the rating pop-up for the dab just logged (marks it asked first, as DabWatcher does). */
  function offerRating() {
    const p = pending;
    if (!p) return;
    pending = null;
    if (p.jarID) deps.jars.updateDab(p.jarID, p.dab.id, d => { d.asked = true; });
    deps.watcher.show({ jarID: p.jarID, dab: p.dab });
  }

  function toReady() {
    phase = "ready";
    run = null;
    setTimer(false);
    deps.keepAwake(false);
    heatSound.torch(theme(), 0, 0, false);
  }

  function stop() {
    if (!isRunning()) return;
    heatSound.torch(theme(), 0, 0, false);
    heatSound.play("cut", theme());
    buzz(45);
    toReady();
    fx.settle();
    note = null;
    say("Stopped.");
    paint();
  }

  function torchOffNow() {
    if (phase !== "torch") return;
    const now = Date.now();
    torchOff(now, 0, now);
    tick();
  }

  function nudge(by: number) {
    const r = run;
    if (phase !== "cool" || !r) return;
    const now = Date.now();
    r.coolEnd = clamp(r.coolEnd + by * 1000, now, now + 300_000);
    if (by > 0) r.lastTick = 99;
    if (r.coolEnd - now > WARN_AT * 1000 + 500) r.warnedCool = false;   // pushed back past the heads-up: give it again
    buzz(10);
    tick();
  }

  function done() {
    if (phase !== "dab") return;
    toReady();
    note = null;
    offerRating();
    paint();
  }

  /** Works out where the run is from the clock. Safe to call at any time, any number of times. */
  function tick() {
    const now = Date.now();
    const r = run;
    if (r) {
      if (phase === "torch" && now >= r.torchEnd) {
        if (r.style === "cold") r.capped = true;
        torchOff(r.torchEnd, now - r.torchEnd, now);
      }
      if (phase === "cool" && now >= r.coolEnd) reachDab(r.coolEnd, now - r.coolEnd);
      if (phase === "torch") {
        // Next step: tell them where to move the torch (only when it just happened, not on coming back)
        const i = r.stepEnds.findIndex(e => now < e);
        if (i > r.step) {
          r.step = i;
          if (now - r.stepEnds[i - 1] < FRESH) {
            heatSound.play("start", theme());
            buzz([60, 50, 60]);
            fx.pulse(true);
            say(`Now ${r.steps[i].cue.toLowerCase()}. ${r.steps[i].secs} seconds.`);
          }
        }
        if (r.style === "cold" && r.coldRef !== undefined && !r.passedRef && now - r.startAt >= r.coldRef * 1000) {
          r.passedRef = true;
          if (now - r.startAt - r.coldRef * 1000 < FRESH) { heatSound.play("tick", theme()); buzz(20); fx.pulse(true); say("Your last time."); }
        }
        if (!r.warnedTorch && r.torchEnd - now <= WARN_AT * 1000) {
          r.warnedTorch = true;
          const stepJust = r.stepEnds.slice(0, -1).some(e => now >= e && now - e < FRESH);   // a step cue just went off: one ping is enough
          if (r.torchEnd - now > WARN_AT * 1000 - FRESH && !stepJust) warnCue(r.style === "cold" ? `${WARN_AT} seconds to the ${COLD_CAP} second cap.` : `Torch off in ${WARN_AT} seconds.`);
        }
      }
      if (phase === "cool") {
        const left = Math.ceil((r.coolEnd - now) / 1000);
        if (!r.warnedCool && r.coolEnd - now <= WARN_AT * 1000) {
          r.warnedCool = true;
          if (r.coolEnd - now > WARN_AT * 1000 - FRESH) warnCue(`Dab in ${WARN_AT} seconds. Get your dab ready.`);
        }
        if (left >= 1 && left <= 5 && left < r.lastTick) {
          r.lastTick = left;
          heatSound.play("tick", theme());
          buzz(10);
          fx.pulse();
        }
      }
      if (phase === "torch") heatSound.torch(theme(), 1, heatAt(now), false);
      else if (phase === "cool") heatSound.torch(theme(), 3, 0, r.coolEnd - now <= 5000);
      else if (phase === "dab" && pending && now >= pending.at && document.visibilityState !== "hidden" && shown) {
        // The moment has had its 15 seconds: back to Ready, and ask for the rating.
        toReady();
        offerRating();
      }
    }
    paint();
  }

  // MARK: Heat, as the dial shows it (a picture of the plan, not a reading)
  function heatAt(now: number): number {
    const r = run;
    if (!r) return 0;
    if (phase === "torch") {
      const span = r.style === "cold" ? (r.coldRef ?? 30) * 1000 : r.torchPlan;
      return 0.14 + 0.86 * Math.pow(clamp((now - r.startAt) / span, 0, 1), 0.8);
    }
    if (phase === "cool") {
      const span = Math.max(1, r.coolEnd - r.coolStart);
      return r.heatOff * Math.pow(clamp((r.coolEnd - now) / span, 0, 1), 1.25);
    }
    return 0;
  }
  /** How much of the ring is lit. */
  function ringAt(now: number): number {
    const r = run;
    if (!r) return 0;
    if (phase === "torch") return clamp((now - r.startAt) / r.torchPlan, 0, 1);
    if (phase === "cool") return clamp((r.coolEnd - now) / Math.max(1, r.coolEnd - r.coolStart), 0, 1);
    return phase === "dab" ? 1 : 0;
  }

  // Colours come from the app's tokens, so both themes work. Fire colours are the one fixed thing.
  const pal = { live: [25, 227, 255] as RGB, gold: [232, 178, 74] as RGB, fire: [255, 122, 26] as RGB, sub: [170, 178, 189] as RGB, light: false };
  function readPal() {
    const cs = getComputedStyle(document.documentElement);
    pal.live = parseColor(cs.getPropertyValue("--live"), pal.live);
    pal.gold = parseColor(cs.getPropertyValue("--gold"), pal.gold);
    pal.fire = parseColor(cs.getPropertyValue("--tm-fire"), pal.fire);
    pal.sub = parseColor(cs.getPropertyValue("--sub"), pal.sub);
    const bg = parseColor(cs.getPropertyValue("--bg"), [6, 7, 8]);
    pal.light = bg[0] * 0.3 + bg[1] * 0.59 + bg[2] * 0.11 > 128;
  }
  /** 1 = fire orange, then gold, then the glow dies to plain grey, and 0 = the app's cyan. */
  const heatRGB = (x: number): RGB => x >= 0.6 ? mix(pal.gold, pal.fire, Math.min(1, (x - 0.6) / 0.4))
    : x >= 0.3 ? mix(pal.sub, pal.gold, (x - 0.3) / 0.3) : mix(pal.live, pal.sub, Math.max(0, x) / 0.3);

  /** Marks on the ring: where each torch step ends, and the cold-start "last time" guide. */
  function paintMarks() {
    const r = run, s = setup();
    const style = r ? r.style : s.style;
    const show = phase === "ready" || phase === "torch";
    const list: { at: number; ref: boolean }[] = [];
    if (show && style === "cold") {
      const ref = r ? r.coldRef : s.cold;
      if (ref !== undefined) list.push({ at: ref / COLD_CAP, ref: true });
    } else if (show && style === "hot") {
      const steps = r ? r.steps : s.steps, total = torchTotal({ steps });
      let t = 0;
      for (const x of steps.slice(0, -1)) { t += x.secs; list.push({ at: t / total, ref: false }); }
    }
    const key = list.map(m => `${m.at.toFixed(4)}${m.ref}`).join();
    if (key === marksKey) return;
    marksKey = key;
    marks.innerHTML = list.map(m => m.ref
      ? `<g transform="rotate(${(m.at * 360).toFixed(2)} 130 130)"><line x1="130" y1="14" x2="130" y2="34" class="tm-refMark"/><path d="M125 13 L135 13 L130 20 Z" class="tm-refTip"/></g>`
      : `<line x1="130" y1="17" x2="130" y2="31" class="tm-stepMark" transform="rotate(${(m.at * 360).toFixed(2)} 130 130)"/>`).join("");
  }

  function paintDial(now: number) {
    const heat = heatAt(now), ring = ringAt(now);
    const col = phase === "dab" ? pal.live : phase === "torch" ? pal.fire : heatRGB(heat);
    if (ring > 0.004) {
      arc.setAttribute("visibility", "visible");
      arc.setAttribute("stroke-dasharray", `${(C * ring).toFixed(1)} ${C.toFixed(1)}`);
      arc.style.stroke = rgba(col, 1);
      arc.style.filter = `drop-shadow(0 0 5px ${rgba(col, pal.light ? 0.35 : 0.8)})`;
    } else arc.setAttribute("visibility", "hidden");
    heatDisc.setAttribute("opacity", (heat * (pal.light ? 0.75 : 1)).toFixed(3));
    const hc = rgba(heatRGB(heat), 1);
    for (const s of heatStops) s.style.stopColor = hc;
    if (phase === "torch") numEl.style.color = rgba(pal.fire, 1);
    else if (phase === "cool") numEl.style.color = rgba(heatRGB(Math.max(heat, 0.0)), 1);
    else numEl.style.color = "";
  }

  let lastShown = "";
  function paint() {
    readPal();
    const now = Date.now();
    const r = run, s = setup();
    const style = r ? r.style : s.style;
    const cold = style === "cold";
    root.classList.toggle("tm-on", phase === "torch");
    root.classList.toggle("tm-dab", phase === "dab");
    readyBox.hidden = phase !== "ready";
    const gauge = phase === "ready" && s.style === "gauge";
    goBtn.hidden = phase !== "ready" || gauge;
    logBtn.hidden = !gauge;
    torchRow.hidden = !(phase === "torch" && !cold);
    coldRow.hidden = !(phase === "torch" && cold);
    coolRow.hidden = phase !== "cool";
    doneBtn.hidden = phase !== "dab";
    noteBox.hidden = !note;
    if (note) { noteTag.textContent = note.tag; noteText.textContent = note.text; }

    // Corners
    const ref = r ? r.coldRef : s.cold;
    const planTorch = r ? (cold ? 0 : Math.round(r.torchPlan / 1000)) : torchTotal(s);
    const torchSecs = r && phase !== "torch" ? Math.round(r.torchMs / 1000) : planTorch;
    const coolSecs = r ? (phase === "dab" || phase === "cool" ? Math.round((r.coolEnd - r.coolStart) / 1000) : r.coolSecs) : s.cool;
    if (gauge) {
      cTorch.t.textContent = "DAB AT";
      cTorch.b.textContent = `${s.dabAt}°F`;
    } else if (cold && (phase === "ready" || phase === "torch")) {
      cTorch.t.textContent = "LAST TIME";
      cTorch.b.textContent = ref !== undefined ? secs(ref) : "—";
    } else {
      cTorch.t.textContent = "TORCH";
      cTorch.b.textContent = secs(torchSecs);
    }
    cCool.t.textContent = gauge ? "TORCH TO" : "COOL DOWN";
    cCool.b.textContent = gauge ? (s.torchTo !== undefined ? `${s.torchTo}°F` : "—") : cold ? "NONE" : secs(coolSecs);
    cStyle.b.textContent = gauge ? "TEMP" : cold ? "COLD" : (r ? r.steps : s.steps).length > 1 ? `TIMER · ${(r ? r.steps : s.steps).length}` : "TIMER";
    cTotal.el.hidden = phase === "torch" || gauge;   // the torch comes in from this corner
    cTotal.t.textContent = phase === "ready" ? (cold ? "STOPS AT" : "TOTAL") : "ELAPSED";
    cTotal.b.textContent = phase === "ready" ? (cold ? `${COLD_CAP}s` : clock(torchSecs + coolSecs))
      : r ? clock(Math.max(0, Math.round(((phase === "dab" ? Math.max(r.coolEnd, r.startAt + r.torchMs) : now) - r.startAt) / 1000))) : "";

    let big = "", top = "", status = "", word = false;
    if (phase === "ready") {
      if (gauge) { big = `${s.dabAt}°`; top = "DAB AT"; }
      else if (cold) { big = ref !== undefined ? clock(ref) : "0"; top = ref !== undefined ? "LAST TIME" : "COUNTS UP"; }
      else { big = clock(torchSecs); top = "TORCH TIME"; }
      status = gauge ? "YOUR GAUGE · °F" : !cold && s.steps.length > 1 ? `READY · ${s.steps.length} STEPS` : "READY";
      segHot.classList.toggle("on", s.style === "hot"); segCold.classList.toggle("on", s.style === "cold"); segGauge.classList.toggle("on", gauge);
      segHot.setAttribute("aria-pressed", String(s.style === "hot")); segCold.setAttribute("aria-pressed", String(s.style === "cold")); segGauge.setAttribute("aria-pressed", String(gauge));
      styleSay.textContent = gauge ? (s.torchTo !== undefined ? `Torch to ${s.torchTo}°. ` : "") + `Watch your gauge. Dab when it reads ${s.dabAt}°.`
        : s.style === "hot" ? "Torch it. Let it cool. Then dab." : "Load first. Torch till it bubbles. Dab right away.";
      readyNote.textContent = gauge ? "Torchless can't read your glass. These are your numbers for your own gauge."
        : "Torchless can't read your glass. These times are yours: tune them to your banger and torch.";
      renderKeys();
      hint.textContent = gauge ? (deps.jars.currentID ? "LOGS IT TO YOUR JAR · RATE IT NEXT" : "LOGS IT · RATE IT NEXT")
        : theme() === "off" ? "SOUND IS OFF · WATCH THE DIAL" : cold ? "LOAD IT FIRST · IT COUNTS UP" : "SOUND WHEN IT'S TIME TO PULL THE TORCH";
    } else if (r && phase === "torch" && cold) {
      const el = Math.max(0, Math.floor((now - r.startAt) / 1000));
      big = clock(el); status = "TORCH ON";
      top = r.coldRef === undefined ? "COUNTING UP" : r.passedRef ? "PAST LAST TIME" : `LAST TIME ${r.coldRef} S`;
      hint.textContent = "TORCH UNTIL IT BUBBLES, THEN TAP DONE TORCHING";
    } else if (r && phase === "torch") {
      const i = Math.max(0, r.stepEnds.findIndex(e => now < e));
      const multi = r.steps.length > 1;
      big = clock(Math.max(0, Math.ceil(((multi ? r.stepEnds[i] : r.torchEnd) - now) / 1000)));
      top = multi ? `STEP ${i + 1}/${r.steps.length} · ${r.steps[i].cue}` : "KEEP TORCHING";
      status = "TORCH ON";
      const nx = r.steps[i + 1];
      hint.textContent = nx ? `NEXT: ${nx.cue} · ${nx.secs} S` : `THEN ${r.coolSecs} S OF COOL-DOWN`;
    } else if (r && phase === "cool") {
      big = clock(Math.max(0, Math.ceil((r.coolEnd - now) / 1000))); top = "LET IT COOL"; status = "COOLING DOWN";
      hint.textContent = "TICKS IN THE LAST FIVE SECONDS";
    } else if (r) {
      big = "DAB IT"; word = true; top = r.coolStart ? "COOL-DOWN DONE" : r.capped ? `${COLD_CAP} S CAP` : "TORCH OFF";
      status = "CAP IT";
      hint.textContent = pending ? (pending.jarID ? "LOGGED TO YOUR JAR · RATE IT NEXT" : "RATE IT NEXT") : "";
    }
    // Next-time nudge (DAB IT only)
    const nx = phase === "dab" ? r?.next : null;
    nextBox.hidden = !nx;
    if (nx) {
      for (const b of nextKeys) {
        const on = String(nx.pick) === b.dataset.k;
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", String(on));
        const k = Number(b.dataset.k);
        b.setAttribute("aria-label", k === 0 ? "Just right: keep it" : cold ? `${k > 0 ? "Too hot: aim 3 seconds shorter" : "Too cool: aim 3 seconds longer"} next time`
          : `${k > 0 ? "Too hot: 10 seconds more cool-down" : "Too cool: 10 seconds less cool-down"} next time`);
      }
      nextSay.textContent = nx.note || (cold ? "Tap one to tune your guide time." : "Tap one to tune the cool-down for next time.");
    }

    if (numEl.textContent !== big) numEl.textContent = big;
    numEl.classList.toggle("tm-word", word);
    numEl.classList.toggle("tm-long", !word && big.length >= 4);
    if (word && lastShown !== "dab") { numEl.classList.remove("tm-pop"); void numEl.offsetWidth; numEl.classList.add("tm-pop"); }
    if (!word) numEl.classList.remove("tm-pop");
    lastShown = phase;
    topEl.textContent = top;
    topEl.style.color = phase === "torch" ? "var(--warn)" : phase === "dab" ? "var(--live)" : "";
    statusEl.textContent = status;
    statusEl.classList.toggle("tm-capIt", phase === "dab");
    statusEl.style.color = phase === "torch" || phase === "cool" ? "var(--gold)" : "";
    const unit = gauge ? " degrees Fahrenheit" : phase === "ready" ? " seconds" : phase === "torch" && cold ? " seconds so far" : " left";
    read.setAttribute("aria-label", phase === "dab" ? "Dab it. Cap it." : `${top}: ${big}${unit}`);
    paintMarks();
    paintDial(now);
    fx.kick();
  }

  // MARK: Motion (canvas over the dial; original drawing, fire colours only)
  const fx = (() => {
    let raf = 0, last: number | null = null;
    let glow = 0, fire = 0, party = -1, pulseAge = -1, pulseGold = false, snap = false;
    let flames: Mote[] = [], embers: Mote[] = [], wisps: Mote[] = [], sparks: Mote[] = [];
    let spr: { hot: HTMLCanvasElement; f: HTMLCanvasElement[]; smoke: HTMLCanvasElement; light: boolean } | null = null;
    const rnd = Math.random;

    function sprites() {
      if (spr && spr.light === pal.light) return spr;
      const soft: [number, number][] = [[0, 1], [1, 0]], core: [number, number][] = [[0, 1], [0.33, 0.3], [1, 0]];
      spr = {
        light: pal.light,
        hot: dot(pal.light ? [240, 120, 20] : [255, 225, 120], core),
        f: pal.light
          ? [dot([255, 196, 70], soft), dot([250, 140, 30], soft), dot([226, 84, 16], soft), dot([170, 52, 14], soft)]
          : [dot([255, 240, 191], soft), dot([255, 161, 46], soft), dot([230, 69, 20], soft), dot([120, 31, 10], soft)],
        smoke: dot(pal.light ? [96, 106, 118] : [190, 205, 220], soft),
      };
      return spr;
    }

    function frame(t: number) {
      raf = 0;
      if (!g2) return;
      const w = canvas.clientWidth, hgt = canvas.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr); }
      g2.setTransform(dpr, 0, 0, dpr, 0, 0);
      g2.clearRect(0, 0, w, hgt);
      const now = t / 1000;
      const dt = Math.min(0.05, Math.max(0, now - (last ?? now)));
      last = now;
      const busy = w > 0 ? draw(g2, w, hgt, dt, now) : false;
      if (!reduce.matches) paintDial(Date.now());   // the ring moves every frame, not five times a second
      if (busy) kick(); else last = null;
    }
    function kick() {
      if (raf || !shown || document.visibilityState === "hidden") return;
      raf = requestAnimationFrame(frame);
    }
    function halt() { if (raf) cancelAnimationFrame(raf); raf = 0; last = null; }

    function draw(ctx: CanvasRenderingContext2D, w: number, hgt: number, dt: number, now: number): boolean {
      const still = reduce.matches;
      const S = sprites();
      const light = pal.light;
      const cx = w / 2, cy = hgt / 2, R = 134;   // the bezel's outer edge on screen
      const heat = heatAt(Date.now());
      glow += (heat - glow) * (still ? 1 : Math.min(1, dt * 5));
      const fireGoal = phase === "torch" && run && Date.now() - run.startAt > 220 ? 1 : 0;
      fire += (fireGoal - fire) * (still ? 1 : Math.min(1, dt * (fireGoal > fire ? 7 : 3)));
      if (snap) { glow = heat; fire = fireGoal; snap = false; }
      const hc = heatRGB(glow);
      ctx.globalCompositeOperation = light ? "source-over" : "lighter";
      ctx.lineCap = "round";
      const ring = (rad: number, a0: number, a1: number, color: string, width: number) => {
        ctx.beginPath(); ctx.arc(cx, cy, rad, a0, a1); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
      };
      const TAU = Math.PI * 2;
      // where the torch hits the glass: lower right of the rim
      const hitA = 0.62, hitX = cx + Math.cos(hitA) * (R + 2), hitY = cy + Math.sin(hitA) * (R + 2);

      // heat bloom around the dial; the middle stays clear for the number
      if (glow > 0.01) {
        const g = ctx.createRadialGradient(cx, cy, R * 0.55, cx, cy, R * 1.6);
        g.addColorStop(0, rgba(hc, 0));
        g.addColorStop(0.42, rgba(hc, (light ? 0.2 : 0.26) * glow));
        g.addColorStop(1, rgba(hc, 0));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, hgt);
        // the rim itself glows
        const breathe = still ? 1 : 0.9 + 0.1 * Math.sin(now * 5.3) * fire;
        ring(R + 1, 0, TAU, rgba(hc, 0.2 * glow * breathe), 15);
        ring(R + 1, 0, TAU, rgba(hc, 0.85 * glow * breathe), 4);
      }
      // hottest where the flame lands, spreading as the torch time runs
      if (fire > 0.02) {
        const spread = 0.35 + 1.5 * glow;
        ring(R + 1, hitA - spread, hitA + spread, rgba(light ? [255, 150, 30] : [255, 170, 60], 0.5 * fire), 7);
        ring(R + 1, hitA - spread * 0.45, hitA + spread * 0.45, rgba(light ? [255, 205, 90] : [255, 236, 190], 0.75 * fire), 3);
      }

      // flames splash from the hit and hug the outside of the rim
      if (!still) {
        let n = fire * 300 * dt;
        while (n > 0) {
          if (rnd() < n) {
            const side = rnd() < 0.62 ? -1 : 1;   // more go up the right side, where there is room to see them
            const tx = -Math.sin(hitA) * side, ty = Math.cos(hitA) * side;
            const sp = 70 + rnd() * 130;
            flames.push({ x: hitX + (rnd() - 0.5) * 12, y: hitY + (rnd() - 0.5) * 12, vx: tx * sp, vy: ty * sp - 20, life: 0, max: 0.55 + rnd() * 0.75, s: 5 + rnd() * 6, kind: 0, ph: 0 });
          }
          n -= 1;
        }
        for (const f of flames) {
          f.life += dt;
          f.vy -= 300 * dt;
          f.vx *= 0.975;
          f.x += f.vx * dt + (rnd() - 0.5) * 30 * dt;
          f.y += f.vy * dt;
          const dx = f.x - cx, dy = f.y - cy, d = Math.hypot(dx, dy), lo = R + 8;
          if (d < lo && d > 0) { f.x = cx + dx / d * lo; f.y = cy + dy / d * lo; }
        }
        flames = flames.filter(f => f.life < f.max);
      } else flames = [];
      for (const f of flames) {
        const k = f.life / f.max, rad = f.s * (1 + k * 2.4);
        // fade out before the top corner, so its label stays easy to read
        ctx.globalAlpha = Math.max(0, (1 - k) * (light ? 0.6 : 0.75)) * clamp((f.y - 64) / 60, 0, 1);
        ctx.drawImage(S.f[k < 0.18 ? 0 : k < 0.45 ? 1 : k < 0.75 ? 2 : 3], f.x - rad, f.y - rad, rad * 2, rad * 2);
      }
      ctx.globalAlpha = 1;

      // embers lift off the hot rim (fewer as it cools)
      if (!still) {
        let n = Math.pow(glow, 1.6) * (phase === "torch" ? 34 : phase === "cool" ? 9 : 0) * dt;
        while (n > 0) {
          if (rnd() < n) {
            const a = phase === "torch" ? hitA + (rnd() - 0.5) * (1 + glow * 3.4) : rnd() * TAU;
            embers.push({ x: cx + Math.cos(a) * (R + 4), y: cy + Math.sin(a) * (R + 4), vx: (rnd() - 0.5) * 18 + Math.cos(a) * 14, vy: -(24 + rnd() * 50),
              life: 0, max: 1.2 + rnd() * 1.6, s: 0.8 + rnd() * 1.6, kind: 0, ph: rnd() * 6 });
          }
          n -= 1;
        }
        for (const m of embers) {
          m.life += dt;
          m.x += (m.vx + Math.sin(m.life * 3 + m.ph) * 10) * dt;
          m.y += m.vy * dt;
          const dx = m.x - cx, dy = m.y - cy, d = Math.hypot(dx, dy), lo = R + 3;
          if (d < lo && d > 0) { m.x = cx + dx / d * lo; m.y = cy + dy / d * lo; }
        }
        embers = embers.filter(m => m.life < m.max && m.y >= -10);
      } else embers = [];
      for (const m of embers) {
        const k = m.life / m.max, rad = m.s * (1 - k * 0.5) * 3;
        ctx.globalAlpha = Math.max(0, Math.sin(Math.PI * Math.min(1, k * 1.2)) * 0.9);
        ctx.drawImage(S.hot, m.x - rad, m.y - rad, rad * 2, rad * 2);
      }
      ctx.globalAlpha = 1;

      // cool-down: heat drifting off the top of the glass
      if (!still) {
        let n = (phase === "cool" ? glow * 16 : 0) * dt;
        while (n > 0) {
          if (rnd() < n) {
            const a = -Math.PI / 2 + (rnd() - 0.5) * 2.6;
            wisps.push({ x: cx + Math.cos(a) * (R + 6), y: cy + Math.sin(a) * (R + 6), vx: (rnd() - 0.5) * 10, vy: -(14 + rnd() * 18), life: 0, max: 1.6 + rnd() * 1.4, s: 9 + rnd() * 9, kind: 0, ph: rnd() * 6 });
          }
          n -= 1;
        }
        for (const m of wisps) { m.life += dt; m.x += (m.vx + Math.sin(m.life * 2 + m.ph) * 8) * dt; m.y += m.vy * dt; }
        wisps = wisps.filter(m => m.life < m.max);
      } else wisps = [];
      for (const m of wisps) {
        const k = m.life / m.max, rad = m.s * (1 + k * 1.6);
        ctx.globalAlpha = Math.sin(Math.PI * k) * (light ? 0.07 : 0.13);
        ctx.drawImage(S.smoke, m.x - rad, m.y - rad, rad * 2, rad * 2);
      }
      ctx.globalAlpha = 1;

      // a tick in the last five seconds: the ring flashes
      if (pulseAge >= 0) {
        pulseAge += dt;
        if (pulseAge > 0.45) pulseAge = -1;
        else if (!still) ring(106 * 252 / 260, 0, TAU, rgba(pulseGold ? pal.gold : pal.live, 0.5 * (1 - pulseAge / 0.45)), 6 + 12 * (pulseAge / 0.45));
      }

      // the torch: a plain nozzle in the corner and a blue jet into the rim
      if (fire > 0.02) {
        const jx = w - 30, jy = hgt - 15;
        const dx = hitX - jx, dy = hitY - jy, L = Math.hypot(dx, dy);
        const flick = still ? 1 : 0.93 + rnd() * 0.09;
        const len = (L + 8) * flick * Math.min(1, fire * 1.3);
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
        const k = light ? 1.5 : 1;
        cone(len, 20, `rgba(90,110,255,${0.2 * fire * k})`, "rgba(90,110,255,0)");
        cone(len, 12, `rgba(80,110,255,${0.4 * fire * k})`, `rgba(255,140,61,${0.3 * fire})`);
        cone(len * 0.6, 6, light ? `rgba(60,130,255,${0.9 * fire})` : `rgba(171,230,255,${0.95 * fire})`, `rgba(79,140,255,${0.5 * fire})`);
        cone(len * 0.24, 3, `rgba(255,255,255,${fire})`, `rgba(191,240,255,${0.6 * fire})`);
        // nozzle
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = Math.min(1, fire * 1.5);
        const body = ctx.createLinearGradient(0, -9, 0, 9);
        if (light) { body.addColorStop(0, "#C9D0D8"); body.addColorStop(0.45, "#8A939E"); body.addColorStop(1, "#5B6570"); }
        else { body.addColorStop(0, "#5A636E"); body.addColorStop(0.45, "#2C333B"); body.addColorStop(1, "#14181C"); }
        ctx.fillStyle = body;
        ctx.beginPath(); ctx.rect(-40, -9, 34, 18); ctx.fill();
        ctx.beginPath(); ctx.moveTo(-6, -9); ctx.lineTo(4, -6); ctx.lineTo(4, 6); ctx.lineTo(-6, 9); ctx.closePath(); ctx.fill();
        ctx.fillStyle = light ? "#4A525C" : "#0B0D10";
        ctx.fillRect(-14, -9, 2.5, 18);
        ctx.restore();
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = light ? "source-over" : "lighter";
      }

      // DAB IT: rings blow out from the dial, sparks fly, then the rim keeps a slow light going round
      if (phase === "dab" && party >= 0) {
        party += dt;
        const lc = pal.live;
        if (!still) {
          for (const delay of [0, 0.16, 0.34]) {
            const age = party - delay;
            if (age <= 0 || age > 1.1) continue;
            const e = 1 - Math.pow(1 - age / 1.1, 3);
            ctx.lineCap = "butt";
            ring(R + e * R * 1.1, 0, TAU, rgba(delay === 0.16 ? pal.gold : lc, (1 - age / 1.1) * 0.9), 2 + 5 * (1 - age / 1.1));
            ctx.lineCap = "round";
          }
          if (party < 0.5) {
            const g = ctx.createRadialGradient(cx, cy, R * 0.5, cx, cy, R * 1.7);
            g.addColorStop(0, rgba(lc, 0)); g.addColorStop(0.4, rgba(lc, 0.4 * (1 - party / 0.5))); g.addColorStop(1, rgba(lc, 0));
            ctx.fillStyle = g; ctx.fillRect(0, 0, w, hgt);
          }
          for (const m of sparks) {
            m.life += dt;
            m.vx *= 1 - 1.5 * dt; m.vy = m.vy * (1 - 1.5 * dt) + 120 * dt;
            m.x += m.vx * dt; m.y += m.vy * dt;
          }
          sparks = sparks.filter(m => m.life < m.max);
          for (const m of sparks) {
            const k = m.life / m.max;
            ctx.beginPath();
            ctx.moveTo(m.x, m.y); ctx.lineTo(m.x - m.vx * 0.045, m.y - m.vy * 0.045);
            ctx.strokeStyle = rgba(m.kind ? pal.gold : lc, 1 - k * k);
            ctx.lineWidth = m.s * (1 - k * 0.5);
            ctx.stroke();
          }
          // the light that keeps going round
          const a = now * 1.9;
          ctx.globalCompositeOperation = "source-over";
          ring(R + 1, a, a + 0.9, rgba(light ? lc : mix(lc, [255, 255, 255], 0.35), 1), 3.5);
          ring(R + 1, a + Math.PI, a + Math.PI + 0.9, rgba(pal.gold, 1), 3.5);
          ctx.globalCompositeOperation = light ? "source-over" : "lighter";
        } else sparks = [];
        const breathe = still ? 0.8 : 0.65 + 0.35 * Math.sin(now * 2.4);
        ring(R + 1, 0, TAU, rgba(lc, 0.16 * breathe), 15);
        ring(R + 1, 0, TAU, rgba(lc, 0.5 * breathe), 3);
      }
      ctx.globalCompositeOperation = "source-over";

      if (still) return false;   // calm version: one drawing per repaint, nothing in motion
      return phase !== "ready" || glow > 0.01 || fire > 0.02 || flames.length + embers.length + wisps.length + sparks.length > 0 || pulseAge >= 0;
    }

    return {
      kick, halt,
      reset() { glow = 0; fire = 0; party = -1; pulseAge = -1; flames = []; embers = []; wisps = []; sparks = []; },
      pulse(gold = false) { pulseAge = 0; pulseGold = gold; kick(); },
      /** Back from being away: drop what was mid-air and show the state as it is now. */
      settle() { flames = []; embers = []; wisps = []; snap = true; },
      celebrate() {
        party = 0;
        fire = 0;
        flames = []; wisps = []; embers = [];
        sparks = [];
        const w = canvas.clientWidth, hgt = canvas.clientHeight;
        for (let i = 0; i < 90; i++) {
          const a = rnd() * Math.PI * 2, sp = 120 + rnd() * 300;
          sparks.push({ x: w / 2 + Math.cos(a) * 134, y: hgt / 2 + Math.sin(a) * 134, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40, life: 0, max: 0.6 + rnd() * 0.9, s: 1.5 + rnd() * 2, kind: rnd() < 0.35 ? 1 : 0, ph: 0 });
        }
        kick();
      },
    };
  })();

  // MARK: Current jar strip (as on Home; a tap opens Jars)
  function lid(producer: string): Element {
    const el = document.createElementNS(NS, "svg");
    el.setAttribute("viewBox", "0 0 100 100");
    el.setAttribute("class", "lid");
    el.innerHTML = `<circle cx="50" cy="50" r="49" class="lidBody"/><circle cx="50" cy="50" r="40" fill="none" class="lidRing"/>` +
      `<path d="M50 20 A30 30 0 1 1 24 35" fill="none" class="lidArc" transform="rotate(-60 50 50)"/>`;
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", "50"); t.setAttribute("y", "62"); t.setAttribute("class", "lidLetter");
    t.textContent = (producer.trim()[0] ?? "P").toUpperCase();
    el.append(t);
    return el;
  }
  function renderJar() {
    const j = deps.jars.current;
    const main = h("button", { class: "curMain", "aria-label": j ? `Now dabbing ${j.strain}. Open jars.` : "Pick a jar", onclick: () => deps.openJars() });
    if (j) {
      const box = h("div", { class: "jarPhoto", style: "width:56px;border-radius:12px" });
      const l = lid(j.producer);
      box.append(l);
      if (j.photo) void photoURLs.get(deps.jars, j.photo, true).then(url => { if (url) l.replaceWith(h("img", { src: url, alt: "" })); });
      const n = (j.dabs ?? []).length;
      main.append(box, h("div", { class: "curText" }, tag("NOW DABBING", "font-size:9px;color:var(--live)"),
        h("b", {}, j.strain), h("small", {}, `${n} DAB${n === 1 ? "" : "S"} · TORCH DABS LOG HERE`)));
    } else {
      const icon = document.createElementNS(NS, "svg");
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("class", "jarIcon");
      icon.innerHTML = `<ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v11c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6"/>`;
      main.append(h("span", { class: "curIcon" }, icon),
        h("div", { class: "curText" }, tag("JARS", "font-size:9px"), h("b", {}, "Pick what you're dabbing"), h("small", {}, "Then every dab gets rated.")));
    }
    jarBox.replaceChildren(main, h("span", { class: "chev", "aria-hidden": "true" }, "›"));
  }

  // MARK: Page comes and goes
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { fx.halt(); if (isRunning()) heatSound.stop(); return; }
    fx.settle();
    if (phase !== "ready") tick();          // jump to where the clock says we are
    if (isRunning()) deps.keepAwake(true);   // the browser drops the wake lock when the page hides
    fx.kick();
  });
  window.addEventListener("pageshow", () => { if (phase !== "ready") tick(); });

  renderJar();
  paint();

  return {
    setVisible(on: boolean) {
      shown = on;
      if (on) { paint(); renderJar(); } else fx.halt();
    },
    get running() { return isRunning(); },
    renderJar,
  };
}
