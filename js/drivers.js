// A driver turns UI settings into packets for one protocol and folds replies back into page state.
//   probe()   -> true (device answered correctly) / false (wrong or no answer) / null (can't tell)
//   readAll() / poll() -> partial state
//   apply(key, value) -> { updates, mismatch?, unverified? }
// State keys: firmware, firmwareNum, sampleRate, volumeLevel, volumeDb, balance, filter, gain,
//             dacMode, dreEnabled, ledOn, micGain.

import * as P from './protocol.js';
import * as S from './space2.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const fmtDb = (db) => (db === 0 ? '0' : db.toFixed(1).replace(/\.0$/, ''));

const VOLUME_CONFIRM_DB = 10;
const VOLUME_CONFIRM_STEPS = 10;

export function createDriver(mode, transport, log) {
  return mode.protocol === 'space2' ? new Space2Driver(mode, transport, log) : new LunaDriver(mode, transport, log);
}

// ---------------------------------------------------------------------------------------------
// LUNA protocol (LUNA, LUNA AT, SPACE): 7-byte commands, 8-byte replies over EP0 (WebUSB) or
// write-only output reports (WebHID).

class LunaDriver {
  filters = P.FILTERS;
  gains = P.GAINS;
  dacModes = P.DAC_MODES;

  constructor(mode, transport, log) {
    this.mode = mode;
    this.t = transport;
    this.log = log;
    this.canRead = transport.kind === 'webusb';
  }

  get volumeMax() { return P.VOLUME_MAX_LEVEL; }
  get volumeUnit() { return 'dB'; }
  volumeText(level) { return fmtDb(P.dbForVolumeByte(P.volumeByteForLevel(level))); }

  volumeConfirm(state, level) {
    const target = P.dbForVolumeByte(P.volumeByteForLevel(level));
    const current = state.volumeDb;
    if (current === null) {
      return target > -40 ? `현재 볼륨을 알 수 없습니다. ${fmtDb(target)} dB로 설정할까요?` : null;
    }
    return target - current > VOLUME_CONFIRM_DB
      ? `볼륨을 ${fmtDb(current)} dB에서 ${fmtDb(target)} dB로 크게 올립니다. 계속할까요?` : null;
  }

  async #exchange(cmd) {
    this.log(`TX ${P.toHex(cmd)}`);
    const reply = this.canRead ? await this.t.controlExchange(cmd) : await this.t.exchange(cmd);
    if (reply) this.log(`RX ${P.toHex(reply)}`);
    return reply;
  }

  // Reads one value. Retries once on a stale/rejected reply.
  async #read(cmd) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const parsed = P.parseReply(await this.#exchange(P.readCommand(cmd)));
      if (parsed.cmd === cmd && parsed.kind !== 'rejected' && parsed.kind !== 'ack') return toLunaState(parsed);
      this.log(`  응답이 맞지 않음 (${parsed.kind}), 다시 시도`);
    }
    throw new Error(`읽기 실패: 0x${P.hex2(cmd)}`);
  }

  async probe() {
    if (!this.canRead) return null;
    try {
      await this.#read(P.CMD.READ_FIRMWARE);
      return true;
    } catch (e) {
      this.log(`  확인 실패: ${e.message}`);
      return false;
    }
  }

  async readAll() {
    const cmds = [P.CMD.READ_FIRMWARE, P.CMD.READ_VOLUME];
    if (this.mode.features.sampleRate) cmds.push(P.CMD.READ_SAMPLE_RATE);
    cmds.push(P.CMD.READ_CONFIG_1, P.CMD.READ_CONFIG_2);
    const out = {};
    for (const c of cmds) Object.assign(out, await this.#read(c));
    return out;
  }

  async poll() {
    const out = {};
    if (this.mode.features.sampleRate) Object.assign(out, await this.#read(P.CMD.READ_SAMPLE_RATE));
    Object.assign(out, await this.#read(P.CMD.READ_VOLUME));
    return out;
  }

  #plan(key, value) {
    switch (key) {
      case 'volume': {
        const byte = P.volumeByteForLevel(value);
        return [P.setVolumeLevel(value), { volumeLevel: value, volumeDb: P.dbForVolumeByte(byte) }, P.CMD.READ_VOLUME];
      }
      case 'balance': return [P.setBalance(value), { balance: value }, P.CMD.READ_VOLUME];
      case 'filter': return [P.setFilter(value), { filter: value }, P.CMD.READ_CONFIG_1];
      case 'gain': return [P.setGain(value), { gain: value }, P.CMD.READ_CONFIG_1];
      case 'led': return [P.setLed(value), { ledOn: value }, P.CMD.READ_CONFIG_1];
      case 'dacMode': return [P.setDacMode(value), { dacMode: value }, P.CMD.READ_CONFIG_2];
      case 'dre': return [P.setDre(value), { dreEnabled: value }, P.CMD.READ_CONFIG_2];
      default: throw new Error(`지원하지 않는 설정: ${key}`);
    }
  }

  async apply(key, value) {
    const [cmd, expect, verifyCmd] = this.#plan(key, value);
    if (!this.canRead) {
      await this.#exchange(cmd);
      return { updates: expect, unverified: true };
    }
    let reply = P.parseReply(await this.#exchange(cmd));
    if (reply.kind === 'rejected') {
      this.log('  장치가 명령을 거부함, 다시 시도');
      await sleep(300);
      reply = P.parseReply(await this.#exchange(cmd));
      if (reply.kind === 'rejected') throw new Error('장치가 명령을 거부했습니다.');
    }
    const updates = await this.#read(verifyCmd);
    const mismatch = Object.keys(expect).find((k) => k !== 'volumeDb' && updates[k] !== expect[k]) ?? null;
    return { updates, mismatch };
  }
}

function toLunaState(p) {
  switch (p.kind) {
    case 'firmware': return { firmware: String(p.firmware), firmwareNum: p.firmware };
    case 'sampleRate': return { sampleRate: p.label };
    case 'volume': return {
      volumeLevel: P.levelForVolumeByte(p.volumeByte), volumeDb: P.dbForVolumeByte(p.volumeByte), balance: p.balance,
    };
    case 'config1': return { filter: p.filter, gain: p.gain, ledOn: p.ledOn };
    case 'config2': return { dacMode: p.dacMode, dreEnabled: p.dreEnabled };
    default: return {};
  }
}

// ---------------------------------------------------------------------------------------------
// SPACE II protocol (UNVERIFIED): 64-byte HID reports, replies as input reports.

const shortHex = (bytes) => {
  let end = bytes.length;
  while (end > 8 && bytes[end - 1] === 0) end--;
  return P.toHex(bytes.subarray(0, end)) + (end < bytes.length ? ' …' : '');
};

class Space2Driver {
  filters = P.FILTERS.map((f, i) => ({ ...f, code: S.FILTER_CODES[i] }));
  gains = P.GAINS;
  dacModes = P.DAC_MODES;

  constructor(mode, transport, log) {
    this.mode = mode;
    this.t = transport;
    this.log = log;
    this.canRead = true; // confirmed by probe()
  }

  get volumeMax() { return S.VOLUME_MAX_STEP; }
  get volumeUnit() { return `/ ${S.VOLUME_MAX_STEP}`; }
  volumeText(level) { return String(level); }

  volumeConfirm(state, level) {
    const current = state.volumeLevel;
    if (current === null) {
      return level > 20 ? `현재 볼륨을 알 수 없습니다. ${level}단계로 설정할까요?` : null;
    }
    return level - current > VOLUME_CONFIRM_STEPS
      ? `볼륨을 ${current}단계에서 ${level}단계로 크게 올립니다. 계속할까요?` : null;
  }

  async #send(packet, match = null) {
    this.log(`TX ${shortHex(packet)}`);
    const reply = await this.t.exchange(packet, match);
    if (reply) this.log(`RX ${shortHex(reply)}`);
    else if (match) this.log('  응답 없음');
    return reply;
  }

  async #read(reg, channel = null) {
    const packet = channel === null ? S.readCommand(reg) : S.readBalanceCommand(channel);
    const reply = await this.#send(packet, S.isReplyTo(reg, channel));
    const parsed = reply && S.parseReply(reply);
    if (!parsed) throw new Error(`읽기 실패: 0x${P.hex2(reg)}`);
    return parsed;
  }

  async #readBalance() {
    const left = await this.#read(S.REG.BALANCE, S.CHANNEL.LEFT);
    const right = await this.#read(S.REG.BALANCE, S.CHANNEL.RIGHT);
    return { balance: S.balanceFromLevels(left.level, right.level) };
  }

  async #readState(reg) {
    if (reg === S.REG.BALANCE) return this.#readBalance();
    const p = await this.#read(reg);
    if ('volumeStep' in p) return { volumeLevel: p.volumeStep, volumeDb: null };
    if ('firmware' in p) return { firmware: p.firmware, firmwareNum: null };
    return p;
  }

  async probe() {
    try {
      await this.#read(S.REG.FIRMWARE);
      return true;
    } catch (e) {
      this.log(`  확인 실패: ${e.message}`);
      return false;
    }
  }

  async readAll() {
    const out = {};
    for (const reg of [S.REG.FIRMWARE, S.REG.VOLUME, S.REG.FILTER, S.REG.GAIN, S.REG.DAC_MODE, S.REG.DRE,
      S.REG.MIC_GAIN, S.REG.BALANCE]) {
      Object.assign(out, await this.#readState(reg));
    }
    return out;
  }

  poll() { return this.#readState(S.REG.VOLUME); }

  #plan(key, value) {
    switch (key) {
      case 'volume': return [[S.setVolumeStep(value)], { volumeLevel: value, volumeDb: null }, S.REG.VOLUME];
      case 'balance': return [S.setBalance(value), { balance: value }, S.REG.BALANCE];
      case 'filter': return [[S.setFilter(value)], { filter: value }, S.REG.FILTER];
      case 'gain': return [[S.setGain(value)], { gain: value }, S.REG.GAIN];
      case 'dacMode': return [[S.setDacMode(value)], { dacMode: value }, S.REG.DAC_MODE];
      case 'dre': return [[S.setDre(value)], { dreEnabled: value }, S.REG.DRE];
      case 'micGain': return [[S.setMicGain(value)], { micGain: value }, S.REG.MIC_GAIN];
      default: throw new Error(`지원하지 않는 설정: ${key}`);
    }
  }

  async apply(key, value) {
    const [packets, expect, verifyReg] = this.#plan(key, value);
    for (const p of packets) await this.#send(p);
    let updates;
    try {
      updates = await this.#readState(verifyReg);
    } catch {
      return { updates: expect, unverified: true };
    }
    const mismatch = Object.keys(expect).find((k) => k !== 'volumeDb' && updates[k] !== expect[k]) ?? null;
    return { updates, mismatch };
  }
}
