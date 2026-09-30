"use strict";

const fs = require("fs");
const { spawn, spawnSync } = require("child_process");
const { runRecoveryBackup } = require("./recovery-backup-v1");

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

function prepareStartup({ dataDir, recoveryBackupId, prepare = prepareDataDirectory }) {
  const backup = runRecoveryBackup({ dataDir, id: recoveryBackupId });
  if (backup.enabled) console.log(`777 recovery backup ${backup.reused ? "verified" : "completed"}: ${backup.id}; ${backup.files} files; ${backup.bytes} bytes; same-volume copy`);
  prepare(dataDir);
  return backup;
}

function main() {
  const dataDir = process.env.RADAR_DATA_DIR || "/data";
  prepareStartup({ dataDir, recoveryBackupId: process.env.RADAR_RECOVERY_BACKUP_ID });

  const dedupe = spawnSync(process.execPath, ["journal-dedupe-v4.js"], { stdio: "inherit" });
  if (dedupe.error) throw dedupe.error;
  if (dedupe.status !== 0) process.exit(dedupe.status || 1);

  const server = spawn(process.execPath, ["server-v4.js"], { stdio: "inherit" });
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      server.kill(signal);
    });
  }
  server.on("error", (error) => {
    console.error(`777 entrypoint failed: ${error.message}`);
    process.exit(1);
  });
  server.on("exit", (code) => process.exit(code ?? (stopping ? 0 : 1)));
}

module.exports = { parsePasswdEntry, prepareDataDirectory, prepareStartup };

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(`777 entrypoint failed: ${error.message}`);
    process.exit(1);
  }
}
