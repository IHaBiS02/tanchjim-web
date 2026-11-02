// TANCHJIM LUNA control protocol.
// Every command is 7 bytes: C1 A5 <cmd> <p1> <p2> <p3> <p4>.
// Replies are 8 bytes: A1 A5 <cmd> ... (the device answers C1 A5 ... when it rejects a command).
// See PROTOCOL.md for how this was derived and verified.

export const VENDOR_ID = 0x2fc6;
// Only LUNA AT has been verified on real hardware.
export const DEVICES = [{ vendorId: VENDOR_ID, productId: 0xf0f0, name: 'TANCHJIM-LUNA AT' }];

// Other Comtrue-based TANCHJIM products may share the same VID/PID, so the USB product string is
// checked too (the official app also tells models apart by name). Some platforms prefix the
// manufacturer ("TANCHJIM TANCHJIM-LUNA AT"), which is accepted.
export function identifyDevice(vendorId, productId, productName) {
  const name = (productName ?? '').trim();
  return DEVICES.find((d) => d.vendorId === vendorId && d.productId === productId
    && (name === d.name || name.endsWith(` ${d.name}`))) ?? null;
}

export const CMD = Object.freeze({
  FILTER: 0x01,
  GAIN: 0x02,
  VOLUME: 0x04,
  BALANCE: 0x05,
  LED: 0x06,
  DAC_MODE: 0x08,
  DRE: 0x09,
  READ_FIRMWARE: 0xa0,
  READ_SAMPLE_RATE: 0xa1,
  READ_VOLUME: 0xa2,
  READ_CONFIG_1: 0xa3, // filter, gain, LED
  READ_CONFIG_2: 0xa4, // DAC mode, DRE
});

export const READ_ALL = [
  CMD.READ_FIRMWARE,
  CMD.READ_VOLUME,
  CMD.READ_SAMPLE_RATE,
  CMD.READ_CONFIG_1,
  CMD.READ_CONFIG_2,
];

export const FILTERS = [
  { code: 0x00, label: '저지연 · 빠른 롤오프', hint: 'Low latency, fast roll-off' },
  { code: 0x01, label: '위상 보상 · 빠른 롤오프', hint: 'Phase compensated, fast roll-off' },
  { code: 0x02, label: '저지연 · 느린 롤오프', hint: 'Low latency, slow roll-off' },
  { code: 0x03, label: '위상 보상 · 느린 롤오프', hint: 'Phase compensated, slow roll-off' },
  { code: 0x04, label: 'NOS', hint: 'Non over-sampling' },
];

export const GAINS = [
  { code: 0x00, label: 'Low', hint: '2 Vrms' },
  { code: 0x01, label: 'High', hint: '4 Vrms' },
];

export const DAC_MODES = [
  { code: 0x00, label: 'Class AB' },
  { code: 0x01, label: 'Class H' },
];

// LED is only meaningful on SPACE (the official app hides it for LUNA; LUNA AT has no LED).
// Kept here for completeness; the UI does not expose it.
export const LED = Object.freeze({ ON: 0x00, OFF: 0x02 });

// DRE is only available from this firmware version on.
export const DRE_MIN_FIRMWARE = 7;

// Volume byte = attenuation in 0.5 dB steps (0x00 = 0 dB, 0xFF = -127.5 dB).
// These are the 61 steps the official app offers.
const VOLUME_BYTES = [
  0xff, 0xdc, 0xc8, 0xbe, 0xb6, 0xae, 0xa6, 0x9e, 0x96, 0x90, 0x8a, 0x84, 0x7e, 0x78, 0x72, 0x6e,
  0x6c, 0x6a, 0x68, 0x66, 0x64, 0x63, 0x62, 0x61, 0x60, 0x5f, 0x5e, 0x5d, 0x5c, 0x5b, 0x5a, 0x59,
  0x58, 0x57, 0x56, 0x55, 0x54, 0x53, 0x52, 0x51, 0x50, 0x4e, 0x4c, 0x4a, 0x48, 0x46, 0x44, 0x40,
  0x3c, 0x38, 0x34, 0x30, 0x2c, 0x28, 0x24, 0x1e, 0x18, 0x12, 0x0c, 0x06, 0x00,
];
export const VOLUME_MAX_LEVEL = VOLUME_BYTES.length - 1;
export const volumeByteForLevel = (level) => VOLUME_BYTES[clamp(level, 0, VOLUME_MAX_LEVEL)];
export const dbForVolumeByte = (byte) => -byte / 2;
export function levelForVolumeByte(byte) {
  let best = 0;
  for (let i = 0; i < VOLUME_BYTES.length; i++) {
    if (Math.abs(VOLUME_BYTES[i] - byte) < Math.abs(VOLUME_BYTES[best] - byte)) best = i;
  }
  return best;
}

// Balance in dB. Negative = towards the left channel, positive = towards the right.
// Sent as 0.5 dB steps: C1 A5 05 <right byte> <left byte> 00 00 (the official app's naming).
export const BALANCE_LIMIT_DB = 20;

const SAMPLE_RATES = {
  0x00: '재생 중 아님',
  0x10: 'PCM 44.1 kHz', 0x11: 'PCM 48 kHz', 0x12: 'PCM 88.2 kHz', 0x13: 'PCM 96 kHz',
  0x14: 'PCM 176.4 kHz', 0x15: 'PCM 192 kHz', 0x16: 'PCM 352.8 kHz', 0x17: 'PCM 384 kHz',
  0x18: 'PCM 705.6 kHz', 0x19: 'PCM 768 kHz',
  0x20: 'DSD64 (DoP)', 0x21: 'DSD128 (DoP)', 0x22: 'DSD256 (DoP)', 0x23: 'DSD512 (DoP)',
  0x40: 'DSD64 (Native)', 0x41: 'DSD128 (Native)', 0x42: 'DSD256 (Native)', 0x43: 'DSD512 (Native)',
};
export const sampleRateLabel = (code) => SAMPLE_RATES[code] ?? `알 수 없음 (0x${hex2(code)})`;

// ---------- command builders ----------

export function command(cmd, ...params) {
  const out = new Uint8Array(7);
  out[0] = 0xc1;
  out[1] = 0xa5;
  out[2] = cmd;
  params.slice(0, 4).forEach((p, i) => { out[3 + i] = p & 0xff; });
  return out;
}

export const readCommand = (cmd) => command(cmd);
export const setFilter = (code) => command(CMD.FILTER, code);
export const setGain = (code) => command(CMD.GAIN, code);
export const setDacMode = (code) => command(CMD.DAC_MODE, code);
export const setLed = (on) => command(CMD.LED, on ? LED.ON : LED.OFF);
export const setDre = (enabled) => command(CMD.DRE, enabled ? 0x00 : 0x01);
export const setVolumeLevel = (level) => command(CMD.VOLUME, volumeByteForLevel(level));

export function setBalance(db) {
  const steps = Math.min(0xff, Math.round(Math.abs(db) * 2));
  // Official app: moving towards the left fills the 2nd parameter, towards the right the 1st.
  return db < 0 ? command(CMD.BALANCE, 0x00, steps) : command(CMD.BALANCE, steps, 0x00);
}

// ---------- reply parser ----------

export function parseReply(bytes) {
  const r = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (r.length < 4) return { kind: 'short' };
  if (r[0] === 0xc1 && r[1] === 0xa5) return { kind: 'rejected', cmd: r[2] };
  if (r[0] !== 0xa1 || r[1] !== 0xa5) return { kind: 'unknown' };
  const cmd = r[2];
  switch (cmd) {
    case CMD.READ_FIRMWARE:
      return { kind: 'firmware', cmd, firmware: r[3] };
    case CMD.READ_SAMPLE_RATE:
      return { kind: 'sampleRate', cmd, code: r[3], label: sampleRateLabel(r[3]) };
    case CMD.READ_VOLUME:
      // A1 A5 A2 ?? <volume> <right-ish> <left-ish>
      return { kind: 'volume', cmd, volumeByte: r[4], balance: balanceFromBytes(r[5], r[6]) };
    case CMD.READ_CONFIG_1:
      return { kind: 'config1', cmd, filter: r[3], gain: r[4], ledOn: r[5] === LED.ON };
    case CMD.READ_CONFIG_2:
      return { kind: 'config2', cmd, dacMode: r[3], dreEnabled: r[4] === 0x00 };
    default:
      return { kind: 'ack', cmd };
  }
}

// Mirrors the official app: second byte non-zero means "towards the left".
function balanceFromBytes(rightSteps, leftSteps) {
  if (leftSteps > 0) return -leftSteps / 2;
  return rightSteps / 2;
}

// ---------- helpers ----------

export const hex2 = (n) => n.toString(16).padStart(2, '0').toUpperCase();
export const toHex = (bytes) => Array.from(bytes, hex2).join(' ');
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
