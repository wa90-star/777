"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const writeDurableState = require("./durable-state-v1");

const SCOPE = "MANUAL_SOURCE_DATE_NOTICE_TYPE";
const EXPIRED = "delivery-expired-requires-review";
const MAX_BYTES = 4 * 1024 * 1024, MAX_RECORDS = 10000;
const FILES = { policy: "catalyst-state.json", eia: "eia-state.json", ecb: "ecb-state.json" };
const HASH = /^[a-f0-9]{64}$/;
const hash = value => createHash("sha256").update(value).digest("hex");
const fail = code => { throw new Error(`source-review-${code}`); };
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) fail("schema-invalid");
}
function text(value, max) { return typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value); }
function iso(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value; }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function validateTarget(target) {
  exact(target, ["engine", "channel", "id", "createdAt", "itemHashAlgorithm", "itemSha256", "deliverySha256"]);
  if (!Object.hasOwn(FILES, target.engine) || target.channel !== "telegram" || !text(target.id, 4096) || !Number.isSafeInteger(target.createdAt) || target.createdAt < 0 ||
      target.itemHashAlgorithm !== "sha256-json-stringify-item-v1" || !HASH.test(target.itemSha256) || !HASH.test(target.deliverySha256)) fail("target-invalid");
}
function targetKey(target) { validateTarget(target); return hash(canonical(target)); }
function targetFor(engine, entry) {
  const d = entry?.deliveries?.telegram;
  if (d?.status !== "failed" || d.error !== EXPIRED) return null;
  if (!entry.item || typeof entry.item !== "object" || Array.isArray(entry.item) || !Number.isSafeInteger(d.attempts) || d.attempts < 0 ||
      !Number.isFinite(d.nextAttemptAt) || d.nextAttemptAt < 0 || d.providerReceipt != null || d.acknowledgedAt != null) fail("target-delivery-invalid");
  const target = { engine, channel: "telegram", id: entry.id, createdAt: entry.createdAt,
    itemHashAlgorithm: "sha256-json-stringify-item-v1", itemSha256: hash(JSON.stringify(entry.item)),
    deliverySha256: hash(canonical({ status: d.status, attempts: d.attempts, nextAttemptAt: d.nextAttemptAt, error: d.error,
      acknowledgedAt: d.acknowledgedAt ?? null, providerReceipt: d.providerReceipt ?? null })) };
  validateTarget(target); return target;
}
function validateReview(review, now) {
  exact(review, ["scope", "disposition", "verifiedPublicationDate", "evidenceUrls", "explanation", "reviewer", "reviewedAt"]);
  if (review.scope !== SCOPE || !["TRIAGED_NO_REPLAY", "OPEN_REQUIRES_MORE_EVIDENCE"].includes(review.disposition) ||
      !text(review.explanation, 4000) || !text(review.reviewer, 120) || !iso(review.reviewedAt) || Date.parse(review.reviewedAt) > now + 300000) fail("review-invalid");
  const date = review.verifiedPublicationDate;
  if (date !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !iso(`${date}T00:00:00.000Z`))) fail("publication-date-invalid");
  if (!Array.isArray(review.evidenceUrls) || review.evidenceUrls.length < 1 || review.evidenceUrls.length > 10) fail("evidence-invalid");
  for (const value of review.evidenceUrls) {
    let u; try { u = new URL(value); } catch { fail("evidence-invalid"); }
    if (!text(value, 4096) || u.protocol !== "https:" || u.username || u.password || u.search || u.hash) fail("evidence-invalid");
  }
}
function validateRequest(request, now) {
  exact(request, ["target", "revision", "previousReviewSha256", "review"]);
  validateTarget(request.target); validateReview(request.review, now);
  if (!Number.isSafeInteger(request.revision) || request.revision < 1 ||
      !(request.previousReviewSha256 === null || HASH.test(request.previousReviewSha256))) fail("revision-invalid");
}
function safeDirectory(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) fail("directory-invalid");
  const absolute = path.resolve(directory), parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("directory-unsafe");
  }
  return absolute;
}
function paths(directory) {
  const root = safeDirectory(directory), dir = path.join(root, "private-reviews");
  try {
    safeDirectory(dir);
    if (process.platform !== "win32" && (fs.statSync(dir).mode & 0o077)) fail("directory-permissions");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return { root, dir, file: path.join(dir, "source-reviews-v1.json"), lock: path.join(dir, ".import.lock") };
}
function readJson(file, maxBytes = MAX_BYTES) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) fail("file-unsafe-or-large");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > maxBytes) fail("file-unsafe-or-large");
    const bytes = fs.readFileSync(fd);
    if (bytes.length > maxBytes) fail("file-unsafe-or-large");
    return { value: JSON.parse(bytes.toString("utf8")), sha256: hash(bytes) };
  } finally { fs.closeSync(fd); }
}
function validateJournal(journal, now) {
  exact(journal, ["schema", "records"]);
  if (journal.schema !== 1 || !Array.isArray(journal.records) || journal.records.length > MAX_RECORDS) fail("journal-invalid");
  const latest = new Map(), byHash = new Map();
  for (const record of journal.records) {
    exact(record, ["request", "importedAt", "inputSha256", "sha256"]);
    validateRequest(record.request, now);
    if (!iso(record.importedAt) || Date.parse(record.importedAt) > now + 300000 || !HASH.test(record.inputSha256) || !HASH.test(record.sha256) ||
        hash(canonical({ request: record.request, importedAt: record.importedAt, inputSha256: record.inputSha256 })) !== record.sha256) fail("journal-invalid");
    const key = targetKey(record.request.target), previous = latest.get(key);
    if (record.request.revision !== (previous?.request.revision || 0) + 1 || record.request.previousReviewSha256 !== (previous?.sha256 || null) || byHash.has(record.sha256)) fail("journal-chain-invalid");
    latest.set(key, record); byHash.set(record.sha256, record);
  }
  return { journal, latest, byHash };
}
function loadJournal(directory, now = Date.now()) {
  const p = paths(directory);
  try {
    if (process.platform !== "win32" && (fs.lstatSync(p.file).mode & 0o077)) fail("file-permissions");
    return { ...validateJournal(readJson(p.file).value, now), state: "ok", ...p };
  }
  catch (error) {
    if (error.code === "ENOENT") return { ...validateJournal({ schema: 1, records: [] }, now), state: "missing", ...p };
    throw error;
  }
}
function readTargets(directory) {
  const root = safeDirectory(directory), result = new Map();
  for (const [engine, filename] of Object.entries(FILES)) {
    let value; try { value = readJson(path.join(root, filename), 32 * 1024 * 1024).value; } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!Array.isArray(value.deliveryOutbox)) fail("outbox-invalid");
    const ids = new Set();
    for (const entry of value.deliveryOutbox) {
      if (typeof entry?.id === "string") { if (ids.has(entry.id)) fail("outbox-duplicate"); ids.add(entry.id); }
      const target = targetFor(engine, entry); if (!target) continue;
      const key = targetKey(target); if (result.has(key)) fail("outbox-duplicate");
      result.set(key, target);
    }
  }
  return result;
}
function planImport(directory, packet, inputSha256, now) {
  exact(packet, ["schema", "reviews"]);
  if (packet.schema !== 1 || !Array.isArray(packet.reviews) || !packet.reviews.length || packet.reviews.length > 100 || !HASH.test(inputSha256)) fail("input-invalid");
  const loaded = loadJournal(directory, now), targets = readTargets(directory);
  const records = [...loaded.journal.records], latest = new Map(loaded.latest);
  let added = 0;
  for (const request of packet.reviews) {
    validateRequest(request, now);
    const key = targetKey(request.target);
    if (!targets.has(key)) fail("target-mismatch");
    const existing = records.find(r => targetKey(r.request.target) === key && r.request.revision === request.revision);
    if (existing) { if (canonical(existing.request) !== canonical(request)) fail("revision-conflict"); continue; }
    const previous = latest.get(key);
    if (request.revision !== (previous?.request.revision || 0) + 1 || request.previousReviewSha256 !== (previous?.sha256 || null)) fail("revision-conflict");
    const payload = { request, importedAt: new Date(now).toISOString(), inputSha256 };
    const record = { ...payload, sha256: hash(canonical(payload)) };
    records.push(record); latest.set(key, record); added++;
  }
  const journal = { schema: 1, records };
  if (records.length > MAX_RECORDS || Buffer.byteLength(JSON.stringify(journal, null, 2)) > MAX_BYTES) fail("journal-limit");
  validateJournal(journal, now);
  return { ...loaded, journal, added, unchanged: packet.reviews.length - added };
}
function importReviews({ directory, inputFile, expectedInputSha256, apply = false, now = Date.now() }) {
  const { value: packet, sha256: inputSha256 } = readJson(inputFile);
  if (apply && inputSha256 !== expectedInputSha256) fail("input-hash-mismatch");
  const plan = planImport(directory, packet, inputSha256, now);
  if (!apply) return { status: "PREVIEW", added: plan.added, unchanged: plan.unchanged, inputSha256, deliveryChanged: false };
  if (!fs.existsSync(plan.dir)) fs.mkdirSync(plan.dir, { mode: 0o700 });
  safeDirectory(plan.dir);
  if (process.platform !== "win32" && (fs.statSync(plan.dir).mode & 0o077)) fail("directory-permissions");
  let lock;
  try { lock = fs.openSync(plan.lock, "wx", 0o600); } catch { fail("import-locked"); }
  try {
    const checked = planImport(directory, packet, inputSha256, now);
    if (checked.added) {
      writeDurableState(checked.file, checked.journal);
      if (canonical(loadJournal(directory, now).journal) !== canonical(checked.journal)) fail("readback-mismatch");
    }
    return { status: checked.added ? "IMPORTED" : "UNCHANGED", added: checked.added, unchanged: checked.unchanged, inputSha256, deliveryChanged: false };
  } finally { fs.closeSync(lock); fs.unlinkSync(plan.lock); }
}
function projectReviews({ directory, engine, entries, now = Date.now() }) {
  const result = { reviewSchema: 1, reviewScope: SCOPE, reviewStoreStatus: "missing", expiredFailed: 0, reviewedFailed: 0, unreviewedFailed: 0, otherFailed: 0 };
  let loaded;
  try { loaded = loadJournal(directory, now); result.reviewStoreStatus = loaded.state; }
  catch { result.reviewStoreStatus = "error"; }
  const ids = new Set();
  for (const entry of entries) {
    if (typeof entry?.id === "string") { if (ids.has(entry.id)) result.reviewStoreStatus = "error"; ids.add(entry.id); }
    const d = entry?.deliveries?.telegram; if (d?.status !== "failed") continue;
    if (d.error !== EXPIRED) { result.otherFailed++; continue; }
    result.expiredFailed++;
    let record;
    try { const target = targetFor(engine, entry); if (target) record = loaded?.latest.get(targetKey(target)); }
    catch { result.reviewStoreStatus = "error"; }
    if (record?.request.review.disposition === "TRIAGED_NO_REPLAY") result.reviewedFailed++;
    else result.unreviewedFailed++;
  }
  if (result.reviewStoreStatus === "error") { result.reviewedFailed = 0; result.unreviewedFailed = result.expiredFailed; }
  return result;
}

module.exports = { SCOPE, EXPIRED, MAX_BYTES, targetFor, targetKey, readTargets, loadJournal, importReviews, projectReviews };
