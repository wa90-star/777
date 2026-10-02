const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createStructural = require("../structural-intelligence-v1");

const {
  THEMES,
  classifyStructuralItem,
  parseWatchlist,
  rssItems,
  sourceGroup
} = createStructural._test;

const memory = THEMES.find((item) => item.id === "memory");

test("structural watchlist is unique, validated and capped at eight symbols", () => {
  assert.deepEqual(parseWatchlist("MU,UUUU,mu,MP,INTC,AAPL,MSFT,NVDA,AMD,INVALID-$"), [
    "MU", "UUUU", "MP", "INTC", "AAPL", "MSFT", "NVDA", "AMD"
  ]);
});

test("structural RSS parser preserves publisher identity", () => {
  const xml = "<rss><channel><item><title>CXMT enters mass production</title><link>https://example.test/a</link>" +
    "<pubDate>Wed, 30 Sep 2026 12:00:00 GMT</pubDate><source>Reuters</source>" +
    "<description>DRAM capacity expansion</description></item></channel></rss>";
  assert.deepEqual(rssItems(xml), [{
    title: "CXMT enters mass production",
    url: "https://example.test/a",
    publishedAt: "Wed, 30 Sep 2026 12:00:00 GMT",
    description: "DRAM capacity expansion",
    publisher: "Reuters"
  }]);
  assert.equal(sourceGroup("Reuters News"), "reuters");
});

test("CXMT capacity progress creates a Micron SHORT hypothesis but never a direct alert", () => {
  const item = classifyStructuralItem({
    title: "CXMT enters mass production with fifth-generation DRAM platform",
    description: "The new process raises dies per wafer by 50% and creates an additional source of supply for memory chips.",
    publisher: "Reuters",
    url: "https://example.test/cxmt",
    publishedAt: "2026-09-20T00:00:00Z"
  }, memory, ["MU"]);

  assert.ok(item);
  assert.ok(item.eventTypes.includes("supply_expansion"));
  assert.equal(item.directionalBiases.MU, "SHORT");
  assert.equal(item.hypothesisOnly, true);
  assert.equal(item.requiresIndependentConfirmation, true);
  assert.equal(item.directTelegramAlerts, false);
  assert.ok(item.score >= 70);
});

test("ordinary DDR5 commentary without a structural mechanism is rejected", () => {
  assert.equal(classifyStructuralItem({
    title: "DDR5 prices discussed by PC builders",
    description: "Users compare kits and RGB designs.",
    publisher: "Example",
    url: "https://example.test/noise"
  }, memory, ["MU"]), null);
});

test("two independent publisher groups are required before structural promotion", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radar-structural-"));
  const oldDir = process.env.RADAR_DATA_DIR;
  process.env.RADAR_DATA_DIR = dir;
  t.after(() => {
    if (oldDir === undefined) delete process.env.RADAR_DATA_DIR;
    else process.env.RADAR_DATA_DIR = oldDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const callbacks = [];
  const engine = createStructural({ onFreshRelevant: async (items) => callbacks.push(...items) });

  const makeItem = (publisher, url) => ({
    title: "CXMT DRAM mass production expands capacity",
    description: "New technology platform increases dies per wafer by 50%.",
    publisher,
    url,
    publishedAt: new Date().toISOString()
  });

  await engine.acceptTheme(memory, [makeItem("Publisher A", "https://a.test/1")]);
  assert.equal(callbacks.length, 0, "first scan establishes a quiet baseline");

  await engine.acceptTheme(memory, [makeItem("Publisher B", "https://b.test/2")]);
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].directionalBiases.MU, "SHORT");
  assert.equal(callbacks[0].independentSourceCount, 2);
  assert.equal(callbacks[0].directTelegramAlerts, false);

  await engine.acceptTheme(memory, [makeItem("Publisher C", "https://c.test/3")]);
  assert.equal(callbacks.length, 1, "one structural cluster promotes only once");
});
