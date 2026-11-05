const test = require("node:test");
const assert = require("node:assert/strict");
const { createEfPrimaryRuntime, formatNotice } = require("../ef-primary-runtime-v1");
const sample = { id: "notice:abc", title: "Company update", url: "https://investors.energyfuels.com/example", kind: "SOURCE_NEW", publisher: "energy-fuels", createdAt: "2026-11-05T17:00:00Z", classification: { topics: ["company"] } };
function fixture(options = {}) {
  const calls = { scans: 0, sends: 0, acks: 0, pending: [sample] };
  let clock = Date.parse("2026-11-05T17:00:00Z");
  const collector = {
    async collect() { calls.scans++; return { status: "OK" }; },
    async readStatus() { return { pendingNotices: calls.pending.length }; },
    async listPendingNotices(_dir, opts) { assert.equal(opts.actionableOnly, true); return calls.pending; },
    async acknowledgeDelivery({ receipt }) { calls.acks++; assert.equal(receipt.messageId, "8"); calls.pending = []; }
  };
  const transport = { configured: () => true, send: async () => { calls.sends++; return { message_id: 8 }; } };
  Object.assign(collector, options.collector); Object.assign(transport, options.transport);
  const runtime = createEfPrimaryRuntime({ enabled: true, intervalMinutes: 10, directory: "unused", moduleLoader: async () => collector, transport, now: () => clock, setTimer: () => ({ unref() {} }), clearTimer() {}, pause: async () => {}, logger: { error() {} } });
  return { calls, collector, transport, runtime, advance: ms => { clock += ms; } };
}
test("persists provider receipt and sends no duplicate on another run", async () => {
  const f = fixture(); await f.runtime.start(); await f.runtime.run();
  assert.deepEqual([f.calls.scans, f.calls.sends, f.calls.acks], [1, 1, 1]);
  assert.equal(f.runtime.getState().deviceReadConfirmed, false);
  f.advance(600001); await f.runtime.run(); assert.equal(f.calls.scans, 2); await f.runtime.stop();
});
test("429 preserves pending notice and respects provider retry delay", async () => {
  let attempts = 0;
  const f = fixture({ transport: { send: async () => { attempts++; throw Object.assign(new Error("limited"), { retryAfterMs: 120000 }); } } });
  await f.runtime.start(); f.advance(60001); await f.runtime.run();
  assert.equal(attempts, 1); assert.equal(f.calls.acks, 0); assert.equal(f.calls.pending.length, 1);
  f.advance(60001); await f.runtime.run(); assert.equal(attempts, 2); await f.runtime.stop();
});
test("accepted message whose receipt cannot be stored pauses sender", async () => {
  const f = fixture({ collector: { acknowledgeDelivery: async () => { throw new Error("disk full"); } } });
  await f.runtime.start(); f.advance(60001); await f.runtime.run();
  assert.equal(f.calls.sends, 1); assert.equal(f.calls.pending.length, 1); assert.equal(f.runtime.getState().deliveryPaused, true);
  await f.runtime.stop();
});
test("suppressed or malformed transport result never acknowledges a notice", async () => {
  const f = fixture({ transport: { send: async () => ({ suppressed: true }) } });
  await f.runtime.start(); assert.equal(f.calls.acks, 0); assert.equal(f.calls.pending.length, 1); await f.runtime.stop();
});
test("concurrent start/run share one scan and one send", async () => {
  let release; const gate = new Promise(r => { release = r; });
  const f = fixture({ collector: { collect: async () => { f.calls.scans++; await gate; return { status: "OK" }; } } });
  const first = f.runtime.start(); await Promise.resolve(); const second = f.runtime.run(); release();
  await Promise.all([first, second]); assert.equal(f.calls.scans, 1); assert.equal(f.calls.sends, 1); await f.runtime.stop();
});
test("missing credentials still collects and retains notice", async () => {
  const f = fixture({ transport: { configured: () => false } }); await f.runtime.start();
  assert.equal(f.calls.scans, 1); assert.equal(f.calls.sends, 0); assert.equal(f.calls.pending.length, 1); await f.runtime.stop();
});
test("source failure is visible and does not pretend to be a clean scan", async () => {
  const f = fixture({ collector: { collect: async () => { throw new Error("bad source layout"); } } });
  await f.runtime.start(); assert.match(f.runtime.getState().lastCollectionError, /bad source layout/); await f.runtime.stop();
});
test("notice labels assessment uncertainty and stable identity", () => {
  const text = formatNotice(sample);
  assert.match(text, /noch zu prüfen/); assert.match(text, /Keine Handelsfreigabe/); assert.match(text, /Hinweis-ID: notice:abc/);
  assert.ok(text.length < 4096);
});
test("future source time and later thesis review stay explicit in messages", () => {
  assert.match(formatNotice({ ...sample, publishedAt: "2099-01-01T00:00:00Z", publicationTimeStatus: "FUTURE_DATED_UNVERIFIED" }), /liegt in der Zukunft/);
  const text = formatNotice({ ...sample, kind: "RISK_REVIEW_REQUIRED", thesisId: "uranium-supply", decisionVersion: "2", explanation: "New evidence changes the earlier assumption" });
  assert.match(text, /uranium-supply/); assert.match(text, /New evidence changes/); assert.match(text, /noch nicht unabhängig bestätigt/);
});
