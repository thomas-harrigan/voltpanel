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

export function decodePedal(a) {
  return (a * 100) / 255;
}

export function holdFloor(boost) {
  return boost ? 22 : 45;
}

// Rpm 1–399 is a crank. The engine-off hold does not continue through it.
export function holdThroughCrank(row) {
  void row;
  return false;
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
  const previous = row.previousPlan;
  return {
    mode,
    boost: !!row.boost,
    phase: row.phase === "engine" ? "engine" : "battery",
    soc: numeric(row.soc) ? row.soc : null,
    lockUntil: numeric(row.lockUntil) ? row.lockUntil : null,
    previousPlan: previous === "force-off" || previous === "force-on" || previous === "release" ? previous : "none",
  };
}

function finish(next, plan) {
  if (plan === "force-off" || plan === "force-on") next.previousPlan = plan;
  else if (plan === "release") next.previousPlan = "none";
  return { state: next, plan };
}

function leaveHold(next) {
  if (next.previousPlan === "force-off" || next.previousPlan === "force-on") return finish(next, "release");
  return { state: next, plan: "none" };
}

// Engine mode and a charge phase send engine-on at every charge level, including an empty reading.
function engineOn(next) {
  return finish(next, "force-on");
}

function engineShowing(next) {
  return next.mode === "engine" || (next.mode === "cycle" && next.phase === "engine");
}

// Boost is done. The charge phase then sends engine-on until 46%.
function endBoost(next) {
  next.boost = false;
  next.lockUntil = null;
  next.mode = "cycle";
  next.phase = "engine";
  return engineOn(next);
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
    if (next.mode === "engine" || (next.mode === "cycle" && next.phase === "engine")) return engineOn(next);
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
      return engineOn(next);
    }
    next.phase = "battery";
    return finish(next, "force-off");
  }
  if (next.mode === "engine") {
    next.phase = "engine";
    return engineOn(next);
  }
  if (next.mode === "cycle") {
    // One point above the floor turns the battery back on. lockUntil is not a gate.
    const backOn = floor + 1;
    if (next.phase !== "engine") {
      if (soc <= floor) {
        next.phase = "engine";
        return engineOn(next);
      }
      next.phase = "battery";
      return finish(next, "force-off");
    }
    if (soc >= backOn) {
      next.phase = "battery";
      return finish(next, "force-off");
    }
    return engineOn(next);
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
      return leaveHold(next);
    }
    next.mode = "engine";
    next.phase = "engine";
    return engineOn(next);
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
        return engineOn(next);
      }
      next.mode = "electric";
      next.phase = "battery";
      return finish(next, "force-off");
    }
    next.mode = "cycle";
    if (numeric(next.soc) && next.soc <= holdFloor(next.boost)) {
      next.phase = "engine";
      return engineOn(next);
    }
    next.phase = "battery";
    return finish(next, "force-off");
  }
  if (kind === "refuse") {
    if (next.mode === "electric" || next.mode === "engine" || next.mode === "cycle") {
      return finish(next, "force-on");
    }
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
  const pedal = bytesAfter(compact, "4149", 1);
  if (pedal) out.pedalPct = decodePedal(pedal[0]);
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
    && !compact.includes("4149") && !compact.includes("415E") && !compact.includes("4110")
    && !compact.includes("415B") && !compact.includes("622429") && !compact.includes("622414");
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

// Engine mode above 22% is the engine-off hold in stepDrive. This plan stays empty.
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

export const FLOOR_PCT = 95;
export const FLOOR_HOLD_MS = 10000;
export const LINK_CHARGE_MS = 3000;

export function emptyFloor() {
  return {
    pedalPct: null,
    pedalKnown: false,
    prevKmh: null,
    prevAt: null,
    samples: 0,
    active: false,
    t0: 0,
    held: false,
    blocked: false,
  };
}

function floorDown(row) {
  return row.pedalKnown === true && typeof row.pedalPct === "number" && row.pedalPct >= FLOOR_PCT;
}

// Constant power, not a straight line: 60 mph lands at 11.0 s, so expected speed is sqrt(prev² + 2kt) with k = 60² / (2×11), and that shape runs through 65 mph.
// A floored pedal turns the engine on only when the next speed, in hundredths of a mile per hour, is under that curve.
export function floorAssist(state, event) {
  const row = Object.assign(emptyFloor(), state || {});
  const now = event && typeof event.now === "number" && Number.isFinite(event.now) ? event.now : 0;
  const type = event && event.type;
  if (type === "cancel") {
    row.active = false;
    row.held = false;
    row.samples = 0;
    row.prevKmh = null;
    row.prevAt = null;
    return { state: row, plan: "none" };
  }
  if (type === "refused") {
    row.active = false;
    row.held = false;
    row.blocked = true;
    row.samples = 0;
    row.prevKmh = null;
    row.prevAt = null;
    return { state: row, plan: "none" };
  }
  if (type === "pedal") {
    if (typeof event.pedalPct !== "number" || !Number.isFinite(event.pedalPct)) {
      row.pedalPct = null;
      row.pedalKnown = false;
    } else {
      row.pedalPct = event.pedalPct;
      row.pedalKnown = true;
    }
  }
  const down = floorDown(row);
  if (!down) {
    row.blocked = false;
    row.samples = 0;
    row.prevKmh = null;
    row.prevAt = null;
    if (row.active) row.held = false;
  } else if (type === "speed" && typeof event.speedKmh === "number" && Number.isFinite(event.speedKmh)) {
    const speed = event.speedKmh;
    const mph = milesPerHour(speed);
    const prevMph = milesPerHour(row.prevKmh);
    const prevAt = row.prevAt;
    row.samples += 1;
    if (prevMph != null && typeof prevAt === "number" && Number.isFinite(prevAt) && mph != null && !row.blocked) {
      const dtSeconds = (now - prevAt) / 1000;
      if (dtSeconds > 0 && dtSeconds <= 4 && prevMph < 65) {
        const k = (60 * 60) / (2 * 11);
        const expectedMph = Math.sqrt((prevMph * prevMph) + (2 * k * dtSeconds));
        if (Math.round(mph * 100) < Math.round(expectedMph * 100)) {
          if (!row.active) row.t0 = now;
          row.active = true;
          row.held = true;
        }
      }
    }
    row.prevKmh = speed;
    row.prevAt = now;
  }
  if (row.active && now >= row.t0 + FLOOR_HOLD_MS && !row.held) row.active = false;
  return { state: row, plan: row.active ? "engine" : "none" };
}

// Full pack, engine turning, and almost no current. A parked 100% at 0 rpm does not set it.
export function unusedPack(latched, sample) {
  const row = sample || {};
  const soc = row.soc;
  const rpm = row.rpm;
  const current = row.current;
  const socNum = typeof soc === "number" && Number.isFinite(soc);
  const currentNum = typeof current === "number" && Number.isFinite(current);
  let on = latched === true;
  if (on) {
    if (socNum && soc < 98) on = false;
    if (currentNum && Math.abs(current) >= 5) on = false;
  } else if (socNum && soc >= 98 && typeof rpm === "number" && Number.isFinite(rpm) && rpm >= 400 && currentNum && Math.abs(current) < 5) {
    on = true;
  }
  return on;
}

function desiredHold(mode, phase) {
  if (mode === "engine" || (mode === "cycle" && phase === "engine")) return "force-on";
  if (mode === "electric" || mode === "cycle") return "force-off";
  return "none";
}

// While a mode is selected the bus is force-on or force-off. Release is only for no mode.
export function linkCommand(input) {
  const row = input || {};
  const mode = row.mode === "electric" || row.mode === "engine" || row.mode === "cycle" ? row.mode : "off";
  if (mode === "off") return row.plan === "release" ? "release" : "none";
  if (row.latched === true || row.stretch === true) return "force-on";
  const rpm = typeof row.rpm === "number" && Number.isFinite(row.rpm) ? row.rpm : null;
  if (rpm != null && rpm > 0 && rpm < 400) return "force-on";
  let desired = row.plan === "force-on" || row.plan === "force-off" ? row.plan : null;
  if (row.plan === "release" || desired == null) desired = desiredHold(mode, row.phase);
  if (desired !== "force-off") return "force-on";
  const samples = Array.isArray(row.samples) ? row.samples : [];
  const older = samples.length >= 2 ? Number(samples[samples.length - 2]) : NaN;
  const newer = samples.length >= 2 ? Number(samples[samples.length - 1]) : NaN;
  const stable = Number.isFinite(older) && Number.isFinite(newer) && Math.abs(older - newer) <= 2;
  const age = typeof row.ageMs === "number" && Number.isFinite(row.ageMs) ? row.ageMs : 0;
  if (samples.length === 0 && age >= LINK_CHARGE_MS) return "force-on";
  if (!stable || holdGate(row.previousRpm, rpm) !== "hold") return "force-on";
  return "force-off";
}

// Battery Reserve keeps the mode already on the bus until the pack is at 22% or below.
// Any other flat floor sends the same Engine On frame Engine mode sends at 45%.
export function floorCommandsEngine(boost, soc) {
  if (!boost) return true;
  return numeric(soc) && soc <= 22;
}

export function floorBus(plan, boost, soc) {
  if (plan !== "engine") return null;
  if (!floorCommandsEngine(boost, soc)) return null;
  return "force-on";
}

// While the last pedal is floored, this tick asks speed, then pedal, then one other PID.
export function pollTick(rows, index, options) {
  const list = Array.isArray(rows) ? rows : [];
  const count = list.length;
  if (!count) return { jobs: [], index: 0 };
  const opts = options || {};
  const askFuel = opts.askFuel !== false;
  const askPedal = opts.askPedal !== false;
  const floored = opts.floored === true;
  let cursor = Number(index);
  if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;
  const skipped = (tag) => (tag === "fuel" && !askFuel) || (tag === "pedal" && !askPedal);
  if (!floored) {
    for (let n = 0; n < count; n += 1) {
      const row = list[cursor % count];
      cursor += 1;
      if (skipped(row[2])) continue;
      return { jobs: [row], index: cursor };
    }
    return { jobs: [], index: cursor };
  }
  const jobs = [];
  const speed = list.find((row) => row[2] === "speed");
  const pedal = list.find((row) => row[2] === "pedal");
  if (speed) jobs.push(speed);
  if (pedal && !skipped("pedal")) jobs.push(pedal);
  for (let n = 0; n < count; n += 1) {
    const row = list[cursor % count];
    cursor += 1;
    if (row[2] === "speed" || row[2] === "pedal") continue;
    if (skipped(row[2])) continue;
    jobs.push(row);
    break;
  }
  return { jobs, index: cursor };
}

// Header is the one last written. A committed pedal or speed job keeps its own header.
export function commitWrite(header, job) {
  const row = job || {};
  const cmd = String(row.cmd || "");
  const now = header || "";
  const commands = [];
  if (row.tag !== "hdr" && row.head && row.head !== now) commands.push("ATSH " + row.head);
  if (cmd) commands.push(cmd);
  let next = now;
  for (const line of commands) {
    if (line.startsWith("ATSH ")) next = line.slice(5).trim();
  }
  return { commands, header: next };
}

export function floorFace(mode, phase, assist) {
  const cycle = mode === "cycle";
  const enginePhase = phase === "engine";
  return {
    cycle,
    electric: !assist && (mode === "electric" || (cycle && !enginePhase)),
    engine: !!assist || mode === "engine" || (cycle && enginePhase),
  };
}

// Rpm 0 may hold the engine off. 1–399 is a start, so the hold lets go.
// One sample at 400 can be the crank. The next sample at 400 or more may hold again.
// Speed is not an input.
export function holdGate(previousRpm, rpm) {
  if (!numeric(rpm)) return "wait";
  if (rpm === 0) return "hold";
  if (rpm > 0 && rpm < 400) return "release";
  if (rpm >= 400 && numeric(previousRpm) && previousRpm >= 400) return "hold";
  return "wait";
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
    const engine = row.engine === true;
    if (!engine && typeof rpm === "number" && Number.isFinite(rpm) && rpm < 400) electricMiles += added;
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
