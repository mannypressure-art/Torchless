// Web Bluetooth transport for the Peak (Chrome, and Bluefy on iPhone). One GATT operation at a time.
/// <reference lib="dom" />
import type { LoraxTransport } from "./peak-controller";
import { LORAX_SERVICE, LEGACY_SERVICE, LoraxChar, hex } from "./lorax";

const msg = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
const withTimeout = <T>(p: Promise<T>, s: number, what: string) => Promise.race([
  p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${s} s`)), s * 1000)),
]);

export class WebLorax implements LoraxTransport {
  onReply: ((b: number[]) => void) | null = null;
  onEvent: ((b: number[]) => void) | null = null;
  onDrop: ((why: string) => void) | null = null;
  private cmd: any = null;
  private chain: Promise<unknown> = Promise.resolve();
  private gen = 0;
  private closing = false;
  private listening = false;

  constructor(readonly device: any, private readonly log: (s: string) => void) {}
  get id(): string { return this.device.id; }
  get name(): string | null { return this.device.name ?? null; }

  open(done: (err: string | null, version: number[] | null) => void): void {
    const gen = ++this.gen;
    this.closing = false;
    this.cmd = null;
    this.chain = Promise.resolve();
    if (!this.listening) {
      this.listening = true;
      this.device.addEventListener("gattserverdisconnected", () => {
        if (this.closing) { this.log("PEAK GATT closed (by Torchless)."); return; }
        this.cmd = null;
        this.onDrop?.("the Peak disconnected");
      });
    }
    (async () => {
      const server = this.device.gatt.connected ? this.device.gatt : await withTimeout(this.device.gatt.connect(), 15, "GATT connect");
      this.log("PEAK GATT connected. Looking for the Lorax service…");
      let svc: any;
      try { svc = await withTimeout(server.getPrimaryService(LORAX_SERVICE), 8, "Lorax service"); }
      catch (e) {
        let legacy = false;
        try { await server.getPrimaryService(LEGACY_SERVICE); legacy = true; } catch { /* not that either */ }
        throw new Error(legacy ? "This Peak has old firmware. Update it once in Puffco's app, then try again." : `No Lorax service (${msg(e)})`);
      }
      const [ver, cmd, reply, event] = await Promise.all([
        svc.getCharacteristic(LoraxChar.version), svc.getCharacteristic(LoraxChar.command),
        svc.getCharacteristic(LoraxChar.reply), svc.getCharacteristic(LoraxChar.event),
      ]);
      const p = cmd.properties;
      this.log(`PEAK command characteristic: write ${!!p.write}, writeWithoutResponse ${!!p.writeWithoutResponse}`);
      // Reading the version is what starts pairing on iPhone / Mac. It can take a while the first time
      // (the system pairing pop-up), so give it longer.
      const dv: DataView = await withTimeout(ver.readValue(), 30, "Version read (pairing)");
      const version = Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
      reply.addEventListener("characteristicvaluechanged", (ev: any) => {
        if (gen !== this.gen) return;
        const v: DataView = ev.target.value;
        this.onReply?.(Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)));
      });
      event.addEventListener("characteristicvaluechanged", (ev: any) => {
        if (gen !== this.gen) return;
        const v: DataView = ev.target.value;
        this.onEvent?.(Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)));
      });
      await reply.startNotifications();
      try { await event.startNotifications(); } catch (e) { this.log(`PEAK event notifications not available: ${msg(e)}`); }
      this.cmd = cmd;
      return version;
    })().then(v => { if (gen === this.gen) done(null, v); }, e => { if (gen === this.gen) done(msg(e), null); });
  }

  send(bytes: number[]): void {
    const cmd = this.cmd, gen = this.gen;
    if (!cmd) { this.log(`PEAK send with no link, dropped: ${hex(bytes)}`); return; }
    const data = new Uint8Array(bytes);
    this.chain = this.chain.then(async () => {
      if (gen !== this.gen) return;
      try {
        if (cmd.properties.writeWithoutResponse && typeof cmd.writeValueWithoutResponse === "function") await cmd.writeValueWithoutResponse(data);
        else if (typeof cmd.writeValueWithResponse === "function") await cmd.writeValueWithResponse(data);
        else await cmd.writeValue(data);
      } catch (e) { this.log(`PEAK write failed: ${msg(e)} (${hex(bytes)})`); }
    });
  }

  close(): void {
    this.gen += 1;
    this.closing = true;
    this.cmd = null;
    try { if (this.device.gatt.connected) this.device.gatt.disconnect(); } catch { /* gone */ }
  }
}

/** Picks Switch or Peak for a device from the chooser. Name first (no extra Bluetooth work for a Switch);
 *  for a renamed rig, a quick look at its services. */
export async function isPeakDevice(device: any, log: (s: string) => void): Promise<boolean> {
  const name: string = device.name ?? "";
  if (/peak|puffco|proxy/i.test(name)) { log(`Chooser pick "${name}": Puffco by name.`); return true; }
  if (/switch|dabber|presh|torchless/i.test(name)) return false;
  log(`Chooser pick "${name || "(no name)"}": checking its services for a Puffco…`);
  try {
    const server = device.gatt.connected ? device.gatt : await withTimeout(device.gatt.connect(), 10, "GATT connect");
    const list: any[] = await withTimeout(server.getPrimaryServices(), 6, "service list");
    const ids = list.map(s => String(s.uuid).toLowerCase());
    log(`Services: ${ids.join(", ")}`);
    return ids.includes(LORAX_SERVICE) || ids.includes(LEGACY_SERVICE);
  } catch (e) {
    log(`Service check failed (${msg(e)}); treating it as a Switch.`);
    return false;
  }
}
