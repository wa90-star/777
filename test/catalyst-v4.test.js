const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const createCatalystEngine = require("../catalyst-v4");
const { normalizeOfficialTrumpPosts, normalizeTrumpFmPosts } = createCatalystEngine._test;

test("normalizes the official Truth Social response", () => {
  const items = normalizeOfficialTrumpPosts([{
    id: "123",
    content: "<p>Oil &amp; OPEC update</p>",
    url: "https://truthsocial.com/@realDonaldTrump/123",
    created_at: "2026-04-07T20:14:40.936Z"
  }]);

  assert.deepEqual(items, [{
    id: "truth:123",
    source: "Donald Trump · Truth Social official",
    title: "Oil & OPEC update",
    text: "Oil & OPEC update",
    url: "https://truthsocial.com/@realDonaldTrump/123",
    publishedAt: "2026-04-07T20:14:40.936Z"
  }]);
});

test("validates and normalizes public archive posts", () => {
  const items = normalizeTrumpFmPosts({ data: [{
    id: "ts_123",
    platformId: "123",
    platform: "truth",
    content: "Crude oil",
    createdAt: "2026-04-07T20:14:40.936Z",
    checksum: "sha256:abc"
  }] });

  assert.equal(items[0].id, "truth:123");
  assert.equal(items[0].source, "Donald Trump · Truth Social public archive (trump.fm)");
  assert.equal(items[0].url, "https://truthsocial.com/@realDonaldTrump/123");
  assert.equal(items[0].sourceClass, "public-archive");
  assert.equal(items[0].requiresIndependentConfirmation, true);
  assert.equal(items[0].archiveChecksum, "sha256:abc");
});

test("uses repost text while preserving the repost wrapper id and time", () => {
  const items = normalizeTrumpFmPosts({ data: [{
    id: "ts_789",
    platformId: "789",
    platform: "truth",
    content: "@someone",
    createdAt: "2026-09-17T12:00:00Z",
    checksum: "sha256:def",
    isRepost: true,
    repostOf: {
      id: "ts_456",
      platformId: "456",
      platform: "truth",
      content: "OPEC statement",
      createdAt: "2026-09-16T12:00:00Z",
      checksum: "sha256:ghi"
    }
  }] });

  assert.equal(items[0].id, "truth:789");
  assert.equal(items[0].title, "OPEC statement");
  assert.equal(items[0].publishedAt, "2026-09-17T12:00:00.000Z");
});

test("rejects archive rows with a wrong platform, invalid id or timestamp", () => {
  const items = normalizeTrumpFmPosts({ data: [
    { id: "123", platform: "x", content: "Oil", createdAt: "2026-04-07T20:14:40.936Z", checksum: "a" },
    { id: "not-a-truth-id", platform: "truth", content: "Oil", createdAt: "2026-04-07T20:14:40.936Z", checksum: "b" },
    { id: "456", platform: "truth", content: "Oil", createdAt: "not-a-date", checksum: "c" },
    { id: "789", platform: "truth", content: "Oil", createdAt: "2026-04-07T20:14:40.936Z" }
  ] });

  assert.deepEqual(items, []);
});

test("uses the repost time while reading the original reposted text", () => {
  const items = normalizeOfficialTrumpPosts([{
    id: "wrapper-9",
    content: "",
    url: "https://truthsocial.com/@realDonaldTrump/wrapper-9",
    created_at: "2026-09-17T12:00:00Z",
    reblog: {
      id: "original-1",
      content: "<p>OPEC statement</p>",
      created_at: "2026-09-16T12:00:00Z"
    }
  }]);

  assert.equal(items[0].id, "truth:wrapper-9");
  assert.equal(items[0].title, "OPEC statement");
  assert.equal(items[0].publishedAt, "2026-09-17T12:00:00Z");
});

test("public archive posts require confirmation and never send direct Telegram alerts", async () => {
  const originalFetch = global.fetch;
  const originalDataDir = process.env.RADAR_DATA_DIR;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "radar-catalyst-test-"));
  process.env.RADAR_DATA_DIR = dataDir;
  let call = 0;
  let telegramMessages = 0;
  let freshRelevant = 0;
  let recordedPosts = 0;
  const createdAt = new Date().toISOString();

  global.fetch = async () => {
    call += 1;
    const data = call === 1
      ? [{ id: "ts_111111111111111111", platformId: "111111111111111111", platform: "truth", content: "Oil and OPEC", createdAt, checksum: "first" }]
      : [
          { id: "ts_222222222222222222", platformId: "222222222222222222", platform: "truth", content: "Oil sanctions and OPEC", createdAt, checksum: "second" },
          { id: "ts_111111111111111111", platformId: "111111111111111111", platform: "truth", content: "Oil and OPEC", createdAt, checksum: "first" }
        ];
    return new Response(JSON.stringify({ data }), { status: 200 });
  };

  try {
    const engine = createCatalystEngine({
      sendMessage: async () => { telegramMessages += 1; },
      telegramConfigured: () => true,
      onFreshRelevant: (items) => { freshRelevant += items.length; },
      onTrumpPost: async () => { recordedPosts += 1; }
    });
    await engine.scanTrump();
    await engine.scanTrump();

    assert.equal(telegramMessages, 0);
    assert.equal(freshRelevant, 1);
    assert.equal(recordedPosts, 1);
    assert.deepEqual(engine.getState().sources.trumpTruth, {
      ok: true,
      lastScanAt: engine.getState().sources.trumpTruth.lastScanAt,
      error: null,
      endpoint: "trump.fm-public-api",
      provider: "trump.fm",
      sourceClass: "public-archive",
      officialAutomationAccess: "licensed-only",
      verification: "truth-id+canonical-url+utc-timestamp+checksum",
      requiresIndependentConfirmation: true,
      directTelegramAlerts: false,
      warning: null
    });
  } finally {
    global.fetch = originalFetch;
    if (originalDataDir === undefined) delete process.env.RADAR_DATA_DIR;
    else process.env.RADAR_DATA_DIR = originalDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
