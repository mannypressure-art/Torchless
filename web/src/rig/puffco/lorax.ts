// Puffco Peak Pro "Lorax" Bluetooth protocol: constants, packets, login token, value parsing.
// Built from public open-source work (PuffcoBLE, HA-Puff, peakhaus, puffco-remote; all MIT) and our notes in
// project files puffco/Puffco-protocol-notes.md. Not tested on a real Peak yet. Torchless is not affiliated
// with Puffco. No Puffco code is copied here; only the protocol facts those projects publish.

/** Current firmware ("Lorax"): one command channel addressed by text paths. */
export const LORAX_SERVICE = "e276967f-ea8a-478a-a92e-d78f5dd15dd5";
/** Old firmware (W / X): one characteristic per value. We don't drive it; we ask for a firmware update. */
export const LEGACY_SERVICE = "06caf9c0-74d3-454f-9be9-e30cd999c17a";
export const DEVICE_INFO_SERVICE = "0000180a-0000-1000-8000-00805f9b34fb";

export const LoraxChar = {
  /** Read first. Reading it is what makes iPhone and Mac start pairing. First 2 bytes: protocol version (LE). */
  version: "05434bca-cc7f-4ef6-bbb3-b1c520b9800c",
  command: "60133d5c-5727-4f2c-9697-d842c5292a3c",
  reply: "8dc5ec05-8f7d-45ad-99db-3fbde65dbd9c",
  event: "43312cd1-7d34-46ce-a7d3-0a98fd9b4cb8",
} as const;

/** Names Puffco rigs advertise by default (owners can rename them, so the app also checks the service). */
export const PEAK_NAME_PREFIXES = ["Peak", "PEAK", "Puffco", "Proxy"];
export const looksLikePuffco = (name: string | null | undefined) => !!name && /peak|puffco|proxy/i.test(name);

export const Op = {
  GET_ACCESS_SEED: 0x00, UNLOCK_ACCESS: 0x01, GET_LIMITS: 0x02, ACK_EVENTS: 0x03,
  READ_SHORT: 0x10, WRITE_SHORT: 0x11, STAT_SHORT: 0x12,
} as const;
export const opName = (op: number) => (Object.entries(Op).find(([, v]) => v === op)?.[0] ?? `OP_${op.toString(16)}`);

export const Path = {
  modeCommand: "/p/app/mc",
  state: "/p/app/stat/id",
  elapsed: "/p/app/stat/elap",
  total: "/p/app/stat/tott",
  heaterTemp: "/p/app/htr/temp",
  heaterTarget: "/p/app/htr/tcmd",
  activeProfile: "/p/app/hcs",
  activeTemp: "/p/app/thc/temp",
  activeTime: "/p/app/thc/time",
  battery: "/p/bat/soc",
  charging: "/p/bat/chg/stat",
  chamber: "/p/htr/chmt",
  dabs: "/p/app/odom/0/nc",
  name: "/u/sys/name",
  serial: "/p/sys/hw/ser",
  firmware: "/p/sys/fw/ver",
  profileName: (n: number) => `/u/app/hc/${n}/name`,
  profileTemp: (n: number) => `/u/app/hc/${n}/temp`,
  profileTime: (n: number) => `/u/app/hc/${n}/time`,
} as const;

/** Values written to /p/app/mc. */
export const Mode = { MASTER_OFF: 0, SLEEP: 1, IDLE: 2, HEAT_START: 7, HEAT_ABORT: 8, HEAT_BOOST: 9, BONDING: 11 } as const;

/** Values read from /p/app/stat/id. */
export const State = { OFF: 3, SLEEP: 4, IDLE: 5, TEMP_SELECT: 6, PREHEAT: 7, ACTIVE: 8, FADE: 9, BONDING: 13 } as const;
export function stateName(s: number | null): string {
  switch (s) {
    case 3: return "off"; case 4: return "sleep"; case 5: return "idle"; case 6: return "temp select";
    case 7: return "preheat"; case 8: return "active"; case 9: return "fade"; case 13: return "bonding";
    case null: return "unknown";
    default: return `state ${s}`;
  }
}
/** The heater is on (or about to be) in these states. */
export const isHeatingState = (s: number | null) => s === State.PREHEAT || s === State.ACTIVE;

// MARK: Bytes

export const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
export const utf8 = (s: string) => Array.from(new TextEncoder().encode(s));
export function f32le(x: number): number[] {
  const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, x, true); return Array.from(b);
}
function dv(b: number[]): DataView { return new DataView(Uint8Array.from(b).buffer); }
export const readF32 = (b: number[]) => dv(b).getFloat32(0, true);
export const readU32 = (b: number[]) => dv(b).getUint32(0, true);
export const readI32 = (b: number[]) => dv(b).getInt32(0, true);
export const hex = (b: ArrayLike<number>) => Array.from(b, n => n.toString(16).toUpperCase().padStart(2, "0")).join(" ");
export const text = (b: number[]) => String.fromCharCode(...b.filter(c => c >= 32 && c < 127)).trim();

/** Packet the app sends: seq (u16 LE) + opcode + body. */
export function packet(seq: number, op: number, body: number[] = []): number[] { return [...u16le(seq), op & 0xff, ...body]; }
export const readShortBody = (path: string, maxLen = 64, offset = 0) => [...u16le(offset), ...u16le(maxLen), ...utf8(path)];
export const writeShortBody = (path: string, value: number[], offset = 0, flags = 0) =>
  [...u16le(offset), flags & 0xff, ...utf8(path), 0, ...value];

export interface Reply { seq: number; status: number; payload: number[] }
/** Reply the rig sends: seq (u16 LE) + status byte (0 = OK) + payload. */
export function parseReply(b: number[]): Reply | null {
  if (b.length < 3) return null;
  return { seq: b[0] | (b[1] << 8), status: b[2], payload: b.slice(3) };
}

// MARK: Values. Puffco sends temperatures as float32 °C; some firmware sends tenths as an int. Same checks as
// the public libraries: try the float, then the int forms, and give up (null) rather than guess.

export function parseTempC(b: number[]): number | null {
  if (b.length < 4) return null;
  const f = readF32(b);
  if (Number.isFinite(f) && f >= 5 && f <= 450) return f;
  const i = readI32(b);
  if (i >= 50 && i <= 4500) return i / 10;
  if (i >= 5 && i <= 450) return i;
  return null;
}
export function parseSeconds(b: number[]): number | null {
  if (b.length >= 4) {
    const i = readU32(b);
    if (i <= 100000) return i;                    // a plain whole number (a float this small would be ~0)
    const f = readF32(b);
    return Number.isFinite(f) && f >= 0 && f < 100000 ? f : null;
  }
  if (b.length === 2) return b[0] | (b[1] << 8);
  if (b.length === 1) return b[0];
  return null;
}
export function parseBattery(b: number[]): number | null {
  if (b.length === 0) return null;
  if (b.length === 1) return Math.min(100, b[0]);
  if (b.length >= 4) {
    const i = readU32(b);
    if (i <= 100) return i;                       // a plain whole number (a float this small would be ~0)
    const f = readF32(b);
    if (Number.isFinite(f) && f >= 0 && f <= 100) return Math.round(f);
    if (i <= 10000) return Math.min(100, Math.round(i / 100));
  }
  if (b.length === 2) return Math.min(100, b[0] | (b[1] << 8));
  return null;
}
export function parseCount(b: number[]): number | null {
  if (b.length >= 4) { const f = readF32(b); if (f >= 1 && f < 1e7 && Number.isInteger(f)) return f; return readU32(b); }
  if (b.length === 2) return b[0] | (b[1] << 8);
  if (b.length === 1) return b[0];
  return null;
}
export const cToF = (c: number) => c * 9 / 5 + 32;
export const fToC = (f: number) => (f - 32) * 5 / 9;

// MARK: Login. token = first 16 bytes of SHA-256(fixed 16-byte key + 16-byte seed from the rig).
// The key is the one published by every public Lorax library (taken from Puffco's own web app).

const KEY_B64 = "ZMZFYlbyb1scoSc3pd1x+w==";
export function loraxKey(): number[] {
  const s = atobSafe(KEY_B64);
  return Array.from(s, c => c.charCodeAt(0));
}
function atobSafe(b64: string): string {
  if (typeof atob === "function") return atob(b64);
  return Buffer.from(b64, "base64").toString("binary");
}
export function unlockToken(seed: number[]): number[] {
  return sha256([...loraxKey(), ...seed.slice(0, 16)]).slice(0, 16);
}

// Plain SHA-256 (FIPS 180-4), synchronous so the bench runs on its virtual clock. Checked against Node's
// crypto in the Peak bench.
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
export function sha256(data: number[]): number[] {
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const bitLen = data.length * 8;
  const msg = [...data, 0x80];
  while (msg.length % 64 !== 56) msg.push(0);
  const hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0;
  msg.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
  const w = new Array<number>(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let i = 0; i < msg.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = (msg[i + 4 * t] << 24) | (msg[i + 4 * t + 1] << 16) | (msg[i + 4 * t + 2] << 8) | msg[i + 4 * t + 3];
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[t] + w[t]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
  const out: number[] = [];
  for (const x of h) out.push((x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255);
  return out;
}
