// 2012 Volt, Veepeak OBDCheck BLE. The ELM327 adds the ISO-TP length byte.
// Engine-off is the only module write. RPM on the gauge is PID 01 0C.

export const TESTER = "3E";
export const FORCE_OFF = "AE 31 05 00 00 00 00";
export const FORCE_ON = "AE 31 06 00 00 00 00";
export const RELEASE = "AE 00 00 00 00 00 00";

export const INIT = ["ATZ", "ATE0", "ATL0", "ATS0", "ATH0", "ATAT1", "ATSP6"];

export const BLE_SERVICES = [
  "0000fff0-0000-1000-8000-00805f9b34fb",
  "49535343-fe7d-4ae5-8fa9-9fafd205e455",
];

export const BLE_LAYOUTS = [
  {
    service: "0000fff0-0000-1000-8000-00805f9b34fb",
    notify: "0000fff1-0000-1000-8000-00805f9b34fb",
    write: "0000fff2-0000-1000-8000-00805f9b34fb",
  },
  {
    service: "49535343-fe7d-4ae5-8fa9-9fafd205e455",
    write: "49535343-6daa-4d02-abf6-19569aca69fe",
    notify: "49535343-aca3-481c-91ec-d85e28a60318",
  },
];

export function dataByteCount(cmd) {
  return cmd.trim().split(/\s+/).filter(Boolean).length;
}

export function signed16(hi, lo) {
  let v = ((hi & 0xff) << 8) | (lo & 0xff);
  if (v & 0x8000) v -= 0x10000;
  return v;
}

export function decodeVoltage(hi, lo) {
  return signed16(hi, lo) / 64;
}

export function decodeCurrent(hi, lo) {
  return signed16(hi, lo) / 20;
}

export function kilowatts(volts, amps) {
  return (volts * amps) / 1000;
}

export function decodeRpm(hi, lo) {
  return (hi * 256 + lo) / 4;
}

export function decodeSpeedKmh(a) {
  return a;
}

export function decodeFuelLph(hi, lo) {
  return (hi * 256 + lo) * 0.05;
}

export function decodeMaf(hi, lo) {
  return ((hi & 0xff) * 256 + (lo & 0xff)) / 100;
}

export function decodeSoc(a) {
  return (a * 100) / 255;
}

export function holdFloor(boost) {
  return boost ? 22 : 45;
}

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// A new Electric press needs 46%, or 22% with Boost. No charge reading stays pressable.
// lockUntil is not a gate.
export function electricBlocked(state) {
  const row = state || {};
  const soc = row.soc;
  if (!numeric(soc)) return false;
  if (row.boost) return soc < 22;
  return soc < 46;
}

// The hold lets go at 45% without Boost, and below 22% with Boost. 22% itself continues.
function aboveRelease(soc, boost) {
  if (!numeric(soc)) return true;
  if (boost) return soc >= 22;
  return soc > holdFloor(false);
}

function cloneDrive(state) {
  const row = state || {};
  const mode = row.mode === "electric" || row.mode === "engine" || row.mode === "cycle" ? row.mode : "off";
  return {
    mode,
    boost: !!row.boost,
    phase: row.phase === "engine" ? "engine" : "battery",
    soc: numeric(row.soc) ? row.soc : null,
    lockUntil: numeric(row.lockUntil) ? row.lockUntil : null,
    previousPlan: row.previousPlan === "force-off" || row.previousPlan === "release" ? row.previousPlan : "none",
  };
}

function finish(next, plan) {
  if (plan === "force-off") next.previousPlan = "force-off";
  else if (plan === "release") next.previousPlan = "none";
  return { state: next, plan };
}

function leaveHold(next) {
  if (next.previousPlan === "force-off") return finish(next, "release");
  return { state: next, plan: "none" };
}

function engineShowing(next) {
  return next.mode === "engine" || (next.mode === "cycle" && next.phase === "engine");
}

// Boost is done. Cycle stays in the engine phase until 46%.
function endBoost(next) {
  next.boost = false;
  next.lockUntil = null;
  next.mode = "cycle";
  next.phase = "engine";
  return leaveHold(next);
}

export function restorePhase(mode, saved) {
  if (mode === "engine" || (mode === "cycle" && saved === "engine")) return "engine";
  return "battery";
}

function stepSoc(next) {
  const soc = next.soc;
  if (!numeric(soc)) {
    const holding = next.mode === "electric" || (next.mode === "cycle" && next.phase !== "engine");
    if (holding && next.previousPlan === "force-off") return finish(next, "force-off");
    return leaveHold(next);
  }
  // Electric holds through 22% with Boost. Cycle, and every other mode, still ends Boost at 22%.
  if (next.boost && soc <= 22 && !(next.mode === "electric" && soc === 22)) return endBoost(next);
  if (next.boost && engineShowing(next) && soc >= 22) {
    next.mode = "electric";
    next.phase = "battery";
    return finish(next, "force-off");
  }
  const floor = holdFloor(next.boost);
  if (next.mode === "electric") {
    if (!aboveRelease(soc, next.boost)) {
      next.lockUntil = null;
      next.mode = "engine";
      next.phase = "engine";
      return finish(next, "release");
    }
    next.phase = "battery";
    return finish(next, "force-off");
  }
  if (next.mode === "engine") {
    next.phase = "engine";
    return leaveHold(next);
  }
  if (next.mode === "cycle") {
    // One point above the floor turns the battery back on. lockUntil is not a gate.
    const backOn = floor + 1;
    if (next.phase !== "engine") {
      if (soc <= floor) {
        next.phase = "engine";
        return leaveHold(next);
      }
      next.phase = "battery";
      return finish(next, "force-off");
    }
    if (soc >= backOn) {
      next.phase = "battery";
      return finish(next, "force-off");
    }
    return leaveHold(next);
  }
  return leaveHold(next);
}

export function stepDrive(state, event) {
  const next = cloneDrive(state);
  const kind = event && event.type;
  if (kind === "boost") {
    next.boost = !next.boost;
    if (next.boost && engineShowing(next) && (!numeric(next.soc) || next.soc >= 22)) {
      next.mode = "electric";
      next.phase = "battery";
      return finish(next, "force-off");
    }
    return { state: next, plan: "none" };
  }
  if (kind === "engine") {
    if (next.mode === "engine") {
      next.mode = "off";
      next.phase = "battery";
    } else {
      next.mode = "engine";
      next.phase = "engine";
    }
    return leaveHold(next);
  }
  if (kind === "electric") {
    const keep = next.mode === "electric" && aboveRelease(next.soc, next.boost);
    if (electricBlocked(next) && !keep) return { state: next, plan: "none" };
    next.mode = "electric";
    next.phase = "battery";
    return finish(next, "force-off");
  }
  if (kind === "cycle") {
    if (next.mode === "cycle") {
      if (next.phase === "engine") {
        next.mode = "engine";
        next.phase = "engine";
        return leaveHold(next);
      }
      next.mode = "electric";
      next.phase = "battery";
      return finish(next, "force-off");
    }
    next.mode = "cycle";
    if (numeric(next.soc) && next.soc <= holdFloor(next.boost)) {
      next.phase = "engine";
      return leaveHold(next);
    }
    next.phase = "battery";
    return finish(next, "force-off");
  }
  if (kind === "refuse") {
    next.mode = "off";
    next.phase = "battery";
    return leaveHold(next);
  }
  if (kind === "soc") {
    next.soc = numeric(event.soc) ? event.soc : null;
    return stepSoc(next);
  }
  return { state: next, plan: "none" };
}

function compactHex(text) {
  return String(text || "").toUpperCase().replace(/[^0-9A-F]/g, "");
}

function bytesAfter(compact, marker, n) {
  const i = compact.indexOf(marker);
  if (i < 0) return null;
  const start = i + marker.length;
  if (compact.length < start + n * 2) return null;
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push(parseInt(compact.slice(start + k * 2, start + k * 2 + 2), 16));
  }
  return out;
}

export function parseReply(text) {
  const compact = compactHex(text);
  const out = {};
  const rpm = bytesAfter(compact, "410C", 2);
  if (rpm) out.rpm = decodeRpm(rpm[0], rpm[1]);
  const speed = bytesAfter(compact, "410D", 1);
  if (speed) out.speedKmh = speed[0];
  const fuel = bytesAfter(compact, "415E", 2);
  if (fuel) out.fuelLph = decodeFuelLph(fuel[0], fuel[1]);
  const maf = bytesAfter(compact, "4110", 2);
  if (maf) out.mafGs = decodeMaf(maf[0], maf[1]);
  const soc = bytesAfter(compact, "415B", 1);
  if (soc) out.soc = decodeSoc(soc[0]);
  const volts = bytesAfter(compact, "622429", 2);
  if (volts) out.voltage = decodeVoltage(volts[0], volts[1]);
  const amps = bytesAfter(compact, "622414", 2);
  if (amps) out.current = decodeCurrent(amps[0], amps[1]);
  return out;
}

export function replySilent(text) {
  const raw = String(text || "").toUpperCase();
  if (raw.includes("NO DATA") || raw.includes("UNABLE") || raw.includes("ERROR")) return true;
  const compact = compactHex(raw);
  return compact.includes("7F") && !compact.includes("410C") && !compact.includes("410D")
    && !compact.includes("415E") && !compact.includes("4110") && !compact.includes("415B")
    && !compact.includes("622429") && !compact.includes("622414");
}

export function holdRefused(text) {
  const compact = compactHex(text);
  if (!compact.includes("7F")) return false;
  if (compact.includes("6E")) return false;
  return true;
}

const MPG_TOP = 250;

function cappedMpg(mph, perHour) {
  if (!numeric(perHour) || perHour <= 0) return MPG_TOP;
  const mpg = mph / perHour;
  if (!Number.isFinite(mpg) || mpg > MPG_TOP) return MPG_TOP;
  return mpg;
}

export function economy(state) {
  const row = state || {};
  if (!numeric(row.speedKmh)) return { label: "MPG", value: null };
  const mph = row.speedKmh * 0.621371;
  if (mph < 1) return { label: "MPG", value: 0 };
  const fuelUsable = row.fuelKnown !== false && numeric(row.fuelLph);
  if (fuelUsable && row.fuelLph >= 0.05) {
    return { label: "MPG", value: cappedMpg(mph, row.fuelLph * 0.264172) };
  }
  const rpmKnown = numeric(row.rpm);
  if (!rpmKnown || row.rpm < 400) return { label: "MPG", value: null };
  if (fuelUsable) return { label: "MPG", value: cappedMpg(mph, row.fuelLph * 0.264172) };
  const mafKnown = row.mafKnown !== false && numeric(row.mafGs);
  if (mafKnown) {
    const gph = (row.mafGs / 14.7) * 3600 / 453.592 / 6.17;
    return { label: "MPG", value: cappedMpg(mph, gph) };
  }
  return { label: "MPG", value: null };
}

export function noteVoltFuel(state, text, timedOut) {
  const prior = state || {};
  const next = { ...prior };
  next.mafKnown = prior.mafKnown;
  next.mafGs = prior.mafGs;
  if (!timedOut) {
    const parsed = parseReply(text);
    if (parsed.fuelLph != null) {
      next.fuelLph = parsed.fuelLph;
      next.fuelKnown = true;
      next.askFuel = true;
      return next;
    }
  }
  if (timedOut || replySilent(text)) {
    next.fuelLph = null;
    next.fuelKnown = false;
    next.askFuel = false;
    return next;
  }
  next.askFuel = prior.askFuel !== false;
  return next;
}

export function promptAfterTimeout(timedOut) {
  return !!timedOut;
}

export function takePrompt(discardNext, buffer) {
  const text = String(buffer == null ? "" : buffer);
  const at = text.indexOf(">");
  if (at < 0) return { ready: false, discardNext: !!discardNext, text: "", rest: text };
  const head = text.slice(0, at + 1);
  const rest = text.slice(at + 1);
  if (discardNext) return { ready: true, discardNext: false, text: "", rest };
  return { ready: true, discardNext: false, text: head, rest };
}

export function holdCommands() {
  return {
    ok: true,
    commands: ["ATSH 7E1", TESTER, FORCE_OFF],
  };
}

export function forceOnCommands() {
  return {
    ok: true,
    commands: ["ATSH 7E1", TESTER, FORCE_ON],
  };
}

export function releaseCommands() {
  return ["ATSH 7E1", RELEASE];
}

// Engine mode and Cycle's engine phase are the car's Normal at every charge and every rpm.
// The charge hold is not a plan. A refused hold does not start one.
export function quietPlan(row) {
  void row;
  return "none";
}

// A new link sends no module frame. Engine mode is the same silence as no mode.
// A force-off hold releases only when stepDrive leaves that hold.
export function attachRelease(state) {
  void state;
  return [];
}

export function onHoldRefused(queue, asserted) {
  return {
    queue: queue.filter((item) => item.tag !== "hold"),
    asserted: false,
    electric: false,
    commands: asserted ? releaseCommands() : [],
  };
}

// iOS Web Bluetooth advertises write-without-response, then the write never reaches the car.
export function writePlan(properties) {
  const props = properties || {};
  const withResponse = !!props.write;
  const withoutResponse = !!props.writeWithoutResponse;
  if (withoutResponse && !withResponse) {
    return ["writeValueWithoutResponse", "writeValueWithResponse"];
  }
  return ["writeValueWithResponse", "writeValueWithoutResponse"];
}

// One ELM line is at most 20 bytes per write. A spaced line that does not fit is compacted, then split.
export function packLine(cmd) {
  const trimmed = String(cmd == null ? "" : cmd).trim();
  const spaced = trimmed + "\r";
  const line = spaced.length <= 20 ? spaced : trimmed.replace(/ /g, "") + "\r";
  const chunks = [];
  for (let i = 0; i < line.length; i += 20) chunks.push(line.slice(i, i + 20));
  return chunks;
}

export const RECONNECT_CAP = 5;

export function reconnectPlan(input) {
  const row = input || {};
  const attempts = Number(row.attempts) || 0;
  if (row.userDisconnect || attempts >= RECONNECT_CAP) {
    return { retry: false, text: "Not Connected", wait: 0 };
  }
  const waits = [500, 1000, 2000, 2000, 2000];
  return { retry: true, text: "Reconnecting", wait: waits[Math.min(attempts, waits.length - 1)] };
}

export const TRIP_HOLD_MS = 700;

export function milesPerHour(speedKmh) {
  if (typeof speedKmh !== "number" || !Number.isFinite(speedKmh)) return null;
  return speedKmh * 0.621371;
}

export function engineKnown(row) {
  const item = row || {};
  if (item.proved === true) return true;
  const rpmOk = typeof item.rpm === "number" && Number.isFinite(item.rpm);
  if (rpmOk && item.rpm >= 400) return true;
  if (typeof item.speedKmh === "number" && Number.isFinite(item.speedKmh) && item.speedKmh > 0 && rpmOk) return true;
  return false;
}

export function tripRecord(trip) {
  const row = trip && typeof trip === "object" ? trip : {};
  const miles = Number(row.miles);
  const electricMiles = Number(row.electricMiles);
  return {
    miles: Number.isFinite(miles) && miles >= 0 ? miles : 0,
    electricMiles: Number.isFinite(electricMiles) && electricMiles >= 0 ? electricMiles : 0,
  };
}

export function clearedTrip() {
  return { miles: 0, electricMiles: 0 };
}

// One counter. Engine shut off is rpm under 400. A null rpm does not add electric miles.
// A gap of 60 seconds still counts. A longer gap adds nothing. Speed under 1 mph adds nothing.
export function tripStep(trip, sample) {
  const base = tripRecord(trip);
  const row = sample || {};
  const dt = Number(row.dt);
  const mph = Number(row.mph);
  let miles = base.miles;
  let electricMiles = base.electricMiles;
  if (dt > 0 && dt <= 60 && Number.isFinite(mph) && mph >= 1) {
    const added = (mph * dt) / 3600;
    miles += added;
    const rpm = row.rpm;
    if (typeof rpm === "number" && Number.isFinite(rpm) && rpm < 400) electricMiles += added;
  }
  return { miles, electricMiles };
}

export function decodeDtcBytes(a, b) {
  const prefix = "PCBU"[a >> 6] || "P";
  const digit = (a >> 4) & 3;
  const rest = ((a & 0x0f) << 8) | (b & 0xff);
  return prefix + String(digit) + rest.toString(16).toUpperCase().padStart(3, "0");
}

export function parseDtcResponse(text) {
  const raw = String(text || "").toUpperCase();
  if (!raw.trim()) return null;
  if (raw.includes("NO DATA") || raw.includes("UNABLE") || raw.includes("ERROR") || raw.includes("STOPPED") || raw.includes("?")) {
    return null;
  }
  const compact = raw.replace(/[^0-9A-F]/g, "");
  const match = compact.match(/4(?:3|7|A)([0-9A-F]{2})([0-9A-F]*)/);
  if (!match) return null;
  const count = parseInt(match[1], 16);
  if (!Number.isFinite(count)) return null;
  const data = match[2];
  const codes = [];
  for (let i = 0; i < count; i++) {
    const hex = data.slice(i * 4, i * 4 + 4);
    if (hex.length < 4) break;
    codes.push(decodeDtcBytes(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16)));
  }
  return codes;
}

export function clearAccepted(text) {
  const raw = String(text || "").toUpperCase();
  if (!raw.includes(">")) return false;
  if (raw.includes("NO DATA") || raw.includes("UNABLE") || raw.includes("ERROR") || raw.includes("STOPPED") || raw.includes("?")) {
    return false;
  }
  const compact = raw.replace(/[^0-9A-F]/g, "");
  if (compact.includes("7F")) return false;
  if (raw.includes("OK")) return true;
  return compact.includes("44");
}

export function adapterLine(input) {
  const row = input || {};
  if (!row.hasBluetooth) return "No Bluetooth";
  if (row.availability === false) return "Bluetooth Off";
  const errorName = row.errorName || "";
  if (errorName === "NotAllowedError" || errorName === "SecurityError") return "Allow Nearby Devices";
  if (row.reconnecting) return "Reconnecting";
  if (row.connected) {
    const name = row.name || "Adapter";
    return row.noReply ? name + " · No Reply" : name;
  }
  return "Not Connected";
}

export function connectFace(input) {
  const row = input || {};
  const lit = !!(row.connected && !row.reconnecting);
  return { label: lit ? "CONNECTED" : "CONNECT", lit };
}
