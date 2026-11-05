"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createCatalyst = require("../catalyst-v4");
const createEia = require("../eia-v4");
const createEcb = require("../ecb-v4");
const { formatInformationNotice, administrativeCatalyst } = require("../general-information-v1");

const ENGINES = [
  ["policy", createCatalyst, "scanWhiteHouse", "catalyst-state.json", "Emergency crude oil sanctions on Iran", "https://www.whitehouse.gov/presidential-actions/"],
  ["eia", createEia, "scan", "eia-state.json", "Weekly petroleum status report: crude oil inventories decreased", "https://www.eia.gov/news/"],
  ["ecb", createEcb, "scan", "ecb-state.json", "Monetary policy decisions: key ECB interest rates cut by 25 basis points", "https://www.ecb.europa.eu/press/"]
];
function setup(t, title, origin) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "777-info-"));
  const saved = Object.fromEntries(["RADAR_DATA_DIR", "APCA_API_KEY_ID", "APCA_API_SECRET_KEY", "TWELVE"].map(key => [key, process.env[key]]));
  process.env.RADAR_DATA_DIR = directory;
  delete process.env.APCA_API_KEY_ID; delete process.env.APCA_API_SECRET_KEY; delete process.env.TWELVE;
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(directory, { recursive: true, force: true }); });
  let ids = ["baseline"], timestamp = Date.now();
  const publishedAt = new Date(timestamp).toUTCString();
  const urls = [];
  t.mock.method(Date, "now", () => timestamp);
  t.mock.method(global, "fetch", async url => {
    urls.push(String(url));
    return new Response(`<rss><channel>${ids.map(id => `<item><title>${title} ${id}</title><link>${origin}${id}</link><pubDate>${publishedAt}</pubDate></item>`).join("")}</channel></rss>`);
  });
  return { directory, urls, fresh() { ids = ["fresh", "baseline"]; }, advance(ms) { timestamp += ms; } };
}

for (const [kind, create, scan, filename, title, origin] of ENGINES) {
  test(`${kind}: information arrives with durable intent and receipt despite unavailable quotes; restart does not resend`, async t => {
    const h = setup(t, title, origin), sent = [], order = [];
    const options = { informationMode: true, telegramConfigured: () => true,
      sendMessage: async text => {
        order.push("telegram");
        const durable = JSON.parse(fs.readFileSync(path.join(h.directory, filename), "utf8"));
        assert.ok(durable.deliveryOutbox.some(entry => entry.deliveries.telegram?.status === "pending" && entry.item.id.includes("fresh")));
        sent.push(text); return { message_id: 781 };
      },
      onFreshRelevant: async () => { order.push("quotes"); throw new Error("Alpaca market data is not configured"); }
    };
    let engine = create(options);
    await engine[scan](); assert.equal(sent.length, 0, "historical baseline stays quiet");
    h.fresh(); await engine[scan]();
    assert.deepEqual(order, ["telegram", "quotes"]);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /INFORMATIONSHINWEIS/); assert.match(sent[0], /Kursreaktion nicht bestätigt/);
    assert.match(sent[0], /Keine Handelsfreigabe/); assert.match(sent[0], /Ereignis-ID:/);
    assert.match(sent[0], /Veröffentlicht:/); assert.match(sent[0], /Erkannt:/);
    assert.doesNotMatch(sent[0], /\bLONG\b|\bSHORT\b|Score:|Tagesbewegung:|Bestätigungen:/);
    assert.ok(h.urls.every(url => !url.includes("alpaca") && !url.includes("twelvedata")));
    const disk = JSON.parse(fs.readFileSync(path.join(h.directory, filename), "utf8"));
    const entry = disk.deliveryOutbox.find(entry => entry.item.id.includes("fresh"));
    assert.equal(entry.deliveries.telegram.status, "sent");
    assert.equal(entry.deliveries.telegram.providerReceipt.messageId, "781");
    assert.equal(entry.deliveries.marketRecheck.status, "pending");
    assert.equal(engine.getState().informationDeliveryStatus.sent, 1);
    assert.equal(engine.getState().informationDeliveryStatus.error, null, "quote errors do not become information delivery errors");
    assert.ok(engine.getState().informationDeliveryStatus.lastReceiptAt);
    engine = create(options); h.advance(30001); await engine.drainDeliveries(); await engine[scan]();
    assert.equal(sent.length, 1, "source repeat/restart cannot duplicate an acknowledged event");
    assert.equal(engine.getState().informationNoticesExecutionEligible, false);
  });

  test(`${kind}: failed disk sync blocks delivery and remains retryable`, async t => {
    const h = setup(t, title, origin); let sent = 0;
    const engine = create({ informationMode: true, telegramConfigured: () => true, sendMessage: async () => ({ message_id: ++sent }) });
    await engine[scan](); h.fresh();
    const sync = fs.fsyncSync;
    const mock = t.mock.method(fs, "fsyncSync", () => { throw new Error("synthetic disk failure"); });
    await engine[scan](); assert.equal(sent, 0); assert.equal(engine.getState().deliveryStatus.pending, 1);
    assert.match(engine.getState().deliveryStatus.error, /persistence-failed/);
    assert.match(engine.getState().informationDeliveryStatus.error, /persistence-failed/);
    mock.mock.restore(); assert.equal(fs.fsyncSync, sync);
    await engine.drainDeliveries(); assert.equal(sent, 1);
  });

  test(`${kind}: absent provider receipt never marks information delivered`, async t => {
    const h = setup(t, title, origin);
    const engine = create({ informationMode: true, telegramConfigured: () => true, sendMessage: async () => ({ ok: true }) });
    await engine[scan](); h.fresh(); await engine[scan]();
    assert.equal(engine.getState().deliveryStatus.sent, 0);
    assert.equal(engine.getState().deliveryStatus.pending, 1);
    assert.match(engine.getState().deliveryStatus.error, /delivery receipt/);
  });
}

test("formatter requires stable identity and preserves an unknown publication time honestly", () => {
  assert.throws(() => formatInformationNotice({ title: "test" }));
  const text = formatInformationNotice({ id: "ecb:fixed", url: "https://www.ecb.europa.eu/test", title: "Rate decision", directionalBiases: { TLT: "LONG" } });
  assert.match(text, /Veröffentlichungszeit: von der Quelle nicht angegeben/);
  assert.doesNotMatch(text, /LONG|TLT|Richtung:/);
});
test("existing administrative noise filter survives the new format", () => {
  assert.equal(administrativeCatalyst({ title: "Treasury performance review board membership" }), true);
  assert.equal(administrativeCatalyst({ title: "Treasury administration", keywordHits: ["treasury"], directionalBiases: {} }), true);
  assert.equal(administrativeCatalyst({ title: "Treasury oil sanctions", keywordHits: ["treasury", "oil"], directionalBiases: {} }), false);
});

for (const [kind, create, scan, filename, title, origin] of ENGINES.slice(0, 2)) {
  test(`${kind}: missing native EF consumer and failed handoff storage cannot swallow the information notice`, async t => {
    const h = setup(t, "Energy Fuels announces uranium export ban clarification alongside crude oil production statistics", origin);
    let sent = 0, persisted = false, handoffs = 0;
    const options = { informationMode: true, telegramConfigured: () => true,
      sendMessage: async text => { assert.match(text, /separate Zustellung nicht nachgewiesen/); return { message_id: ++sent }; },
      energyFuelsHandoff: { recordPolicy: item => { handoffs++; return { persisted, eventId: item.id }; } }
    };
    let engine = create(options);
    await engine[scan](); h.fresh(); await engine[scan]();
    assert.equal(sent, 1); assert.equal(handoffs, 1);
    assert.equal(engine.getState().deliveryStatus.pending, 1);
    assert.equal(engine.getState().deliveryStatus.suppressed, 0);
    assert.equal(engine.getState().informationDeliveryStatus.sent, 1);
    assert.equal(engine.getState().informationDeliveryStatus.error, null);
    persisted = true; engine = create(options); h.advance(30001); await engine.drainDeliveries();
    assert.equal(sent, 1); assert.equal(handoffs, 2);
    assert.equal(engine.getState().deliveryStatus.suppressed, 0);
    assert.equal(engine.getState().deliveryStatus.pending, 0);
    assert.equal(engine.getState().informationDeliveryStatus.sent, 1);
  });
  test(`${kind}: a broad policy event with incidental Energy Fuels mention remains general information`, async t => {
    const h = setup(t, "China expands crude oil export ban; affected companies include Energy Fuels and MP Materials", origin);
    const sent = [];
    const engine = create({ informationMode: true, telegramConfigured: () => true,
      sendMessage: async text => { sent.push(text); return { message_id: 1 }; },
      energyFuelsHandoff: { recordPolicy: () => { throw new Error("Incidental mentions must not be exclusively delegated"); } }
    });
    await engine[scan](); h.fresh(); await engine[scan]();
    assert.equal(sent.length, 1); assert.match(sent[0], /China expands/);
    assert.equal(engine.getState().deliveryStatus.suppressed, 0);
  });
}

test("ECB retains event-only behavior when the explicit information mode is disabled", async t => {
  const row = ENGINES[2], h = setup(t, row[4], row[5]); let callbacks = 0, sent = 0;
  const engine = createEcb({ informationMode: false, telegramConfigured: () => true, sendMessage: async () => ({ message_id: ++sent }), onFreshRelevant: async () => { callbacks++; } });
  await engine.scan(); h.fresh(); await engine.scan();
  assert.equal(callbacks, 1); assert.equal(sent, 0);
});
