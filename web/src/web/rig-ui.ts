// Rig tab, laid out like the iPhone's RigView (ContentView.swift): link card, battery/power/units tiles,
// UNLINK (or FIND YOUR RIG), Look, and Shop tools (Log, Ride the dial, Raw status). Screens only: the only
// rig calls are askDisconnect, dialNudge and dialMode, the same ones the iPhone screens use.

import { BLEManager } from "../rig/ble-manager";
import { RigController } from "../rig/rig-controller";
import { chargingOf, unitText, sessionOnOf, hapticsOf } from "../rig/frames";
import { h, openSheet, topBar, textBtn, tag, icon } from "./jar-ui";
import { CLEAN_CHOICES } from "./extras";

export interface RigUIHooks {
  build: string;
  onFindRig(): void;
  lookLabel(): string;
  /** Fills the Look page (mode, faces, sound). */
  buildLook(page: HTMLElement): void;
  /** Clean reminder: how many dabs between reminders (the user's pick; Dr. Dabber gives no number). */
  cleanEvery(): number;
  showTutorial(): void;
  cleanOn(): boolean;
  setClean(on: boolean, every: number): void;
}

const set = (e: Element, t: string) => { if (e.textContent !== t) e.textContent = t; };

export function mountRig(ble: BLEManager, rig: RigController, hooks: RigUIHooks) {
  const panel = document.getElementById("rigPanel")!;
  const linked = () => ble.isConnected || ble.reconnecting;

  // Link card
  const linkIcon = h("span", { class: "rigIcon" }, icon("signal"));
  const linkName = h("b", { class: "cond", style: "font-size:26px;display:block" });
  const linkText = h("span", { class: "mono sub", style: "font-size:10px" });
  const linkCard = h("div", { class: "linkCard" }, linkIcon, h("div", { style: "min-width:0" }, linkName, linkText));

  const tile = (title: string) => { const v = h("b"); return { el: h("div", { class: "panel tile" }, tag(title, "font-size:9px"), v), v }; };
  const tBat = tile("BATTERY"), tPow = tile("POWER"), tUnit = tile("UNITS");

  const unlink = h("button", { class: "unlink", onclick: () => rig.askDisconnect() }, "UNLINK");
  const unlinkNote = h("p", { class: "mono sub", style: "font-size:10.5px;margin:0" }, "Dab's still going. It finishes first, then the app lets go of the rig.");
  const findRig = h("button", { class: "findRig", onclick: hooks.onFindRig }, "FIND YOUR RIG");

  const row = (title: string, ico: string, note: () => string, noteColor: string, open: () => void) => {
    const n = h("span", { class: "tag", style: `color:${noteColor}` });
    const b = h("button", { class: "toolRow", onclick: open }, h("span", { class: "toolIcon" }, icon(ico)), h("span", { class: "cond", style: "font-size:20px" }, title), h("span", { style: "flex:1" }), n, h("span", { class: "chev" }, "›"));
    return { b, upd: () => set(n, note()) };
  };
  const look = row("Look", "look", () => hooks.lookLabel(), "var(--dim)", openLook);
  const clean = row("Deep clean", "check", () => hooks.cleanOn() ? `EVERY ${hooks.cleanEvery()} DABS` : "OFF", "var(--dim)", openClean);
  const howTo = row("How it works", "list", () => "REPLAY", "var(--dim)", () => hooks.showTutorial());
  const log = row("Log", "list", () => "SHARE IT", "var(--dim)", openLog);
  const dial = row("Ride the dial", "dial", () => "TEST", "var(--gold)", openDial);
  const raw = row("Raw status", "pulse", () => "", "var(--dim)", openRaw);

  panel.replaceChildren(
    h("h2", {}, "RIG"),
    linkCard,
    h("div", { class: "tiles" }, tBat.el, tPow.el, tUnit.el),
    h("div", { class: "stackS" }, unlink, unlinkNote, findRig),
    h("div", { class: "panel toolList" }, clean.b, h("hr"), howTo.b),
    h("div", {}, tag("SHOP TOOLS", "font-size:9.5px"), h("div", { class: "panel toolList", style: "margin-top:8px" }, log.b, h("hr"), raw.b)),
    h("p", { class: "mono dim center", style: "font-size:9.5px;margin-top:6px" }, `Compatible with Dr. Dabber Switch 2. Not an official Dr. Dabber app. Build ${hooks.build}.`),
  );

  let pageUpd: (() => void) | null = null;
  let lastStatusTime: number | null = null, seenAt = new Date();

  function render() {
    const s = rig.live;
    set(linkName, ble.peripheralName || "No rig");
    set(linkText, ble.connectionText);
    linkCard.classList.toggle("on", ble.isConnected);
    set(tBat.v, s ? `${s.battery}%` : "--");
    set(tPow.v, s ? (chargingOf(s) ? "Charging" : "On battery") : "--");
    set(tUnit.v, s ? "°" + unitText(s) : "--");
    const l = linked();
    unlink.hidden = !l;
    set(unlink, rig.disconnectWaiting ? "UNLINK NOW" : "UNLINK");
    unlinkNote.hidden = !(l && rig.disconnectWaiting);
    findRig.hidden = l;
    look.upd(); clean.upd(); howTo.upd(); log.upd(); dial.upd(); raw.upd();
    pageUpd?.();
  }

  function page(title: string, fill: (body: HTMLElement) => (() => void) | void) {
    openSheet(close => {
      const body = h("div", { class: "pageBody" });
      const done = () => { pageUpd = null; close(); };
      body.append(topBar(null, null, textBtn("DONE", done, "var(--live)")), h("h2", { style: "font-size:40px;margin:0" }, title));
      const upd = fill(body);
      pageUpd = upd ?? null;
      upd?.();
      return body;
    });
  }

  function openClean() {
    page("DEEP CLEAN", body => {
      const pick = h("select", { class: "cleanPick", style: "font:inherit;font-size:20px;padding:10px 12px;border-radius:12px;background:var(--panel,#111);color:inherit;border:1px solid var(--line,#333);width:100%" }) as HTMLSelectElement;
      for (const n of CLEAN_CHOICES) pick.append(h("option", { value: String(n) }, `Every ${n} dabs`));
      pick.value = String(hooks.cleanEvery());
      const sw = h("input", { type: "checkbox", style: "width:28px;height:28px;accent-color:var(--gold)" }) as HTMLInputElement;
      sw.checked = hooks.cleanOn();
      const sync = () => { pick.disabled = !sw.checked; pick.style.opacity = sw.checked ? "1" : ".4"; hooks.setClean(sw.checked, Number(pick.value)); render(); };
      sw.onchange = sync; pick.onchange = sync; pick.disabled = !sw.checked; pick.style.opacity = sw.checked ? "1" : ".4";
      body.append(
        h("p", { class: "sub cond", style: "font-size:19px;margin:0" }, "A reminder on Home when it's time to deep clean."),
        h("label", { class: "toolRow", style: "cursor:pointer" }, h("span", { class: "cond", style: "font-size:20px" }, "Remind me"), h("span", { style: "flex:1" }), sw),
        pick);
    });
  }

  function openLook() { page("LOOK", body => { body.append(h("p", { class: "sub cond", style: "font-size:19px;margin:0" }, "Make it yours.")); hooks.buildLook(body); }); }

  function openLog() {
    page("LOG", body => {
      const copy = h("button", { class: "btn2", style: "flex:1", onclick: async () => {
        try { await navigator.clipboard.writeText(ble.exportText(hooks.build)); set(copy, "Copied"); }
        catch { set(copy, "Copy failed: use Share"); }
      } }, "Copy");
      const share = h("button", { class: "goldBtn", style: "flex:1;margin:0;min-height:48px;font-size:18px", onclick: async () => {
        const text = ble.exportText(hooks.build);
        const name = `torchless-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
        const file = new File([text], name, { type: "text/plain" });
        const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
        try { if (nav.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: "Torchless log" }); return; } } catch { /* fall through */ }
        const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = name; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      } }, "Share");
      const lines = h("pre", { class: "logLines" });
      body.append(h("div", { class: "row", style: "gap:10px" }, share, copy), lines);
      let shown = -1;
      return () => {
        if (ble.logLines.length === shown) return;
        shown = ble.logLines.length;
        lines.textContent = ble.logLines.slice(-1500).join("\n");
        set(copy, "Copy");
      };
    });
  }

  function openDial() {
    page("RIDE THE DIAL", body => {
      const why = h("p", { class: "cond", style: "color:var(--warn);font-size:17px;margin:0" });
      const segA = h("button", { onclick: () => { rig.dialMode = "live"; render(); } }, "A: Live slot");
      const segB = h("button", { onclick: () => { rig.dialMode = "active"; render(); } }, "B: Active preset");
      const down = h("button", { class: "btn2 nudge", onclick: () => rig.dialNudge(-RigController.dialStep) }, `−${RigController.dialStep}°`);
      const up = h("button", { class: "btn2 nudge", onclick: () => rig.dialNudge(RigController.dialStep) }, `+${RigController.dialStep}°`);
      const nums = h("div", { class: "mono", style: "color:var(--gold);font-size:12px;line-height:1.6" });
      const readout = h("b", { class: "cond", style: "font-size:19px" });
      const numbers = h("p", { class: "mono dim", style: "font-size:11px;margin:0" });
      body.append(
        h("p", { class: "mono dim", style: "font-size:11px;margin:0" }, `Only works while a heat session is already running. Never starts or stops one. Each tap moves the temp target ${RigController.dialStep}°F, up to 50°F from where it started. Put back when the session ends.`),
        h("div", { class: "seg", style: "grid-template-columns:1fr 1fr" }, segA, segB), why,
        h("div", { class: "row", style: "gap:12px" }, down, up), nums, readout, numbers);
      return () => {
        const w = rig.dialDisabledReason;
        segA.classList.toggle("on", rig.dialMode === "live"); segB.classList.toggle("on", rig.dialMode === "active");
        set(why, w ?? ""); why.hidden = !w;
        (down as HTMLButtonElement).disabled = !!w; (up as HTMLButtonElement).disabled = !!w;
        set(nums, `Starting target: ${rig.dialStart !== null ? rig.dialStart + "°F" : "---"}\nTest target: ${rig.dialCurrent !== null ? rig.dialCurrent + "°F" : "---"}\nLive temp: ${rig.liveTempF !== null && rig.liveTempF !== undefined ? rig.liveTempF + "°F" : "---"}`);
        nums.style.whiteSpace = "pre-line";
        set(readout, rig.dialReadout);
        set(numbers, rig.dialNumbers); numbers.hidden = !rig.dialNumbers;
      };
    });
  }

  function openRaw() {
    page("RAW STATUS", body => {
      const conn = h("div", { class: "panel pad stackS" });
      const live = h("div", { class: "panel pad" });
      const extra = h("div", { class: "panel pad" });
      const info = h("div", { class: "panel pad" });
      body.append(tag("CONNECTION", "font-size:9.5px"), conn, tag("LIVE STATUS", "font-size:9.5px"), live, extra, info,
        h("p", { class: "mono dim", style: "font-size:10px" }, "Web Bluetooth only sees the services the app asks for, so the full service list from the iPhone app isn't shown here."));
      const kv = (k: string, v: string) => h("div", { class: "kv" }, h("span", {}, k), h("b", {}, v));
      return () => {
        const disc = h("button", { class: "btn2 danger", onclick: () => rig.askDisconnect() }, rig.disconnectWaiting ? "Disconnect now" : "Disconnect");
        conn.replaceChildren(h("b", { class: "cond", style: "font-size:22px" }, ble.connectionText),
          ble.peripheralName ? h("div", { class: "mono", style: "font-size:11px" }, `${ble.peripheralName}\n${ble.peripheralID}`) : "",
          linked() ? disc : "",
          rig.disconnectWaiting ? h("p", { class: "mono sub", style: "font-size:11px;margin:0" }, "Dab's still going. It finishes first, then the app lets go of the rig.") : "");
        const s = ble.status;
        if (ble.statusTime !== lastStatusTime) { lastStatusTime = ble.statusTime; seenAt = new Date(); }
        if (!s) live.replaceChildren(h("p", { class: "dim", style: "margin:0" }, "No status frame yet."));
        else {
          const temp = s.unitByte === 15 ? `${s.tempRaw} F` : s.unitByte === 12 ? `${s.tempRaw} C` : `${s.tempRaw} (unit byte ${s.unitByte})`;
          live.replaceChildren(h("b", { class: "cond", style: "font-size:44px" }, temp),
            kv("Session", sessionOnOf(s) ? "ON" : `off (byte ${s.sessionByte})`), kv("Active preset", String(s.preset)),
            kv("Light mode", String(s.lightMode)), kv("Time remaining", String(s.sessionTimeRemaining)),
            kv("Battery", `${s.battery}%`), kv("Charging", chargingOf(s) ? "yes" : `no (byte ${s.chargingByte})`),
            kv("Haptics", hapticsOf(s) ? "on" : `off (byte ${s.hapticsByte})`), kv("Brightness", String(s.brightness)),
            kv("Unit", unitText(s)), kv("Auto shut-off / remaining", `${s.autoShutOff} / ${s.autoShutOffRemaining}`),
            kv("Session extend", String(s.sessionExtend)),
            ble.statusTime !== null ? h("p", { class: "mono dim", style: "font-size:11px" }, "Updated " + seenAt.toLocaleTimeString()) : "");
        }
        const ex = Object.keys(ble.extra).sort();
        extra.hidden = !ex.length;
        extra.replaceChildren(tag("OTHER DECODED FRAMES", "font-size:9.5px"), ...ex.map(k => h("div", { class: "kv" }, h("span", {}, k), h("b", { class: "mono" }, ble.extra[k]))));
        const di = Object.keys(ble.deviceInfo).sort();
        info.hidden = !di.length;
        info.replaceChildren(tag("DEVICE INFO", "font-size:9.5px"), ...di.map(k => kv(k, ble.deviceInfo[k])));
      };
    });
  }

  return { render, openLook };
}
