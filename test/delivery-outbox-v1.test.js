const test = require("node:test");
const assert = require("node:assert/strict");
const createOutbox = require("../delivery-outbox-v1");
const { createTelegramTransport } = require("../telegram-transport-v1");

function harness(options = {}) {
  let timestamp = 1000000;
  let disk;
  let outbox;
  const settings = {
    now: () => timestamp,
    persist: () => { disk = structuredClone(outbox.snapshot()); return true; },
    ...options
  };
  outbox = createOutbox(settings);
  return {
    get outbox() { return outbox; },
    get disk() { return disk; },
    advance: (ms) => { timestamp += ms; },
    restart: () => { outbox = createOutbox(settings); outbox.restore(disk); }
  };
}

test("retains a burst beyond the send batch and deduplicates acknowledged items after restart", async () => {
  const sent = [], rechecks = [];
  const h = harness({ handlers: {
    market: { batch: true, deliver: async (items) => rechecks.push(...items.map((x) => x.id)) },
    telegram: { deliver: async ([item]) => sent.push(item.id) }
  } });
  const items = [1, 2, 3, 4].map((id) => ({ id: String(id) }));
  h.outbox.enqueue(items, ["market", "telegram"]);
  await h.outbox.drain();
  assert.deepEqual(sent, ["1", "2"]);
  assert.deepEqual(rechecks, ["1", "2", "3", "4"]);
  assert.equal(h.outbox.getStatus().pending, 2);
  h.restart();
  h.outbox.enqueue(items, ["market", "telegram"]);
  await h.outbox.drain();
  assert.deepEqual(sent, ["1", "2", "3", "4"]);
  assert.deepEqual(rechecks, ["1", "2", "3", "4"]);
  assert.equal(h.outbox.getStatus().pending, 0);
});

test("retries transient failure after backoff and restart without repeating a successful channel", async () => {
  let attempts = 0, callbacks = 0;
  const h = harness({ handlers: {
    market: { batch: true, deliver: async () => { callbacks += 1; } },
    telegram: { deliver: async () => { if (++attempts === 1) throw new Error("temporary 503"); } }
  } });
  h.outbox.enqueue([{ id: "event" }], ["market", "telegram"]);
  await h.outbox.drain();
  assert.equal(h.disk[0].deliveries.telegram.status, "pending");
  assert.equal(h.disk[0].deliveries.market.status, "sent");
  assert.match(h.outbox.getStatus().error, /temporary 503/);
  h.restart();
  await h.outbox.drain();
  assert.equal(attempts, 1);
  h.advance(30001);
  await h.outbox.drain();
  assert.equal(attempts, 2);
  assert.equal(callbacks, 1);
  assert.equal(h.outbox.getStatus().error, null);
  assert.equal(h.disk[0].deliveries.telegram.status, "sent");
});

test("exhausted retries remain failed on disk and are never marked sent", async () => {
  let attempts = 0;
  const h = harness({ handlers: { telegram: { deliver: async () => { attempts += 1; throw new Error("unavailable"); } } } });
  h.outbox.enqueue([{ id: "event" }], ["telegram"]);
  for (let i = 0; i < 5; i += 1) { await h.outbox.drain(); h.advance(300000); }
  assert.equal(attempts, 5);
  assert.equal(h.disk[0].deliveries.telegram.status, "failed");
  h.restart();
  h.advance(4 * 86400000);
  await h.outbox.drain();
  assert.equal(attempts, 5);
  assert.equal(h.outbox.getStatus().failed, 1);
  assert.equal(h.outbox.getStatus().sent, 0);
});

test("Telegram retry_after=600 survives restart and does not exhaust attempts before the provider deadline", async () => {
  let requests = 0;
  const transport = createTelegramTransport({
    token: "test-token", chatId: "test-chat",
    fetchImpl: async () => {
      requests += 1;
      const status = requests === 1 ? 429 : 200;
      return { ok: status === 200, status, json: async () => status === 429
        ? { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 600 } }
        : { ok: true, result: { message_id: 99 } }
      };
    }
  });
  const h = harness({ handlers: { telegram: { deliver: async () => transport.send("test event") } } });
  h.outbox.enqueue([{ id: "event" }], ["telegram"]);
  await h.outbox.drain();
  assert.equal(requests, 1);
  assert.equal(h.disk[0].deliveries.telegram.nextAttemptAt, 1600000);
  for (let i = 1; i <= 19; i += 1) {
    h.advance(30000);
    if (i === 5) h.restart();
    await h.outbox.drain();
    assert.equal(requests, 1, `no Telegram retry after only ${i * 30}s`);
    assert.equal(h.disk[0].deliveries.telegram.attempts, 1);
    assert.equal(h.outbox.getStatus().failed, 0);
  }
  h.advance(29999);
  await h.outbox.drain();
  assert.equal(requests, 1, "no early retry at 599.999 seconds");
  h.advance(1);
  await h.outbox.drain();
  assert.equal(requests, 2);
  assert.equal(h.disk[0].deliveries.telegram.status, "sent");
  assert.equal(h.disk[0].deliveries.telegram.attempts, 2);
});

test("invalid retry hints do not override backoff; a long valid hint cannot bypass the 30-minute expiry", async () => {
  for (const retryAfterMs of [-1, NaN, Infinity, "600000"]) {
    const h = harness({ handlers: { telegram: { deliver: async () => {
      throw Object.assign(new Error("retry hint"), { retryAfterMs });
    } } } });
    h.outbox.enqueue([{ id: "event" }], ["telegram"]);
    await h.outbox.drain();
    assert.equal(h.disk[0].deliveries.telegram.nextAttemptAt, 1030000);
  }
  let requests = 0;
  const h = harness({ handlers: { telegram: { deliver: async () => {
    requests += 1;
    throw Object.assign(new Error("long rate limit"), { retryAfterMs: 3600000 });
  } } } });
  h.outbox.enqueue([{ id: "event" }], ["telegram"]);
  await h.outbox.drain();
  h.advance(30 * 60000);
  await h.outbox.drain();
  assert.equal(requests, 1);
  assert.equal(h.outbox.getStatus().failed, 1);
  assert.match(h.outbox.getStatus().error, /delivery-expired-requires-review/);
});

test("a long downtime exposes an expired failure rather than sending a stale event", async () => {
  let enabled = false, sent = 0;
  const h = harness({ handlers: { telegram: { enabled: () => enabled, deliver: async () => { sent += 1; } } } });
  h.outbox.enqueue([{ id: "event" }], ["telegram"]);
  await h.outbox.drain();
  h.advance(31 * 60000);
  h.restart();
  enabled = true;
  await h.outbox.drain();
  assert.equal(sent, 0);
  assert.equal(h.outbox.getStatus().failed, 1);
  assert.match(h.outbox.getStatus().error, /delivery-expired-requires-review/);
});

test("does not send when the write-ahead persistence fails", async () => {
  let sent = 0;
  const h = harness({ persist: () => false, handlers: { telegram: { deliver: async () => { sent += 1; } } } });
  h.outbox.enqueue([{ id: "event" }], ["telegram"]);
  await h.outbox.drain();
  assert.equal(sent, 0);
  assert.match(h.outbox.getStatus().error, /persistence-failed/);
});

test("an observer failure cannot resend an acknowledged Telegram message", async () => {
  let sent = 0;
  const h = harness({ handlers: { telegram: {
    deliver: async () => { sent += 1; },
    onDelivered: () => { throw new Error("telemetry unavailable"); }
  } } });
  h.outbox.enqueue([{ id: "event" }], ["telegram"]);
  await h.outbox.drain();
  h.restart();
  h.advance(300001);
  await h.outbox.drain();
  assert.equal(sent, 1);
  assert.equal(h.outbox.getStatus().sent, 1);
});

test("concurrent drains share one delivery and suppression is not reported as sent", async () => {
  let sendCalls = 0, delivered = 0, release;
  const wait = new Promise((resolve) => { release = resolve; });
  const h = harness({ handlers: { telegram: {
    deliver: async () => { sendCalls += 1; await wait; return { suppressed: true }; },
    onDelivered: () => { delivered += 1; }
  } } });
  h.outbox.enqueue([{ id: "event" }], ["telegram"]);
  const a = h.outbox.drain(), b = h.outbox.drain();
  assert.equal(a, b);
  release();
  await a;
  assert.equal(sendCalls, 1);
  assert.equal(delivered, 0);
  assert.equal(h.outbox.getStatus().suppressed, 1);
  assert.equal(h.outbox.getStatus().sent, 0);
});


test("persists and restores provider delivery receipt", async () => {
  const h = harness({ handlers: { telegram: { deliver: async () => ({ message_id: 4242 }) } } });
  h.outbox.enqueue([{ id: "receipt-event" }], ["telegram"]);
  await h.outbox.drain();
  assert.deepEqual(h.disk[0].deliveries.telegram.providerReceipt, { messageId: "4242" });
  assert.ok(h.disk[0].deliveries.telegram.acknowledgedAt);
  h.restart();
  const restored = h.outbox.snapshot()[0].deliveries.telegram;
  assert.equal(restored.status, "sent");
  assert.deepEqual(restored.providerReceipt, { messageId: "4242" });
});
