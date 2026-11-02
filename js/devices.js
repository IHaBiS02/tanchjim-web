// Which devices the page offers and how a device is mapped to a protocol mode.
// The official app tells models apart by the USB product string, so the same is done here.
// Only LUNA AT has been verified on real hardware; every other mode is marked unverified.

// Vendor IDs used by TANCHJIM USB products according to the official Windows app.
// The browser's device chooser is limited to these.
export const DEVICE_FILTERS = [
  { vendorId: 0x2fc6 }, // Comtrue (LUNA, LUNA AT, SPACE ...)
  { vendorId: 0x31b2 },
  { vendorId: 0x3302 },
  { vendorId: 0x0666, productId: 0x0888 },
];

export const isKnownDevice = (d) => DEVICE_FILTERS.some(
  (f) => f.vendorId === d.vendorId && (f.productId === undefined || f.productId === d.productId),
);

// features.dre = minimum firmware for DRE (0 = no version check).
export const MODES = {
  'luna-at': {
    id: 'luna-at', label: 'LUNA AT', productName: 'TANCHJIM-LUNA AT', protocol: 'luna', verified: true,
    features: { sampleRate: true, dacMode: true, led: false, dre: 7, balance: true, micGain: false },
  },
  luna: {
    id: 'luna', label: 'LUNA', productName: 'TANCHJIM-LUNA', protocol: 'luna', verified: false,
    features: { sampleRate: true, dacMode: true, led: false, dre: 7, balance: true, micGain: false },
  },
  space: {
    id: 'space', label: 'SPACE', productName: 'TANCHJIM-SPACE', protocol: 'luna', verified: false,
    features: { sampleRate: false, dacMode: false, led: true, dre: 9, balance: true, micGain: false },
  },
  space2: {
    id: 'space2', label: 'SPACE II', productName: 'TANCHJIM-SPACE II', protocol: 'space2', verified: false,
    hidOnly: true,
    features: { sampleRate: false, dacMode: true, led: false, dre: 0, balance: true, micGain: true },
  },
};
export const MODE_LIST = Object.values(MODES);

// Products the official app drives with a different protocol. Never auto-selected.
const OTHER_PROTOCOL = ['TANCHJIM-SPACE PRO', 'TANCHJIM-SPACE PRO AT'];

const normalize = (name) => (name ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
// Some platforms prefix the manufacturer ("TANCHJIM TANCHJIM-LUNA AT"), which is accepted.
const nameIs = (name, product) => name === product || name.endsWith(` ${product}`);

export function detectMode(productName) {
  const name = normalize(productName);
  if (OTHER_PROTOCOL.some((p) => nameIs(name, p))) return null;
  return MODE_LIST.find((m) => nameIs(name, m.productName)) ?? null;
}

export const isOtherProtocolProduct = (productName) =>
  OTHER_PROTOCOL.some((p) => nameIs(normalize(productName), p));

export const usbId = ({ vendorId, productId }) =>
  `${vendorId.toString(16).padStart(4, '0')}:${productId.toString(16).padStart(4, '0')}`;
