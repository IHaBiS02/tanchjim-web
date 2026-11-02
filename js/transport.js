// Two ways to reach the device from a browser:
//  - WebUSB: vendor control transfers on EP0 (what the official LUNA apps use). Read + write.
//  - WebHID: output reports on the HID interface. LUNA firmware accepts its 7-byte commands this way
//            but its replies can't be read back from a browser. SPACE II (unverified) is expected to
//            answer with input reports, which WebHID can receive.

import { DEVICE_FILTERS, isKnownDevice } from './devices.js';

const CONTROL_OUT = { requestType: 'vendor', recipient: 'other', request: 0xa0, value: 0, index: 0x09a0 };
const CONTROL_IN = { requestType: 'vendor', recipient: 'other', request: 0xa1, value: 0, index: 0x09a0 };
const REPLY_LENGTH = 8;
const REPLY_DELAY_MS = 50; // between a write and its read-back
const COMMAND_GAP_MS = 200; // between consecutive commands
const HID_REPLY_TIMEOUT_MS = 800;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs device operations one at a time with a minimum gap between them.
class CommandQueue {
  #tail = Promise.resolve();
  run(task) {
    const result = this.#tail.then(task);
    this.#tail = result.catch(() => {}).then(() => sleep(COMMAND_GAP_MS));
    return result;
  }
}

export class UsbTransport {
  static kind = 'webusb';
  static isSupported() { return 'usb' in navigator; }
  static async request() {
    return new UsbTransport(await navigator.usb.requestDevice({ filters: DEVICE_FILTERS }));
  }
  static async paired() {
    if (!UsbTransport.isSupported()) return [];
    return (await navigator.usb.getDevices()).filter(isKnownDevice).map((d) => new UsbTransport(d));
  }
  static onDisconnect(handler) {
    if (UsbTransport.isSupported()) navigator.usb.addEventListener('disconnect', (e) => handler(e.device));
  }

  #queue = new CommandQueue();
  constructor(device) { this.device = device; }
  get kind() { return UsbTransport.kind; }
  get name() { return this.device.productName || '알 수 없는 장치'; }
  get productName() { return this.device.productName ?? ''; }

  async open() {
    if (!this.device.opened) await this.device.open();
    if (this.device.configuration === null) await this.device.selectConfiguration(1);
  }

  // LUNA protocol: sends a command and returns the 8-byte reply.
  controlExchange(cmd) {
    return this.#queue.run(async () => {
      const out = await this.device.controlTransferOut(CONTROL_OUT, cmd);
      if (out.status !== 'ok') throw new Error(`controlTransferOut: ${out.status}`);
      await sleep(REPLY_DELAY_MS);
      const res = await this.device.controlTransferIn(CONTROL_IN, REPLY_LENGTH);
      if (res.status !== 'ok' || !res.data) throw new Error(`controlTransferIn: ${res.status}`);
      return new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength);
    });
  }

  async close() {
    try { if (this.device.opened) await this.device.close(); } catch { /* already gone */ }
  }
}

export class HidTransport {
  static kind = 'webhid';
  static isSupported() { return 'hid' in navigator; }
  static async request() {
    const [device] = await navigator.hid.requestDevice({ filters: DEVICE_FILTERS });
    if (!device) throw new DOMException('No device selected.', 'NotFoundError');
    return new HidTransport(device);
  }
  static async paired() {
    if (!HidTransport.isSupported()) return [];
    // One physical device can show up as several HID interfaces; keep the first of each.
    const seen = new Set();
    return (await navigator.hid.getDevices()).filter(isKnownDevice).filter((d) => {
      const key = `${d.vendorId}:${d.productId}:${d.productName}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((d) => new HidTransport(d));
  }
  static onDisconnect(handler) {
    if (HidTransport.isSupported()) navigator.hid.addEventListener('disconnect', (e) => handler(e.device));
  }

  #queue = new CommandQueue();
  #waiters = new Set();
  #outputReportIds = new Set();
  #onInput = (e) => {
    const body = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    // With numbered reports the report ID is the first byte of the packet.
    const report = e.reportId ? Uint8Array.of(e.reportId, ...body) : body;
    for (const w of this.#waiters) {
      if (w.match(report)) { this.#waiters.delete(w); w.resolve(report); return; }
    }
  };

  constructor(device) { this.device = device; }
  get kind() { return HidTransport.kind; }
  get name() { return this.device.productName || '알 수 없는 장치'; }
  get productName() { return this.device.productName ?? ''; }

  async open() {
    if (!this.device.opened) await this.device.open();
    this.#outputReportIds = new Set(this.device.collections.flatMap(
      (c) => (c.outputReports ?? []).map((r) => r.reportId).filter((id) => id),
    ));
    this.device.addEventListener('inputreport', this.#onInput);
  }

  // Sends one packet. If the descriptor declares numbered output reports and the packet starts with
  // one of those IDs, that byte is sent as the report ID; otherwise the whole packet goes as report 0.
  #send(packet) {
    if (this.#outputReportIds.has(packet[0])) return this.device.sendReport(packet[0], packet.slice(1));
    return this.device.sendReport(0, packet);
  }

  // Sends a packet. With `match`, waits for the first input report it accepts and returns it
  // (or null after a timeout). Without `match`, returns null right after sending.
  exchange(packet, match = null, timeoutMs = HID_REPLY_TIMEOUT_MS) {
    return this.#queue.run(async () => {
      if (!match) { await this.#send(packet); return null; }
      let waiter;
      const reply = new Promise((resolve) => {
        waiter = { match, resolve };
        this.#waiters.add(waiter);
      });
      const timeout = sleep(timeoutMs).then(() => null);
      try {
        await this.#send(packet);
        return await Promise.race([reply, timeout]);
      } finally {
        this.#waiters.delete(waiter);
      }
    });
  }

  async close() {
    this.device.removeEventListener('inputreport', this.#onInput);
    for (const w of this.#waiters) w.resolve(null);
    this.#waiters.clear();
    try { if (this.device.opened) await this.device.close(); } catch { /* already gone */ }
  }
}
