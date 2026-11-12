// The Torchless web app. Same rig logic as the test page (src/rig, unchanged), with the Gauge screens from
// the iPhone app: Link it, Home (gauge, presets, HEAT IT / CUT IT, current jar), Jars, Lights, Rig.
// Phase 4b: the jar library, dab rating and price log, kept on this device. Sign-in comes later.

import { RealClock } from "../rig/clock";
import { LocalStore } from "../rig/storage";
import { BLEManager } from "../rig/ble-manager";
import { RigController, LightModes, HeatProfile, RigLimits } from "../rig/rig-controller";
import { WebCentral } from "../rig/web-central";
import { chargingOf } from "../rig/frames";
import { JarStore, IDBJarBackend, MemoryJarBackend } from "./jars";
import { DabWatcher } from "./dab-watcher";
import { mountJars } from "./jar-ui";

const BUILD = "app-4b.1";
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
const jarUI = mountJars(jars, watcher, (t) => showTab(t));
jars.onChange = () => { jarUI.renderHome(); if (tab === "jars") jarUI.renderJars(); jarUI.renderOpen(); };
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
  document.querySelectorAll<HTMLButtonElement>("[data-look]").forEach(b => b.classList.toggle("on", b.dataset.look === v));
}
applyLook(prefs.get("look") ?? "auto");
document.querySelectorAll<HTMLButtonElement>("[data-look]").forEach(b => {
  b.onclick = () => { prefs.set("look", b.dataset.look!); applyLook(b.dataset.look!); };
});

// MARK: Leaving the page counts as leaving the app (same away rule as on iPhone)

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") rig.appMovedToBackground(); else rig.appBecameActive();
});
window.addEventListener("pagehide", () => rig.appMovedToBackground());
window.addEventListener("pageshow", () => { if (document.visibilityState === "visible") rig.appBecameActive(); });

// Keep the screen on while heating where the browser allows it: a locked phone freezes the page.
type Lock = { release(): Promise<void> };
let wake: Lock | null = null;
async function keepAwake(on: boolean) {
  const wl = (navigator as unknown as { wakeLock?: { request(t: string): Promise<Lock> } }).wakeLock;
  if (!wl) return;
  try {
    if (on && !wake) wake = await wl.request("screen");
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
for (const [title, modes] of groups) {
  const h = document.createElement("div");
  h.className = "tag";
  h.textContent = title.toUpperCase();
  lightGrid.appendChild(h);
  const g = document.createElement("div");
  g.className = "orbs";
  for (const m of modes) {
    const b = document.createElement("button");
    b.className = "orbBtn";
    b.dataset.mode = String(m.id);
    b.innerHTML = `<span class="orb" style="${orbStyle(m.id)}"></span><span class="orbName"></span>`;
    (b.querySelector(".orbName") as HTMLElement).textContent = m.name;
    b.onclick = () => rig.setLightMode(m.id);
    g.appendChild(b);
  }
  lightGrid.appendChild(g);
}
const bright = $<HTMLInputElement>("bright");
let brightTouchedAt = 0;
bright.oninput = () => {
  brightTouchedAt = Date.now();
  $("brightV").textContent = `${bright.value}%`;
  rig.setBrightness(Number(bright.value));
};
$<HTMLInputElement>("showOn").onchange = (e) => { rig.showEnabled = (e.target as HTMLInputElement).checked; };

// MARK: Rig tab

$("disconnect").onclick = () => rig.askDisconnect();
$("copyLog").onclick = async () => {
  try {
    await navigator.clipboard.writeText(ble.exportText(BUILD));
    $("copyLog").textContent = "Copied";
  } catch {
    $("copyLog").textContent = "Copy failed: use Save";
  }
  setTimeout(() => { $("copyLog").textContent = "Copy log"; }, 2000);
};
$("saveLog").onclick = () => {
  const blob = new Blob([ble.exportText(BUILD)], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const d = new Date();
  a.download = `Torchless-log-${d.toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
$("build").textContent = BUILD;

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

  // Link screen until the rig is linked (or coming back).
  const onLink = !linked && !ble.reconnecting;
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
  show("editBtn", sel >= 1 && sel <= 5);
  setText("editBtn", `EDIT ${sel}`);
  enable("editBtn", !locked);
  if (heating && !$("editor").hidden) $("editor").hidden = true;

  // Heat controls
  show("heatRow", !heating);
  show("cutRow", heating);
  enable("heat", rig.canHeat);
  enable("extend", rig.canExtend);
  setText("heatHint", !linked ? "" : !rig.linkFresh ? "Waiting on the rig…" : rig.startPendingAt !== null ? "Starting…" : "");

  // Lights
  if (tab === "lights") {
    const cur = s?.lightMode ?? -1;
    lightGrid.querySelectorAll<HTMLButtonElement>(".orbBtn").forEach(b => {
      b.classList.toggle("on", Number(b.dataset.mode) === cur);
      b.disabled = !rig.canControl;
    });
    setText("lightNow", s ? `${LightModes.name(s.lightMode)} · ${s.brightness}%` : "--");
    if (s && Date.now() - brightTouchedAt > 1500 && document.activeElement !== bright) {
      bright.value = String(s.brightness);
      setText("brightV", `${s.brightness}%`);
    }
    bright.disabled = !rig.canControl;
    $<HTMLInputElement>("showOn").checked = rig.showEnabled;
  }

  // Rig tab
  if (tab === "rig") {
    const info = ble.deviceInfo;
    const rows: [string, string][] = [
      ["Name", ble.peripheralName || "--"],
      ["Model", info["Model number (2A24)"] ?? "--"],
      ["Firmware", info["Software revision (2A28)"] ?? "--"],
      ["Units", s ? (celsius ? "°C" : "°F") : "--"],
      ["Battery", s ? `${s.battery}%${chargingOf(s) ? ", charging" : ""}` : "--"],
      ["Link", ble.connectionText],
    ];
    const html = rows.map(([k]) => `<div class="kv"><span>${k}</span><b></b></div>`).join("");
    const box = $("rigInfo");
    if (box.childElementCount !== rows.length) box.innerHTML = html;
    rows.forEach(([, v], i) => { const b = box.children[i].querySelector("b")!; if (b.textContent !== v) b.textContent = v; });
    enable("disconnect", linked || ble.reconnecting);
    setText("disconnect", rig.disconnectWaiting ? "Disconnect now" : "Disconnect");
  }
}
function schedule() { if (!queued) { queued = true; requestAnimationFrame(render); } }
ble.onChange = schedule;
rig.onChange = () => { watcher.update(rig); schedule(); };
setInterval(schedule, 500);
showTab("home");
render();
