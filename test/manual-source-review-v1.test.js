"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createHash } = require("node:crypto"), { spawnSync } = require("node:child_process");
const createOutbox = require("../delivery-outbox-v1");
const writeDurableState = require("../durable-state-v1");
const { SCOPE, MAX_BYTES, targetFor, readTargets, loadJournal, importReviews, projectReviews } = require("../manual-source-review-v1");
const { informationDeliveryStatus } = require("../general-information-v1");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const FILES = { policy: "catalyst-state.json", eia: "eia-state.json", ecb: "ecb-state.json" };
const cli = path.resolve(__dirname, "../scripts/import-source-reviews.js");
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "777-manual-review-")), now = Date.now();
  t.after(() => { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, now, journal: path.join(directory, "private-reviews", "source-reviews-v1.json") };
}
function fixture(engine, index, now) {
  const id = `${engine}:fixture-${index}`;
  return { id, item: { id, title: `Synthetic official source ${index}`, url: `https://example.org/${engine}/${index}`, publishedAt: new Date(now - 86400000).toISOString(), detectedAt: new Date(now - 3600000).toISOString() },
    createdAt: now - 3600000, deliveries: { telegram: { status: "failed", attempts: 0, nextAttemptAt: 0, error: "delivery-expired-requires-review" },
      marketRecheck: { status: "failed", attempts: 5, nextAttemptAt: 0, error: "synthetic unavailable quotes" } } };
}
function save(h, engine, entries) { fs.writeFileSync(path.join(h.directory, FILES[engine]), JSON.stringify({ version: 3, savedAt: new Date(h.now).toISOString(), seen: [], primed: [], items: [], deliveryOutbox: entries })); }
function request(engine, entry, now, revision = 1, previousReviewSha256 = null, disposition = "TRIAGED_NO_REPLAY") {
  return { target: targetFor(engine, entry), revision, previousReviewSha256, review: { scope: SCOPE, disposition, verifiedPublicationDate: null,
    evidenceUrls: ["https://example.org/official"], explanation: "PRIVATE_REVIEW_EXPLANATION synthetic dated-source triage only", reviewer: "PRIVATE_REVIEWER", reviewedAt: new Date(now).toISOString() } };
}
function input(h, reviews) {
  const inputFile = path.join(h.directory, "review-input.json"), bytes = JSON.stringify({ schema: 1, reviews });
  fs.writeFileSync(inputFile, bytes);
  return { directory: h.directory, inputFile, expectedInputSha256: digest(bytes), apply: true, now: h.now };
}
function projection(h, engine, entries) { return projectReviews({ directory: h.directory, engine, entries, now: h.now }); }

test("seven real expired outbox transitions stay byte-identical through private import, reread and a second process", async t => {
  const h = setup(t), entries = {}, before = {}, reviews = []; let sends = 0;
  for (const [engine, count] of [["policy", 4], ["eia", 3]]) {
    let clock = h.now - 3600000, outbox;
    outbox = createOutbox({ now: () => clock, persist: () => writeDurableState(path.join(h.directory, FILES[engine]), { version: 3, deliveryOutbox: outbox.snapshot() }), handlers: { telegram: { deliver: async () => { sends++; return { message_id: 1 }; } } } });
    outbox.enqueue(Array.from({ length: count }, (_, i) => fixture(engine, i, h.now).item), ["telegram"]);
    clock = h.now; await outbox.drain(); entries[engine] = outbox.snapshot();
    before[engine] = fs.readFileSync(path.join(h.directory, FILES[engine]));
    reviews.push(...entries[engine].map(e => request(engine, e, h.now)));
  }
  const opts = input(h, reviews);
  assert.equal(importReviews(opts).added, 7); assert.equal(sends, 0);
  for (const [engine, count] of [["policy", 4], ["eia", 3]]) {
    assert.deepEqual(fs.readFileSync(path.join(h.directory, FILES[engine])), before[engine]);
    assert.equal(projection(h, engine, entries[engine]).reviewedFailed, count);
    assert.equal(projection(h, engine, entries[engine]).unreviewedFailed, 0);
    for (const e of entries[engine]) { assert.equal(e.deliveries.telegram.status, "failed"); assert.equal(e.deliveries.telegram.attempts, 0); assert.equal(e.deliveries.telegram.providerReceipt, undefined); }
  }
  const journalBefore = fs.readFileSync(h.journal);
  const child = spawnSync(process.execPath, [cli, "--data-dir", h.directory, "--input", opts.inputFile, "--expected-input-sha256", opts.expectedInputSha256, "--apply"], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).status, "UNCHANGED");
  assert.deepEqual(fs.readFileSync(h.journal), journalBefore);
  for (const engine of Object.keys(entries)) assert.deepEqual(fs.readFileSync(path.join(h.directory, FILES[engine])), before[engine]);
  assert.doesNotMatch(child.stdout + child.stderr, /PRIVATE_REVIEW|example.org/);
  if (process.platform !== "win32") { assert.equal(fs.statSync(h.journal).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(h.journal)).mode & 0o777, 0o700); }
});

for (const change of [
  e => { e.item.title += " changed"; }, e => { e.createdAt++; }, e => { e.deliveries.telegram.attempts++; },
  e => { e.deliveries.telegram.nextAttemptAt++; }, e => { e.id += "|release:new"; e.item.id = e.id; }
]) test("content, instance, delivery or new-edition changes cannot inherit a review", t => {
  const h = setup(t), entry = fixture("eia", 1, h.now); save(h, "eia", [entry]);
  const opts = input(h, [request("eia", entry, h.now)]); importReviews(opts);
  const changed = structuredClone(entry); change(changed); save(h, "eia", [changed]);
  assert.equal(projection(h, "eia", [changed]).reviewedFailed, 0);
  assert.equal(projection(h, "eia", [changed]).unreviewedFailed, 1);
  assert.throws(() => importReviews(opts), /target-mismatch/);
});

test("explicit next revision reopens a case and old idempotent imports cannot close it again", t => {
  const h = setup(t), entry = fixture("policy", 1, h.now); save(h, "policy", [entry]);
  const initial = request("policy", entry, h.now); importReviews(input(h, [initial]));
  const first = loadJournal(h.directory, h.now).journal.records[0];
  const reopen = request("policy", entry, h.now, 2, first.sha256, "OPEN_REQUIRES_MORE_EVIDENCE");
  importReviews(input(h, [reopen])); assert.equal(projection(h, "policy", [entry]).unreviewedFailed, 1);
  assert.equal(importReviews(input(h, [initial])).status, "UNCHANGED"); assert.equal(projection(h, "policy", [entry]).reviewedFailed, 0);
  const conflict = structuredClone(reopen); conflict.review.disposition = "TRIAGED_NO_REPLAY";
  assert.throws(() => importReviews(input(h, [conflict])), /revision-conflict/);
  const latest = loadJournal(h.directory, h.now).journal.records.at(-1);
  importReviews(input(h, [request("policy", entry, h.now, 3, latest.sha256)]));
  assert.equal(projection(h, "policy", [entry]).reviewedFailed, 1);
});

test("preview, missing journal and target listing create no private store or data mutation", t => {
  const h = setup(t), entry = fixture("policy", 1, h.now); save(h, "policy", [entry]);
  const opts = input(h, [request("policy", entry, h.now)]), names = fs.readdirSync(h.directory);
  assert.equal(importReviews({ ...opts, apply: false }).status, "PREVIEW");
  assert.equal(projection(h, "policy", [entry]).reviewStoreStatus, "missing");
  const listed = spawnSync(process.execPath, [cli, "--data-dir", h.directory, "--list-targets"], { encoding: "utf8" });
  assert.equal(listed.status, 0); assert.equal(JSON.parse(listed.stdout).targets.length, 1);
  assert.deepEqual(fs.readdirSync(h.directory), names);
});

test("ambiguous duplicate outbox IDs reject imports even with different instances and content", t => {
  const h = setup(t), entry = fixture("policy", 1, h.now), other = structuredClone(entry);
  other.createdAt++; other.item.title += " different"; save(h, "policy", [entry, other]);
  assert.throws(() => importReviews(input(h, [request("policy", entry, h.now)])), /outbox-duplicate/);
  assert.equal(fs.existsSync(h.journal), false);
});

test("a later duplicate ID invalidates a previously matching review projection", t => {
  const h = setup(t), entry = fixture("policy", 1, h.now); save(h, "policy", [entry]);
  importReviews(input(h, [request("policy", entry, h.now)]));
  const other = structuredClone(entry); other.createdAt++; other.item.title += " different";
  const result = projection(h, "policy", [entry, other]);
  assert.equal(result.reviewStoreStatus, "error"); assert.equal(result.reviewedFailed, 0); assert.equal(result.unreviewedFailed, 2);
});

test("unknown input fields, wrong input hash, review scope, dates and unsafe evidence are rejected before writing", t => {
  const h = setup(t), entry = fixture("eia", 1, h.now); save(h, "eia", [entry]);
  const initial = request("eia", entry, h.now), opts = input(h, [initial]);
  assert.throws(() => importReviews({ ...opts, expectedInputSha256: "0".repeat(64) }), /input-hash-mismatch/);
  for (const mutate of [r => { r.privateUnknown = "secret"; }, r => { r.review.scope = "FULL_ECONOMIC_REVIEW"; }, r => { r.review.verifiedPublicationDate = "2026-02-30"; },
    r => { r.review.evidenceUrls = ["https://example.org/?api_key=private"]; }, r => { r.review.reviewedAt = new Date(h.now + 600000).toISOString(); }]) {
    const bad = structuredClone(initial); mutate(bad); assert.throws(() => importReviews(input(h, [bad])));
  }
  assert.equal(fs.existsSync(h.journal), false);
});

test("pending, unrelated failure, missing ID and contradictory receipt cannot be marked reviewed", t => {
  const h = setup(t), original = fixture("policy", 1, h.now), req = request("policy", original, h.now);
  for (const mutate of [e => { e.deliveries.telegram.status = "pending"; }, e => { e.deliveries.telegram.error = "retry-limit"; },
    e => { e.deliveries.telegram.providerReceipt = { messageId: "99" }; }, e => { e.id = "different"; }]) {
    const e = structuredClone(original); mutate(e); save(h, "policy", [e]);
    assert.throws(() => importReviews(input(h, [req])));
  }
  assert.equal(fs.existsSync(h.journal), false);
});

test("corrupt, modified or oversize journal is fail-closed and never repaired by reads/imports", t => {
  const h = setup(t), entry = fixture("policy", 1, h.now); save(h, "policy", [entry]);
  const opts = input(h, [request("policy", entry, h.now)]); importReviews(opts);
  const valid = JSON.parse(fs.readFileSync(h.journal)); valid.records[0].request.review.disposition = "OPEN_REQUIRES_MORE_EVIDENCE";
  for (const bad of ["{broken", JSON.stringify(valid), "x".repeat(MAX_BYTES + 1)]) {
    fs.writeFileSync(h.journal, bad);
    const result = projection(h, "policy", [entry]);
    assert.equal(result.reviewStoreStatus, "error"); assert.equal(result.reviewedFailed, 0); assert.equal(result.unreviewedFailed, 1);
    assert.throws(() => importReviews(opts)); assert.equal(fs.readFileSync(h.journal, "utf8"), bad);
  }
});

test("sync failure and exclusive import lock cannot claim success or alter original outbox", t => {
  const h = setup(t), entry = fixture("eia", 1, h.now); save(h, "eia", [entry]);
  const opts = input(h, [request("eia", entry, h.now)]), before = fs.readFileSync(path.join(h.directory, FILES.eia));
  const mock = t.mock.method(fs, "fsyncSync", () => { throw new Error("synthetic private failure"); });
  assert.throws(() => importReviews(opts)); mock.mock.restore();
  assert.equal(fs.existsSync(h.journal), false);
  const lock = path.join(path.dirname(h.journal), ".import.lock"); fs.writeFileSync(lock, "", { mode: 0o600 });
  assert.throws(() => importReviews(opts), /import-locked/); assert.equal(fs.existsSync(lock), true);
  assert.deepEqual(fs.readFileSync(path.join(h.directory, FILES.eia)), before);
});

test("safe public projection never returns private notes, IDs, hashes or reviewer information", t => {
  const h = setup(t), entry = fixture("policy", 1, h.now); save(h, "policy", [entry]);
  importReviews(input(h, [request("policy", entry, h.now)]));
  const outbox = { snapshot: () => [entry], getStatus: () => ({ error: "telegram: delivery-expired-requires-review" }) };
  const status = informationDeliveryStatus(outbox, { directory: h.directory, engine: "policy", now: h.now });
  assert.equal(status.failed, 1); assert.equal(status.reviewedFailed, 1); assert.equal(status.sent, 0); assert.equal(status.lastReceiptAt, null);
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE_|example.org|fixture-1|sha256|evidenceUrls|explanation|reviewer|reviewedAt/);
});

for (const [engine, moduleName] of [["policy", "catalyst-v4"], ["eia", "eia-v4"], ["ecb", "ecb-v4"]]) {
  test(`${engine}: actual engine status reads private review; reread/new engine does not send or mutate delivery`, t => {
    const h = setup(t), entry = fixture(engine, 1, h.now); save(h, engine, [entry]);
    const old = process.env.RADAR_DATA_DIR; process.env.RADAR_DATA_DIR = h.directory;
    t.after(() => { if (old === undefined) delete process.env.RADAR_DATA_DIR; else process.env.RADAR_DATA_DIR = old; });
    t.mock.method(global, "fetch", () => { throw new Error("Unexpected network request"); });
    let sends = 0;
    const create = require(`../${moduleName}`), options = { informationMode: true, telegramConfigured: () => true, sendMessage: async () => { sends++; return { message_id: 2 }; } };
    let instance = create(options);
    const stateFile = path.join(h.directory, FILES[engine]), before = fs.readFileSync(stateFile);
    assert.equal(instance.getState().informationDeliveryStatus.unreviewedFailed, 1);
    importReviews(input(h, [request(engine, entry, h.now)]));
    assert.equal(instance.getState().informationDeliveryStatus.reviewedFailed, 1);
    assert.doesNotMatch(JSON.stringify(instance.getState()), /PRIVATE_REVIEW|evidenceUrls|explanation|reviewer/);
    assert.deepEqual(fs.readFileSync(stateFile), before);
    instance = create(options);
    assert.equal(instance.getState().informationDeliveryStatus.reviewedFailed, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile)).deliveryOutbox, JSON.parse(before).deliveryOutbox);
    assert.equal(sends, 0);
  });
}

test("symlink journal is rejected instead of read or overwritten", { skip: process.platform === "win32" }, t => {
  const h = setup(t), entry = fixture("policy", 1, h.now); save(h, "policy", [entry]);
  const opts = input(h, [request("policy", entry, h.now)]);
  fs.mkdirSync(path.dirname(h.journal), { mode: 0o700 }); fs.symlinkSync(opts.inputFile, h.journal);
  assert.equal(projection(h, "policy", [entry]).reviewStoreStatus, "error");
  assert.throws(() => importReviews(opts)); assert.equal(fs.lstatSync(h.journal).isSymbolicLink(), true);
});

test("POSIX private storage refuses broad file or directory access", { skip: process.platform === "win32" }, t => {
  const h = setup(t), entry = fixture("policy", 1, h.now); save(h, "policy", [entry]);
  const opts = input(h, [request("policy", entry, h.now)]); importReviews(opts);
  fs.chmodSync(h.journal, 0o644);
  assert.equal(projection(h, "policy", [entry]).reviewStoreStatus, "error"); assert.throws(() => importReviews(opts), /permissions/);
  fs.chmodSync(h.journal, 0o600); fs.chmodSync(path.dirname(h.journal), 0o755);
  assert.equal(projection(h, "policy", [entry]).reviewStoreStatus, "error"); assert.throws(() => importReviews(opts), /permissions/);
});
