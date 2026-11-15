const GREEN = "#3dbe6e";
const AMBER = "#e6c15a";
const RED = "#e23b2f";

export const GAUGES = {
  battery: { min: 0, max: 100, red: "low", unit: "%", label: "Battery" },
  output: { min: -120, max: 120, unit: "kW", label: "Output" },
  rpm: { min: 0, max: 6000, redFrom: 4800, unit: "rpm", label: "RPM" },
  economy: { min: 0, max: 40, red: "low", unit: "mpg", label: "MPG" },
};

const RAMP = [
  { t: 0, hex: GREEN },
  { t: 0.45, hex: AMBER },
  { t: 1, hex: RED },
];

export const ARC_START = 120;
export const ARC_SWEEP = 300;
export const ARC_R = 38;
const OUTPUT_CAP = 120;

export function fraction(value, min, max) {
  if (value == null || !Number.isFinite(value)) return 0;
  const f = (value - min) / (max - min);
  return Math.min(1, Math.max(0, f));
}

export function formatReading(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  const n = Math.round(value);
  return Object.is(n, -0) ? "0" : String(n);
}

export function dash(value, min, max) {
  const f = fraction(value, min, max);
  return `${(f * 100).toFixed(2)} 100`;
}

function hexRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function rgbHex(r, g, b) {
  const h = (n) => Math.round(n).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function colorAt(t) {
  const x = Math.min(1, Math.max(0, t));
  let a = RAMP[0];
  let b = RAMP[RAMP.length - 1];
  for (let i = 0; i < RAMP.length - 1; i++) {
    if (x >= RAMP[i].t && x <= RAMP[i + 1].t) {
      a = RAMP[i];
      b = RAMP[i + 1];
      break;
    }
  }
  const span = b.t - a.t || 1;
  const u = (x - a.t) / span;
  const [ar, ag, ab] = hexRgb(a.hex);
  const [br, bg, bb] = hexRgb(b.hex);
  return rgbHex(ar + (br - ar) * u, ag + (bg - ag) * u, ab + (bb - ab) * u);
}

function lerpHex(from, to, t) {
  const u = Math.min(1, Math.max(0, t));
  const [ar, ag, ab] = hexRgb(from);
  const [br, bg, bb] = hexRgb(to);
  return rgbHex(ar + (br - ar) * u, ag + (bg - ag) * u, ab + (bb - ab) * u);
}

export function zoneColors(value, spec) {
  const f = fraction(value, spec.min, spec.max);
  const bad = spec.red === "high" ? f : 1 - f;
  const floor = bad >= 0.66 ? 0.66 : bad >= 0.4 ? 0.4 : 0;
  const start = Math.max(floor, bad - 0.2);
  return [colorAt(start), colorAt(bad)];
}

export function rpmColors(value) {
  if (value == null || !Number.isFinite(value) || value < GAUGES.rpm.redFrom) {
    const t = value == null || !Number.isFinite(value) ? 0 : Math.min(1, Math.max(0, value / GAUGES.rpm.redFrom));
    const color = lerpHex(GREEN, AMBER, t);
    return [color, color];
  }
  return [RED, RED];
}

// Zero sits at path midpoint, 270°, the top of the 120° arc. Left is input.
export function outputGeometry(kw) {
  const zero = {
    text: "0",
    side: "zero",
    start: 50,
    length: 0,
    cap: "butt",
    colors: [GREEN, GREEN],
    dasharray: "0 100",
    dashoffset: "0",
  };
  if (kw == null || !Number.isFinite(kw)) {
    return { ...zero, text: "—" };
  }
  const mag = Math.min(OUTPUT_CAP, Math.abs(kw));
  const shown = Math.round(mag);
  if (shown === 0) return zero;
  const input = kw < 0;
  const length = (mag / OUTPUT_CAP) * 50;
  const start = input ? 50 - length : 50;
  const end = lerpHex(GREEN, RED, mag / OUTPUT_CAP);
  return {
    text: input ? `+${shown}` : String(shown),
    side: input ? "input" : "output",
    start,
    length,
    cap: "round",
    colors: input ? [GREEN, GREEN] : [GREEN, end],
    dasharray: `${length.toFixed(2)} 100`,
    dashoffset: start === 0 ? "0" : (-start).toFixed(2),
  };
}

export function arcPath(cx = 50, cy = 50, r = ARC_R) {
  const polar = (deg) => {
    const rad = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  };
  const [x1, y1] = polar(ARC_START);
  const [x2, y2] = polar(ARC_START + ARC_SWEEP);
  const large = ARC_SWEEP > 180 ? 1 : 0;
  return `M ${x1.toFixed(3)} ${y1.toFixed(3)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(3)} ${y2.toFixed(3)}`;
}

export const SHOTS = {
  electric: { mode: "electric", boost: false, phase: "battery", soc: 80, lockUntil: null, kw: 24, rpm: 0, mpg: 0 },
  engine: { mode: "engine", boost: false, phase: "engine", soc: 50, lockUntil: null, kw: 18, rpm: 2400, mpg: 34 },
  cycle: { mode: "cycle", boost: false, phase: "battery", soc: 40, lockUntil: null, kw: 12, rpm: 1600, mpg: 38 },
  locked: { mode: "engine", boost: false, phase: "engine", soc: 21, lockUntil: 23, kw: 8, rpm: 1700, mpg: 28 },
  input: { mode: "off", boost: false, phase: "battery", soc: 70, lockUntil: null, kw: -30, rpm: 900, mpg: 40 },
  output: { mode: "off", boost: false, phase: "battery", soc: 64, lockUntil: null, kw: 60, rpm: 0, mpg: 0 },
};
