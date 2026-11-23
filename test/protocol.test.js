import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BLE_SERVICES,
  FORCE_OFF,
  FORCE_ON,
  RELEASE,
  TESTER,
  dataByteCount,
  decodeCurrent,
  decodeFuelLph,
  decodeMaf,
  decodeRpm,
  decodeSoc,
  decodeVoltage,
  economy,
  engineKnown,
  holdGate,
  noteVoltFuel,
  promptAfterTimeout,
  takePrompt,
  attachRelease,
  forceOnCommands,
  holdCommands,
  holdRefused,
  kilowatts,
  onHoldRefused,
  parseReply,
  replySilent,
  holdFloor,
  electricBlocked,
  quietPlan,
  releaseCommands,
  restorePhase,
  stepDrive,
  clearedTrip,
  decodeDtcBytes,
  parseDtcResponse,
  tripRecord,
  tripStep,
  emptyFloor,
  floorAssist,
  floorBus,
  floorCommandsEngine,
  floorFace,
  decodePedal,
  linkCommand,
  unusedPack,
} from "../js/protocol.js";

function drive(partial) {
  return {
    mode: "off",
    boost: false,
    phase: "battery",
    soc: null,
    lockUntil: null,
    previousPlan: "none",
    ...partial,
  };
}

test("voltage current and kilowatts stay signed", () => {
  assert.equal(decodeVoltage(0x5a, 0x00), 360);
  assert.equal(decodeCurrent(0x01, 0x90), 20);
  assert.equal(kilowatts(360, 20), 7.2);
  assert.equal(decodeCurrent(0xff, 0x38), -10);
  assert.ok(Math.abs(kilowatts(360, decodeCurrent(0xff, 0x38)) + 3.6) < 1e-9);
  assert.ok(kilowatts(360, -20) < 0);
});

test("rpm fuel maf and soc", () => {
  assert.equal(decodeRpm(0x17, 0x70), 1500);
  assert.equal(decodeFuelLph(0x00, 0x14), 1);
  assert.equal(decodeMaf(0x03, 0xe8), 10);
  assert.ok(Math.abs(decodeSoc(41) - 16.078) < 0.01);
});

test("boost off, soc 45.9, press Electric, mode stays off", () => {
  assert.equal(holdFloor(false), 45);
  assert.equal(electricBlocked({ soc: 45.9, boost: false }), true);
  const pressed = stepDrive(drive({ soc: 45.9 }), { type: "electric" });
  assert.equal(pressed.state.mode, "off");
  assert.equal(pressed.plan, "none");
});

test("boost off, soc 46, press Electric, mode electric, plan force-off", () => {
  const pressed = stepDrive(drive({ soc: 46 }), { type: "electric" });
  assert.equal(pressed.state.mode, "electric");
  assert.equal(pressed.state.phase, "battery");
  assert.equal(pressed.plan, "force-off");
  assert.equal(electricBlocked(pressed.state), false);
});

test("boost off, Electric hold at 45.1 stays electric and force-off, lockUntil is null", () => {
  const held = stepDrive(drive({ mode: "electric", phase: "battery", soc: 60, previousPlan: "force-off" }), { type: "soc", soc: 45.1 });
  assert.equal(held.state.mode, "electric");
  assert.equal(held.state.phase, "battery");
  assert.equal(held.plan, "force-off");
  assert.equal(held.state.lockUntil, null);
  const again = stepDrive(held.state, { type: "electric" });
  assert.equal(again.state.mode, "electric");
  assert.equal(again.plan, "force-off");
  assert.equal(again.state.lockUntil, null);
});

test("boost off, Electric hold polled at 45 turns the engine on, and 46 turns it off", () => {
  const started = stepDrive(drive({ mode: "electric", phase: "battery", soc: 60, previousPlan: "force-off" }), { type: "soc", soc: 45 });
  assert.equal(started.state.mode, "engine");
  assert.equal(started.state.phase, "engine");
  assert.equal(started.state.lockUntil, null);
  assert.equal(started.plan, "force-on");
  const held = stepDrive(started.state, { type: "soc", soc: 45.5 });
  assert.equal(held.plan, "force-on");
  const stopped = stepDrive(held.state, { type: "soc", soc: 46 });
  assert.equal(stopped.state.mode, "engine");
  assert.equal(stopped.plan, "force-on");
  const again = stepDrive(started.state, { type: "electric" });
  assert.equal(again.state.mode, "engine");
  assert.equal(again.plan, "none");
  const lower = stepDrive(drive({ mode: "electric", phase: "battery", soc: 60, previousPlan: "force-off" }), { type: "soc", soc: 44.5 });
  assert.equal(lower.state.mode, "engine");
  assert.equal(lower.state.phase, "engine");
  assert.equal(lower.state.lockUntil, null);
  assert.equal(lower.plan, "force-on");
  const pressed = stepDrive(drive({ mode: "electric", phase: "battery", soc: 45, previousPlan: "force-off" }), { type: "engine" });
  assert.equal(pressed.plan, "force-on");
  const low = stepDrive(drive({ mode: "engine", phase: "engine", soc: 40, previousPlan: "none" }), { type: "soc", soc: 40 });
  assert.equal(low.plan, "force-on");
});

test("a stale lockUntil of 47 does not block a press at soc 46", () => {
  const pressed = stepDrive(drive({ soc: 46, lockUntil: 47 }), { type: "electric" });
  assert.equal(pressed.state.mode, "electric");
  assert.equal(pressed.plan, "force-off");
  assert.equal(stepDrive(drive({ soc: 30, lockUntil: 30 }), { type: "electric" }).state.mode, "off");
  assert.equal(stepDrive(drive({ soc: 46.9, lockUntil: 47 }), { type: "electric" }).state.mode, "electric");
});

test("no charge reading keeps Electric pressable", () => {
  assert.equal(electricBlocked({ soc: null }), false);
  assert.equal(electricBlocked({}), false);
  const pressed = stepDrive(drive({ soc: null }), { type: "electric" });
  assert.equal(pressed.state.mode, "electric");
  assert.equal(pressed.plan, "force-off");
  const row = drive();
  delete row.soc;
  assert.equal(stepDrive(row, { type: "electric" }).state.mode, "electric");
});

test("boost on, soc 22, press Electric, mode electric", () => {
  assert.equal(holdFloor(true), 22);
  assert.equal(electricBlocked({ soc: 22, boost: true }), false);
  const pressed = stepDrive(drive({ soc: 22, boost: true }), { type: "electric" });
  assert.equal(pressed.state.mode, "electric");
  assert.equal(pressed.plan, "force-off");
  assert.equal(stepDrive(drive({ soc: 45, boost: true }), { type: "electric" }).state.mode, "electric");
  assert.equal(stepDrive(drive({ soc: 22.1, boost: true, lockUntil: 23.5 }), { type: "electric" }).state.mode, "electric");
});

test("boost on, soc 21.9, press Electric, mode stays off", () => {
  assert.equal(electricBlocked({ soc: 21.9, boost: true }), true);
  const pressed = stepDrive(drive({ soc: 21.9, boost: true }), { type: "electric" });
  assert.equal(pressed.state.mode, "off");
  assert.equal(pressed.plan, "none");
});

test("boost on, Electric at 21.9 ends Boost and soc 46 returns to battery force-off", () => {
  const dropped = stepDrive(drive({ mode: "electric", boost: true, phase: "battery", soc: 40, previousPlan: "force-off" }), { type: "soc", soc: 21.9 });
  assert.equal(dropped.state.boost, false);
  assert.equal(dropped.state.mode, "cycle");
  assert.equal(dropped.state.phase, "engine");
  assert.equal(dropped.plan, "force-on");
  assert.equal(dropped.state.lockUntil, null);
  const back = stepDrive(dropped.state, { type: "soc", soc: 46 });
  assert.equal(back.state.mode, "cycle");
  assert.equal(back.state.phase, "battery");
  assert.equal(back.plan, "force-off");
  const held = stepDrive(drive({ mode: "electric", boost: true, soc: 40, previousPlan: "force-off" }), { type: "soc", soc: 22 });
  assert.equal(held.state.mode, "electric");
  assert.equal(held.state.boost, true);
  assert.equal(held.plan, "force-off");
  assert.equal(held.state.lockUntil, null);
});

test("electric at 21.5 with boost on turns boost off and charges toward 46", () => {
  const result = stepDrive(drive({ mode: "electric", boost: true, soc: 60, previousPlan: "force-off" }), { type: "soc", soc: 21.5 });
  assert.equal(result.state.boost, false);
  assert.equal(result.state.mode, "cycle");
  assert.equal(result.state.phase, "engine");
  assert.equal(result.state.lockUntil, null);
  assert.equal(result.plan, "force-on");
  const charging = stepDrive(result.state, { type: "soc", soc: 30 });
  assert.equal(charging.state.phase, "engine");
  assert.equal(charging.state.mode, "cycle");
  assert.equal(charging.plan, "force-on");
  const back = stepDrive(charging.state, { type: "soc", soc: 46 });
  assert.equal(back.state.phase, "battery");
  assert.equal(back.plan, "force-off");
});

test("boost on, soc 30, a stale lockUntil does not block Electric", () => {
  const armed = stepDrive(drive({ mode: "engine", soc: 30, lockUntil: 47 }), { type: "boost" });
  assert.equal(armed.state.mode, "electric");
  assert.equal(armed.state.phase, "battery");
  assert.equal(armed.state.boost, true);
  assert.equal(armed.plan, "force-off");
  assert.equal(electricBlocked(armed.state), false);
  const pressed = stepDrive(drive({ soc: 30, lockUntil: 47, boost: true }), { type: "electric" });
  assert.equal(pressed.state.mode, "electric");
  assert.equal(pressed.plan, "force-off");
  const polled = stepDrive(pressed.state, { type: "soc", soc: 30 });
  assert.equal(polled.state.mode, "electric");
  assert.equal(polled.plan, "force-off");
  assert.equal(polled.state.lockUntil, 47);
});

test("engine mode does not shut off for charge power", () => {
  let result = stepDrive(drive({ mode: "engine", phase: "engine", soc: 50, previousPlan: "none" }), { type: "soc", soc: 50, kw: -50, now: 0 });
  assert.equal(result.state.mode, "engine");
  assert.equal(result.state.phase, "engine");
  assert.notEqual(result.plan, "force-off");
  result = stepDrive(result.state, { type: "soc", soc: 50, kw: -50, now: 60000 });
  assert.notEqual(result.plan, "force-off");
  assert.equal(result.state.regenOffUntil, undefined);
});

test("manual engine does not set a lock, and the two modes clear each other", () => {
  const manual = stepDrive(drive({ soc: 50 }), { type: "engine" });
  assert.equal(manual.state.mode, "engine");
  assert.equal(manual.state.phase, "engine");
  assert.equal(manual.state.lockUntil, null);
  const cleared = stepDrive(drive({ mode: "electric", phase: "battery", soc: 50, previousPlan: "force-off" }), { type: "engine" });
  assert.equal(cleared.state.mode, "engine");
  assert.equal(cleared.plan, "force-on");
  const back = stepDrive(drive({ mode: "engine", phase: "engine", soc: 50 }), { type: "electric" });
  assert.equal(back.state.mode, "electric");
  assert.equal(back.state.phase, "battery");
  assert.equal(back.plan, "force-off");
});

test("cycle holds on the battery, releases at 45, and returns at 46", () => {
  let result = stepDrive(drive({ soc: 60 }), { type: "cycle" });
  assert.equal(result.state.mode, "cycle");
  assert.equal(result.state.phase, "battery");
  assert.equal(result.plan, "force-off");
  result = stepDrive(result.state, { type: "soc", soc: 45.1 });
  assert.equal(result.state.mode, "cycle");
  assert.equal(result.state.phase, "battery");
  assert.equal(result.plan, "force-off");
  result = stepDrive(result.state, { type: "soc", soc: 45 });
  assert.equal(result.state.mode, "cycle");
  assert.equal(result.state.phase, "engine");
  assert.equal(result.state.lockUntil, null);
  assert.equal(result.plan, "force-on");
  result = stepDrive(result.state, { type: "soc", soc: 45.5 });
  assert.equal(result.state.phase, "engine");
  assert.equal(result.state.mode, "cycle");
  assert.equal(result.plan, "force-on");
  result = stepDrive(result.state, { type: "soc", soc: 46 });
  assert.equal(result.state.phase, "battery");
  assert.equal(result.plan, "force-off");
  assert.equal(result.state.lockUntil, null);
  result = stepDrive(result.state, { type: "soc", soc: 45.5 });
  assert.equal(result.state.phase, "battery");
  assert.equal(result.plan, "force-off");
});

test("cycle with boost on turns boost off at 22 and returns at 46", () => {
  let result = stepDrive(drive({ soc: 60, boost: true }), { type: "cycle" });
  result = stepDrive(result.state, { type: "soc", soc: 22.1 });
  assert.equal(result.state.boost, true);
  assert.equal(result.state.phase, "battery");
  assert.equal(result.plan, "force-off");
  result = stepDrive(result.state, { type: "soc", soc: 22 });
  assert.equal(result.state.boost, false);
  assert.equal(result.state.phase, "engine");
  assert.equal(result.state.mode, "cycle");
  assert.equal(result.state.lockUntil, null);
  assert.equal(result.plan, "force-on");
  result = stepDrive(result.state, { type: "soc", soc: 23 });
  assert.equal(result.state.phase, "engine");
  assert.equal(result.plan, "force-on");
  result = stepDrive(result.state, { type: "soc", soc: 46 });
  assert.equal(result.state.phase, "battery");
  assert.equal(result.plan, "force-off");
});

test("boost on while engine is showing selects electric", () => {
  const fromEngine = stepDrive(drive({ mode: "engine", phase: "engine", soc: 30 }), { type: "boost" });
  assert.equal(fromEngine.state.mode, "electric");
  assert.equal(fromEngine.state.boost, true);
  assert.equal(fromEngine.plan, "force-off");
  const fromCycle = stepDrive(drive({ mode: "cycle", phase: "engine", soc: 40, previousPlan: "none" }), { type: "boost" });
  assert.equal(fromCycle.state.mode, "electric");
  assert.equal(fromCycle.state.phase, "battery");
  assert.equal(fromCycle.state.boost, true);
  assert.equal(fromCycle.plan, "force-off");
  const batteryPhase = stepDrive(drive({ mode: "cycle", phase: "battery", soc: 50, boost: false, previousPlan: "force-off" }), { type: "boost" });
  assert.equal(batteryPhase.state.mode, "cycle");
  assert.equal(batteryPhase.state.phase, "battery");
  assert.equal(batteryPhase.state.boost, true);
  assert.equal(batteryPhase.plan, "none");
  const at21 = stepDrive(drive({ mode: "engine", phase: "engine", soc: 21 }), { type: "boost" });
  assert.equal(at21.state.boost, true);
  assert.equal(at21.state.mode, "engine");
  assert.equal(at21.state.phase, "engine");
  assert.notEqual(at21.plan, "force-off");
  const unread = stepDrive(drive({ mode: "engine", phase: "engine", soc: null }), { type: "boost" });
  assert.equal(unread.state.mode, "electric");
  assert.equal(unread.state.boost, true);
  assert.equal(unread.plan, "force-off");
});

test("boost pressed at 22 while the engine is showing selects Electric and the hold continues", () => {
  const pressed = stepDrive(drive({ mode: "cycle", phase: "engine", soc: 22, boost: false, previousPlan: "none" }), { type: "boost" });
  assert.equal(pressed.state.boost, true);
  assert.equal(pressed.state.mode, "electric");
  assert.equal(pressed.plan, "force-off");
  const again = stepDrive(pressed.state, { type: "soc", soc: 22 });
  assert.equal(again.state.boost, true);
  assert.equal(again.state.mode, "electric");
  assert.equal(again.state.phase, "battery");
  assert.equal(again.plan, "force-off");
  assert.equal(again.state.lockUntil, null);
});

test("restorePhase keeps a cycle charge in the engine phase", () => {
  assert.equal(restorePhase("cycle", "engine"), "engine");
  assert.equal(restorePhase("cycle", "battery"), "battery");
  assert.equal(restorePhase("engine", "battery"), "engine");
  assert.equal(restorePhase("electric", "engine"), "battery");
});

test("cycle at 45.5 starts on the battery and stays there until 45", () => {
  let result = stepDrive(drive({ soc: 45.5, lockUntil: 47 }), { type: "cycle" });
  assert.equal(result.state.mode, "cycle");
  assert.equal(result.state.phase, "battery");
  assert.equal(result.plan, "force-off");
  assert.equal(result.state.lockUntil, 47);
  result = stepDrive(result.state, { type: "soc", soc: 45.5 });
  assert.equal(result.state.phase, "battery");
  assert.equal(result.plan, "force-off");
  result = stepDrive(result.state, { type: "soc", soc: 45 });
  assert.equal(result.state.phase, "engine");
  assert.equal(result.plan, "force-on");
  assert.equal(result.state.lockUntil, 47);
});

test("a stale lock does not block the cycle return at 46 or bounce it off", () => {
  let result = stepDrive(drive({
    mode: "cycle",
    phase: "engine",
    soc: 45.5,
    lockUntil: 47,
    previousPlan: "none",
  }), { type: "soc", soc: 46 });
  assert.equal(result.state.mode, "cycle");
  assert.equal(result.state.phase, "battery");
  assert.equal(result.plan, "force-off");
  assert.equal(result.state.lockUntil, 47);
  result = stepDrive(result.state, { type: "soc", soc: 46 });
  assert.equal(result.state.mode, "cycle");
  assert.equal(result.state.phase, "battery");
  assert.equal(result.plan, "force-off");
  assert.equal(result.state.lockUntil, 47);
  const boost = stepDrive(drive({
    mode: "cycle",
    phase: "engine",
    boost: true,
    soc: 22.5,
    lockUntil: 47,
    previousPlan: "none",
  }), { type: "soc", soc: 23 });
  assert.equal(boost.state.mode, "electric");
  assert.equal(boost.state.boost, true);
  assert.equal(boost.state.phase, "battery");
  assert.equal(boost.plan, "force-off");
  assert.equal(boost.state.lockUntil, 47);
});

test("cycle with an empty charge reading holds the battery and leaves the engine phase alone", () => {
  const pressed = stepDrive(drive({ soc: null }), { type: "cycle" });
  assert.equal(pressed.state.mode, "cycle");
  assert.equal(pressed.state.phase, "battery");
  assert.equal(pressed.state.soc, null);
  assert.equal(pressed.plan, "force-off");

  const held = stepDrive(pressed.state, { type: "soc", soc: null });
  assert.equal(held.state.mode, "cycle");
  assert.equal(held.state.phase, "battery");
  assert.equal(held.state.soc, null);
  assert.equal(held.state.previousPlan, "force-off");
  assert.equal(held.plan, "force-off");

  const engine = stepDrive(drive({
    mode: "cycle",
    phase: "engine",
    soc: null,
    previousPlan: "none",
  }), { type: "soc", soc: null });
  assert.equal(engine.state.mode, "cycle");
  assert.equal(engine.state.phase, "engine");
  assert.equal(engine.state.soc, null);
  assert.notEqual(engine.plan, "force-off");

  const row = drive();
  delete row.soc;
  const omitted = stepDrive(row, { type: "cycle" });
  assert.equal(omitted.state.phase, "battery");
  assert.equal(omitted.state.soc, null);
  assert.equal(omitted.plan, "force-off");
  const omittedPoll = stepDrive(omitted.state, { type: "soc" });
  assert.equal(omittedPoll.state.phase, "battery");
  assert.equal(omittedPoll.state.soc, null);
  assert.equal(omittedPoll.plan, "force-off");
  const running = drive({ mode: "cycle", phase: "engine", previousPlan: "none" });
  delete running.soc;
  const omittedEngine = stepDrive(running, { type: "soc" });
  assert.equal(omittedEngine.state.mode, "cycle");
  assert.equal(omittedEngine.state.phase, "engine");
  assert.equal(omittedEngine.state.soc, null);
  assert.notEqual(omittedEngine.plan, "force-off");
});

test("leaving cycle keeps the phase it was in", () => {
  const battery = stepDrive(drive({ mode: "cycle", phase: "battery", soc: 40, previousPlan: "force-off" }), { type: "cycle" });
  assert.equal(battery.state.mode, "electric");
  assert.equal(battery.state.phase, "battery");
  assert.equal(battery.plan, "force-off");
  const running = stepDrive(drive({ mode: "cycle", phase: "engine", soc: 28, previousPlan: "none" }), { type: "cycle" });
  assert.equal(running.state.mode, "engine");
  assert.equal(running.state.phase, "engine");
  assert.notEqual(running.plan, "force-off");
});

test("cycle under the floor does not release unless a hold was on", () => {
  const locked = stepDrive(drive({ mode: "off", soc: 25, lockUntil: 26, previousPlan: "none" }), { type: "cycle" });
  assert.equal(locked.state.mode, "cycle");
  assert.equal(locked.state.phase, "engine");
  assert.equal(locked.plan, "force-on");
  const fromEngine = stepDrive(drive({ mode: "engine", soc: 20, previousPlan: "none" }), { type: "cycle" });
  assert.equal(fromEngine.plan, "force-on");
  const held = stepDrive(drive({ mode: "electric", phase: "battery", soc: 20, previousPlan: "force-off" }), { type: "cycle" });
  assert.equal(held.state.mode, "cycle");
  assert.equal(held.state.phase, "engine");
  assert.equal(held.plan, "force-on");
});

test("cycle during the lock does not enter the battery phase", () => {
  const pressed = stepDrive(drive({ soc: 25, lockUntil: 26 }), { type: "cycle" });
  assert.equal(pressed.state.mode, "cycle");
  assert.equal(pressed.state.phase, "engine");
  const held = stepDrive(drive({ mode: "cycle", phase: "engine", soc: 25, lockUntil: 26 }), { type: "soc", soc: 25 });
  assert.equal(held.state.phase, "engine");
  assert.notEqual(held.plan, "force-off");
});

test("engine frames are the two published payloads", () => {
  assert.equal(dataByteCount(TESTER), 1);
  assert.equal(dataByteCount(FORCE_OFF), 7);
  assert.equal(dataByteCount(FORCE_ON), 7);
  assert.equal(dataByteCount(RELEASE), 7);
  assert.deepEqual(holdCommands().commands, ["ATSH 7E1", "3E", FORCE_OFF]);
  assert.deepEqual(forceOnCommands().commands, ["ATSH 7E1", "3E", FORCE_ON]);
  assert.deepEqual(releaseCommands(), ["ATSH 7E1", RELEASE]);
  const src = readFileSync(new URL("../js/protocol.js", import.meta.url), "utf8");
  const payloads = src.match(/AE[ 0-9A-F]+/g);
  assert.deepEqual(payloads, ["AE 31 05 00 00 00 00", "AE 31 06 00 00 00 00", "AE 00 00 00 00 00 00"]);
  assert.equal(holdFloor(true), 22);
  assert.equal(holdFloor(false), 45);
  assert.equal(src.includes("? 22 : 45"), true);
  assert.equal(src.includes("? 16 : 22"), false);
  assert.equal(src.includes("soc >= 55"), false);
  assert.equal(src.includes("floor + 1"), true);
  assert.equal(src.includes("soc + 2"), false);
  assert.equal(src.includes("engineKnown"), true);
  const app = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
  assert.equal(app.includes('setItem("voltpanel.lockUntil"'), false);
  assert.equal(app.includes('removeItem("voltpanel.lockUntil")'), true);
  assert.equal(app.includes("protocol.js?v=32"), true);
  assert.equal(app.includes('enact("force-on", true)'), true);
  assert.equal(app.includes('if (!fromFloor) drive.previousPlan = "force-on"'), true);
  assert.equal(app.includes("01 49"), true);
  assert.equal(app.includes("floorBus"), true);
  assert.equal(src.includes("floorBus"), true);
  assert.equal(app.includes("considerOn"), true);
  assert.equal(app.includes('if (plan === "force-on") return'), false);
  assert.equal(app.includes("holdGate"), true);
  assert.equal(app.includes("engineKnown"), false);
  const refused = app.slice(app.indexOf('job.tag === "hold" && !timedOut'), app.indexOf('job.tag === "on"'));
  assert.equal(refused.includes("asserted = false"), false);
  assert.equal(refused.includes('busKind = "none"'), false);
  assert.equal(refused.includes("onHoldRefused(queue, false)"), true);
  assert.equal(src.includes("enginePlan"), false);
  assert.equal(src.includes("regen"), false);
  assert.equal(/\b2200\b/.test(src), false);
  assert.equal(/\b1400\b/.test(src), false);
  assert.equal(/setpoint/i.test(src), false);
});

test("engine mode in the 45% band sends the engine-on command and quietPlan does not", () => {
  assert.equal(quietPlan({ mode: "off" }), "none");
  assert.equal(quietPlan({ mode: "off", soc: null, rpm: 0, kw: 0, boost: false }), "none");

  const running = { mode: "engine", phase: "engine", soc: 50, boost: false, lockUntil: null, now: 1000 };
  assert.equal(quietPlan({ ...running, rpm: 4000 }), "none");
  assert.equal(quietPlan({ ...running, soc: 50, rpm: 4000, kw: 18 }), "none");
  assert.equal(quietPlan({ ...running, rpm: 2400, kw: 18 }), "none");
  assert.equal(quietPlan({ ...running, rpm: 0, kw: 40 }), "none");
  assert.equal(quietPlan({ ...running, rpm: 0, kw: -40 }), "none");
  assert.equal(quietPlan({ ...running, rpm: 2400, kw: -50 }), "none");
  assert.equal(quietPlan({ ...running, forceOnOk: false, rpm: 2400 }), "none");
  assert.equal(quietPlan({ ...running, forceOnOk: false, rpm: 4000 }), "none");
  assert.equal(quietPlan({ ...running, soc: 20, rpm: 4000 }), "none");
  assert.equal(quietPlan({ ...running, boost: true, soc: 18, rpm: 4000 }), "none");
  assert.equal(quietPlan({ ...running, boost: true, soc: 50, rpm: 0, kw: -10 }), "none");
  assert.equal(quietPlan({ ...running, soc: 25, lockUntil: 27, rpm: 4000 }), "none");
  assert.equal(quietPlan({ mode: "cycle", phase: "engine", soc: 28, rpm: 4000 }), "none");
  assert.equal(quietPlan({ mode: "cycle", phase: "engine", rpm: 1400 }), "none");
  assert.equal(quietPlan({ mode: "cycle", phase: "battery", rpm: 4000 }), "none");
  assert.equal(quietPlan({ mode: "electric", rpm: 0 }), "none");
  assert.equal(quietPlan({ ...running, soc: null, rpm: 4000 }), "none");

  let cycle = stepDrive(drive({ soc: 60 }), { type: "cycle" });
  cycle = stepDrive(cycle.state, { type: "soc", soc: 45 });
  assert.equal(cycle.state.phase, "engine");
  assert.equal(cycle.plan, "force-on");
  assert.equal(quietPlan({ ...cycle.state, soc: 45, rpm: 4000, kw: -40 }), "none");
  cycle = stepDrive(cycle.state, { type: "soc", soc: 45.5 });
  assert.equal(cycle.state.phase, "engine");
  assert.equal(cycle.state.mode, "cycle");
  assert.equal(quietPlan({ ...cycle.state, soc: 45.5, rpm: 2400, kw: 10 }), "none");
  cycle = stepDrive(cycle.state, { type: "soc", soc: 46 });
  assert.equal(cycle.state.phase, "battery");
  assert.equal(cycle.plan, "force-off");
  assert.equal(quietPlan({ ...cycle.state, soc: 46, rpm: 0 }), "none");

  const stopped = onHoldRefused([
    { cmd: "3E", tag: "hold" },
    { cmd: FORCE_OFF, tag: "hold" },
    { cmd: "01 0C", tag: "rpm" },
  ], true);
  assert.deepEqual(stopped.commands, ["ATSH 7E1", RELEASE]);
  assert.equal(stopped.commands.includes(FORCE_ON), false);
  assert.equal(quietPlan({ mode: "engine", phase: "engine", forceOnOk: false, rpm: 4000, soc: 50 }), "none");
  const refused = stepDrive(drive({ mode: "electric", phase: "battery", soc: 40, previousPlan: "force-off" }), { type: "refuse" });
  assert.equal(refused.state.mode, "electric");
  assert.equal(refused.plan, "force-on");
  assert.notEqual(refused.plan, "release");
  const quiet = stepDrive(drive({ mode: "off", previousPlan: "force-off" }), { type: "refuse" });
  assert.equal(quiet.state.mode, "off");
  assert.equal(quiet.plan, "release");
});

test("attach sends no module frame for any mode", () => {
  assert.deepEqual(attachRelease({ mode: "off" }), []);
  assert.deepEqual(attachRelease({ mode: "electric", phase: "battery", soc: 50 }), []);
  assert.deepEqual(attachRelease({ mode: "cycle", phase: "battery", soc: 32 }), []);
  assert.deepEqual(attachRelease({ mode: "engine", phase: "engine", soc: 50, rpm: 4000 }), []);
  assert.deepEqual(attachRelease({ mode: "engine", phase: "engine", soc: null, rpm: 0 }), []);
  assert.deepEqual(attachRelease({ mode: "cycle", phase: "engine", soc: 24, rpm: 4000 }), []);
  assert.deepEqual(attachRelease({ mode: "cycle", phase: "engine", soc: 31.9 }), []);
  assert.equal(attachRelease({ mode: "engine", soc: 50 }).includes(FORCE_ON), false);
  assert.equal(quietPlan({ mode: "engine", phase: "engine", soc: 50, rpm: 4000 }), "none");
  assert.equal(quietPlan({ mode: "cycle", phase: "engine", soc: 24, rpm: 2400 }), "none");
});

test("a negative reply clears the hold without a sentence", () => {
  assert.equal(holdRefused("7F AE 11"), true);
  assert.equal(holdRefused("02 6E 31"), false);
  assert.equal(holdRefused("NO DATA"), false);
  const queued = [
    { cmd: "3E", tag: "hold" },
    { cmd: "AE 31 05 00 00 00 00", tag: "hold" },
    { cmd: "01 0C", tag: "rpm" },
  ];
  const stopped = onHoldRefused(queued, true);
  assert.deepEqual(stopped.queue, [{ cmd: "01 0C", tag: "rpm" }]);
  assert.equal(stopped.asserted, false);
  assert.equal(stopped.electric, false);
  assert.equal(stopped.note, undefined);
  assert.deepEqual(stopped.commands, ["ATSH 7E1", RELEASE]);
  assert.deepEqual(onHoldRefused(queued, false).commands, []);
  const src = readFileSync(new URL("../js/protocol.js", import.meta.url), "utf8");
  assert.equal(src.includes('"Reserve"'), false);
  assert.equal(src.includes('"Refused"'), false);
});

test("pid decode and silent fuel", () => {
  const live = parseReply("41 0C 17 70\r41 0D 64\r41 5E 00 14\r41 10 03 E8\r41 5B 80\r62 24 29 5A 00\r62 24 14 01 90");
  assert.equal(live.rpm, 1500);
  assert.equal(live.speedKmh, 100);
  assert.equal(live.fuelLph, 1);
  assert.equal(live.mafGs, 10);
  assert.equal(live.voltage, 360);
  assert.equal(live.current, 20);
  assert.ok(live.soc > 50);
  assert.deepEqual(parseReply("NO DATA"), {});
  assert.deepEqual(parseReply("7F 01 5E 11"), {});
});

test("mpg stays MPG, zero when stopped, and finite from a fuel sample", () => {
  assert.deepEqual(economy({ speedKmh: 0, fuelKnown: true, fuelLph: 1 }), { label: "MPG", value: 0 });
  const moving = economy({ speedKmh: 100, fuelKnown: true, fuelLph: 1, mafKnown: true, mafGs: 20 });
  assert.equal(moving.label, "MPG");
  assert.equal(Number.isFinite(moving.value), true);
  assert.ok(moving.value > 0);
  assert.equal(JSON.stringify(moving).includes("MPGe"), false);
  const maf = economy({ speedKmh: 100, rpm: 1500, fuelKnown: false, mafKnown: true, mafGs: 5 });
  assert.equal(maf.label, "MPG");
  assert.equal(Number.isFinite(maf.value), true);
  assert.equal(economy({ speedKmh: 100, fuelKnown: true, fuelLph: 0 }).value, null);
  assert.equal(economy({ speedKmh: 100, rpm: 0, fuelKnown: false, mafKnown: false }).value, null);
  assert.equal(economy({ speedKmh: 100, fuelKnown: false, mafKnown: false }).value, null);
  assert.equal(economy({ speedKmh: 100, rpm: 400, fuelKnown: false, mafKnown: false }).value, null);
  assert.equal(economy({ speedKmh: 100, rpm: 1800, fuelKnown: false, mafKnown: false }).value, null);
  const rate = economy({ speedKmh: 100, fuelKnown: true, fuelLph: 1 });
  assert.ok(rate.value > 0);
  assert.ok(rate.value <= 250);
  assert.notEqual(rate.value, 40);
  const src = readFileSync(new URL("../js/protocol.js", import.meta.url), "utf8");
  assert.equal(src.includes("MPGe"), false);
});

test("moving with rpm 0 and no fuel answer is blank", () => {
  assert.equal(economy({ speedKmh: 100, rpm: 0, fuelKnown: false, mafKnown: false }).value, null);
  assert.equal(economy({ speedKmh: 16, rpm: 0 }).value, null);
  assert.equal(economy({ speedKmh: 100, rpm: 399, fuelLph: 0.04, fuelKnown: true }).value, null);
  const coast = economy({ speedKmh: 100, rpm: 800, fuelKnown: true, fuelLph: 0.01 });
  assert.equal(Number.isFinite(coast.value), true);
  assert.ok(coast.value > 0);
  assert.ok(coast.value <= 250);
  assert.equal(economy({ speedKmh: 100, rpm: 800, fuelKnown: true, fuelLph: 0 }).value, 250);
  const lowMaf = economy({ speedKmh: 100, rpm: 900, fuelKnown: false, mafKnown: true, mafGs: 0.1 });
  assert.equal(Number.isFinite(lowMaf.value), true);
  assert.ok(lowMaf.value <= 250);
  const electricFuel = economy({ speedKmh: 100, rpm: 0, fuelKnown: true, fuelLph: 1 });
  assert.equal(Number.isFinite(electricFuel.value), true);
  assert.ok(electricFuel.value > 0 && electricFuel.value <= 250);
  const kept = noteVoltFuel({ mafKnown: true, mafGs: 4, fuelKnown: true, fuelLph: 1, askFuel: true }, "NO DATA", false);
  assert.equal(kept.askFuel, false);
  assert.equal(kept.fuelKnown, false);
  assert.equal(kept.mafKnown, true);
  assert.equal(kept.mafGs, 4);
  const timed = noteVoltFuel({ mafKnown: true, mafGs: 4, askFuel: true }, "", true);
  assert.equal(timed.askFuel, false);
  assert.equal(timed.mafKnown, true);
});

test("rpm at least 400 with both sources refused is null", () => {
  assert.equal(economy({ speedKmh: 100, rpm: 400, fuelKnown: false, mafKnown: false }).value, null);
  assert.equal(economy({ speedKmh: 100, rpm: 900, fuelKnown: false, mafKnown: false, mafGs: null }).value, null);
  const airflow = economy({ speedKmh: 100, rpm: 900, fuelKnown: false, mafKnown: true, mafGs: 5 });
  assert.equal(Number.isFinite(airflow.value), true);
});

test("a timeout discards the next prompt", () => {
  assert.equal(promptAfterTimeout(true), true);
  const late = takePrompt(promptAfterTimeout(true), "NO DATA\r>");
  assert.equal(late.text, "");
  assert.equal(late.discardNext, false);
  const kept = takePrompt(false, "41 10 03 E8\r>");
  assert.equal(kept.text.includes("41 10"), true);
});

test("only the two published radio services", () => {
  assert.equal(BLE_SERVICES.length, 2);
  assert.ok(BLE_SERVICES.every((id) => !id.includes("ffe0") && !id.includes("6e400001")));
});

test("60 mph for 60s at rpm 0 adds 1.0 mile to trip and to electric miles", () => {
  const next = tripStep({ miles: 0, electricMiles: 0 }, { mph: 60, rpm: 0, dt: 60 });
  assert.equal(next.miles, 1);
  assert.equal(next.electricMiles, 1);
  const slow = tripStep({ miles: 2, electricMiles: 1 }, { mph: 0.99, rpm: 0, dt: 60 });
  assert.equal(slow.miles, 2);
  assert.equal(slow.electricMiles, 1);
});

test("60 mph for 60s at rpm 2000 adds 1.0 trip mile and 0 electric miles", () => {
  const next = tripStep({ miles: 0, electricMiles: 0 }, { mph: 60, rpm: 2000, dt: 60 });
  assert.equal(next.miles, 1);
  assert.equal(next.electricMiles, 0);
  const edge = tripStep({ miles: 0, electricMiles: 0 }, { mph: 60, rpm: 399, dt: 60 });
  assert.equal(edge.miles, 1);
  assert.equal(edge.electricMiles, 1);
  const running = tripStep({ miles: 0, electricMiles: 0 }, { mph: 60, rpm: 400, dt: 60 });
  assert.equal(running.miles, 1);
  assert.equal(running.electricMiles, 0);
});

test("rpm null adds trip miles and does not add electric miles", () => {
  const next = tripStep({ miles: 0, electricMiles: 0 }, { mph: 60, rpm: null, dt: 60 });
  assert.equal(next.miles, 1);
  assert.equal(next.electricMiles, 0);
});

test("a 61s gap adds nothing", () => {
  const next = tripStep({ miles: 4, electricMiles: 2 }, { mph: 60, rpm: 0, dt: 61 });
  assert.equal(next.miles, 4);
  assert.equal(next.electricMiles, 2);
});

test("reset zeros both", () => {
  assert.deepEqual(clearedTrip(), { miles: 0, electricMiles: 0 });
  assert.deepEqual(tripRecord({ miles: 3.5, electricMiles: 1.25, rpm: 1800, speedKmh: 90 }), {
    miles: 3.5,
    electricMiles: 1.25,
  });
});

test("dtc bytes match the gauge decoder", () => {
  assert.equal(decodeDtcBytes(0x03, 0x01), "P0301");
  assert.deepEqual(parseDtcResponse("43 01 03 01"), ["P0301"]);
  assert.deepEqual(parseDtcResponse("43 00"), []);
  assert.equal(parseDtcResponse("NO DATA"), null);
});

test("engine known is spin, motion with a finite rpm, or an earlier proof", () => {
  assert.equal(engineKnown({}), false);
  assert.equal(engineKnown({ rpm: 0 }), false);
  assert.equal(engineKnown({ rpm: 0, speedKmh: 0 }), false);
  assert.equal(engineKnown({ rpm: 400 }), true);
  assert.equal(engineKnown({ rpm: 0, speedKmh: 1 }), true);
  assert.equal(engineKnown({ proved: true }), true);
  assert.equal(holdCommands().commands.includes(FORCE_ON), false);
});

test("hold gate is stopped, a start, or two running samples", () => {
  assert.equal(holdGate(null, undefined), "wait");
  assert.equal(holdGate(null, null), "wait");
  assert.equal(holdGate(0, NaN), "wait");
  assert.equal(holdGate(null, 0), "hold");
  assert.equal(holdGate(0, 0), "hold");
  assert.equal(holdGate(0, 200), "release");
  assert.equal(holdGate(200, 399), "release");
  assert.equal(holdGate(0, 400), "wait");
  assert.equal(holdGate(400, 800), "hold");
  assert.equal(holdGate(800, 800), "hold");
  assert.equal(holdGate(null, 400), "wait");
  assert.equal(engineKnown({ rpm: 200, speedKmh: 10 }), true);
  assert.equal(holdGate(0, 200), "release");
  const app = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
  const hold = app.slice(app.indexOf("function considerHold"), app.indexOf("function enact"));
  assert.equal(hold.includes("holdGate(previousRpm, proofRpm)"), true);
  assert.equal(hold.includes("engineKnown"), false);
  assert.equal(hold.includes("speed"), false);
  assert.equal(hold.includes('enact("release")'), false);
  assert.equal(hold.includes("considerOn"), true);
  assert.equal(app.includes("previousRpm = proofRpm"), true);
  const cleared = app.slice(app.indexOf("function clearProof"), app.indexOf("function onLinkDrop"));
  assert.equal(cleared.includes("previousRpm = null"), true);
  assert.equal(cleared.includes("proofRpm = null"), true);
});

function floorDown(state, pedal) {
  return floorAssist(state, { type: "pedal", pedalPct: pedal, now: 0 }).state;
}

test("pedal byte 243 is floored and 242 is not", () => {
  assert.ok(decodePedal(243) >= 95);
  assert.ok(decodePedal(242) < 95);
  assert.equal(parseReply("41 49 F3").pedalPct, decodePedal(0xf3));
  assert.equal(parseReply("41 49 00").pedalPct, 0);
  assert.equal(replySilent("41 49 F3"), false);
  assert.equal(replySilent("7F 01 49 11"), true);
});

test("empty floor and one speed sample do not start the engine", () => {
  assert.equal(floorAssist(emptyFloor(), { type: "tick", now: 0 }).plan, "none");
  const down = floorDown(emptyFloor(), 100);
  const once = floorAssist(down, { type: "speed", speedKmh: 40, now: 1000 });
  assert.equal(once.plan, "none");
  assert.equal(once.state.samples, 1);
  assert.equal(floorBus(once.plan, false, 50), null);
});

test("a flat press under 65 sends the same engine-on frame as 45% charge", () => {
  let state = floorDown(emptyFloor(), 100);
  state = floorAssist(state, { type: "speed", speedKmh: 64, now: 1000 }).state;
  const stuck = floorAssist(state, { type: "speed", speedKmh: 64, now: 2500 });
  assert.equal(stuck.plan, "engine");
  assert.equal(stuck.state.active, true);
  assert.equal(floorBus(stuck.plan, false, 50), "force-on");
  assert.equal(floorBus(stuck.plan, false, 10), "force-on");
  assert.equal(floorBus(stuck.plan, false, null), "force-on");
  assert.equal(floorCommandsEngine(true, 22.1), false);
  assert.equal(floorBus(stuck.plan, true, 30), null);
  assert.equal(floorBus(stuck.plan, true, null), null);
  assert.equal(floorCommandsEngine(true, 22), true);
  assert.equal(floorBus(stuck.plan, true, 22), "force-on");
  assert.equal(floorBus(stuck.plan, true, 21), "force-on");
  assert.equal(floorBus("none", true, 10), null);
  const plain = stepDrive(drive({ mode: "engine", phase: "engine", soc: 50, previousPlan: "none" }), { type: "soc", soc: 50 });
  assert.equal(plain.plan, "force-on");
  assert.equal(plain.state.previousPlan, "force-on");
  const bandExit = stepDrive(drive({ mode: "engine", phase: "engine", soc: 50, previousPlan: "force-on" }), { type: "soc", soc: 50 });
  assert.equal(bandExit.plan, "force-on");
  assert.equal(floorFace("electric", "battery", true).engine, true);
  assert.equal(floorFace("electric", "battery", true).electric, false);
  assert.equal(floorFace("electric", "battery", false).engine, false);
  assert.equal(floorFace("cycle", "battery", true).engine, true);
  assert.equal(floorFace("cycle", "battery", true).electric, false);
  const fast = floorAssist(floorDown(emptyFloor(), 100), { type: "speed", speedKmh: 105, now: 1000 }).state;
  const still = floorAssist(fast, { type: "speed", speedKmh: 105, now: 2000 });
  assert.equal(still.plan, "none");
});

test("a 40 percent pedal and a slow gain arms the stretch", () => {
  const kmh = (mph) => mph / 0.621371;
  const run = (pedal, prevMph, actualMph, dt = 1000) => {
    let state = floorDown(emptyFloor(), pedal);
    state = floorAssist(state, { type: "speed", speedKmh: kmh(prevMph), now: 0 }).state;
    return floorAssist(state, { type: "speed", speedKmh: kmh(actualMph), now: dt });
  };
  const armed = run(40, 30, 30.5);
  assert.equal(armed.plan, "engine");
  assert.equal(armed.state.samples > 1, true);
  assert.equal(floorBus(armed.plan, false, 50), "force-on");
  assert.equal(floorBus(armed.plan, true, 30), null);
  assert.equal(floorBus(armed.plan, true, 22), "force-on");
  assert.equal(run(20, 30, 30.2).plan, "none");
  assert.equal(run(40, 30, 30.2, 5000).plan, "none");
  assert.equal(run(40, 70, 70).plan, "none");
  assert.equal(run(40, 30, 32).plan, "none");
  const faster = floorAssist(armed.state, { type: "speed", speedKmh: kmh(40), now: 2000 });
  assert.equal(faster.plan, "engine");
  assert.equal(faster.state.active, true);
  assert.equal(FORCE_ON, "AE 31 06 00 00 00 00");
});

test("the stretch is 10 seconds or the press, whichever is longer", () => {
  let state = floorDown(emptyFloor(), 100);
  state = floorAssist(state, { type: "speed", speedKmh: 40, now: 0 }).state;
  state = floorAssist(state, { type: "speed", speedKmh: 40, now: 1000 }).state;
  assert.equal(state.active, true);
  const lifted = floorAssist(state, { type: "pedal", pedalPct: 10, now: 3000 });
  assert.equal(lifted.state.active, true);
  assert.equal(floorAssist(lifted.state, { type: "tick", now: 10999 }).state.active, true);
  assert.equal(floorAssist(lifted.state, { type: "tick", now: 11000 }).state.active, false);
  const held = floorAssist(state, { type: "tick", now: 20000 });
  assert.equal(held.state.active, true);
  assert.equal(floorAssist(held.state, { type: "pedal", pedalPct: 0, now: 20000 }).state.active, false);
  const again = floorAssist(lifted.state, { type: "tick", now: 11000 });
  assert.equal(floorAssist(again.state, { type: "tick", now: 15000 }).plan, "none");
});

test("a refused pedal or no pedal does not start the stretch", () => {
  let state = floorDown(emptyFloor(), null);
  state = floorAssist(state, { type: "speed", speedKmh: 20, now: 0 }).state;
  assert.equal(floorAssist(state, { type: "speed", speedKmh: 20, now: 1000 }).plan, "none");
  let live = floorDown(emptyFloor(), 100);
  live = floorAssist(live, { type: "speed", speedKmh: 20, now: 0 }).state;
  live = floorAssist(live, { type: "speed", speedKmh: 20, now: 1000 }).state;
  const refused = floorAssist(live, { type: "refused", now: 1500 });
  assert.equal(refused.plan, "none");
  const stuck = floorAssist(refused.state, { type: "speed", speedKmh: 20, now: 2000 });
  assert.equal(stuck.plan, "none");
  const up = floorAssist(stuck.state, { type: "pedal", pedalPct: 0, now: 3000 }).state;
  let next = floorDown(up, 100);
  next = floorAssist(next, { type: "speed", speedKmh: 20, now: 4000 }).state;
  assert.equal(floorAssist(next, { type: "speed", speedKmh: 20, now: 5000 }).plan, "engine");
  assert.equal(floorAssist(live, { type: "cancel", now: 1600 }).plan, "none");
});

test("engine mode plans force-on at 10, 45, and 50", () => {
  for (const soc of [10, 45, 50]) {
    const result = stepDrive(drive({ mode: "engine", phase: "engine", soc, previousPlan: "none" }), { type: "soc", soc });
    assert.equal(result.state.mode, "engine");
    assert.equal(result.plan, "force-on");
  }
  const empty = stepDrive(drive({ mode: "engine", phase: "engine", soc: null, previousPlan: "none" }), { type: "soc", soc: null });
  assert.equal(empty.plan, "force-on");
  const above = stepDrive(drive({ mode: "engine", phase: "engine", soc: 80, previousPlan: "force-on" }), { type: "soc", soc: 80 });
  assert.equal(above.plan, "force-on");
});

test("cycle plans force-on at 40 and 44 and force-off at 46", () => {
  let result = stepDrive(drive({ soc: 60 }), { type: "cycle" });
  result = stepDrive(result.state, { type: "soc", soc: 40 });
  assert.equal(result.state.mode, "cycle");
  assert.equal(result.state.phase, "engine");
  assert.equal(result.plan, "force-on");
  result = stepDrive(result.state, { type: "soc", soc: 44 });
  assert.equal(result.state.phase, "engine");
  assert.equal(result.plan, "force-on");
  result = stepDrive(result.state, { type: "soc", soc: 46 });
  assert.equal(result.state.phase, "battery");
  assert.equal(result.plan, "force-off");
});

test("a refused hold keeps the selected mode and plans force-on", () => {
  const refused = stepDrive(drive({ mode: "cycle", phase: "battery", soc: 50, previousPlan: "force-off" }), { type: "refuse" });
  assert.equal(refused.state.mode, "cycle");
  assert.equal(refused.plan, "force-on");
  assert.notEqual(refused.plan, "release");
  const stopped = onHoldRefused([
    { cmd: FORCE_OFF, tag: "hold" },
    { cmd: "01 0C", tag: "rpm" },
  ], false);
  assert.equal(stopped.commands.includes(RELEASE), false);
  assert.equal(stopped.queue.some((item) => item.tag === "hold"), false);
});

test("crank rpm 200 does not produce force-off while a mode is selected", () => {
  for (const mode of ["electric", "engine", "cycle"]) {
    const command = linkCommand({
      mode,
      phase: mode === "cycle" ? "battery" : "engine",
      plan: "force-off",
      rpm: 200,
      previousRpm: 0,
      samples: [50, 50],
      ageMs: 5000,
    });
    assert.equal(command, "force-on");
    assert.notEqual(command, "force-off");
  }
  const stopped = linkCommand({
    mode: "electric",
    phase: "battery",
    plan: "force-off",
    rpm: 0,
    previousRpm: 0,
    samples: [50, 50],
    ageMs: 5000,
  });
  assert.equal(stopped, "force-off");
});

test("a full unused pack latches and a parked 100 percent at 0 rpm does not", () => {
  assert.equal(unusedPack(false, { soc: 98, rpm: 400, current: 1 }), true);
  assert.equal(unusedPack(false, { soc: 100, rpm: 900, current: -4 }), true);
  assert.equal(unusedPack(false, { soc: 100, rpm: 0, current: 0 }), false);
  assert.equal(unusedPack(true, { soc: 99, rpm: 800, current: 5 }), false);
  assert.equal(unusedPack(true, { soc: 97.9, rpm: 800, current: 1 }), false);
  assert.equal(unusedPack(true, { soc: 99, rpm: 800, current: 4.9 }), true);
  const latched = linkCommand({
    mode: "electric",
    phase: "battery",
    plan: "force-off",
    latched: true,
    rpm: 800,
    previousRpm: 800,
    samples: [99, 99],
    ageMs: 5000,
  });
  assert.equal(latched, "force-on");
  const parked = linkCommand({
    mode: "electric",
    phase: "battery",
    plan: "force-off",
    latched: unusedPack(false, { soc: 100, rpm: 0, current: 0 }),
    rpm: 0,
    previousRpm: 0,
    samples: [100, 100],
    ageMs: 5000,
  });
  assert.equal(parked, "force-off");
  const missing = linkCommand({
    mode: "electric",
    plan: "force-off",
    rpm: 0,
    samples: [],
    ageMs: 3000,
  });
  assert.equal(missing, "force-on");
  assert.notEqual(missing, "release");
});

test("background listeners do not drop the hold", () => {
  const app = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
  assert.equal(app.includes("askPedal = false"), false);
  const onFn = app.slice(app.indexOf("function considerOn"), app.indexOf("function considerHold"));
  const holdFn = app.slice(app.indexOf("function considerHold"), app.indexOf("function enact"));
  assert.equal(onFn.includes("visibilityState"), false);
  assert.equal(holdFn.includes("visibilityState"), false);
  assert.equal(app.includes('addEventListener("pagehide", saveTrip)'), true);
  assert.equal(app.includes('addEventListener("freeze", saveTrip)'), true);
  assert.equal(app.includes("resumeLink"), true);
  assert.equal(app.includes("typeof AndroidBLE"), true);
  assert.equal(app.includes('title: "Volt"'), true);
  const miss = app.slice(app.indexOf('job.tag === "rpm" && timedOut'), app.indexOf("const parsed"));
  assert.equal(miss.includes('enact("release")'), false);
  assert.equal(miss.includes("clearProof()"), false);
  const sw = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
  assert.equal(sw.includes("voltpanel-39"), true);
  assert.equal(sw.includes("/js/app.js?v=33"), true);
  assert.equal(sw.includes("/js/protocol.js?v=32"), true);
});

test("engine stretch miles stay on the trip and off the electric miles", () => {
  const next = tripStep({ miles: 0, electricMiles: 0 }, { mph: 60, rpm: 0, dt: 60, engine: true });
  assert.equal(next.miles, 1);
  assert.equal(next.electricMiles, 0);
  const plain = tripStep({ miles: 0, electricMiles: 0 }, { mph: 60, rpm: 0, dt: 60 });
  assert.equal(plain.electricMiles, 1);
  const many = tripStep({ miles: 3, electricMiles: 2 }, { mph: 60, rpm: 100, dt: 60, engine: true });
  assert.equal(many.miles, 4);
  assert.equal(many.electricMiles, 2);
});
