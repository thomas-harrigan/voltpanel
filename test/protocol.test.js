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
  holdFloor,
  quietPlan,
  releaseCommands,
  stepDrive,
  clearedTrip,
  decodeDtcBytes,
  parseDtcResponse,
  tripRecord,
  tripStep,
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

test("boost off blocks 24 and allows 24.1", () => {
  assert.equal(holdFloor(false), 24);
  assert.equal(stepDrive(drive({ soc: 24 }), { type: "electric" }).state.mode, "off");
  assert.equal(stepDrive(drive({ soc: 18.1 }), { type: "electric" }).state.mode, "off");
  const allow = stepDrive(drive({ soc: 24.1 }), { type: "electric" });
  assert.equal(allow.state.mode, "electric");
  assert.equal(allow.plan, "force-off");
});

test("boost on blocks 18 and allows 18.1", () => {
  assert.equal(holdFloor(true), 18);
  assert.equal(stepDrive(drive({ soc: 18, boost: true }), { type: "electric" }).state.mode, "off");
  const low = stepDrive(drive({ soc: 18.1, boost: true }), { type: "electric" });
  assert.equal(low.state.mode, "electric");
  assert.equal(low.plan, "force-off");
  assert.equal(stepDrive(drive({ soc: 24, boost: true }), { type: "electric" }).state.mode, "electric");
});

test("electric at 23.5 with boost off trips to engine and locks 2 points up", () => {
  const result = stepDrive(drive({ mode: "electric", phase: "battery", soc: 40, previousPlan: "force-off" }), { type: "soc", soc: 23.5 });
  assert.equal(result.state.mode, "engine");
  assert.equal(result.state.phase, "engine");
  assert.equal(result.state.lockUntil, 25.5);
  assert.notEqual(result.plan, "force-off");
});

test("electric at 17.5 with boost on trips to engine and locks 2 points up", () => {
  const result = stepDrive(drive({ mode: "electric", boost: true, soc: 40, previousPlan: "force-off" }), { type: "soc", soc: 17.5 });
  assert.equal(result.state.mode, "engine");
  assert.equal(result.state.lockUntil, 19.5);
  assert.notEqual(result.plan, "force-off");
});

test("the lock blocks electric until soc reaches it", () => {
  const blocked = stepDrive(drive({ soc: 29.9, lockUntil: 30 }), { type: "electric" });
  assert.equal(blocked.state.mode, "off");
  assert.equal(blocked.plan, "none");
  const open = stepDrive(drive({ soc: 30, lockUntil: 30 }), { type: "electric" });
  assert.equal(open.state.mode, "electric");
  assert.equal(open.plan, "force-off");
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
  assert.equal(cleared.plan, "release");
  const back = stepDrive(drive({ mode: "engine", phase: "engine", soc: 50 }), { type: "electric" });
  assert.equal(back.state.mode, "electric");
  assert.equal(back.state.phase, "battery");
  assert.equal(back.plan, "force-off");
});

test("cycle holds on the battery, releases at 24, and returns at 32", () => {
  let result = stepDrive(drive({ soc: 40 }), { type: "cycle" });
  assert.equal(result.state.mode, "cycle");
  assert.equal(result.state.phase, "battery");
  assert.equal(result.plan, "force-off");
  result = stepDrive(result.state, { type: "soc", soc: 24.1 });
  assert.equal(result.state.phase, "battery");
  result = stepDrive(result.state, { type: "soc", soc: 24 });
  assert.equal(result.state.mode, "cycle");
  assert.equal(result.state.phase, "engine");
  assert.equal(result.state.lockUntil, 26);
  assert.notEqual(result.plan, "force-off");
  result = stepDrive(result.state, { type: "soc", soc: 31.9 });
  assert.equal(result.state.phase, "engine");
  assert.equal(result.state.mode, "cycle");
  result = stepDrive(result.state, { type: "soc", soc: 32 });
  assert.equal(result.state.phase, "battery");
  assert.equal(result.plan, "force-off");
  assert.equal(result.state.lockUntil, null);
});

test("cycle with boost on releases at 18 and returns at 32", () => {
  let result = stepDrive(drive({ soc: 40, boost: true }), { type: "cycle" });
  result = stepDrive(result.state, { type: "soc", soc: 18.1 });
  assert.equal(result.state.phase, "battery");
  result = stepDrive(result.state, { type: "soc", soc: 18 });
  assert.equal(result.state.phase, "engine");
  assert.equal(result.state.lockUntil, 20);
  result = stepDrive(result.state, { type: "soc", soc: 32 });
  assert.equal(result.state.phase, "battery");
  assert.equal(result.plan, "force-off");
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
  assert.equal(holdFloor(true), 18);
  assert.equal(holdFloor(false), 24);
  assert.equal(src.includes("? 18 : 24"), true);
  assert.equal(src.includes("? 16 : 22"), false);
  assert.equal(src.includes("32"), true);
  assert.equal(src.includes("enginePlan"), false);
  assert.equal(src.includes("regen"), false);
  assert.equal(/\b2200\b/.test(src), false);
  assert.equal(/\b1400\b/.test(src), false);
  assert.equal(/setpoint/i.test(src), false);
});

test("engine mode and the cycle engine phase stay force-on", () => {
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

  let cycle = stepDrive(drive({ soc: 40 }), { type: "cycle" });
  cycle = stepDrive(cycle.state, { type: "soc", soc: 24 });
  assert.equal(cycle.state.phase, "engine");
  assert.equal(cycle.plan, "release");
  assert.equal(quietPlan({ ...cycle.state, soc: 24, rpm: 4000, kw: -40 }), "none");
  cycle = stepDrive(cycle.state, { type: "soc", soc: 31.9 });
  assert.equal(cycle.state.phase, "engine");
  assert.equal(cycle.state.mode, "cycle");
  assert.equal(quietPlan({ ...cycle.state, soc: 31.9, rpm: 2400, kw: 10 }), "none");
  cycle = stepDrive(cycle.state, { type: "soc", soc: 32 });
  assert.equal(cycle.state.phase, "battery");
  assert.equal(cycle.plan, "force-off");
  assert.equal(quietPlan({ ...cycle.state, soc: 32, rpm: 0 }), "none");

  const stopped = onHoldRefused([
    { cmd: "3E", tag: "hold" },
    { cmd: FORCE_OFF, tag: "hold" },
    { cmd: "01 0C", tag: "rpm" },
  ], true);
  assert.deepEqual(stopped.commands, ["ATSH 7E1", RELEASE]);
  assert.equal(stopped.commands.includes(FORCE_ON), false);
  assert.equal(quietPlan({ mode: "engine", phase: "engine", forceOnOk: false, rpm: 4000, soc: 50 }), "none");
  const refused = stepDrive(drive({ mode: "electric", phase: "battery", soc: 40, previousPlan: "force-off" }), { type: "refuse" });
  assert.equal(refused.plan, "release");
  assert.notEqual(refused.plan, "force-on");
});

test("attach releases once when engine or the cycle engine phase is already selected", () => {
  assert.deepEqual(attachRelease({ mode: "off" }), []);
  assert.deepEqual(attachRelease({ mode: "electric", phase: "battery", soc: 50 }), []);
  assert.deepEqual(attachRelease({ mode: "cycle", phase: "battery", soc: 32 }), []);
  assert.deepEqual(attachRelease({ mode: "engine", phase: "engine", soc: 50, rpm: 4000 }), releaseCommands());
  assert.deepEqual(attachRelease({ mode: "engine", phase: "engine", soc: null, rpm: 0 }), releaseCommands());
  assert.deepEqual(attachRelease({ mode: "cycle", phase: "engine", soc: 24, rpm: 4000 }), releaseCommands());
  assert.deepEqual(attachRelease({ mode: "cycle", phase: "engine", soc: 31.9 }), releaseCommands());
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
  assert.equal(economy({ speedKmh: 100, fuelKnown: true, fuelLph: 0 }).value, 40);
  assert.equal(economy({ speedKmh: 100, rpm: 0, fuelKnown: false, mafKnown: false }).value, 40);
  assert.equal(economy({ speedKmh: 100, fuelKnown: false, mafKnown: false }).value, 40);
  assert.equal(economy({ speedKmh: 100, rpm: 400, fuelKnown: false, mafKnown: false }).value, null);
  assert.equal(economy({ speedKmh: 100, rpm: 1800, fuelKnown: false, mafKnown: false }).value, null);
  const rate = economy({ speedKmh: 100, fuelKnown: true, fuelLph: 1 });
  assert.ok(rate.value > 0);
  assert.notEqual(rate.value, 40);
  const src = readFileSync(new URL("../js/protocol.js", import.meta.url), "utf8");
  assert.equal(src.includes("MPGe"), false);
});

test("moving with rpm 0 and no fuel answer is 40", () => {
  assert.equal(economy({ speedKmh: 100, rpm: 0, fuelKnown: false, mafKnown: false }).value, 40);
  assert.equal(economy({ speedKmh: 16, rpm: 0 }).value, 40);
  assert.equal(economy({ speedKmh: 100, rpm: 399, fuelLph: 0.04, fuelKnown: true }).value, 40);
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
