"use strict";

const fs = require("fs");
const { spawnSync } = require("child_process");
const { runRecoveryBackup } = require("./recovery-backup-v1");
const { prepareBackupExport } = require("./private-backup-v1");

function parsePasswdEntry(contents, account) {
  const line = String(contents)
    .split("\n")
    .find((entry) => entry.startsWith(`${account}:`));
  if (!line) throw new Error(`Container account not found: ${account}`);
  const fields = line.split(":");
  const uid = Number(fields[2]);
  const gid = Number(fields[3]);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
    throw new Error(`Invalid uid/gid for container account: ${account}`);
  }
  return { uid, gid };
}

function prepareDataDirectory(dataDir, account = "node") {
  fs.mkdirSync(dataDir, { recursive: true });
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return;

  const { uid, gid } = parsePasswdEntry(fs.readFileSync("/etc/passwd", "utf8"), account);
  try {
    fs.chownSync(dataDir, uid, gid);
    fs.chmodSync(dataDir, 0o770);
  } catch (error) {
    if (!new Set(["EPERM", "EINVAL"]).has(error.code)) throw error;
    fs.chmodSync(dataDir, 0o777);
    console.warn(`777 volume ownership mapping unavailable; write access enabled: ${error.code}`);
  }
  process.setgid(gid);
  process.setuid(uid);
}

function prepareStartup({ dataDir, recoveryBackupId, backupAccessKey = process.env.RADAR_BACKUP_ACCESS_KEY,
  prepare = prepareDataDirectory, prepareExport = prepareBackupExport,
  runtimeAccount = () => parsePasswdEntry(fs.readFileSync("/etc/passwd", "utf8"), "node"),
  privileged = typeof process.getuid === "function" && process.getuid() === 0 }) {
  const backup = runRecoveryBackup({ dataDir, id: recoveryBackupId });
  if (backup.enabled) console.log(`777 recovery backup ${backup.reused ? "verified" : "completed"}: ${backup.id}; ${backup.files} files; ${backup.bytes} bytes; same-volume copy`);
  if (backup.enabled && backupAccessKey && privileged) {
    const account = runtimeAccount();
    const exported = prepareExport({ dataDir, id: recoveryBackupId, accessKey: backupAccessKey, ...account });
    if (exported.enabled) console.log("777 configured recovery snapshot prepared for authenticated export");
  }
  prepare(dataDir);
  return backup;
}

function main({
  env = process.env,
  prepare = prepareStartup,
  runDedupe = () => spawnSync(process.execPath, [require.resolve("./journal-dedupe-v4.js")], { stdio: "inherit" }),
  loadServer = () => require("./server-v4.js")
} = {}) {
  const dataDir = env.RADAR_DATA_DIR || "/data";
  prepare({ dataDir, recoveryBackupId: env.RADAR_RECOVERY_BACKUP_ID, backupAccessKey: env.RADAR_BACKUP_ACCESS_KEY });

  const dedupe = runDedupe();
  if (dedupe.error) throw dedupe.error;
  if (dedupe.status !== 0) {
    const error = new Error("777 prestart journal check failed");
    error.exitCode = dedupe.status || 1;
    throw error;
  }

  // The server owns the HTTP listener, scheduler and shutdown handlers in this
  // same unprivileged process. Do not retain a second Node supervisor in RAM.
  return loadServer();
}

module.exports = { parsePasswdEntry, prepareDataDirectory, prepareStartup, main };

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(`777 entrypoint failed: ${error.message}`);
    process.exit(error.exitCode || 1);
  }
}
