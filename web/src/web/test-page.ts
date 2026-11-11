// Phase 3: the bare rig test page. Connect, live status, HEAT IT, CUT IT, +10s, presets, dial, log.
// No account, no jars, no styling beyond what makes it usable on a phone.

import { RealClock } from "../rig/clock";
import { LocalStore } from "../rig/storage";
import { BLEManager } from "../rig/ble-manager";
import { RigController, LightModes } from "../rig/rig-controller";
import { WebCentral } from "../rig/web-central";

const BUILD = "test-3.1";
const clock = new RealClock();
const central = new WebCentral();
const ble = new BLEManager(central, clock);
const rig = new RigController(clock, new LocalStore("presh."));
rig.attach(ble);
ble.log(`Presh web ${BUILD} started. ${navigator.userAgent}`);

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let connectAfterPick = false;

// Leaving the page counts as leaving the app: the same away rule as on iPhone.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") rig.appMovedToBackground(); else rig.appBecameActive();
});
window.addEventListener("pagehide", () => rig.appMovedToBackground());
window.addEventListener("pageshow", () => { if (document.visibilityState === "visible") rig.appBecameActive(); });

function openChooser(all: boolean) {
  connectAfterPick = true;
  ble.devices = [];
  ble.showAll = all;
  ble.startScan();   // opens the browser's chooser; must stay inside this tap
}
$("connect").onclick = () => openChooser(false);
$("connectAll").onclick = () => openChooser(true);
central.onChooserClosed = (why) => {
  ble.log(`Chooser closed without a rig: ${why}`);
  ble.stopScan();
};
$("disconnect").onclick = () => rig.askDisconnect();
$("heat").onclick = () => rig.heatIt();
$("cut").onclick = () => rig.cutIt();
$("extend").onclick = () => rig.extendTen();
$("dialDown").onclick = () => rig.dialNudge(-RigController.dialStep);
$("dialUp").onclick = () => rig.dialNudge(RigController.dialStep);
$("dialMode").onchange = (e) => { rig.dialMode = (e.target as HTMLSelectElement).value === "active" ? "active" : "live"; render(); };
for (let n = 1; n <= 5; n++) $(`p${n}`).onclick = () => rig.selectPreset(n);
const lightSel = $<HTMLSelectElement>("light");
for (const m of LightModes.all) {
  const o = document.createElement("option");
  o.value = String(m.id);
  o.textContent = m.name;
  lightSel.appendChild(o);
}
$("setLight").onclick = () => rig.setLightMode(Number(lightSel.value));
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
  a.download = `Presh-web-log-${d.toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

function setText(id: string, t: string) { const el = $(id); if (el.textContent !== t) el.textContent = t; }
function enable(id: string, on: boolean) { ($(id) as HTMLButtonElement).disabled = !on; }

let queued = false;
function render() {
  queued = false;
  if (connectAfterPick && ble.devices.length > 0) {
    connectAfterPick = false;
    ble.connect(ble.devices[0]);
  }
  setText("bt", ble.btMessage ?? "");
  $("bt").hidden = !ble.btMessage;
  setText("conn", ble.connectionText);
  const s = rig.live;
  const heating = rig.sessionOn;
  setText("temp", rig.liveTempF !== null ? `${rig.liveTempF} °F` : "--");
  setText("state", !s ? "No status yet" : heating ? "HEATING" : rig.startPendingAt !== null ? "Starting..." : "Idle");
  $("state").className = heating ? "state hot" : "state";
  setText("left", s && heating ? `${s.sessionTimeRemaining} s left${s.sessionExtend > 0 ? ` (+${s.sessionExtend * 10} s)` : ""}` : "");
  setText("preset", s ? `Preset ${s.preset}` : "");
  setText("lightNow", s ? `${LightModes.name(s.lightMode)}, brightness ${s.brightness}` : "");
  setText("battery", s ? `Battery ${s.battery}%` : "");
  setText("fresh", ble.isConnected && !rig.linkFresh ? "Status is stale. Wait for the rig." : "");
  for (let n = 1; n <= 5; n++) {
    const p = rig.presets[n];
    const btn = $(`p${n}`);
    setText(`p${n}`, `${n}: ${p.tempF ?? "?"}°F ${p.hold ?? "?"}s`);
    btn.className = s && s.preset === n ? "preset on" : "preset";
    enable(`p${n}`, rig.canControl && !heating);
  }
  enable("heat", rig.canHeat);
  enable("cut", ble.isConnected);
  enable("extend", rig.canExtend);
  const dialWhy = rig.dialDisabledReason;
  enable("dialDown", dialWhy === null);
  enable("dialUp", dialWhy === null);
  setText("dialTarget", rig.dialCurrent !== null ? `Target ${rig.dialCurrent} °F` : "");
  setText("dialWhy", dialWhy ?? `${rig.dialReadout}. ${rig.dialNumbers}`);
  enable("setLight", rig.canControl);
  enable("disconnect", ble.isConnected || ble.reconnecting);
  setText("disconnect", rig.disconnectWaiting ? "Disconnect now" : "Disconnect");
  setText("msg", rig.message ?? "");
  $("msg").hidden = !rig.message;
  setText("away", rig.awayNote ?? "");
  $("away").hidden = !rig.awayNote;
  const lines = ble.logLines.filter(l => !l.includes("CURVE")).slice(-150);
  setText("log", lines.join("\n"));
}
function schedule() { if (!queued) { queued = true; requestAnimationFrame(render); } }
ble.onChange = schedule;
rig.onChange = schedule;
setInterval(schedule, 500);
render();
