const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createHash } = require("node:crypto");
const { createPrivateBackupHandler, prepareBackupExport } = require("../private-backup-v1");
const { prepareStartup } = require("../container-entrypoint");
const KEY = "synthetic-test-access-key-32-bytes-only";
const sha = data => createHash("sha256").update(data).digest("hex");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "radar-private-backup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data"), id = "before-runtime";
  const parent = path.join(dataDir, ".radar-recovery"), snapshot = path.join(parent, id), copy = path.join(snapshot, "data");
  fs.mkdirSync(path.join(copy, "nested"), { recursive: true });
  const payloads = new Map([["journal.json", Buffer.from('[{"id":"old-record"}]')],
    ["nested/binary.bin", Buffer.from(Array.from({ length: 120000 }, (_, i) => i % 256))], ["empty", Buffer.alloc(0)]]);
  for (const [name, data] of payloads) fs.writeFileSync(path.join(copy, name), data);
  fs.writeFileSync(path.join(dataDir, ".env"), "DO_NOT_EXPORT_LIVE_SECRET=example");
  fs.writeFileSync(path.join(dataDir, "journal.json"), "different-live-state");
  const entries = [];
  function walk(folder, prefix = "") {
    for (const name of fs.readdirSync(folder).sort()) {
      const file = path.join(folder, name), relative = prefix ? `${prefix}/${name}` : name, stat = fs.statSync(file);
      const meta = { path: relative, mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid };
      if (stat.isDirectory()) { entries.push({ ...meta, type: "directory" }); walk(file, relative); }
      else entries.push({ ...meta, type: "file", size: stat.size, sha256: sha(fs.readFileSync(file)) });
    }
  }
  walk(copy);
  const manifest = { version: 1, id, createdAt: new Date().toISOString(), bytes: entries.reduce((n, e) => n + (e.size || 0), 0), entries };
  const manifestPath = path.join(snapshot, "manifest.json");
  const save = () => fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n"); save();
  return { root, dataDir, id, parent, snapshot, copy, manifest, manifestPath, payloads, save };
}
async function serve(t, options) {
  const handler = createPrivateBackupHandler(options);
  const server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return (route = "/api/private-backup", options = {}) => fetch(base + route, { ...options,
    headers: options.headers || { authorization: `Bearer ${KEY}` } });
}

test("disabled export does not inspect any data and short configuration keys remain disabled", async t => {
  for (const accessKey of [undefined, "short"]) {
    const request = await serve(t, { dataDir: "missing-private-location", id: "snapshot", accessKey });
    assert.equal((await request()).status, 404);
  }
});

test("missing or invalid bearer returns 401 without revealing credentials or paths", async t => {
  const f = fixture(t), request = await serve(t, { ...f, accessKey: KEY });
  for (const authorization of [undefined, "Bearer wrong", `Basic ${KEY}`]) {
    const response = await request(undefined, { headers: authorization ? { authorization } : {} });
    assert.equal(response.status, 401);
    const body = await response.text();
    assert.equal(body, '{"error":"unauthorized"}'); assert.ok(!body.includes(KEY)); assert.ok(!body.includes(f.dataDir));
  }
});

test("only GET of the configured snapshot is allowed; no query selector or mutation endpoint", async t => {
  const f = fixture(t), request = await serve(t, { ...f, accessKey: KEY });
  assert.equal((await request(undefined, { method: "POST" })).status, 405);
  assert.equal((await request("/api/private-backup?id=../../private")).status, 400);
  const invalid = await serve(t, { ...f, id: "../escape", accessKey: KEY });
  assert.equal((await invalid()).status, 404);
});

test("full streamed download reconstructs every byte and verifies snapshot and manifest hashes", async t => {
  const f = fixture(t), request = await serve(t, { ...f, accessKey: KEY });
  const response = await request(); assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const text = await response.text(), rows = text.trim().split("\n").map(JSON.parse);
  assert.equal(rows[0].format, "radar-recovery-ndjson");
  assert.equal(rows.at(-1).type, "complete");
  assert.equal(rows.at(-1).files, f.payloads.size);
  const manifestRow = rows.find(row => row.type === "manifest"), manifest = Buffer.from(manifestRow.data, "base64");
  assert.deepEqual(manifest, fs.readFileSync(f.manifestPath));
  assert.equal(sha(manifest), manifestRow.sha256);
  assert.equal(rows.at(-1).manifestSha256, manifestRow.sha256);
  for (const [name, expected] of f.payloads) {
    const chunks = rows.filter(row => row.type === "chunk" && row.path === name); let offset = 0;
    const buffers = chunks.map(row => { assert.equal(row.offset, offset); const bytes = Buffer.from(row.data, "base64"); offset += bytes.length; return bytes; });
    const bytes = Buffer.concat(buffers); assert.deepEqual(bytes, expected);
    const end = rows.find(row => row.type === "file-end" && row.path === name);
    assert.equal(end.sha256, sha(bytes)); assert.equal(end.bytes, bytes.length);
  }
  assert.ok(rows.filter(row => row.type === "chunk").length > f.payloads.size, "large files must be chunked");
  assert.ok(!text.includes(".env")); assert.ok(!text.includes("DO_NOT_EXPORT"));
  assert.equal(fs.readFileSync(path.join(f.dataDir, "journal.json"), "utf8"), "different-live-state");
});

test("corrupt content and manifest traversal fail before a successful export header", async t => {
  for (const mutate of [f => fs.writeFileSync(path.join(f.copy, "journal.json"), "corrupt"),
    f => { f.manifest.entries[0].path = "../escape"; f.save(); }]) {
    const f = fixture(t); mutate(f); const request = await serve(t, { ...f, accessKey: KEY });
    const response = await request(); assert.equal(response.status, 409);
    assert.equal(await response.text(), '{"error":"private-backup-unavailable"}');
  }
});

test("snapshotted environment/credential files are refused rather than omitted from a complete claim", async t => {
  const f = fixture(t), bytes = Buffer.from("synthetic-secret");
  fs.writeFileSync(path.join(f.copy, ".env"), bytes);
  f.manifest.entries.push({ path: ".env", type: "file", size: bytes.length, sha256: sha(bytes) }); f.manifest.bytes += bytes.length; f.save();
  const request = await serve(t, { ...f, accessKey: KEY }); assert.equal((await request()).status, 409);
});

test("wire-size limit includes base64 expansion rather than accepting a 76MB raw snapshot", async t => {
  const f = fixture(t), size = 76_000_000;
  fs.writeFileSync(path.join(f.copy, "large.bin"), ""); fs.truncateSync(path.join(f.copy, "large.bin"), size);
  f.manifest.entries.push({ path: "large.bin", type: "file", size, sha256: "0".repeat(64) }); f.manifest.bytes += size; f.save();
  const request = await serve(t, { ...f, accessKey: KEY }); assert.equal((await request()).status, 409);
});

test("an interrupted client releases the active-download slot and file handles", async t => {
  const f = fixture(t), data = Buffer.alloc(2_000_000, 42);
  fs.writeFileSync(path.join(f.copy, "larger.bin"), data);
  f.manifest.entries.push({ path: "larger.bin", type: "file", size: data.length, sha256: sha(data) }); f.manifest.bytes += data.length; f.save();
  const request = await serve(t, { ...f, accessKey: KEY });
  const interrupted = await request(); assert.equal(interrupted.status, 200);
  await interrupted.body.cancel();
  let response;
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    response = await request(); if (response.status !== 429) break; await response.text();
  }
  assert.equal(response.status, 200);
  assert.equal(JSON.parse((await response.text()).trim().split("\n").at(-1)).type, "complete");
});

test("hard links outside the snapshot cannot be exported", async t => {
  const f = fixture(t), file = path.join(f.copy, "journal.json");
  fs.linkSync(file, path.join(f.root, "outside-copy"));
  const request = await serve(t, { ...f, accessKey: KEY }); assert.equal((await request()).status, 409);
});

test("symlink escape is rejected", async t => {
  const f = fixture(t), target = path.join(f.copy, "journal.json");
  fs.unlinkSync(target);
  try { fs.symlinkSync(path.join(f.dataDir, "journal.json"), target); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) { t.skip("Host does not permit symlink creation; Linux CI covers it"); return; } throw error; }
  const request = await serve(t, { ...f, accessKey: KEY }); assert.equal((await request()).status, 409);
});

test("snapshot export preparation is disabled without a strong key", () => {
  assert.deepEqual(prepareBackupExport({ dataDir: "must-not-be-read", accessKey: "short" }), { enabled: false });
});

test("failed snapshot validation never grants export permissions", t => {
  const f = fixture(t), before = fs.statSync(f.parent);
  fs.writeFileSync(path.join(f.copy, "journal.json"), "broken");
  assert.throws(() => prepareBackupExport({ ...f, accessKey: KEY, uid: 1000, gid: 1000 }), /private-backup-unavailable/);
  const after = fs.statSync(f.parent);
  assert.equal(after.mode, before.mode); assert.equal(after.ctimeMs, before.ctimeMs);
});

test("only configured snapshot permissions change, and the common parent grants search only", t => {
  if (process.platform === "win32") { t.skip("POSIX ownership and mode acceptance runs on Linux"); return; }
  const f = fixture(t), historical = path.join(f.parent, "older-backup");
  fs.mkdirSync(historical, { mode: 0o700 }); fs.writeFileSync(path.join(historical, "untouched"), "old", { mode: 0o600 });
  const oldStat = fs.statSync(historical), liveStat = fs.statSync(path.join(f.dataDir, "journal.json"));
  const result = prepareBackupExport({ ...f, accessKey: KEY, uid: process.getuid(), gid: process.getgid() });
  assert.equal(result.enabled, true);
  assert.equal(fs.statSync(f.parent).mode & 0o777, 0o710);
  assert.equal(fs.statSync(f.snapshot).mode & 0o777, 0o700);
  assert.equal(fs.statSync(f.manifestPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(historical).mode, oldStat.mode); assert.equal(fs.statSync(historical).ctimeMs, oldStat.ctimeMs);
  assert.equal(fs.statSync(path.join(f.dataDir, "journal.json")).ctimeMs, liveStat.ctimeMs);
});

test("startup validates the completed backup before export rights and before privilege drop", t => {
  const f = fixture(t), calls = [];
  prepareStartup({ dataDir: f.dataDir, recoveryBackupId: f.id, backupAccessKey: KEY, privileged: true,
    runtimeAccount: () => ({ uid: 1000, gid: 1000 }),
    prepareExport: options => { assert.equal(options.id, f.id); assert.equal(options.accessKey, KEY); calls.push("export"); return { enabled: true }; },
    prepare: () => calls.push("drop") });
  assert.deepEqual(calls, ["export", "drop"]);
  fs.writeFileSync(path.join(f.copy, "journal.json"), "invalid"); calls.length = 0;
  assert.throws(() => prepareStartup({ dataDir: f.dataDir, recoveryBackupId: f.id, backupAccessKey: KEY, privileged: true,
    prepareExport: () => calls.push("export"), prepare: () => calls.push("drop") }), /corrupt-backup/);
  assert.deepEqual(calls, []);
});
