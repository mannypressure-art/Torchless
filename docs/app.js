"use strict";
(() => {
  // src/rig/clock.ts
  var DISTANT_PAST = -Infinity;
  var RealClock = class {
    now() {
      return performance.now() / 1e3;
    }
    after(seconds, fn) {
      const id = setTimeout(fn, Math.max(0, seconds * 1e3));
      return () => clearTimeout(id);
    }
    wallMs() {
      return Date.now();
    }
  };

  // src/rig/storage.ts
  var LocalStore = class {
    constructor(prefix = "presh.") {
      this.prefix = prefix;
    }
    get(key) {
      try {
        const v = localStorage.getItem(this.prefix + key);
        return v === null ? null : JSON.parse(v);
      } catch {
        return null;
      }
    }
    set(key, value) {
      try {
        localStorage.setItem(this.prefix + key, JSON.stringify(value));
      } catch {
      }
    }
    remove(key) {
      try {
        localStorage.removeItem(this.prefix + key);
      } catch {
      }
    }
  };

  // src/rig/central.ts
  var Props = { read: 2, writeWithoutResponse: 4, write: 8, notify: 16, indicate: 32 };

  // src/rig/frames.ts
  var hapticsOf = (s) => s.hapticsByte === 170;
  var chargingOf = (s) => s.chargingByte === 170;
  var hex2 = (n) => n.toString(16).toUpperCase().padStart(2, "0");
  var hexString = (b) => Array.from(b, hex2).join(" ");
  function u16(b, i) {
    return i + 1 < b.length ? b[i] << 8 | b[i + 1] : null;
  }
  function u32(b, i) {
    if (i + 3 >= b.length) return null;
    let v = 0;
    for (let k = 0; k < 4; k++) v = v * 256 + b[i + k];
    return v;
  }
  function ascii(b, from, to) {
    if (from >= b.length) return "";
    const end = Math.min(to, b.length - 1);
    if (from > end) return "";
    return String.fromCharCode(...b.slice(from, end + 1).filter((c) => c >= 32 && c < 127));
  }
  function decodeFrame(b) {
    if (b.length === 0) return { kind: "unknown", why: "empty frame" };
    const cmd = b[0];
    switch (cmd) {
      case 169: {
        const temp = u16(b, 10);
        if (b.length < 19 || temp === null) return { kind: "unknown", why: `short 0xA9 status frame (${b.length} bytes)` };
        return {
          kind: "status",
          status: {
            preset: b[3],
            lightMode: b[6],
            sessionByte: b[7],
            autoShutOff: b[8],
            autoShutOffRemaining: b[9],
            tempRaw: temp,
            unitByte: b[12],
            sessionTimeRemaining: b[13],
            hapticsByte: b[14],
            sessionExtend: b[15],
            battery: b[16],
            chargingByte: b[17],
            brightness: b[18]
          }
        };
      }
      case 195: {
        const last = b.length > 2 && b[2] === 71 ? 10 : 9;
        const text = ascii(b, 2, last);
        return { kind: "info", key: "Firmware (0xC3)", value: text === "" ? "(empty)" : text };
      }
      case 196:
        return { kind: "info", key: "Version 2 (0xC4)", value: ascii(b, 2, 9) };
      case 163: {
        const f = u16(b, 3), c = u16(b, 5);
        if (b.length < 7 || f === null || c === null) return { kind: "unknown", why: `short 0xA3 frame (${b.length} bytes)` };
        return { kind: "info", key: `Preset ${b[2]} temp (0xA3)`, value: `${f} F / ${c} C` };
      }
      case 165:
        if (b.length < 4) return { kind: "unknown", why: `short 0xA5 frame (${b.length} bytes)` };
        return { kind: "info", key: `Preset ${b[2]} profile (0xA5)`, value: `0x${hex2(b[3])}` };
      case 167: {
        const sec = u16(b, 3);
        if (b.length < 5 || sec === null) return { kind: "unknown", why: `short 0xA7 frame (${b.length} bytes)` };
        return { kind: "info", key: `Preset ${b[2]} hold time (0xA7)`, value: `${sec} s` };
      }
      case 162:
        return decodeAnalytics(b);
      case 161: {
        const year = u16(b, 2);
        if (b.length < 8 || year === null) return { kind: "unknown", why: `short 0xA1 frame (${b.length} bytes)` };
        return { kind: "info", key: "Rig clock (0xA1)", value: `${year}-${b[4]}-${b[5]} ${b[6]}:${b[7]} UTC` };
      }
      case 170:
      case 171:
        if (b.length < 3) return { kind: "unknown", why: `short custom-curve frame (${b.length} bytes)` };
        return { kind: "info", key: `Preset ${b[2]} custom curve part ${cmd === 170 ? 1 : 2}`, value: hexString(b) };
      case 225:
        if (b.length < 6) return { kind: "unknown", why: `short 0xE1 frame (${b.length} bytes)` };
        return { kind: "info", key: "Status flags (0xE1)", value: `device ${b[2]}, battery ${b[3]}, board ${b[4]}, chamber ${b[5]}` };
      case 241:
        if (b.length < 4) return { kind: "unknown", why: `short 0xF1 frame (${b.length} bytes)` };
        return { kind: "info", key: "Cleaning assist (0xF1)", value: `state byte ${b[2]}, seconds left ${b[3]}` };
      default:
        return { kind: "unknown", why: `unknown frame, first byte 0x${hex2(cmd)}` };
    }
  }
  function decodeAnalytics(b) {
    if (b.length < 2) return { kind: "unknown", why: "short 0xA2 frame" };
    const variant = b[1];
    switch (variant) {
      case 20: {
        if (b.length < 18) return { kind: "unknown", why: `short 0xA2 (len 20) frame (${b.length} bytes)` };
        const v = (i) => u16(b, i) ?? 0;
        const text = `fav temp ${v(2)}F/${v(4)}C, heat cycles ${v(6)}, most in a day ${v(8)}, charge cycles ${v(10)}, fav profile ${b[12]}, fav light ${b[13]}, total time ${v(14)}, resets ${v(16)}`;
        return { kind: "info", key: "Analytics (0xA2)", value: text };
      }
      case 7: {
        const t = u32(b, 2);
        if (t === null) return { kind: "unknown", why: "short 0xA2 (len 7) frame" };
        return { kind: "info", key: "Analytics total time (0xA2/7)", value: `${t}` };
      }
      case 11: {
        const t = u32(b, 2), o = u32(b, 6);
        if (t === null || o === null) return { kind: "unknown", why: "short 0xA2 (len 11) frame" };
        return { kind: "info", key: "Analytics time (0xA2/11)", value: `total ${t}, operation ${o}` };
      }
      case 13: {
        const counts = [];
        for (let k = 0; k < 5; k++) {
          const v = u16(b, 2 + k * 2);
          if (v !== null) counts.push(String(v));
        }
        return { kind: "info", key: "Analytics profile cycles (0xA2/13)", value: counts.join(", ") };
      }
      default:
        return { kind: "info", key: `Analytics (0xA2, variant ${variant})`, value: "raw: " + hexString(b) };
    }
  }

  // src/rig/ble-manager.ts
  function normUUID(u) {
    const s = u.toLowerCase();
    if (s.length === 4) return `0000${s}-0000-1000-8000-00805f9b34fb`;
    if (s.length === 8) return `${s}-0000-1000-8000-00805f9b34fb`;
    return s;
  }
  var KnownUUID = {
    fee7: "0000fee7-0000-1000-8000-00805f9b34fb",
    fec1: "0000fec1-0000-1000-8000-00805f9b34fb",
    fec2: "0000fec2-0000-1000-8000-00805f9b34fb",
    primary: "f56598fa-3ffa-41a7-9726-3fc69baeca1d",
    primaryRead: "744c98ff-83c6-45d5-bd0c-52a50589215b",
    primaryWrite: "2c759c29-a73c-45ab-a799-31d6a032f6af",
    battery: "00002a19-0000-1000-8000-00805f9b34fb"
  };
  var readOnConnect = {
    "00002a24-0000-1000-8000-00805f9b34fb": "Model number (2A24)",
    "00002a25-0000-1000-8000-00805f9b34fb": "Serial number (2A25)",
    "00002a27-0000-1000-8000-00805f9b34fb": "Hardware revision (2A27)",
    "00002a28-0000-1000-8000-00805f9b34fb": "Software revision (2A28)",
    "00002a29-0000-1000-8000-00805f9b34fb": "Manufacturer (2A29)",
    [KnownUUID.battery]: "Battery (2A19)"
  };
  var labels = {
    [KnownUUID.fee7]: "FEE7 service",
    [KnownUUID.fec1]: "FEC1 (write on FEE7)",
    [KnownUUID.fec2]: "FEC2 (notify on FEE7)",
    [KnownUUID.primary]: "Primary service",
    [KnownUUID.primaryRead]: "Primary notify",
    [KnownUUID.primaryWrite]: "Primary write"
  };
  var writeTargetIDs = [KnownUUID.fec1, KnownUUID.primaryWrite];
  function propsText(p) {
    const parts = [];
    if (p & Props.read) parts.push("read");
    if (p & Props.write) parts.push("write");
    if (p & Props.writeWithoutResponse) parts.push("writeWithoutResponse");
    if (p & Props.notify) parts.push("notify");
    if (p & Props.indicate) parts.push("indicate");
    return parts.length === 0 ? "(none of the listed)" : parts.join(", ");
  }
  var BLEManager = class {
    constructor(central2, clock2) {
      this.central = central2;
      this.clock = clock2;
      // Bluetooth / scanning
      this.btMessage = null;
      this.btReady = false;
      this.isScanning = false;
      this.showAll = false;
      this.devices = [];
      // Connection
      this.connectionText = "Not connected";
      this.isConnected = false;
      this.reconnecting = false;
      this.peripheralName = "";
      this.peripheralID = "";
      // Discovered GATT + data
      this.services = [];
      this.deviceInfo = {};
      this.status = null;
      this.statusTime = null;
      this.extra = {};
      this.writeTargets = [];
      this.logLines = [];
      this.rig = null;
      /** Called after any change, so a screen can redraw. */
      this.onChange = null;
      this.peripheral = null;
      this.charactersByUUID = /* @__PURE__ */ new Map();
      this.clockSyncSent = false;
      this.linkIntent = "idle";
      this.reconnectToken = 0;
      this.reconnectDeadline = DISTANT_PAST;
      this.inBackground = false;
      this.lostToBluetoothOff = false;
      /** How long to keep trying to get the rig back after the link drops by itself. */
      this.linkLostWindow = 180;
      this.lastRX = /* @__PURE__ */ new Map();
      this.logCap = 2e4;
      this.droppedLogLines = 0;
      central2.delegate = this;
    }
    changed() {
      this.onChange?.();
    }
    // MARK: Logging
    stamp() {
      const d = new Date(this.clock.wallMs());
      const p = (n, w = 2) => String(n).padStart(w, "0");
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
    }
    log(text) {
      this.logLines.push(`[${this.stamp()}] ${text}`);
      if (this.logLines.length > this.logCap + 2e3) {
        const extra = this.logLines.length - this.logCap;
        this.logLines.splice(0, extra);
        this.droppedLogLines += extra;
      }
      this.changed();
    }
    exportText(appVersion = "web") {
      let h = "Presh log\n";
      h += `App version: ${appVersion}
`;
      h += `Browser: ${typeof navigator !== "undefined" ? navigator.userAgent : "bench"}
`;
      h += `Peripheral name: ${this.peripheralName || "(none)"}
`;
      h += `Peripheral identifier: ${this.peripheralID || "(none)"}
`;
      h += `Exported: ${new Date(this.clock.wallMs()).toISOString()}
`;
      if (this.droppedLogLines > 0) h += `Older lines dropped to save memory: ${this.droppedLogLines}
`;
      h += "Note: a status frame that repeats unchanged is logged once, then counted.\n";
      h += "----------------------------------------\n";
      return h + this.logLines.join("\n") + "\n";
    }
    /** A frame identical to the last one of its kind is counted instead of logged again (shown once every 10 s). */
    logRX(source, bytes) {
      let key = source + ":" + String(bytes[0] ?? 0);
      if (bytes.length > 2 && [163, 165, 167, 170, 171].includes(bytes[0])) key += ":" + String(bytes[2]);
      const now = this.clock.now();
      const m = this.lastRX.get(key);
      if (m) {
        if (m.bytes.length === bytes.length && m.bytes.every((v, i) => v === bytes[i])) {
          if (now - m.loggedAt < 10) {
            m.skipped += 1;
            return;
          }
          this.log(`RX ${source}: ${hexString(bytes)}  [unchanged, ${m.skipped} repeats not shown]`);
          this.lastRX.set(key, { bytes, loggedAt: now, skipped: 0 });
          return;
        }
        if (m.skipped > 0) this.log(`RX ${source}: [previous frame repeated ${m.skipped} more times]`);
      }
      this.log(`RX ${source}: ${hexString(bytes)}`);
      this.lastRX.set(key, { bytes, loggedAt: now, skipped: 0 });
    }
    // MARK: Scanning
    startScan() {
      if (this.central.state !== "poweredOn") {
        this.log("Cannot scan: Bluetooth is not ready.");
        return;
      }
      this.central.stopScan();
      this.central.scanForPeripherals(this.showAll ? null : ["FEE7", KnownUUID.primary]);
      this.isScanning = true;
      if (!this.isConnected && !this.reconnecting) this.connectionText = "Scanning";
      this.log(this.showAll ? "Scan started (all nearby devices)." : "Scan started (FEE7 or f56598fa service).");
    }
    stopScan() {
      if (!this.isScanning) return;
      this.central.stopScan();
      this.isScanning = false;
      if (!this.isConnected && this.connectionText === "Scanning") this.connectionText = "Not connected";
      this.log("Scan stopped.");
    }
    // MARK: Connecting
    connect(d) {
      this.stopScan();
      const old = this.peripheral;
      if (old && old === d.peripheral && this.isConnected) {
        this.log(`Already connected to ${d.name}.`);
        return;
      }
      if (old && old !== d.peripheral) this.central.cancelPeripheralConnection(old);
      if (this.isConnected) {
        this.isConnected = false;
        this.rig?.connectionChanged(false);
      }
      this.reconnectToken += 1;
      this.reconnecting = false;
      this.resetDeviceState();
      this.linkIntent = "wanted";
      this.peripheral = d.peripheral;
      this.peripheralName = d.name;
      this.peripheralID = d.id;
      d.peripheral.delegate = this;
      this.connectionText = `Connecting to ${d.name}`;
      this.log(`Connecting to ${d.name} (${d.id})`);
      this.central.connect(d.peripheral);
    }
    /** The user asked to disconnect (or to stop trying to reconnect). No automatic reconnect after this. */
    disconnect() {
      const p = this.peripheral;
      if (!p) return;
      this.log("Disconnect requested by user.");
      this.linkIntent = "userDropped";
      this.reconnectToken += 1;
      const wasUp = this.isConnected;
      this.reconnecting = false;
      this.central.cancelPeripheralConnection(p);
      if (!wasUp) this.connectionText = "Not connected";
      this.changed();
    }
    /** Lets go of the rig while the app sits idle in the background. Reconnects when the app is opened again. */
    parkForBackground() {
      const p = this.peripheral;
      if (!p || !this.isConnected || !this.inBackground) return;
      this.log("Letting go of the rig while the app is in the background.");
      this.linkIntent = "parked";
      this.central.cancelPeripheralConnection(p);
    }
    appMovedToBackground() {
      this.inBackground = true;
      if (this.isScanning) this.stopScan();
    }
    appBecameActive() {
      this.inBackground = false;
      if (this.linkIntent === "parked" && this.peripheral && !this.isConnected) {
        this.log("Back in the app. Getting the rig back.");
        this.beginReconnect(30, "Getting the rig back...");
      }
    }
    beginReconnect(window2, text) {
      const old = this.peripheral;
      if (this.central.state !== "poweredOn" || !old) return;
      const p = this.central.retrievePeripherals([old.identifier])[0] ?? old;
      p.delegate = this;
      this.peripheral = p;
      this.linkIntent = "wanted";
      this.reconnectToken += 1;
      const tok = this.reconnectToken;
      this.reconnecting = true;
      this.reconnectDeadline = this.clock.now() + window2;
      this.connectionText = text;
      this.services = [];
      this.writeTargets = [];
      this.charactersByUUID.clear();
      this.clockSyncSent = false;
      this.central.connect(p);
      this.clock.after(window2, () => {
        if (this.reconnectToken !== tok || !this.reconnecting || this.isConnected) return;
        this.reconnecting = false;
        this.linkIntent = "idle";
        this.central.cancelPeripheralConnection(p);
        this.connectionText = "Not connected. Couldn't get the rig back.";
        this.log(`Gave up getting the rig back after ${Math.trunc(window2)} s. Use Scan to connect again.`);
      });
    }
    retryReconnectSoon() {
      const tok = this.reconnectToken;
      this.clock.after(1, () => {
        const p = this.peripheral;
        if (this.reconnectToken !== tok || !this.reconnecting || this.isConnected || this.linkIntent !== "wanted" || !p) return;
        this.central.connect(p);
      });
    }
    resetDeviceState() {
      this.services = [];
      this.deviceInfo = {};
      this.status = null;
      this.statusTime = null;
      this.extra = {};
      this.writeTargets = [];
      this.charactersByUUID.clear();
      this.clockSyncSent = false;
      this.lastRX.clear();
    }
    // MARK: Control writes (everything goes through here)
    get fec1Ready() {
      const ch = this.charactersByUUID.get(KnownUUID.fec1);
      if (!this.isConnected || !this.peripheral || !ch) return false;
      return (ch.properties & Props.writeWithoutResponse) !== 0;
    }
    /** Writes one frame to FEC1 without response and logs it in hex with a label. */
    transmit(frame, label) {
      const p = this.peripheral;
      const ch = this.charactersByUUID.get(KnownUUID.fec1);
      if (!p || !this.isConnected || !ch || (ch.properties & Props.writeWithoutResponse) === 0) {
        this.log(`TX refused [${label}]: not connected or FEC1 not available.`);
        return false;
      }
      const busy = !p.canSendWriteWithoutResponse;
      p.writeValue(frame, ch, false);
      this.log(`TX (without response) to FEC1 [${label}]: ${hexString(frame)}${busy ? "  [phone Bluetooth buffer was busy]" : ""}`);
      return true;
    }
    /** The clock-sync frame the official app sends right after subscribing, in UTC. */
    sendClockSync() {
      const d = new Date(this.clock.wallMs());
      const year = d.getUTCFullYear();
      const frame = [177, 9, year >> 8 & 255, year & 255, d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), 177];
      if (this.transmit(frame, "Clock sync (UTC)")) this.clockSyncSent = true;
    }
    handleFrame(source, bytes) {
      this.logRX(source, bytes);
      const d = decodeFrame(bytes);
      if (d.kind === "status") {
        this.status = d.status;
        this.statusTime = this.clock.now();
      } else if (d.kind === "info") {
        this.extra[d.key] = d.value;
      } else {
        this.extra["Last unknown frame"] = `${d.why}: ${hexString(bytes)}`;
      }
      if (source === KnownUUID.fec2) this.rig?.handle(bytes);
    }
    /** Bluetooth was switched off or is otherwise gone. Mark the link down here. */
    bluetoothWentAway() {
      this.isScanning = false;
      if (!this.isConnected && !this.reconnecting) return;
      this.lostToBluetoothOff = this.linkIntent === "wanted";
      this.isConnected = false;
      this.reconnecting = false;
      this.reconnectToken += 1;
      this.charactersByUUID.clear();
      this.clockSyncSent = false;
      this.connectionText = "Disconnected: Bluetooth is off";
      this.rig?.connectionChanged(false);
      this.log("Bluetooth went away. Link dropped.");
    }
    // MARK: Central delegate
    centralDidUpdateState(c) {
      switch (c.state) {
        case "poweredOn":
          this.btReady = true;
          this.btMessage = null;
          this.log("Bluetooth is on.");
          if (this.lostToBluetoothOff) {
            this.lostToBluetoothOff = false;
            if (this.linkIntent === "wanted" && this.peripheral) {
              this.log("Bluetooth is back. Getting the rig back.");
              this.beginReconnect(60, "Bluetooth is back. Getting the rig...");
            }
          }
          break;
        case "poweredOff":
          this.btReady = false;
          this.btMessage = "Bluetooth is turned off. Turn it on, then come back.";
          this.log("Bluetooth is off.");
          this.bluetoothWentAway();
          break;
        case "unauthorized":
          this.btReady = false;
          this.btMessage = "This browser is not allowed to use Bluetooth. Allow it in the browser's settings for this site.";
          this.log("Bluetooth permission denied.");
          this.bluetoothWentAway();
          break;
        case "unsupported":
          this.btReady = false;
          this.btMessage = "This browser can't use Bluetooth. On iPhone, open Presh in Bluefy. On Android or a computer, use Chrome.";
          this.log("Bluetooth unsupported.");
          this.bluetoothWentAway();
          break;
        case "resetting":
          this.btReady = false;
          this.btMessage = "Bluetooth is resetting. Give it a moment.";
          this.log("Bluetooth resetting.");
          this.bluetoothWentAway();
          break;
        default:
          this.btReady = false;
          this.btMessage = "Checking Bluetooth...";
      }
      this.changed();
    }
    didDiscover(_c, p, adv, rssi) {
      const name = p.name ?? adv.localName ?? "(no name)";
      const uuids = (adv.serviceUUIDs ?? []).map(normUUID);
      if (rssi === 127) return;
      const idx = this.devices.findIndex((d) => d.id === p.identifier);
      if (idx >= 0) {
        const old = this.devices[idx];
        const newServices = [...old.services];
        for (const u of uuids) if (!newServices.includes(u)) newServices.push(u);
        const newName = name === "(no name)" && old.name !== "(no name)" ? old.name : name;
        if (Math.abs(old.rssi - rssi) >= 3 || newServices.length !== old.services.length || newName !== old.name) {
          this.devices[idx] = { ...old, rssi, services: newServices, name: newName };
        }
      } else {
        this.devices.push({ id: p.identifier, name, rssi, services: uuids, peripheral: p });
        this.log(`Found ${name} RSSI ${rssi} services ${uuids.length === 0 ? "(none advertised)" : uuids.join(", ")}`);
      }
      this.changed();
    }
    didConnect(c, p) {
      if (p !== this.peripheral || this.linkIntent !== "wanted") {
        this.log("A connection came up that is no longer wanted. Closing it.");
        c.cancelPeripheralConnection(p);
        return;
      }
      if (this.reconnecting && this.clock.now() > this.reconnectDeadline + 2) {
        this.reconnecting = false;
        this.reconnectToken += 1;
        this.linkIntent = "idle";
        this.connectionText = "Not connected. Couldn't get the rig back.";
        this.log("The rig came back too late (after the wait ran out). Not connecting. Use Scan to connect again.");
        c.cancelPeripheralConnection(p);
        return;
      }
      if (this.reconnecting) this.log("Got the rig back.");
      this.reconnecting = false;
      this.reconnectToken += 1;
      this.isConnected = true;
      this.connectionText = `Connected to ${this.peripheralName}`;
      this.rig?.connectionChanged(true);
      this.log("Connected. Discovering all services.");
      p.discoverServices();
    }
    didFailToConnect(_c, p, error) {
      if (p !== this.peripheral) return;
      const reason = error?.localizedDescription ?? "no reason given";
      if (this.reconnecting && this.linkIntent === "wanted" && this.clock.now() < this.reconnectDeadline) {
        this.log(`Reconnect attempt failed (${reason}). Trying again.`);
        this.retryReconnectSoon();
        return;
      }
      this.isConnected = false;
      this.reconnecting = false;
      this.linkIntent = "idle";
      this.connectionText = `Disconnected: could not connect (${reason})`;
      this.rig?.connectionChanged(false);
      this.log(`Failed to connect: ${reason}`);
    }
    didDisconnect(_c, p, error) {
      if (p !== this.peripheral) {
        this.log("An older connection closed. Ignored.");
        return;
      }
      const wasUp = this.isConnected;
      this.isConnected = false;
      this.charactersByUUID.clear();
      this.clockSyncSent = false;
      const reason = error?.localizedDescription ?? "disconnected normally";
      this.rig?.connectionChanged(false);
      switch (this.linkIntent) {
        case "userDropped":
          this.connectionText = "Disconnected";
          this.log("Disconnected (you asked).");
          break;
        case "parked":
          if (this.inBackground) {
            this.connectionText = "Resting. Reconnects when you open the app.";
            this.log("Let go of the rig (app in the background).");
          } else {
            this.beginReconnect(30, "Getting the rig back...");
          }
          break;
        case "idle":
          if (this.connectionText.startsWith("Connected") || this.connectionText.startsWith("Connecting")) {
            this.connectionText = `Disconnected: ${reason}`;
          }
          this.log(`Disconnected: ${reason}`);
          break;
        case "wanted":
          if (wasUp) {
            this.log(`Link lost: ${reason}. Trying to get the rig back for up to ${Math.trunc(this.linkLostWindow)} s.`);
            this.beginReconnect(this.linkLostWindow, "Lost the rig. Getting it back...");
          } else if (this.reconnecting && this.clock.now() < this.reconnectDeadline) {
            this.log(`Reconnect attempt dropped (${reason}). Trying again.`);
            this.retryReconnectSoon();
          } else {
            this.reconnecting = false;
            this.connectionText = `Disconnected: ${reason}`;
            this.log(`Disconnected: ${reason}`);
          }
          break;
      }
    }
    // MARK: Peripheral delegate
    didDiscoverServices(p, error) {
      if (p !== this.peripheral) return;
      if (error) {
        this.log(`Service discovery error: ${error.localizedDescription}`);
        return;
      }
      const list = p.services ?? [];
      this.log(`Found ${list.length} service(s).`);
      this.services = [];
      for (const s of list) {
        const id = normUUID(s.uuid);
        this.log(`SERVICE ${id}${labels[id] ? ` (${labels[id]})` : ""}`);
        this.services.push({ uuid: id, label: labels[id] ?? null, chars: [] });
        p.discoverCharacteristics(s);
      }
    }
    didDiscoverCharacteristics(p, service, error) {
      if (p !== this.peripheral) return;
      const sid = normUUID(service.uuid);
      if (error) {
        this.log(`Characteristic discovery error for ${sid}: ${error.localizedDescription}`);
        return;
      }
      const infos = [];
      for (const ch of service.characteristics ?? []) {
        const cid = normUUID(ch.uuid);
        const props = propsText(ch.properties);
        infos.push({ uuid: cid, props, label: labels[cid] ?? null });
        this.charactersByUUID.set(cid, ch);
        this.log(`  CHAR ${cid} [${props}] in service ${sid}`);
        if (ch.properties & Props.read && readOnConnect[cid] !== void 0) p.readValue(ch);
        if (ch.properties & (Props.notify | Props.indicate)) {
          p.setNotifyValue(true, ch);
          this.log(`  Subscribing to ${cid}`);
        }
      }
      const idx = this.services.findIndex((s) => s.uuid === sid);
      if (idx >= 0) this.services[idx].chars = infos;
      const targets = [];
      for (const tid of writeTargetIDs) {
        const ch = this.charactersByUUID.get(tid);
        if (ch && ch.properties & (Props.writeWithoutResponse | Props.write)) targets.push({ id: tid, label: labels[tid] ?? tid });
      }
      this.writeTargets = targets;
    }
    didUpdateNotificationState(p, ch, error) {
      if (p !== this.peripheral) return;
      const cid = normUUID(ch.uuid);
      if (error) {
        this.log(`Notify state error on ${cid}: ${error.localizedDescription}`);
      } else {
        this.log(`Notify on ${cid}: ${ch.isNotifying ? "ON" : "OFF"}`);
        if (cid === KnownUUID.fec2 && ch.isNotifying && !this.clockSyncSent) this.sendClockSync();
      }
    }
    didUpdateValue(p, ch, error) {
      if (p !== this.peripheral) return;
      const cid = normUUID(ch.uuid);
      if (error) {
        this.log(`Read/notify error on ${cid}: ${error.localizedDescription}`);
        return;
      }
      const bytes = ch.value;
      if (!bytes) return;
      const label = readOnConnect[cid];
      if (label !== void 0) {
        if (cid === KnownUUID.battery) {
          const level = bytes.length > 0 ? `${bytes[0]}%` : "?";
          this.deviceInfo[label] = level;
          this.log(`READ ${label}: ${level}  raw ${hexString(bytes)}`);
        } else {
          const text = String.fromCharCode(...bytes.filter((c) => c >= 32 && c < 127));
          this.deviceInfo[label] = text;
          this.log(`READ ${label}: "${text}"  raw ${hexString(bytes)}`);
        }
        return;
      }
      this.handleFrame(cid, [...bytes]);
    }
  };

  // src/rig/rig-controller.ts
  var LightModes = {
    basic: [{ id: 0, name: "Stealth" }, { id: 1, name: "Calm" }],
    solid: [
      { id: 2, name: "Purple" },
      { id: 3, name: "Blue" },
      { id: 4, name: "Cyan" },
      { id: 5, name: "Green" },
      { id: 6, name: "Yellow" },
      { id: 7, name: "Orange" },
      { id: 8, name: "Red" },
      { id: 9, name: "Pink" }
    ],
    themes: [
      { id: 10, name: "Cali Sunset" },
      { id: 11, name: "Purple Haze" },
      { id: 12, name: "Northern Lights" },
      { id: 13, name: "Vegas Nights" },
      { id: 14, name: "Blue Dream" },
      { id: 15, name: "Strawberry Cough" },
      { id: 16, name: "Florida Groves" },
      { id: 17, name: "Lime Light" },
      { id: 24, name: "Blue Cheese" },
      { id: 25, name: "Golden Goat" },
      { id: 26, name: "Grape Ape" },
      { id: 27, name: "Miami Vice" },
      { id: 28, name: "Purple Urkle" }
    ],
    seasonal: [
      { id: 29, name: "Candy Corn" },
      { id: 30, name: "Redrum" },
      { id: 31, name: "Skull & Bones" },
      { id: 32, name: "Witches Brew" },
      { id: 33, name: "Jack-O-Lantern" }
    ],
    get all() {
      return [...this.basic, ...this.solid, ...this.themes, ...this.seasonal];
    },
    /** Modes this app offers (18 to 23 have no name and are never offered). */
    isOffered(m) {
      return this.all.some((x) => x.id === m);
    },
    name(m) {
      return this.all.find((x) => x.id === m)?.name ?? `Mode ${m}`;
    }
  };
  var HeatProfile = {
    /** Custom (241) is deliberately not writable. */
    writable: [
      { id: 161, name: "Steady" },
      { id: 177, name: "Ascent" },
      { id: 193, name: "Descent" },
      { id: 209, name: "Valley" },
      { id: 225, name: "Hill" }
    ],
    isWritable(b) {
      return this.writable.some((x) => x.id === b);
    },
    name(b) {
      if (b === 241) return "Custom";
      return this.writable.find((x) => x.id === b)?.name ?? `Unknown (${b})`;
    }
  };
  var inRange = (v, lo, hi) => v >= lo && v <= hi;
  var RigLimits = {
    tempF: [250, 650],
    tempC: [121, 343],
    hold: [10, 90],
    brightness: [0, 100],
    extend: [0, 9],
    maxTotalHold: 90,
    celsius(f) {
      return swiftRound((f - 32) * 5 / 9);
    }
  };
  function swiftRound(x) {
    return x < 0 ? -Math.round(-x) : Math.round(x);
  }
  var RigFrames = {
    /** The ONLY place a 0xB9 frame is assembled. Session byte (index 10):
     *  start -> 170, stop -> 0, echo -> 170 only if the latest status showed a session running, else 0. */
    b9(f, session, liveSessionByte) {
      const values = [f.preset, f.lightMode, f.autoShutOff, f.unitByte, f.extend, f.brightness];
      if (!values.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) return null;
      if (session !== "stop") {
        if (!(inRange(f.preset, 0, 5) && inRange(f.lightMode, 0, 33) && inRange(f.brightness, 0, 100) && inRange(f.extend, 0, 9) && inRange(f.autoShutOff, 0, 60) && (f.unitByte === 15 || f.unitByte === 12))) return null;
      }
      const sessionByte = session === "start" ? 170 : session === "stop" ? 0 : liveSessionByte > 0 ? 170 : 0;
      return [
        185,
        20,
        0,
        f.preset,
        0,
        0,
        f.lightMode,
        0,
        f.autoShutOff,
        f.unitByte,
        sessionByte,
        f.haptics ? 170 : 0,
        f.extend,
        f.brightness,
        0,
        0,
        0,
        0,
        0,
        185
      ];
    }
  };
  var stepSeq = 0;
  var newStepID = () => `step-${Date.now().toString(36)}-${(stepSeq++).toString(36)}`;
  function defaultShow() {
    return {
      steps: [
        { id: newStepID(), atStart: true, secondsRemaining: 0, lightMode: 3, brightness: 70 },
        { id: newStepID(), atStart: false, secondsRemaining: 30, lightMode: 10, brightness: 80 },
        { id: newStepID(), atStart: false, secondsRemaining: 10, lightMode: 8, brightness: 100 }
      ],
      flashEnabled: true,
      flashSeconds: 10,
      flashHigh: 100,
      flashLow: 20
    };
  }
  var clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  function sanitizeShow(s) {
    return {
      steps: s.steps.slice(0, 6).map((st) => ({
        id: st.id || newStepID(),
        atStart: !!st.atStart,
        secondsRemaining: clamp(st.secondsRemaining, 5, 90),
        brightness: clamp(st.brightness, 0, 100),
        lightMode: LightModes.isOffered(st.lightMode) ? st.lightMode : 3
      })),
      flashEnabled: !!s.flashEnabled,
      flashSeconds: clamp(s.flashSeconds, 5, 30),
      flashHigh: clamp(s.flashHigh, 0, 100),
      flashLow: clamp(s.flashLow, 0, 100)
    };
  }
  var emptyPresets = () => Array.from({ length: 6 }, () => ({}));
  var _RigController = class _RigController {
    constructor(clock2, store) {
      this.clock = clock2;
      this.store = store;
      this.ble = null;
      this.onChange = null;
      // Live data
      this.live = null;
      this.liveTime = null;
      this.linkFresh = false;
      this.presets = emptyPresets();
      this.message = null;
      this.startPendingAt = null;
      this.previewing = false;
      this.flashing = false;
      // Away handling. The rule: never cut the dab that is running. Once it finishes, make sure heat is off.
      this.awayNote = null;
      this.disconnectWaiting = false;
      this.dialMode = "live";
      this.dialStart = null;
      this.dialCurrent = null;
      this.dialReadout = "No nudge yet";
      this.dialNumbers = "";
      // Timings (plain fields so the bench can shorten them)
      this.parkAfterQuiet = 60;
      this.stuckAfterZero = 8;
      this.maxAwaySession = 300;
      // Queue
      this.queue = [];
      this.pumping = false;
      this.gen = 0;
      this.lastSend = DISTANT_PAST;
      this.holdUntil = DISTANT_PAST;
      this.waitingForStatus = false;
      this.carry = null;
      this.stopPendingAt = null;
      this.stopRetryToken = 0;
      this.brightnessDebounce = null;
      this.messageToken = 0;
      // Watching for heat that came back on by accident
      this.lastStartSentAt = DISTANT_PAST;
      this.lastEchoOnAt = DISTANT_PAST;
      this.lastEchoOnRemaining = 0;
      this.lastEchoOnExtend = 0;
      this.lastEchoOnCounting = false;
      this.lastExtendSentAt = DISTANT_PAST;
      // Away private state
      this.inBackground = false;
      this.linkLostAt = null;
      this.zeroSince = null;
      this.lastAwayCutAt = DISTANT_PAST;
      this.quietSince = null;
      // Ride-the-dial private state
      this.dialStartPreset = 0;
      this.dialLastTap = DISTANT_PAST;
      this.dialTouched = /* @__PURE__ */ new Set();
      this.dialRestoreQueued = /* @__PURE__ */ new Set();
      this.dialSamples = [];
      this.dialNudgeAt = null;
      this.dialNudgeBase = 0;
      this.dialNudgeDir = 1;
      this.dialNudgeTarget = 0;
      this.dialBeforeSlope = 0;
      this.dialWatchUntil = DISTANT_PAST;
      this.dialLastB3 = -1;
      this._dialPending = /* @__PURE__ */ new Map();
      // Session tracking
      this.prevOn = false;
      this.sessionStartDate = null;
      this.sessionPeakF = 0;
      this.countdownSeen = false;
      this.peakRemaining = 0;
      this.counting = false;
      // Light show state
      this.preSession = null;
      this.restoreTarget = null;
      this._pendingRestore = null;
      this.restoreQueued = false;
      this.lastRestoreTryAt = DISTANT_PAST;
      this.restoreSentAt = DISTANT_PAST;
      this.showRan = false;
      this.appliedStepID = null;
      this.flashHighPhase = false;
      this.flashTicks = 0;
      this.previewToken = 0;
      const saved = store.get("lightShowV1");
      this._show = saved ? sanitizeShow(saved) : defaultShow();
      this._showEnabled = store.get("lightShowEnabled") === true;
      const dp = store.get("dialPendingV1");
      if (dp && typeof dp === "object") {
        const loaded = /* @__PURE__ */ new Map();
        for (const [k, v] of Object.entries(dp)) {
          const slot = Number(k);
          if (Number.isInteger(slot) && inRange(slot, 0, 5) && Number.isInteger(v) && inRange(v, 0, 65535)) loaded.set(slot, v);
        }
        this.dialPending = loaded;
      }
      const lr = store.get("lightRestoreV1");
      if (Array.isArray(lr) && lr.length === 2 && inRange(lr[0], 0, 33) && inRange(lr[1], 0, 100)) {
        this.pendingRestore = { mode: lr[0], brightness: lr[1] };
      }
      this.watchdog();
    }
    // Persisted properties
    get show() {
      return this._show;
    }
    set show(s) {
      this._show = s;
      this.store.set("lightShowV1", s);
      this.changed();
    }
    get showEnabled() {
      return this._showEnabled;
    }
    set showEnabled(v) {
      this._showEnabled = v;
      this.store.set("lightShowEnabled", v);
      if (!v) this.stopFlash();
      this.changed();
    }
    get dialPending() {
      return this._dialPending;
    }
    set dialPending(m) {
      this._dialPending = m;
      this.saveDialPending();
    }
    saveDialPending() {
      const out = {};
      for (const [k, v] of this._dialPending) out[String(k)] = v;
      this.store.set("dialPendingV1", out);
    }
    get pendingRestore() {
      return this._pendingRestore;
    }
    set pendingRestore(r) {
      this._pendingRestore = r;
      if (r) this.store.set("lightRestoreV1", [r.mode, r.brightness]);
      else this.store.remove("lightRestoreV1");
    }
    attach(b) {
      this.ble = b;
      b.rig = this;
    }
    changed() {
      this.onChange?.();
    }
    log(t) {
      this.ble?.log(t);
    }
    now() {
      return this.clock.now();
    }
    say(t) {
      this.message = t;
      this.log(`NOTICE: ${t}`);
      this.messageToken += 1;
      const tok = this.messageToken;
      this.clock.after(6, () => {
        if (this.messageToken !== tok) return;
        this.message = null;
        this.changed();
      });
    }
    watchdog() {
      this.clock.after(1, () => {
        this.watchdogTick();
        this.watchdog();
      });
    }
    watchdogTick() {
      const now = this.now();
      const fresh = this.liveTime !== null ? now - this.liveTime <= 3 : false;
      if (this.linkFresh !== fresh) {
        this.linkFresh = fresh;
        this.changed();
      }
      if (this.startPendingAt !== null && now - this.startPendingAt > 3) this.startPendingAt = null;
      if (this.waitingForStatus && this.queue.length > 0 && this.liveTime !== null && now - this.liveTime > 1) {
        this.waitingForStatus = false;
        this.pump();
      }
      const quiet = this.connected && !this.sessionOn && this.startPendingAt === null && this.queue.length === 0 && !this.pumping && !this.previewing;
      if (!quiet) {
        this.quietSince = null;
        return;
      }
      if (this.quietSince === null) this.quietSince = now;
      const quietFor = now - this.quietSince;
      if (this.disconnectWaiting && quietFor >= 2) {
        this.disconnectWaiting = false;
        this.log("Dab is done and everything is put back. Disconnecting now, as asked.");
        this.ble?.disconnect();
      } else if (this.inBackground && quietFor >= this.parkAfterQuiet) {
        this.quietSince = null;
        this.log("APP: left idle in the background. Letting go of the rig until you come back.");
        this.ble?.parkForBackground();
      }
    }
    // MARK: Derived
    get connected() {
      return this.ble?.isConnected ?? false;
    }
    get sessionOn() {
      return (this.live?.sessionByte ?? 0) > 0;
    }
    get canControl() {
      return this.connected && this.linkFresh && this.live !== null;
    }
    get canHeat() {
      return this.canControl && !this.sessionOn && this.startPendingAt === null && !this.previewing;
    }
    get canPreview() {
      return this.canControl && !this.sessionOn && !this.previewing && this.startPendingAt === null;
    }
    get heldHoldSeconds() {
      const s = this.live;
      if (!s || !inRange(s.preset, 0, 5)) return void 0;
      return this.presets[s.preset].hold;
    }
    get canExtend() {
      const s = this.live;
      const hold = this.heldHoldSeconds;
      if (!this.canControl || !s || s.sessionByte <= 0 || hold === void 0) return false;
      if (this.countdownSeen && s.sessionTimeRemaining <= 3) return false;
      const n = s.sessionExtend + 1;
      return n <= RigLimits.extend[1] && hold + 10 * n <= RigLimits.maxTotalHold;
    }
    get linkRecovering() {
      return this.linkLostAt !== null && this.now() - this.linkLostAt < 600;
    }
    /** Nobody is at the controls: app in the background, link just recovered, or a disconnect is waiting. */
    get away() {
      return this.inBackground || this.disconnectWaiting || this.linkRecovering;
    }
    // MARK: Incoming frames
    u16(b, i) {
      return i + 1 < b.length ? b[i] << 8 | b[i + 1] : null;
    }
    handle(b) {
      if (b.length === 0) return;
      const cmd = b[0];
      switch (cmd) {
        case 169: {
          const d = decodeFrame(b);
          if (d.kind === "status") this.onLive(d.status);
          break;
        }
        case 163: {
          const f = this.u16(b, 3), c = this.u16(b, 5);
          if (b.length >= 7 && b[2] <= 5 && f !== null && c !== null) {
            this.presets[b[2]].tempF = f;
            this.presets[b[2]].tempC = c;
            if (this.now() < this.dialWatchUntil || this.dialTouched.size > 0) {
              this.log(`DIAL TEST 163 report: slot ${b[2]} = ${f} F / ${c} C`);
            }
          }
          break;
        }
        case 165:
          if (b.length >= 4 && b[2] <= 5) this.presets[b[2]].profile = b[3];
          break;
        case 167: {
          const sec = this.u16(b, 3);
          if (b.length >= 5 && b[2] <= 5 && sec !== null) this.presets[b[2]].hold = sec;
          break;
        }
        case 170:
          if (b.length >= 3 && b[2] <= 5) this.presets[b[2]].custom170 = b;
          break;
        case 171:
          if (b.length >= 3 && b[2] <= 5) this.presets[b[2]].custom171 = b;
          break;
      }
      this.changed();
    }
    connectionChanged(isUp) {
      if (isUp) {
        this.presets = emptyPresets();
        this.changed();
        return;
      }
      const wasHeating2 = this.prevOn || this.startPendingAt !== null;
      if (this.prevOn && this.sessionStartDate !== null) {
        this.log(`SESSION END duration=${(this.now() - this.sessionStartDate).toFixed(0)} peak=${this.sessionPeakF} (link lost)`);
      }
      if (wasHeating2) {
        this.linkLostAt = this.now();
        this.log("AWAY: lost the rig mid-dab. The rig finishes the dab on its own timer. When the link is back, the app makes sure heat is off.");
      }
      this.sessionStartDate = null;
      if (this.dialPending.size > 0) {
        this.log(`DIAL TEST: link lost with changed temps still to put back (slots [${[...this.dialPending.keys()].sort((a, b) => a - b).join(", ")}]). Will restore when a status shows no session.`);
      }
      const r = this.pendingRestore;
      if (r) this.log(`Lights still to put back (mode ${r.mode}, brightness ${r.brightness}). Will do it when a status shows no session.`);
      this.dialStart = null;
      this.dialCurrent = null;
      this.dialTouched.clear();
      this.dialRestoreQueued.clear();
      this.dialNudgeAt = null;
      this.dialSamples = [];
      this.dialReadout = "No nudge yet";
      this.dialNumbers = "";
      this.gen += 1;
      this.queue = [];
      this.pumping = false;
      this.waitingForStatus = false;
      this.stopRetryToken += 1;
      this.brightnessDebounce?.();
      this.stopFlash();
      this.restoreQueued = false;
      this.live = null;
      this.liveTime = null;
      this.linkFresh = false;
      this.prevOn = false;
      this.countdownSeen = false;
      this.counting = false;
      this.peakRemaining = 0;
      this.zeroSince = null;
      this.carry = null;
      this.startPendingAt = null;
      this.stopPendingAt = null;
      this.previewing = false;
      this.previewToken += 1;
      this.disconnectWaiting = false;
      this.quietSince = null;
      this.changed();
    }
    onLive(s) {
      const now = this.now();
      const wasOn = this.prevOn;
      const on = s.sessionByte > 0;
      this.live = s;
      this.liveTime = now;
      if (!this.linkFresh) this.linkFresh = true;
      if (on) this.startPendingAt = null;
      if (!on) {
        this.stopPendingAt = null;
        this.stopRetryToken += 1;
      }
      let accident = null;
      if (on && !wasOn && now - this.lastEchoOnAt < 1.5 && now - this.lastStartSentAt > 5) {
        accident = "a session started right after a light or time change, with no HEAT IT tap";
      }
      if (on && wasOn && this.lastEchoOnCounting && now - this.lastEchoOnAt < 1.2 && now - this.lastExtendSentAt > 3 && s.sessionExtend === this.lastEchoOnExtend && s.sessionTimeRemaining >= this.lastEchoOnRemaining + 3) {
        accident = `the countdown jumped back up (${this.lastEchoOnRemaining} s to ${s.sessionTimeRemaining} s) right after a light change`;
      }
      if (on && !wasOn) this.sessionBegan();
      if (!on && wasOn) this.sessionEnded();
      this.prevOn = on;
      if (on) {
        if (s.sessionTimeRemaining > 0) this.countdownSeen = true;
        if (s.sessionTimeRemaining > this.peakRemaining) this.peakRemaining = s.sessionTimeRemaining;
        if (s.sessionTimeRemaining < this.peakRemaining) this.counting = true;
        this.curveTick(s);
        if (accident !== null) {
          this.safetyCut(accident);
        } else {
          this.dialTick(s);
          this.showTick(s);
          this.awayTick(s, now);
        }
      } else {
        this.countdownSeen = false;
        this.counting = false;
        this.peakRemaining = 0;
        this.zeroSince = null;
        if (this.pendingRestore === null && now - this.restoreSentAt > 1) {
          this.preSession = { mode: s.lightMode, brightness: s.brightness };
        }
        this.idleTick(now);
      }
      if (this.waitingForStatus) {
        this.waitingForStatus = false;
        this.pump();
      }
      this.changed();
    }
    idleTick(now) {
      this.tryOwedRestore(now);
      this.dialRestorePending();
      if (this.linkLostAt !== null) {
        const recent = this.linkRecovering;
        this.linkLostAt = null;
        if (recent) this.confirmOff("the link dropped mid-dab and is back now, with nothing heating");
      }
    }
    // MARK: Gate
    gate(allowStale = false, quiet = false) {
      let problem = null;
      let result = null;
      const b = this.ble;
      if (b && b.isConnected) {
        if (b.fec1Ready) {
          if (this.live && this.liveTime !== null) {
            if (!allowStale && this.now() - this.liveTime > 3) {
              problem = "Status from the rig is older than 3 seconds. Wait for it to come back.";
            } else {
              result = this.live;
            }
          } else {
            problem = "No status from the rig yet. Wait a second.";
          }
        } else {
          problem = "The rig's control channel (FEC1) was not found.";
        }
      } else {
        problem = "Not connected to the rig.";
      }
      if (problem !== null) {
        if (quiet) this.log(`Not sent: ${problem}`);
        else this.say(problem);
      }
      return result;
    }
    // MARK: Queue
    item(p) {
      return {
        gapBefore: 0.12,
        requireSessionOn: false,
        requireSessionOff: false,
        deferredSince: null,
        auto: false,
        born: this.now(),
        ...p
      };
    }
    enqueue(item) {
      if (this.gate(false, item.auto) === null) {
        item.onDrop?.();
        return;
      }
      this.queue.push(item);
      this.pump();
    }
    pump() {
      if (this.pumping || this.queue.length === 0) return;
      const first = this.queue[0];
      this.pumping = true;
      const g = this.gen;
      const since = this.now() - this.lastSend;
      const hold = this.holdUntil - this.now();
      const wait = Math.max(0, Math.max(first.gapBefore - since, hold));
      this.clock.after(wait, () => {
        if (this.gen !== g) return;
        this.pumping = false;
        if (this.queue.length === 0) return;
        const item = this.queue.shift();
        const result = this.fire(item);
        if (result === "deferred") {
          if (item.deferredSince === null) item.deferredSince = this.now();
          this.queue.unshift(item);
          if (this.waitingForStatus) return;
          this.holdUntil = this.now() + 0.25;
        }
        this.pump();
        this.changed();
      });
    }
    isStopItem(it) {
      return it.kind.t === "b9" && it.kind.intent === "stop";
    }
    isStartItem(it) {
      return it.kind.t === "b9" && it.kind.intent === "start";
    }
    effectiveFields(s) {
      if (this.carry && this.now() - this.carry.time < 1.5) return { ...this.carry.fields };
      return {
        preset: s.preset,
        lightMode: s.lightMode,
        autoShutOff: s.autoShutOff,
        unitByte: s.unitByte,
        haptics: hapticsOf(s),
        extend: s.sessionExtend,
        brightness: s.brightness
      };
    }
    fire(item) {
      const isStop = this.isStopItem(item);
      const s = this.gate(isStop, item.auto);
      if (s === null) {
        item.onDrop?.();
        return "dropped";
      }
      if (item.requireSessionOn && s.sessionByte === 0) {
        this.log(`Dropped [${item.label}]: session is not on.`);
        item.onDrop?.();
        return "dropped";
      }
      if (item.requireSessionOff && s.sessionByte > 0) {
        if (item.auto) this.log(`Dropped [${item.label}]: the rig is heating.`);
        else this.say("That only works when the rig is not heating.");
        item.onDrop?.();
        return "dropped";
      }
      if (this.isStartItem(item) && this.now() - item.born > 5) {
        this.say("HEAT IT waited too long behind other changes. Tap it again.");
        item.onDrop?.();
        return "dropped";
      }
      if (item.deferredSince !== null && this.now() - item.deferredSince > 5) {
        this.log(`Dropped [${item.label}]: waited over 5 s for the rig's status to settle.`);
        item.onDrop?.();
        return "dropped";
      }
      if (item.kind.t === "b9" && item.kind.intent === "echo" && s.sessionByte > 0) {
        if (this.countdownSeen && s.sessionTimeRemaining <= 3) {
          if (item.requireSessionOn) {
            if (item.auto) this.log(`Dropped [${item.label}]: session is in its last 3 seconds.`);
            else this.say("Too late for that: the dab is in its last 3 seconds.");
            item.onDrop?.();
            return "dropped";
          }
          return "deferred";
        }
        if (this.liveTime !== null && this.now() - this.liveTime > 0.2) {
          this.waitingForStatus = true;
          return "deferred";
        }
      }
      if (!isStop && !this.isStartItem(item)) {
        if (this.startPendingAt !== null && this.now() - this.startPendingAt < 3 && s.sessionByte === 0) return "deferred";
        if (this.stopPendingAt !== null && this.now() - this.stopPendingAt < 3 && s.sessionByte > 0) return "deferred";
      }
      if (item.kind.t === "raw") {
        if (this.ble?.transmit(item.kind.bytes, item.label) !== true) {
          item.onDrop?.();
          return "dropped";
        }
        this.lastSend = this.now();
        item.onSent?.();
        return "sent";
      }
      const { change, intent } = item.kind;
      const f = this.effectiveFields(s);
      if (change.preset !== void 0) f.preset = change.preset;
      if (change.lightMode !== void 0) f.lightMode = change.lightMode;
      if (change.brightness !== void 0) f.brightness = change.brightness;
      if (change.haptics !== void 0) f.haptics = change.haptics;
      if (change.extendPlusOne) {
        const n = f.extend + 1;
        const hold = this.presets[clamp(f.preset, 0, 5)].hold;
        if (hold === void 0 || n > RigLimits.extend[1] || hold + 10 * n > RigLimits.maxTotalHold) {
          this.say("Can't add more time: hold plus extra can't go past 90 s.");
          item.onDrop?.();
          return "dropped";
        }
        f.extend = n;
      }
      if (intent === "start") {
        if (s.sessionByte !== 0) {
          this.say("Already heating.");
          item.onDrop?.();
          return "dropped";
        }
        if (!inRange(f.preset, 1, 5)) {
          this.say("Pick preset 1 to 5 first.");
          item.onDrop?.();
          return "dropped";
        }
      }
      const frame = RigFrames.b9(f, intent, s.sessionByte);
      if (frame === null) {
        this.say("Rig state looked odd (value out of range), so nothing was sent.");
        item.onDrop?.();
        return "dropped";
      }
      if (this.ble?.transmit(frame, item.label) !== true) {
        item.onDrop?.();
        return "dropped";
      }
      const now = this.now();
      this.lastSend = now;
      this.carry = { fields: f, time: now };
      if (intent === "start") {
        this.startPendingAt = now;
        this.stopPendingAt = null;
        this.lastStartSentAt = now;
      } else if (intent === "stop") {
        this.stopPendingAt = now;
        this.startPendingAt = null;
      } else if (s.sessionByte > 0) {
        this.lastEchoOnAt = now;
        this.lastEchoOnRemaining = s.sessionTimeRemaining;
        this.lastEchoOnExtend = f.extend;
        this.lastEchoOnCounting = this.counting;
        if (change.extendPlusOne) this.lastExtendSentAt = now;
      }
      item.onSent?.();
      return "sent";
    }
    // MARK: Actions: heat
    /** The ONLY call site that can send a session byte of 170 via start. */
    heatIt() {
      const s = this.gate();
      if (s === null) return;
      if (s.sessionByte !== 0) {
        this.say("Already heating.");
        return;
      }
      if (this.startPendingAt !== null) return;
      if (this.queue.some((it) => this.isStartItem(it))) return;
      if (this.previewing) {
        this.say("Wait for the light preview to finish.");
        return;
      }
      if (inRange(s.preset, 1, 5)) {
        const t = this.presets[s.preset].tempF;
        if (t !== void 0 && !inRange(t, RigLimits.tempF[0], RigLimits.tempF[1])) {
          this.say(`Preset ${s.preset} is set to ${t} F. This app only heats 250 to 650 F. Edit the preset first.`);
          return;
        }
      }
      this.log("HEAT IT tapped.");
      this.awayNote = null;
      this.enqueue(this.item({ label: "HEAT IT (start, session 170)", kind: { t: "b9", change: {}, intent: "start" }, requireSessionOff: true }));
    }
    /** CUT IT: drops everything waiting and sends Stop. */
    cutIt() {
      this.log("CUT IT tapped.");
      this.sendStop("CUT IT (stop, session 0)", true);
    }
    /** The ONLY place a Stop is created. A Stop jumps the queue, is never held back, and is resent if needed. */
    sendStop(label, clearQueue, attempt = 0) {
      if (clearQueue) {
        const dropped = this.queue;
        this.queue = [];
        for (const it2 of dropped) it2.onDrop?.();
        this.brightnessDebounce?.();
        this.stopFlash();
        this.previewToken += 1;
        this.previewing = false;
      }
      this.gen += 1;
      this.pumping = false;
      this.waitingForStatus = false;
      this.holdUntil = DISTANT_PAST;
      const heating = this.sessionOn;
      const shown = attempt === 0 ? label : `${label}, try ${attempt + 1}`;
      const it = this.item({ label: shown, kind: { t: "b9", change: {}, intent: "stop" }, gapBefore: 0.1 });
      it.onSent = () => {
        if (!heating || attempt >= 2) return;
        this.armStopRetry(label, attempt);
      };
      this.queue.unshift(it);
      this.pump();
    }
    armStopRetry(label, attempt) {
      this.stopRetryToken += 1;
      const tok = this.stopRetryToken;
      this.clock.after(1.5, () => {
        if (this.stopRetryToken !== tok) return;
        const s = this.live;
        if (!this.connected || !s || s.sessionByte <= 0) return;
        this.log("Stop did not take after 1.5 s (rig still shows heating). Sending it again.");
        this.sendStop(label, false, attempt + 1);
      });
    }
    safetyCut(why) {
      this.log(`SAFETY CUT: ${why}. Heat never starts on its own, so it is being cut.`);
      this.lastEchoOnAt = DISTANT_PAST;
      this.say("Heat came back on by itself. Cut it.");
      this.sendStop("SAFETY CUT (stop, session 0)", true);
    }
    extendTen() {
      const s = this.gate();
      if (s === null) return;
      if (s.sessionByte <= 0) {
        this.say("+10s only works while heating.");
        return;
      }
      if (this.heldHoldSeconds === void 0) {
        this.say("Can't add time: the rig hasn't reported this preset's hold time.");
        return;
      }
      if (this.countdownSeen && s.sessionTimeRemaining <= 3) {
        this.say("Too late for that: the dab is in its last 3 seconds.");
        return;
      }
      if (!this.canExtend) {
        this.say("Can't add more time: hold plus extra can't go past 90 s.");
        return;
      }
      this.enqueue(this.item({ label: "+10 s (session extend +1)", kind: { t: "b9", change: { extendPlusOne: true }, intent: "echo" }, requireSessionOn: true }));
    }
    // MARK: Away: leaving the app, losing the link, disconnecting mid-dab
    appMovedToBackground() {
      if (this.inBackground) return;
      this.inBackground = true;
      this.quietSince = null;
      this.ble?.appMovedToBackground();
      if (this.sessionOn || this.startPendingAt !== null) {
        this.log("APP: left the app mid-dab. Letting the dab finish. Heat gets confirmed off after.");
      } else {
        this.log("APP: left the app. Nothing heating.");
      }
    }
    appBecameActive() {
      if (!this.inBackground) return;
      this.inBackground = false;
      this.quietSince = null;
      this.log("APP: back in the app.");
      this.ble?.appBecameActive();
    }
    /** Disconnect button. Mid-dab the first tap waits for the dab to finish; a second tap drops the link now. */
    askDisconnect() {
      if (this.sessionOn && this.connected && this.linkFresh && !this.disconnectWaiting) {
        this.disconnectWaiting = true;
        this.log("Disconnect asked mid-dab. Letting the dab finish first, then disconnecting. A second tap disconnects right away.");
        this.changed();
        return;
      }
      if (this.disconnectWaiting) {
        this.log("Disconnect asked again. Dropping the link now. The rig finishes the dab on its own timer.");
      }
      this.disconnectWaiting = false;
      this.ble?.disconnect();
    }
    confirmOff(why) {
      this.log(`AWAY: ${why}. Sending one stop to make sure heat is off.`);
      this.awayNote = "Dab finished on its own. Heat confirmed off.";
      this.sendStop("SAFE OFF (stop, session 0)", false);
    }
    awayTick(s, now) {
      if (!this.away) {
        this.zeroSince = null;
        return;
      }
      if (this.countdownSeen && s.sessionTimeRemaining === 0) {
        if (this.zeroSince === null) this.zeroSince = now;
      } else {
        this.zeroSince = null;
      }
      let why = null;
      if (this.zeroSince !== null && now - this.zeroSince >= this.stuckAfterZero) {
        why = `the countdown finished ${Math.trunc(this.stuckAfterZero)} s ago but the rig still shows heating`;
      }
      if (this.sessionStartDate !== null && now - this.sessionStartDate >= this.maxAwaySession) {
        why = `this session has run over ${Math.trunc(this.maxAwaySession)} s`;
      }
      if (why === null || now - this.lastAwayCutAt < 5) return;
      this.lastAwayCutAt = now;
      this.log(`AWAY CUT: nobody is at the app and ${why}. Cutting heat.`);
      this.awayNote = "The dab was over but the rig was still heating, so the app cut it.";
      this.sendStop("AWAY CUT (stop, session 0)", true);
    }
    // MARK: Actions: presets
    selectPreset(n) {
      if (!inRange(n, 1, 5)) return;
      if (this.gate() === null) return;
      this.enqueue(this.item({ label: `Select preset ${n}`, kind: { t: "b9", change: { preset: n }, intent: "echo" }, requireSessionOff: true }));
    }
    savePreset(p, tempF, hold, profile) {
      if (!inRange(p, 1, 5)) {
        this.say("Preset must be 1 to 5.");
        return;
      }
      if (!inRange(tempF, RigLimits.tempF[0], RigLimits.tempF[1])) {
        this.say("Temperature must be 250 to 650 F.");
        return;
      }
      const c = RigLimits.celsius(tempF);
      if (!inRange(c, RigLimits.tempC[0], RigLimits.tempC[1])) {
        this.say("Temperature out of range.");
        return;
      }
      if (!inRange(hold, RigLimits.hold[0], RigLimits.hold[1])) {
        this.say("Hold time must be 10 to 90 seconds.");
        return;
      }
      const s = this.gate();
      if (s === null) return;
      if (s.sessionByte !== 0) {
        this.say("Can't edit presets while heating.");
        return;
      }
      const tempFrame = [179, 8, p, tempF >> 8, tempF & 255, c >> 8, c & 255, 179];
      const holdFrame = [183, 6, p, hold >> 8, hold & 255, 183];
      this.log(`Saving preset ${p}: ${tempF} F / ${c} C, hold ${hold} s, profile ${HeatProfile.name(profile)}.`);
      this.enqueue(this.item({
        label: `Preset ${p} temp ${tempF}F`,
        kind: { t: "raw", bytes: tempFrame },
        gapBefore: 0.12,
        requireSessionOff: true,
        onSent: () => {
          this.presets[p].tempF = tempF;
          this.presets[p].tempC = c;
        }
      }));
      this.enqueue(this.item({
        label: `Preset ${p} hold ${hold}s`,
        kind: { t: "raw", bytes: holdFrame },
        gapBefore: 1,
        requireSessionOff: true,
        onSent: () => {
          this.presets[p].hold = hold;
        }
      }));
      if (HeatProfile.isWritable(profile)) {
        const profFrame = [181, 5, p, profile, 181];
        this.enqueue(this.item({
          label: `Preset ${p} profile ${HeatProfile.name(profile)}`,
          kind: { t: "raw", bytes: profFrame },
          gapBefore: 1,
          requireSessionOff: true,
          onSent: () => {
            this.presets[p].profile = profile;
          }
        }));
      } else {
        this.log("Profile left unchanged (not a writable profile in this build).");
      }
    }
    // MARK: Actions: lights
    setLightMode(m) {
      if (!LightModes.isOffered(m)) {
        this.say("That light mode isn't available.");
        return;
      }
      this.enqueue(this.item({ label: `Light mode ${m} ${LightModes.name(m)}`, kind: { t: "b9", change: { lightMode: m }, intent: "echo" } }));
    }
    /** Slider-driven: waits 250 ms after the last change. */
    setBrightness(v) {
      const clamped = clamp(Math.round(v), RigLimits.brightness[0], RigLimits.brightness[1]);
      this.brightnessDebounce?.();
      this.brightnessDebounce = this.clock.after(0.25, () => {
        this.enqueue(this.item({ label: `Brightness ${clamped}`, kind: { t: "b9", change: { brightness: clamped }, intent: "echo" } }));
      });
    }
    setHaptics(on) {
      this.enqueue(this.item({ label: `Haptics ${on ? "on" : "off"}`, kind: { t: "b9", change: { haptics: on }, intent: "echo" } }));
    }
    enqueueLight(o) {
      const ch = {};
      if (o.mode !== null && inRange(o.mode, 0, 33)) ch.lightMode = o.mode;
      if (o.brightness !== null) ch.brightness = clamp(o.brightness, 0, 100);
      this.enqueue(this.item({
        label: o.label,
        kind: { t: "b9", change: ch, intent: "echo" },
        requireSessionOn: o.requireOn,
        requireSessionOff: o.requireOff ?? false,
        onSent: o.onSent,
        onDrop: o.onDrop,
        auto: true
      }));
    }
    tryOwedRestore(now) {
      const r = this.pendingRestore;
      if (!r || this.restoreQueued || this.previewing || now - this.lastRestoreTryAt < 2) return;
      this.lastRestoreTryAt = now;
      this.restoreQueued = true;
      this.log(`Restoring lights: mode ${r.mode}, brightness ${r.brightness}.`);
      this.enqueueLight({
        mode: r.mode,
        brightness: r.brightness,
        label: "Restore lights",
        requireOn: false,
        requireOff: true,
        onSent: () => {
          this.pendingRestore = null;
          this.restoreQueued = false;
          this.restoreSentAt = this.now();
        },
        onDrop: () => {
          this.restoreQueued = false;
        }
      });
    }
    // MARK: Curve logging and temperature helpers
    tempInF(s) {
      if (s.unitByte === 12) return swiftRound(s.tempRaw * 9 / 5 + 32);
      return s.tempRaw;
    }
    get liveTempF() {
      return this.live ? this.tempInF(this.live) : null;
    }
    curveTick(s) {
      if (this.sessionStartDate === null) return;
      const f = this.tempInF(s);
      if (f > this.sessionPeakF) this.sessionPeakF = f;
      const t = this.now() - this.sessionStartDate;
      this.log(`CURVE t=${t.toFixed(1)} temp=${f} remaining=${s.sessionTimeRemaining} preset=${s.preset}`);
    }
    // MARK: Ride the dial (test)
    b3Frame(slot, f) {
      const c = RigLimits.celsius(f);
      return [179, 8, slot, f >> 8, f & 255, c >> 8, c & 255, 179];
    }
    get dialDisabledReason() {
      if (!this.canControl) return "Connect to the rig first.";
      if (!this.sessionOn) return "Start a heat session with HEAT IT first. This only works while heating.";
      if (this.dialStart === null) return "Starting target unknown: the rig hasn't reported the active preset's temperature yet.";
      if (this.dialMode === "active") {
        const s = this.live;
        if (!s || !inRange(s.preset, 1, 5) || s.preset !== this.dialStartPreset) return "Active preset changed since the session began.";
      }
      return null;
    }
    dialNudge(delta) {
      if (Math.abs(delta) !== _RigController.dialStep) return;
      const s = this.gate();
      if (s === null) return;
      if (s.sessionByte <= 0) {
        this.say("Dial test only works while a session is running.");
        return;
      }
      const start = this.dialStart, cur = this.dialCurrent;
      if (start === null || cur === null) {
        this.say("Starting target unknown, so the dial test is off.");
        return;
      }
      if (this.now() - this.dialLastTap < 1) {
        this.say("Wait 1 second between nudges.");
        return;
      }
      const newT = cur + delta;
      if (!inRange(newT, RigLimits.tempF[0], RigLimits.tempF[1])) {
        this.say("Dial test stays between 250 and 650 F.");
        return;
      }
      if (Math.abs(newT - start) > 50) {
        this.say(`Dial test stays within 50 F of where it started (${start} F).`);
        return;
      }
      let slot = 0;
      if (this.dialMode === "active") {
        if (!inRange(s.preset, 1, 5) || s.preset !== this.dialStartPreset) {
          this.say("Active preset changed since the session began.");
          return;
        }
        slot = s.preset;
      }
      if (!this.dialTouched.has(slot)) {
        this.dialTouched.add(slot);
        const original = slot === 0 ? this.presets[0].tempF : start;
        if (original !== void 0) {
          this.dialPending.set(slot, original);
          this.saveDialPending();
          this.log(`DIAL TEST original for slot ${slot} = ${original} F. Will be put back when the session ends.`);
        } else {
          this.log("DIAL TEST original for slot 0 was unknown (no 163 report for slot 0 seen before the test). It will be left as is.");
        }
      }
      const label = `DIAL TEST nudge \u2192 target ${newT} (mode ${this.dialMode === "live" ? "A" : "B"})`;
      this.log(label);
      this.dialLastTap = this.now();
      this.dialCurrent = newT;
      const frame = this.b3Frame(slot, newT);
      this.enqueue(this.item({
        label,
        kind: { t: "raw", bytes: frame },
        gapBefore: 0.12,
        requireSessionOn: true,
        onSent: () => this.dialNudgeSent(newT, delta),
        onDrop: () => {
          this.dialCurrent = cur;
          this.log(`DIAL TEST nudge not sent; target stays ${cur} F.`);
        }
      }));
    }
    dialNudgeSent(newTarget, delta) {
      const now = this.now();
      const recent = this.dialSamples.filter((x) => now - x.time <= 4);
      let slope = 0;
      const a = recent[0], b = recent[recent.length - 1];
      if (a && b && b.time > a.time) slope = (b.f - a.f) / (b.time - a.time);
      this.dialBeforeSlope = slope;
      this.dialNudgeBase = this.dialSamples.length > 0 ? this.dialSamples[this.dialSamples.length - 1].f : this.liveTempF ?? 0;
      this.dialNudgeDir = delta > 0 ? 1 : -1;
      this.dialNudgeTarget = newTarget;
      this.dialNudgeAt = now;
      this.dialWatchUntil = now + 20;
      this.dialLastB3 = this.live?.preset ?? -1;
      this.dialReadout = "Temp moving toward new target: too early";
      this.dialNumbers = `At nudge ${this.dialNudgeBase} F, new target ${newTarget} F, slope before ${slope.toFixed(1)} F/s`;
      this.log(`DIAL TEST sent. Temp at nudge ${this.dialNudgeBase} F, slope before ${slope.toFixed(2)} F/s. Watching A9 b3 (now ${this.dialLastB3}).`);
    }
    dialTick(s) {
      const now = this.now();
      const f = this.tempInF(s);
      if (this.dialStart === null && inRange(s.preset, 1, 5)) {
        const t = this.presets[s.preset].tempF;
        if (t !== void 0) {
          this.dialStart = t;
          this.dialCurrent = t;
          this.dialStartPreset = s.preset;
          this.log(`DIAL TEST ready: starting target ${t} F (preset ${s.preset}).`);
        }
      }
      this.dialSamples.push({ time: now, f });
      this.dialSamples = this.dialSamples.filter((x) => now - x.time <= 12);
      if (now < this.dialWatchUntil && this.dialLastB3 >= 0 && s.preset !== this.dialLastB3) {
        this.log(`DIAL TEST A9 b3 changed ${this.dialLastB3} \u2192 ${s.preset}`);
        this.dialLastB3 = s.preset;
      }
      if (this.dialNudgeAt !== null) {
        const el = now - this.dialNudgeAt;
        const delta = f - this.dialNudgeBase;
        const toward = delta * this.dialNudgeDir;
        const sign = delta >= 0 ? "+" : "";
        const nums = `At nudge ${this.dialNudgeBase} F, now ${f} F (${sign}${delta} F in ${el.toFixed(1)} s), new target ${this.dialNudgeTarget} F, slope before ${this.dialBeforeSlope.toFixed(1)} F/s`;
        if (el < 6) {
          this.dialReadout = "Temp moving toward new target: too early";
          this.dialNumbers = nums;
        } else {
          const yes = toward >= Math.max(2, Math.trunc(_RigController.dialStep * 3 / 5));
          this.dialReadout = `Temp moving toward new target: ${yes ? "yes" : "no"}`;
          this.dialNumbers = nums;
          this.log(`DIAL TEST result after 6 s: ${yes ? "yes" : "no"}. ${nums}`);
          this.dialNudgeAt = null;
        }
      }
    }
    dialRestorePending() {
      if (this.dialPending.size === 0 || this.sessionOn) return;
      for (const slot of [...this.dialPending.keys()].sort((a, b) => a - b)) {
        const f = this.dialPending.get(slot);
        if (this.dialRestoreQueued.has(slot) || f === void 0) continue;
        this.dialRestoreQueued.add(slot);
        const frame = this.b3Frame(slot, f);
        const label = `DIAL TEST restore slot ${slot} to ${f} F`;
        this.log(label);
        this.enqueue(this.item({
          label,
          kind: { t: "raw", bytes: frame },
          gapBefore: 0.5,
          requireSessionOff: true,
          auto: true,
          onSent: () => {
            this.dialPending.delete(slot);
            this.saveDialPending();
            this.dialRestoreQueued.delete(slot);
            this.presets[slot].tempF = f;
            this.presets[slot].tempC = RigLimits.celsius(f);
            this.log(`DIAL TEST restore sent for slot ${slot}.`);
          },
          onDrop: () => {
            this.dialRestoreQueued.delete(slot);
          }
        }));
      }
    }
    // MARK: Session start and end
    sessionBegan() {
      this.sessionStartDate = this.now();
      this.sessionPeakF = 0;
      const s = this.live;
      if (s) {
        const p = inRange(s.preset, 0, 5) ? this.presets[s.preset] : {};
        const tgt = p.tempF !== void 0 ? String(p.tempF) : "?";
        const hold = p.hold !== void 0 ? String(p.hold) : "?";
        const prof = p.profile !== void 0 ? HeatProfile.name(p.profile) : "?";
        this.log(`SESSION START target=${tgt} hold=${hold} profile=${prof}`);
      } else {
        this.log("SESSION START target=? hold=? profile=?");
      }
      this.dialStart = null;
      this.dialCurrent = null;
      this.dialTouched.clear();
      this.dialNudgeAt = null;
      this.dialSamples = [];
      this.dialReadout = "No nudge yet";
      this.dialNumbers = "";
      this.countdownSeen = false;
      this.counting = false;
      this.peakRemaining = 0;
      this.zeroSince = null;
      this.showRan = false;
      this.appliedStepID = null;
      this.flashHighPhase = false;
      this.flashTicks = 0;
      this.stopFlash();
      this.restoreTarget = this.pendingRestore ?? this.preSession;
      const r = this.restoreTarget;
      if (r) this.log(`Session started. Lights before session: mode ${r.mode}, brightness ${r.brightness}.`);
      else this.log("Session already running when connected; no earlier light settings known to restore.");
    }
    sessionEnded() {
      if (this.sessionStartDate !== null) {
        this.log(`SESSION END duration=${(this.now() - this.sessionStartDate).toFixed(0)} peak=${this.sessionPeakF}`);
      }
      this.sessionStartDate = null;
      if (this.dialTouched.size > 0) this.log("DIAL TEST: session ended. Putting temps back.");
      this.dialStart = null;
      this.dialCurrent = null;
      this.dialTouched.clear();
      this.dialNudgeAt = null;
      this.dialSamples = [];
      this.stopFlash();
      this.queue = this.queue.filter((it) => !it.requireSessionOn);
      this.showRan = false;
      this.log("Session ended.");
      if (this.away) {
        const why = this.inBackground ? "the dab finished while the app was in the background" : this.disconnectWaiting ? "the dab finished and a disconnect is waiting" : "the dab finished after the link dropped and came back";
        this.linkLostAt = null;
        this.confirmOff(why);
      }
    }
    // MARK: Light show
    orderedSteps() {
      const starts = this.show.steps.filter((x) => x.atStart);
      const timed = this.show.steps.filter((x) => !x.atStart).sort((a, b) => b.secondsRemaining - a.secondsRemaining);
      return [...starts, ...timed];
    }
    markShowRan() {
      if (this.showRan) return;
      this.showRan = true;
      if (this.pendingRestore === null && this.restoreTarget) this.pendingRestore = this.restoreTarget;
    }
    showTick(s) {
      if (!this.showEnabled) {
        this.stopFlash();
        return;
      }
      const remaining = s.sessionTimeRemaining;
      const tail = this.countdownSeen && remaining <= 3;
      const sh = this.show;
      let target = null;
      for (const st of this.orderedSteps()) {
        if (st.atStart || this.counting && remaining <= st.secondsRemaining) target = st;
      }
      const wantFlash = sh.flashEnabled && this.counting && remaining > 3 && remaining <= sh.flashSeconds;
      if (wantFlash) {
        this.startFlash();
      } else if (this.flashing) {
        this.stopFlash();
        if (!tail) this.appliedStepID = null;
      }
      if (!tail && target && target.id !== this.appliedStepID) {
        this.appliedStepID = target.id;
        this.markShowRan();
        const br = this.flashing ? this.flashHighPhase ? sh.flashHigh : sh.flashLow : target.brightness;
        this.enqueueLight({
          mode: target.lightMode,
          brightness: br,
          label: `Show step: ${LightModes.name(target.lightMode)} @${br}`,
          requireOn: true,
          onDrop: () => {
            this.appliedStepID = null;
          }
        });
      }
      if (this.flashing && !tail) {
        this.flashTicks += 1;
        if (this.flashTicks % 2 === 0 && this.queue.length <= 2) {
          this.flashHighPhase = !this.flashHighPhase;
          const lvl = this.flashHighPhase ? sh.flashHigh : sh.flashLow;
          this.enqueueLight({ mode: null, brightness: lvl, label: `Flash brightness ${lvl}`, requireOn: true });
        }
      }
    }
    startFlash() {
      if (this.flashing) return;
      this.flashing = true;
      this.flashTicks = 0;
      this.markShowRan();
      this.log("Slow-down flash started.");
    }
    stopFlash() {
      if (this.flashing) this.log("Slow-down flash stopped.");
      this.flashing = false;
    }
    previewStep(st) {
      const s = this.gate();
      if (s === null) return;
      if (s.sessionByte !== 0) {
        this.say("Preview only works when the rig is not heating.");
        return;
      }
      if (this.startPendingAt !== null || this.previewing) return;
      if (this.pendingRestore !== null) {
        this.say("Hang on, putting the lights back first.");
        return;
      }
      if (!LightModes.isOffered(st.lightMode)) return;
      this.pendingRestore = { mode: s.lightMode, brightness: s.brightness };
      this.previewing = true;
      this.previewToken += 1;
      const tok = this.previewToken;
      this.log(`Preview step: ${LightModes.name(st.lightMode)} @${st.brightness} for 3 s.`);
      this.enqueueLight({
        mode: st.lightMode,
        brightness: st.brightness,
        label: "Preview step",
        requireOn: false,
        requireOff: true,
        onDrop: () => {
          if (this.previewToken !== tok) return;
          this.previewing = false;
          this.pendingRestore = null;
        }
      });
      this.clock.after(3, () => {
        if (this.previewToken !== tok || !this.previewing) return;
        this.previewing = false;
        this.changed();
      });
    }
  };
  // Ride-the-dial test state
  _RigController.dialStep = 5;
  var RigController = _RigController;

  // src/rig/web-central.ts
  var FEE7 = "0000fee7-0000-1000-8000-00805f9b34fb";
  var PRIMARY = "f56598fa-3ffa-41a7-9726-3fc69baeca1d";
  var OPTIONAL = [FEE7, PRIMARY, "0000180a-0000-1000-8000-00805f9b34fb", "0000180f-0000-1000-8000-00805f9b34fb"];
  var err = (e) => ({ localizedDescription: e instanceof Error ? e.message : String(e) });
  function shortUUID(u) {
    const m = u.toLowerCase().match(/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/);
    return m ? m[1].toUpperCase() : u.toLowerCase();
  }
  var WebChar = class {
    constructor(raw) {
      this.raw = raw;
      this.value = null;
      this.isNotifying = false;
      this.uuid = shortUUID(raw.uuid);
      const p = raw.properties;
      this.properties = (p.read ? Props.read : 0) | (p.write ? Props.write : 0) | (p.writeWithoutResponse ? Props.writeWithoutResponse : 0) | (p.notify ? Props.notify : 0) | (p.indicate ? Props.indicate : 0);
    }
  };
  var WebService = class {
    constructor(raw) {
      this.raw = raw;
      this.characteristics = null;
      this.uuid = shortUUID(raw.uuid);
    }
  };
  var WebPeripheral = class {
    constructor(device) {
      this.device = device;
      this.delegate = null;
      this.services = null;
      this.canSendWriteWithoutResponse = true;
      this.chain = Promise.resolve();
      /** Bumped on every connect and disconnect, so work from an older link is ignored. */
      this.linkGen = 0;
    }
    get identifier() {
      return this.device.id;
    }
    get name() {
      return this.device.name ?? null;
    }
    get gattConnected() {
      return !!this.device.gatt?.connected;
    }
    /** Runs GATT operations one at a time. Work queued for an older link is skipped. */
    op(fn, onError) {
      const gen = this.linkGen;
      this.chain = this.chain.then(async () => {
        if (gen !== this.linkGen || !this.gattConnected) return;
        try {
          await fn();
        } catch (e) {
          if (gen === this.linkGen) onError(e);
        }
      });
    }
    resetLink() {
      this.linkGen += 1;
      this.services = null;
      this.chain = Promise.resolve();
    }
    discoverServices() {
      this.op(async () => {
        const list = await this.device.gatt.getPrimaryServices();
        this.services = list.map((s) => new WebService(s));
        this.delegate?.didDiscoverServices(this, null);
      }, (e) => this.delegate?.didDiscoverServices(this, err(e)));
    }
    discoverCharacteristics(service) {
      const ws = service;
      this.op(async () => {
        const list = await ws.raw.getCharacteristics();
        ws.characteristics = list.map((c) => new WebChar(c));
        this.delegate?.didDiscoverCharacteristics(this, ws, null);
      }, (e) => this.delegate?.didDiscoverCharacteristics(this, ws, err(e)));
    }
    readValue(ch) {
      const wc = ch;
      this.op(async () => {
        const dv = await wc.raw.readValue();
        wc.value = Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
        this.delegate?.didUpdateValue(this, wc, null);
      }, (e) => this.delegate?.didUpdateValue(this, wc, err(e)));
    }
    setNotifyValue(on, ch) {
      const wc = ch;
      const gen = this.linkGen;
      this.op(async () => {
        if (on) {
          wc.raw.addEventListener("characteristicvaluechanged", (ev) => {
            if (gen !== this.linkGen) return;
            const dv = ev.target.value;
            wc.value = Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
            this.delegate?.didUpdateValue(this, wc, null);
          });
          await wc.raw.startNotifications();
        } else {
          await wc.raw.stopNotifications();
        }
        wc.isNotifying = on;
        this.delegate?.didUpdateNotificationState(this, wc, null);
      }, (e) => this.delegate?.didUpdateNotificationState(this, wc, err(e)));
    }
    writeValue(bytes, ch, withResponse) {
      const wc = ch;
      const data = new Uint8Array(bytes);
      this.op(async () => {
        if (!withResponse && typeof wc.raw.writeValueWithoutResponse === "function") await wc.raw.writeValueWithoutResponse(data);
        else if (typeof wc.raw.writeValueWithResponse === "function") await wc.raw.writeValueWithResponse(data);
        else await wc.raw.writeValue(data);
      }, (e) => console.warn("Presh: write failed", e));
    }
  };
  var WebCentral = class {
    constructor() {
      this.state = "unknown";
      this.delegate = null;
      /** Told when the chooser closes without a rig picked, with the browser's reason. */
      this.onChooserClosed = null;
      this.known = /* @__PURE__ */ new Map();
      this.wanted = /* @__PURE__ */ new Set();
      this.cancelled = /* @__PURE__ */ new Set();
      /** Links closed because a cancel came in while connecting: already reported, so stay quiet. */
      this.silent = /* @__PURE__ */ new Set();
      const bt = navigator.bluetooth;
      setTimeout(async () => {
        if (!bt || typeof bt.requestDevice !== "function") {
          this.setState("unsupported");
          return;
        }
        let on = true;
        try {
          if (typeof bt.getAvailability === "function") on = await bt.getAvailability();
        } catch {
          on = true;
        }
        this.setState(on ? "poweredOn" : "poweredOff");
        bt.addEventListener?.("availabilitychanged", (ev) => this.setState(ev.value ? "poweredOn" : "poweredOff"));
      }, 0);
    }
    setState(s) {
      if (s === this.state) return;
      if (s === "poweredOff") {
        for (const p of this.known.values()) {
          p.resetLink();
          this.wanted.delete(p);
        }
      }
      this.state = s;
      this.delegate?.centralDidUpdateState(this);
    }
    /** Opens the browser's chooser. Must run inside a tap. */
    scanForPeripherals(serviceUUIDs) {
      const bt = navigator.bluetooth;
      const options = serviceUUIDs === null ? { acceptAllDevices: true, optionalServices: OPTIONAL } : { filters: [{ services: [FEE7] }], optionalServices: OPTIONAL };
      bt.requestDevice(options).then((device) => {
        const p = this.wrap(device);
        this.delegate?.didDiscover(this, p, { localName: device.name ?? void 0, serviceUUIDs: ["FEE7"] }, -50);
      }).catch((e) => {
        this.onChooserClosed?.(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      });
    }
    stopScan() {
    }
    wrap(device) {
      let p = this.known.get(device.id);
      if (!p) {
        p = new WebPeripheral(device);
        this.known.set(device.id, p);
        const wp = p;
        device.addEventListener("gattserverdisconnected", () => this.onDropped(wp));
      }
      return p;
    }
    onDropped(p) {
      if (this.silent.delete(p)) {
        p.resetLink();
        return;
      }
      const wasCancelled = this.cancelled.delete(p);
      p.resetLink();
      for (const s of p.services ?? []) s.characteristics = null;
      this.delegate?.didDisconnect(this, p, wasCancelled ? null : { localizedDescription: "The connection was lost." });
    }
    connect(p) {
      const wp = p;
      this.wanted.add(wp);
      this.cancelled.delete(wp);
      wp.device.gatt.connect().then(() => {
        if (!this.wanted.has(wp)) {
          this.silent.add(wp);
          wp.device.gatt.disconnect();
          return;
        }
        this.wanted.delete(wp);
        wp.resetLink();
        this.delegate?.didConnect(this, wp);
      }).catch((e) => {
        if (!this.wanted.delete(wp)) return;
        this.delegate?.didFailToConnect(this, wp, err(e));
      });
    }
    cancelPeripheralConnection(p) {
      const wp = p;
      if (wp.gattConnected) {
        this.cancelled.add(wp);
        wp.device.gatt.disconnect();
      } else if (this.wanted.delete(wp)) {
        setTimeout(() => this.delegate?.didDisconnect(this, wp, null), 0);
      }
    }
    retrievePeripherals(identifiers) {
      return identifiers.map((id) => this.known.get(id)).filter((p) => !!p);
    }
  };

  // src/web/app.ts
  var BUILD = "app-4a.3";
  var clock = new RealClock();
  var central = new WebCentral();
  var ble = new BLEManager(central, clock);
  var rig = new RigController(clock, new LocalStore("presh."));
  rig.attach(ble);
  ble.log(`Torchless web ${BUILD} started. ${navigator.userAgent}`);
  var $ = (id) => document.getElementById(id);
  var prefs = {
    get(k) {
      try {
        return localStorage.getItem("torchless." + k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem("torchless." + k, v);
      } catch {
      }
    }
  };
  if (prefs.get("age21") === "yes") $("age").hidden = true;
  $("ageYes").onclick = () => {
    prefs.set("age21", "yes");
    $("age").hidden = true;
  };
  $("ageNo").onclick = () => {
    $("ageMsg").hidden = false;
  };
  function checkFsTip() {
    const hasBt2 = !!navigator.bluetooth;
    const barShowing = window.innerHeight < screen.height - 60;
    $("fsTip").hidden = !(hasBt2 && barShowing && prefs.get("fsTip") !== "done");
  }
  $("fsGotIt").onclick = () => {
    prefs.set("fsTip", "done");
    $("fsTip").hidden = true;
  };
  checkFsTip();
  window.addEventListener("resize", checkFsTip);
  function applyLook(v) {
    if (v === "dark" || v === "light") document.documentElement.dataset.theme = v;
    else delete document.documentElement.dataset.theme;
    document.querySelectorAll("[data-look]").forEach((b) => b.classList.toggle("on", b.dataset.look === v));
  }
  applyLook(prefs.get("look") ?? "auto");
  document.querySelectorAll("[data-look]").forEach((b) => {
    b.onclick = () => {
      prefs.set("look", b.dataset.look);
      applyLook(b.dataset.look);
    };
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") rig.appMovedToBackground();
    else rig.appBecameActive();
  });
  window.addEventListener("pagehide", () => rig.appMovedToBackground());
  window.addEventListener("pageshow", () => {
    if (document.visibilityState === "visible") rig.appBecameActive();
  });
  var wake = null;
  async function keepAwake(on) {
    const wl = navigator.wakeLock;
    if (!wl) return;
    try {
      if (on && !wake) wake = await wl.request("screen");
      if (!on && wake) {
        const w = wake;
        wake = null;
        await w.release();
      }
    } catch {
      wake = null;
    }
  }
  var tab = "home";
  function showTab(t) {
    tab = t;
    document.querySelectorAll("[data-panel]").forEach((el) => {
      el.hidden = el.dataset.panel !== t;
    });
    document.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
    window.scrollTo(0, 0);
    schedule();
  }
  document.querySelectorAll("[data-tab]").forEach((b) => {
    b.onclick = () => showTab(b.dataset.tab);
  });
  var connectAfterPick = false;
  function openChooser(all) {
    connectAfterPick = true;
    ble.devices = [];
    ble.showAll = all;
    ble.startScan();
  }
  $("linkIt").onclick = () => openChooser(false);
  var hasBt = !!navigator.bluetooth;
  if (!hasBt) {
    $("noBt").hidden = false;
    $("openBluefy").href = "bluefy://open?url=" + encodeURIComponent(location.href.split("#")[0]);
    $("linkIt").hidden = true;
    $("linkAll").hidden = true;
  }
  $("linkAll").onclick = () => openChooser(true);
  central.onChooserClosed = (why) => {
    ble.log(`Chooser closed without a rig: ${why}`);
    ble.stopScan();
    connectAfterPick = false;
    schedule();
  };
  $("heat").onclick = () => rig.heatIt();
  $("cut").onclick = () => rig.cutIt();
  $("extend").onclick = () => rig.extendTen();
  $("gotIt").onclick = () => {
    rig.awayNote = null;
    schedule();
  };
  for (let n = 1; n <= 5; n++) $(`p${n}`).onclick = () => rig.selectPreset(n);
  var profileSel = $("edProfile");
  for (const pr of HeatProfile.writable) {
    const o = document.createElement("option");
    o.value = String(pr.id);
    o.textContent = pr.name;
    profileSel.appendChild(o);
  }
  var editing = 0;
  var edTemp = $("edTemp");
  var edHold = $("edHold");
  edTemp.min = String(RigLimits.tempF[0]);
  edTemp.max = String(RigLimits.tempF[1]);
  edHold.min = String(RigLimits.hold[0]);
  edHold.max = String(RigLimits.hold[1]);
  function edLabels() {
    $("edTempV").textContent = `${edTemp.value}\xB0F`;
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
    profileSel.value = String(p.profile !== void 0 && (HeatProfile.isWritable(p.profile) || p.profile === 241) ? p.profile : 161);
    $("edProfileNote").hidden = p.profile !== 241;
    $("edTitle").textContent = `Preset ${n}`;
    edLabels();
    $("editor").hidden = false;
  };
  $("edCancel").onclick = () => {
    $("editor").hidden = true;
  };
  $("edSave").onclick = () => {
    rig.savePreset(editing, Number(edTemp.value), Number(edHold.value), Number(profileSel.value));
    $("editor").hidden = true;
  };
  document.querySelectorAll("[data-step]").forEach((b) => {
    b.onclick = () => {
      const input = b.dataset.step.startsWith("t") ? edTemp : edHold;
      const d = Number(b.dataset.step.slice(1));
      input.value = String(Math.min(Number(input.max), Math.max(Number(input.min), Number(input.value) + d)));
      edLabels();
    };
  });
  var LIGHT_COLORS = {
    2: "#9B5CFF",
    3: "#2F6BFF",
    4: "#19E3FF",
    5: "#34E07A",
    6: "#FFE14A",
    7: "#FF9A2F",
    8: "#FF3B3B",
    9: "#FF6FC8"
  };
  function orbStyle(m) {
    if (LIGHT_COLORS[m]) return `background:${LIGHT_COLORS[m]}`;
    if (m === 0) return "background:#20252B";
    if (m === 1) return "background:radial-gradient(circle at 40% 35%, #8fd9ff, #2a4a66)";
    return "background:conic-gradient(#3CF2D0, #19E3FF, #6A7BFF, #B66BFF, #3CF2D0)";
  }
  var groups = [
    ["Low key", LightModes.basic],
    ["Solid", LightModes.solid],
    ["Themes", LightModes.themes],
    ["Seasonal", LightModes.seasonal]
  ];
  var lightGrid = $("lightGrid");
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
      b.querySelector(".orbName").textContent = m.name;
      b.onclick = () => rig.setLightMode(m.id);
      g.appendChild(b);
    }
    lightGrid.appendChild(g);
  }
  var bright = $("bright");
  var brightTouchedAt = 0;
  bright.oninput = () => {
    brightTouchedAt = Date.now();
    $("brightV").textContent = `${bright.value}%`;
    rig.setBrightness(Number(bright.value));
  };
  $("showOn").onchange = (e) => {
    rig.showEnabled = e.target.checked;
  };
  $("disconnect").onclick = () => rig.askDisconnect();
  $("copyLog").onclick = async () => {
    try {
      await navigator.clipboard.writeText(ble.exportText(BUILD));
      $("copyLog").textContent = "Copied";
    } catch {
      $("copyLog").textContent = "Copy failed: use Save";
    }
    setTimeout(() => {
      $("copyLog").textContent = "Copy log";
    }, 2e3);
  };
  $("saveLog").onclick = () => {
    const blob = new Blob([ble.exportText(BUILD)], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const d = /* @__PURE__ */ new Date();
    a.download = `Torchless-log-${d.toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5e3);
  };
  $("build").textContent = BUILD;
  var SVGNS = "http://www.w3.org/2000/svg";
  var C = 130;
  var R = 122;
  var ang = (f) => (135 + 270 * f) * Math.PI / 180;
  var pt = (f, r) => [C + Math.cos(ang(f)) * r, C + Math.sin(ang(f)) * r];
  function arcPath(f0, f1, r) {
    const [x0, y0] = pt(f0, r);
    const [x1, y1] = pt(f1, r);
    const large = (f1 - f0) * 270 > 180 ? 1 : 0;
    return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }
  function buildGauge() {
    const svg = $("gauge");
    const ticks = document.createElementNS(SVGNS, "g");
    for (let i = 0; i <= 25; i++) {
      const f = i / 25;
      const major = i % 5 === 0;
      const [x0, y0] = pt(f, R * (major ? 0.84 : 0.885));
      const [x1, y1] = pt(f, R * 0.95);
      const l = document.createElementNS(SVGNS, "line");
      l.setAttribute("x1", x0.toFixed(2));
      l.setAttribute("y1", y0.toFixed(2));
      l.setAttribute("x2", x1.toFixed(2));
      l.setAttribute("y2", y1.toFixed(2));
      l.setAttribute("class", major ? "tickMajor" : "tickMinor");
      ticks.appendChild(l);
    }
    svg.insertBefore(ticks, svg.querySelector("#gArc"));
    for (let i = 0; i < 6; i++) {
      const [x, y] = pt(i / 5, R * 0.69);
      const t = document.createElementNS(SVGNS, "text");
      t.setAttribute("x", x.toFixed(1));
      t.setAttribute("y", (y + 4).toFixed(1));
      t.setAttribute("class", "gLabel");
      t.id = `gL${i}`;
      svg.insertBefore(t, svg.querySelector("#gNeedle"));
    }
  }
  buildGauge();
  var clamp01 = (v) => Math.min(Math.max(v, 0), 1);
  var clockText = (s) => {
    const v = Math.max(s, 0);
    return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
  };
  function setText(id, t) {
    const el = $(id);
    if (el.textContent !== t) el.textContent = t;
  }
  function enable(id, on) {
    $(id).disabled = !on;
  }
  function show(id, on) {
    const el = $(id);
    if (el.hidden === on) el.hidden = !on;
  }
  var queued = false;
  var wasHeating = false;
  function render() {
    queued = false;
    if (connectAfterPick && ble.devices.length > 0) {
      connectAfterPick = false;
      ble.connect(ble.devices[0]);
    }
    const s = rig.live;
    const linked = ble.isConnected;
    const heating = rig.sessionOn;
    if (heating !== wasHeating) {
      wasHeating = heating;
      void keepAwake(heating);
    }
    const onLink = !linked && !ble.reconnecting;
    show("linkScreen", onLink);
    show("main", !onLink);
    setText("linkState", connectAfterPick || ble.connectionText === "Scanning" ? "Pick your rig in the list that opened." : ble.connectionText);
    setText("btMsg", ble.btMessage ?? "");
    show("btMsg", !!ble.btMessage);
    show("btMsg2", !!ble.btMessage);
    setText("btMsg2", ble.btMessage ?? "");
    const linkText = linked ? rig.linkFresh ? "SWITCH 2 \xB7 LINKED" : "LINKED \xB7 WAITING ON THE RIG" : ble.reconnecting ? "GETTING THE RIG BACK\u2026" : "NOT LINKED";
    setText("linkTag", linkText);
    $("linkDot").classList.toggle("live", linked && rig.linkFresh);
    setText("battery", s ? `${s.battery}%` : "");
    setText("batteryTag", s ? chargingOf(s) ? "CHARGING" : "BATTERY" : "");
    const m = rig.message;
    show("notice", !!m);
    if (m) {
      setText("noticeTag", m.startsWith("Heat came back on") ? "SAFETY CUT" : "HEADS UP");
      setText("noticeText", m);
    }
    show("away", !!rig.awayNote);
    setText("awayText", rig.awayNote ?? "");
    const celsius = s?.unitByte === 12;
    const lo = celsius ? 100 : 200, hi = celsius ? 350 : 700, room = celsius ? 21 : 70;
    const labels2 = celsius ? [100, 150, 200, 250, 300, 350] : [200, 300, 400, 500, 600, 700];
    labels2.forEach((v, i) => setText(`gL${i}`, String(v)));
    let frac = 0, targetFrac = null, targetText = "---", status = linked ? "WAITING ON THE RIG" : "NOT LINKED";
    let profileText = "--";
    if (s) {
      frac = clamp01((s.tempRaw - lo) / (hi - lo));
      if (s.preset >= 0 && s.preset <= 5) {
        const ps = rig.presets[s.preset];
        const t = celsius ? ps.tempC : ps.tempF;
        if (t !== void 0) {
          targetText = `${t}\xB0`;
          targetFrac = clamp01((t - lo) / (hi - lo));
        }
        if (ps.profile !== void 0) profileText = HeatProfile.name(ps.profile);
      }
      status = !rig.linkFresh ? "WAITING ON THE RIG" : heating ? `HEATING \xB7 ${clockText(s.sessionTimeRemaining)} LEFT` : s.tempRaw > room + 50 ? "COOLING \xB7 HEAT OFF" : "COOL \xB7 READY";
    }
    document.body.classList.toggle("heating", heating);
    setText("gTemp", s ? `${s.tempRaw}\xB0` : "---");
    setText("gStatus", status);
    $("gNeedle").setAttribute("transform", `rotate(${(225 + 270 * frac).toFixed(1)} ${C} ${C})`);
    if (heating && frac > 2e-3) {
      $("gArc").setAttribute("d", arcPath(0, frac, R * 0.985));
    } else $("gArc").setAttribute("d", "");
    if (targetFrac !== null) {
      $("gMarker").setAttribute("transform", `rotate(${(225 + 270 * targetFrac).toFixed(1)} ${C} ${C})`);
      $("gMarker").style.display = "";
    } else $("gMarker").style.display = "none";
    setText("cTarget", targetText);
    const hold = rig.heldHoldSeconds;
    setText("cHold", hold !== void 0 ? `${hold}s` : "--");
    setText("cProfile", profileText);
    setText("cLeft", heating && s ? clockText(s.sessionTimeRemaining) : "--");
    const locked = !rig.canControl || heating;
    setText("presetTag", heating ? "PRESETS \xB7 LOCKED WHILE HEATING" : "PRESETS");
    for (let n = 1; n <= 5; n++) {
      const p = rig.presets[n];
      const t = celsius ? p.tempC : p.tempF;
      setText(`p${n}t`, t !== void 0 ? `${t}\xB0` : "\u2014");
      $(`p${n}`).classList.toggle("on", s?.preset === n);
      enable(`p${n}`, !locked);
    }
    const sel = s?.preset ?? 0;
    show("editBtn", sel >= 1 && sel <= 5);
    setText("editBtn", `EDIT ${sel}`);
    enable("editBtn", !locked);
    if (heating && !$("editor").hidden) $("editor").hidden = true;
    show("heatRow", !heating);
    show("cutRow", heating);
    enable("heat", rig.canHeat);
    enable("extend", rig.canExtend);
    setText("heatHint", !linked ? "" : !rig.linkFresh ? "Waiting on the rig\u2026" : rig.startPendingAt !== null ? "Starting\u2026" : "");
    if (tab === "lights") {
      const cur = s?.lightMode ?? -1;
      lightGrid.querySelectorAll(".orbBtn").forEach((b) => {
        b.classList.toggle("on", Number(b.dataset.mode) === cur);
        b.disabled = !rig.canControl;
      });
      setText("lightNow", s ? `${LightModes.name(s.lightMode)} \xB7 ${s.brightness}%` : "--");
      if (s && Date.now() - brightTouchedAt > 1500 && document.activeElement !== bright) {
        bright.value = String(s.brightness);
        setText("brightV", `${s.brightness}%`);
      }
      bright.disabled = !rig.canControl;
      $("showOn").checked = rig.showEnabled;
    }
    if (tab === "rig") {
      const info = ble.deviceInfo;
      const rows = [
        ["Name", ble.peripheralName || "--"],
        ["Model", info["Model number (2A24)"] ?? "--"],
        ["Firmware", info["Software revision (2A28)"] ?? "--"],
        ["Units", s ? celsius ? "\xB0C" : "\xB0F" : "--"],
        ["Battery", s ? `${s.battery}%${chargingOf(s) ? ", charging" : ""}` : "--"],
        ["Link", ble.connectionText]
      ];
      const html = rows.map(([k]) => `<div class="kv"><span>${k}</span><b></b></div>`).join("");
      const box = $("rigInfo");
      if (box.childElementCount !== rows.length) box.innerHTML = html;
      rows.forEach(([, v], i) => {
        const b = box.children[i].querySelector("b");
        if (b.textContent !== v) b.textContent = v;
      });
      enable("disconnect", linked || ble.reconnecting);
      setText("disconnect", rig.disconnectWaiting ? "Disconnect now" : "Disconnect");
    }
  }
  function schedule() {
    if (!queued) {
      queued = true;
      requestAnimationFrame(render);
    }
  }
  ble.onChange = schedule;
  rig.onChange = schedule;
  setInterval(schedule, 500);
  showTab("home");
  render();
})();
