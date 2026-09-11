// 777 startup journal dedupe guard v4.8.2
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.RADAR_DATA_DIR || "/data";
const JOURNAL_FILE = path.join(DATA_DIR, "signal-journal.json");
const BACKUP_FILE = path.join(DATA_DIR, "signal-journal.pre-v481-dedupe.json");
const WINDOW_MS = 8 * 60 * 60 * 1000;
const SCORE_ESCALATION = 15;
const MOVE_ESCALATION_PCT = 2;

function safeTime(value) {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

function types(entry) {
  return Array.isArray(entry?.confirmationTypes) ? entry.confirmationTypes.map(String) : [];
}

function materiallyEscalated(next, prior) {
  if (Number(next?.correlationCount || 0) > Number(prior?.correlationCount || 0)) return true;
  if (Number(next?.score || 0) >= Number(prior?.score || 0) + SCORE_ESCALATION) return true;
  if (Math.abs(Number(next?.percentChangeAtAlert || 0)) >= Math.abs(Number(prior?.percentChangeAtAlert || 0)) + MOVE_ESCALATION_PCT) return true;
  const priorTypes = new Set(types(prior));
  return types(next).some((type) => !priorTypes.has(type));
}

function dedupe(entries) {
  const ordered = [...entries]
    .filter((x) => x?.id && x?.symbol && x?.direction && safeTime(x.createdAt))
    .sort((a, b) => safeTime(a.createdAt) - safeTime(b.createdAt));

  const kept = [];
  const latestByKey = new Map();
  let removed = 0;

  for (const entry of ordered) {
    const key = `${entry.symbol}:${entry.direction}`;
    const prior = latestByKey.get(key);
    const withinWindow = prior && safeTime(entry.createdAt) - safeTime(prior.createdAt) < WINDOW_MS;

    if (withinWindow && !materiallyEscalated(entry, prior)) {
      removed += 1;
      continue;
    }

    kept.push(entry);
    latestByKey.set(key, entry);
  }

  kept.sort((a, b) => safeTime(b.createdAt) - safeTime(a.createdAt));
  return { kept, removed };
}

function run() {
  if (!fs.existsSync(JOURNAL_FILE)) {
    console.log("777 JOURNAL DEDUPE skipped: journal file not found");
    return;
  }

  const raw = fs.readFileSync(JOURNAL_FILE, "utf8");
  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed) ? parsed : parsed.entries;
  if (!Array.isArray(entries)) throw new Error("Journal entries are not an array");

  const { kept, removed } = dedupe(entries);
  if (!removed) {
    console.log(`777 JOURNAL DEDUPE clean: ${kept.length} entries`);
    return;
  }

  if (!fs.existsSync(BACKUP_FILE)) fs.writeFileSync(BACKUP_FILE, raw);

  const next = {
    version: Number(parsed?.version || 3),
    savedAt: new Date().toISOString(),
    entries: kept
  };
  const tmp = `${JOURNAL_FILE}.dedupe.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));

  const check = JSON.parse(fs.readFileSync(tmp, "utf8"));
  if (!Array.isArray(check.entries) || check.entries.length !== kept.length) {
    fs.unlinkSync(tmp);
    throw new Error("Dedupe validation failed");
  }

  fs.renameSync(tmp, JOURNAL_FILE);
  console.log(`777 JOURNAL DEDUPE removed ${removed}; kept ${kept.length}; backup ${BACKUP_FILE}`);
}

try {
  run();
} catch (error) {
  console.error(`777 JOURNAL DEDUPE ERROR: ${error.message}`);
  process.exitCode = 1;
}
