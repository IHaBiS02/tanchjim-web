// TANCHJIM SPACE II protocol — UNVERIFIED (derived from the official Android app only).
// 64-byte packets over the HID interrupt endpoints.
//   read : 4B 80 <reg> 00 ...           reply: 4B 80 <reg> ...
//   write: 4B 01 <reg> <len> <data> ...  (the official app does not read anything back)
// The official app also sends a "save to flash" packet (4B 01 04) after volume changes.
// That is deliberately not implemented here.

export const PACKET_SIZE = 64;

export const REG = Object.freeze({
  FIRMWARE: 0x0c,
  VOLUME: 0x85,
  MIC_GAIN: 0x02, // "ADC gain"
  FILTER: 0x11,
  GAIN: 0x19, // "DAC gain"
  DAC_MODE: 0x1d,
  DRE: 0x32,
  BALANCE: 0x16,
});

export const CHANNEL = Object.freeze({ LEFT: 0x00, RIGHT: 0x01 });

// Same labels as LUNA, different codes.
export const FILTER_CODES = [0x01, 0x02, 0x03, 0x04, 0x05];
export const GAIN_CODES = [0x00, 0x01];
export const DAC_MODE_CODES = [0x00, 0x01];
export const VOLUME_MAX_STEP = 60;
export const MIC_GAIN_RANGE = Object.freeze({ min: -60, max: 12 });

function packet(...bytes) {
  const p = new Uint8Array(PACKET_SIZE);
  p.set(bytes.map((b) => b & 0xff));
  return p;
}

// ---------- reads ----------

export const readCommand = (reg) => packet(0x4b, 0x80, reg);
export const readBalanceCommand = (channel) => packet(0x4b, 0x80, REG.BALANCE, 0x02, channel);

// Reply matchers (replies arrive as HID input reports).
export const isReplyTo = (reg, channel = null) => (r) =>
  r.length >= 8 && r[0] === 0x4b && r[1] === 0x80 && r[2] === reg && (channel === null || r[4] === channel);

// ---------- writes ----------

export const setVolumeStep = (step) => packet(0x4b, 0x01, REG.VOLUME, 0x01, clamp(step, 0, VOLUME_MAX_STEP));
export const setGain = (code) => packet(0x4b, 0x01, REG.GAIN, 0x01, code);
export const setFilter = (code) => packet(0x4b, 0x01, REG.FILTER, 0x01, code);
export const setDacMode = (code) => packet(0x4b, 0x01, REG.DAC_MODE, 0x01, code);
export const setDre = (enabled) => packet(0x4b, 0x01, REG.DRE, 0x01, enabled ? 0x00 : 0x01);
export const setMicGain = (db) =>
  packet(0x4b, 0x01, REG.MIC_GAIN, 0x02, 0x00, clamp(Math.round(db), MIC_GAIN_RANGE.min, MIC_GAIN_RANGE.max));

// Per-channel level in dB as signed 8.8 fixed point, little endian.
export function setChannelLevel(channel, db) {
  const v = clamp(Math.round(db * 256), -32768, 32767) & 0xffff;
  return packet(0x4b, 0x01, REG.BALANCE, 0x04, channel, v & 0xff, v >> 8);
}

// Balance in dB: negative = towards the left (right channel attenuated), like the LUNA UI.
export function setBalance(db) {
  const left = db > 0 ? -db : 0;
  const right = db < 0 ? db : 0;
  return [setChannelLevel(CHANNEL.LEFT, left), setChannelLevel(CHANNEL.RIGHT, right)];
}

// ---------- reply parsing (mirrors the official app) ----------

export function parseReply(r) {
  if (!r || r.length < 8 || r[0] !== 0x4b || r[1] !== 0x80) return null;
  switch (r[2]) {
    case REG.FIRMWARE:
      return { firmware: `V${ascii(r[4])}${ascii(r[5])}${ascii(r[6])}` };
    case REG.VOLUME:
      return { volumeStep: r[4] };
    case REG.GAIN:
      return { gain: r[4] };
    case REG.FILTER:
      return { filter: r[4] };
    case REG.DAC_MODE:
      return { dacMode: r[4] };
    case REG.DRE:
      return { dreEnabled: r[4] === 0x00 };
    case REG.MIC_GAIN:
      return { micGain: r[5] > 128 ? r[5] - 256 : r[5] };
    case REG.BALANCE: {
      // The app reads bytes 6..7 as a big-endian 8.8 value.
      let v = (r[6] << 8) | r[7];
      if (v >= 0x8000) v -= 0x10000;
      return { channel: r[4], level: v / 256 };
    }
    default:
      return null;
  }
}

// Combines per-channel levels back into one balance value (negative = towards the left).
export function balanceFromLevels(left, right) {
  if (right) return right;
  if (left) return Math.abs(left);
  return 0;
}

const ascii = (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '');
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
