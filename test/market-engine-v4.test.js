const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("../market-engine-v4");

test("extreme price alone is not two-dimensional confirmation", () => {
  const result = _test.confirmationSummary([{ type: "price", independenceGroup: "market-price" }]);
  assert.equal(result.count, 1);
  assert.equal(result.qualified, false);
});

test("duplicate derived evidence does not count twice", () => {
  const result = _test.confirmationSummary([
    { type: "price", independenceGroup: "market-price" },
    { type: "price", independenceGroup: "market-price" }
  ]);
  assert.equal(result.count, 1);
  assert.equal(result.qualified, false);
});

test("distinct evidence groups qualify", () => {
  const result = _test.confirmationSummary([
    { type: "price", independenceGroup: "market-price" },
    { type: "options", independenceGroup: "market-derivatives" }
  ]);
  assert.equal(result.count, 2);
  assert.equal(result.qualified, true);
});

test("market phase is timezone-aware and excludes weekends", () => {
  assert.equal(_test.marketPhaseAt(new Date("2026-09-28T14:00:00Z")), "regular");
  assert.equal(_test.marketPhaseAt(new Date("2026-09-28T12:00:00Z")), "premarket");
  assert.equal(_test.marketPhaseAt(new Date("2026-09-28T21:00:00Z")), "afterhours");
  assert.equal(_test.marketPhaseAt(new Date("2026-09-27T14:00:00Z")), "closed");
});
