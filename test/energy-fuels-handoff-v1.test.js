const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createHandoff = require("../energy-fuels-handoff-v1");
const createCatalyst = require("../catalyst-v4");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radar-handoff-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, filename: path.join(dir, "energy-fuels-handoff.jsonl") };
}

test("handoff evidence is immutable, namespaced, restart-safe and never automatically expires", (t) => {
  const { dir, filename } = fixture(t);
  const time = Date.parse("2026-11-05T16:00:00Z");
  const store = createHandoff({ dataDir: dir, now: () => time });
  const event = { id: "source:1", title: "Energy Fuels receives uranium permit", url: "https://example.test/1" };
  assert.deepEqual(store.recordPolicy(event), {
    persisted: true, duplicate: false, eventId: "policy:source:1", deliveryConfirmed: false
  });
  event.title = "mutated caller object";
  assert.equal(store.recordPolicy(event).duplicate, true);
  store.recordEquity({ symbol: "UUUU", direction: "LONG", structural: { id: "source:1" }, price: 11 });
  assert.equal(store.recordEquity({ symbol: "EFR.TO", direction: "LONG", structural: { id: "source:1" }, price: 15 }).duplicate, true);
  const state = createHandoff({ dataDir: dir, now: () => time + 365 * 86400000 }).getState();
  assert.equal(state.pendingCount, 2);
  assert.equal(state.automaticDeletion, false);
  assert.equal(state.pending[0].evidence.title, "Energy Fuels receives uranium permit");
  assert.equal(state.pending[1].evidence.price, 11);
  assert.ok(state.pending.every((entry) => entry.status === "pending-owner-review" &&
    entry.deliveryConfirmed === false && entry.ownerReadConfirmed === false));
  assert.equal(fs.readFileSync(filename, "utf8").trim().split("\n").length, 2);
});

test("sync failures cannot produce a successful handoff receipt, including duplicate retries", (t) => {
  const { dir, filename } = fixture(t);
  const store = createHandoff({ dataDir: dir });
  const original = fs.fsyncSync;
  let fail = true, syncs = 0;
  t.mock.method(fs, "fsyncSync", (fd) => {
    syncs += 1;
    if (fail) throw Object.assign(new Error("fixture disk sync failed"), { code: "EIO" });
    return original(fd);
  });
  const event = { id: "source:retry", title: "Energy Fuels receives permit" };
  assert.throws(() => store.recordPolicy(event), /could not be persisted: EIO/);
  assert.throws(() => store.recordPolicy(event), /could not be persisted: EIO/);
  assert.equal(syncs, 2, "duplicate bytes are synced again before acknowledging persistence");
  fail = false;
  assert.equal(store.recordPolicy(event).persisted, true);
  assert.equal(store.getState().lastError, null);
  assert.equal(fs.readFileSync(filename, "utf8").trim().split("\n").length, 1);
});

test("corrupt or incomplete handoff files fail closed without overwriting evidence", (t) => {
  const { dir, filename } = fixture(t);
  fs.writeFileSync(filename, '{"incomplete":');
  const store = createHandoff({ dataDir: dir });
  assert.throws(() => store.recordPolicy({ id: "source:2" }), /could not be persisted/);
  assert.match(store.getState().lastError, /could not be read/);
  assert.equal(fs.readFileSync(filename, "utf8"), '{"incomplete":');
});

test("real policy outbox retries handoff storage failure after restart instead of marking it suppressed", async (t) => {
  const { dir, filename } = fixture(t);
  const oldDir = process.env.RADAR_DATA_DIR;
  process.env.RADAR_DATA_DIR = dir;
  t.after(() => {
    if (oldDir === undefined) delete process.env.RADAR_DATA_DIR; else process.env.RADAR_DATA_DIR = oldDir;
  });
  let time = Date.now(), fresh = false;
  t.mock.method(Date, "now", () => time);
  t.mock.method(globalThis, "fetch", async () => new Response(`<rss><channel><item>
    <title>${fresh ? "Energy Fuels receives emergency uranium export permit" : "Emergency oil baseline"}</title>
    <link>https://example.test/${fresh ? "fresh" : "baseline"}</link>
    <pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`));
  const options = {
    energyFuelsHandoff: createHandoff({ dataDir: dir }), telegramConfigured: () => true,
    sendMessage: async () => { assert.fail("EF company alert must not leak to general Telegram"); }
  };
  let engine = createCatalyst(options);
  await engine.scanWhiteHouse();
  fs.mkdirSync(filename); // Existing outbox works; only the handoff path is blocked.
  fresh = true;
  await engine.scanWhiteHouse();
  assert.equal(engine.getState().deliveryStatus.suppressed, 0);
  assert.equal(engine.getState().deliveryStatus.pending, 1);
  assert.match(engine.getState().deliveryStatus.error, /handoff could not be persisted/);
  const failedDisk = JSON.parse(fs.readFileSync(path.join(dir, "catalyst-state.json"), "utf8"));
  assert.equal(failedDisk.deliveryOutbox[0].deliveries.telegram.status, "pending");
  engine = createCatalyst({ ...options, energyFuelsHandoff: createHandoff({ dataDir: dir }) });
  fs.rmdirSync(filename);
  time += 30001;
  await engine.drainDeliveries();
  assert.equal(engine.getState().deliveryStatus.suppressed, 1);
  assert.equal(engine.getState().deliveryStatus.pending, 0);
  const retained = createHandoff({ dataDir: dir }).getState();
  assert.equal(retained.pendingCount, 1);
  assert.equal(retained.pending[0].deliveryConfirmed, false);
  assert.equal(retained.pending[0].ownerReadConfirmed, false);
});
