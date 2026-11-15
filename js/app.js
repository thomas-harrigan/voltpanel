import {
  BLE_LAYOUTS,
  INIT,
  adapterLine,
  economy,
  electricBlocked,
  holdCommands,
  holdRefused,
  kilowatts,
  onHoldRefused,
  packLine,
  parseReply,
  reconnectPlan,
  releaseCommands,
  replySilent,
  stepDrive,
  writePlan,
} from "./protocol.js?v=9";
import { GAUGES, SHOTS, arcPath, dash, formatReading, outputGeometry, rpmColors, zoneColors } from "./gauges.js?v=6";

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
};
let shotMode = false;
let device = null;
let writeChar = null;
let notifyChar = null;
let buffer = "";
let waiters = [];
let queue = [];
let busy = false;
let header = "";
let lastHold = 0;
let asserted = false;
let pollTimer = 0;
const poll = [
  ["7DF", "01 0C", "rpm"],
  ["7DF", "01 0D", "speed"],
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

function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

function paintModes() {
  const locked = electricBlocked(drive);
  const cycle = drive.mode === "cycle";
  const enginePhase = drive.phase === "engine";
  const electricOn = (drive.mode === "electric" || (cycle && !enginePhase)) && !locked;
  const engineOn = drive.mode === "engine" || (cycle && enginePhase);
  const electricBtn = $("electric");
  electricBtn.classList.toggle("on", electricOn);
  electricBtn.setAttribute("aria-pressed", electricOn ? "true" : "false");
  if (locked) electricBtn.setAttribute("aria-disabled", "true");
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
  const next = dash(value, spec.min, spec.max);
  const fill = $("fill-" + key);
  fill.style.strokeLinecap = next.startsWith("0.00") ? "butt" : "round";
  if (fill.getAttribute("stroke-dasharray") !== next) fill.setAttribute("stroke-dasharray", next);
  const [a, b] = key === "rpm" ? rpmColors(value) : zoneColors(value, spec);
  const stop0 = $("stop0-" + key);
  const stop1 = $("stop1-" + key);
  if (stop0 && stop0.getAttribute("stop-color") !== a) stop0.setAttribute("stop-color", a);
  if (stop1 && stop1.getAttribute("stop-color") !== b) stop1.setAttribute("stop-color", b);
  setText($("num-" + key), formatReading(value));
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

function paintLive() {
  paintGauge("battery", state.soc);
  paintOutput(state.kw);
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
  };
  try {
    let mode = localStorage.getItem("voltpanel.mode");
    const legacy = localStorage.getItem("voltpanel.electric") === "1";
    if (mode !== "off" && mode !== "electric" && mode !== "engine" && mode !== "cycle") {
      mode = legacy ? "electric" : "off";
    }
    const raw = localStorage.getItem("voltpanel.lockUntil");
    const lockNum = raw == null || raw === "" ? null : Number(raw);
    localStorage.removeItem("voltpanel.electric");
    return {
      mode,
      boost: localStorage.getItem("voltpanel.boost") === "1",
      phase: mode === "engine" ? "engine" : "battery",
      soc: null,
      lockUntil: lockNum != null && Number.isFinite(lockNum) ? lockNum : null,
      previousPlan: mode === "electric" ? "force-off" : "none",
    };
  } catch {
    return blank;
  }
}

function persistDrive() {
  if (shotMode) return;
  try {
    localStorage.setItem("voltpanel.mode", drive.mode);
    localStorage.setItem("voltpanel.boost", drive.boost ? "1" : "0");
    if (drive.lockUntil == null) localStorage.removeItem("voltpanel.lockUntil");
    else localStorage.setItem("voltpanel.lockUntil", String(drive.lockUntil));
    localStorage.removeItem("voltpanel.electric");
  } catch {
    /* private mode */
  }
}

function linked() {
  return !shotMode && !!(writeChar && promptSeen);
}

function considerHold(forceNow) {
  if (drive.previousPlan !== "force-off" || !linked()) return;
  const now = Date.now();
  if (!forceNow && now - lastHold < 2000) return;
  if (queue.some((job) => job.tag === "hold")) return;
  lastHold = now;
  asserted = true;
  for (const cmd of holdCommands().commands) enqueue(cmd, cmd.startsWith("ATSH") ? "hdr" : "hold");
}

function applyDrive(event) {
  const before = drive.previousPlan;
  const wasAsserted = asserted;
  drive.soc = state.soc;
  const result = stepDrive(drive, event);
  drive = result.state;
  persistDrive();
  if (linked() && result.plan === "force-off") {
    considerHold(before !== "force-off");
  } else if (result.plan === "release") {
    asserted = false;
    if (linked() && (before === "force-off" || wasAsserted)) {
      for (const cmd of releaseCommands()) enqueue(cmd, cmd.startsWith("ATSH") ? "hdr" : "release");
    }
  }
  paintModes();
}

function press(type) {
  drive.soc = state.soc;
  if (type === "electric" && electricBlocked(drive)) return;
  applyDrive({ type });
  paintLive();
}

function bluetoothMissing() {
  return typeof navigator === "undefined" || !navigator.bluetooth;
}

function paintAdapter() {
  if (bluetoothMissing()) {
    setText(adapterEl, "No Bluetooth");
    connectBtn.hidden = true;
    return;
  }
  connectBtn.hidden = false;
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
  setText(connectBtn, (connected || reconnecting) ? "Disconnect" : "Connect");
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

function onLinkDrop(next) {
  if (device !== next) return;
  linkGen += 1;
  clearInterval(pollTimer);
  clearQueue();
  probing = false;
  if (notifyChar) notifyChar.removeEventListener("characteristicvaluechanged", onNotify);
  writeChar = null;
  notifyChar = null;
  asserted = false;
  promptSeen = false;
  noReply = false;
  buffer = "";
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
  try {
    text = await transact(job.cmd, job.timeout);
  } catch {
    text = "";
  }
  onReply(job, text);
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

function transact(cmd, timeout) {
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
    const timer = setTimeout(() => finish("", new Error("timeout")), timeout);
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
  buffer = "";
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
  if (!buffer.includes(">")) return;
  const text = buffer;
  buffer = "";
  const waiter = waiters.shift();
  if (waiter) waiter(text);
}

function onReply(job, text) {
  if (job.cmd === "ATZ") header = "";
  if (job.tag === "hold" && holdRefused(text)) {
    queue = onHoldRefused(queue, false).queue;
    asserted = false;
    applyDrive({ type: "refuse" });
    paintLive();
    return;
  }
  const parsed = parseReply(text);
  if (parsed.rpm != null) state.rpm = parsed.rpm;
  if (parsed.speedKmh != null) state.speedKmh = parsed.speedKmh;
  if (parsed.fuelLph != null) {
    state.fuelLph = parsed.fuelLph;
    state.fuelKnown = true;
  } else if (job.tag === "fuel" && replySilent(text)) {
    state.fuelLph = null;
    state.fuelKnown = false;
  }
  if (parsed.mafGs != null) {
    state.mafGs = parsed.mafGs;
    state.mafKnown = true;
  } else if (job.tag === "maf" && replySilent(text)) {
    state.mafGs = null;
    state.mafKnown = false;
  }
  if (parsed.voltage != null) state.voltage = parsed.voltage;
  if (parsed.current != null) state.current = parsed.current;
  if (state.voltage != null && state.current != null) state.kw = kilowatts(state.voltage, state.current);
  if (parsed.rpm != null || parsed.voltage != null || parsed.speedKmh != null) state.live = true;
  if (parsed.soc != null) {
    state.soc = parsed.soc;
    applyDrive({ type: "soc", soc: parsed.soc });
  } else if (drive.previousPlan === "force-off") {
    considerHold(false);
  }
  paintLive();
}

function startPoll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!writeChar || queue.length > 4) return;
    const [head, cmd, tag] = poll[pollIndex % poll.length];
    pollIndex += 1;
    enqueuePid(head, cmd, tag);
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
  if (drive.previousPlan === "force-off") considerHold(true);
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
  promptSeen = false;
  noReply = false;
  buffer = "";
  dropWaiters();
  releaseWake();
  paintAdapter();
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

function boot() {
  drive = loadDrive();
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
  connectBtn.addEventListener("click", () => {
    if ((device && device.gatt && device.gatt.connected) || reconnecting) disconnect();
    else {
      userGone = false;
      statusError = "";
      retryCount = 0;
      holdWake();
      connectPicker().then(() => {
        if (userGone || reconnecting) return;
        closeSettings();
        paintAdapter();
      }).catch((err) => noteConnectError(err));
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !sessionUp()) return;
    holdWake();
  });
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
  document.addEventListener("pointerdown", () => {
    if (sessionUp()) holdWake();
    if (!writeChar && !reconnecting && localStorage.getItem("voltpanel.device")) {
      userGone = false;
      holdWake();
      reconnectSaved().catch((err) => noteConnectError(err));
    }
  }, { once: true });
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
