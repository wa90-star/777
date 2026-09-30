"use strict";

// A recovery copy on the SAME volume, not an external disaster-recovery backup.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const BACKUP_DIRECTORY = ".radar-recovery";
const NOFOLLOW = fs.constants.O_NOFOLLOW;

function fail(code) { throw new Error(`Recovery backup: ${code}`); }
function exists(location) { return Boolean(fs.lstatSync(location, { throwIfNoEntry: false })); }
function directory(location) {
  const stat = fs.lstatSync(location);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(location) !== location) fail("unsafe-directory");
}

function readFile(location, expected, destination) {
  directory(path.dirname(location));
  const fd = fs.openSync(location, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | NOFOLLOW);
  let output;
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || (expected && (before.ino !== expected.ino || before.dev !== expected.dev))) fail("source-changed");
    if (destination) output = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    let length;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, length));
      if (output !== undefined) {
        let written = 0;
        while (written < length) written += fs.writeSync(output, buffer, written, length - written);
      }
      size += length;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(location, { bigint: true });
    if (before.ino !== current.ino || before.dev !== current.dev || current.isSymbolicLink() ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(size) !== after.size) fail("source-changed");
    if (output !== undefined) fs.fsyncSync(output);
    return { size, sha256: hash.digest("hex") };
  } finally {
    fs.closeSync(fd);
    if (output !== undefined) fs.closeSync(output);
  }
}

function inventory(root, excludeBackups = false) {
  directory(root);
  const entries = [];
  function walk(parent, relative = "") {
    directory(parent);
    for (const name of fs.readdirSync(parent).sort()) {
      if (!relative && excludeBackups && name === BACKUP_DIRECTORY) continue;
      const location = path.join(parent, name);
      const rel = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(location, { bigint: true });
      const metadata = { path: rel, mode: Number(stat.mode & 0o777n), uid: Number(stat.uid), gid: Number(stat.gid) };
      if (stat.isSymbolicLink()) fail("symlink-not-allowed");
      if (stat.isDirectory()) {
        entries.push({ ...metadata, type: "directory" });
        walk(location, rel);
      } else if (stat.isFile()) {
        entries.push({ ...metadata, type: "file", ...readFile(location, stat) });
      } else fail("special-file-not-allowed");
    }
  }
  walk(root);
  return entries;
}

function comparable(entries) {
  return entries.map(({ path: name, type, size, sha256 }) => ({ path: name, type, ...(type === "file" ? { size, sha256 } : {}) }));
}

function verifyCompleted(location, id) {
  directory(location);
  if (JSON.stringify(fs.readdirSync(location).sort()) !== JSON.stringify(["data", "manifest.json"])) fail("corrupt-backup");
  const manifestPath = path.join(location, "manifest.json");
  if (!fs.lstatSync(manifestPath).isFile()) fail("corrupt-manifest");
  const fd = fs.openSync(manifestPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | NOFOLLOW);
  let manifest;
  try {
    if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size > 16 * 1024 * 1024) fail("corrupt-manifest");
    manifest = JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally { fs.closeSync(fd); }
  if (manifest.version !== 1 || manifest.id !== id || !Array.isArray(manifest.entries) ||
      manifest.bytes !== manifest.entries.reduce((sum, entry) => sum + (entry.size || 0), 0) ||
      JSON.stringify(comparable(manifest.entries)) !== JSON.stringify(comparable(inventory(path.join(location, "data"))))) fail("corrupt-backup");
  return manifest;
}

function syncDirectory(location) {
  const fd = fs.openSync(location, fs.constants.O_RDONLY | NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function runRecoveryBackup({ dataDir = process.env.RADAR_DATA_DIR || "/data", id = process.env.RADAR_RECOVERY_BACKUP_ID,
  statfs = fs.statfsSync } = {}) {
  // No reads, writes, chmod or startup changes unless explicitly enabled.
  if (id === undefined || id === "") return { enabled: false };
  try {
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) || id.endsWith(".partial")) fail("invalid-id");
    const root = path.resolve(dataDir);
    directory(root);
    const backupRoot = path.join(root, BACKUP_DIRECTORY);
    const completed = path.join(backupRoot, id);
    const partial = path.join(backupRoot, `${id}.partial`);
    if (exists(backupRoot)) {
      directory(backupRoot);
      if (fs.readdirSync(backupRoot).some((name) => name.endsWith(".partial"))) fail("partial-backup-requires-review");
      if (exists(completed)) {
        const manifest = verifyCompleted(completed, id);
        return { enabled: true, reused: true, id, files: manifest.entries.filter((entry) => entry.type === "file").length, bytes: manifest.bytes };
      }
    }
    const entries = inventory(root, true);
    const bytes = entries.reduce((sum, entry) => sum + (entry.size || 0), 0);
    const space = statfs(root);
    const block = Number(space.bsize);
    const available = Number(space.bavail) * block;
    const required = entries.reduce((sum, entry) => sum + (entry.type === "file" ? Math.ceil(entry.size / block) * block : block), 0) + 1048576 + entries.length * 4096;
    if (!Number.isFinite(available) || !Number.isFinite(required) || block <= 0 || available < required) fail("insufficient-space");

    if (!exists(backupRoot)) fs.mkdirSync(backupRoot, { mode: 0o700 });
    directory(backupRoot);
    fs.mkdirSync(partial, { mode: 0o700 }); // Exclusive; never repair/delete a partial copy automatically.
    const copyRoot = path.join(partial, "data");
    fs.mkdirSync(copyRoot, { mode: 0o700 });
    for (const entry of entries) {
      const destination = path.join(copyRoot, entry.path);
      if (entry.type === "directory") fs.mkdirSync(destination, { mode: 0o700 });
      else {
        const original = path.join(root, entry.path);
        const copied = readFile(original, fs.lstatSync(original, { bigint: true }), destination);
        if (copied.size !== entry.size || copied.sha256 !== entry.sha256) fail("source-changed");
      }
    }
    // A changed/deleted/new source file invalidates the whole snapshot.
    if (JSON.stringify(comparable(entries)) !== JSON.stringify(comparable(inventory(root, true)))) fail("source-changed");
    const manifest = { version: 1, id, createdAt: new Date().toISOString(), bytes, entries };
    const manifestFd = fs.openSync(path.join(partial, "manifest.json"), "wx", 0o600);
    try { fs.writeFileSync(manifestFd, `${JSON.stringify(manifest, null, 2)}\n`); fs.fsyncSync(manifestFd); } finally { fs.closeSync(manifestFd); }
    verifyCompleted(partial, id);
    for (const entry of entries.filter((entry) => entry.type === "directory").reverse()) syncDirectory(path.join(copyRoot, entry.path));
    syncDirectory(copyRoot);
    syncDirectory(partial);
    fs.renameSync(partial, completed);
    syncDirectory(backupRoot);
    syncDirectory(root);
    return { enabled: true, reused: false, id, files: entries.filter((entry) => entry.type === "file").length, bytes };
  } catch (error) {
    if (String(error.message).startsWith("Recovery backup: ")) throw error;
    // Never include payloads, credentials, paths or filenames in startup logs.
    throw new Error(`Recovery backup: ${/^[A-Z0-9_]+$/.test(error.code || "") ? error.code : "invalid-or-incomplete-backup"}`);
  }
}

module.exports = { runRecoveryBackup };
