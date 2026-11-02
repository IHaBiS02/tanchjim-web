import * as P from './protocol.js';
import { UsbTransport, HidTransport } from './transport.js';
import { MODES, MODE_LIST, detectMode, isOtherProtocolProduct, usbId } from './devices.js';
import { createDriver, fmtDb } from './drivers.js';

const POLL_MS = 3000;
const STORAGE_KEY = 'luna-control.last-sent';
const MODE_KEY = 'luna-control.mode';

const $ = (id) => document.getElementById(id);
const isWindows = /Windows/i.test(navigator.userAgentData?.platform ?? navigator.userAgent);
// On Windows WebUSB can't open an audio device, so WebHID is the default there.
const PRIMARY = isWindows ? HidTransport : UsbTransport;
const SECONDARY = isWindows ? UsbTransport : HidTransport;

const EMPTY = {
  firmware: null, firmwareNum: null, sampleRate: null, volumeLevel: null, volumeDb: null, balance: null,
  filter: null, gain: null, dacMode: null, dreEnabled: null, ledOn: null, micGain: null,
};
const state = { ...EMPTY };
const session = {
  transport: null,
  detected: null, // mode picked from the product name (or null)
  mode: null, // mode in use
  driver: null,
  ready: false, // writes allowed
  blocked: null, // why writes are not allowed
};
let pollTimer = null;
const dragging = { volume: false, balance: false, micGain: false };

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

function handleIoError(e) {
  log(`오류: ${e.name ?? ''} ${e.message}`);
  toast(`오류: ${e.message}`, true);
  render();
}

// Folds device values into state without moving a slider the user is holding.
function absorb(updates) {
  const u = { ...updates };
  if (dragging.volume) { delete u.volumeLevel; delete u.volumeDb; }
  if (dragging.balance) delete u.balance;
  if (dragging.micGain) delete u.micGain;
  Object.assign(state, u);
}

// ---------- connection ----------

async function connectWith(Transport) {
  try {
    const t = await Transport.request();
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
    return 'Windows에서는 WebUSB로 열 수 없습니다. WebHID로 연결해 주세요.';
  }
  if (Transport === UsbTransport) {
    return `WebUSB로 열지 못했습니다 (${e.name}). WebHID로 연결해 보세요.`;
  }
  return `연결하지 못했습니다: ${e.message}`;
}

async function useTransport(t) {
  await disconnect(false);
  session.transport = t;
  session.detected = detectMode(t.productName);
  log(`연결됨: ${t.productName || '(제품명 없음)'} · ${usbId(t.device)} · ${t.kind === 'webusb' ? 'WebUSB' : 'WebHID'}`);
  log(`  제품명으로 판별한 모드: ${session.detected?.label ?? '없음'}`);
  const saved = MODES[loadModeOverride(t)] ?? null;
  if (saved) log(`  저장된 수동 모드: ${saved.label}`);
  await activate(saved ?? session.detected);
}

// Switches the protocol mode. Nothing is sent before a mode is chosen; with a mode, a read-only
// command is sent first and writes stay disabled unless the reply looks right.
async function activate(mode) {
  stopPolling();
  const t = session.transport;
  Object.assign(state, EMPTY);
  Object.assign(session, { mode, driver: null, ready: false, blocked: null });
  buildOptions();

  if (!mode) {
    session.blocked = isOtherProtocolProduct(t.productName) ? 'other-protocol' : 'unknown';
    log('  모드가 정해지지 않아 명령을 보내지 않음');
    render();
    return;
  }
  if (mode.hidOnly && t.kind !== 'webhid') {
    session.blocked = 'hid-only';
    render();
    return;
  }

  const driver = createDriver(mode, t, log);
  session.driver = driver;
  buildOptions();
  render();

  log(`${mode.label} 모드${mode.verified ? '' : ' (미검증)'} — 읽기 명령으로 응답 확인`);
  let probe;
  try { probe = await driver.probe(); } catch (e) { probe = false; log(`  확인 실패: ${e.message}`); }
  if (session.driver !== driver) return; // mode changed meanwhile

  if (probe === false) {
    session.blocked = 'probe-failed';
    toast(`${mode.label} 모드 응답을 확인하지 못해 설정 변경을 막았습니다.`, true);
    render();
    return;
  }
  if (probe === null && mode !== session.detected) {
    const ok = confirm(`WebHID에서는 장치 응답을 읽을 수 없어 ${mode.label} 모드가 맞는지 확인할 수 없습니다.\n`
      + `제품명("${t.productName || '없음'}")과 맞지 않는 모드입니다. 그래도 이 모드로 설정 명령을 보낼 수 있게 할까요?`);
    if (!ok) {
      session.blocked = 'not-confirmed';
      render();
      return;
    }
  }

  session.ready = true;
  if (driver.canRead) {
    try {
      const updates = await driver.readAll();
      if (session.driver !== driver) return;
      absorb(updates);
      toast('장치 상태를 읽었습니다.');
    } catch (e) { handleIoError(e); }
    if (session.driver !== driver) return;
    startPolling();
  } else {
    loadLastSent();
    toast(`${mode.label} 모드 · 쓰기 전용으로 연결했습니다.`);
  }
  render();
}

async function disconnect(userInitiated = true) {
  stopPolling();
  const t = session.transport;
  Object.assign(session, { transport: null, detected: null, mode: null, driver: null, ready: false, blocked: null });
  if (t) {
    await t.close();
    if (userInitiated) log('연결 해제');
  }
  Object.assign(state, EMPTY);
  buildOptions();
  render();
}

function onDeviceGone(device) {
  if (session.transport?.device === device) {
    log('장치가 분리됨');
    toast('장치가 분리되었습니다.', true);
    disconnect(false);
  }
}

// Keeps the sample rate and volume (which the inline remote may change) up to date.
function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollOnce, POLL_MS);
}
function stopPolling() { clearInterval(pollTimer); pollTimer = null; }
async function pollOnce() {
  const d = session.driver;
  if (!session.ready || !d?.canRead || document.visibilityState !== 'visible') return;
  try {
    const updates = await d.poll();
    if (session.driver === d) { absorb(updates); render(); }
  } catch (e) { log(`상태 갱신 실패: ${e.message}`); }
}

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

// ---------- persistence ----------

const modeKey = (t) => `${MODE_KEY}.${usbId(t.device)}.${t.productName}`;
function loadModeOverride(t) {
  try { return localStorage.getItem(modeKey(t)); } catch { return null; }
}
function saveModeOverride(t, id) {
  try {
    if (id) localStorage.setItem(modeKey(t), id);
    else localStorage.removeItem(modeKey(t));
  } catch { /* storage unavailable */ }
}

// Write-only mode: remember what was sent, per mode.
const lastSentKey = () => (session.mode.id === 'luna-at' ? STORAGE_KEY : `${STORAGE_KEY}.${session.mode.id}`);
function saveLastSent() {
  const saved = {};
  for (const k of Object.keys(EMPTY)) if (state[k] !== null && k !== 'firmware' && k !== 'firmwareNum') saved[k] = state[k];
  try { localStorage.setItem(lastSentKey(), JSON.stringify(saved)); } catch { /* storage unavailable */ }
}
function loadLastSent() {
  try {
    const saved = JSON.parse(localStorage.getItem(lastSentKey()) ?? 'null');
    if (!saved || typeof saved !== 'object') return;
    // Older versions stored the raw LUNA volume byte.
    if (typeof saved.volumeByte === 'number' && !('volumeLevel' in saved)) {
      saved.volumeLevel = P.levelForVolumeByte(saved.volumeByte);
      saved.volumeDb = P.dbForVolumeByte(saved.volumeByte);
    }
    for (const k of Object.keys(EMPTY)) if (k in saved) state[k] = saved[k];
  } catch { /* storage unavailable */ }
}

// ---------- applying settings ----------

async function applySetting(key, value, description) {
  const d = session.driver;
  if (!session.ready || !d) return;
  try {
    const result = await d.apply(key, value);
    if (session.driver !== d) return;
    absorb(result.updates);
    if (result.unverified) {
      if (!d.canRead) saveLastSent();
      toast(`${description} — 전송함${d.canRead ? ' (응답으로 확인하지 못함)' : ''}`);
    } else if (result.mismatch) {
      toast(`${description} — 장치 값이 다릅니다 (${result.mismatch}). 로그를 확인하세요.`, true);
    } else {
      toast(`${description} — 적용됨`);
    }
    render();
  } catch (e) {
    handleIoError(e);
  }
}

async function applyVolumeLevel(level) {
  const d = session.driver;
  if (!session.ready || !d) return;
  level = Math.max(0, Math.min(d.volumeMax, level));
  const question = d.volumeConfirm(state, level);
  if (question && !confirm(question)) { render(); return; }
  await applySetting('volume', level, `볼륨 ${d.volumeText(level)} ${d.volumeUnit}`);
}

// ---------- UI ----------

function buildOptions() {
  const d = session.driver;
  const filters = d?.filters ?? P.FILTERS;
  const gains = d?.gains ?? P.GAINS;
  const dacModes = d?.dacModes ?? P.DAC_MODES;
  $('filterOptions').innerHTML = filters.map((f) => `
    <label class="option">
      <input type="radio" name="filter" value="${f.code}">
      <span>${f.label}<small>${f.hint}</small></span>
    </label>`).join('');
  $('gainOptions').innerHTML = gains.map((g) => `
    <label><input type="radio" name="gain" value="${g.code}">${g.label}<small>${g.hint}</small></label>`).join('');
  $('dacOptions').innerHTML = dacModes.map((m) => `
    <label><input type="radio" name="dac" value="${m.code}">${m.label}</label>`).join('');
  $('volume').max = d?.volumeMax ?? P.VOLUME_MAX_LEVEL;
  $('balance').min = -P.BALANCE_LIMIT_DB;
  $('balance').max = P.BALANCE_LIMIT_DB;

  const t = session.transport;
  const detected = session.detected;
  $('mode').innerHTML = [
    `<option value="auto">자동${detected ? ` (${detected.label})` : ' (판별 안 됨)'}</option>`,
    ...MODE_LIST.map((m) => `<option value="${m.id}">${m.label}${m.verified ? '' : ' · 미검증'}</option>`),
  ].join('');
  $('mode').value = t && session.mode && session.mode !== detected ? session.mode.id : 'auto';
}

function setRadio(name, value) {
  document.querySelectorAll(`input[name="${name}"]`).forEach((el) => {
    el.checked = value !== null && Number(el.value) === value;
  });
}
function balanceLabel(db) {
  if (db === null) return '—';
  if (db === 0) return '가운데';
  return `${db < 0 ? '왼쪽' : '오른쪽'}으로 ${fmtDb(Math.abs(db))} dB`;
}
const escapeText = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function modeNotice() {
  const t = session.transport;
  if (!t) return null;
  const name = escapeText(t.productName || '없음');
  const mode = session.mode;
  const manual = mode && mode !== session.detected;
  switch (session.blocked) {
    case 'other-protocol':
      return ['error', `<strong>지원하지 않는 기기</strong> — "${name}"은(는) 공식 앱에서 다른 명령 체계를 쓰는 제품이라 지원하지 않습니다. 아무 명령도 보내지 않았습니다.`];
    case 'unknown':
      return ['warn', `<strong>모드를 정할 수 없음</strong> — 제품명 "${name}" (${usbId(t.device)})으로 기기를 알아보지 못해 아무 명령도 보내지 않았습니다. 어떤 기기인지 확실하면 위 장치 카드의 <em>프로토콜 모드</em>에서 직접 고르세요.`];
    case 'hid-only':
      return ['error', `<strong>${mode.label} 모드는 WebHID 전용입니다</strong> — 연결을 해제한 뒤 WebHID로 다시 연결해 주세요.`];
    case 'probe-failed':
      return ['error', `<strong>응답 확인 실패</strong> — ${mode.label} 모드의 읽기 명령에 올바른 응답이 없어 설정 변경을 막았습니다. 모드가 맞는지, 다른 프로그램이 장치를 쓰고 있지 않은지 확인하세요.`];
    case 'not-confirmed':
      return ['warn', `<strong>설정 변경 막힘</strong> — ${mode.label} 모드가 맞는지 확인할 수 없어 쓰기를 막았습니다. 모드를 다시 고르면 다시 묻습니다.`];
    default:
      break;
  }
  const parts = [];
  if (manual) parts.push(`제품명 "${name}"과 다른 <strong>${mode.label}</strong> 모드를 직접 선택했습니다.`);
  if (mode && !mode.verified) parts.push(`<strong>${mode.label} 모드는 미검증입니다</strong> — 공식 앱 분석만으로 만든 기능이라 실제 기기에서 다르게 동작할 수 있습니다.`);
  return parts.length ? ['warn', parts.join(' ')] : null;
}

function render() {
  const t = session.transport;
  const d = session.driver;
  const connected = !!t;
  const ready = session.ready;
  const canRead = ready && !!d?.canRead;
  const features = session.mode?.features
    ?? { sampleRate: true, dacMode: true, led: false, dre: 0, balance: true, micGain: false };

  $('status').classList.toggle('on', connected);
  $('statusText').textContent = connected ? `${t.name} 연결됨` : '연결 안 됨';
  $('connectPrimary').hidden = connected;
  $('connectSecondary').hidden = connected;
  $('disconnect').hidden = !connected;
  $('writeOnlyNotice').hidden = !(ready && d && !d.canRead);
  $('controls').setAttribute('aria-disabled', String(!ready));

  const notice = modeNotice();
  $('modeNotice').hidden = !notice;
  if (notice) {
    $('modeNotice').className = `banner ${notice[0]}`;
    $('modeNotice').innerHTML = notice[1];
  }

  $('mode').disabled = !connected;
  $('modeHint').textContent = !connected ? '연결하면 제품명으로 자동 선택됩니다.'
    : (session.mode ? `${session.mode.label}${session.mode.verified ? ' · 검증됨' : ' · 미검증'}` : '선택 안 됨');

  const unreadable = ready && !canRead ? '읽을 수 없음' : '—';
  $('infoName').textContent = t?.name ?? '—';
  $('infoFirmware').textContent = state.firmware ?? unreadable;
  $('rateRow').hidden = !features.sampleRate;
  $('infoRate').textContent = state.sampleRate ?? unreadable;
  $('infoTransport').textContent = !t ? '—'
    : `${t.kind === 'webusb' ? 'WebUSB' : 'WebHID'}${ready && d ? (d.canRead ? ' (읽기 + 쓰기)' : ' (쓰기 전용)') : ''}`;
  $('infoUsbId').textContent = t ? usbId(t.device) : '—';
  $('refresh').disabled = !canRead;

  document.querySelectorAll('#controls input, #controls button.step, #balanceCenter').forEach((el) => {
    el.disabled = !ready;
  });

  if (!dragging.volume) {
    const level = state.volumeLevel;
    $('volume').value = level ?? 0;
    if (level === null) $('volumeDb').textContent = '—';
    else if (state.volumeDb !== null) $('volumeDb').textContent = fmtDb(state.volumeDb);
    else $('volumeDb').textContent = d ? d.volumeText(level) : String(level);
  }
  $('volumeUnit').textContent = d?.volumeUnit ?? 'dB';

  $('balanceSection').hidden = !features.balance;
  if (!dragging.balance) {
    $('balance').value = state.balance ?? 0;
    $('balanceText').textContent = balanceLabel(state.balance);
  }

  setRadio('filter', state.filter);
  setRadio('gain', state.gain);
  $('dacSection').hidden = !features.dacMode;
  setRadio('dac', state.dacMode);

  const dre = $('dre');
  dre.indeterminate = state.dreEnabled === null;
  dre.checked = !!state.dreEnabled;
  $('dreRow').hidden = !!features.dre && state.firmwareNum !== null && state.firmwareNum < features.dre;
  $('dreHint').textContent = features.dre
    ? `Dynamic Range Enhancement · 펌웨어 ${features.dre} 이상` : 'Dynamic Range Enhancement';

  $('ledRow').hidden = !features.led;
  const led = $('led');
  led.indeterminate = state.ledOn === null;
  led.checked = !!state.ledOn;

  $('micSection').hidden = !features.micGain;
  if (!dragging.micGain) {
    $('micGain').value = state.micGain ?? 0;
    $('micGainText').textContent = state.micGain ?? '—';
  }

  const labels = { webusb: 'WebUSB로 연결', webhid: 'WebHID로 연결' };
  $('connectPrimary').textContent = labels[PRIMARY.kind];
  $('connectSecondary').textContent = labels[SECONDARY.kind];
  $('connectPrimary').disabled = !PRIMARY.isSupported();
  $('connectSecondary').hidden ||= !SECONDARY.isSupported();
}

// ---------- event wiring ----------

function onModeSelected() {
  const t = session.transport;
  if (!t) return;
  const id = $('mode').value;
  const mode = id === 'auto' ? session.detected : MODES[id];
  if (mode === session.mode) return;
  if (mode && mode !== session.detected) {
    const expected = session.detected ? `${session.detected.label} 모드` : '알 수 없는 기기';
    const ok = confirm(`제품명 "${t.productName || '없음'}"은(는) ${expected}입니다.\n`
      + `${mode.label} 모드로 강제로 바꿀까요?\n\n`
      + '잘못된 모드로 명령을 보내면 장치가 오동작할 수 있습니다. '
      + '설정을 보내기 전에 읽기 명령으로 응답을 먼저 확인합니다.');
    if (!ok) { buildOptions(); return; }
  }
  saveModeOverride(t, mode && mode !== session.detected ? mode.id : null);
  log(`모드 변경: ${mode ? mode.label : '자동 (판별 안 됨)'}`);
  activate(mode);
}

function wire() {
  $('connectPrimary').addEventListener('click', () => connectWith(PRIMARY));
  $('connectSecondary').addEventListener('click', () => connectWith(SECONDARY));
  $('disconnect').addEventListener('click', () => disconnect(true));
  $('mode').addEventListener('change', onModeSelected);
  $('refresh').addEventListener('click', async () => {
    try {
      absorb(await session.driver.readAll());
      render();
      toast('상태를 다시 읽었습니다.');
    } catch (e) { handleIoError(e); }
  });

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
    const d = session.driver;
    if (d) $('volumeDb').textContent = d.volumeText(Number(volume.value));
  });
  volume.addEventListener('change', async () => {
    dragging.volume = false;
    await applyVolumeLevel(Number(volume.value));
  });
  const stepVolume = (delta) => applyVolumeLevel((state.volumeLevel ?? 0) + delta);
  $('volumeDown').addEventListener('click', () => stepVolume(-1));
  $('volumeUp').addEventListener('click', () => stepVolume(+1));

  const balance = $('balance');
  trackDrag(balance, 'balance');
  balance.addEventListener('input', () => { $('balanceText').textContent = balanceLabel(Number(balance.value)); });
  const applyBalance = (db) => applySetting('balance', db, `밸런스 ${balanceLabel(db)}`);
  balance.addEventListener('change', () => {
    dragging.balance = false;
    applyBalance(Number(balance.value));
  });
  $('balanceCenter').addEventListener('click', () => applyBalance(0));

  $('filterOptions').addEventListener('change', (e) => {
    const code = Number(e.target.value);
    const f = (session.driver?.filters ?? P.FILTERS).find((x) => x.code === code);
    applySetting('filter', code, `필터: ${f.label}`);
  });
  $('gainOptions').addEventListener('change', (e) => {
    const code = Number(e.target.value);
    const g = P.GAINS.find((x) => x.code === code);
    applySetting('gain', code, `게인: ${g.label} (${g.hint})`);
  });
  $('dacOptions').addEventListener('change', (e) => {
    const code = Number(e.target.value);
    const m = P.DAC_MODES.find((x) => x.code === code);
    applySetting('dacMode', code, `DAC 모드: ${m.label}`);
  });
  $('dre').addEventListener('change', (e) => {
    const on = e.target.checked;
    applySetting('dre', on, `DRE ${on ? '켜기' : '끄기'}`);
  });
  $('led').addEventListener('change', (e) => {
    const on = e.target.checked;
    applySetting('led', on, `LED ${on ? '켜기' : '끄기'}`);
  });

  const mic = $('micGain');
  trackDrag(mic, 'micGain');
  mic.addEventListener('input', () => { $('micGainText').textContent = mic.value; });
  mic.addEventListener('change', () => {
    dragging.micGain = false;
    applySetting('micGain', Number(mic.value), `마이크 게인 ${mic.value} dB`);
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
    if (document.visibilityState === 'visible') pollOnce();
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
