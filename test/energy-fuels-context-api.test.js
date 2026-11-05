const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const vm = require("node:vm");
const createHandoff = require("../energy-fuels-handoff-v1");

test("real local API serves persisted EF context read-only with honest ownership and version", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radar-context-api-"));
  const now = new Date().toISOString();
  createHandoff({ dataDir: dir }).recordPolicy({ id: "fixture:deferred-policy", title: "Energy Fuels receives uranium permit" });
  fs.writeFileSync(path.join(dir, "structural-intelligence.json"), JSON.stringify({
    version: 1, savedAt: now, seen: [], primed: ["critical-minerals"], clusters: {}, verified: [],
    items: [{ id: "fixture:retained-event", theme: "critical-minerals", title: "Synthetic retained context",
      detectedAt: now, publishedAt: null, sourceClass: "secondary-discovery", baseline: true }]
  }));
  const deliveryItem = id => ({ id, title: "Synthetic policy fixture", url: "https://www.whitehouse.gov/fixture", detectedAt: now });
  fs.writeFileSync(path.join(dir, "catalyst-state.json"), JSON.stringify({
    version: 3, seen: [], primed: [], items: [], deliveryOutbox: [
      { id: "fixture:delivered", item: deliveryItem("fixture:delivered"), createdAt: Date.now(), deliveries: {
        telegram: { status: "sent", attempts: 1, nextAttemptAt: 0, error: null, acknowledgedAt: now, providerReceipt: { messageId: "111" } },
        marketRecheck: { status: "failed", attempts: 5, nextAttemptAt: 0, error: "synthetic quote-provider failure" }
      } },
      { id: "fixture:pending", item: deliveryItem("fixture:pending"), createdAt: Date.now(), deliveries: {
        telegram: { status: "pending", attempts: 1, nextAttemptAt: Date.now() + 600000, error: "synthetic Telegram timeout" }
      } }
    ]
  }));
  const env = { ...process.env, PORT: "0", RADAR_PORT: "0", RADAR_BIND_ADDRESS: "127.0.0.1",
    RADAR_DATA_DIR: dir, OIL_DATA_MODE: "free-proxy", KIMI_RESEARCH_MODE: "off", RADAR_GENERAL_INFO_MODE: "true",
    RADAR_FREE_ONLY: "true", RADAR_EF_PRIMARY_ENABLED: "false", RADAR_DELIVERY_MODE: "probe-only", RADAR_TWELVE_BASIC_CONTEXT: "true" };
  for (const key of ["APCA_API_KEY_ID", "APCA_API_SECRET_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID",
    "TWELVE", "TWELVE_BASIC_API_KEY", "MASSIVE_API_KEY", "RADAR_RECOVERY_BACKUP_ID", "RADAR_DELIVERY_PROBE_ID", "RADAR_BACKUP_ACCESS_KEY", "NODE_OPTIONS"]) delete env[key];
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server-v4.js")], {
    env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.kill("SIGKILL");
      await closed;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("local fixture server did not become ready")), 8000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error("local fixture server exited: " + code)); });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/running on 127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  const base = "http://127.0.0.1:" + port;
  const status = await (await fetch(base + "/api/status")).json();
  assert.equal(status.version, require("../package.json").version);
  assert.equal(status.energyFuelsRouting.owner, "energy-fuels-fokus");
  assert.equal(status.telegramConfigured, false);
  assert.equal(status.generalInformation.enabled, true);
  assert.equal(status.generalInformation.deliveryEnabled, false);
  assert.equal(status.generalInformation.marketDataConfigured, false);
  assert.equal(status.generalInformation.informationNoticesExecutionEligible, false);
  assert.equal(status.generalInformation.notificationMode, "PRIMARY_SOURCE_INFORMATION");
  assert.equal(status.alternativeMarketContext.enabled, true);
  assert.equal(status.alternativeMarketContext.configured, false);
  assert.equal(status.alternativeMarketContext.executionEligible, false);
  const contextStatus = await (await fetch(base + "/api/market-context/status")).json();
  assert.equal(contextStatus.configured, false);
  assert.equal(contextStatus.provider, null);
  assert.equal(contextStatus.eventContext.resultsExposure, "none");
  assert.equal((await fetch(base + "/api/market-context/status", { method: "POST" })).status, 405);
  const information = status.generalInformation.informationDeliveryStatus;
  assert.deepEqual(Object.keys(information), ["policy", "eia", "ecb"]);
  assert.equal(information.policy.pending, 1);
  assert.equal(information.policy.sent, 1);
  assert.equal(information.policy.failed, 0, "a quote-channel failure is not a Telegram failure");
  assert.equal(information.policy.error, "synthetic Telegram timeout");
  assert.equal(information.policy.lastReceiptAt, now);
  assert.equal(information.policy.historyScope, "telegram-channel-including-legacy");
  assert.equal(information.eia.pending, 0);
  assert.equal(information.ecb.lastReceiptAt, null);
  const response = await fetch(base + "/api/energy-fuels-context");
  assert.equal(response.status, 200);
  const context = await response.json();
  assert.equal(context.discoveries[0].id, "fixture:retained-event");
  assert.equal(context.deliveryConfirmed, false);
  assert.equal(context.ownerReadConfirmed, false);
  assert.equal(context.tradeDecisionAllowed, false);
  assert.equal(context.handoff.pendingCount, 1);
  assert.equal(context.handoff.pending[0].eventId, "policy:fixture:deferred-policy");
  assert.equal(context.handoff.pending[0].deliveryConfirmed, false);
  assert.equal(context.handoff.automaticDeletion, false);
  assert.equal(status.energyFuelsHandoff.pendingCount, 1);
  assert.equal((await fetch(base + "/api/energy-fuels-context", { method: "POST" })).status, 405);
});

function dashboardFixture() {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "dashboard-v4.html"), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const nodes = new Map();
  let data, unavailable = false;
  const context = vm.createContext({
    document: { getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { textContent: "", innerHTML: "", className: "" });
      return nodes.get(id);
    } },
    fetch: async () => { if (unavailable) throw new Error("offline"); return { ok: true, json: async () => data }; }
  });
  // Load the real dashboard functions without starting its repeating network jobs.
  vm.runInContext(script.slice(0, script.indexOf("$('quoteForm').addEventListener")), context);
  return { nodes, async render(value, fail = false) {
    data = value; unavailable = fail;
    await vm.runInContext("loadStatus()", context);
  } };
}

function informationFixture() {
  const channel = () => ({ pending: 0, sent: 0, failed: 0, suppressed: 0,
    lastReceiptAt: null, error: null, historyScope: "telegram-channel-including-legacy" });
  return { deliveryMode: "live", telegramConfigured: true, marketDataConfigured: false,
    telegramDelivery: { lastError: null, lastSuccessAt: "2026-11-05T20:01:29.044Z" },
    generalInformation: { enabled: true, deliveryEnabled: true,
      informationDeliveryStatus: { policy: channel(), eia: channel(), ecb: channel() } } };
}

test("dashboard separates enabled delivery from information receipts and labels legacy history", async () => {
  const ui = dashboardFixture(), data = informationFixture();
  await ui.render(data);
  assert.equal(ui.nodes.get("infoBadge").textContent, "VERSAND FREIGESCHALTET");
  assert.equal(ui.nodes.get("infoBadge").className, "badge pending");
  const history = ui.nodes.get("infoDelivery").innerHTML;
  assert.match(history, /Politik/); assert.match(history, /EIA/); assert.match(history, /ECB/);
  assert.equal((history.match(/kein gespeicherter Beleg/g) || []).length, 3,
    "a shared Telegram probe is not a per-engine information receipt");
  assert.match(history, /ältere Telegram-Einträge/);
  assert.doesNotMatch(history, /corrline ok/);
});

test("dashboard exposes queue failures and pending work with escaped details and a dated provider receipt", async () => {
  const ui = dashboardFixture(), data = informationFixture();
  data.generalInformation.informationDeliveryStatus.policy = { pending: 2, sent: 3, failed: 1, suppressed: 4,
    lastReceiptAt: "2026-10-01T12:00:00Z", error: "<img src=x onerror=alert(1)>", historyScope: "telegram-channel-including-legacy" };
  data.telegramDelivery.lastError = "synthetic provider error";
  await ui.render(data);
  const history = ui.nodes.get("infoDelivery").innerHTML;
  assert.match(history, /2 ausstehend · 1 fehlgeschlagen · 3 als gesendet gespeichert · 4 unterdrückt/);
  assert.match(history, /01\.10\.2026/);
  assert.match(history, /Gemeinsamer Telegram-Meldeweg: synthetic provider error/);
  assert.match(history, /corrline bad/);
  assert.match(history, /&lt;img/); assert.doesNotMatch(history, /<img/);
  assert.equal(ui.nodes.get("infoBadge").className, "badge pending");
});

test("dashboard keeps unavailable or disabled delivery visibly unconfirmed", async () => {
  const ui = dashboardFixture(), data = informationFixture();
  data.generalInformation.deliveryEnabled = false;
  data.generalInformation.informationDeliveryStatus.eia = null;
  await ui.render(data);
  assert.equal(ui.nodes.get("infoBadge").textContent, "VERSAND NICHT FREIGESCHALTET");
  assert.match(ui.nodes.get("infoDelivery").innerHTML, /EIA: Zustellhistorie nicht verfügbar/);
  await ui.render(data, true);
  assert.equal(ui.nodes.get("infoBadge").textContent, "NICHT ERREICHBAR");
  assert.equal(ui.nodes.get("infoBadge").className, "badge bad");
  assert.match(ui.nodes.get("infoDelivery").textContent, /nicht aktualisiert/);
});
