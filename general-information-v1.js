"use strict";
const { projectReviews } = require("./manual-source-review-v1");

function administrativeCatalyst(item) {
  const text = `${item.title || ""} ${item.text || ""}`;
  return /senior executive service performance review board|performance review board membership/i.test(text)
    || (!Object.keys(item.directionalBiases || {}).length && item.keywordHits?.length === 1 && item.keywordHits[0] === "treasury");
}

function formatInformationNotice(item, heading = "777 INFORMATIONSHINWEIS") {
  if (!item.id || !item.url) throw new Error("Information notice requires an existing source event ID and link");
  return [
    heading,
    String(item.source || "Primärquelle"),
    String(item.title || "").slice(0, 700),
    "Einordnung: im Radar neu erkanntes Quellenereignis; Kursreaktion nicht bestätigt.",
    "Keine Handelsfreigabe. Keine Kauf-/Verkaufsrichtung aus dieser Meldung.",
    item.ownerDeliveryPending === true ? "EF-Fokus: separate Zustellung nicht nachgewiesen; ein weiterer Quellenhinweis kann sich überschneiden." : null,
    item.publishedAt ? `Veröffentlicht: ${item.publishedAt}` : "Veröffentlichungszeit: von der Quelle nicht angegeben",
    item.detectedAt ? `Erkannt: ${item.detectedAt}` : null,
    `Ereignis-ID: ${String(item.id).slice(0, 500)}`,
    item.url
  ].filter(Boolean).join("\n");
}

async function sendInformationNotice(item, sendMessage, heading) {
  const receipt = await sendMessage(formatInformationNotice(item, heading));
  if (receipt?.suppressed === true) return receipt;
  if (!Number.isInteger(receipt?.message_id) || receipt.message_id <= 0) throw new Error("Information notice lacks Telegram delivery receipt");
  return receipt;
}

function informationDeliveryStatus(outbox, reviewOptions) {
  const entries = outbox.snapshot();
  const status = { pending: 0, sent: 0, failed: 0, suppressed: 0, lastReceiptAt: null, error: null, historyScope: "telegram-channel-including-legacy" };
  let oldestPending = null, activeDeliveryError = null;
  for (const entry of entries) {
    const delivery = entry.deliveries.telegram;
    if (!delivery) continue;
    if (Object.hasOwn(status, delivery.status)) status[delivery.status]++;
    if (delivery.error) status.error ||= delivery.error;
    if (delivery.status === "pending") {
      if (Number.isFinite(entry.createdAt) && (oldestPending === null || entry.createdAt < oldestPending)) oldestPending = entry.createdAt;
      if (delivery.error) activeDeliveryError = "telegram-delivery-error";
    }
    if (delivery.status === "sent" && delivery.providerReceipt?.messageId && delivery.acknowledgedAt > (status.lastReceiptAt || "")) status.lastReceiptAt = delivery.acknowledgedAt;
  }
  // A shared storage failure applies to this channel too; quote failures do not.
  const sharedError = outbox.getStatus().error;
  if (sharedError === "delivery-state-persistence-failed") status.error = sharedError;
  if (reviewOptions) {
    if (sharedError === "delivery-state-persistence-failed") activeDeliveryError = sharedError;
    Object.assign(status, projectReviews({ ...reviewOptions, entries }), { activeDeliveryError,
      oldestPendingAt: oldestPending === null ? null : new Date(oldestPending).toISOString() });
  }
  return status;
}

function persistInformationHandoff(item, handoff) {
  if (!handoff) throw new Error("Energy Fuels handoff is not configured");
  const receipt = handoff.recordPolicy(item);
  if (receipt?.persisted !== true) throw new Error("Energy Fuels handoff was not persisted");
  // This acknowledges storage only. It cannot suppress the Telegram channel.
  return { persisted: true, eventId: receipt.eventId, deliveryConfirmed: false };
}

function restoreInformationHandoffs(snapshot, informationMode, isEnergyFuelsSpecific) {
  if (!informationMode) return snapshot;
  return (Array.isArray(snapshot) ? snapshot : []).map(entry => {
    if (entry?.deliveries?.telegram?.status !== "pending" || !isEnergyFuelsSpecific(entry.item) || entry.deliveries.energyFuelsHandoff) return entry;
    return { ...entry, deliveries: { ...entry.deliveries, energyFuelsHandoff: { status: "pending", attempts: 0, nextAttemptAt: 0, error: null } } };
  });
}

module.exports = { administrativeCatalyst, formatInformationNotice, sendInformationNotice, informationDeliveryStatus, persistInformationHandoff, restoreInformationHandoffs };
