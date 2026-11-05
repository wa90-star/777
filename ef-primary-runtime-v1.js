"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { redactError } = require("./telegram-transport-v1");

function formatNotice(notice) {
  const title = String(notice.title || "Neue Originalquelle").replace(/[\r\n]+/g, " ").slice(0, 900);
  const kind = notice.kind === "SOURCE_UPDATED" ? "Geänderte Originalmeldung" : notice.kind === "RISK_REVIEW_REQUIRED" ? "Neue Risiko-Prüfung" : "Neu erfasste Originalmeldung";
  const topics = (notice.classification?.topics || []).join(", ");
  return [
    `ENERGY FUELS | ${kind}`,
    title,
    `Quelle: ${notice.publisher || notice.sourceId}`,
    notice.publicationTimeStatus === "FUTURE_DATED_UNVERIFIED" ? `Quellenzeit widersprüchlich (liegt in der Zukunft): ${notice.publishedAt}` : notice.publishedAt ? `Quellenzeit: ${notice.publishedAt}` : "Quellenzeit: nicht vollständig bekannt",
    `Vom Radar erkannt: ${notice.createdAt}`,
    topics ? `Themen: ${topics}` : null,
    notice.kind === "RISK_REVIEW_REQUIRED" ? "Externe Risiko-Einschätzung; noch nicht unabhängig bestätigt." : "Auswirkung auf Energy Fuels und wirtschaftliche Bedeutung noch zu prüfen.",
    notice.kind === "RISK_REVIEW_REQUIRED" ? `These: ${String(notice.thesisId || "unbekannt").slice(0,120)} · Entscheidungsstand: ${String(notice.decisionVersion || "unbekannt").slice(0,120)}` : null,
    notice.kind === "RISK_REVIEW_REQUIRED" ? `Begründung: ${String(notice.explanation || "nicht angegeben").slice(0,900)}` : null,
    "Keine Handelsfreigabe. Keine automatische Order.",
    notice.url,
    `Hinweis-ID: ${notice.id}`
  ].filter(Boolean).join("\n").slice(0, 3900);
}

function createEfPrimaryRuntime({
  enabled = process.env.RADAR_EF_PRIMARY_ENABLED === "true",
  directory = path.join(process.env.RADAR_DATA_DIR || "/data", "ef-primary"),
  intervalMinutes = Number(process.env.EF_POLL_MINUTES || 10),
  transport,
  onSourceNotices,
  moduleLoader = () => import(pathToFileURL(path.join(__dirname, "ef-primary", "collector.mjs")).href),
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  logger = console
} = {}) {
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 2 || intervalMinutes > 60) throw new Error("EF interval must be 2 to 60 minutes");
  const state = { enabled, running: false, intervalMinutes, startedAt: null, lastCollectionAt: null,
    lastCollectionError: null, lastDeliveryAt: null, lastDeliveryError: null, retryAt: null,
    deliveryMode: "AT_LEAST_ONCE_PROVIDER_RECEIPT", deliveryLimitation: "Nach Timeout oder Absturz vor gespeicherter Quittung ist eine Doppelmeldung möglich; gleiche Hinweis-ID kennzeichnet denselben Hinweis.", deviceReadConfirmed: false, tradePermission: false,
    nativeFokusAutomationConnected: false, status: null };
  let collector, timer, stopped = true, inFlight = null, lastCollectionMs = null;
  let deliveryPaused = false;
  const stamp = () => new Date(now()).toISOString();
  async function refreshStatus() { state.status = await collector.readStatus(directory); }
  async function run({ forceCollection = false } = {}) {
    if (!enabled || stopped) return;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      state.running = true;
      try {
        collector ||= await moduleLoader();
        if (forceCollection || lastCollectionMs === null || now() - lastCollectionMs >= intervalMinutes * 60000) {
          lastCollectionMs = now();
          try {
            const result = await collector.collect({ directory, now: stamp() });
            state.lastCollectionAt = result.at || stamp();
            state.lastCollectionError = result.status === "OK" ? null : "Mindestens eine Quelle ist eingeschränkt; siehe Quellenstatus.";
          } catch (error) { state.lastCollectionError = redactError(error); }
        }
        await refreshStatus();
        if (onSourceNotices) {
          try {
            const notices = await collector.listPendingNotices(directory, { limit: 30, actionableOnly: true });
            Promise.resolve(onSourceNotices(notices)).catch(() => logger.error("EF optional internal context unavailable; source delivery remains independent"));
          } catch { logger.error("EF optional internal context unavailable; source delivery remains independent"); }
        }
        if (deliveryPaused || !transport?.configured() || (state.retryAt && now() < Date.parse(state.retryAt))) return;
        const pending = await collector.listPendingNotices(directory, { limit: 10, actionableOnly: true });
        for (const notice of pending) {
          if (stopped) break;
          let receipt;
          try {
            receipt = await transport.send(formatNotice(notice));
            if (!Number.isInteger(receipt?.message_id) || receipt.message_id <= 0) throw new Error("Telegram delivery receipt missing");
          } catch (error) {
            state.lastDeliveryError = redactError(error);
            const delay = Math.max(60000, Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : 60000);
            state.retryAt = new Date(now() + Math.min(delay, 86400000)).toISOString();
            break;
          }
          try {
            await collector.acknowledgeDelivery({ directory, noticeId: notice.id,
              receipt: { provider: "telegram", messageId: String(receipt.message_id), deliveredAt: stamp() } });
            state.lastDeliveryAt = stamp(); state.lastDeliveryError = null; state.retryAt = null;
          } catch (error) {
            // The provider accepted this message, but persistence failed. Stop this process's
            // sender; do not repeatedly resend an accepted notice while the disk is failing.
            deliveryPaused = true;
            state.lastDeliveryError = `Provider receipt could not be stored; sender paused: ${redactError(error)}`;
            break;
          }
          await pause(1100);
        }
        await refreshStatus();
      } catch (error) {
        state.lastCollectionError = redactError(error);
        logger.error("EF primary runtime:", state.lastCollectionError);
      } finally { state.running = false; }
    })();
    try { return await inFlight; } finally { inFlight = null; }
  }
  function schedule() {
    if (stopped) return;
    timer = setTimer(async () => { await run(); schedule(); }, 60000);
    timer?.unref?.();
  }
  async function start() {
    if (!enabled || !stopped) return;
    stopped = false; state.startedAt = stamp();
    await run({ forceCollection: true }); schedule();
  }
  async function stop() { stopped = true; clearTimer(timer); await inFlight; }
  const getState = () => ({ ...state, running: state.running, deliveryPaused,
    configured: Boolean(transport?.configured()), sourceScope: "Ten selected primary sources; finite listing windows, not exhaustive coverage" });
  async function context() {
    if (!enabled || !collector) return { ...getState(), pending: [] };
    return { ...getState(), pending: await collector.listPendingNotices(directory, { limit: 30, actionableOnly: false }) };
  }
  return { start, stop, run, getState, context };
}

module.exports = { createEfPrimaryRuntime, formatNotice };
