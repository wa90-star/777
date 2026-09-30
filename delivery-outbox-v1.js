// The containing engine persists this snapshot together with its seen IDs.
// Telegram has no idempotency key: a lost response can still cause a duplicate
// after retry. Successful acknowledgements are never deliberately resent.
function createDeliveryOutbox({
  persist, handlers, now = Date.now, maxBatch = 2, maxAttempts = 5,
  retryBaseMs = 30000, retryMaxMs = 300000, maxDeliveryAgeMs = 30 * 60000,
  retentionMs = 72 * 60 * 60000
}) {
  const entries = new Map();
  let running = null;
  let storageError = null;

  function save() {
    try {
      if (persist() === false) throw new Error("delivery-state-persistence-failed");
      storageError = null;
      return true;
    } catch {
      storageError = "delivery-state-persistence-failed";
      return false;
    }
  }

  function enqueue(items, channels) {
    for (const item of items) {
      const id = item.id || item.url;
      if (!id || entries.has(id)) continue;
      const deliveries = {};
      for (const name of channels) {
        if (handlers[name]) deliveries[name] = { status: "pending", attempts: 0, nextAttemptAt: 0, error: null };
      }
      if (Object.keys(deliveries).length) entries.set(id, { id, item, createdAt: now(), deliveries });
    }
  }

  function restore(snapshot) {
    for (const entry of Array.isArray(snapshot) ? snapshot : []) {
      if (!entry?.id || !entry.item || !Number.isFinite(entry.createdAt) || !entry.deliveries) continue;
      const deliveries = Object.fromEntries(Object.entries(entry.deliveries).filter(([name, delivery]) =>
        handlers[name] && ["pending", "sent", "suppressed", "failed"].includes(delivery?.status)
      ));
      if (Object.keys(deliveries).length) entries.set(entry.id, { ...entry, deliveries });
    }
  }

  async function flush() {
    const timestamp = now();
    for (const [id, entry] of entries) {
      for (const delivery of Object.values(entry.deliveries)) {
        if (delivery.status !== "pending") continue;
        if (timestamp - entry.createdAt >= maxDeliveryAgeMs) {
          delivery.status = "failed";
          delivery.error = "delivery-expired-requires-review";
        } else if (delivery.attempts >= maxAttempts) {
          delivery.status = "failed";
          delivery.error ||= "delivery-retry-limit-reached";
        }
      }
      // Keep failures visible until reviewed; only acknowledged history expires.
      if (timestamp - entry.createdAt > retentionMs && Object.values(entry.deliveries).every((d) =>
        d.status === "sent" || d.status === "suppressed")) entries.delete(id);
    }
    // Never deliver a message whose durable intent could not be recorded.
    if (!save()) return;

    for (const [name, handler] of Object.entries(handlers)) {
      if (handler.enabled && !handler.enabled()) continue;
      const due = [...entries.values()].filter((entry) => {
        const d = entry.deliveries[name];
        return d?.status === "pending" && d.nextAttemptAt <= now();
      }).slice(0, handler.batch ? 100 : maxBatch);
      const batches = handler.batch ? (due.length ? [due] : []) : due.map((entry) => [entry]);
      for (const batch of batches) {
        for (const entry of batch) {
          const d = entry.deliveries[name];
          d.attempts += 1;
          d.nextAttemptAt = now() + Math.min(retryMaxMs, retryBaseMs * (2 ** (d.attempts - 1)));
        }
        if (!save()) return;
        let result;
        try {
          result = await handler.deliver(batch.map((entry) => entry.item));
        } catch (error) {
          for (const entry of batch) {
            const d = entry.deliveries[name];
            d.error = String(error?.message || "delivery-failed").slice(0, 160);
            if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs >= 0) {
              d.nextAttemptAt = Math.max(d.nextAttemptAt, now() + error.retryAfterMs);
            }
            if (d.attempts >= maxAttempts) d.status = "failed";
          }
          if (!save()) return;
          continue;
        }
        for (const entry of batch) {
          const d = entry.deliveries[name];
          d.status = result?.suppressed ? "suppressed" : "sent";
          d.acknowledgedAt = new Date(now()).toISOString();
          d.error = null;
        }
        if (!save()) return;
        if (!result?.suppressed) {
          // Observers must not turn an acknowledged delivery into a resend.
          try { handler.onDelivered?.(); } catch (error) { console.error("777 delivery observer failed:", error.message); }
        }
      }
    }
  }

  function drain() {
    if (!running) running = flush().finally(() => { running = null; });
    return running;
  }

  function getStatus() {
    const counts = { pending: 0, failed: 0, sent: 0, suppressed: 0 };
    let error = storageError;
    let oldestPendingAt = null;
    for (const entry of entries.values()) {
      for (const [name, d] of Object.entries(entry.deliveries)) {
        counts[d.status] += 1;
        if (d.error) error ||= `${name}: ${d.error}`;
        if (d.status === "pending" && (oldestPendingAt === null || entry.createdAt < oldestPendingAt)) oldestPendingAt = entry.createdAt;
      }
    }
    return { ...counts, error, oldestPendingAt: oldestPendingAt === null ? null : new Date(oldestPendingAt).toISOString() };
  }

  return { enqueue, restore, drain, getStatus, snapshot: () => [...entries.values()] };
}

module.exports = createDeliveryOutbox;
