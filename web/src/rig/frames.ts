// Port of FrameDecoder.swift. Byte positions were confirmed on the real rig.

export interface LiveStatus {
  preset: number;
  lightMode: number;
  sessionByte: number;
  autoShutOff: number;
  autoShutOffRemaining: number;
  tempRaw: number;
  unitByte: number;
  sessionTimeRemaining: number;
  hapticsByte: number;
  sessionExtend: number;
  battery: number;
  chargingByte: number;
  brightness: number;
}

export const sessionOnOf = (s: LiveStatus) => s.sessionByte === 170;
export const hapticsOf = (s: LiveStatus) => s.hapticsByte === 170;
export const chargingOf = (s: LiveStatus) => s.chargingByte === 170;
export function unitText(s: LiveStatus): string {
  if (s.unitByte === 15) return "F";
  if (s.unitByte === 12) return "C";
  return `? (${s.unitByte})`;
}

export type DecodedFrame =
  | { kind: "status"; status: LiveStatus }
  | { kind: "info"; key: string; value: string }
  | { kind: "unknown"; why: string };

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");
export const hexString = (b: ArrayLike<number>) => Array.from(b, hex2).join(" ");

function u16(b: number[], i: number): number | null {
  return i + 1 < b.length ? (b[i] << 8) | b[i + 1] : null;
}
function u32(b: number[], i: number): number | null {
  if (i + 3 >= b.length) return null;
  let v = 0;
  for (let k = 0; k < 4; k++) v = v * 256 + b[i + k];
  return v;
}
function ascii(b: number[], from: number, to: number): string {
  if (from >= b.length) return "";
  const end = Math.min(to, b.length - 1);
  if (from > end) return "";
  return String.fromCharCode(...b.slice(from, end + 1).filter(c => c >= 32 && c < 127));
}

export function decodeFrame(b: number[]): DecodedFrame {
  if (b.length === 0) return { kind: "unknown", why: "empty frame" };
  const cmd = b[0];
  switch (cmd) {
    case 169: {
      const temp = u16(b, 10);
      if (b.length < 19 || temp === null) return { kind: "unknown", why: `short 0xA9 status frame (${b.length} bytes)` };
      return {
        kind: "status",
        status: {
          preset: b[3], lightMode: b[6], sessionByte: b[7], autoShutOff: b[8], autoShutOffRemaining: b[9],
          tempRaw: temp, unitByte: b[12], sessionTimeRemaining: b[13], hapticsByte: b[14],
          sessionExtend: b[15], battery: b[16], chargingByte: b[17], brightness: b[18],
        },
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

function decodeAnalytics(b: number[]): DecodedFrame {
  if (b.length < 2) return { kind: "unknown", why: "short 0xA2 frame" };
  const variant = b[1];
  switch (variant) {
    case 20: {
      if (b.length < 18) return { kind: "unknown", why: `short 0xA2 (len 20) frame (${b.length} bytes)` };
      const v = (i: number) => u16(b, i) ?? 0;
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
      const counts: string[] = [];
      for (let k = 0; k < 5; k++) { const v = u16(b, 2 + k * 2); if (v !== null) counts.push(String(v)); }
      return { kind: "info", key: "Analytics profile cycles (0xA2/13)", value: counts.join(", ") };
    }
    default:
      return { kind: "info", key: `Analytics (0xA2, variant ${variant})`, value: "raw: " + hexString(b) };
  }
}
