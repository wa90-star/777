const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { runRecoveryBackup } = require("../recovery-backup-v1");
const { prepareStartup } = require("../container-entrypoint");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "radar-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir);
  fs.mkdirSync(path.join(dataDir, "nested"));
  fs.writeFileSync(path.join(dataDir, "journal.json"), '[{"id":"old-journal"}]');
  fs.writeFileSync(path.join(dataDir, "catalysts.json"), '{"deliveryOutbox":[{"id":"pending","deliveries":{"telegram":{"status":"pending","attempts":2}}}]}');
  fs.writeFileSync(path.join(dataDir, "nested", ".state"), "private-content-not-for-logs");
  fs.writeFileSync(path.join(dataDir, "empty"), "");
  return { root, dataDir, location: path.join(dataDir, ".radar-recovery", "before-restart") };
}

test("default-off is a no-op even for an absent volume", () => {
  assert.deepEqual(runRecoveryBackup({ dataDir: "/definitely-not-a-radar-volume", id: "" }), { enabled: false });
});

test("complete pre-start snapshot preserves all files, nested state and pending outbox", (t) => {
  const { dataDir, location } = fixture(t);
  const result = runRecoveryBackup({ dataDir, id: "before-restart" });
  assert.equal(result.files, 4);
  assert.equal(result.reused, false);
  const manifest = JSON.parse(fs.readFileSync(path.join(location, "manifest.json"), "utf8"));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.entries.length, 5);
  assert.equal(JSON.stringify(manifest).includes("private-content-not-for-logs"), false);
  for (const entry of manifest.entries.filter((entry) => entry.type === "file")) {
    const source = fs.readFileSync(path.join(dataDir, entry.path));
    assert.deepEqual(fs.readFileSync(path.join(location, "data", entry.path)), source);
    assert.equal(entry.sha256, crypto.createHash("sha256").update(source).digest("hex"));
    assert.equal(entry.size, source.length);
  }
  assert.equal(fs.existsSync(`${location}.partial`), false);
});

test("same successful ID is verified and reused after app data evolves; newer IDs preserve older copies", (t) => {
  const { dataDir, location } = fixture(t);
  runRecoveryBackup({ dataDir, id: "before-restart" });
  const before = fs.readFileSync(path.join(location, "manifest.json"));
  fs.writeFileSync(path.join(dataDir, "journal.json"), '[{"id":"new-runtime-state"}]');
  assert.equal(runRecoveryBackup({ dataDir, id: "before-restart" }).reused, true);
  assert.deepEqual(fs.readFileSync(path.join(location, "manifest.json")), before);
  runRecoveryBackup({ dataDir, id: "next-restart" });
  assert.deepEqual(fs.readFileSync(path.join(location, "manifest.json")), before);
  assert.equal(fs.readFileSync(path.join(dataDir, ".radar-recovery", "next-restart", "data", "journal.json"), "utf8"), '[{"id":"new-runtime-state"}]');
});

test("insufficient space fails before backup writes and leaves source content/permissions untouched", (t) => {
  const { dataDir } = fixture(t);
  const source = path.join(dataDir, "journal.json");
  const before = fs.statSync(source);
  assert.throws(() => runRecoveryBackup({ dataDir, id: "before-restart", statfs: () => ({ bsize: 4096, bavail: 0 }) }), /insufficient-space/);
  assert.equal(fs.existsSync(path.join(dataDir, ".radar-recovery")), false);
  assert.equal(fs.readFileSync(source, "utf8"), '[{"id":"old-journal"}]');
  assert.equal(fs.statSync(source).mode, before.mode);
  assert.equal(fs.statSync(source).mtimeMs, before.mtimeMs);
});

test("a crash-left partial copy is never overwritten and blocks app mutation", (t) => {
  const { dataDir, location } = fixture(t);
  fs.mkdirSync(`${location}.partial`, { recursive: true });
  fs.writeFileSync(path.join(`${location}.partial`, "crash-marker"), "keep-evidence");
  let prepared = false;
  assert.throws(() => prepareStartup({ dataDir, recoveryBackupId: "before-restart", prepare: () => { prepared = true; } }), /partial-backup-requires-review/);
  assert.equal(prepared, false);
  assert.equal(fs.readFileSync(path.join(`${location}.partial`, "crash-marker"), "utf8"), "keep-evidence");
  assert.equal(fs.existsSync(location), false);
});

test("corrupt completed backup blocks startup instead of claiming restart success", (t) => {
  const { dataDir, location } = fixture(t);
  runRecoveryBackup({ dataDir, id: "before-restart" });
  fs.writeFileSync(path.join(location, "data", "journal.json"), "corrupted");
  let prepared = false;
  assert.throws(() => prepareStartup({ dataDir, recoveryBackupId: "before-restart", prepare: () => { prepared = true; } }), /corrupt-backup/);
  assert.equal(prepared, false);
  assert.equal(fs.readFileSync(path.join(dataDir, "journal.json"), "utf8"), '[{"id":"old-journal"}]');
  assert.equal(fs.readFileSync(path.join(location, "data", "journal.json"), "utf8"), "corrupted");
});

test("source and backup symlinks are rejected without following them", (t) => {
  const { root, dataDir } = fixture(t);
  const outside = path.join(root, "external-private-state");
  fs.writeFileSync(outside, "do-not-copy");
  fs.symlinkSync(outside, path.join(dataDir, "symlink"));
  assert.throws(() => runRecoveryBackup({ dataDir, id: "before-restart" }), /symlink-not-allowed/);
  assert.equal(fs.existsSync(path.join(dataDir, ".radar-recovery")), false);
  fs.unlinkSync(path.join(dataDir, "symlink"));
  fs.symlinkSync(path.join(root, "does-not-exist"), path.join(dataDir, ".radar-recovery"));
  assert.throws(() => runRecoveryBackup({ dataDir, id: "before-restart" }), /unsafe-directory/);
  assert.equal(fs.existsSync(path.join(root, "does-not-exist")), false);
});

test("changing a source during capture leaves a partial snapshot and prevents reuse", (t) => {
  const { dataDir, location } = fixture(t);
  assert.throws(() => runRecoveryBackup({ dataDir, id: "before-restart", statfs: (root) => {
    fs.writeFileSync(path.join(dataDir, "journal.json"), "concurrent change");
    return fs.statfsSync(root);
  } }), /source-changed/);
  assert.equal(fs.existsSync(location), false);
  assert.equal(fs.existsSync(`${location}.partial`), true);
  assert.throws(() => runRecoveryBackup({ dataDir, id: "before-restart" }), /partial-backup-requires-review/);
  assert.equal(fs.readFileSync(path.join(dataDir, "journal.json"), "utf8"), "concurrent change");
});

test("volume preparation only begins after a completed verified snapshot", (t) => {
  const { dataDir, location } = fixture(t);
  prepareStartup({ dataDir, recoveryBackupId: "before-restart", prepare: () => {
    assert.equal(fs.existsSync(path.join(location, "manifest.json")), true);
    fs.writeFileSync(path.join(dataDir, "journal.json"), "startup mutation");
  } });
  assert.equal(fs.readFileSync(path.join(location, "data", "journal.json"), "utf8"), '[{"id":"old-journal"}]');
});

test("unsafe and reserved identifiers fail without touching the data directory", (t) => {
  const { dataDir } = fixture(t);
  for (const id of ["../escape", "before-restart.partial", "has space", "secret\nvalue"]) {
    assert.throws(() => runRecoveryBackup({ dataDir, id }), /invalid-id/);
  }
  assert.equal(fs.existsSync(path.join(dataDir, ".radar-recovery")), false);
});
