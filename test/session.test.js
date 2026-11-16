import { test } from "node:test";
import assert from "node:assert/strict";
import { adapterLine, connectFace, packLine, reconnectPlan, writePlan } from "../js/protocol.js";

test("write plan prefers a write with a response", () => {
  assert.deepEqual(writePlan({ write: true, writeWithoutResponse: true }), [
    "writeValueWithResponse",
    "writeValueWithoutResponse",
  ]);
  assert.deepEqual(writePlan({ write: true, writeWithoutResponse: false }), [
    "writeValueWithResponse",
    "writeValueWithoutResponse",
  ]);
  assert.deepEqual(writePlan({ writeWithoutResponse: true }), [
    "writeValueWithoutResponse",
    "writeValueWithResponse",
  ]);
  assert.deepEqual(writePlan({}), [
    "writeValueWithResponse",
    "writeValueWithoutResponse",
  ]);
  assert.deepEqual(writePlan({ write: false, writeWithoutResponse: false }), [
    "writeValueWithResponse",
    "writeValueWithoutResponse",
  ]);
  assert.deepEqual(writePlan(null), [
    "writeValueWithResponse",
    "writeValueWithoutResponse",
  ]);
});

test("pack line keeps a short command and compacts a long one", () => {
  assert.deepEqual(packLine("01 0C"), ["01 0C\r"]);
  assert.equal(packLine("01 0C")[0].endsWith("\r"), true);

  const engine = packLine("AE 31 05 00 00 00 00");
  assert.equal("AE 31 05 00 00 00 00".length + 1 > 20, true);
  assert.deepEqual(engine, ["AE310500000000\r"]);
  assert.equal(engine.length, 1);
  assert.equal(engine[0].includes(" "), false);
  assert.equal(engine[0].endsWith("\r"), true);

  const compact = "0102030405060708090A0B0C0D0E0F1011121314";
  assert.equal(compact.length, 40);
  const parts = packLine(compact);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 20));
  assert.equal(parts.join(""), compact + "\r");
  assert.equal(parts[parts.length - 1].endsWith("\r"), true);
  assert.equal(parts[parts.length - 1], "\r");
});

test("adapter line for an empty session, one adapter, and the error path", () => {
  assert.equal(adapterLine({}), "No Bluetooth");
  assert.equal(adapterLine({ hasBluetooth: true }), "Not Connected");
  assert.equal(adapterLine({ hasBluetooth: true, availability: false, errorName: "NotFoundError" }), "Bluetooth Off");
  assert.equal(adapterLine({ hasBluetooth: true, connected: true, name: "VEEPEAK" }), "VEEPEAK");
  assert.equal(adapterLine({ hasBluetooth: true, connected: true, name: "VEEPEAK", noReply: true }), "VEEPEAK · No Reply");
  assert.equal(adapterLine({ hasBluetooth: true, errorName: "NotFoundError" }), "Not Connected");
  assert.equal(adapterLine({ hasBluetooth: true, errorName: "NotAllowedError" }), "Allow Nearby Devices");
  assert.equal(adapterLine({ hasBluetooth: true, errorName: "SecurityError" }), "Allow Nearby Devices");
  assert.equal(adapterLine({ hasBluetooth: true, reconnecting: true, name: "VEEPEAK" }), "Reconnecting");
});

test("reconnect once after a drop, and stop on disconnect or the cap", () => {
  const first = reconnectPlan({ attempts: 0 });
  assert.equal(first.retry, true);
  assert.equal(first.text, "Reconnecting");
  assert.equal(first.wait, 500);
  const second = reconnectPlan({ attempts: 1 });
  assert.equal(second.retry, true);
  assert.equal(second.wait, 1000);
  assert.deepEqual(reconnectPlan({ userDisconnect: true, attempts: 0 }), { retry: false, text: "Not Connected", wait: 0 });
  assert.deepEqual(reconnectPlan({ attempts: 5 }), { retry: false, text: "Not Connected", wait: 0 });
  assert.equal(reconnectPlan({ attempts: 4 }).retry, true);
});

test("connect face is CONNECT until the link is up, including no reply", () => {
  assert.deepEqual(connectFace({ connected: false }), { label: "CONNECT", lit: false });
  assert.deepEqual(connectFace({ connected: true, name: "VEEPEAK" }), { label: "CONNECTED", lit: true });
  assert.deepEqual(connectFace({ connected: true, name: "VEEPEAK", noReply: true }), { label: "CONNECTED", lit: true });
  assert.deepEqual(connectFace({ connected: true, reconnecting: true, name: "VEEPEAK" }), { label: "CONNECT", lit: false });
  assert.deepEqual(connectFace({ reconnecting: true }), { label: "CONNECT", lit: false });
  assert.deepEqual(connectFace({ hasBluetooth: false }), { label: "CONNECT", lit: false });
  assert.deepEqual(connectFace({}), { label: "CONNECT", lit: false });
  assert.deepEqual(connectFace(null), { label: "CONNECT", lit: false });
});
