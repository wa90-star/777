const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
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
  const env = { ...process.env, PORT: "0", RADAR_PORT: "0", RADAR_BIND_ADDRESS: "127.0.0.1",
    RADAR_DATA_DIR: dir, OIL_DATA_MODE: "free-proxy", KIMI_RESEARCH_MODE: "off" };
  for (const key of ["APCA_API_KEY_ID", "APCA_API_SECRET_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID",
    "TWELVE", "MASSIVE_API_KEY", "RADAR_RECOVERY_BACKUP_ID"]) delete env[key];
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
