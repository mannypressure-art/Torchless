// The simulated Switch 2 and Bluetooth link. Port of switch app/sim-bench/stubs/CoreBluetooth.swift,
// described in plain words in presh-shared/bench-spec/SIMRIG.md.

import { VirtualClock } from "../src/rig/clock";
import {
  Central, CentralDelegate, CentralState, Characteristic, Peripheral, PeripheralDelegate, Props, Service,
} from "../src/rig/central";

class SimChar implements Characteristic {
  value: number[] | null = null;
  isNotifying = false;
  constructor(readonly uuid: string, readonly properties: number) {}
}

class SimService implements Service {
  characteristics: Characteristic[] | null = null;
  constructor(readonly uuid: string, readonly hidden: Characteristic[]) {}
}

export class SimPeripheral implements Peripheral {
  readonly identifier = "8E2F6C1A-0000-4000-8000-5157C4A1B2C3";
  delegate: PeripheralDelegate | null = null;
  services: Service[] | null = null;
  readonly canSendWriteWithoutResponse = true;
  connected = false;
  wantConnect = false;
  readonly fec1 = new SimChar("FEC1", Props.write | Props.writeWithoutResponse);
  readonly fec2 = new SimChar("FEC2", Props.notify);
  readonly model = new SimChar("2A24", Props.read);
  readonly maker = new SimChar("2A29", Props.read);
  readonly all: SimService[] = [new SimService("FEE7", [this.fec1, this.fec2]), new SimService("180A", [this.model, this.maker])];

  constructor(readonly name: string, private readonly w: SimWorld) {}

  dropLinkState() {
    this.connected = false;
    this.services = null;
    this.fec2.isNotifying = false;
    for (const s of this.all) s.characteristics = null;
  }

  discoverServices() {
    this.w.clock.after(0.03, () => {
      if (!this.connected) return;
      this.services = this.all;
      this.delegate?.didDiscoverServices(this, null);
    });
  }

  discoverCharacteristics(service: Service) {
    this.w.clock.after(0.03, () => {
      if (!this.connected) return;
      service.characteristics = (service as SimService).hidden;
      this.delegate?.didDiscoverCharacteristics(this, service, null);
    });
  }

  readValue(ch: Characteristic) {
    this.w.clock.after(0.02, () => {
      if (!this.connected) return;
      ch.value = Array.from(ch === this.model ? "Switch 2" : "Dr.Dabber", c => c.charCodeAt(0));
      this.delegate?.didUpdateValue(this, ch, null);
    });
  }

  setNotifyValue(on: boolean, ch: Characteristic) {
    this.w.clock.after(0.02, () => {
      if (!this.connected) return;
      ch.isNotifying = on;
      this.delegate?.didUpdateNotificationState(this, ch, null);
    });
  }

  writeValue(bytes: number[], ch: Characteristic) {
    if (!this.connected || ch !== this.fec1) { this.w.lostWrites += 1; return; }
    const copy = [...bytes];
    this.w.clock.after(this.w.writeLatency, () => {
      if (!this.connected) { this.w.lostWrites += 1; return; }
      this.w.rig.receive(copy);
    });
  }

  push(bytes: number[]) {
    if (!this.connected || !this.fec2.isNotifying) return;
    this.fec2.value = [...bytes];
    this.delegate?.didUpdateValue(this, this.fec2, null);
  }
}

export class SimCentral implements Central {
  state: CentralState = "unknown";
  delegate: CentralDelegate | null = null;
  private scanning = false;

  constructor(private readonly w: SimWorld) {
    w.central = this;
    w.clock.after(0, () => {
      this.state = "poweredOn";
      this.delegate?.centralDidUpdateState(this);
    });
  }

  scanForPeripherals() {
    this.scanning = true;
    this.w.clock.after(0.1, () => {
      if (!this.scanning || !this.w.inRange || this.state !== "poweredOn") return;
      this.delegate?.didDiscover(this, this.w.peripheral, { localName: "Presh", serviceUUIDs: ["FEE7"] }, -50);
    });
  }

  stopScan() { this.scanning = false; }

  connect(p: Peripheral) {
    const sp = p as SimPeripheral;
    this.w.connectCalls += 1;
    sp.wantConnect = true;
    this.completeConnectIfPossible(sp);
  }

  completeConnectIfPossible(p: SimPeripheral) {
    this.w.clock.after(0.08, () => {
      if (!p.wantConnect || p.connected || !this.w.inRange || this.state !== "poweredOn") return;
      p.wantConnect = false;
      p.connected = true;
      this.delegate?.didConnect(this, p);
    });
  }

  cancelPeripheralConnection(p: Peripheral) {
    const sp = p as SimPeripheral;
    this.w.cancelCalls += 1;
    if (sp.connected) {
      sp.dropLinkState();
      this.w.clock.after(0.02, () => this.delegate?.didDisconnect(this, sp, null));
    } else if (sp.wantConnect) {
      sp.wantConnect = false;
      if (this.w.pendingCancelReportsDisconnect) {
        this.w.clock.after(0.02, () => this.delegate?.didDisconnect(this, sp, null));
      }
    }
  }

  retrievePeripherals(ids: string[]): Peripheral[] {
    return ids.includes(this.w.peripheral.identifier) ? [this.w.peripheral] : [];
  }

  simLoseLink() {
    this.w.inRange = false;
    const p = this.w.peripheral;
    if (!p.connected) return;
    p.dropLinkState();
    this.delegate?.didDisconnect(this, p, { localizedDescription: "The connection has timed out unexpectedly." });
  }

  simBackInRange() {
    this.w.inRange = true;
    const p = this.w.peripheral;
    if (p.wantConnect) this.completeConnectIfPossible(p);
  }

  simBluetooth(on: boolean) {
    const p = this.w.peripheral;
    if (!on) {
      p.dropLinkState();
      p.wantConnect = false;
      this.state = "poweredOff";
    } else {
      this.state = "poweredOn";
    }
    this.delegate?.centralDidUpdateState(this);
  }
}

export interface Seen { time: number; bytes: number[]; sessionWas: number; remainingWas: number; sinceStatus: number }
export interface RigEvent { time: number; what: string }

export class SimRig {
  preset = 1; lightMode = 3; session = 0; autoOff = 10; unit = 15; remaining = 0; haptics = 170;
  extend = 0; battery = 80; brightness = 50; temp = 80.0;
  presetTemp = [480, 450, 500, 520, 550, 600];
  hold = [30, 12, 30, 10, 45, 60];
  profile = [161, 161, 161, 161, 161, 161];

  preheat = 2.0;
  lingerAfterZero = 0;
  neverStops = false;
  ignoreStops = 0;
  statusPeriod = 0.5;
  afterStatus: (() => void) | null = null;
  /** The real rig's connect dump lists presets 1 to 5 only (Log of 2026-11-11, firmware SW2-260929-011), so the
   *  app never learns what the live slot (0) held. A scenario can turn this on to cover the other case. */
  reportsLiveSlot = false;

  received: Seen[] = [];
  events: RigEvent[] = [];
  sessionStarts = 0;
  statusTimes: number[] = [];
  heatOnTotal = 0;

  private total = 0;
  private countdownStart = -Infinity;
  private zeroAt: number | null = null;
  private onSince: number | null = null;

  constructor(private readonly w: SimWorld) {}

  private now() { return this.w.clock.now(); }
  private slot() { return Math.min(Math.max(this.preset, 0), 5); }

  power() {
    const loop = () => this.w.clock.after(this.statusPeriod, () => { this.tick(); loop(); });
    loop();
  }

  private note(what: string) { this.events.push({ time: this.now(), what }); }

  buttonStart() { if (this.session === 0) this.startSession("rig button"); }
  buttonStop() { if (this.session !== 0) this.stopSession("rig button"); }

  private startSession(cause: string) {
    this.session = 170;
    this.sessionStarts += 1;
    this.total = this.hold[this.slot()] + 10 * this.extend;
    this.remaining = Math.min(this.total, 255);
    this.countdownStart = this.now() + this.preheat;
    this.zeroAt = null;
    this.onSince = this.now();
    this.note(`START by ${cause}`);
  }

  private stopSession(cause: string) {
    this.session = 0;
    this.remaining = 0;
    this.extend = 0;
    if (this.onSince !== null) this.heatOnTotal += this.now() - this.onSince;
    this.onSince = null;
    this.note(`STOP by ${cause}`);
  }

  private tick() {
    const now = this.now();
    if (this.session !== 0) {
      if (now >= this.countdownStart) {
        this.remaining = Math.max(0, this.total - Math.trunc(now - this.countdownStart));
      }
      if (this.remaining === 0) {
        if (this.zeroAt === null) this.zeroAt = now;
        if (!this.neverStops && now - this.zeroAt >= this.lingerAfterZero) this.stopSession("its own timer");
      }
      const slot = this.slot();
      let target = this.presetTemp[slot];
      // Seen on the real rig (Log of 2026-11-11, preset 465 F / 50 s / Ascent): once the countdown runs, an
      // Ascent preset climbs 1 F a second from its set temp, and +10 s keeps the climb going. One dab's
      // worth of evidence; whether the rig stops climbing at set temp + 50 was not seen.
      if (this.profile[slot] === 177 && now >= this.countdownStart) target += Math.min(this.total, now - this.countdownStart);
      this.temp = Math.min(target, this.temp + 60);
    } else {
      this.temp = Math.max(80, this.temp - 8);
    }
    this.sendStatus();
  }

  sendStatus() {
    const t = Math.round(this.temp);
    const frame = [169, 20, 0, this.preset, 0, 1, this.lightMode, this.session, this.autoOff, 0,
      (t >> 8) & 255, t & 255, this.unit, this.remaining & 255, this.haptics, this.extend, this.battery, 0, this.brightness, 169];
    this.statusTimes.push(this.now());
    this.w.peripheral.push(frame);
    this.afterStatus?.();
  }

  private report(bytes: number[]) { this.w.peripheral.push(bytes.map(b => b & 255)); }

  private reportPreset(p: number) {
    const f = this.presetTemp[p];
    const c = Math.round((f - 32) * 5 / 9);
    this.report([163, 8, p, f >> 8, f & 255, c >> 8, c & 255, 163]);
    this.report([167, 6, p, this.hold[p] >> 8, this.hold[p] & 255, 167]);
    this.report([165, 5, p, this.profile[p], 165]);
  }

  receive(b: number[]) {
    const last = this.statusTimes.length > 0 ? this.statusTimes[this.statusTimes.length - 1] : -Infinity;
    this.received.push({ time: this.now(), bytes: b, sessionWas: this.session, remainingWas: this.remaining, sinceStatus: this.now() - last });
    if (b.length === 0) return;
    const cmd = b[0];
    const ascii = (s: string) => Array.from(s, c => c.charCodeAt(0));
    switch (cmd) {
      case 177:
        for (let p = this.reportsLiveSlot ? 0 : 1; p <= 5; p++) this.reportPreset(p);
        this.report([225, 7, 1, 2, 3, 4, 225]);
        this.report([195, 11, ...ascii("SW2-260929"), 195]);
        this.report([196, 11, ...ascii("V2.0.0  "), 196]);
        break;
      case 185: {
        if (b.length !== 20) { this.note("BAD B9 length"); return; }
        const wantOn = b[10] === 170;
        if (this.session !== 0 && !wantOn && this.ignoreStops > 0) {
          this.ignoreStops -= 1;
          this.note("STOP frame swallowed");
          return;
        }
        this.preset = b[3];
        this.lightMode = b[6];
        this.autoOff = b[8];
        this.unit = b[9];
        this.haptics = b[11];
        this.brightness = b[13];
        const newExtend = b[12];
        if (this.session !== 0) {
          if (!wantOn) {
            this.stopSession("app frame");
          } else if (newExtend !== this.extend) {
            this.extend = newExtend;
            this.total = this.hold[this.slot()] + 10 * this.extend;
            if (this.now() < this.countdownStart) this.remaining = Math.min(this.total, 255);
            this.note(`EXTEND to ${this.extend}`);
          }
        } else if (wantOn) {
          this.extend = newExtend;
          this.startSession("app frame");
        }
        break;
      }
      case 179: {
        if (b.length !== 8 || b[2] > 5) return;
        this.presetTemp[b[2]] = (b[3] << 8) | b[4];
        this.note(`TEMP slot ${b[2]} = ${this.presetTemp[b[2]]}`);
        const f = this.presetTemp[b[2]];
        const c = Math.round((f - 32) * 5 / 9);
        this.report([163, 8, b[2], f >> 8, f & 255, c >> 8, c & 255, 163]);
        break;
      }
      case 183:
        if (b.length !== 6 || b[2] > 5) return;
        this.hold[b[2]] = (b[3] << 8) | b[4];
        this.report([167, 6, b[2], b[3], b[4], 167]);
        break;
      case 181:
        if (b.length !== 5 || b[2] > 5) return;
        this.profile[b[2]] = b[3];
        this.report([165, 5, b[2], b[3], 165]);
        break;
      case 178:
        this.report([162, 13, 0, 5, 0, 63, 0, 121, 0, 210, 0, 0, 162]);
        break;
      default:
        this.note(`UNEXPECTED frame ${cmd}`);
    }
  }
}

export class SimWorld {
  readonly clock = new VirtualClock();
  rig: SimRig;
  peripheral: SimPeripheral;
  central: SimCentral | null = null;
  inRange = true;
  writeLatency = 0.02;
  pendingCancelReportsDisconnect = true;
  connectCalls = 0;
  cancelCalls = 0;
  lostWrites = 0;
  constructor() {
    this.rig = new SimRig(this);
    this.peripheral = new SimPeripheral("Presh", this);
  }
}
