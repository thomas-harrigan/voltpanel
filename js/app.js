import {
  BLE_LAYOUTS,
  INIT,
  TRIP_HOLD_MS,
  adapterLine,
  connectFace,
  clearAccepted,
  clearedTrip,
  economy,
  attachRelease,
  electricBlocked,
  holdCommands,
  forceOnCommands,
  holdRefused,
  kilowatts,
  quietPlan,
  restorePhase,
  milesPerHour,
  onHoldRefused,
  packLine,
  parseDtcResponse,
  parseReply,
  reconnectPlan,
  releaseCommands,
  replySilent,
  stepDrive,
  noteVoltFuel,
  promptAfterTimeout,
  takePrompt,
  tripRecord,
  tripStep,
  writePlan,
  holdGate,
  emptyFloor,
  floorAssist,
  floorBus,
  floorCommandsEngine,
  floorFace,
  linkCommand,
  unusedPack,
} from "./protocol.js?v=32";
import { GAUGES, SHOTS, arcPath, dash, formatMiles, formatReading, outputGeometry, rpmColors, zoneColors } from "./gauges.js?v=8";

const $ = (id) => document.getElementById(id);
const adapterEl = $("adapter");
const connectBtn = $("connect");
const sheet = $("sheet");

const state = {
  voltage: null,
  current: null,
  kw: null,
  rpm: null,
  speedKmh: null,
  fuelLph: null,
  fuelKnown: false,
  mafGs: null,
  mafKnown: false,
  soc: null,
  live: false,
};

let drive = {
  mode: "off",
  boost: false,
  phase: "battery",
  soc: null,
  lockUntil: null,
  previousPlan: "none",
  sustain: false,
};
let shotMode = false;
let device = null;
let writeChar = null;
let notifyChar = null;
let buffer = "";
let discardNext = false;
let askFuel = true;
let askPedal = true;
let floor = emptyFloor();
let lastTripEngine = false;
let waiters = [];
let queue = [];
let busy = false;
let header = "";
let lastHold = 0;
let asserted = false;
let busKind = "none";
let forceOnRejected = false;
let lastOn = 0;
let proofRpm = null;
let previousRpm = null;
let rpmMisses = 0;
let pollTimer = 0;
let holdPoll = false;
let trip = clearedTrip();
let lastTripAt = 0;
let lastTripMph = null;
let lastTripRpm = null;
let codesGen = 0;
let codesChain = Promise.resolve();
let clearArmed = false;
let clearing = false;
let holding = false;
let holdTimer = 0;
let holdPointer = null;
const poll = [
  ["7DF", "01 0C", "rpm"],
  ["7DF", "01 0D", "speed"],
  ["7DF", "01 49", "pedal"],
  ["7DF", "01 5E", "fuel"],
  ["7E0", "01 10", "maf"],
  ["7DF", "01 5B", "soc"],
  ["7E1", "22 2429", "voltage"],
  ["7E1", "22 2414", "current"],
];
let pollIndex = 0;
let promptSeen = false;
let noReply = false;
let probing = false;
let linkGen = 0;
let writeMethods = ["writeValueWithResponse", "writeValueWithoutResponse"];
let writeMethodIndex = 0;
let gattWatch = null;
let gattDevice = null;
let userGone = false;
let reconnecting = false;
let retryCount = 0;
let retryTimer = 0;
let retryGen = 0;
let radioOn = null;
let statusError = "";
let wakeLock = null;
let socWindow = [];
let linkReadyAt = 0;
let packLatched = false;
let stayReported = null;
let resumePending = false;
let audioCtx = null;
let audioOsc = null;
let audioGain = null;
let audioArmed = false;

function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

function floorShowing() {
  return !shotMode && (packLatched || (floor.active && floorCommandsEngine(drive.boost, drive.soc)));
}

function modeSelected() {
  return drive.mode === "electric" || drive.mode === "engine" || drive.mode === "cycle";
}

function chargeStable() {
  if (socWindow.length < 2) return false;
  return Math.abs(socWindow[socWindow.length - 2] - socWindow[socWindow.length - 1]) <= 2;
}

function noteCharge(soc) {
  if (typeof soc !== "number" || !Number.isFinite(soc)) return;
  socWindow.push(soc);
  if (socWindow.length > 2) socWindow.shift();
}

function resetLinkGate() {
  socWindow = [];
  linkReadyAt = 0;
  packLatched = false;
}

function paintModes() {
  const face = floorFace(drive.mode, drive.phase, floorShowing());
  const holding = drive.mode === "electric";
  const blocked = electricBlocked(drive);
  const cycle = face.cycle;
  const electricOn = face.electric;
  const engineOn = face.engine;
  const electricBtn = $("electric");
  electricBtn.classList.toggle("on", electricOn);
  electricBtn.setAttribute("aria-pressed", electricOn ? "true" : "false");
  if (blocked && !holding) electricBtn.setAttribute("aria-disabled", "true");
  else electricBtn.removeAttribute("aria-disabled");
  const engineBtn = $("engine");
  engineBtn.classList.toggle("on", engineOn);
  engineBtn.setAttribute("aria-pressed", engineOn ? "true" : "false");
  const cycleBtn = $("cycle");
  cycleBtn.classList.toggle("on", cycle);
  cycleBtn.setAttribute("aria-pressed", cycle ? "true" : "false");
  const boostBtn = $("boost");
  boostBtn.classList.toggle("on", !!drive.boost);
  boostBtn.setAttribute("aria-pressed", drive.boost ? "true" : "false");
}

function bindDepression(btn) {
  let pointerId = null;
  const clear = () => {
    pointerId = null;
    btn.classList.remove("pressed");
  };
  const inside = (event) => {
    const box = btn.getBoundingClientRect();
    return event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
  };
  btn.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    pointerId = event.pointerId;
    btn.classList.add("pressed");
  });
  btn.addEventListener("pointermove", (event) => {
    if (pointerId !== event.pointerId) return;
    if (!inside(event)) clear();
  });
  const end = (event) => {
    if (pointerId !== event.pointerId) return;
    clear();
  };
  btn.addEventListener("pointerup", end);
  btn.addEventListener("pointercancel", end);
  btn.addEventListener("pointerleave", end);
}

function paintGauge(key, value) {
  const spec = GAUGES[key];
  const shown = spec.decimals === 1 && Number.isFinite(value) ? Math.round(value * 10) / 10 : value;
  const next = dash(shown, spec.min, spec.max);
  const fill = $("fill-" + key);
  fill.style.strokeLinecap = next.startsWith("0.00") ? "butt" : "round";
  if (fill.getAttribute("stroke-dasharray") !== next) fill.setAttribute("stroke-dasharray", next);
  const colorSpec = key === "economy" ? { ...spec, max: 40 } : spec;
  const [a, b] = spec.solid ? [spec.solid, spec.solid] : (key === "rpm" ? rpmColors(value) : zoneColors(value, colorSpec));
  const stop0 = $("stop0-" + key);
  const stop1 = $("stop1-" + key);
  if (stop0 && stop0.getAttribute("stop-color") !== a) stop0.setAttribute("stop-color", a);
  if (stop1 && stop1.getAttribute("stop-color") !== b) stop1.setAttribute("stop-color", b);
  setText($("num-" + key), spec.decimals === 1 ? formatMiles(value) : formatReading(value));
}

function paintOutput(kw) {
  const view = outputGeometry(kw);
  const fill = $("fill-output");
  fill.style.strokeLinecap = view.cap;
  if (fill.getAttribute("stroke-dasharray") !== view.dasharray) fill.setAttribute("stroke-dasharray", view.dasharray);
  if (fill.getAttribute("stroke-dashoffset") !== view.dashoffset) fill.setAttribute("stroke-dashoffset", view.dashoffset);
  const [a, b] = view.colors;
  const stop0 = $("stop0-output");
  const stop1 = $("stop1-output");
  if (stop0 && stop0.getAttribute("stop-color") !== a) stop0.setAttribute("stop-color", a);
  if (stop1 && stop1.getAttribute("stop-color") !== b) stop1.setAttribute("stop-color", b);
  setText($("num-output"), view.text);
}

function paintEconomy(result) {
  setText($("label-economy"), "MPG");
  setText($("unit-economy"), "mpg");
  paintGauge("economy", result.value);
}

function paintMiles() {
  paintGauge("electric", trip.electricMiles);
  paintGauge("trip", trip.miles);
}

function paintLive() {
  paintGauge("battery", state.soc);
  paintOutput(state.kw);
  paintMiles();
  paintGauge("rpm", state.rpm);
  paintEconomy(economy(state));
  paintModes();
}

function applyShot(shot) {
  shotMode = true;
  drive = {
    mode: shot.mode,
    boost: !!shot.boost,
    phase: shot.phase === "engine" ? "engine" : "battery",
    soc: shot.soc,
    lockUntil: shot.lockUntil == null ? null : shot.lockUntil,
    previousPlan: shot.mode === "electric" ? "force-off" : "none",
    sustain: false,
  };
  state.soc = shot.soc;
  state.kw = shot.kw;
  state.rpm = shot.rpm;
  paintGauge("battery", shot.soc);
  paintOutput(shot.kw);
  paintGauge("rpm", shot.rpm);
  setText($("label-economy"), "MPG");
  setText($("unit-economy"), "mpg");
  paintGauge("economy", shot.mpg);
  paintMiles();
  paintModes();
}

function loadDrive() {
  const blank = {
    mode: "off",
    boost: false,
    phase: "battery",
    soc: null,
    lockUntil: null,
    previousPlan: "none",
    sustain: false,
  };
  try {
    let mode = localStorage.getItem("voltpanel.mode");
    const legacy = localStorage.getItem("voltpanel.electric") === "1";
    if (mode !== "off" && mode !== "electric" && mode !== "engine" && mode !== "cycle") {
      mode = legacy ? "electric" : "off";
    }
    localStorage.removeItem("voltpanel.lockUntil");
    localStorage.removeItem("voltpanel.electric");
    const phase = restorePhase(mode, localStorage.getItem("voltpanel.phase"));
    const opening = mode === "engine" || (mode === "cycle" && phase === "engine")
      ? "force-on"
      : (mode === "electric" || mode === "cycle" ? "force-off" : "none");
    return {
      mode,
      boost: localStorage.getItem("voltpanel.boost") === "1",
      phase,
      soc: null,
      lockUntil: null,
      previousPlan: opening,
      sustain: localStorage.getItem("voltpanel.sustain") === "1",
    };
  } catch {
    return blank;
  }
}

function loadTrip() {
  try {
    const raw = localStorage.getItem("voltpanel.trip");
    trip = tripRecord(raw ? JSON.parse(raw) : null);
  } catch {
    trip = clearedTrip();
  }
}

function saveTrip() {
  if (shotMode) return;
  try {
    localStorage.setItem("voltpanel.trip", JSON.stringify(tripRecord(trip)));
  } catch {
    /* private mode */
  }
}

function noteTripSample() {
  if (shotMode) return;
  const now = Date.now();
  const mph = milesPerHour(state.speedKmh);
  if (lastTripAt) {
    const next = tripStep(trip, {
      mph: lastTripMph,
      rpm: lastTripRpm,
      dt: (now - lastTripAt) / 1000,
      engine: floorShowing() || lastTripEngine,
    });
    const changed = next.miles !== trip.miles || next.electricMiles !== trip.electricMiles;
    trip = next;
    if (changed) saveTrip();
  }
  lastTripAt = now;
  lastTripMph = mph;
  lastTripRpm = Number.isFinite(state.rpm) ? state.rpm : null;
  lastTripEngine = floorShowing();
}

function persistDrive() {
  if (shotMode) return;
  try {
    localStorage.setItem("voltpanel.mode", drive.mode);
    localStorage.setItem("voltpanel.boost", drive.boost ? "1" : "0");
    if (drive.mode === "cycle") localStorage.setItem("voltpanel.phase", drive.phase === "engine" ? "engine" : "battery");
    else localStorage.removeItem("voltpanel.phase");
    localStorage.setItem("voltpanel.sustain", drive.sustain ? "1" : "0");
    localStorage.removeItem("voltpanel.lockUntil");
    localStorage.removeItem("voltpanel.electric");
  } catch {
    /* private mode */
  }
}

function linked() {
  return !shotMode && !!(writeChar && promptSeen);
}

function dropBus(tag) {
  if (!queue.some((job) => job.tag === tag)) return;
  queue = queue.filter((job) => job.tag !== tag);
}

function finalPlan(fallback) {
  const quiet = quietPlan({
    mode: drive.mode,
    phase: drive.phase,
    boost: drive.boost,
    soc: drive.soc,
    lockUntil: drive.lockUntil,
    forceOnOk: !forceOnRejected,
  });
  if (quiet !== "none") return quiet;
  if (modeSelected()) return fallback;
  if (busKind === "on" && fallback !== "force-off" && fallback !== "force-on") return "release";
  return fallback;
}

function keptPlan() {
  if (drive.previousPlan === "force-off") return "force-off";
  if (drive.previousPlan === "force-on") return "force-on";
  return "none";
}

function syncFloor(event) {
  const stepped = floorAssist(floor, event);
  floor = stepped.state;
  return stepped.plan;
}

function driveEnact(plan) {
  packLatched = unusedPack(packLatched, {
    soc: state.soc,
    rpm: state.rpm,
    current: state.current,
  });
  const stretch = floorBus(floor.active ? "engine" : "none", drive.boost, drive.soc) === "force-on";
  const command = linkCommand({
    mode: drive.mode,
    phase: drive.phase,
    plan,
    latched: packLatched,
    stretch,
    rpm: proofRpm,
    previousRpm,
    samples: socWindow,
    ageMs: linkReadyAt ? Date.now() - linkReadyAt : 0,
  });
  const modeWantsOn = drive.mode === "engine" || (drive.mode === "cycle" && drive.phase === "engine");
  if (command === "force-on" && plan !== "force-on" && !modeWantsOn) {
    enact("force-on", true);
    return;
  }
  if (command === "force-on" || command === "force-off" || command === "release") {
    enact(command);
    return;
  }
  enact(plan);
}

function considerOn(forceNow) {
  if (!linked()) return;
  const now = Date.now();
  if (!forceNow && now - lastOn < 2000) return;
  dropBus("hold");
  dropBus("release");
  busKind = "on";
  if (queue.some((item) => item.tag === "on")) return;
  lastOn = now;
  asserted = false;
  for (const cmd of forceOnCommands().commands) enqueue(cmd, cmd.startsWith("ATSH") ? "hdr" : "on");
}

function considerHold(forceNow) {
  if (!linked()) return;
  const gate = holdGate(previousRpm, proofRpm);
  if (gate !== "hold" || !chargeStable()) {
    if (modeSelected()) considerOn(busKind !== "on");
    return;
  }
  const now = Date.now();
  if (!forceNow && now - lastHold < 2000) return;
  dropBus("on");
  dropBus("release");
  busKind = "off";
  if (queue.some((job) => job.tag === "hold")) return;
  lastHold = now;
  asserted = true;
  for (const cmd of holdCommands().commands) enqueue(cmd, cmd.startsWith("ATSH") ? "hdr" : "hold");
}

function enact(plan, fromFloor) {
  if (plan === "force-on") {
    if (!fromFloor) drive.previousPlan = "force-on";
    considerOn(busKind !== "on");
    return;
  }
  if (plan === "force-off") {
    drive.previousPlan = "force-off";
    considerHold(busKind !== "off");
    return;
  }
  if (plan === "release") {
    const was = busKind !== "none" || asserted || drive.previousPlan === "force-off";
    asserted = false;
    busKind = "none";
    drive.previousPlan = "none";
    dropBus("on");
    dropBus("hold");
    if (linked() && was) {
      for (const cmd of releaseCommands()) enqueue(cmd, cmd.startsWith("ATSH") ? "hdr" : "release");
    }
  }
}

function applyDrive(event) {
  drive.soc = state.soc;
  const result = stepDrive(drive, event);
  drive = result.state;
  persistDrive();
  driveEnact(finalPlan(result.plan));
  paintModes();
}

function press(type) {
  syncFloor({ type: "cancel", now: Date.now() });
  drive.soc = state.soc;
  if (type === "electric" && electricBlocked(drive)) {
    if (drive.mode !== "electric") return;
    const soc = drive.soc;
    const live = drive.boost ? soc >= 22 : soc > 45;
    if (!live) return;
  }
  applyDrive({ type });
  paintLive();
}

function bluetoothMissing() {
  return typeof navigator === "undefined" || !navigator.bluetooth;
}

function paintConnect(row) {
  const face = connectFace(row);
  const node = connectBtn.querySelector(".face");
  if (node && node.textContent !== face.label) node.textContent = face.label;
  connectBtn.classList.toggle("on", face.lit);
  connectBtn.setAttribute("aria-pressed", face.lit ? "true" : "false");
  connectBtn.setAttribute("aria-label", face.lit ? "Connected" : "Connect");
}

function paintAdapter() {
  if (bluetoothMissing()) {
    setText(adapterEl, "No Bluetooth");
    paintConnect({ connected: false });
    syncAudio();
    reportSession();
    return;
  }
  const connected = !!(device && device.gatt && device.gatt.connected);
  const text = adapterLine({
    hasBluetooth: true,
    availability: radioOn,
    errorName: statusError,
    reconnecting,
    connected,
    noReply: connected && noReply,
    name: device ? (device.name || "Adapter") : "",
  });
  setText(adapterEl, text);
  paintConnect({
    connected,
    reconnecting,
    noReply: connected && noReply,
    name: device ? (device.name || "Adapter") : "",
  });
  syncAudio();
  reportSession();
}

function sessionUp() {
  return !userGone && (reconnecting || !!(device && device.gatt && device.gatt.connected));
}

function clearRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = 0;
}

async function readRadio() {
  if (bluetoothMissing() || typeof navigator.bluetooth.getAvailability !== "function") return null;
  try {
    return await navigator.bluetooth.getAvailability();
  } catch {
    return null;
  }
}

async function holdWake() {
  const locks = typeof navigator !== "undefined" ? navigator.wakeLock : null;
  if (!locks || typeof locks.request !== "function") return;
  try {
    if (wakeLock) return;
    const sentinel = await locks.request("screen");
    wakeLock = sentinel;
    sentinel.addEventListener("release", () => {
      if (wakeLock === sentinel) wakeLock = null;
    });
  } catch {
    /* the gauges still run */
  }
}

async function releaseWake() {
  const sentinel = wakeLock;
  wakeLock = null;
  if (!sentinel) return;
  try { await sentinel.release(); } catch { /* already released */ }
}

async function noteConnectError(err) {
  if (noReply && device && device.gatt && device.gatt.connected) {
    reconnecting = false;
    paintAdapter();
    return;
  }
  radioOn = await readRadio();
  statusError = (err && err.name) || "";
  reconnecting = false;
  paintAdapter();
  if (!sessionUp()) releaseWake();
}

function scheduleRetry(next) {
  const mine = ++retryGen;
  const plan = reconnectPlan({ userDisconnect: userGone, attempts: retryCount });
  if (!plan.retry || radioOn === false) {
    reconnecting = false;
    statusError = "";
    paintAdapter();
    releaseWake();
    return;
  }
  retryCount += 1;
  reconnecting = true;
  statusError = "";
  paintAdapter();
  clearRetry();
  retryTimer = setTimeout(() => {
    retryTimer = 0;
    if (mine !== retryGen || userGone || device !== next) return;
    attach(next).then(() => {
      if (mine !== retryGen || userGone || device !== next) return;
    }).catch((err) => {
      if (mine !== retryGen || userGone || device !== next) return;
      if (noReply && device.gatt && device.gatt.connected) {
        reconnecting = false;
        retryCount = 0;
        paintAdapter();
        return;
      }
      scheduleRetry(next);
    });
  }, plan.wait);
}

function clearProof() {
  proofRpm = null;
  previousRpm = null;
  rpmMisses = 0;
}

function onLinkDrop(next) {
  if (device !== next) return;
  clearProof();
  resetLinkGate();
  linkGen += 1;
  clearInterval(pollTimer);
  clearQueue();
  probing = false;
  if (notifyChar) notifyChar.removeEventListener("characteristicvaluechanged", onNotify);
  writeChar = null;
  notifyChar = null;
  asserted = false;
  busKind = "none";
  floor = emptyFloor();
  askPedal = true;
  lastTripEngine = false;
  promptSeen = false;
  noReply = false;
  buffer = "";
  discardNext = false;
  dropWaiters();
  if (userGone) {
    reconnecting = false;
    statusError = "";
    paintAdapter();
    return;
  }
  scheduleRetry(next);
}

function openSettings() {
  paintAdapter();
  sheet.hidden = false;
}

function closeSettings() {
  sheet.hidden = true;
}

function enqueue(cmd, tag, timeout) {
  if (tag === "hdr") {
    const want = cmd.slice(5);
    if (want === header) return;
    header = want;
  }
  queue.push({ cmd, tag, timeout: timeout || (cmd === "ATZ" ? 2500 : 1200) });
  pump();
}

function enqueuePid(head, cmd, tag) {
  if (head !== header) enqueue("ATSH " + head, "hdr", 800);
  enqueue(cmd, tag, 1200);
}

async function pump() {
  if (busy || probing || !queue.length || !writeChar) return;
  busy = true;
  const job = queue.shift();
  let text = "";
  let timedOut = false;
  try {
    text = await transact(job.cmd, job.timeout);
  } catch {
    text = "";
    timedOut = true;
  }
  onReply(job, text, timedOut);
  busy = false;
  setTimeout(pump, 200);
}

function clearQueue() {
  const pending = queue.splice(0);
  for (const job of pending) {
    if (typeof job.resolve === "function") job.resolve("");
  }
}

function dropWaiters() {
  const pending = waiters.splice(0);
  for (const waiter of pending) waiter("");
}

function drainBuffer() {
  let step = takePrompt(discardNext, buffer);
  while (step.ready) {
    buffer = step.rest;
    discardNext = step.discardNext;
    if (step.text) {
      const waiter = waiters.shift();
      if (waiter) waiter(step.text);
      return;
    }
    step = takePrompt(discardNext, buffer);
  }
}

async function settlePrompt() {
  if (!discardNext) return;
  const started = Date.now();
  while (discardNext && Date.now() - started < 150) {
    drainBuffer();
    if (!discardNext) return;
    await wait(20);
  }
  drainBuffer();
}

async function transact(cmd, timeout) {
  await settlePrompt();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (text, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      waiters = waiters.filter((w) => w !== finish);
      if (err) reject(err);
      else resolve(text);
    };
    const timer = setTimeout(() => {
      discardNext = promptAfterTimeout(true);
      finish("", new Error("timeout"));
    }, timeout);
    waiters.push(finish);
    writeChunks(cmd).catch(() => finish(""));
  });
}

async function writeChunks(cmd) {
  const method = writeMethods[writeMethodIndex] || "writeValueWithResponse";
  const encoder = new TextEncoder();
  for (const chunk of packLine(cmd)) {
    await writeChar[method](encoder.encode(chunk));
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probePrompt() {
  if (!discardNext) buffer = "";
  try {
    const text = await transact("ATZ", 2500);
    return typeof text === "string" && text.includes(">");
  } catch {
    return false;
  }
}

async function openSession() {
  const mine = linkGen;
  promptSeen = false;
  noReply = false;
  writeMethods = writePlan(writeChar.properties || {});
  writeMethodIndex = 0;
  buffer = "";
  discardNext = false;
  askFuel = true;
  askPedal = true;
  floor = emptyFloor();
  lastTripEngine = false;
  header = "";
  clearInterval(pollTimer);
  clearQueue();
  probing = true;
  notifyChar.removeEventListener("characteristicvaluechanged", onNotify);
  notifyChar.addEventListener("characteristicvaluechanged", onNotify);
  try {
    await notifyChar.startNotifications();
    await wait(400);
    if (mine !== linkGen || !writeChar) return false;
    let ok = await probePrompt();
    if (mine !== linkGen || !writeChar) return false;
    if (!ok) {
      buffer = "";
      writeMethodIndex += 1;
      ok = await probePrompt();
    }
    if (mine !== linkGen || !writeChar) return false;
    if (!ok) {
      buffer = "";
      noReply = true;
      promptSeen = false;
      clearQueue();
      paintAdapter();
      return false;
    }
    promptSeen = true;
    noReply = false;
    paintAdapter();
    return true;
  } catch (err) {
    if (notifyChar) notifyChar.removeEventListener("characteristicvaluechanged", onNotify);
    throw err;
  } finally {
    probing = false;
  }
}

function onNotify(event) {
  const value = new TextDecoder().decode(event.target.value || new DataView(new ArrayBuffer(0)));
  buffer += value;
  drainBuffer();
}

function onReply(job, text, timedOut) {
  if (job.cmd === "ATZ") header = "";
  if (job.tag === "hold" && !timedOut && holdRefused(text)) {
    queue = onHoldRefused(queue, false).queue;
    if (modeSelected()) applyDrive({ type: "refuse" });
    else enact(finalPlan("release"));
    paintLive();
    return;
  }
  if (job.tag === "on" && !timedOut && holdRefused(text)) {
    forceOnRejected = true;
    queue = queue.filter((item) => item.tag !== "on");
    if (modeSelected()) driveEnact(finalPlan("force-on"));
    else enact(finalPlan("release"));
    paintLive();
    return;
  }
  if (job.tag === "rpm" && timedOut && linked()) {
    rpmMisses += 1;
    if (rpmMisses >= 3 && modeSelected()) driveEnact(finalPlan(keptPlan()));
  }
  const parsed = timedOut ? {} : parseReply(text);
  if (parsed.rpm != null) state.rpm = parsed.rpm;
  if (job.tag === "rpm" && !timedOut && typeof parsed.rpm === "number" && Number.isFinite(parsed.rpm)) {
    rpmMisses = 0;
    previousRpm = proofRpm;
    proofRpm = parsed.rpm;
  }
  if (parsed.speedKmh != null) state.speedKmh = parsed.speedKmh;
  const wasActive = floor.active;
  const nowMs = Date.now();
  if (job.tag === "pedal" && !timedOut && parsed.pedalPct != null) {
    syncFloor({ type: "pedal", pedalPct: parsed.pedalPct, now: nowMs });
  }
  if (job.tag === "speed" && !timedOut && parsed.speedKmh != null) {
    syncFloor({ type: "speed", speedKmh: parsed.speedKmh, now: nowMs });
  }
  syncFloor({ type: "tick", now: nowMs });
  if (job.tag === "speed" && !timedOut && parsed.speedKmh != null) noteTripSample();
  if (job.tag === "fuel") {
    const next = noteVoltFuel({
      fuelLph: state.fuelLph,
      fuelKnown: state.fuelKnown,
      mafGs: state.mafGs,
      mafKnown: state.mafKnown,
      askFuel,
    }, text, !!timedOut);
    state.fuelLph = next.fuelLph == null ? null : next.fuelLph;
    state.fuelKnown = !!next.fuelKnown;
    state.mafGs = next.mafGs;
    state.mafKnown = !!next.mafKnown;
    askFuel = next.askFuel !== false;
  } else if (parsed.fuelLph != null) {
    state.fuelLph = parsed.fuelLph;
    state.fuelKnown = true;
  }
  if (parsed.mafGs != null) {
    state.mafGs = parsed.mafGs;
    state.mafKnown = true;
  } else if (job.tag === "maf" && !timedOut && replySilent(text)) {
    state.mafGs = null;
    state.mafKnown = false;
  }
  if (parsed.voltage != null) state.voltage = parsed.voltage;
  if (parsed.current != null) state.current = parsed.current;
  if (state.voltage != null && state.current != null) state.kw = kilowatts(state.voltage, state.current);
  if (parsed.rpm != null || parsed.voltage != null || parsed.speedKmh != null) state.live = true;
  if (parsed.soc != null) {
    state.soc = parsed.soc;
    noteCharge(parsed.soc);
  }
  if (parsed.soc != null || (wasActive && !floor.active)) {
    applyDrive({ type: "soc", soc: state.soc });
  } else {
    driveEnact(finalPlan(keptPlan()));
  }
  paintLive();
}

function startPoll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (holdPoll || !writeChar || queue.length > 4) return;
    for (let n = 0; n < poll.length; n += 1) {
      const [head, cmd, tag] = poll[pollIndex % poll.length];
      pollIndex += 1;
      if (tag === "fuel" && !askFuel) continue;
      if (tag === "pedal" && !askPedal) continue;
      enqueuePid(head, cmd, tag);
      return;
    }
  }, 200);
}

async function attach(next) {
  const generation = linkGen;
  clearInterval(pollTimer);
  clearQueue();
  const server = await next.gatt.connect();
  let write = null;
  let notify = null;
  for (const layout of BLE_LAYOUTS) {
    let service;
    try {
      service = await server.getPrimaryService(layout.service);
    } catch {
      continue;
    }
    const chars = await service.getCharacteristics();
    notify = chars.find((c) => c.uuid === layout.notify) || chars.find((c) => c.properties.notify || c.properties.indicate);
    write = chars.find((c) => c.uuid === layout.write) || chars.find((c) => c.properties.write || c.properties.writeWithoutResponse);
    if (write && notify) break;
    write = null;
    notify = null;
  }
  if (!write || !notify) throw new Error("layout");
  if (notifyChar && notifyChar !== notify) notifyChar.removeEventListener("characteristicvaluechanged", onNotify);
  device = next;
  writeChar = write;
  notifyChar = notify;
  bindGatt(next);
  localStorage.setItem("voltpanel.device", next.id);
  paintAdapter();
  const ready = await openSession();
  if (generation !== linkGen || device !== next || userGone) return;
  if (!ready) throw new Error("no reply");
  reconnecting = false;
  retryCount = 0;
  statusError = "";
  paintAdapter();
  for (const cmd of INIT) enqueue(cmd, "init");
  startPoll();
  socWindow = [];
  linkReadyAt = Date.now();
  packLatched = false;
  driveEnact(finalPlan(keptPlan()));
  if (!modeSelected() && !queue.some((job) => job.tag === "release")) {
    for (const cmd of attachRelease(drive)) enqueue(cmd, cmd.startsWith("ATSH") ? "hdr" : "release");
  }
  reportSession();
}

function bindGatt(next) {
  if (gattWatch && gattDevice) gattDevice.removeEventListener("gattserverdisconnected", gattWatch);
  gattDevice = next;
  gattWatch = () => onLinkDrop(next);
  next.addEventListener("gattserverdisconnected", gattWatch);
}

async function connectPicker() {
  const next = await navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: "VEEPEAK" }, { namePrefix: "OBD" }],
    optionalServices: BLE_LAYOUTS.map((layout) => layout.service),
  });
  await attach(next);
}

async function reconnectSaved() {
  if (bluetoothMissing() || !navigator.bluetooth.getDevices) return;
  const id = localStorage.getItem("voltpanel.device");
  if (!id) return;
  const list = await navigator.bluetooth.getDevices();
  const saved = list.find((item) => item.id === id);
  if (!saved) return;
  await attach(saved);
}

function disconnect() {
  userGone = true;
  retryGen += 1;
  clearRetry();
  reconnecting = false;
  retryCount = 0;
  statusError = "";
  linkGen += 1;
  clearInterval(pollTimer);
  clearQueue();
  probing = false;
  if (notifyChar) notifyChar.removeEventListener("characteristicvaluechanged", onNotify);
  if (device && device.gatt && device.gatt.connected) device.gatt.disconnect();
  writeChar = null;
  notifyChar = null;
  device = null;
  asserted = false;
  busKind = "none";
  forceOnRejected = false;
  floor = emptyFloor();
  askPedal = true;
  lastTripEngine = false;
  clearProof();
  resetLinkGate();
  stayReported = null;
  stopSilentAudio();
  promptSeen = false;
  noReply = false;
  buffer = "";
  discardNext = false;
  dropWaiters();
  releaseWake();
  paintAdapter();
}

function scheduleCodes(mine, job) {
  holdPoll = true;
  codesChain = codesChain.then(async () => {
    if (mine !== codesGen) return;
    holdPoll = true;
    try {
      await job();
    } finally {
      if (mine === codesGen) holdPoll = false;
    }
  }).catch(() => {
    if (mine === codesGen) holdPoll = false;
  });
}

async function ask(cmd, timeout) {
  try {
    return await transact(cmd, timeout);
  } catch {
    return "";
  }
}

async function useHeader(head) {
  if (header === head) return true;
  const text = await ask("ATSH " + head, 800);
  if (!String(text).includes(">")) return false;
  header = head;
  return true;
}

async function whenIdle() {
  const start = Date.now();
  while ((busy || queue.length || probing) && Date.now() - start < 8000) {
    await wait(40);
  }
}

async function askCodes(mine) {
  const storedText = await ask("03", 2200);
  if (mine !== codesGen) return null;
  const pendingText = await ask("07", 2200);
  if (mine !== codesGen) return null;
  const permanentText = await ask("0A", 2200);
  if (mine !== codesGen) return null;
  return {
    stored: parseDtcResponse(storedText),
    pending: parseDtcResponse(pendingText),
    permanent: parseDtcResponse(permanentText),
  };
}

function paintCodes(result, refused) {
  const list = $("codes-list");
  list.replaceChildren();
  const stored = result && result.stored;
  const pending = result && result.pending;
  const permanent = result && result.permanent;
  const answered = !!result && (stored != null || pending != null || permanent != null);
  if (!answered) {
    setText($("codes-status"), refused ? "Not Cleared" : "No Answer");
    return;
  }
  const groups = [
    ["Stored", stored],
    ["Pending", pending],
    ["Permanent", permanent],
  ];
  let count = 0;
  for (const [title, codes] of groups) {
    if (!codes || !codes.length) continue;
    count += codes.length;
    const heading = document.createElement("h3");
    heading.textContent = title;
    list.append(heading);
    for (const code of codes) {
      const row = document.createElement("p");
      row.textContent = code;
      list.append(row);
    }
  }
  if (refused) setText($("codes-status"), "Not Cleared");
  else setText($("codes-status"), count ? "" : "No Codes");
}

async function readInto(mine, refused) {
  await whenIdle();
  if (mine !== codesGen) return;
  if (!linked()) {
    paintCodes(null, refused);
    return;
  }
  const ready = await useHeader("7DF");
  if (mine !== codesGen) return;
  if (!ready) {
    paintCodes(null, refused);
    return;
  }
  const result = await askCodes(mine);
  if (mine !== codesGen || !result) return;
  paintCodes(result, refused);
}

async function clearInto(mine) {
  await whenIdle();
  if (mine !== codesGen) return;
  if (!linked()) {
    paintCodes(null, true);
    return;
  }
  const ready = await useHeader("7DF");
  if (mine !== codesGen) return;
  if (!ready) {
    paintCodes(null, true);
    return;
  }
  const text = await ask("04", 2200);
  if (mine !== codesGen) return;
  await readInto(mine, !clearAccepted(text));
}

function openCodes() {
  clearArmed = false;
  clearing = false;
  $("clear-codes").classList.remove("armed");
  $("codes-list").replaceChildren();
  setText($("codes-status"), "");
  $("codes").hidden = false;
  const mine = ++codesGen;
  if (!linked()) {
    setText($("codes-status"), "No Answer");
    return;
  }
  scheduleCodes(mine, () => readInto(mine, false));
}

function closeCodes() {
  codesGen += 1;
  clearArmed = false;
  clearing = false;
  $("clear-codes").classList.remove("armed");
  holdPoll = false;
  $("codes").hidden = true;
  paintLive();
}

function onClearCodes() {
  if (!clearArmed) {
    clearArmed = true;
    $("clear-codes").classList.add("armed");
    return;
  }
  if (clearing) return;
  clearArmed = false;
  $("clear-codes").classList.remove("armed");
  clearing = true;
  const mine = ++codesGen;
  scheduleCodes(mine, async () => {
    try {
      await clearInto(mine);
    } finally {
      if (mine === codesGen) clearing = false;
    }
  });
}

function resetTrip() {
  trip = clearedTrip();
  lastTripAt = Date.now();
  saveTrip();
  paintMiles();
}

function bindReset() {
  const btn = $("trip-reset");
  const cancel = (event) => {
    if (!holding) return;
    if (event && event.pointerId != null && holdPointer != null && event.pointerId !== holdPointer) return;
    holding = false;
    clearTimeout(holdTimer);
    btn.classList.remove("holding");
  };
  btn.addEventListener("pointerdown", (event) => {
    if (holding) return;
    if (event.button != null && event.button !== 0) return;
    holding = true;
    holdPointer = event.pointerId;
    try { btn.setPointerCapture(event.pointerId); } catch { /* pointer already gone */ }
    btn.classList.add("holding");
    holdTimer = setTimeout(() => {
      if (!holding) return;
      holding = false;
      btn.classList.remove("holding");
      resetTrip();
    }, TRIP_HOLD_MS);
    event.preventDefault();
  });
  btn.addEventListener("pointerup", cancel);
  btn.addEventListener("pointercancel", cancel);
  window.addEventListener("pointerup", cancel);
  window.addEventListener("pointercancel", cancel);
  btn.addEventListener("contextmenu", (event) => event.preventDefault());
}

function lockScale() {
  const stop = (event) => event.preventDefault();
  document.addEventListener("gesturestart", stop, { passive: false });
  document.addEventListener("gesturechange", stop, { passive: false });
  document.addEventListener("gestureend", stop, { passive: false });
  document.addEventListener("touchmove", (event) => {
    if (event.touches.length > 1) event.preventDefault();
  }, { passive: false });
}

function armAudio() {
  audioArmed = true;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  if (!audioCtx) audioCtx = new Ctx();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
}

function startSilentAudio() {
  if (!audioArmed || !sessionUp() || document.visibilityState === "visible") return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  if (!audioCtx) audioCtx = new Ctx();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  if (!audioOsc) {
    audioGain = audioCtx.createGain();
    audioGain.gain.value = 0;
    audioOsc = audioCtx.createOscillator();
    audioOsc.frequency.value = 1;
    audioOsc.connect(audioGain);
    audioGain.connect(audioCtx.destination);
    try { audioOsc.start(); } catch { /* already started */ }
  }
  if ("mediaSession" in navigator && typeof MediaMetadata === "function") {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: "Volt" });
      navigator.mediaSession.playbackState = "playing";
    } catch { /* no session */ }
  }
}

function stopSilentAudio() {
  if (audioOsc) {
    try { audioOsc.stop(); } catch { /* already stopped */ }
    try { audioOsc.disconnect(); } catch { /* already gone */ }
  }
  audioOsc = null;
  if (audioGain) {
    try { audioGain.disconnect(); } catch { /* already gone */ }
  }
  audioGain = null;
  if ("mediaSession" in navigator) {
    try {
      navigator.mediaSession.playbackState = "none";
      navigator.mediaSession.metadata = null;
    } catch { /* no session */ }
  }
}

function syncAudio() {
  if (document.visibilityState === "visible" || !sessionUp()) stopSilentAudio();
  else startSilentAudio();
}

function reportSession() {
  const up = sessionUp();
  if (stayReported === up) return;
  const bridge = typeof AndroidBLE === "undefined" ? null : AndroidBLE;
  if (!bridge || typeof bridge.session !== "function") return;
  try {
    bridge.session(up);
    stayReported = up;
  } catch {
    /* browser page */
  }
}

function resumeLink() {
  if (shotMode || userGone || writeChar || reconnecting || resumePending) return;
  let id = "";
  try { id = localStorage.getItem("voltpanel.device") || ""; } catch { id = ""; }
  if (!id || bluetoothMissing()) return;
  resumePending = true;
  holdWake();
  reconnectSaved().then(() => {
    resumePending = false;
  }).catch((err) => {
    resumePending = false;
    noteConnectError(err);
  });
}

function boot() {
  drive = loadDrive();
  loadTrip();
  paintLive();
  paintAdapter();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  $("open-settings").addEventListener("click", openSettings);
  $("close-settings").addEventListener("click", closeSettings);
  $("scrim").addEventListener("click", closeSettings);
  $("electric").addEventListener("click", () => press("electric"));
  $("engine").addEventListener("click", () => press("engine"));
  $("cycle").addEventListener("click", () => press("cycle"));
  $("boost").addEventListener("click", () => press("boost"));
  for (const key of ["electric", "engine", "cycle", "boost"]) bindDepression($(key));
  $("diag").addEventListener("click", openCodes);
  $("diag").addEventListener("contextmenu", (event) => event.preventDefault());
  bindDepression($("diag"));
  $("codes-back").addEventListener("click", closeCodes);
  $("clear-codes").addEventListener("click", onClearCodes);
  bindReset();
  connectBtn.addEventListener("click", () => {
    if ((device && device.gatt && device.gatt.connected) || reconnecting) disconnect();
    else if (!bluetoothMissing()) {
      userGone = false;
      statusError = "";
      retryCount = 0;
      armAudio();
      holdWake();
      connectPicker().then(() => {
        if (userGone || reconnecting) return;
        closeSettings();
        paintAdapter();
      }).catch((err) => noteConnectError(err));
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      stopSilentAudio();
      if (sessionUp()) holdWake();
      resumeLink();
      return;
    }
    if (sessionUp()) startSilentAudio();
  });
  window.addEventListener("pageshow", () => {
    stopSilentAudio();
    if (sessionUp()) holdWake();
    resumeLink();
  });
  window.addEventListener("pagehide", saveTrip);
  document.addEventListener("freeze", saveTrip);
  if (navigator.bluetooth && typeof navigator.bluetooth.addEventListener === "function") {
    navigator.bluetooth.addEventListener("availabilitychanged", () => {
      readRadio().then((value) => {
        radioOn = value;
        if (radioOn === false) {
          retryGen += 1;
          clearRetry();
          reconnecting = false;
        }
        paintAdapter();
      });
    });
  }
  readRadio().then((value) => {
    radioOn = value;
    paintAdapter();
  });
  resumeLink();
}

for (const key of Object.keys(GAUGES)) {
  const d = arcPath();
  $("track-" + key).setAttribute("d", d);
  const fill = $("fill-" + key);
  fill.setAttribute("d", d);
  fill.setAttribute("stroke-dasharray", "0 100");
}

lockScale();

const shotName = new URLSearchParams(location.search).get("shot");
if (shotName && SHOTS[shotName]) applyShot(SHOTS[shotName]);
else boot();
