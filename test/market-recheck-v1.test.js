const test = require("node:test");
const assert = require("node:assert/strict");
const queueMarketRecheck = require("../market-recheck-v1");

function fixture(overrides = {}) {
  const calls = [];
  const state = { marketWindowOpen: true, lastError: null, lastCoreScanAt: null };
  const market = {
    marketWindowOpen: () => true,
    getState: () => ({ ...state }),
    runContext: async (...args) => { calls.push(["context", args]); },
    runCore: async (...args) => { calls.push(["core", args]); state.lastCoreScanAt = "2026-09-30T21:30:00Z"; },
    ...overrides
  };
  return { market, calls, state };
}
const items = [{ id: "fresh-policy" }];

test("acknowledgement waits for the deferred market scan to finish", async () => {
  const { market, state } = fixture();
  let start;
  let finish;
  let settled = false;
  market.runCore = () => new Promise((resolve) => { finish = resolve; });
  const pending = queueMarketRecheck({ market, items, defer: (run) => { start = run; } });
  pending.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  const running = start();
  await Promise.resolve();
  assert.equal(settled, false);
  state.lastCoreScanAt = "2026-09-30T21:30:00Z";
  finish();
  await running;
  assert.deepEqual(await pending, { completed: true, lastCoreScanAt: "2026-09-30T21:30:00Z" });
});

test("a swallowed core failure rejects and each retry invokes a new scan", async () => {
  const { market, state } = fixture();
  let attempts = 0;
  market.runCore = async (...args) => {
    assert.deepEqual(args, []);
    attempts++;
    state.lastError = attempts === 1 ? "Alpaca HTTP 401" : null;
    state.lastCoreScanAt = attempts === 1 ? "old-snapshot" : "new-snapshot";
  };
  await assert.rejects(queueMarketRecheck({ market, items }), /Market core recheck failed: Alpaca HTTP 401/);
  assert.deepEqual(await queueMarketRecheck({ market, items }), { completed: true, lastCoreScanAt: "new-snapshot" });
  assert.equal(attempts, 2);
});

test("context failure cannot be erased by a subsequent successful core scan", async () => {
  const { market, state, calls } = fixture();
  market.runContext = async () => { state.lastError = "context feed offline"; };
  await assert.rejects(queueMarketRecheck({ market, items, refreshContext: true }), /Market context recheck failed: context feed offline/);
  assert.equal(calls.length, 0);
});

test("ECB recheck completes context then core without forcing the market window", async () => {
  const { market, calls } = fixture();
  const result = await queueMarketRecheck({ market, items, refreshContext: true });
  assert.deepEqual(calls, [["context", []], ["core", []]]);
  assert.equal(result.completed, true);
});

test("closed market window is suppressed and performs no scan", async () => {
  const { market, calls } = fixture({ marketWindowOpen: () => false });
  assert.deepEqual(await queueMarketRecheck({ market, items, refreshContext: true }), { suppressed: true, reason: "market-window-closed" });
  assert.equal(calls.length, 0);
});

test("window closing between context and core prevents the core scan", async () => {
  let open = true;
  const { market, calls } = fixture({ marketWindowOpen: () => open });
  market.runContext = async () => { open = false; };
  assert.deepEqual(await queueMarketRecheck({ market, items, refreshContext: true }), { suppressed: true, reason: "market-window-closed" });
  assert.equal(calls.length, 0);
});

test("an engine-side market-window skip cannot acknowledge stale results", async () => {
  const { market, state } = fixture();
  market.runCore = async () => { state.marketWindowOpen = false; state.lastError = "old error"; };
  assert.deepEqual(await queueMarketRecheck({ market, items }), { suppressed: true, reason: "market-window-closed" });
});

test("thrown scan errors reject instead of becoming successful scheduling acknowledgements", async () => {
  const { market } = fixture({ runCore: async () => { throw new Error("scan exception"); } });
  await assert.rejects(queueMarketRecheck({ market, items }), /scan exception/);
});
