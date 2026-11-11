// Web Bluetooth behind the CoreBluetooth-shaped interface (central.ts), so BLEManager runs unchanged.
// Works in Chrome (Android, Mac, Windows, ChromeOS) and in Bluefy on iPhone. Safari has no Web Bluetooth.
//
// Differences from CoreBluetooth, and how this file handles them:
// - No background scan list: the browser shows its own chooser. scanForPeripherals() opens it, so it must be
//   called straight from a tap. The chosen rig is reported through didDiscover like a scan result.
// - connect() fails at once when the rig is out of range instead of waiting. BLEManager already retries
//   inside its reconnect window, so this only changes how often it asks.
// - One GATT operation at a time: every call goes through a small queue.

/// <reference lib="dom" />
import {
  Central, CentralDelegate, CentralState, Characteristic, Peripheral, PeripheralDelegate, Props, Service, BleError,
} from "./central";

const FEE7 = 0xfee7;
const PRIMARY = "f56598fa-3ffa-41a7-9726-3fc69baeca1d";
const OPTIONAL = [0x180a, 0x180f, FEE7, PRIMARY];

const err = (e: unknown): BleError => ({ localizedDescription: e instanceof Error ? e.message : String(e) });

function shortUUID(u: string): string {
  const m = u.toLowerCase().match(/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/);
  return m ? m[1].toUpperCase() : u.toLowerCase();
}

class WebChar implements Characteristic {
  value: number[] | null = null;
  isNotifying = false;
  readonly uuid: string;
  readonly properties: number;
  constructor(readonly raw: any) {
    this.uuid = shortUUID(raw.uuid);
    const p = raw.properties;
    this.properties = (p.read ? Props.read : 0) | (p.write ? Props.write : 0)
      | (p.writeWithoutResponse ? Props.writeWithoutResponse : 0) | (p.notify ? Props.notify : 0) | (p.indicate ? Props.indicate : 0);
  }
}

class WebService implements Service {
  characteristics: Characteristic[] | null = null;
  readonly uuid: string;
  constructor(readonly raw: any) { this.uuid = shortUUID(raw.uuid); }
}

export class WebPeripheral implements Peripheral {
  delegate: PeripheralDelegate | null = null;
  services: Service[] | null = null;
  readonly canSendWriteWithoutResponse = true;
  private chain: Promise<unknown> = Promise.resolve();
  /** Bumped on every connect and disconnect, so work from an older link is ignored. */
  linkGen = 0;
  constructor(readonly device: any) {}
  get identifier(): string { return this.device.id; }
  get name(): string | null { return this.device.name ?? null; }
  get gattConnected(): boolean { return !!this.device.gatt?.connected; }

  /** Runs GATT operations one at a time. Work queued for an older link is skipped. */
  private op<T>(fn: () => Promise<T>, onError: (e: unknown) => void): void {
    const gen = this.linkGen;
    this.chain = this.chain.then(async () => {
      if (gen !== this.linkGen || !this.gattConnected) return;
      try { await fn(); } catch (e) { if (gen === this.linkGen) onError(e); }
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
      this.services = list.map((s: any) => new WebService(s));
      this.delegate?.didDiscoverServices(this, null);
    }, e => this.delegate?.didDiscoverServices(this, err(e)));
  }

  discoverCharacteristics(service: Service) {
    const ws = service as WebService;
    this.op(async () => {
      const list = await ws.raw.getCharacteristics();
      ws.characteristics = list.map((c: any) => new WebChar(c));
      this.delegate?.didDiscoverCharacteristics(this, ws, null);
    }, e => this.delegate?.didDiscoverCharacteristics(this, ws, err(e)));
  }

  readValue(ch: Characteristic) {
    const wc = ch as WebChar;
    this.op(async () => {
      const dv: DataView = await wc.raw.readValue();
      wc.value = Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
      this.delegate?.didUpdateValue(this, wc, null);
    }, e => this.delegate?.didUpdateValue(this, wc, err(e)));
  }

  setNotifyValue(on: boolean, ch: Characteristic) {
    const wc = ch as WebChar;
    const gen = this.linkGen;
    this.op(async () => {
      if (on) {
        wc.raw.addEventListener("characteristicvaluechanged", (ev: any) => {
          if (gen !== this.linkGen) return;
          const dv: DataView = ev.target.value;
          wc.value = Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
          this.delegate?.didUpdateValue(this, wc, null);
        });
        await wc.raw.startNotifications();
      } else {
        await wc.raw.stopNotifications();
      }
      wc.isNotifying = on;
      this.delegate?.didUpdateNotificationState(this, wc, null);
    }, e => this.delegate?.didUpdateNotificationState(this, wc, err(e)));
  }

  writeValue(bytes: number[], ch: Characteristic, withResponse: boolean) {
    const wc = ch as WebChar;
    const data = new Uint8Array(bytes);
    // A failed write is not reported back on iPhone either (write without response). The rig's next
    // status frame is what the app trusts.
    this.op(async () => {
      if (!withResponse && typeof wc.raw.writeValueWithoutResponse === "function") await wc.raw.writeValueWithoutResponse(data);
      else if (typeof wc.raw.writeValueWithResponse === "function") await wc.raw.writeValueWithResponse(data);
      else await wc.raw.writeValue(data);
    }, e => console.warn("Presh: write failed", e));
  }
}

export class WebCentral implements Central {
  state: CentralState = "unknown";
  delegate: CentralDelegate | null = null;
  private known = new Map<string, WebPeripheral>();
  private wanted = new Set<WebPeripheral>();
  private cancelled = new Set<WebPeripheral>();
  /** Links closed because a cancel came in while connecting: already reported, so stay quiet. */
  private silent = new Set<WebPeripheral>();

  constructor() {
    const bt = (navigator as any).bluetooth;
    setTimeout(async () => {
      if (!bt || typeof bt.requestDevice !== "function") {
        this.setState("unsupported");
        return;
      }
      let on = true;
      try { if (typeof bt.getAvailability === "function") on = await bt.getAvailability(); } catch { on = true; }
      this.setState(on ? "poweredOn" : "poweredOff");
      bt.addEventListener?.("availabilitychanged", (ev: any) => this.setState(ev.value ? "poweredOn" : "poweredOff"));
    }, 0);
  }

  private setState(s: CentralState) {
    if (s === this.state) return;
    if (s === "poweredOff") {
      for (const p of this.known.values()) { p.resetLink(); this.wanted.delete(p); }
    }
    this.state = s;
    this.delegate?.centralDidUpdateState(this);
  }

  /** Opens the browser's chooser. Must run inside a tap. */
  scanForPeripherals(serviceUUIDs: string[] | null) {
    const bt = (navigator as any).bluetooth;
    const options = serviceUUIDs === null
      ? { acceptAllDevices: true, optionalServices: OPTIONAL }
      : { filters: [{ services: [FEE7] }, { services: [PRIMARY] }], optionalServices: OPTIONAL };
    bt.requestDevice(options).then((device: any) => {
      const p = this.wrap(device);
      this.delegate?.didDiscover(this, p, { localName: device.name ?? undefined, serviceUUIDs: ["FEE7"] }, -50);
    }).catch((e: unknown) => {
      // The chooser was closed without a pick, or the browser refused.
      console.info("Presh: chooser closed", e);
    });
  }

  stopScan() { /* the chooser closes itself */ }

  private wrap(device: any): WebPeripheral {
    let p = this.known.get(device.id);
    if (!p) {
      p = new WebPeripheral(device);
      this.known.set(device.id, p);
      const wp = p;
      device.addEventListener("gattserverdisconnected", () => this.onDropped(wp));
    }
    return p;
  }

  private onDropped(p: WebPeripheral) {
    if (this.silent.delete(p)) { p.resetLink(); return; }
    const wasCancelled = this.cancelled.delete(p);
    p.resetLink();
    for (const s of p.services ?? []) s.characteristics = null;
    this.delegate?.didDisconnect(this, p, wasCancelled ? null : { localizedDescription: "The connection was lost." });
  }

  connect(p: Peripheral) {
    const wp = p as WebPeripheral;
    this.wanted.add(wp);
    this.cancelled.delete(wp);
    wp.device.gatt.connect().then(() => {
      if (!this.wanted.has(wp)) {
        // Cancelled while connecting (already reported as a disconnect).
        this.silent.add(wp);
        wp.device.gatt.disconnect();
        return;
      }
      this.wanted.delete(wp);
      wp.resetLink();
      this.delegate?.didConnect(this, wp);
    }).catch((e: unknown) => {
      if (!this.wanted.delete(wp)) return;
      this.delegate?.didFailToConnect(this, wp, err(e));
    });
  }

  cancelPeripheralConnection(p: Peripheral) {
    const wp = p as WebPeripheral;
    if (wp.gattConnected) {
      this.cancelled.add(wp);
      wp.device.gatt.disconnect();
    } else if (this.wanted.delete(wp)) {
      setTimeout(() => this.delegate?.didDisconnect(this, wp, null), 0);
    }
  }

  retrievePeripherals(identifiers: string[]): Peripheral[] {
    return identifiers.map(id => this.known.get(id)).filter((p): p is WebPeripheral => !!p);
  }
}
