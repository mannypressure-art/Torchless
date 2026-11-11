// The shapes BLEManager talks to: the same ones as Apple's CoreBluetooth, cut down to what the app uses.
// The bench plugs in a simulated rig; the web app plugs in Web Bluetooth (web-central.ts, phase 3).

export type CentralState = "unknown" | "resetting" | "unsupported" | "unauthorized" | "poweredOff" | "poweredOn";

export const Props = { read: 0x02, writeWithoutResponse: 0x04, write: 0x08, notify: 0x10, indicate: 0x20 } as const;

export interface Characteristic {
  readonly uuid: string;          // as the stack reports it (short "FEC1" or full); BLEManager normalizes
  readonly properties: number;    // Props bit flags
  value: number[] | null;
  isNotifying: boolean;
}

export interface Service {
  readonly uuid: string;
  characteristics: Characteristic[] | null;
}

export interface BleError { localizedDescription: string }

export interface PeripheralDelegate {
  didDiscoverServices(p: Peripheral, error: BleError | null): void;
  didDiscoverCharacteristics(p: Peripheral, service: Service, error: BleError | null): void;
  didUpdateNotificationState(p: Peripheral, ch: Characteristic, error: BleError | null): void;
  didUpdateValue(p: Peripheral, ch: Characteristic, error: BleError | null): void;
}

export interface Peripheral {
  readonly identifier: string;
  readonly name: string | null;
  delegate: PeripheralDelegate | null;
  readonly services: Service[] | null;
  readonly canSendWriteWithoutResponse: boolean;
  discoverServices(): void;
  discoverCharacteristics(service: Service): void;
  readValue(ch: Characteristic): void;
  setNotifyValue(on: boolean, ch: Characteristic): void;
  writeValue(bytes: number[], ch: Characteristic, withResponse: boolean): void;
}

export interface Advertisement { localName?: string; serviceUUIDs?: string[] }

export interface CentralDelegate {
  centralDidUpdateState(c: Central): void;
  didDiscover(c: Central, p: Peripheral, adv: Advertisement, rssi: number): void;
  didConnect(c: Central, p: Peripheral): void;
  didFailToConnect(c: Central, p: Peripheral, error: BleError | null): void;
  didDisconnect(c: Central, p: Peripheral, error: BleError | null): void;
}

export interface Central {
  readonly state: CentralState;
  delegate: CentralDelegate | null;
  scanForPeripherals(serviceUUIDs: string[] | null): void;
  stopScan(): void;
  connect(p: Peripheral): void;
  cancelPeripheralConnection(p: Peripheral): void;
  retrievePeripherals(identifiers: string[]): Peripheral[];
}
