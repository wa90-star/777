"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createTwelveContextRuntime } = require("../twelve-context-runtime-v1");
const { createTwelveBasicContext } = require("../twelve-basic-context-v1");
const START = Date.parse("2026-11-05T15:00:30Z"), MINUTE = 60000, KEY = "synthetic-private-test-key";
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup(t, overrides = {}) {
  let at = START, callback, timerCleared = 0, closed = 0, created = 0;
  const calls = [], evaluations = [], delays = [];
  let poll = async () => ({ results: [] }), reaction = () => ({ assessable: false });
  let status = () => ({ configured: true, configuredSymbols: 3, observedSymbols: 2, freshSymbols: 1,
    latestObservationAt: new Date(START).toISOString(), quota: { usedToday: 2, dailyLimit: 600, minuteLimit: 6, utcDay: "2026-11-05" } });
  const provider = { pollDue: opts => { calls.push(opts); return poll(opts); },
    evaluateReaction: (symbol, opts) => { evaluations.push({ symbol, ...opts }); return reaction(symbol, opts); },
    publicStatus: () => status(), close: () => { closed++; } };
  const runtime = createTwelveContextRuntime({ enabled: true, apiKey: KEY, directory: path.resolve("unused-runtime-test"),
    symbols: ["UUUU", "SPY", "USO"], now: () => at,
    providerFactory: () => { created++; return provider; },
    setIntervalImpl: (fn, delay) => { callback = fn; delays.push(delay); return { unref() {} }; },
    clearIntervalImpl: () => { timerCleared++; }, ...overrides });
  t.after(() => runtime.stop());
  return { runtime, calls, evaluations, delays, provider, time: value => { at = value; },
    poll: fn => { poll = fn; }, reaction: fn => { reaction = fn; }, status: fn => { status = fn; },
    tick: () => callback?.(), get closed() { return closed; }, get created() { return created; }, get cleared() { return timerCleared; } };
}
const event = (id, more = {}) => ({ id, publishedAt: new Date(START - 30000).toISOString(), relatedSymbols: ["UUUU"], ...more });
const assessed = () => ({ assessable: true, internalOnly: true, executionEligible: false, movePercent: 9876.54321,
  direction: "up", thresholdReached: true, barMayBeIncomplete: true,
  baselineAt: new Date(START - MINUTE).toISOString(), observedAt: new Date(START).toISOString() });

test("disabled or missing/demo key never constructs provider, schedules, or sends requests", async t => {
  for (const config of [{ enabled: false }, { apiKey: undefined }, { apiKey: "demo" }]) {
    const s = setup(t, config); s.runtime.start(); s.runtime.observeEvents([event("inactive")]); await flush();
    assert.equal(s.created, 0); assert.equal(s.delays.length, 0); assert.equal(s.calls.length, 0);
    assert.equal(s.runtime.getState().eventContext.pending, 0);
    if (config.apiKey !== undefined || Object.hasOwn(config, "apiKey")) assert.equal(s.runtime.getState().configured, false);
  }
});

test("one request allowance per ten-second tick, idempotent start and no overlap", async t => {
  const s = setup(t); let release; s.poll(() => new Promise(resolve => { release = resolve; }));
  s.runtime.start(); s.runtime.start(); await flush(); s.tick(); s.tick();
  assert.equal(s.created, 1); assert.deepEqual(s.delays, [10000]); assert.deepEqual(s.calls, [{ maxRequests: 1 }]);
  assert.equal(s.runtime.getState().overlapSkips, 2); assert.equal(s.runtime.getState().inFlight, true);
  release(); await flush(); s.poll(async () => ({})); s.tick(); await flush();
  assert.deepEqual(s.calls, [{ maxRequests: 1 }, { maxRequests: 1 }]);
});

test("stop clears timer immediately and closes only after the single inflight request", async t => {
  const s = setup(t); let release; s.poll(() => new Promise(resolve => { release = resolve; }));
  s.runtime.start(); await flush(); const stopped = s.runtime.stop();
  s.tick(); s.runtime.start(); assert.equal(s.cleared, 1); assert.equal(s.closed, 0); assert.equal(s.calls.length, 1);
  assert.equal(s.runtime.getState().running, false); release(); await stopped;
  assert.equal(s.closed, 1); assert.equal(s.runtime.getState().inFlight, false);
});

test("stop in the start turn cancels the poll before any request begins", async t => {
  const s = setup(t); s.runtime.start(); await s.runtime.stop();
  assert.equal(s.calls.length, 0); assert.equal(s.closed, 1); assert.equal(s.cleared, 1);
});

test("provider initialization, poll and status failures remain safe and do not escape", async t => {
  const broken = setup(t, { providerFactory() { throw new Error(KEY); } });
  assert.doesNotThrow(() => broken.runtime.start()); assert.equal(broken.runtime.getState().lastError, "runtime_start_failed");
  const s = setup(t); s.poll(async () => { throw Object.assign(new Error(KEY), { safeCode: KEY }); });
  s.runtime.start(); await flush(); assert.equal(s.runtime.getState().lastError, "provider_poll_failed");
  s.status(() => { throw new Error(KEY); }); assert.equal(s.runtime.getState().lastError, "provider_status_failed");
  assert.equal(JSON.stringify(s.runtime.getState()).includes(KEY), false);
});

test("public state projects safe provider fields even when injected provider adds secrets and prices", async t => {
  const s = setup(t); s.status(() => ({ configured: true, source: KEY, secret: KEY, price: 9876.54321, direction: "up",
    freshSymbols: 1, quota: { usedToday: 1, dailyLimit: 600, minuteLimit: 6, scope: KEY, secret: KEY, movePercent: 9876.54321 } }));
  s.runtime.start(); await flush(); const json = JSON.stringify(s.runtime.getState());
  for (const forbidden of [KEY, "9876.54321", '"price"', '"movePercent"', '"direction"', '"secret"']) assert.equal(json.includes(forbidden), false);
  assert.equal(s.runtime.getState().executionEligible, false);
});

test("explicit asset fields and EF aliases map without inventing macro direction proxies", async t => {
  const s = setup(t); s.runtime.start(); await flush();
  s.runtime.observeEvents([
    event("assets", { relatedSymbols: [], affectedAssets: ["SPY", { symbol: "USO" }] }),
    event("bias", { relatedSymbols: [], directionalBiases: { SPY: "down", OIL: "up" } }),
    event("ef-title", { relatedSymbols: [], title: "Energy Fuels publishes a statement" }),
    event("ef-ticker", { relatedSymbols: [], summary: "New UUUU disclosure" }),
    event("macro", { relatedSymbols: [], title: "Oil supply tightens as interest rates fall" })
  ]);
  s.tick(); await flush();
  assert.deepEqual(s.evaluations.map(v => v.symbol), ["SPY", "USO", "SPY", "UUUU", "UUUU"]);
  assert.equal(s.runtime.getState().eventContext.ignoredNoSymbols, 1);
});

test("published time is authoritative; detected fallback only when source time is missing", async t => {
  const s = setup(t); s.runtime.start(); await flush();
  s.runtime.observeEvents([
    event("source", { detectedAt: new Date(START).toISOString() }),
    event("detected", { publishedAt: null, detectedAt: new Date(START - 10000).toISOString() }),
    event("invalid-source", { publishedAt: "invalid", detectedAt: new Date(START).toISOString() }),
    event("missing-both", { publishedAt: null }),
    event("ambiguous-zone", { publishedAt: "2026-11-05 15:00:00" }),
    event("future", { publishedAt: new Date(START + MINUTE).toISOString() })
  ]);
  s.tick(); await flush();
  assert.deepEqual(s.evaluations.map(v => v.eventTime), [START - 30000, START - 10000]);
  assert.equal(s.runtime.getState().eventContext.rejected, 4);
});

test("baseline events and duplicates do not become repeated work, source-time revisions remain distinct", async t => {
  const s = setup(t); s.runtime.observeEvents([event("baseline", { baseline: true }), event("same"), event("same"),
    event("same", { publishedAt: new Date(START - 10000).toISOString() })]);
  let state = s.runtime.getState().eventContext; assert.equal(state.pending, 2); assert.equal(state.duplicates, 1); assert.equal(state.ignoredBaseline, 1);
  s.reaction(assessed); s.runtime.start(); await flush();
  state = s.runtime.getState().eventContext; assert.equal(state.completed, 2); assert.equal(state.storedResults, 2);
  s.runtime.observeEvents([event("same")]); assert.equal(s.runtime.getState().eventContext.pending, 0);
});

test("later explicit symbol enrichment receives an assessment without repeating completed symbols", async t => {
  const s = setup(t); s.reaction(assessed); s.runtime.observeEvents([event("enriched")]); s.runtime.start(); await flush();
  assert.equal(s.runtime.getState().eventContext.completed, 1);
  s.runtime.observeEvents([event("enriched", { relatedSymbols: ["SPY"] })]);
  assert.equal(s.runtime.getState().eventContext.pending, 1); s.tick(); await flush();
  assert.deepEqual(s.evaluations.map(v => v.symbol), ["UUUU", "SPY"]);
  assert.equal(s.runtime.getState().eventContext.completed, 1); assert.equal(s.runtime.getState().eventContext.storedResults, 1);
});

test("pending capacity and expiration are explicit; internal assessments never escape public state", async t => {
  const s = setup(t); s.runtime.observeEvents(Array.from({ length: 105 }, (_, i) => event(`secret-event-${i}`, { title: KEY })));
  assert.equal(s.runtime.getState().eventContext.pending, 100); assert.equal(s.runtime.getState().eventContext.capacityDropped, 5);
  s.reaction(assessed); s.runtime.start(); await flush();
  let state = s.runtime.getState(); assert.equal(state.eventContext.pending, 0); assert.equal(state.eventContext.storedResults, 100);
  const json = JSON.stringify(state); for (const forbidden of [KEY, "secret-event", "9876.54321", '"direction"', '"thresholdReached"']) assert.equal(json.includes(forbidden), false);
  s.runtime.observeEvents(Array.from({ length: 10 }, (_, i) => event(`next-${i}`))); s.tick(); await flush();
  assert.equal(s.runtime.getState().eventContext.storedResults, 100);
  s.reaction(() => ({ assessable: false })); s.runtime.observeEvents([event("will-expire")]);
  s.time(START + 31 * MINUTE); s.tick(); await flush();
  state = s.runtime.getState(); assert.equal(state.eventContext.pending, 0); assert.equal(state.eventContext.storedResults, 0); assert.equal(state.eventContext.expired, 1);
});

test("evaluation failures stay pending and private, unsafe trade-capable results are rejected", async t => {
  const s = setup(t); s.runtime.observeEvents([event("one"), event("two")]);
  s.reaction(() => { throw new Error(KEY); }); s.runtime.start(); await flush();
  assert.equal(s.runtime.getState().eventContext.evaluationFailures, 2); assert.equal(s.runtime.getState().eventContext.pending, 2);
  s.reaction(() => ({ ...assessed(), executionEligible: true })); s.tick(); await flush();
  assert.equal(s.runtime.getState().eventContext.completed, 0);
  s.reaction(assessed); s.tick(); await flush(); assert.equal(s.runtime.getState().eventContext.completed, 2);
  assert.equal(JSON.stringify(s.runtime.getState()).includes(KEY), false);
});

test("stop and fresh runtime expose the deliberate ephemeral event-context boundary", async t => {
  const s = setup(t); s.runtime.observeEvents([event("one")]); assert.equal(s.runtime.getState().eventContext.pending, 1);
  await s.runtime.stop(); assert.equal(s.runtime.getState().eventContext.pending, 0);
  const second = setup(t); assert.equal(second.runtime.getState().eventContext.accepted, 0);
  assert.equal(second.runtime.getState().eventContext.storage, "bounded-memory-reset-on-restart");
});

test("real provider integration evaluates only a fresh bracketing event after a later poll", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twelve-runtime-integration-"));
  let at = START, callback, fetches = 0;
  const runtime = createTwelveContextRuntime({ enabled: true, apiKey: KEY, directory, symbols: ["UUUU"], now: () => at,
    providerFactory: options => createTwelveBasicContext({ ...options, fetchImpl: async () => {
      fetches++; const bar = Math.floor(at / MINUTE) * MINUTE;
      return new Response(JSON.stringify({ status: "ok", meta: { symbol: "UUUU", currency: "USD", type: "Common Stock", exchange: "NYSE American", interval: "1min" },
        values: [{ datetime: new Date(bar).toISOString().slice(0, 19).replace("T", " "), close: fetches === 1 ? "100" : "102" }] }));
    } }), setIntervalImpl: fn => { callback = fn; return 1; }, clearIntervalImpl() {} });
  t.after(async () => { await runtime.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  runtime.start(); await flush();
  at = START + 2 * MINUTE; runtime.observeEvents([event("real", { publishedAt: new Date(at).toISOString() })]); callback(); await flush();
  assert.equal(fetches, 1); assert.equal(runtime.getState().eventContext.completed, 0);
  at = START + 5 * MINUTE; callback(); await flush();
  assert.equal(fetches, 2); assert.equal(runtime.getState().eventContext.completed, 1);
  assert.equal(runtime.getState().executionEligible, false); assert.equal(JSON.stringify(runtime.getState()).includes('"movePercent"'), false);
});
