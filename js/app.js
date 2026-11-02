import * as P from './protocol.js';
import { UsbTransport, HidTransport } from './transport.js';

const POLL_MS = 3000;
const VOLUME_CONFIRM_DB = 10;
const STORAGE_KEY = 'luna-control.last-sent';

const $ = (id) => document.getElementById(id);
const isWindows = /Windows/i.test(navigator.userAgentData?.platform ?? navigator.userAgent);
// On Windows WebUSB can't open an audio device, so WebHID is the default there.
const PRIMARY = isWindows ? HidTransport : UsbTransport;
const SECONDARY = isWindows ? UsbTransport : HidTransport;

const EMPTY = {
  firmware: null, sampleRate: null, volumeByte: null, balance: null,
  filter: null, gain: null, dacMode: null, dreEnabled: null,
};
const state = { transport: null, ...EMPTY };
let pollTimer = null;
let dragging = { volume: false, balance: false };

// ---------- logging / feedback ----------

function log(text) {
  const el = $('log');
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  el.textContent += `${time}  ${text}\n`;
  const lines = el.textContent.split('\n');
  if (lines.length > 400) el.textContent = lines.slice(-400).join('\n');
  el.scrollTop = el.scrollHeight;
}

let toastTimer;
function toast(text, isError = false) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('error', isError);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.textContent = ''; }, isError ? 8000 : 3000);
}

// ---------- device I/O ----------

async function exchange(cmd) {
  const t = state.transport;
  if (!t) throw new Error('연결된 장치가 없습니다.');
  log(`TX ${P.toHex(cmd)}`);
  const reply = await t.exchange(cmd);
  if (reply) log(`RX ${P.toHex(reply)}`);
  return reply;
}

// Reads one value from the device and folds it into state. Retries once on a stale/rejected reply.
async function read(cmd) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const parsed = P.parseReply(await exchange(P.readCommand(cmd)));
    if (parsed.cmd === cmd && parsed.kind !== 'rejected') {
      absorb(parsed);
      return parsed;
    }
    log(`  응답이 맞지 않음 (${parsed.kind}), 다시 시도`);
  }
  throw new Error(`읽기 실패: 0x${P.hex2(cmd)}`);
}

function absorb(p) {
  switch (p.kind) {
    case 'firmware': state.firmware = p.firmware; break;
    case 'sampleRate': state.sampleRate = p.code; break;
    case 'volume':
      if (!dragging.volume) state.volumeByte = p.volumeByte;
      if (!dragging.balance) state.balance = p.balance;
      break;
    case 'config1': state.filter = p.filter; state.gain = p.gain; break;
    case 'config2': state.dacMode = p.dacMode; state.dreEnabled = p.dreEnabled; break;
  }
}

async function readAll() {
  for (const cmd of P.READ_ALL) await read(cmd);
  render();
}

// Sends a setting. With WebUSB the device state is read back afterwards; with WebHID we can only
// remember what was sent.
async function apply(cmd, optimistic, verifyCmd, description) {
  try {
    if (!state.transport.canRead) {
      await exchange(cmd);
      Object.assign(state, optimistic);
      saveLastSent();
      render();
      toast(`${description} — 전송함`);
      return;
    }
    let reply = P.parseReply(await exchange(cmd));
    if (reply.kind === 'rejected') {
      log('  장치가 명령을 거부함, 다시 시도');
      await new Promise((r) => setTimeout(r, 300));
      reply = P.parseReply(await exchange(cmd));
      if (reply.kind === 'rejected') throw new Error('장치가 명령을 거부했습니다.');
    }
    await read(verifyCmd);
    render();
    const mismatch = Object.entries(optimistic).find(([k, v]) => state[k] !== v);
    if (mismatch) toast(`${description} — 장치 값이 다릅니다 (${mismatch[0]}). 로그를 확인하세요.`, true);
    else toast(`${description} — 적용됨`);
  } catch (e) {
    handleIoError(e);
  }
}

function handleIoError(e) {
  log(`오류: ${e.name ?? ''} ${e.message}`);
  toast(`오류: ${e.message}`, true);
  render();
}

// ---------- connection ----------

async function connectWith(Transport, transport) {
  try {
    const t = transport ?? await Transport.request();
    await t.open();
    await useTransport(t);
  } catch (e) {
    if (e.name === 'NotFoundError') { log('장치 선택이 취소됨'); return; }
    log(`연결 실패: ${e.name} ${e.message}`);
    toast(connectErrorHint(Transport, e), true);
    if (Transport === UsbTransport || /Linux/i.test(navigator.userAgent)) $('help').open = true;
  }
}

function connectErrorHint(Transport, e) {
  const linux = /Linux/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent);
  if (linux && (e.name === 'SecurityError' || e.name === 'NetworkError' || e.name === 'NotAllowedError')) {
    return '장치에 접근할 권한이 없습니다. 아래 도움말의 udev 규칙을 설치해 주세요.';
  }
  if (Transport === UsbTransport && isWindows) {
    return 'Windows에서는 WebUSB로 열 수 없습니다. WebHID(쓰기 전용)로 연결해 주세요.';
  }
  if (Transport === UsbTransport) {
    return `WebUSB로 열지 못했습니다 (${e.name}). WebHID로 연결해 보세요.`;
  }
  return `연결하지 못했습니다: ${e.message}`;
}

async function useTransport(t) {
  const { vendorId, productId } = t.device;
  if (!P.identifyDevice(vendorId, productId, t.productName)) {
    // Close before any command is sent.
    await t.close();
    const name = t.productName || '알 수 없음';
    log(`지원하지 않는 기기: ${name} (${P.hex2(vendorId >> 8)}${P.hex2(vendorId & 0xff)}:${P.hex2(productId >> 8)}${P.hex2(productId & 0xff)}) — 명령을 보내지 않고 닫음`);
    toast(`지원하지 않는 기기입니다 (제품명: ${name}). 현재는 LUNA AT만 지원합니다.`, true);
    return;
  }
  await disconnect(false);
  Object.assign(state, EMPTY, { transport: t });
  log(`연결됨: ${t.name} (${t.kind === 'webusb' ? 'WebUSB' : 'WebHID'})`);
  if (t.canRead) {
    render();
    try {
      await readAll();
      toast('장치 상태를 읽었습니다.');
    } catch (e) { handleIoError(e); }
    startPolling();
  } else {
    loadLastSent();
    render();
    toast('WebHID로 연결했습니다 (쓰기 전용).');
  }
}

async function disconnect(userInitiated = true) {
  stopPolling();
  const t = state.transport;
  state.transport = null;
  if (t) {
    await t.close();
    if (userInitiated) log('연결 해제');
  }
  Object.assign(state, EMPTY);
  render();
}

function onDeviceGone(device) {
  if (state.transport?.device === device) {
    log('장치가 분리됨');
    toast('장치가 분리되었습니다.', true);
    disconnect(false);
  }
}

// Keeps the sample rate (and volume, which the inline remote may change) up to date.
function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    if (!state.transport?.canRead || document.visibilityState !== 'visible') return;
    try {
      await read(P.CMD.READ_SAMPLE_RATE);
      await read(P.CMD.READ_VOLUME);
      render();
    } catch (e) { log(`상태 갱신 실패: ${e.message}`); }
  }, POLL_MS);
}
function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

async function autoReconnect() {
  for (const T of [PRIMARY, SECONDARY]) {
    const [t] = await T.paired().catch(() => []);
    if (!t) continue;
    try {
      await t.open();
      await useTransport(t);
      return;
    } catch (e) {
      log(`자동 연결 실패 (${t.kind}): ${e.name}`);
    }
  }
}

// ---------- WebHID mode: remember what was sent ----------

function saveLastSent() {
  const { volumeByte, balance, filter, gain, dacMode, dreEnabled } = state;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ volumeByte, balance, filter, gain, dacMode, dreEnabled })); } catch { /* storage unavailable */ }
}
function loadLastSent() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved && typeof saved === 'object') {
      for (const k of Object.keys(EMPTY)) if (k in saved) state[k] = saved[k];
    }
  } catch { /* storage unavailable */ }
}

// ---------- UI ----------

function buildOptions() {
  $('filterOptions').innerHTML = P.FILTERS.map((f) => `
    <label class="option">
      <input type="radio" name="filter" value="${f.code}">
      <span>${f.label}<small>${f.hint}</small></span>
    </label>`).join('');
  $('gainOptions').innerHTML = P.GAINS.map((g) => `
    <label><input type="radio" name="gain" value="${g.code}">${g.label}<small>${g.hint}</small></label>`).join('');
  $('dacOptions').innerHTML = P.DAC_MODES.map((m) => `
    <label><input type="radio" name="dac" value="${m.code}">${m.label}</label>`).join('');
  $('volume').max = P.VOLUME_MAX_LEVEL;
  $('balance').min = -P.BALANCE_LIMIT_DB;
  $('balance').max = P.BALANCE_LIMIT_DB;
}

function setRadio(name, value) {
  document.querySelectorAll(`input[name="${name}"]`).forEach((el) => {
    el.checked = value !== null && Number(el.value) === value;
  });
}
const fmtDb = (db) => (db === 0 ? '0' : db.toFixed(1).replace(/\.0$/, ''));
function balanceLabel(db) {
  if (db === null) return '—';
  if (db === 0) return '가운데';
  return `${db < 0 ? '왼쪽' : '오른쪽'}으로 ${fmtDb(Math.abs(db))} dB`;
}

function render() {
  const t = state.transport;
  const connected = !!t;
  const canRead = !!t?.canRead;

  $('status').classList.toggle('on', connected);
  $('statusText').textContent = connected ? `${t.name} 연결됨` : '연결 안 됨';
  $('connectPrimary').hidden = connected;
  $('connectSecondary').hidden = connected;
  $('disconnect').hidden = !connected;
  $('writeOnlyNotice').hidden = !connected || canRead;
  $('controls').setAttribute('aria-disabled', String(!connected));

  $('infoName').textContent = t?.name ?? '—';
  $('infoFirmware').textContent = state.firmware ?? (connected && !canRead ? '읽을 수 없음' : '—');
  $('infoRate').textContent = state.sampleRate !== null ? P.sampleRateLabel(state.sampleRate)
    : (connected && !canRead ? '읽을 수 없음' : '—');
  $('infoTransport').textContent = !t ? '—' : (canRead ? 'WebUSB (읽기 + 쓰기)' : 'WebHID (쓰기 전용)');
  $('refresh').disabled = !canRead;

  document.querySelectorAll('#controls input, #controls button.step, #balanceCenter').forEach((el) => {
    el.disabled = !connected;
  });

  if (!dragging.volume) {
    if (state.volumeByte !== null) {
      $('volume').value = P.levelForVolumeByte(state.volumeByte);
      $('volumeDb').textContent = fmtDb(P.dbForVolumeByte(state.volumeByte));
    } else {
      $('volume').value = 0;
      $('volumeDb').textContent = '—';
    }
  }
  if (!dragging.balance) {
    $('balance').value = state.balance ?? 0;
    $('balanceText').textContent = balanceLabel(state.balance);
  }

  setRadio('filter', state.filter);
  setRadio('gain', state.gain);
  setRadio('dac', state.dacMode);

  const dre = $('dre');
  dre.indeterminate = state.dreEnabled === null;
  dre.checked = !!state.dreEnabled;
  const dreSupported = state.firmware === null || state.firmware >= P.DRE_MIN_FIRMWARE;
  $('dreRow').hidden = !dreSupported;

  const labels = { webusb: 'WebUSB로 연결', webhid: 'WebHID로 연결 (쓰기 전용)' };
  $('connectPrimary').textContent = labels[PRIMARY.kind];
  $('connectSecondary').textContent = labels[SECONDARY.kind];
  $('connectPrimary').disabled = !PRIMARY.isSupported();
  $('connectSecondary').hidden ||= !SECONDARY.isSupported();
}

// ---------- event wiring ----------

function currentVolumeDb() {
  return state.volumeByte === null ? null : P.dbForVolumeByte(state.volumeByte);
}

async function applyVolumeLevel(level) {
  level = Math.max(0, Math.min(P.VOLUME_MAX_LEVEL, level));
  const byte = P.volumeByteForLevel(level);
  const target = P.dbForVolumeByte(byte);
  const current = currentVolumeDb();
  const risky = current === null ? target > -40 : target - current > VOLUME_CONFIRM_DB;
  if (risky) {
    const msg = current === null
      ? `현재 볼륨을 알 수 없습니다. ${fmtDb(target)} dB로 설정할까요?`
      : `볼륨을 ${fmtDb(current)} dB에서 ${fmtDb(target)} dB로 크게 올립니다. 계속할까요?`;
    if (!confirm(msg)) { render(); return; }
  }
  await apply(P.setVolumeLevel(level), { volumeByte: byte }, P.CMD.READ_VOLUME, `볼륨 ${fmtDb(target)} dB`);
}

function wire() {
  $('connectPrimary').addEventListener('click', () => connectWith(PRIMARY));
  $('connectSecondary').addEventListener('click', () => connectWith(SECONDARY));
  $('disconnect').addEventListener('click', () => disconnect(true));
  $('refresh').addEventListener('click', () => readAll().then(() => toast('상태를 다시 읽었습니다.')).catch(handleIoError));

  // While a slider is held, polling must not move it. `change` fires on release; the timeout covers
  // a press that ends without changing the value.
  const trackDrag = (el, key) => {
    el.addEventListener('pointerdown', () => { dragging[key] = true; });
    const release = () => setTimeout(() => { dragging[key] = false; }, 0);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
  };

  const volume = $('volume');
  trackDrag(volume, 'volume');
  volume.addEventListener('input', () => {
    $('volumeDb').textContent = fmtDb(P.dbForVolumeByte(P.volumeByteForLevel(Number(volume.value))));
  });
  volume.addEventListener('change', async () => {
    dragging.volume = false;
    await applyVolumeLevel(Number(volume.value));
  });
  const stepVolume = (delta) => {
    const level = state.volumeByte === null ? 0 : P.levelForVolumeByte(state.volumeByte);
    applyVolumeLevel(level + delta);
  };
  $('volumeDown').addEventListener('click', () => stepVolume(-1));
  $('volumeUp').addEventListener('click', () => stepVolume(+1));

  const balance = $('balance');
  trackDrag(balance, 'balance');
  balance.addEventListener('input', () => { $('balanceText').textContent = balanceLabel(Number(balance.value)); });
  const applyBalance = (db) => apply(P.setBalance(db), { balance: db }, P.CMD.READ_VOLUME, `밸런스 ${balanceLabel(db)}`);
  balance.addEventListener('change', () => {
    dragging.balance = false;
    applyBalance(Number(balance.value));
  });
  $('balanceCenter').addEventListener('click', () => applyBalance(0));

  $('filterOptions').addEventListener('change', (e) => {
    const code = Number(e.target.value);
    const f = P.FILTERS.find((x) => x.code === code);
    apply(P.setFilter(code), { filter: code }, P.CMD.READ_CONFIG_1, `필터: ${f.label}`);
  });
  $('gainOptions').addEventListener('change', (e) => {
    const code = Number(e.target.value);
    const g = P.GAINS.find((x) => x.code === code);
    apply(P.setGain(code), { gain: code }, P.CMD.READ_CONFIG_1, `게인: ${g.label} (${g.hint})`);
  });
  $('dacOptions').addEventListener('change', (e) => {
    const code = Number(e.target.value);
    const m = P.DAC_MODES.find((x) => x.code === code);
    apply(P.setDacMode(code), { dacMode: code }, P.CMD.READ_CONFIG_2, `DAC 모드: ${m.label}`);
  });
  $('dre').addEventListener('change', (e) => {
    const on = e.target.checked;
    apply(P.setDre(on), { dreEnabled: on }, P.CMD.READ_CONFIG_2, `DRE ${on ? '켜기' : '끄기'}`);
  });

  $('clearLog').addEventListener('click', () => { $('log').textContent = ''; });
  $('copyUdev').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('udevCommand').textContent);
      toast('명령을 복사했습니다.');
    } catch { toast('복사하지 못했습니다. 직접 선택해서 복사해 주세요.', true); }
  });

  UsbTransport.onDisconnect(onDeviceGone);
  HidTransport.onDisconnect(onDeviceGone);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.transport?.canRead) {
      read(P.CMD.READ_SAMPLE_RATE).then(render).catch(() => {});
    }
  });
}

// ---------- start ----------

buildOptions();
wire();
render();
if (!UsbTransport.isSupported() && !HidTransport.isSupported()) {
  $('unsupported').hidden = false;
  log('WebUSB / WebHID 미지원 브라우저');
} else {
  log(`준비됨 · 기본 연결 방식: ${PRIMARY.kind === 'webusb' ? 'WebUSB' : 'WebHID'}`);
  autoReconnect();
}
