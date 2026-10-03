const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

test("disclosure API is cached, read-only and separate from the production signal path", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "house-api-"));
  const child = spawn(process.execPath, ["-e", `
    globalThis.fetch = async () => { throw new Error('upstream-network-disabled-in-test'); };
    const http = require('node:http');
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function(...args) {
      this.once('listening', () => process.send({ port: this.address().port }));
      return listen.apply(this, args);
    };
    require('./server-v4');
  `], { cwd: path.join(__dirname, ".."), env: {
    PATH: process.env.PATH, RADAR_DATA_DIR: dir, PORT: "0", KIMI_RESEARCH_MODE: "off"
  }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(async () => {
    if (child.exitCode === null) {
      const closed = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await closed;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server-start-timeout")), 10000);
    child.once("message", (message) => { clearTimeout(timeout); resolve(message.port); });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`server-exited:${code}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  for (const method of ["POST", "PUT", "DELETE"]) {
    assert.equal((await fetch(`${base}/api/politician-disclosures`, { method })).status, 405);
  }
  const before = fs.readFileSync(path.join(dir, "house-disclosures-state.json"), "utf8");
  const data = await (await fetch(`${base}/api/politician-disclosures`)).json();
  assert.equal(data.productionInfluence, false);
  assert.equal(data.directTelegramAlerts, false);
  assert.equal(data.lastAttemptAt, null, "public reads never trigger an upstream scan");
  assert.equal(fs.readFileSync(path.join(dir, "house-disclosures-state.json"), "utf8"), before);
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.marketExecutionGate, "decision-engine-v5.executionQuality");
  assert.equal(status.extremeOverrideEnabled, false);
  assert.equal(status.marketDataMaxAgeMinutes, 5);
  assert.equal(status.politicianDisclosures.productionInfluence, false);
  const catalysts = await (await fetch(`${base}/api/catalysts`)).json();
  assert.ok(catalysts.items.every((item) => !item.id.startsWith("house-ptr:")));
});
