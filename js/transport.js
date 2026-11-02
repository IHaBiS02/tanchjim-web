// Two ways to reach the device from a browser:
//  - WebUSB: vendor control transfers on EP0 (what the official apps use). Read + write.
//  - WebHID: 7-byte output report on the HID interface. The firmware accepts commands this way,
//            but replies can't be read back from a browser, so it is write-only.

import { DEVICES } from './protocol.js';

const CONTROL_OUT = { requestType: 'vendor', recipient: 'other', request: 0xa0, value: 0, index: 0x09a0 };
const CONTROL_IN = { requestType: 'vendor', recipient: 'other', request: 0xa1, value: 0, index: 0x09a0 };
const REPLY_LENGTH = 8;
const REPLY_DELAY_MS = 50; // between a write and its read-back
const COMMAND_GAP_MS = 200; // between consecutive commands

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FILTERS = DEVICES.map(({ vendorId, productId }) => ({ vendorId, productId }));
const isLuna = (d) => DEVICES.some((x) => x.vendorId === d.vendorId && x.productId === d.productId);

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
    return new UsbTransport(await navigator.usb.requestDevice({ filters: FILTERS }));
  }
  static async paired() {
    if (!UsbTransport.isSupported()) return [];
    return (await navigator.usb.getDevices()).filter(isLuna).map((d) => new UsbTransport(d));
  }
  static onDisconnect(handler) {
    if (UsbTransport.isSupported()) navigator.usb.addEventListener('disconnect', (e) => handler(e.device));
  }

  canRead = true;
  #queue = new CommandQueue();
  constructor(device) { this.device = device; }
  get kind() { return UsbTransport.kind; }
  get name() { return this.device.productName || 'LUNA'; }

  async open() {
    if (!this.device.opened) await this.device.open();
    if (this.device.configuration === null) await this.device.selectConfiguration(1);
  }

  // Sends a command and returns the 8-byte reply.
  exchange(cmd) {
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
    const [device] = await navigator.hid.requestDevice({ filters: FILTERS });
    if (!device) throw new DOMException('No device selected.', 'NotFoundError');
    return new HidTransport(device);
  }
  static async paired() {
    if (!HidTransport.isSupported()) return [];
    return (await navigator.hid.getDevices()).filter(isLuna).map((d) => new HidTransport(d));
  }
  static onDisconnect(handler) {
    if (HidTransport.isSupported()) navigator.hid.addEventListener('disconnect', (e) => handler(e.device));
  }

  canRead = false;
  #queue = new CommandQueue();
  constructor(device) { this.device = device; }
  get kind() { return HidTransport.kind; }
  get name() { return this.device.productName || 'LUNA'; }

  async open() {
    if (!this.device.opened) await this.device.open();
  }

  // Write-only: always resolves to null.
  exchange(cmd) {
    return this.#queue.run(async () => {
      await this.device.sendReport(0, cmd);
      return null;
    });
  }

  async close() {
    try { if (this.device.opened) await this.device.close(); } catch { /* already gone */ }
  }
}
