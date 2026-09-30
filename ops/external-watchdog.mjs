// Prepared, not activated. Run on a host independent of the Radar host.
// One cycle only; the optional systemd timer supplies scheduling and flock.
// Telegram cannot guarantee exactly-once delivery after a lost acknowledgement.
// Endpoint availability deterioration alerts immediately. Other cause changes
// inside the same ongoing incident are included in the six-hour reminder.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { probe } from "./health-check.mjs";
import telegram from "../telegram-transport-v1.js";

const { createTelegramTransport, redactError } = telegram;
const REMINDER_MS = 6 * 60 * 60000;
const RETRY_BASE_MS = 60000;
const RETRY_MAX_MS = 15 * 60000;

function initialState(target) {
  return { version: 1, target, checkedAt: null, healthyStreak: 0, incident: null,
    delivery: { attempts: 0, nextAttemptAt: 0, lastError: null } };
}

function privateStore(stateFile) {
  const directory = path.dirname(path.resolve(stateFile));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dir = fs.lstatSync(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || fs.realpathSync(directory) !== directory || (dir.mode & 0o077)) {
    throw new Error("Watchdog state directory must be private and not a symlink");
  }
  function load(target) {
    const existing = fs.lstatSync(stateFile, { throwIfNoEntry: false });
    if (!existing) return initialState(target);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("Invalid watchdog state file");
    const descriptor = fs.openSync(stateFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 1024 * 1024) throw new Error("Invalid watchdog state file");
      const state = JSON.parse(fs.readFileSync(descriptor, "utf8"));
      const date = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
      const optionalDate = (value) => value == null || date(value);
      if (state.version !== 1 || state.target !== target || !Number.isInteger(state.healthyStreak) ||
          state.healthyStreak < 0 || state.healthyStreak > 2 || !Number.isInteger(state.delivery?.attempts) ||
          state.delivery.attempts < 0 || !Number.isFinite(state.delivery.nextAttemptAt) || state.delivery.nextAttemptAt < 0 ||
          !optionalDate(state.checkedAt) || !(state.delivery.lastError === null || typeof state.delivery.lastError === "string") ||
          !(state.incident === null || (typeof state.incident?.id === "string" &&
            date(state.incident.firstSeenAt) && date(state.incident.lastSeenAt) &&
            optionalDate(state.incident.outageDeliveredAt) && optionalDate(state.incident.lastOutageNoticeAt) &&
            Boolean(state.incident.outageDeliveredAt) === Boolean(state.incident.lastOutageNoticeAt) &&
            typeof state.incident.unreachable === "boolean" && typeof state.incident.escalationPending === "boolean" &&
            optionalDate(state.incident.recoveryObservedAt) && Array.isArray(state.incident.errors) &&
            state.incident.errors.every((error) => typeof error === "string")))) {
        throw new Error("Invalid or different-target watchdog state; review required");
      }
      return state;
    } finally { fs.closeSync(descriptor); }
  }
  function save(state) {
    const temporary = path.join(directory, `.watchdog-${randomUUID()}.tmp`);
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, stateFile);
      const parent = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  return { load, save };
}

function validateTarget(baseUrl) {
  const target = new URL(baseUrl);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.search || target.hash) {
    throw new Error("Watchdog requires an explicit HTTP(S) target without credentials or query");
  }
  return target.origin;
}

export async function runWatchdog({
  baseUrl, stateFile, token, chatId, now = Date.now, fetchImpl = globalThis.fetch,
  probeOptions = {}, telegramTimeoutMs = 8000
}) {
  const target = validateTarget(baseUrl);
  if (!stateFile || !token || !chatId) throw new Error("Watchdog state path and Telegram credentials are required");
  const redact = (error) => redactError(error, [token, chatId]);
  const storage = privateStore(path.resolve(stateFile));
  const state = storage.load(target);
  let health;
  try {
    // The exact existing health contract is reused; no relaxed source thresholds.
    health = await probe({ ...probeOptions, baseUrl: target });
  } catch (error) {
    health = { ok: false, errors: [`probe-error:${redact(error)}`] };
  }
  const timestamp = now();
  const iso = new Date(timestamp).toISOString();
  state.checkedAt = iso;
  state.healthyStreak = health.ok ? Math.min(2, state.healthyStreak + 1) : 0;
  if (!health.ok) {
    state.incident ||= { id: randomUUID(), firstSeenAt: iso, lastSeenAt: iso, errors: [],
      outageDeliveredAt: null, lastOutageNoticeAt: null, unreachable: false, escalationPending: false };
    state.incident.lastSeenAt = iso;
    state.incident.recoveryObservedAt = null;
    state.incident.errors = (health.errors || ["unknown-health-failure"]).slice(0, 8).map(redact);
    const unreachable = state.incident.errors.some((error) => /^attempt \d+: \/api\/(?:status|oil-monitor):/.test(error));
    if (unreachable && !state.incident.unreachable && state.incident.outageDeliveredAt) state.incident.escalationPending = true;
    if (!unreachable) state.incident.escalationPending = false;
    state.incident.unreachable = unreachable;
  }
  let kind = null;
  const incident = state.incident;
  if (incident && health.ok) {
    incident.recoveryObservedAt ||= iso;
    incident.unreachable = false;
    incident.escalationPending = false;
  }
  if (incident && !health.ok && (!incident.lastOutageNoticeAt ||
      incident.escalationPending || timestamp - Date.parse(incident.lastOutageNoticeAt) >= REMINDER_MS)) kind = "outage";
  if (incident && health.ok && state.healthyStreak >= 2) {
    kind = incident.outageDeliveredAt ? "recovery" : "resolved-outage";
  }
  storage.save(state); // Durable intent before attempting an external notification.
  const result = { checkedAt: iso, target, healthy: health.ok, incidentOpen: Boolean(state.incident), notification: "none" };
  if (!kind) return result;
  if (timestamp < state.delivery.nextAttemptAt) return { ...result, notification: "deferred", error: state.delivery.lastError };

  state.delivery.attempts += 1;
  state.delivery.nextAttemptAt = timestamp + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(state.delivery.attempts - 1, 10));
  storage.save(state);
  const message = kind === "outage" ? [
    "RADAR-AUSFALL — externe Überwachung",
    `Ziel: ${target}`, `Prüfung: ${iso}`, `Erstmals erkannt: ${incident.firstSeenAt}`,
    incident.escalationPending ? "Verschlechterung: Mindestens ein Status-Endpunkt liefert keine gültige erfolgreiche Antwort."
      : incident.outageDeliveredAt ? "Erinnerung: Der Fehler besteht weiterhin." : "Der Radar besteht die vollständige Zustandsprüfung nicht.",
    ...incident.errors, `Incident: ${incident.id}`
  ].join("\n").slice(0, 3800) : kind === "resolved-outage" ? [
    "RADAR: AUSFALL NACHTRÄGLICH GEMELDET — inzwischen behoben",
    `Ziel: ${target}`, `Prüfung: ${iso}`, `Erstmals erkannt: ${incident.firstSeenAt}`,
    `Zuletzt fehlerhaft geprüft: ${incident.lastSeenAt}`, `Erste gesunde Folgeprüfung: ${incident.recoveryObservedAt}`,
    "Die Zustellung war bisher nicht bestätigt. Zwei gesunde Folgeprüfungen liegen jetzt vor.",
    ...incident.errors, `Incident: ${incident.id}`
  ].join("\n").slice(0, 3800) : [
    "RADAR WIEDER ERREICHBAR — externe Überwachung",
    `Ziel: ${target}`, `Prüfung: ${iso}`,
    "Zwei aufeinanderfolgende vollständige Zustandsprüfungen waren erfolgreich.",
    `Zuvor gemeldeter Ausfall seit: ${incident.firstSeenAt}`, `Incident: ${incident.id}`
  ].join("\n");
  const transport = createTelegramTransport({ token, chatId, fetchImpl, now, timeoutMs: telegramTimeoutMs });
  let receipt;
  try {
    receipt = await transport.send(message);
  } catch (error) {
    state.delivery.lastError = redact(error);
    if (Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0) {
      state.delivery.nextAttemptAt = Math.max(state.delivery.nextAttemptAt, now() + error.retryAfterMs);
    }
    storage.save(state);
    return { ...result, notification: "failed", error: state.delivery.lastError };
  }
  // Only the confirmed transport receipt can change delivered state.
  state.delivery = { attempts: 0, nextAttemptAt: 0, lastError: null };
  if (kind === "outage") {
    incident.outageDeliveredAt ||= new Date(now()).toISOString();
    incident.lastOutageNoticeAt = new Date(now()).toISOString();
    incident.escalationPending = false;
    incident.lastTelegramMessageId = receipt.message_id;
  } else state.incident = null;
  storage.save(state);
  return { ...result, incidentOpen: Boolean(state.incident), notification: `${kind}-sent` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  try {
    const result = await runWatchdog({ baseUrl: process.env.RADAR_BASE_URL,
      stateFile: process.env.RADAR_WATCHDOG_STATE_FILE || "/var/lib/radar-watchdog/state.json", token, chatId });
    console.log(JSON.stringify(result));
    process.exitCode = result.healthy && !["failed", "deferred"].includes(result.notification) ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify({ monitorError: redactError(error, [token, chatId]) }));
    process.exitCode = 1;
  }
}
