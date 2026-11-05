const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createStructural = require("../structural-intelligence-v1");
const createEquity = require("../equity-structural-v1");
const createCatalyst = require("../catalyst-v4");
const createHandoff = require("../energy-fuels-handoff-v1");
const { signalOwnership, energyFuelsContext, isEnergyFuelsSpecific } = require("../signal-ownership-v1");

test("Energy Fuels aliases share one owner without blocking unrelated symbols", () => {
  for (const symbol of ["UUUU", "efr", " EF2 ", "EFR.TO", "EF2.F", "NYSEAMERICAN:UUUU"]) {
    assert.equal(signalOwnership(symbol).owner, "energy-fuels-fokus");
    assert.equal(signalOwnership(symbol).directAlertAllowed, false);
  }
  for (const symbol of ["MU", "MP", "INTC", "UEC", "GLD", "UUU"]) {
    assert.equal(signalOwnership(symbol).directAlertAllowed, true);
  }
});

test("actual equity dispatch blocks all EF aliases but sends eligible MU once", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radar-ef-equity-"));
  const handoff = createHandoff({ dataDir: dir });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.parse("2026-11-05T16:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now });
  const oldKey = process.env.APCA_API_KEY_ID;
  const oldSecret = process.env.APCA_API_SECRET_KEY;
  process.env.APCA_API_KEY_ID = "offline-test-key";
  process.env.APCA_API_SECRET_KEY = "offline-test-secret";
  t.after(() => {
    if (oldKey === undefined) delete process.env.APCA_API_KEY_ID; else process.env.APCA_API_KEY_ID = oldKey;
    if (oldSecret === undefined) delete process.env.APCA_API_SECRET_KEY; else process.env.APCA_API_SECRET_KEY = oldSecret;
  });
  const symbols = ["UUUU", "EFR", "EF2", "MU"];
  const quote = {
    latestTrade: { p: 11, t: new Date(now).toISOString() },
    latestQuote: { bp: 10.99, ap: 11.01, t: new Date(now).toISOString() },
    dailyBar: { c: 11 }, prevDailyBar: { c: 10 }
  };
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () =>
    Object.fromEntries(symbols.map((symbol) => [symbol, quote])) }));
  const messages = [];
  const journal = [];
  const engine = createEquity({
    energyFuelsHandoff: handoff,
    watchlist: symbols,
    telegramConfigured: () => true,
    sendMessage: async (text) => { messages.push(text); return { message_id: 123 }; },
    onSignalAlert: (entry) => journal.push(entry),
    getStructuralState: () => ({ verified: [{
      id: "fixture:independent-event", baseline: false, verifiedAt: new Date(now).toISOString(),
      score: 95, title: "synthetic fixture", independentSourceCount: 2,
      directionalBiases: Object.fromEntries(symbols.map((symbol) => [symbol, "LONG"]))
    }] })
  });
  const handoffFile = path.join(dir, "energy-fuels-handoff.jsonl");
  fs.mkdirSync(handoffFile); // Simulate a real storage failure on the handoff only.
  await engine.run(true); // Existing quiet startup baseline.
  await engine.run(true);
  assert.match(engine.getState().lastHandoffError, /could not be persisted/);
  assert.equal(handoff.getState().pendingCount, 0);
  fs.rmdirSync(handoffFile);
  await engine.run(true); // Existing cooldown still applies to non-EF symbols.
  assert.equal(messages.length, 1);
  assert.match(messages[0], /\(MU\)/);
  assert.deepEqual(journal.map((entry) => entry.signal.symbol), ["MU"]);
  assert.equal(handoff.getState().pendingCount, 1, "aliases share one durable event");
  assert.equal(engine.getState().lastHandoffError, null);
  for (const signal of engine.getState().signals.filter((signal) => signal.symbol !== "MU")) {
    assert.equal(signal.marketConfirmed, true);
    assert.equal(signal.executionQuality.plausible, true);
    assert.equal(signal.alertRouting.mode, "context-only");
  }
  // Check a second engine too: the ownership guarantee does not depend on RAM dedupe.
  const restarted = createEquity({
    energyFuelsHandoff: createHandoff({ dataDir: dir }),
    watchlist: symbols, telegramConfigured: () => true,
    sendMessage: async (text) => { assert.doesNotMatch(text, /\((UUUU|EFR|EF2)\)/); return { message_id: 124 }; },
    getStructuralState: () => ({ verified: [{
      id: "fixture:new-event", verifiedAt: new Date(now).toISOString(), score: 100,
      independentSourceCount: 3, directionalBiases: { UUUU: "LONG", EFR: "LONG", EF2: "LONG" }
    }] })
  });
  await restarted.run(true);
  await restarted.run(true);
  assert.equal(handoff.getState().pendingCount, 2, "new event remains available after restart");
});

test("EF discovery survives restart and remains available without quote or trade approval", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radar-ef-context-"));
  const oldDir = process.env.RADAR_DATA_DIR;
  process.env.RADAR_DATA_DIR = dir;
  t.after(() => {
    if (oldDir === undefined) delete process.env.RADAR_DATA_DIR; else process.env.RADAR_DATA_DIR = oldDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const theme = createStructural._test.THEMES.find((entry) => entry.id === "critical-minerals");
  const engine = createStructural();
  await engine.acceptTheme(theme, [{
    title: "Energy Fuels rare earth commercial production increases capacity",
    description: "White Mesa capacity expansion of 25%.",
    publisher: "Fixture publisher", url: "https://example.test/ef-event",
    publishedAt: new Date().toISOString()
  }]);
  const restarted = createStructural();
  const context = energyFuelsContext(restarted.getState(), { signals: [], lastError: "fixture quote unavailable" });
  assert.equal(context.discoveries.length, 1);
  assert.equal(context.discoveries[0].url, "https://example.test/ef-event");
  assert.equal(context.discoveries[0].baseline, true, "historical baseline is preserved");
  assert.equal(context.discoveries[0].sourceClass, "secondary-discovery");
  assert.equal(context.discoveries[0].tradeDecisionAllowed, false);
  assert.equal(context.confirmedClusters.length, 0);
  assert.equal(context.ownerReadConfirmed, false);
  assert.equal(context.deliveryConfirmed, false);
  assert.equal(context.marketError, "fixture quote unavailable");
});

test("context preserves collector identity, excludes unrelated themes, and does not duplicate IDs", () => {
  const event = { id: "existing:collector-id", theme: "critical-minerals", publishedAt: null, baseline: false };
  const context = energyFuelsContext({ items: [event, event, { id: "memory:1", theme: "memory" }] });
  assert.equal(context.discoveries.length, 1);
  assert.equal(context.discoveries[0].id, event.id);
  assert.equal(context.discoveries[0].publishedAt, null);
  assert.equal(context.deliveryConfirmed, false);
});

test("policy outbox retains explicit EF news for its owner while other alerts and market checks continue", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radar-ef-policy-"));
  const oldDir = process.env.RADAR_DATA_DIR;
  process.env.RADAR_DATA_DIR = dir;
  t.after(() => {
    if (oldDir === undefined) delete process.env.RADAR_DATA_DIR; else process.env.RADAR_DATA_DIR = oldDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let titles = ["Emergency oil sanctions baseline"];
  t.mock.method(globalThis, "fetch", async () => new Response("<rss><channel>" + titles.map((title, i) =>
    `<item><title>${title}</title><link>https://example.test/${i}</link><pubDate>${new Date().toUTCString()}</pubDate></item>`
  ).join("") + "</channel></rss>"));
  let enabled = false;
  const messages = [], rechecks = [];
  const options = { telegramConfigured: () => enabled,
    energyFuelsHandoff: createHandoff({ dataDir: dir }),
    sendMessage: async (text) => { messages.push(text); return { message_id: 42 }; },
    onFreshRelevant: async (items) => rechecks.push(...items) };
  let engine = createCatalyst(options);
  await engine.scanWhiteHouse();
  titles.push("Energy Fuels receives uranium export restriction emergency order", "Emergency oil sanctions new measure");
  await engine.scanWhiteHouse();
  assert.equal(messages.length, 0);
  assert.equal(rechecks.length, 2);
  // Both telegram deliveries are pending on disk when the engine restarts.
  engine = createCatalyst(options);
  enabled = true;
  await engine.drainDeliveries();
  assert.equal(messages.length, 1);
  assert.doesNotMatch(messages[0], /Energy Fuels/);
  assert.equal(engine.getState().deliveryStatus.suppressed, 1);
  assert.equal(createHandoff({ dataDir: dir }).getState().pendingCount, 1);
  const context = energyFuelsContext({}, {}, engine.getState());
  assert.equal(context.policyDiscoveries.length, 1);
  assert.match(context.policyDiscoveries[0].title, /Energy Fuels/);
  assert.equal(context.deliveryConfirmed, false);
  engine = createCatalyst(options);
  await engine.drainDeliveries();
  assert.equal(messages.length, 1, "suppression and delivery survive restart");
});

test("broad policy alerts with incidental EF mentions remain general-market messages", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radar-ef-broad-"));
  const oldDir = process.env.RADAR_DATA_DIR;
  process.env.RADAR_DATA_DIR = dir;
  t.after(() => {
    if (oldDir === undefined) delete process.env.RADAR_DATA_DIR; else process.env.RADAR_DATA_DIR = oldDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const broadTitles = [
    "China expands rare earth export restrictions; affected companies include Energy Fuels and MP Materials",
    "Emergency oil sanctions on Iran; Energy Fuels among mentioned companies",
    "Federal Reserve announces rate cut; Energy Fuels reacts",
    "Energy Fuels reports on oil sanctions on Iran"
  ];
  for (const title of broadTitles.slice(0, 3)) assert.equal(isEnergyFuelsSpecific({ title }), false);
  assert.equal(isEnergyFuelsSpecific({ title: "Energy Fuels announces uranium project", impactedSymbols: ["UUUU", "MP"] }), false);
  assert.equal(isEnergyFuelsSpecific({ title: "Oil sanctions", description: "Energy Fuels reports uranium expansion" }), false);
  let titles = ["Emergency oil baseline"];
  t.mock.method(globalThis, "fetch", async () => new Response("<rss><channel>" + titles.map((title, i) =>
    `<item><title>${title}</title><link>https://example.test/broad/${i}</link><pubDate>${new Date().toUTCString()}</pubDate></item>`
  ).join("") + "</channel></rss>"));
  const messages = [];
  const handoff = createHandoff({ dataDir: dir });
  const engine = createCatalyst({ telegramConfigured: () => true, energyFuelsHandoff: handoff,
    sendMessage: async (text) => { messages.push(text); return { message_id: messages.length }; } });
  await engine.scanWhiteHouse();
  titles.push(...broadTitles);
  await engine.scanWhiteHouse();
  await engine.drainDeliveries();
  assert.equal(messages.length, 4);
  assert.equal(engine.getState().deliveryStatus.suppressed, 0);
  assert.equal(handoff.getState().pendingCount, 0);
  assert.equal(energyFuelsContext({}, {}, engine.getState()).policyDiscoveries.length, 4);
});
