import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GAUGES, SHOTS, actionCenters, arcPath, dash, formatMiles, formatReading, fraction, outputGeometry, rpmColors, zoneColors } from "../js/gauges.js";

function rgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function isStopRed(hex) {
  const [r, g, b] = rgb(hex);
  return r > 180 && g < 80 && b < 80;
}

function redder(hex) {
  const [r, g] = rgb(hex);
  return r > g && r > 180;
}

function greener(hex) {
  const [r, g] = rgb(hex);
  return g > r && g > 140;
}

test("battery is 0 to 100 and the old voltage label is gone", () => {
  assert.equal(GAUGES.battery.min, 0);
  assert.equal(GAUGES.battery.max, 100);
  assert.equal(GAUGES.battery.label, "Battery");
  assert.equal(GAUGES.battery.unit, "%");
  assert.equal(GAUGES.battery.red, "low");
  assert.equal(GAUGES.voltage, undefined);
  assert.equal(Object.values(GAUGES).some((spec) => spec.label === "Voltage"), false);
  assert.equal(GAUGES.economy.max, 40);
  assert.equal(GAUGES.economy.label, "MPG");
  assert.equal(GAUGES.economy.mpgeMax, undefined);
  assert.equal(GAUGES.rpm.min, 0);
  assert.equal(GAUGES.rpm.max, 6000);
  assert.equal(GAUGES.rpm.redFrom, 4800);
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.equal(html.includes("Engine Mode"), true);
  assert.equal(html.includes("Cycle Mode"), true);
  assert.equal(html.includes("Battery Boost"), true);
  assert.equal(html.includes(">Battery<"), true);
  assert.equal(html.includes(">Voltage<"), false);
  assert.equal(html.includes("MPGe"), false);
});

test("rpm is red from 4800 and not red at 4799", () => {
  assert.equal(isStopRed(rpmColors(4800)[0]), true);
  assert.equal(isStopRed(rpmColors(4800)[1]), true);
  assert.equal(isStopRed(rpmColors(6000)[0]), true);
  assert.equal(isStopRed(rpmColors(4799)[0]), false);
  assert.equal(isStopRed(rpmColors(4799)[1]), false);
  assert.equal(greener(rpmColors(0)[0]), true);
});

test("battery is red when empty and green when full", () => {
  const low = zoneColors(0, GAUGES.battery);
  const full = zoneColors(100, GAUGES.battery);
  assert.ok(redder(low[0]) && redder(low[1]));
  assert.ok(greener(full[0]) && greener(full[1]));
});

test("output is centered at the top, signed, and clamped at 120", () => {
  const regen = outputGeometry(-30);
  assert.equal(regen.text, "+30");
  assert.equal(regen.text.includes("-"), false);
  assert.equal(regen.side, "input");
  assert.ok(regen.start < 50);
  assert.equal(regen.length, 12.5);
  assert.deepEqual(regen.colors, ["#3dbe6e", "#3dbe6e"]);
  const out = outputGeometry(60);
  assert.equal(out.text, "60");
  assert.equal(out.side, "output");
  assert.equal(out.start, 50);
  assert.equal(out.length, 25);
  assert.equal(out.colors[0], "#3dbe6e");
  assert.notEqual(out.colors[1], "#3dbe6e");
  const zero = outputGeometry(0);
  assert.equal(zero.text, "0");
  assert.equal(zero.start, 50);
  assert.equal(zero.length, 0);
  assert.equal(zero.cap, "butt");
  const high = outputGeometry(150);
  const low = outputGeometry(-150);
  assert.equal(high.text, "120");
  assert.equal(high.side, "output");
  assert.equal(high.length, 50);
  assert.equal(high.colors[1], "#e23b2f");
  assert.equal(low.text, "+120");
  assert.equal(low.side, "input");
  assert.equal(low.length, 50);
  assert.equal(low.start, 0);
});

test("empty reading is an em dash", () => {
  assert.equal(formatReading(null), "—");
  assert.equal(formatReading(Number.NaN), "—");
  assert.equal(formatReading(80.4), "80");
  assert.equal(outputGeometry(null).text, "—");
});

test("arc starts at the lower left and the dash follows the value", () => {
  const d = arcPath();
  assert.ok(d.startsWith("M "));
  assert.ok(d.includes(" A "));
  assert.equal(dash(0, 0, 100), "0.00 100");
  assert.equal(dash(100, 0, 100), "100.00 100");
  assert.equal(dash(null, 0, 100), "0.00 100");
  assert.equal(fraction(100, 0, 100), 1);
  assert.equal(fraction(0, 0, 6000), 0);
});

test("action centers sit on the column gaps", () => {
  const dial = 140;
  const gap = 12;
  const centers = actionCenters(dial, gap);
  assert.equal(centers.diag, dial + gap / 2);
  assert.equal(centers.reset, 2 * dial + 1.5 * gap);
  const css = readFileSync(new URL("../css/app.css", import.meta.url), "utf8");
  assert.equal(css.includes("var(--dial) + var(--col-gap) / 2"), true);
  assert.equal(css.includes("2 * var(--dial) + 1.5 * var(--col-gap)"), true);
  assert.equal(css.includes("(56px + var(--dial) * 0.794) / 2"), true);
});

test("modes and gauges stay in face order", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const modes = html.slice(html.indexOf('class="modes"'), html.indexOf('class="grid"'));
  const modeNames = [...modes.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(modeNames, ["Cycle Mode", "Electric Mode", "Engine Mode", "Battery Boost"]);
  const grid = html.slice(html.indexOf('class="grid"'), html.indexOf('class="bar"'));
  const labels = [...grid.matchAll(/class="label[^"]*"[^>]*>([\s\S]*?)<\/div>/g)].map((match) =>
    match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
  );
  assert.deepEqual(labels, ["Battery", "Output", "Electric Miles", "RPM", "MPG", "Trip"]);
  assert.equal(html.includes("DIAG"), true);
  assert.equal(html.includes("RESET"), true);
  assert.equal(html.includes("TRIP"), true);
  assert.equal(GAUGES.electric.min, 0);
  assert.equal(GAUGES.electric.max, 500);
  assert.equal(GAUGES.electric.unit, "mi");
  assert.equal(GAUGES.electric.solid, "#3dbe6e");
  assert.equal(GAUGES.electric.decimals, 1);
  assert.equal(GAUGES.trip.min, 0);
  assert.equal(GAUGES.trip.max, 500);
  assert.equal(GAUGES.trip.solid, "#3dbe6e");
  assert.equal(formatMiles(0), "0.0");
  assert.equal(formatMiles(1), "1.0");
  assert.equal(formatMiles(null), "—");
});

test("shot fixtures paint the four modes and both output sides", () => {
  assert.equal(SHOTS.electric.mode, "electric");
  assert.equal(SHOTS.engine.mode, "engine");
  assert.equal(SHOTS.cycle.mode, "cycle");
  assert.equal(SHOTS.locked.soc <= 24, true);
  assert.equal(SHOTS.input.kw, -30);
  assert.equal(SHOTS.output.kw, 60);
  assert.ok(SHOTS.output.kw <= 120);
  assert.ok(SHOTS.engine.rpm < 4800);
});
