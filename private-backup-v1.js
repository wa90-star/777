"use strict";

// Authenticated, bounded read-only export of an already completed snapshot.
// Never creates a backup and never opens the live data files or environment.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const MAX_EXPORT_BYTES = 100_000_000;
const MAX_MANIFEST_BYTES = 2_000_000;
const CHUNK_BYTES = 48 * 1024;
const READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0);
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const validKey = value => typeof value === "string" && Buffer.byteLength(value) >= 32 && Buffer.byteLength(value) <= 512;
function fail() { throw new Error("private-backup-unavailable"); }
function validId(id) { return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) && !id.endsWith(".partial"); }
function relativeName(value) {
  if (typeof value !== "string" || !value || value.length > 1024 || /[\\:\x00-\x1f]/.test(value)) fail();
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) fail();
  // These are credentials, not radar recovery data. Refuse the entire export
  // instead of silently omitting files while claiming a complete snapshot.
  if (parts.some(part => /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)(?:\.pub)?)$/i.test(part) || /\.(?:pem|key|p12|pfx)$/i.test(part))) fail();
  return value;
}
function directory(location) {
  const stat = fs.lstatSync(location, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(location) !== location) fail();
  return { location, stat };
}
function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function openFile(record) {
  directory(path.dirname(record.location));
  const fd = fs.openSync(record.location, READ_FLAGS);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || !sameFile(stat, record.stat)) fail();
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}
function checkAfterRead(fd, record) {
  const current = fs.lstatSync(record.location, { bigint: true });
  if (current.isSymbolicLink() || !sameFile(fs.fstatSync(fd, { bigint: true }), record.stat) || !sameFile(current, record.stat)) fail();
}
function recordFor(location) {
  const stat = fs.lstatSync(location, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) fail();
  return { location, stat };
}
function verifyFile(record, expected) {
  const fd = openFile(record), hash = crypto.createHash("sha256"), chunk = Buffer.allocUnsafe(CHUNK_BYTES);
  let bytes = 0;
  try {
    for (;;) {
      const length = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!length) break;
      bytes += length; if (bytes > expected.size) fail();
      hash.update(chunk.subarray(0, length));
    }
    checkAfterRead(fd, record);
    if (bytes !== expected.size || hash.digest("hex") !== expected.sha256) fail();
  } finally { fs.closeSync(fd); }
}
function inspectSnapshot(dataDir, id) {
  if (!validId(id)) fail();
  const root = directory(path.resolve(dataDir));
  const parent = directory(path.join(root.location, ".radar-recovery"));
  const snapshot = directory(path.join(parent.location, id));
  if (JSON.stringify(fs.readdirSync(snapshot.location).sort()) !== JSON.stringify(["data", "manifest.json"])) fail();
  const data = directory(path.join(snapshot.location, "data"));
  const manifestFile = recordFor(path.join(snapshot.location, "manifest.json"));
  if (manifestFile.stat.size > BigInt(MAX_MANIFEST_BYTES)) fail();
  const manifestFd = openFile(manifestFile);
  let raw;
  try { raw = fs.readFileSync(manifestFd); checkAfterRead(manifestFd, manifestFile); }
  finally { fs.closeSync(manifestFd); }
  const manifest = JSON.parse(raw.toString("utf8"));
  if (manifest.version !== 1 || manifest.id !== id || !Array.isArray(manifest.entries) || manifest.entries.length > 10000 ||
      !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 0 || manifest.bytes > MAX_EXPORT_BYTES) fail();
  const expected = new Map(); let bytes = 0;
  for (const entry of manifest.entries) {
    relativeName(entry.path);
    if (expected.has(entry.path) || !["file", "directory"].includes(entry.type)) fail();
    if (entry.type === "file") {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) fail();
      bytes += entry.size; if (bytes > MAX_EXPORT_BYTES) fail();
    }
    expected.set(entry.path, entry);
  }
  if (bytes !== manifest.bytes) fail();
  const files = [], directories = [data]; let count = 0;
  function walk(folder, prefix = "") {
    for (const name of fs.readdirSync(folder.location).sort()) {
      const relative = relativeName(prefix ? `${prefix}/${name}` : name);
      const entry = expected.get(relative); if (!entry) fail(); count++;
      const location = path.join(folder.location, name);
      if (entry.type === "directory") {
        const child = directory(location); directories.push(child); walk(child, relative);
      } else {
        const record = recordFor(location);
        if (record.stat.size !== BigInt(entry.size)) fail();
        files.push({ ...record, entry });
      }
    }
  }
  walk(data);
  if (count !== expected.size) fail();
  const result = { id, root, parent, snapshot, data, manifestFile, raw, manifest, files, directories, manifestSha256: digest(raw) };
  if (wireSize(result) > MAX_EXPORT_BYTES) fail();
  for (const file of files) verifyFile(file, file.entry);
  return result;
}
const line = object => JSON.stringify(object) + "\n";
function header(snapshot) { return { type: "header", format: "radar-recovery-ndjson", version: 1, id: snapshot.id }; }
function manifestRecord(snapshot) { return { type: "manifest", bytes: snapshot.raw.length, sha256: snapshot.manifestSha256, data: snapshot.raw.toString("base64") }; }
function fileStart(entry) { return { type: "file", path: entry.path, bytes: entry.size, sha256: entry.sha256 }; }
function fileEnd(entry) { return { type: "file-end", path: entry.path, bytes: entry.size, sha256: entry.sha256 }; }
function complete(snapshot) { return { type: "complete", id: snapshot.id, files: snapshot.files.length, bytes: snapshot.manifest.bytes, manifestSha256: snapshot.manifestSha256 }; }
function wireSize(snapshot) {
  let size = Buffer.byteLength(line(header(snapshot))) + Buffer.byteLength(line(manifestRecord(snapshot))) + Buffer.byteLength(line(complete(snapshot)));
  for (const entry of snapshot.manifest.entries) {
    if (entry.type === "directory") { size += Buffer.byteLength(line({ type: "directory", path: entry.path })); continue; }
    size += Buffer.byteLength(line(fileStart(entry))) + Buffer.byteLength(line(fileEnd(entry)));
    for (let offset = 0; offset < entry.size; offset += CHUNK_BYTES) {
      size += Buffer.byteLength(line({ type: "chunk", path: entry.path, offset, data: "" })) + 4 * Math.ceil(Math.min(CHUNK_BYTES, entry.size - offset) / 3);
    }
  }
  return size;
}
function respond(res, status, code) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify({ error: code }));
}
function drained(res) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { res.off("drain", ready); res.off("close", closed); res.off("error", closed); };
    const ready = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(new Error("download-interrupted")); };
    res.once("drain", ready); res.once("close", closed); res.once("error", closed);
    if (res.destroyed) closed();
  });
}
function createPrivateBackupHandler({ dataDir = process.env.RADAR_DATA_DIR || "/data", id = process.env.RADAR_RECOVERY_BACKUP_ID,
  accessKey = process.env.RADAR_BACKUP_ACCESS_KEY } = {}) {
  const enabled = validKey(accessKey) && validId(id);
  const expected = enabled ? crypto.createHash("sha256").update(accessKey).digest() : null;
  let running = false;
  return async function privateBackup(req, res) {
    if (!enabled) return respond(res, 404, "not-found");
    const authorization = req.headers.authorization;
    const supplied = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const candidate = crypto.createHash("sha256").update(supplied).digest();
    if (!supplied || !crypto.timingSafeEqual(candidate, expected)) return respond(res, 401, "unauthorized");
    if (req.method !== "GET") return respond(res, 405, "method-not-allowed");
    if (req.url !== "/api/private-backup") return respond(res, 400, "invalid-request");
    if (running) return respond(res, 429, "download-in-progress");
    running = true;
    let timer, sent = 0;
    try {
      const snapshot = inspectSnapshot(dataDir, id);
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `attachment; filename="radar-recovery-${id}.ndjson"` });
      timer = setTimeout(() => res.destroy(), 120000); timer.unref?.();
      res.setTimeout?.(30000, () => res.destroy());
      async function emit(object) {
        const encoded = line(object); sent += Buffer.byteLength(encoded);
        if (sent > MAX_EXPORT_BYTES || res.destroyed) fail();
        if (!res.write(encoded)) await drained(res);
      }
      await emit(header(snapshot)); await emit(manifestRecord(snapshot));
      const byName = new Map(snapshot.files.map(file => [file.entry.path, file]));
      for (const entry of snapshot.manifest.entries) {
        if (entry.type === "directory") { await emit({ type: "directory", path: entry.path }); continue; }
        const record = byName.get(entry.path), fd = openFile(record), chunk = Buffer.allocUnsafe(CHUNK_BYTES);
        const hash = crypto.createHash("sha256"); let offset = 0;
        try {
          await emit(fileStart(entry));
          for (;;) {
            const length = fs.readSync(fd, chunk, 0, chunk.length, null); if (!length) break;
            if (offset + length > entry.size) fail();
            const part = chunk.subarray(0, length); hash.update(part);
            await emit({ type: "chunk", path: entry.path, offset, data: part.toString("base64") }); offset += length;
          }
          checkAfterRead(fd, record);
          if (offset !== entry.size || hash.digest("hex") !== entry.sha256) fail();
        } finally { fs.closeSync(fd); }
        await emit(fileEnd(entry));
      }
      await emit(complete(snapshot)); res.end();
    } catch {
      // No paths, file content, credentials or underlying exception text leave
      // the handler. Missing completion means an invalid/truncated download.
      if (res.headersSent) res.destroy(); else respond(res, 409, "private-backup-unavailable");
    } finally { clearTimeout(timer); running = false; }
  };
}

function prepareBackupExport({ dataDir, id, accessKey, uid, gid }) {
  if (!validKey(accessKey)) return { enabled: false };
  if (!Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid) || gid < 0) fail();
  const snapshot = inspectSnapshot(dataDir, id); // Verify everything before granting access.
  for (const record of [...snapshot.files, snapshot.manifestFile]) {
    const fd = openFile(record);
    try { fs.fchownSync(fd, uid, gid); fs.fchmodSync(fd, 0o600); } finally { fs.closeSync(fd); }
  }
  for (const record of [...snapshot.directories].reverse().concat(snapshot.snapshot)) {
    directory(record.location);
    const fd = fs.openSync(record.location, READ_FLAGS | (fs.constants.O_DIRECTORY || 0));
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (stat.ino !== record.stat.ino || stat.dev !== record.stat.dev || !stat.isDirectory()) fail();
      fs.fchownSync(fd, uid, gid); fs.fchmodSync(fd, 0o700);
    } finally { fs.closeSync(fd); }
  }
  // Group search permission only on the common parent. Other snapshots retain
  // their ownership/modes; the runtime cannot list this parent directory.
  directory(snapshot.parent.location);
  const fd = fs.openSync(snapshot.parent.location, READ_FLAGS | (fs.constants.O_DIRECTORY || 0));
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (stat.ino !== snapshot.parent.stat.ino || stat.dev !== snapshot.parent.stat.dev) fail();
    fs.fchownSync(fd, Number(stat.uid), gid); fs.fchmodSync(fd, 0o710);
  } finally { fs.closeSync(fd); }
  return { enabled: true, files: snapshot.files.length, bytes: snapshot.manifest.bytes };
}

module.exports = { createPrivateBackupHandler, prepareBackupExport };
