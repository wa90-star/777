const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createTrumpOilMonitor = require("../trump-oil-monitor-v1");

function fakeProviderFactory(control) {
  return ({ onEvent, onStatus }) => {
    control.emit = onEvent;
    const providerState = {
      configured: true,
      connection: "connected",
      authenticated: true,
      contracts: {
        CL: { productCode: "CL", ticker: "CLX6" },
        BZ: { productCode: "BZ", ticker: "BZX6" }
      },
      ...(control.providerState || {})
    };
    return {
      start: async () => onStatus(providerState),
      stop: () => {},
      aggregates: async (ticker, params) => {
        control.aggregateCalls ||= [];
        control.aggregateCalls.push({ ticker, params });
        return { results: [] };
      },
      getState: () => providerState
    };
  };
}

test("requests historical aggregates with documented nanosecond timestamps", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oil-history-range-test-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const control = {};
  const clock = Date.parse("2026-09-01T12:00:00Z");
  const monitor = createTrumpOilMonitor({
    sendMessage: async () => {},
    telegramConfigured: () => false,
    getPublicCatalysts: () => ({ items: [] }),
    dataDir: tempDir,
    now: () => clock,
    providerFactory: fakeProviderFactory(control)
  });

  await monitor.bootstrapHistory();
  assert.equal(control.aggregateCalls.length, 2);
  for (const call of control.aggregateCalls) {
    assert.match(call.params.from, /^\d{19}$/);
    assert.match(call.params.to, /^\d{19}$/);
    assert.equal(BigInt(call.params.to) > BigInt(call.params.from), true);
  }
  monitor.stop();
});

function emitNormalMinute(control, start, index) {
  const bid = 70 + ((index % 7) - 3) * 0.002;
  const ask = bid + 0.02;
  const bidSize = 90 + (index % 13);
  const askSize = 91 + ((index * 3) % 13);
  control.emit({ type: "quote", productCode: "CL", ticker: "CLX6", bid, ask, bidSize, askSize, timestamp: start + 1000 });
  control.emit({ type: "quote", productCode: "CL", ticker: "CLX6", bid, ask, bidSize: bidSize + (index % 3) - 1, askSize: askSize + ((index + 1) % 3) - 1, timestamp: start + 2000 });
  const trades = 5 + (index % 5);
  for (let i = 0; i < trades; i += 1) {
    const buy = (i + index) % 2 === 0;
    control.emit({
      type: "trade",
      productCode: "CL",
      ticker: "CLX6",
      price: buy ? ask : bid,
      size: 1 + ((i + index) % 3),
      timestamp: start + 3000 + i
    });
  }
}

function syntheticFeatures(productCode, eventAt, close = 70) {
  return {
    start: eventAt - 60000,
    end: eventAt,
    ticker: productCode === "CL" ? "CLX6" : "BZX6",
    open: close - 0.02,
    high: close + 0.01,
    low: close - 0.03,
    close,
    returnBps: 5,
    rangeBps: 8,
    volume: 1000,
    tradeCount: 500,
    quoteCount: 800,
    imbalance: 0.8,
    ofiPerQuote: 25,
    spreadBps: 1,
    historical: false
  };
}

function syntheticScore(direction = "LONG", composite = 5) {
  return {
    z: { returnZ: 4, rangeZ: 3, volumeZ: 4, tradeCountZ: 4, imbalanceZ: 5, ofiZ: 5, spreadZ: 1 },
    priceBaseline: 300,
    microBaseline: 180,
    composite,
    agreement: 3,
    direction,
    microExtreme: true,
    activityExtreme: true,
    qualified: true
  };
}

test("detects unexplained directional flow and links a later Trump oil post", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oil-monitor-test-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const messages = [];
  const control = {};
  let clock = Date.parse("2026-09-01T12:00:00Z");
  const monitor = createTrumpOilMonitor({
    sendMessage: async (text) => messages.push(text),
    telegramConfigured: () => true,
    getPublicCatalysts: () => ({ items: [] }),
    dataDir: tempDir,
    now: () => clock,
    providerFactory: fakeProviderFactory(control)
  });
  await monitor.start();

  for (let minute = 0; minute < 280; minute += 1) {
    clock = Date.parse("2026-09-01T12:00:00Z") + minute * 60000;
    emitNormalMinute(control, clock, minute);
  }

  const anomalyStart = Date.parse("2026-09-01T12:00:00Z") + 280 * 60000;
  clock = anomalyStart;
  control.emit({ type: "quote", productCode: "CL", ticker: "CLX6", bid: 69.98, ask: 70, bidSize: 120, askSize: 25, timestamp: clock + 1000 });
  for (let step = 0; step < 20; step += 1) {
    const price = 69.98 - step * 0.025;
    control.emit({ type: "quote", productCode: "CL", ticker: "CLX6", bid: price - 0.02, ask: price, bidSize: 5, askSize: 180 + step * 10, timestamp: clock + 2000 + step * 100 });
    for (let trade = 0; trade < 8; trade += 1) {
      control.emit({ type: "trade", productCode: "CL", ticker: "CLX6", price: price - 0.02, size: 20, timestamp: clock + 3000 + step * 100 + trade });
    }
  }

  clock = anomalyStart + 60000;
  emitNormalMinute(control, clock, 281);
  await new Promise((resolve) => setImmediate(resolve));
  const state = monitor.getState();
  assert.ok(state.anomalies.length >= 1, "expected an anomaly");
  assert.equal(state.products.CL.alertReadiness.armed, true);
  assert.equal(state.anomalies[0].direction, "SHORT");
  assert.match(messages.join("\n"), /UNERKLÄRTE ORDERFLOW-ANOMALIE/);

  const postTime = anomalyStart + 10 * 60000;
  clock = postTime;
  await monitor.recordTrumpPost({
    id: "truth-oil-test",
    source: "Donald Trump · Truth Social",
    title: "Oil prices and Iran will be addressed immediately.",
    text: "Oil prices and Iran will be addressed immediately.",
    url: "https://example.invalid/truth-oil-test",
    publishedAt: new Date(postTime).toISOString(),
    detectedAt: new Date(postTime).toISOString(),
    keywordHits: ["oil", "iran"]
  });
  assert.match(messages.join("\n"), /TRUMP-ÖL-EREIGNIS BESTÄTIGT/);
  assert.equal(monitor.getState().metrics.confirmedPostLinks >= 1, true);
  monitor.stop();
});

test("clusters repeated bars into one incident and only escalates once across markets", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oil-incident-test-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const messages = [];
  const control = {};
  let clock = Date.parse("2026-09-02T12:00:00Z");
  const monitor = createTrumpOilMonitor({
    sendMessage: async (text) => messages.push(text),
    telegramConfigured: () => true,
    getPublicCatalysts: () => ({ items: [] }),
    dataDir: tempDir,
    now: () => clock,
    providerFactory: fakeProviderFactory(control)
  });

  monitor._test.recordAnomaly(monitor._test.state.products.CL, syntheticFeatures("CL", clock), syntheticScore("LONG", 5));
  await new Promise((resolve) => setImmediate(resolve));
  clock += 5 * 60000;
  monitor._test.recordAnomaly(monitor._test.state.products.CL, syntheticFeatures("CL", clock, 70.1), syntheticScore("LONG", 6));
  await new Promise((resolve) => setImmediate(resolve));
  clock += 5 * 60000;
  monitor._test.recordAnomaly(monitor._test.state.products.BZ, syntheticFeatures("BZ", clock, 73), syntheticScore("LONG", 5.5));
  await new Promise((resolve) => setImmediate(resolve));
  clock += 60000;
  monitor._test.recordAnomaly(monitor._test.state.products.BZ, syntheticFeatures("BZ", clock, 73.05), syntheticScore("LONG", 5.8));
  await new Promise((resolve) => setImmediate(resolve));

  const state = monitor.getState();
  assert.equal(state.incidents.length, 1);
  assert.deepEqual(state.incidents[0].productCodes.sort(), ["BZ", "CL"]);
  assert.equal(state.incidents[0].anomalyIds.length, 4);
  assert.equal(messages.filter((message) => /TRUMP-ÖL-FLOWALARM/.test(message)).length, 1);
  assert.equal(messages.filter((message) => /MARKTÜBERGREIFENDE ÖL-ANOMALIE/.test(message)).length, 1);
  assert.equal(state.metrics.duplicateAnomaliesSuppressed, 2);
  assert.equal(state.metrics.crossMarketConfirmations, 1);
  monitor.stop();

  const reloaded = createTrumpOilMonitor({
    sendMessage: async () => {},
    telegramConfigured: () => false,
    getPublicCatalysts: () => ({ items: [] }),
    dataDir: tempDir,
    now: () => clock,
    providerFactory: fakeProviderFactory({})
  });
  assert.equal(reloaded.getState().incidents.length, 1);
  assert.equal(reloaded.getState().incidents[0].anomalyIds.length, 4);
  reloaded.stop();
});

test("records incident outcomes without counting every anomalous bar as a new sample", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oil-outcome-test-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const control = {};
  let clock = Date.parse("2026-09-03T12:00:00Z");
  const monitor = createTrumpOilMonitor({
    sendMessage: async () => {},
    telegramConfigured: () => false,
    getPublicCatalysts: () => ({ items: [] }),
    dataDir: tempDir,
    now: () => clock,
    providerFactory: fakeProviderFactory(control)
  });

  const eventAt = clock;
  monitor._test.recordAnomaly(monitor._test.state.products.CL, syntheticFeatures("CL", eventAt, 70), syntheticScore("LONG"));
  monitor._test.recordAnomaly(monitor._test.state.products.CL, syntheticFeatures("CL", eventAt + 60000, 70.02), syntheticScore("LONG"));
  monitor._test.evaluateIncidentOutcomes("CL", syntheticFeatures("CL", eventAt + 30 * 60000, 70.04));
  monitor._test.evaluateIncidentOutcomes("CL", syntheticFeatures("CL", eventAt + 120 * 60000, 69.98));

  const state = monitor.getState();
  assert.equal(state.incidents.length, 1);
  assert.equal(state.calibration.m30.evaluated, 1);
  assert.equal(state.calibration.m30.followThrough, 1);
  assert.equal(state.calibration.m120.evaluated, 1);
  assert.equal(state.calibration.m120.adverse, 1);
  assert.equal(state.calibration.status, "collecting");
  monitor.stop();
});

test("historical aggregate bars never satisfy the live microstructure warm-up", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oil-baseline-test-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const control = {};
  const clock = Date.parse("2026-09-03T12:00:00Z");
  const monitor = createTrumpOilMonitor({
    sendMessage: async () => {},
    telegramConfigured: () => false,
    getPublicCatalysts: () => ({ items: [] }),
    dataDir: tempDir,
    now: () => clock,
    providerFactory: fakeProviderFactory(control)
  });

  for (let minute = 0; minute < 300; minute += 1) {
    monitor._test.seedAggregate("CL", "CLX6", {
      window_start: (clock - (300 - minute) * 60000) * 1e6,
      open: 70,
      high: 70.02,
      low: 69.98,
      close: 70,
      volume: 100,
      transactions: 40
    }, 70);
  }
  for (let minute = 0; minute < 200; minute += 1) {
    monitor._test.state.products.CL.baseline.push({
      ...syntheticFeatures("CL", clock - (600 + minute) * 60000, 69),
      ticker: "CLU6",
      imbalance: 0.1,
      ofiPerQuote: 1
    });
  }
  monitor._test.state.products.CL.ticker = "CLX6";

  const scored = monitor._test.scoreFeatures(monitor._test.state.products.CL, syntheticFeatures("CL", clock, 70.2));
  assert.equal(monitor.getState().products.CL.baselineCounts.total, 300);
  assert.equal(monitor.getState().products.CL.baselineCounts.microstructure, 0);
  assert.equal(monitor.getState().products.CL.baselineCounts.retainedAcrossContracts, 500);
  assert.equal(scored.microBaseline, 0);
  assert.equal(scored.qualified, false);
  monitor.stop();
});

test("marks outcomes across a futures contract roll as invalid", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oil-roll-test-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const clock = Date.parse("2026-09-03T12:00:00Z");
  const monitor = createTrumpOilMonitor({
    sendMessage: async () => {},
    telegramConfigured: () => false,
    getPublicCatalysts: () => ({ items: [] }),
    dataDir: tempDir,
    now: () => clock,
    providerFactory: fakeProviderFactory({})
  });

  monitor._test.recordAnomaly(monitor._test.state.products.CL, syntheticFeatures("CL", clock, 70), syntheticScore("LONG"));
  const rolled = syntheticFeatures("CL", clock + 30 * 60000, 71);
  rolled.ticker = "CLZ6";
  monitor._test.evaluateIncidentOutcomes("CL", rolled);

  const outcome = monitor.getState().incidents[0].outcomes.m30;
  assert.equal(outcome.valid, false);
  assert.equal(outcome.reason, "contract-roll");
  monitor.stop();
});

test("deduplicates several Trump oil posts in the same burst", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oil-post-burst-test-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const messages = [];
  const control = {};
  let clock = Date.parse("2026-09-04T12:00:00Z");
  const monitor = createTrumpOilMonitor({
    sendMessage: async (text) => messages.push(text),
    telegramConfigured: () => true,
    getPublicCatalysts: () => ({ items: [] }),
    dataDir: tempDir,
    now: () => clock,
    providerFactory: fakeProviderFactory(control)
  });

  monitor._test.recordAnomaly(monitor._test.state.products.CL, syntheticFeatures("CL", clock, 70), syntheticScore("SHORT"));
  await new Promise((resolve) => setImmediate(resolve));
  clock += 10 * 60000;
  const first = await monitor.recordTrumpPost({
    id: "truth-burst-1",
    title: "Oil policy update",
    text: "Oil policy update",
    publishedAt: new Date(clock).toISOString()
  });
  clock += 2 * 60000;
  const second = await monitor.recordTrumpPost({
    id: "truth-burst-2",
    title: "More on crude oil",
    text: "More on crude oil",
    publishedAt: new Date(clock).toISOString()
  });
  clock += 29 * 60000;
  const third = await monitor.recordTrumpPost({
    id: "truth-burst-3",
    title: "Another oil statement",
    text: "Another oil statement",
    publishedAt: new Date(clock).toISOString()
  });

  const state = monitor.getState();
  assert.equal(first.linked, 1);
  assert.equal(second.linked, 0);
  assert.equal(first.burstId, second.burstId);
  assert.notEqual(second.burstId, third.burstId);
  assert.equal(state.metrics.confirmedPostLinks, 1);
  assert.equal(messages.filter((message) => /TRUMP-ÖL-EREIGNIS BESTÄTIGT/.test(message)).length, 1);
  monitor.stop();
});

test("labels free IEX proxy incidents and keeps their calibration scope separate", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oil-proxy-scope-test-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const messages = [];
  const clock = Date.parse("2026-09-18T14:00:00Z");
  const control = {
    providerState: {
      provider: "alpaca",
      source: "alpaca-iex-oil-etf-proxy",
      mode: "free-proxy",
      instrumentType: "etf-proxy",
      contracts: {
        CL: { productCode: "CL", ticker: "USO", displayName: "WTI-Proxy (USO ETF)" },
        BZ: { productCode: "BZ", ticker: "BNO", displayName: "Brent-Proxy (BNO ETF)" }
      }
    }
  };
  const monitor = createTrumpOilMonitor({
    sendMessage: async (text) => messages.push(text),
    telegramConfigured: () => true,
    getPublicCatalysts: () => ({ items: [] }),
    dataDir: tempDir,
    now: () => clock,
    providerFactory: fakeProviderFactory(control)
  });
  await monitor.start();

  const features = syntheticFeatures("CL", clock, 80);
  features.ticker = "USO";
  monitor._test.recordAnomaly(monitor._test.state.products.CL, features, syntheticScore("LONG"));
  await new Promise((resolve) => setImmediate(resolve));

  const state = monitor.getState();
  assert.equal(state.dataScope, "free-etf-proxy-iex");
  assert.equal(state.incidents[0].dataScope, "free-etf-proxy-iex");
  assert.equal(state.calibration.dataScope, "free-etf-proxy-iex");
  assert.match(messages.join("\n"), /ÖL-PROXY-FLOWALARM/);
  assert.match(messages.join("\n"), /kein vollständiger WTI-\/Brent-Futures-Orderflow/);
  monitor.stop();
});
