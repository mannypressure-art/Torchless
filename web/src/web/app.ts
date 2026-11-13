// The Torchless web app. Same rig logic as the test page (src/rig, unchanged), with the Gauge screens from
// the iPhone app: Link it, Home (gauge, presets, HEAT IT / CUT IT, current jar), Jars, Lights, Rig.
// Phase 4b: the jar library, dab rating and price log, kept on this device. Sign-in comes later.

import { RealClock } from "../rig/clock";
import { LocalStore } from "../rig/storage";
import { BLEManager } from "../rig/ble-manager";
import { RigController, LightModes, HeatProfile, RigLimits, LightShow, ShowStep, newStepID } from "../rig/rig-controller";
import { WebCentral } from "../rig/web-central";
import { chargingOf } from "../rig/frames";
import { JarStore, IDBJarBackend, MemoryJarBackend } from "./jars";
import { DabWatcher } from "./dab-watcher";
import { mountJars, h, tag, openSheet, topBar, textBtn } from "./jar-ui";
import { mountRig } from "./rig-ui";
import { Account, JarSync } from "./cloud";
import { FACES, DEMO, DEMO_POINTS, TempTrace, makeFace, Face, Readout } from "./faces";
import { HeatFX, heatSound, HEAT_SOUNDS } from "./heatfx";
import { waypointsOf, drawCurve, CurveView, CURVE_W } from "./curve";

const BUILD = "app-4e.0";
const clock = new RealClock();
const central = new WebCentral();
const ble = new BLEManager(central, clock);
const rig = new RigController(clock, new LocalStore("presh."));
rig.attach(ble);
ble.log(`Torchless web ${BUILD} started. ${navigator.userAgent}`);

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const prefs = {
  get(k: string): string | null { try { return localStorage.getItem("torchless." + k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem("torchless." + k, v); } catch { /* private mode */ } },
};

// MARK: Jars (on this device: IndexedDB, or memory when the browser blocks storage)

let backend;
try { backend = typeof indexedDB !== "undefined" ? new IDBJarBackend() : new MemoryJarBackend(); }
catch { backend = new MemoryJarBackend(); }
const jars = new JarStore(backend);
const watcher = new DabWatcher(jars);
// Sign-in and the shared catalog (optional; only the jar's own rating goes up).
// Off until Google/Apple sign-in is set up, tested on a real phone, and Play Data safety is updated (Manny's go).
const CLOUD_LIVE = false;
const account = new Account();
const sync = new JarSync(jars, account);
const jarUI = mountJars(jars, watcher, (t) => showTab(t), CLOUD_LIVE ? { account, sync } : undefined);
let syncTimer: ReturnType<typeof setTimeout> | null = null;
const kickSync = () => { if (!CLOUD_LIVE) return; if (syncTimer) clearTimeout(syncTimer); syncTimer = setTimeout(() => sync.kick(), 800); };
jars.onChange = () => { jarUI.renderHome(); if (tab === "jars") jarUI.renderJars(); jarUI.renderOpen(); kickSync(); };
account.onChange = () => { if (tab === "jars") jarUI.renderJars(); jarUI.renderOpen(); jarUI.renderAccount(); kickSync(); };
// Coming back from Google or Apple: show the account page so a new user can finish their profile.
if (CLOUD_LIVE && /[?&]code=/.test(location.search)) {
  showTabSoon();
}
function showTabSoon() {
  // getSession waits for supabase-js to trade the code for a session before the address is tidied.
  void account.db.auth.getSession().finally(() => {
    history.replaceState(null, "", location.pathname);
    showTab("jars"); jarUI.openAccount();
  });
}
watcher.onPrompt = () => jarUI.renderPrompt();
void jars.load().then(() => watcher.appOpened());
// Ask the browser to keep this site's storage (Chrome grants it for installed apps; others may ignore it).
try { void (navigator.storage as StorageManager | undefined)?.persist?.(); } catch { /* fine */ }

// MARK: Age gate (21+), asked once per browser

if (prefs.get("age21") === "yes") $("age").hidden = true;
$("ageYes").onclick = () => { prefs.set("age21", "yes"); $("age").hidden = true; };
$("ageNo").onclick = () => { $("ageMsg").hidden = false; };

// MARK: Full-screen tip. Bluefy ignores the manifest, so point people at its own
// Full-screen Mode. Bluefy does not keep that setting between launches, so the tip
// comes back each launch while the address bar shows. GOT IT hides it for this
// launch only; DON'T SHOW AGAIN hides it for good.

function checkFsTip() {
  const hasBt = !!(navigator as unknown as { bluetooth?: unknown }).bluetooth;
  const barShowing = window.innerHeight < screen.height - 60;
  $("fsTip").hidden = !(hasBt && barShowing && !fsTipClosed && prefs.get("fsTip") !== "done");
}
let fsTipClosed = false;
$("fsGotIt").onclick = () => { fsTipClosed = true; $("fsTip").hidden = true; };
$("fsNever").onclick = () => { prefs.set("fsTip", "done"); $("fsTip").hidden = true; };
checkFsTip();
window.addEventListener("resize", checkFsTip);

// MARK: Look (Dark / Bright / Auto)

function applyLook(v: string) {
  if (v === "dark" || v === "light") document.documentElement.dataset.theme = v;
  else delete document.documentElement.dataset.theme;
}
applyLook(prefs.get("look") ?? "dark");

// MARK: Leaving the page counts as leaving the app (same away rule as on iPhone)

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") rig.appMovedToBackground(); else rig.appBecameActive();
});
window.addEventListener("pagehide", () => rig.appMovedToBackground());
window.addEventListener("pageshow", () => { if (document.visibilityState === "visible") rig.appBecameActive(); });
// The browser drops the wake lock when the page is hidden; ask again when it comes back mid-dab.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && rig.sessionOn) void keepAwake(true); });

// Keep the screen on while heating where the browser allows it: a locked phone freezes the page.
type Lock = { release(): Promise<void> };
let wake: Lock | null = null;
async function keepAwake(on: boolean) {
  const wl = (navigator as unknown as { wakeLock?: { request(t: string): Promise<Lock> } }).wakeLock;
  if (!wl) return;
  try {
    if (on && !wake) { wake = await wl.request("screen"); (wake as unknown as EventTarget).addEventListener?.("release", () => { wake = null; }); }
    if (!on && wake) { const w = wake; wake = null; await w.release(); }
  } catch { wake = null; }
}

// MARK: Tabs

let tab = "home";
function showTab(t: string) {
  tab = t;
  document.querySelectorAll<HTMLElement>("[data-panel]").forEach(el => { el.hidden = el.dataset.panel !== t; });
  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach(b => b.classList.toggle("on", b.dataset.tab === t));
  window.scrollTo(0, 0);
  if (t === "jars") jarUI.renderJars();
  schedule();
}
document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach(b => { b.onclick = () => showTab(b.dataset.tab!); });

// MARK: Link it

let connectAfterPick = false;
function openChooser(all: boolean) {
  connectAfterPick = true;
  ble.devices = [];
  ble.showAll = all;
  ble.startScan();   // opens the browser's chooser; must stay inside this tap
}
$("linkIt").onclick = () => openChooser(false);
// Safari and other iPhone browsers have no Bluetooth: offer a one-tap jump into Bluefy instead.
const hasBt = !!(navigator as unknown as { bluetooth?: unknown }).bluetooth;
if (!hasBt) {
  $("noBt").hidden = false;
  $<HTMLAnchorElement>("openBluefy").href = "bluefy://open?url=" + encodeURIComponent(location.href.split("#")[0]);
  ($("linkIt") as HTMLButtonElement).hidden = true;
  $("linkAll").hidden = true;
}
$("linkAll").onclick = () => openChooser(true);
central.onChooserClosed = (why) => {
  ble.log(`Chooser closed without a rig: ${why}`);
  ble.stopScan();
  connectAfterPick = false;
  schedule();
};

// MARK: Home actions

$("heat").onclick = () => rig.heatIt();
$("cut").onclick = () => rig.cutIt();
$("extend").onclick = () => rig.extendTen();
$("gotIt").onclick = () => { rig.awayNote = null; schedule(); };
for (let n = 1; n <= 5; n++) $(`p${n}`).onclick = () => rig.selectPreset(n);

// MARK: Preset curve chart (the rig's own waypoints for the selected preset; nothing is sent)

let curveKey = "";
let curveView: CurveView | null = null;
function renderCurve(sel: number, celsius: boolean, heating: boolean) {
  const p = sel >= 1 && sel <= 5 ? rig.presets[sel] : undefined;
  const pts = p ? waypointsOf(p) : [];
  const s = rig.live;
  const extend = heating && s ? s.sessionExtend : 0;
  const total = pts.length ? pts[pts.length - 1].t + 10 * extend : 0;
  // The rig's countdown only runs once it is at temp, so total - remaining is the place on the curve.
  const elapsed = heating && s && pts.length && s.sessionTimeRemaining < total ? total - s.sessionTimeRemaining : null;
  const key = `${sel}|${celsius}|${extend}|${elapsed}|${p?.custom170?.join(",")}|${p?.custom171?.join(",")}|${p?.profile}`;
  if (key === curveKey) return;
  curveKey = key;
  const view = drawCurve(pts, celsius, elapsed, extend, p?.profile === 177);
  curveView = view;
  $("curveCard").hidden = !view;
  if (!view || !p) return;
  $("curveSvg").innerHTML = view.svg;
  const deg = (x: number) => `${Math.round(x)}°`;
  $("curveTag").textContent = `PRESET ${sel} · HEAT CURVE`;
  $("curveTitle").textContent = p.profile !== undefined ? HeatProfile.name(p.profile).toUpperCase() : "—";
  $("curveHeroTag").textContent = view.low === view.peak ? "HOLDS AT" : "RANGE";
  $("curveRange").textContent = view.low === view.peak ? deg(view.peak) : `${Math.round(view.low)}–${deg(view.peak)}`;
  $("cvStart").textContent = deg(view.start);
  $("cvPeak").textContent = deg(view.peak);
  $("cvLow").textContent = deg(view.low);
  $("cvHold").textContent = `${view.seconds}s`;
  $("curveNote").textContent = extend > 0
    ? `+${10 * extend} s added to this dab.`
    : p.profile === 161 || p.profile === 177
      ? "What +10 s adds. Drag across the chart to read any moment."
      : "+10 s on this profile hasn't been measured yet. Drag to read any moment.";
}
{
  // Touch readout: drag across the chart to read time and temp. Vertical drags still scroll the page.
  const svg = $("curveSvg") as unknown as SVGSVGElement;
  const hide = () => svg.querySelector("#cvScrub")?.setAttribute("visibility", "hidden");
  const move = (e: PointerEvent) => {
    const g = svg.querySelector("#cvScrub"), r = svg.getBoundingClientRect();
    const hit = curveView?.probe((e.clientX - r.left) / Math.max(r.width, 1));
    if (!g || !hit) { hide(); return; }
    g.setAttribute("visibility", "visible");
    const ln = g.querySelector("line")!, dot = g.querySelector("circle")!, tip = g.querySelector("#cvScrubTip")!;
    ln.setAttribute("x1", String(hit.x)); ln.setAttribute("x2", String(hit.x));
    dot.setAttribute("cx", String(hit.x)); dot.setAttribute("cy", String(hit.y));
    const tx = Math.min(Math.max(hit.x - 37, 40), CURVE_W - 14 - 74);
    tip.setAttribute("transform", `translate(${tx} ${hit.y > 62 ? hit.y - 34 : hit.y + 12})`);
    tip.querySelector("text")!.textContent = `${hit.t}s · ${Math.round(hit.v)}°`;
  };
  svg.addEventListener("pointerdown", move);
  svg.addEventListener("pointermove", e => { if (e.pointerType === "mouse" || e.buttons || e.pressure > 0) move(e); });
  svg.addEventListener("pointerleave", hide);
  svg.addEventListener("pointerup", e => { if (e.pointerType !== "mouse") window.setTimeout(hide, 1400); });
  svg.addEventListener("pointercancel", hide);
}

// MARK: Preset editor

const profileSel = $<HTMLSelectElement>("edProfile");
for (const pr of HeatProfile.writable) {
  const o = document.createElement("option");
  o.value = String(pr.id);
  o.textContent = pr.name;
  profileSel.appendChild(o);
}
let editing = 0;
const edTemp = $<HTMLInputElement>("edTemp");
const edHold = $<HTMLInputElement>("edHold");
edTemp.min = String(RigLimits.tempF[0]); edTemp.max = String(RigLimits.tempF[1]);
edHold.min = String(RigLimits.hold[0]); edHold.max = String(RigLimits.hold[1]);
function edLabels() {
  $("edTempV").textContent = `${edTemp.value}°F`;
  $("edHoldV").textContent = `${edHold.value}s`;
}
edTemp.oninput = edLabels;
edHold.oninput = edLabels;
$("editBtn").onclick = () => {
  const n = rig.live?.preset ?? 0;
  if (n < 1 || n > 5) return;
  editing = n;
  const p = rig.presets[n];
  edTemp.value = String(p.tempF ?? 450);
  edHold.value = String(p.hold ?? 30);
  profileSel.querySelector('option[value="241"]')?.remove();
  if (p.profile === 241) {
    const o = document.createElement("option");
    o.value = "241";
    o.textContent = "Custom (keep as is)";
    profileSel.prepend(o);
  }
  profileSel.value = String(p.profile !== undefined && (HeatProfile.isWritable(p.profile) || p.profile === 241) ? p.profile : 161);
  $("edProfileNote").hidden = p.profile !== 241;
  $("edTitle").textContent = `Preset ${n}`;
  edLabels();
  $("editor").hidden = false;
};
$("edCancel").onclick = () => { $("editor").hidden = true; };
$("edSave").onclick = () => {
  rig.savePreset(editing, Number(edTemp.value), Number(edHold.value), Number(profileSel.value));
  $("editor").hidden = true;
};
document.querySelectorAll<HTMLButtonElement>("[data-step]").forEach(b => {
  b.onclick = () => {
    const input = b.dataset.step!.startsWith("t") ? edTemp : edHold;
    const d = Number(b.dataset.step!.slice(1));
    input.value = String(Math.min(Number(input.max), Math.max(Number(input.min), Number(input.value) + d)));
    edLabels();
  };
});

// MARK: Lights

const LIGHT_COLORS: Record<number, string> = {
  2: "#9B5CFF", 3: "#2F6BFF", 4: "#19E3FF", 5: "#34E07A", 6: "#FFE14A", 7: "#FF9A2F", 8: "#FF3B3B", 9: "#FF6FC8",
};
function orbStyle(m: number): string {
  if (LIGHT_COLORS[m]) return `background:${LIGHT_COLORS[m]}`;
  if (m === 0) return "background:#20252B";
  if (m === 1) return "background:radial-gradient(circle at 40% 35%, #8fd9ff, #2a4a66)";
  return "background:conic-gradient(#3CF2D0, #19E3FF, #6A7BFF, #B66BFF, #3CF2D0)";
}
const groups: [string, typeof LightModes.basic][] = [
  ["Low key", LightModes.basic], ["Solid", LightModes.solid], ["Themes", LightModes.themes], ["Seasonal", LightModes.seasonal],
];
const lightGrid = $("lightGrid");
const lightOrder: [string, typeof LightModes.basic, boolean][] = [
  ["SOLID", LightModes.solid, true], ["THEMES", LightModes.themes, false], ["SEASONAL", LightModes.seasonal, false], ["LOW KEY", LightModes.basic, false],
];
for (const [title, modes, orbs] of lightOrder) {
  lightGrid.append(h("span", { class: "tag", style: "font-size:9.5px" }, title));
  const g = h("div", { class: orbs ? "orbs" : "chips2" });
  for (const m of modes) {
    const b = orbs
      ? h("button", { class: "orbBtn", "data-mode": String(m.id) }, h("span", { class: "orb", style: orbStyle(m.id) }), h("span", { class: "orbName" }, m.name.toUpperCase()))
      : h("button", { class: "lchip", "data-mode": String(m.id) }, m.name);
    b.onclick = () => rig.setLightMode(m.id);
    g.append(b);
  }
  lightGrid.append(g);
}
const lightKind = (m: number) => LightModes.solid.some(x => x.id === m) ? "Solid" : LightModes.themes.some(x => x.id === m) ? "Theme" : LightModes.seasonal.some(x => x.id === m) ? "Seasonal" : "Low key";
$<HTMLInputElement>("hapticsOn").onchange = (e) => rig.setHaptics((e.target as HTMLInputElement).checked);
$("showRow").onclick = () => openLightShow();

// Light show sheet (LightShowSheet on iPhone). Edits go through rig.show, which saves them.
let showRedraw: (() => void) | null = null;
function editShow(fn: (s: LightShow) => void) {
  const next: LightShow = JSON.parse(JSON.stringify(rig.show));
  fn(next);
  rig.show = next;
  showRedraw?.();
}
function showSegs(show: LightShow, total: number) {
  const t = Math.max(total, 10);
  const marks: { at: number; mode: number }[] = [];
  const first = show.steps.find(st => st.atStart);
  if (first) marks.push({ at: t, mode: first.lightMode });
  for (const st of show.steps) if (!st.atStart && st.secondsRemaining < t) marks.push({ at: st.secondsRemaining, mode: st.lightMode });
  marks.sort((a, b) => b.at - a.at);
  const out: { width: number; mode: number | null; flash: boolean }[] = [];
  let cursor = t; let mode: number | null = null;
  const flashFrom = show.flashEnabled ? Math.min(show.flashSeconds, t) : 0;
  const push = (to: number) => {
    if (!(cursor > to)) return;
    const cuts = [flashFrom, 3].filter(c => c < cursor && c > to).sort((a, b) => b - a);
    let a = cursor;
    for (const c of [...cuts, to]) { out.push({ width: a - c, mode, flash: show.flashEnabled && a <= flashFrom && c >= 3 }); a = c; }
    cursor = to;
  };
  for (const m of marks) { push(m.at); mode = m.mode; }
  push(0);
  return { segs: out, t };
}
function openLightShow() {
  openSheet(close => {
    const body = h("div", { class: "pageBody" });
    const done = () => { showRedraw = null; close(); };
    const draw = () => {
      const show = rig.show;
      const total = rig.heldHoldSeconds ?? 45;
      const { segs, t } = showSegs(show, total);
      const strip = h("div", { class: "showStrip" });
      for (const sg of segs) strip.append(h("span", { style: `width:${(100 * sg.width / t).toFixed(2)}%;opacity:${sg.flash ? 0.45 : 1};background:${sg.mode === null ? "var(--edge)" : (LIGHT_COLORS[sg.mode] ?? "#6A7BFF")}` }));
      const steps = show.steps.map((st, i) => stepCard(st, i));
      const full = show.steps.length >= 6;
      const num = (label: string, v: number, lo: number, hi: number, set: (n: number) => void) =>
        h("div", { class: "row", style: "gap:10px" }, h("span", { class: "cond", style: "font-size:18px;flex:1" }, label),
          h("button", { class: "step", onclick: () => set(Math.max(lo, v - 1)) }, "−"), h("button", { class: "step", onclick: () => set(Math.min(hi, v + 1)) }, "+"));
      const slider = (label: string, v: number, set: (n: number) => void) => {
        const r = h("input", { type: "range", min: 0, max: 100, step: 1, value: String(v), style: "flex:1",
          onchange: (e: Event) => set(Number((e.target as HTMLInputElement).value)) });
        return h("div", { class: "row", style: "gap:10px" }, h("span", { class: "cond", style: "font-size:18px;width:84px" }, `${label} ${v}`), r);
      };
      body.replaceChildren(
        topBar(null, null, textBtn("DONE", done, "var(--live)")),
        h("h2", { style: "font-size:36px;margin:0" }, "LIGHT SHOW"),
        h("label", { class: "switchRow" }, h("b", { class: "cond", style: "font-size:20px;font-weight:500" }, "Run light show"),
          h("input", { type: "checkbox", checked: rig.showEnabled, onchange: (e: Event) => { rig.showEnabled = (e.target as HTMLInputElement).checked; draw(); } })),
        h("p", { class: "mono sub", style: "font-size:10.5px;margin:0" }, "Only runs while the rig is heating. Lights go back to how they were when it ends."),
        h("div", { class: "stackS" }, tag(`A ${total}s DAB, LEFT TO RIGHT`, "font-size:9.5px"), strip,
          h("div", { class: "row" }, tag(clockText(total), "font-size:9.5px"), h("span", { style: "flex:1" }),
            tag(show.flashEnabled ? `FLASH FROM ${clockText(show.flashSeconds)}` : "NO FLASH", "font-size:9.5px"), h("span", { style: "flex:1" }), tag("0:00", "font-size:9.5px"))),
        h("div", { class: "row" }, tag("STEPS", "font-size:9.5px"), h("span", { style: "flex:1" }), tag(`${show.steps.length} OF 6`, "font-size:9.5px")),
        ...steps,
        h("button", { class: "btn2 wide", style: "border-style:dashed;letter-spacing:2px", disabled: full,
          onclick: () => editShow(s => { s.steps.push({ id: newStepID(), atStart: false, secondsRemaining: 20, lightMode: 3, brightness: 80 }); }) }, "+ ADD STEP"),
        tag("SLOW-DOWN FLASH", "font-size:9.5px"),
        h("div", { class: "panel pad stackS" },
          h("label", { class: "switchRow" }, h("b", { class: "cond", style: "font-size:20px;font-weight:500" }, "Flash near the end"),
            h("input", { type: "checkbox", checked: show.flashEnabled, onchange: (e: Event) => editShow(s => { s.flashEnabled = (e.target as HTMLInputElement).checked; }) })),
          num(`Start at ${show.flashSeconds} s left`, show.flashSeconds, 5, 30, n => editShow(s => { s.flashSeconds = n; })),
          slider("High", show.flashHigh, n => editShow(s => { s.flashHigh = n; })),
          slider("Low", show.flashLow, n => editShow(s => { s.flashLow = n; })),
          h("p", { class: "mono dim", style: "font-size:10px;margin:0" }, "Pulses about once a second. Stops 3 seconds before the end.")));
    };
    const stepCard = (st: ShowStep, i: number) => {
      const upd = (fn: (x: ShowStep) => void) => editShow(s => { const x = s.steps.find(y => y.id === st.id); if (x) fn(x); });
      const sel = h("select", { class: "textLine", style: "margin:0", onchange: (e: Event) => upd(x => { x.lightMode = Number((e.target as HTMLSelectElement).value); }) });
      for (const [title, list] of [["Low key", LightModes.basic], ["Solid", LightModes.solid], ["Themes", LightModes.themes], ["Seasonal", LightModes.seasonal]] as const) {
        const og = document.createElement("optgroup"); og.label = title;
        for (const m of list) { const o = document.createElement("option"); o.value = String(m.id); o.textContent = m.name; if (m.id === st.lightMode) o.selected = true; og.append(o); }
        sel.append(og);
      }
      return h("div", { class: "panel stepCard stackS" },
        h("div", { class: "row" }, tag(st.atStart ? "START" : `AT ${clockText(st.secondsRemaining)} LEFT`, "font-size:11px;color:var(--gold)"), h("span", { style: "flex:1" }),
          h("label", { class: "row", style: "gap:8px" }, h("span", { class: "cond sub", style: "font-size:17px" }, "At start"),
            h("input", { type: "checkbox", checked: st.atStart, onchange: (e: Event) => upd(x => { x.atStart = (e.target as HTMLInputElement).checked; }) }))),
        st.atStart ? null : h("div", { class: "row", style: "gap:10px" }, h("span", { class: "cond", style: "font-size:18px;flex:1" }, `When ${st.secondsRemaining} s or fewer remain`),
          h("button", { class: "step", onclick: () => upd(x => { x.secondsRemaining = Math.max(5, x.secondsRemaining - 1); }) }, "−"),
          h("button", { class: "step", onclick: () => upd(x => { x.secondsRemaining = Math.min(90, x.secondsRemaining + 1); }) }, "+")),
        h("div", { class: "row", style: "gap:10px" }, h("span", { class: "orb", style: `width:28px;height:28px;flex:none;${orbStyle(st.lightMode)}` }), sel),
        h("div", { class: "row", style: "gap:10px" }, h("span", { class: "cond", style: "font-size:18px;width:120px" }, `Brightness ${st.brightness}`),
          h("input", { type: "range", min: 0, max: 100, step: 1, value: String(st.brightness), style: "flex:1", onchange: (e: Event) => upd(x => { x.brightness = Number((e.target as HTMLInputElement).value); }) })),
        h("div", { class: "row" },
          h("button", { class: "btn2 pvBtn", style: "color:var(--live);font-size:15px", disabled: !rig.canPreview, onclick: () => rig.previewStep(rig.show.steps[i] ?? st) }, "PREVIEW 3s"),
          h("span", { style: "flex:1" }),
          h("button", { class: "textBtn", style: "color:var(--warn);font-size:15px", onclick: () => editShow(s => { s.steps = s.steps.filter(y => y.id !== st.id); }) }, "REMOVE")));
    };
    showRedraw = draw;
    draw();
    return body;
  });
}

const bright = $<HTMLInputElement>("bright");
let brightTouchedAt = 0;
bright.oninput = () => {
  brightTouchedAt = Date.now();
  $("brightV").textContent = bright.value;
  rig.setBrightness(Number(bright.value));
};

// MARK: Rig tab (rig-ui.ts), Link screen extras

let lookAround = false;
const rigUI = mountRig(ble, rig, {
  build: BUILD,
  onFindRig: () => { lookAround = false; schedule(); },
  lookLabel: () => `${faceID.toUpperCase()} · ${(prefs.get("look") ?? "dark").replace("light", "bright").toUpperCase()}`,
  buildLook: (page) => {
    const cur = prefs.get("look") ?? "dark";
    const seg = h("div", { class: "seg" });
    for (const [id, label] of [["dark", "DARK"], ["light", "BRIGHT"], ["auto", "AUTO"]]) {
      const b = h("button", { class: cur === id ? "on" : "", onclick: () => {
        prefs.set("look", id); applyLook(id); seg.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
      } }, label);
      seg.append(b);
    }
    const grid = h("div", { id: "faceGrid", class: "faceGrid" });
    page.append(tag("MODE", "font-size:9.5px;margin-top:8px"), seg, tag("HOME FACE", "font-size:9.5px;margin-top:8px"), grid,
      h("p", { class: "mono dim", style: "font-size:10px;margin:0" }, "Every face shows the same live temp, target and time left. HEAT IT and CUT IT never move."));
    drawFaceGrid(grid);
    buildSoundPicker(page);
  },
});
// Heat-up sound picker (Rig > Look), same rows and words as HeatSoundPicker.
function buildSoundPicker(page: HTMLElement) {
  const box = h("div", { class: "stackS" });
  const draw = () => {
    const cur = prefs.get("heatSound") ?? "chimes";
    box.replaceChildren(...HEAT_SOUNDS.map(c => {
      const on = cur === c.id;
      return h("button", { class: "soundRow" + (on ? " on" : ""), "aria-label": `${c.name} sound${on ? ", on" : ""}`, onclick: () => {
        prefs.set("heatSound", c.id); heatSound.preview(c.id); draw(); rigUI.render();
      } }, h("div", { style: "flex:1;min-width:0" }, h("b", { class: "cond" }, c.name), h("small", { class: "mono" }, c.line)), on ? tag("ON", "color:var(--live);font-size:9px") : null);
    }));
  };
  draw();
  page.append(tag("HEAT-UP SOUND", "font-size:9.5px;margin-top:8px"), box,
    h("p", { class: "mono dim", style: "font-size:10px;margin:0" }, "Tap one to hear a short preview; tapping another cuts it off. Follows the silent switch on iPhone where the browser allows it, and plays over your own music. Phone taps happen with every option on Android."));
}
$("lookAround").onclick = () => { lookAround = true; schedule(); };
$("linkJars").onclick = () => { lookAround = true; showTab("jars"); };
$("linkJarsBig").onclick = () => { lookAround = true; showTab("jars"); };
$("linkLog").onclick = () => { lookAround = true; showTab("rig"); schedule(); };

// MARK: Gauge (SVG). Fractions run 0..1 across a 270 degree sweep starting bottom left, as on iPhone.

const SVGNS = "http://www.w3.org/2000/svg";
const C = 130, R = 122;
const ang = (f: number) => (135 + 270 * f) * Math.PI / 180;
const pt = (f: number, r: number) => [C + Math.cos(ang(f)) * r, C + Math.sin(ang(f)) * r];
function arcPath(f0: number, f1: number, r: number): string {
  const [x0, y0] = pt(f0, r);
  const [x1, y1] = pt(f1, r);
  const large = (f1 - f0) * 270 > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
function buildGauge() {
  const svg = $("gauge") as unknown as SVGSVGElement;
  const ticks = document.createElementNS(SVGNS, "g");
  for (let i = 0; i <= 25; i++) {
    const f = i / 25;
    const major = i % 5 === 0;
    const [x0, y0] = pt(f, R * (major ? 0.84 : 0.885));
    const [x1, y1] = pt(f, R * 0.95);
    const l = document.createElementNS(SVGNS, "line");
    l.setAttribute("x1", x0.toFixed(2)); l.setAttribute("y1", y0.toFixed(2));
    l.setAttribute("x2", x1.toFixed(2)); l.setAttribute("y2", y1.toFixed(2));
    l.setAttribute("class", major ? "tickMajor" : "tickMinor");
    ticks.appendChild(l);
  }
  svg.insertBefore(ticks, svg.querySelector("#gArc"));
  for (let i = 0; i < 6; i++) {
    const [x, y] = pt(i / 5, R * 0.69);
    const t = document.createElementNS(SVGNS, "text");
    t.setAttribute("x", x.toFixed(1)); t.setAttribute("y", (y + 4).toFixed(1));
    t.setAttribute("class", "gLabel");
    t.id = `gL${i}`;
    svg.insertBefore(t, svg.querySelector("#gNeedle"));
  }
}
buildGauge();

// MARK: Render

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
const clockText = (s: number) => { const v = Math.max(s, 0); return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`; };
function setText(id: string, t: string) { const el = $(id); if (el.textContent !== t) el.textContent = t; }
function enable(id: string, on: boolean) { ($(id) as HTMLButtonElement).disabled = !on; }
function show(id: string, on: boolean) { const el = $(id); if (el.hidden === on) el.hidden = !on; }

let queued = false;
let wasHeating = false;
function render() {
  queued = false;
  if (connectAfterPick && ble.devices.length > 0) {
    connectAfterPick = false;
    ble.connect(ble.devices[0]);
  }
  const s = rig.live;
  const linked = ble.isConnected;
  const heating = rig.sessionOn;
  if (heating !== wasHeating) { wasHeating = heating; void keepAwake(heating); }
  document.querySelectorAll<HTMLButtonElement>(".pvBtn").forEach(b => { if (b.disabled === rig.canPreview) b.disabled = !rig.canPreview; });

  // Link screen until the rig is linked (or coming back).
  if (linked) lookAround = false;
  const onLink = !linked && !ble.reconnecting && !lookAround;
  show("linkScreen", onLink);
  show("main", !onLink);
  setText("linkState", connectAfterPick || ble.connectionText === "Scanning" ? "Pick your rig in the list that opened." : ble.connectionText);
  setText("btMsg", ble.btMessage ?? "");
  show("btMsg", !!ble.btMessage);
  show("btMsg2", !!ble.btMessage);
  setText("btMsg2", ble.btMessage ?? "");

  // Header
  const linkText = linked ? (rig.linkFresh ? "SWITCH 2 · LINKED" : "LINKED · WAITING ON THE RIG")
    : ble.reconnecting ? "GETTING THE RIG BACK…" : "NOT LINKED";
  setText("linkTag", linkText);
  $("linkDot").classList.toggle("live", linked && rig.linkFresh);
  setText("battery", s ? `${s.battery}%` : "");
  setText("batteryTag", s ? (chargingOf(s) ? "CHARGING" : "BATTERY") : "");

  // Notices (wording from the controller, unchanged)
  const m = rig.message;
  show("notice", !!m);
  if (m) {
    setText("noticeTag", m.startsWith("Heat came back on") ? "SAFETY CUT" : "HEADS UP");
    setText("noticeText", m);
  }
  show("away", !!rig.awayNote);
  setText("awayText", rig.awayNote ?? "");

  // Gauge readout
  const celsius = s?.unitByte === 12;
  const lo = celsius ? 100 : 200, hi = celsius ? 350 : 700, room = celsius ? 21 : 70;
  const labels = celsius ? [100, 150, 200, 250, 300, 350] : [200, 300, 400, 500, 600, 700];
  labels.forEach((v, i) => setText(`gL${i}`, String(v)));
  let frac = 0, targetFrac: number | null = null, targetText = "---", status = linked ? "WAITING ON THE RIG" : "NOT LINKED";
  let profileText = "--";
  if (s) {
    frac = clamp01((s.tempRaw - lo) / (hi - lo));
    if (s.preset >= 0 && s.preset <= 5) {
      const ps = rig.presets[s.preset];
      const t = celsius ? ps.tempC : ps.tempF;
      if (t !== undefined) { targetText = `${t}°`; targetFrac = clamp01((t - lo) / (hi - lo)); }
      if (ps.profile !== undefined) profileText = HeatProfile.name(ps.profile);
    }
    status = !rig.linkFresh ? "WAITING ON THE RIG" : heating ? `HEATING · ${clockText(s.sessionTimeRemaining)} LEFT`
      : s.tempRaw > room + 50 ? "COOLING · HEAT OFF" : "COOL · READY";
  }
  document.body.classList.toggle("heating", heating);
  setText("gTemp", s ? `${s.tempRaw}°` : "---");
  setText("gStatus", status);
  $("gNeedle").setAttribute("transform", `rotate(${(225 + 270 * frac).toFixed(1)} ${C} ${C})`);
  if (heating && frac > 0.002) { $("gArc").setAttribute("d", arcPath(0, frac, R * 0.985)); }
  else $("gArc").setAttribute("d", "");
  if (targetFrac !== null) {
    $("gMarker").setAttribute("transform", `rotate(${(225 + 270 * targetFrac).toFixed(1)} ${C} ${C})`);
    $("gMarker").style.display = "";
  } else $("gMarker").style.display = "none";
  setText("cTarget", targetText);
  {
    let fill = 0, presetLine = "";
    if (s && s.preset >= 0 && s.preset <= 5) {
      const ps = rig.presets[s.preset];
      const t = celsius ? ps.tempC : ps.tempF;
      if (t !== undefined && t > room) fill = clamp01((s.tempRaw - room) / (t - room));
      presetLine = `PRESET ${s.preset} · ${ps.profile !== undefined ? HeatProfile.name(ps.profile).toUpperCase() : "—"}`;
    }
    const now = Date.now();
    if (s && now - lastTraceAt >= 450) { lastTraceAt = now; trace.add(fill, heating); }
    const ro: Readout = { tempText: s ? `${s.tempRaw}°` : "---", targetText, fill, heating, secondsLeft: s?.sessionTimeRemaining ?? 0, statusLine: status, presetLine };
    face?.update(ro, trace.points);
  }
  const hold = rig.heldHoldSeconds;
  setText("cHold", hold !== undefined ? `${hold}s` : "--");
  setText("cProfile", profileText);
  setText("cLeft", heating && s ? clockText(s.sessionTimeRemaining) : "--");

  // Presets
  const locked = !rig.canControl || heating;
  setText("presetTag", heating ? "PRESETS · LOCKED WHILE HEATING" : "PRESETS");
  for (let n = 1; n <= 5; n++) {
    const p = rig.presets[n];
    const t = celsius ? p.tempC : p.tempF;
    setText(`p${n}t`, t !== undefined ? `${t}°` : "—");
    $(`p${n}`).classList.toggle("on", s?.preset === n);
    enable(`p${n}`, !locked);
  }
  const sel = s?.preset ?? 0;
  renderCurve(sel, celsius, heating);
  show("editBtn", sel >= 1 && sel <= 5);
  setText("editBtn", `EDIT ${sel}`);
  enable("editBtn", !locked);
  if (heating && !$("editor").hidden) $("editor").hidden = true;

  // Heat controls
  show("heatRow", !heating);
  show("cutRow", heating);
  // Ride the dial strip (DialStrip): only while heating. Same controller calls as the Rig > Ride the dial page.
  show("dialStrip", heating && linked);
  if (heating && linked) {
    const off = rig.dialDisabledReason !== null && rig.dialDisabledReason !== undefined;
    const locked = rig.dialCurrent !== rig.dialStart;
    setText("dialGoal", "GOAL " + (rig.dialCurrent !== null ? `${rig.dialCurrent}°F` : "---"));
    enable("dialDown", !off); enable("dialUp", !off);
    $("dialA").classList.toggle("on", rig.dialMode === "live"); $("dialB").classList.toggle("on", rig.dialMode === "active");
    enable("dialA", !locked); enable("dialB", !locked);
    setText("dialSay", rig.dialDisabledReason ?? rig.dialReadout);
  }
  enable("heat", rig.canHeat);
  enable("extend", rig.canExtend);
  setText("heatHint", !linked ? "" : !rig.linkFresh ? "Waiting on the rig…" : rig.startPendingAt !== null ? "Starting…" : "");

  // Home lights strip
  {
    const lm = s?.lightMode ?? 1;
    $("stripOrb").setAttribute("style", `width:40px;height:40px;${orbStyle(lm)}`);
    setText("stripName", LightModes.name(lm));
    setText("stripDetail", s ? `${s.brightness}% · haptics ${s.hapticsByte === 170 ? "on" : "off"}` : "Link the rig to set lights");
    setText("stripShow", !rig.showEnabled ? "SHOW OFF" : heating ? "RUNNING" : "SHOW ON");
    $("stripShow").style.color = rig.showEnabled ? "var(--gold)" : "var(--dim)";
    $("stripShow").style.borderColor = rig.showEnabled ? "color-mix(in srgb, var(--gold) 60%, transparent)" : "var(--edge)";
  }

  // Lights
  if (tab === "lights") {
    const cur = s?.lightMode ?? -1;
    lightGrid.querySelectorAll<HTMLButtonElement>(".orbBtn, .lchip").forEach(b => {
      b.classList.toggle("on", Number(b.dataset.mode) === cur);
      b.disabled = !rig.canControl;
    });
    const nowMode = s?.lightMode ?? 1;
    $("nowOrb").setAttribute("style", `width:76px;height:76px;${orbStyle(nowMode)}`);
    setText("lightNow", s ? LightModes.name(s.lightMode) : "---");
    setText("lightKind", s ? lightKind(s.lightMode) : "Link the rig first");
    if (s && Date.now() - brightTouchedAt > 1500 && document.activeElement !== bright) {
      bright.value = String(s.brightness);
      setText("brightV", String(s.brightness));
    }
    bright.disabled = !rig.canControl;
    const hp = $<HTMLInputElement>("hapticsOn");
    if (s) hp.checked = s.hapticsByte === 170;
    hp.disabled = !rig.canControl;
    setText("showSub", `${rig.show.steps.length} steps` + (rig.show.flashEnabled ? " · slow-down flash" : ""));
    setText("showTag", rig.showEnabled ? "ON" : "OFF");
    $("showTag").style.color = rig.showEnabled ? "var(--gold)" : "var(--dim)";
  }

  // Rig tab
  if (tab === "rig") rigUI.render();

}
// MARK: Home face (Gauge, Digits, Scope, Pour), saved per browser like the iPhone's look.face

const trace = new TempTrace();
let faceID = prefs.get("face") ?? "gauge";
let face: Face | null = null;
let lastTraceAt = 0;
function setFace(id: string) {
  faceID = FACES.some(f => f.id === id) ? id : "gauge";
  prefs.set("face", faceID);
  face?.root.remove();
  face = makeFace(faceID);
  const card = $("faceCard");
  card.classList.toggle("alt", !!face);
  if (face) card.append(face.root);
  drawFaceGrid();
  schedule();
}
let faceGridEl: HTMLElement | null = null;
function drawFaceGrid(into?: HTMLElement) {
  if (into) faceGridEl = into;
  const grid = faceGridEl;
  if (!grid || (!into && !grid.isConnected)) return;
  grid.replaceChildren();
  for (const f of FACES) {
    const key = document.createElement("button");
    key.className = "faceKey" + (f.id === faceID ? " on" : "");
    key.setAttribute("aria-label", `${f.name} face${f.id === faceID ? ", on" : ""}`);
    const mini = document.createElement("div"); mini.className = "mini";
    const card = document.createElement("div"); card.className = "gaugeCard panel" + (f.id === "gauge" ? "" : " alt");
    if (f.id === "gauge") {
      const g = $("gauge").cloneNode(true) as SVGSVGElement;
      g.removeAttribute("id");
      g.querySelector("#gNeedle")?.setAttribute("transform", `rotate(${225 + 270 * 0.424} ${C} ${C})`);
      g.querySelector("#gArc")?.setAttribute("d", arcPath(0, 0.424, R * 0.985));
      const m = g.querySelector<SVGGElement>("#gMarker"); if (m) { m.style.display = ""; m.setAttribute("transform", `rotate(${225 + 270 * 0.6} ${C} ${C})`); }
      g.querySelectorAll("[id]").forEach(e => { e.classList.add("m-" + e.id); e.removeAttribute("id"); });
      g.classList.add("miniGauge");
      const ro = document.createElement("div"); ro.className = "readout";
      ro.innerHTML = '<div style="font:600 44px/1 var(--cond);color:var(--live)">412°</div>';
      card.append(g, ro);
    } else {
      const ff = makeFace(f.id)!; ff.update(DEMO, DEMO_POINTS); card.append(ff.root);
    }
    mini.append(card);
    const name = document.createElement("div"); name.className = "name"; name.textContent = f.name;
    if (f.id === faceID) { const on = document.createElement("span"); on.className = "tag"; on.style.color = "var(--live)"; on.textContent = "ON"; name.append(on); }
    key.append(mini, name);
    key.onclick = () => setFace(f.id);
    grid.append(key);
  }
}

function schedule() { if (!queued) { queued = true; requestAnimationFrame(render); } }
ble.onChange = schedule;
$("dialDown").onclick = () => rig.dialNudge(-RigController.dialStep);
$("dialUp").onclick = () => rig.dialNudge(RigController.dialStep);
$("dialA").onclick = () => { if (rig.dialCurrent === rig.dialStart) { rig.dialMode = "live"; schedule(); } };
$("dialB").onclick = () => { if (rig.dialCurrent === rig.dialStart) { rig.dialMode = "active"; schedule(); } };
const heatFX = new HeatFX($("faceCard"), () => prefs.get("heatSound") ?? "chimes", () => faceID);
rig.onChange = () => { watcher.update(rig); heatFX.update(rig); schedule(); };
// Audio can only start after a tap: unlock it on the first tap of any kind, and resume after an interruption.
for (const ev of ["pointerdown", "pointerup", "touchend", "click"]) document.addEventListener(ev, () => heatSound.unlock(), { capture: true, passive: true });
setInterval(schedule, 500);
setFace(faceID);
{ // The Link screen's dim gauge, as on iPhone: needle at rest, no readout.
  const g = $("gauge").cloneNode(true) as SVGSVGElement;
  g.removeAttribute("id");
  g.querySelector("#gArc")?.setAttribute("d", "");
  g.querySelectorAll("[id]").forEach(e => { e.classList.add("m-" + e.id); e.removeAttribute("id"); });
  const m = g.querySelector<SVGGElement>(".m-gMarker"); if (m) m.style.display = "none";
  g.querySelector(".m-gNeedle")?.setAttribute("transform", `rotate(225 ${C} ${C})`);
  [200, 300, 400, 500, 600, 700].forEach((v, i) => { const t = g.querySelector(`.m-gL${i}`); if (t) t.textContent = String(v); });
  $("linkGauge").append(g);
}
showTab("home");
render();
