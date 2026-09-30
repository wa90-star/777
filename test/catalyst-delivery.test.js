const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createCatalyst = require("../catalyst-v4");
const createEia = require("../eia-v4");

function feed(ids, kind) {
  return `<rss><channel>${ids.map((id) => `<item><title>${kind === "EIA" ? "Weekly petroleum status report: crude oil inventories decreased" : "Emergency oil sanctions on Iran"} ${id}</title><link>https://example.test/${kind}/${id}</link><pubDate>${new Date().toUTCString()}</pubDate></item>`).join("")}</channel></rss>`;
}

for (const [kind, create, scan, filename] of [
  ["policy", createCatalyst, "scanWhiteHouse", "catalyst-state.json"],
  ["EIA", createEia, "scan", "eia-state.json"]
]) {
  test(`${kind}: real persisted engine keeps all burst events, retries failed Telegram after restart, and preserves baseline`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radar-delivery-"));
    const oldDataDir = process.env.RADAR_DATA_DIR;
    process.env.RADAR_DATA_DIR = dir;
    t.after(() => {
      if (oldDataDir === undefined) delete process.env.RADAR_DATA_DIR;
      else process.env.RADAR_DATA_DIR = oldDataDir;
      fs.rmSync(dir, { recursive: true, force: true });
    });
    let time = Date.now(), ids = ["baseline"], attempts = 0, observed = 0;
    const messages = [], callbackIds = [];
    t.mock.method(Date, "now", () => time);
    t.mock.method(global, "fetch", async () => new Response(feed(ids, kind), { status: 200 }));
    const options = {
      telegramConfigured: () => true,
      sendMessage: async (text) => {
        attempts += 1;
        if (attempts === 1) throw new Error("Telegram temporarily unavailable");
        messages.push(text);
      },
      onAlert: () => { observed += 1; },
      onFreshRelevant: async (items) => { callbackIds.push(...items.map((item) => item.id)); }
    };
    let engine = create(options);
    await engine[scan]();
    assert.equal(attempts, 0, "initial feed establishes a quiet baseline");
    ids = ["baseline", "fresh1", "fresh2", "fresh3"];
    await engine[scan]();
    assert.equal(callbackIds.length, 3, "all eligible events trigger the market recheck");
    assert.equal(attempts, 2, "bounded Telegram batch");
    assert.equal(messages.length, 1);
    assert.equal(observed, 1, "only acknowledged sends count as alerts");
    assert.equal(engine.getState().deliveryStatus.pending, 2);
    const disk = JSON.parse(fs.readFileSync(path.join(dir, filename), "utf8"));
    assert.equal(disk.deliveryOutbox.length, 3);
    assert.ok(disk.deliveryOutbox.every((entry) => disk.seen.some(([id]) => id === entry.id)), "seen and durable intent are persisted together");

    engine = create(options);
    time += 30001;
    await engine.drainDeliveries();
    assert.equal(messages.length, 3);
    assert.equal(observed, 3);
    assert.equal(callbackIds.length, 3, "successful callbacks are not repeated on restart");
    assert.equal(new Set(messages.map((text) => text.match(/fresh[123]/)[0])).size, 3);
    assert.ok(messages.every((text) => text.includes("Veröffentlicht:") && text.includes("Erkannt:")));
    await engine[scan]();
    await engine.drainDeliveries();
    assert.equal(messages.length, 3, "repeated source responses are deduplicated");
    assert.equal(engine.getState().deliveryStatus.pending, 0);
    assert.equal(engine.getState().deliveryStatus.failed, 0);
  });
}
