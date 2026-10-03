const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { deflateRawSync, crc32 } = require("node:zlib");
const createHouseDisclosures = require("../house-disclosures-v1");
const { indexText, parseIndex, POLL_MS, DAILY_BUDGET } = createHouseDisclosures._test;

const NAMES = ["Nancy Pelosi", "Marjorie Taylor Greene"];
const COLUMNS = ["Prefix", "Last", "First", "Suffix", "FilingType", "StateDst", "Year", "FilingDate", "DocID"];
const START = Date.parse("2026-10-03T12:34:56.000Z");
function filing(overrides = {}) {
  return { Prefix: "Hon.", Last: "Pelosi", First: "Nancy", Suffix: "", FilingType: "P", StateDst: "CA11", Year: "2026", FilingDate: "10/2/2026", DocID: "20001234", ...overrides };
}
function tsv(rows, columns = COLUMNS) {
  return `${columns.join("\t")}\r\n${rows.map((row) => columns.map((column) => row[column] ?? "").join("\t")).join("\r\n")}\r\n`;
}

// Tiny ZIP fixtures keep the tests independent of network access and external unzip tools.
function zipEntries(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const { name, text, method = 8 } of entries) {
    const nameBytes = Buffer.from(name), plain = Buffer.from(text);
    const compressed = method === 8 ? deflateRawSync(plain) : plain;
    const local = Buffer.alloc(30), directory = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(plain), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(plain.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(crc32(plain), 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(plain.length, 24);
    directory.writeUInt16LE(nameBytes.length, 28);
    directory.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, compressed);
    central.push(directory, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralData = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralData.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralData, end]);
}
function archive(rows, year = 2026, method = 8) {
  return zipEntries([{ name: `${year}FD.txt`, text: tsv(rows), method }]);
}
function response(body, headers = {}) { return new Response(body, { status: 200, headers }); }
function tempDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "house-disclosures-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}
function harness(t, initialTime = START) {
  const dataDir = tempDir(t), calls = [], replies = [];
  let clock = initialTime;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.ok(replies.length, "an unexpected network request was attempted");
    const reply = replies.shift();
    return typeof reply === "function" ? reply(url, options) : reply;
  };
  return { dataDir, calls, replies, now: () => clock,
    advance: (ms = POLL_MS) => { clock += ms; }, setTime: (value) => { clock = Date.parse(value); },
    create: (extra = {}) => createHouseDisclosures({ dataDir, fetchImpl, now: () => clock, ...extra }) };
}

test("only watched members' PTR filings become explicitly unreviewed primary-index records", () => {
  const records = parseIndex(tsv([
    filing(), filing({ First: "Marjorie Taylor", Last: "Greene", DocID: "20001235" }),
    filing({ First: "Other", DocID: "20001236" }),
    filing({ First: "Other", Last: "Greene", DocID: "20001237" }),
    filing({ FilingType: "A", DocID: "20001238" })
  ]), 2026, ["  NANCY   PELOSI ", NAMES[1]]);
  assert.equal(records.length, 2);
  for (const item of records) {
    assert.equal(item.filingDate, "2026-10-02");
    assert.equal(item.publishedAt, null);
    assert.equal(item.transactionDate, null);
    assert.deepEqual(item.symbols, []);
    assert.deepEqual(item.directionalBiases, {});
    assert.equal(item.independentSourceCount, 1);
    assert.equal(item.originKey, item.id);
    assert.equal(item.status, "RESEARCH_ONLY");
    assert.equal(item.requiresDocumentReview, true);
    assert.equal(item.directTelegramAlerts, false);
    assert.equal(item.productionInfluence, false);
    assert.match(item.url, /^https:\/\/disclosures-clerk\.house\.gov\/public_disc\/ptr-pdfs\/2026\/\d+\.pdf$/);
    assert.equal(item.sourceClass, "official-primary-index");
  }
});

test("TSV parsing rejects malformed rows, identities, conflicting duplicates and fabricated dates", () => {
  const cases = [
    [tsv([filing()], COLUMNS.filter((c) => c !== "DocID")), /invalid-index-schema/],
    [tsv([filing()], [...COLUMNS, "DocID"]), /invalid-index-schema/],
    [`${tsv([filing()]).trimEnd()}\textra`, /invalid-index-row/],
    [tsv([filing({ Year: "2025" })]), /invalid-filing-identity/],
    [tsv([filing({ DocID: "..\/fake" })]), /invalid-filing-identity/],
    [tsv([filing({ FilingDate: "" })]), /invalid-filing-date/],
    [tsv([filing({ FilingDate: "2/29/2026" })]), /invalid-filing-date/],
    [tsv([filing({ FilingDate: "13/1/2026" })]), /invalid-filing-date/],
    [tsv([filing({ FilingDate: "2026-10-02T00:00:00Z" })]), /invalid-filing-date/],
    [tsv([filing(), filing({ FilingDate: "10/3/2026" })]), /conflicting-filing-id/]
  ];
  for (const [text, error] of cases) assert.throws(() => parseIndex(text, 2026, NAMES), error);
  assert.equal(parseIndex(tsv([filing(), filing()]), 2026, NAMES).length, 1);
});

test("reads stored and deflated annual TXT entries, ignoring adjacent XML and stripping the BOM", () => {
  for (const method of [0, 8]) {
    const text = tsv([filing()]);
    const zip = zipEntries([{ name: "2026FD.xml", text: "<ignored />" }, { name: "2026FD.txt", text: `\uFEFF${text}`, method }]);
    assert.equal(indexText(zip, 2026), text);
  }
});

test("ZIP parser rejects truncation, corrupt checksums, unsupported compression and unsafe size declarations", () => {
  const valid = archive([filing()]);
  const central = valid.readUInt32LE(valid.length - 6);
  const corrupt = (mutate) => { const copy = Buffer.from(valid); mutate(copy); return copy; };
  const cases = [
    [valid.subarray(0, valid.length - 1), /invalid-zip-directory/],
    [Buffer.alloc(2 * 1024 * 1024 + 1), /archive-size-limit/],
    [corrupt((b) => b.writeUInt32LE(0, central + 16)), /archive-checksum-mismatch/],
    [corrupt((b) => b.writeUInt16LE(99, central + 10)), /unsupported-zip-entry/],
    [corrupt((b) => b.writeUInt16LE(1, central + 8)), /unsupported-zip-entry/],
    [corrupt((b) => b.writeUInt32LE(4 * 1024 * 1024 + 1, central + 24)), /invalid-zip-data/],
    [corrupt((b) => b.writeUInt32LE(valid.length, central + 42)), /invalid-zip-data/],
    [corrupt((b) => b.writeUInt32LE(valid.length, central + 20)), /invalid-zip-data/],
    [zipEntries([{ name: "2026FD.xml", text: "<not-an-index />" }]), /filing-index-missing/]
  ];
  for (const [zip, error] of cases) assert.throws(() => indexText(zip, 2026), error);
});

test("restart preserves baseline, conditional validators, deduplication and first-seen time on revision", async (t) => {
  const h = harness(t);
  h.replies.push(response(archive([filing()]), { etag: '"v1"', "last-modified": "Fri, 02 Oct 2026 18:00:00 GMT" }));
  let monitor = h.create();
  const first = await monitor.scan();
  assert.equal(first.items[0].novelty, "baseline");
  assert.equal(first.items[0].firstSeenAt, new Date(START).toISOString());
  assert.equal(first.items[0].publishedAt, null);
  assert.equal(h.calls[0].options.redirect, "error");
  assert.ok(h.calls[0].options.signal instanceof AbortSignal);

  monitor = h.create();
  await monitor.scan();
  assert.equal(h.calls.length, 1, "the rate reservation survives process restart");
  h.advance();
  h.replies.push(new Response(null, { status: 304 }));
  const unchanged = await monitor.scan();
  assert.deepEqual(unchanged.items, first.items.map((item) => ({ ...item, lastObservedAt: new Date(h.now()).toISOString() })));
  assert.equal(h.calls[1].options.headers["If-None-Match"], '"v1"');
  assert.equal(h.calls[1].options.headers["If-Modified-Since"], "Fri, 02 Oct 2026 18:00:00 GMT");
  assert.equal(unchanged.budget.bytesToday, first.budget.bytesToday);
  assert.equal(unchanged.error, null);

  h.advance();
  h.replies.push(response(archive([filing(), filing({ DocID: "20001235" })]), { etag: '"v2"' }));
  const added = await monitor.scan();
  assert.equal(added.items.length, 2);
  assert.equal(added.items.find((x) => x.documentId === "20001235").novelty, "newly-observed");
  assert.equal(added.items.find((x) => x.documentId === "20001234").novelty, "baseline");

  monitor = h.create();
  h.advance();
  h.replies.push(response(archive([filing({ FilingDate: "10/3/2026" }), filing({ DocID: "20001235" })]), { etag: '"v3"' }));
  const revised = await monitor.scan();
  const item = revised.items.find((x) => x.documentId === "20001234");
  assert.equal(item.novelty, "index-update");
  assert.equal(item.firstSeenAt, first.items[0].firstSeenAt);
  assert.equal(item.lastObservedAt, new Date(h.now()).toISOString());
  assert.equal(item.publishedAt, null);
  assert.equal(item.transactionDate, null);
  assert.equal(revised.items.length, 2);
  const snapshot = monitor.getState();
  snapshot.items[0].symbols.push("FAKE");
  assert.deepEqual(monitor.getState().items[0].symbols, [], "callers cannot mutate persisted records");
});

test("concurrent scans share one request and both successful and failed attempts obey the 15-minute minimum", async (t) => {
  const h = harness(t);
  let release;
  h.replies.push(() => new Promise((resolve) => { release = resolve; }));
  const monitor = h.create();
  const first = monitor.scan(), concurrent = monitor.scan();
  assert.equal(first, concurrent);
  assert.equal(h.calls.length, 1);
  release(response(archive([filing()])));
  await Promise.all([first, concurrent]);
  h.advance(POLL_MS - 1);
  await monitor.scan();
  assert.equal(h.calls.length, 1);
  h.advance(1);
  h.replies.push(() => { throw new Error("offline"); });
  const failed = await monitor.scan();
  assert.equal(failed.error, "house-index-fetch-or-parse-failed");
  await h.create().scan();
  assert.equal(h.calls.length, 2, "a failed attempt is also rate-limited after restart");
  assert.equal(failed.items.length, 1);
});

test("429 Retry-After seconds and HTTP dates persist across restart without early retries", async (t) => {
  for (const retryAfter of ["3600", "Sat, 03 Oct 2026 13:34:56 GMT"]) {
    await t.test(retryAfter, async (t) => {
      const h = harness(t);
      h.replies.push(new Response(null, { status: 429, headers: { "retry-after": retryAfter } }));
      const result = await h.create().scan();
      assert.equal(result.error, "house-index-HTTP-429");
      assert.equal(result.nextScanAt, "2026-10-03T13:34:56.000Z");
      h.advance(3600000 - 1);
      await h.create().scan();
      assert.equal(h.calls.length, 1);
      h.advance(1);
      h.replies.push(response(archive([filing()])));
      assert.equal((await h.create().scan()).error, null);
      assert.equal(h.calls.length, 2);
    });
  }
});

test("out-of-range Retry-After cannot corrupt the clock or crash scans", async (t) => {
  const h = harness(t);
  h.replies.push(new Response(null, { status: 429, headers: { "retry-after": "9999999999999999" } }));
  const state = await h.create().scan();
  assert.equal(state.error, "house-index-HTTP-429");
  assert.equal(state.nextScanAt, new Date(START + POLL_MS).toISOString());
  assert.equal(h.create().getState().error, "house-index-HTTP-429");
});

test("malformed downloads preserve the last verified records and conditional validators", async (t) => {
  const h = harness(t), monitor = h.create();
  h.replies.push(response(archive([filing()]), { etag: '"verified"' }));
  const good = await monitor.scan();
  h.advance();
  h.replies.push(response(zipEntries([{ name: "2026FD.txt", text: tsv([filing({ FilingDate: "bad" })]) }]), { etag: '"broken"' }));
  const bad = await monitor.scan();
  assert.equal(bad.error, "invalid-filing-date");
  assert.deepEqual(bad.items, good.items);
  assert.equal(bad.lastSuccessAt, good.lastSuccessAt);
  assert.ok(bad.budget.bytesToday > good.budget.bytesToday, "malformed data still counts toward the budget");
  h.advance();
  h.replies.push(new Response(null, { status: 304 }));
  await monitor.scan();
  assert.equal(h.calls[2].options.headers["If-None-Match"], '"verified"');
});

test("an unsolicited initial 304 is an error and creates no fabricated baseline", async (t) => {
  const h = harness(t);
  h.replies.push(new Response(null, { status: 304 }));
  const state = await h.create().scan();
  assert.equal(state.error, "unexpected-304-without-baseline");
  assert.equal(state.lastSuccessAt, null);
  assert.deepEqual(state.items, []);
});

test("eight MiB daily download budget survives restarts, blocks requests, and resets on the next UTC day", async (t) => {
  const h = harness(t);
  for (let i = 0; i < 4; i++) {
    h.replies.push(response(Buffer.alloc(2 * 1024 * 1024)));
    const result = await h.create().scan();
    assert.equal(result.budget.bytesToday, (i + 1) * 2 * 1024 * 1024);
    h.advance();
  }
  const exhausted = await h.create().scan();
  assert.equal(exhausted.budget.dailyLimitBytes, DAILY_BUDGET);
  assert.equal(exhausted.budget.bytesToday, DAILY_BUDGET);
  assert.equal(exhausted.error, "disclosure-daily-budget-exhausted");
  assert.equal(h.calls.length, 4);
  h.setTime("2026-10-04T00:00:00Z");
  const freshZip = archive([filing()]);
  h.replies.push(response(freshZip));
  const fresh = await h.create().scan();
  assert.equal(fresh.budget.day, "2026-10-04");
  assert.equal(fresh.budget.bytesToday, freshZip.length);
  assert.equal(fresh.error, null);
});

test("a download exceeding the per-archive cap never changes the verified feed", async (t) => {
  const h = harness(t), monitor = h.create();
  h.replies.push(response(archive([filing()])));
  const good = await monitor.scan();
  h.advance();
  h.replies.push(response(Buffer.alloc(2 * 1024 * 1024 + 1)));
  const bad = await monitor.scan();
  assert.equal(bad.error, "disclosure-download-budget-exceeded");
  assert.deepEqual(bad.items, good.items);
  assert.equal(bad.lastSuccessAt, good.lastSuccessAt);
});

test("unreadable persistence fails closed without network access or overwriting the corrupt state", async (t) => {
  const h = harness(t);
  const stateFile = path.join(h.dataDir, "house-disclosures-state.json");
  fs.writeFileSync(stateFile, "{broken json");
  const result = await h.create().scan();
  assert.equal(result.error, "disclosure-state-unreadable");
  assert.equal(result.persistence, "unavailable");
  assert.equal(h.calls.length, 0);
  assert.equal(fs.readFileSync(stateFile, "utf8"), "{broken json");
});

test("invalid persisted timestamps fail closed instead of crashing or claiming fresh data", async (t) => {
  for (const override of [{ nextScanAt: 1e100 }, { lastSuccessAt: "not-a-date" }, { bytesToday: -1 }]) {
    await t.test(JSON.stringify(override), async (t) => {
      const h = harness(t);
      h.replies.push(response(archive([filing()])));
      await h.create().scan();
      const stateFile = path.join(h.dataDir, "house-disclosures-state.json");
      const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      const bad = JSON.stringify({ ...saved, ...override });
      fs.writeFileSync(stateFile, bad);
      const result = await h.create().scan();
      assert.equal(result.error, "disclosure-state-unreadable");
      assert.equal(result.persistence, "unavailable");
      assert.equal(result.stale, true);
      assert.equal(h.calls.length, 1);
      assert.equal(fs.readFileSync(stateFile, "utf8"), bad);
    });
  }
});

test("new-year filings are new observations while January and February also check the known prior year", async (t) => {
  const h = harness(t, Date.parse("2026-12-31T23:40:00Z"));
  h.replies.push(response(archive([filing()]), { etag: '"2026-v1"' }));
  const initial = await h.create().scan();
  assert.equal(initial.items[0].novelty, "baseline");
  h.setTime("2027-01-01T00:01:00Z");
  h.replies.push(response(archive([filing({ Year: "2027", FilingDate: "1/1/2027", DocID: "20010000" })], 2027)),
    response(archive([filing(), filing({ FilingDate: "12/31/2026", DocID: "20009999" })])));
  const rollover = await h.create().scan();
  assert.deepEqual(h.calls.slice(1).map((x) => x.url.match(/\/(\d{4})FD\.zip$/)[1]), ["2027", "2026"]);
  assert.equal(h.calls[1].options.headers["If-None-Match"], undefined);
  assert.equal(h.calls[2].options.headers["If-None-Match"], '"2026-v1"');
  assert.equal(rollover.items.find((x) => x.filingYear === 2027).novelty, "newly-observed");
  assert.equal(rollover.items.find((x) => x.documentId === "20009999").novelty, "newly-observed");
  h.setTime("2027-02-28T12:00:00Z");
  h.replies.push(new Response(null, { status: 304 }), new Response(null, { status: 304 }));
  await h.create().scan();
  assert.equal(h.calls.length, 5);
  h.setTime("2027-03-01T12:00:00Z");
  h.replies.push(new Response(null, { status: 304 }));
  await h.create().scan();
  assert.equal(h.calls.length, 6, "prior-year refresh stops after February");
});

test("rollover cannot accept 304 for a new year whose index was never downloaded", async (t) => {
  const h = harness(t, Date.parse("2026-12-31T23:40:00Z"));
  h.replies.push(response(archive([filing()])));
  await h.create().scan();
  h.setTime("2027-01-01T00:01:00Z");
  h.replies.push(new Response(null, { status: 304 }), new Response(null, { status: 304 }));
  const result = await h.create().scan();
  assert.equal(result.error, "unexpected-304-without-baseline");
  assert.equal(h.calls.length, 3, "prior-year monitoring continues despite the new-year failure");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].filingYear, 2026);
});

test("a not-yet-published new-year archive does not suppress late prior-year disclosures", async (t) => {
  const h = harness(t, Date.parse("2026-12-31T23:40:00Z"));
  h.replies.push(response(archive([filing()])));
  await h.create().scan();
  h.setTime("2027-01-01T00:01:00Z");
  h.replies.push(new Response(null, { status: 404 }),
    response(archive([filing(), filing({ FilingDate: "12/31/2026", DocID: "20009999" })])));
  const result = await h.create().scan();
  assert.equal(h.calls.length, 3);
  assert.equal(result.items.find((x) => x.documentId === "20009999")?.novelty, "newly-observed");
  assert.match(result.error, /404/, "the unavailable current year remains visible as a partial failure");
});

test("feed eviction does not reset a filing's original first-seen time on a later revision", async (t) => {
  const h = harness(t), monitor = h.create();
  const rows = [filing({ FilingDate: "1/1/2026", DocID: "1" }),
    ...Array.from({ length: 100 }, (_, i) => filing({ FilingDate: "10/2/2026", DocID: String(i + 2) }))];
  h.replies.push(response(archive(rows)));
  const first = await monitor.scan();
  assert.equal(first.items.length, 100);
  assert.equal(first.items.some((x) => x.documentId === "1"), false);
  h.advance();
  h.replies.push(response(archive([filing({ FilingDate: "10/3/2026", DocID: "1" }), ...rows.slice(1)])));
  const revised = await h.create().scan();
  const item = revised.items.find((x) => x.documentId === "1");
  assert.equal(item.novelty, "index-update");
  assert.equal(item.firstSeenAt, new Date(START).toISOString());
});

test("monitor exposes freshness without ever invoking supplied signal or delivery callbacks", async (t) => {
  const h = harness(t);
  let callbackCount = 0;
  const unexpectedCallback = () => { callbackCount += 1; };
  const monitor = h.create({ onEvent: unexpectedCallback, onSignal: unexpectedCallback, sendMessage: unexpectedCallback });
  assert.equal(monitor.getState().stale, true);
  h.replies.push(response(archive([filing()])));
  const result = await monitor.scan();
  assert.equal(result.stale, false);
  assert.equal(result.transactionExtraction, false);
  assert.equal(result.directTelegramAlerts, false);
  assert.equal(result.productionInfluence, false);
  h.advance(45 * 60000 + 1);
  assert.equal(monitor.getState().stale, true);
  assert.equal(callbackCount, 0);
});
