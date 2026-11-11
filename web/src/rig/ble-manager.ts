// Port of BLEManager.swift: scanning, connecting, keeping the link, logging, and the one FEC1 write path.
// Keep it line for line with the Swift file; the shared bench (presh-shared/bench-spec) checks both.

import { Clock, Cancel, DISTANT_PAST } from "./clock";
import { Central, CentralDelegate, Peripheral, PeripheralDelegate, Service, Characteristic, BleError, Advertisement, Props } from "./central";
import { LiveStatus, decodeFrame, hexString } from "./frames";
import type { RigController } from "./rig-controller";

export function normUUID(u: string): string {
  const s = u.toLowerCase();
  if (s.length === 4) return `0000${s}-0000-1000-8000-00805f9b34fb`;
  if (s.length === 8) return `${s}-0000-1000-8000-00805f9b34fb`;
  return s;
}

export const KnownUUID = {
  fee7: "0000fee7-0000-1000-8000-00805f9b34fb",
  fec1: "0000fec1-0000-1000-8000-00805f9b34fb",
  fec2: "0000fec2-0000-1000-8000-00805f9b34fb",
  primary: "f56598fa-3ffa-41a7-9726-3fc69baeca1d",
  primaryRead: "744c98ff-83c6-45d5-bd0c-52a50589215b",
  primaryWrite: "2c759c29-a73c-45ab-a799-31d6a032f6af",
  battery: "00002a19-0000-1000-8000-00805f9b34fb",
};

const readOnConnect: Record<string, string> = {
  "00002a24-0000-1000-8000-00805f9b34fb": "Model number (2A24)",
  "00002a25-0000-1000-8000-00805f9b34fb": "Serial number (2A25)",
  "00002a27-0000-1000-8000-00805f9b34fb": "Hardware revision (2A27)",
  "00002a28-0000-1000-8000-00805f9b34fb": "Software revision (2A28)",
  "00002a29-0000-1000-8000-00805f9b34fb": "Manufacturer (2A29)",
  [KnownUUID.battery]: "Battery (2A19)",
};

const labels: Record<string, string> = {
  [KnownUUID.fee7]: "FEE7 service",
  [KnownUUID.fec1]: "FEC1 (write on FEE7)",
  [KnownUUID.fec2]: "FEC2 (notify on FEE7)",
  [KnownUUID.primary]: "Primary service",
  [KnownUUID.primaryRead]: "Primary notify",
  [KnownUUID.primaryWrite]: "Primary write",
};

const writeTargetIDs = [KnownUUID.fec1, KnownUUID.primaryWrite];

export interface Discovered { id: string; name: string; rssi: number; services: string[]; peripheral: Peripheral }
export interface CharInfo { uuid: string; props: string; label: string | null }
export interface ServiceInfo { uuid: string; label: string | null; chars: CharInfo[] }
export interface WriteTarget { id: string; label: string }

type LinkIntent = "idle" | "wanted" | "userDropped" | "parked";

function propsText(p: number): string {
  const parts: string[] = [];
  if (p & Props.read) parts.push("read");
  if (p & Props.write) parts.push("write");
  if (p & Props.writeWithoutResponse) parts.push("writeWithoutResponse");
  if (p & Props.notify) parts.push("notify");
  if (p & Props.indicate) parts.push("indicate");
  return parts.length === 0 ? "(none of the listed)" : parts.join(", ");
}

export class BLEManager implements CentralDelegate, PeripheralDelegate {
  // Bluetooth / scanning
  btMessage: string | null = null;
  btReady = false;
  isScanning = false;
  showAll = false;
  devices: Discovered[] = [];

  // Connection
  connectionText = "Not connected";
  isConnected = false;
  reconnecting = false;
  peripheralName = "";
  peripheralID = "";

  // Discovered GATT + data
  services: ServiceInfo[] = [];
  deviceInfo: Record<string, string> = {};
  status: LiveStatus | null = null;
  statusTime: number | null = null;
  extra: Record<string, string> = {};
  writeTargets: WriteTarget[] = [];
  logLines: string[] = [];
  rig: RigController | null = null;
  /** Called after any change, so a screen can redraw. */
  onChange: (() => void) | null = null;

  private peripheral: Peripheral | null = null;
  private charactersByUUID = new Map<string, Characteristic>();
  private clockSyncSent = false;

  private linkIntent: LinkIntent = "idle";
  private reconnectToken = 0;
  private reconnectDeadline = DISTANT_PAST;
  private inBackground = false;
  private lostToBluetoothOff = false;
  /** How long to keep trying to get the rig back after the link drops by itself. */
  linkLostWindow = 180;

  private lastRX = new Map<string, { bytes: number[]; loggedAt: number; skipped: number }>();
  private readonly logCap = 20000;
  droppedLogLines = 0;

  constructor(readonly central: Central, readonly clock: Clock) {
    central.delegate = this;
  }

  private changed() { this.onChange?.(); }

  // MARK: Logging

  private stamp(): string {
    const d = new Date(this.clock.wallMs());
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }

  log(text: string) {
    this.logLines.push(`[${this.stamp()}] ${text}`);
    if (this.logLines.length > this.logCap + 2000) {
      const extra = this.logLines.length - this.logCap;
      this.logLines.splice(0, extra);
      this.droppedLogLines += extra;
    }
    this.changed();
  }

  exportText(appVersion = "web"): string {
    let h = "Presh log\n";
    h += `App version: ${appVersion}\n`;
    h += `Browser: ${typeof navigator !== "undefined" ? navigator.userAgent : "bench"}\n`;
    h += `Peripheral name: ${this.peripheralName || "(none)"}\n`;
    h += `Peripheral identifier: ${this.peripheralID || "(none)"}\n`;
    h += `Exported: ${new Date(this.clock.wallMs()).toISOString()}\n`;
    if (this.droppedLogLines > 0) h += `Older lines dropped to save memory: ${this.droppedLogLines}\n`;
    h += "Note: a status frame that repeats unchanged is logged once, then counted.\n";
    h += "----------------------------------------\n";
    return h + this.logLines.join("\n") + "\n";
  }

  /** A frame identical to the last one of its kind is counted instead of logged again (shown once every 10 s). */
  private logRX(source: string, bytes: number[]) {
    let key = source + ":" + String(bytes[0] ?? 0);
    if (bytes.length > 2 && [163, 165, 167, 170, 171].includes(bytes[0])) key += ":" + String(bytes[2]);
    const now = this.clock.now();
    const m = this.lastRX.get(key);
    if (m) {
      if (m.bytes.length === bytes.length && m.bytes.every((v, i) => v === bytes[i])) {
        if (now - m.loggedAt < 10.0) {
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

  connect(d: Discovered) {
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

  private beginReconnect(window: number, text: string) {
    const old = this.peripheral;
    if (this.central.state !== "poweredOn" || !old) return;
    const p = this.central.retrievePeripherals([old.identifier])[0] ?? old;
    p.delegate = this;
    this.peripheral = p;
    this.linkIntent = "wanted";
    this.reconnectToken += 1;
    const tok = this.reconnectToken;
    this.reconnecting = true;
    this.reconnectDeadline = this.clock.now() + window;
    this.connectionText = text;
    this.services = [];
    this.writeTargets = [];
    this.charactersByUUID.clear();
    this.clockSyncSent = false;
    this.central.connect(p);
    this.clock.after(window, () => {
      if (this.reconnectToken !== tok || !this.reconnecting || this.isConnected) return;
      this.reconnecting = false;
      this.linkIntent = "idle";
      this.central.cancelPeripheralConnection(p);
      this.connectionText = "Not connected. Couldn't get the rig back.";
      this.log(`Gave up getting the rig back after ${Math.trunc(window)} s. Use Scan to connect again.`);
    });
  }

  private retryReconnectSoon() {
    const tok = this.reconnectToken;
    this.clock.after(1.0, () => {
      const p = this.peripheral;
      if (this.reconnectToken !== tok || !this.reconnecting || this.isConnected || this.linkIntent !== "wanted" || !p) return;
      this.central.connect(p);
    });
  }

  private resetDeviceState() {
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

  get fec1Ready(): boolean {
    const ch = this.charactersByUUID.get(KnownUUID.fec1);
    if (!this.isConnected || !this.peripheral || !ch) return false;
    return (ch.properties & Props.writeWithoutResponse) !== 0;
  }

  /** Writes one frame to FEC1 without response and logs it in hex with a label. */
  transmit(frame: number[], label: string): boolean {
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
  private sendClockSync() {
    const d = new Date(this.clock.wallMs());
    const year = d.getUTCFullYear();
    const frame = [177, 9, (year >> 8) & 255, year & 255, d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), 177];
    if (this.transmit(frame, "Clock sync (UTC)")) this.clockSyncSent = true;
  }

  private handleFrame(source: string, bytes: number[]) {
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
  private bluetoothWentAway() {
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

  centralDidUpdateState(c: Central) {
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

  didDiscover(_c: Central, p: Peripheral, adv: Advertisement, rssi: number) {
    const name = p.name ?? adv.localName ?? "(no name)";
    const uuids = (adv.serviceUUIDs ?? []).map(normUUID);
    if (rssi === 127) return;
    const idx = this.devices.findIndex(d => d.id === p.identifier);
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

  didConnect(c: Central, p: Peripheral) {
    if (p !== this.peripheral || this.linkIntent !== "wanted") {
      this.log("A connection came up that is no longer wanted. Closing it.");
      c.cancelPeripheralConnection(p);
      return;
    }
    if (this.reconnecting && this.clock.now() > this.reconnectDeadline + 2.0) {
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

  didFailToConnect(_c: Central, p: Peripheral, error: BleError | null) {
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

  didDisconnect(_c: Central, p: Peripheral, error: BleError | null) {
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

  didDiscoverServices(p: Peripheral, error: BleError | null) {
    if (p !== this.peripheral) return;
    if (error) { this.log(`Service discovery error: ${error.localizedDescription}`); return; }
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

  didDiscoverCharacteristics(p: Peripheral, service: Service, error: BleError | null) {
    if (p !== this.peripheral) return;
    const sid = normUUID(service.uuid);
    if (error) { this.log(`Characteristic discovery error for ${sid}: ${error.localizedDescription}`); return; }
    const infos: CharInfo[] = [];
    for (const ch of service.characteristics ?? []) {
      const cid = normUUID(ch.uuid);
      const props = propsText(ch.properties);
      infos.push({ uuid: cid, props, label: labels[cid] ?? null });
      this.charactersByUUID.set(cid, ch);
      this.log(`  CHAR ${cid} [${props}] in service ${sid}`);
      if ((ch.properties & Props.read) && readOnConnect[cid] !== undefined) p.readValue(ch);
      if (ch.properties & (Props.notify | Props.indicate)) {
        p.setNotifyValue(true, ch);
        this.log(`  Subscribing to ${cid}`);
      }
    }
    const idx = this.services.findIndex(s => s.uuid === sid);
    if (idx >= 0) this.services[idx].chars = infos;
    const targets: WriteTarget[] = [];
    for (const tid of writeTargetIDs) {
      const ch = this.charactersByUUID.get(tid);
      if (ch && (ch.properties & (Props.writeWithoutResponse | Props.write))) targets.push({ id: tid, label: labels[tid] ?? tid });
    }
    this.writeTargets = targets;
  }

  didUpdateNotificationState(p: Peripheral, ch: Characteristic, error: BleError | null) {
    if (p !== this.peripheral) return;
    const cid = normUUID(ch.uuid);
    if (error) {
      this.log(`Notify state error on ${cid}: ${error.localizedDescription}`);
    } else {
      this.log(`Notify on ${cid}: ${ch.isNotifying ? "ON" : "OFF"}`);
      if (cid === KnownUUID.fec2 && ch.isNotifying && !this.clockSyncSent) this.sendClockSync();
    }
  }

  didUpdateValue(p: Peripheral, ch: Characteristic, error: BleError | null) {
    if (p !== this.peripheral) return;
    const cid = normUUID(ch.uuid);
    if (error) { this.log(`Read/notify error on ${cid}: ${error.localizedDescription}`); return; }
    const bytes = ch.value;
    if (!bytes) return;
    const label = readOnConnect[cid];
    if (label !== undefined) {
      if (cid === KnownUUID.battery) {
        const level = bytes.length > 0 ? `${bytes[0]}%` : "?";
        this.deviceInfo[label] = level;
        this.log(`READ ${label}: ${level}  raw ${hexString(bytes)}`);
      } else {
        const text = String.fromCharCode(...bytes.filter(c => c >= 32 && c < 127));
        this.deviceInfo[label] = text;
        this.log(`READ ${label}: "${text}"  raw ${hexString(bytes)}`);
      }
      return;
    }
    this.handleFrame(cid, [...bytes]);
  }
}

export type { Cancel };
