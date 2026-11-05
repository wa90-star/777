const fs = require("node:fs");
const path = require("node:path");
const { isEnergyFuels } = require("./signal-ownership-v1");

// Append-only local handoff evidence, not a delivery acknowledgement. No expiry,
// pruning, public write API or fallback to temporary storage is permitted here.
function createEnergyFuelsHandoff({ dataDir = process.env.RADAR_DATA_DIR || "/data", now = Date.now } = {}) {
  const directory = path.resolve(dataDir);
  const filename = path.join(directory, "energy-fuels-handoff.jsonl");
  let entries = new Map();
  let lastError = null;

  function read() {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dirStat = fs.lstatSync(directory);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error("Invalid handoff directory");
    const current = new Map();
    let stat;
    try { stat = fs.lstatSync(filename); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (stat) {
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid handoff file");
      const content = fs.readFileSync(filename, "utf8");
      if (content && !content.endsWith("\n")) throw new Error("Incomplete handoff record");
      for (const line of content.split("\n").filter(Boolean)) {
        const entry = JSON.parse(line);
        if (entry.schemaVersion !== 1 || !["policy", "equity"].includes(entry.kind) ||
            typeof entry.sourceEventId !== "string" || !entry.sourceEventId ||
            entry.eventId !== entry.kind + ":" + entry.sourceEventId ||
            entry.owner !== "energy-fuels-fokus" || entry.status !== "pending-owner-review" ||
            !Number.isFinite(Date.parse(entry.recordedAt)) || !entry.evidence ||
            entry.deliveryConfirmed !== false || entry.ownerReadConfirmed !== false) {
          throw new Error("Invalid handoff record");
        }
        if (current.has(entry.eventId) && JSON.stringify(current.get(entry.eventId)) !== line) {
          throw new Error("Conflicting immutable handoff identity");
        }
        current.set(entry.eventId, entry);
      }
    }
    entries = current;
  }

  function persistLine(line) {
    const fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY |
      (fs.constants.O_NOFOLLOW || 0), 0o600);
    try {
      if (line) fs.writeFileSync(fd, line);
      // Also sync duplicate retries: a previous write may have succeeded while
      // its fsync failed, in which case readable bytes alone are not a receipt.
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    // Persist the directory entry on the production Linux filesystem. Windows
    // does not support opening directories for fsync through this Node API.
    if (process.platform !== "win32") {
      const dirFd = fs.openSync(directory, "r");
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    }
  }

  function record(kind, sourceEventId, evidence) {
    try {
      if (typeof sourceEventId !== "string" || !sourceEventId.trim()) throw new Error("Missing handoff event identity");
      read();
      const eventId = kind + ":" + sourceEventId;
      if (entries.has(eventId)) {
        persistLine();
        lastError = null;
        return { persisted: true, duplicate: true, eventId, deliveryConfirmed: false };
      }
      const entry = {
        schemaVersion: 1, eventId, sourceEventId, kind, owner: "energy-fuels-fokus",
        status: "pending-owner-review", recordedAt: new Date(now()).toISOString(),
        ownerReadConfirmed: false, deliveryConfirmed: false, evidence
      };
      const line = JSON.stringify(entry) + "\n";
      persistLine(line);
      entries.set(eventId, JSON.parse(line));
      lastError = null;
      return { persisted: true, duplicate: false, eventId, deliveryConfirmed: false };
    } catch (error) {
      // Do not expose filesystem paths or the contents of a failed record.
      lastError = "Energy Fuels handoff could not be persisted: " + (error.code || "invalid-state");
      throw new Error(lastError);
    }
  }

  function recordPolicy(item) {
    return record("policy", item?.id, item);
  }

  function recordEquity(signal) {
    if (!isEnergyFuels(signal?.symbol) || !["LONG", "SHORT"].includes(signal?.direction) ||
        typeof signal?.structural?.id !== "string" || !signal.structural.id.trim()) {
      throw new Error("Invalid Energy Fuels equity handoff");
    }
    // Exchange aliases for the same event/direction share one immutable handoff.
    return record("equity", signal.structural.id + ":" + signal.direction, signal);
  }

  function getState() {
    try { read(); } catch (error) {
      lastError = "Energy Fuels handoff could not be read: " + (error.code || "invalid-state");
    }
    return {
      owner: "energy-fuels-fokus", persistence: "persistent:" + directory,
      pendingCount: entries.size, pending: [...entries.values()],
      lastError, deliveryConfirmed: false, ownerReadConfirmed: false,
      automaticDeletion: false
    };
  }

  return { recordPolicy, recordEquity, getState };
}

module.exports = createEnergyFuelsHandoff;
