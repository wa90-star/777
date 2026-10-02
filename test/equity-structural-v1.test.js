const test = require("node:test");
const assert = require("node:assert/strict");
const { directionConfirmed } = require("../equity-structural-v1")._test;

test("equity price confirmation must agree with structural direction", () => {
  const config = { day: 2.5, velocity: 0.8 };
  assert.equal(directionConfirmed("LONG", 2.6, 0.1, config), true);
  assert.equal(directionConfirmed("LONG", -3.0, -1.0, config), false);
  assert.equal(directionConfirmed("SHORT", -2.6, -0.1, config), true);
  assert.equal(directionConfirmed("SHORT", 3.0, 1.0, config), false);
});

test("equity velocity can confirm before the daily threshold is reached", () => {
  const config = { day: 2.5, velocity: 0.8 };
  assert.equal(directionConfirmed("SHORT", -0.4, -0.9, config), true);
  assert.equal(directionConfirmed("LONG", 0.4, 0.9, config), true);
});
