import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWatchdog } from "../ops/external-watchdog.mjs";

function healthyPayloads(nowMs = Date.now()) {
  const source = () => ({ ok: true, error: null, warning: null, lastScanAt: new Date(nowMs).toISOString() });
  return {
    status: {
      system: "777", version: "5.2.1", status: "online", publicApiMode: "read-only",
      telegramConfigured: true, marketDataConfigured: true, marketDataSource: "alpaca-iex",
      oilDataConfigured: true, oilDataScope: "free-etf-proxy-iex", futuresDataConfigured: false,
      futuresDataStatus: "not-configured", futuresDataSource: null, futuresContracts: {},
      journalPersistence: "persistent:/data", catalystPersistence: "persistent:/data",
      eiaPersistence: "persistent:/data", ecbPersistence: "persistent:/data",
      sourceStatus: {
        trumpTruth: { ...source(), endpoint: "trump.fm-public-api", provider: "trump.fm", sourceClass: "public-archive",
          verification: "truth-id+canonical-url+utc-timestamp+checksum", requiresIndependentConfirmation: true, directTelegramAlerts: false },
        federalReserve: source(), whiteHouse: source(), federalRegister: source(), pelosiOfficial: source(),
        eiaOfficial: source(), europeanCentralBank: source()
      }, kimiResearch: { mode: "off", lastError: null, productionInfluence: false, telegramInfluence: false }
    },
    oil: { status: "live", source: "alpaca-iex-oil-etf-proxy", persistence: "persistent:/data",
      provider: { configured: true, authenticated: true, connection: "connected", provider: "alpaca", lastError: null }, lastError: null }
  };
}

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "radar-watchdog-"));
  const stateFile = path.join(directory, "state.json");
  let timestamp = Date.now();
  const f = { healthy: false, responseStatus: 200, description: "temporary failure", retryAfter: null,
    stallTelegram: false, stallProbe: false, messages: [], receipts: [], probeRequests: [] };
  const server = http.createServer(async (req, res) => {
    if (req.url === "/telegram") {
      let body = "";
      for await (const chunk of req) body += chunk;
      f.messages.push(JSON.parse(body));
      if (f.stallTelegram) return;
      res.writeHead(f.responseStatus, { "Content-Type": "application/json" });
      const payload = f.responseStatus === 200 ? { ok: true, result: { message_id: f.messages.length } }
        : { ok: false, error_code: f.responseStatus, description: f.description,
          ...(f.retryAfter === null ? {} : { parameters: { retry_after: f.retryAfter } }) };
      if (payload.ok) f.receipts.push(payload.result);
      return res.end(JSON.stringify(payload));
    }
    f.probeRequests.push(req.url);
    if (f.stallProbe) return;
    if (!f.healthy) { res.writeHead(404); return res.end("not found"); }
    const payloads = healthyPayloads(timestamp);
    f.modifyPayloads?.(payloads);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url === "/api/status" ? payloads.status : payloads.oil));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const token = "private-test-token", chatId = "private-test-chat";
  Object.assign(f, {
    stateFile, token, chatId, baseUrl,
    advance: (ms) => { timestamp += ms; },
    disk: () => JSON.parse(fs.readFileSync(stateFile, "utf8")),
    run: (overrides = {}) => runWatchdog({ baseUrl, stateFile, token, chatId, now: () => timestamp,
      probeOptions: { attempts: 1, timeoutMs: 100, retryDelayMs: 0 }, telegramTimeoutMs: 100,
      fetchImpl: (url, options) => {
        assert.equal(url, `https://api.telegram.org/bot${token}/sendMessage`);
        return fetch(`${baseUrl}/telegram`, options); // Never reaches real Telegram.
      }, ...overrides })
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return f;
}

test("healthy baseline stays silent and reuses every existing health check", async (t) => {
  const f = await fixture(t);
  f.healthy = true;
  assert.equal((await f.run()).notification, "none");
  assert.equal(f.messages.length, 0);
  assert.equal(f.disk().incident, null);
  assert.equal(fs.statSync(f.stateFile).mode & 0o077, 0);
  f.modifyPayloads = ({ status }) => { status.sourceStatus.eiaOfficial.lastScanAt = "2020-01-01T00:00:00Z"; };
  assert.equal((await f.run()).notification, "outage-sent");
  assert.match(f.messages[0].text, /source-stale:eiaOfficial/);
  assert.deepEqual(new Set(f.probeRequests), new Set(["/api/status", "/api/oil-monitor"]));
});

test("failed outage delivery persists and retries after restart; confirmed messages suppress duplicates until six hours", async (t) => {
  const f = await fixture(t);
  f.responseStatus = 503;
  assert.equal((await f.run()).notification, "failed");
  const id = f.disk().incident.id;
  assert.equal(f.disk().incident.outageDeliveredAt, null);
  f.responseStatus = 200;
  f.advance(59999);
  assert.equal((await f.run()).notification, "deferred");
  assert.equal(f.messages.length, 1);
  f.advance(1);
  assert.equal((await f.run()).notification, "outage-sent");
  assert.equal(f.disk().incident.id, id);
  assert.ok(f.disk().incident.outageDeliveredAt);
  f.advance(6 * 60 * 60000 - 1);
  assert.equal((await f.run()).notification, "none");
  f.advance(1);
  assert.equal((await f.run()).notification, "outage-sent");
  assert.match(f.messages[2].text, /Erinnerung/);
  assert.equal(f.receipts.length, 2);
});

test("recovery requires two healthy probes, prior delivered outage and confirmed recovery receipt", async (t) => {
  const f = await fixture(t);
  await f.run();
  f.healthy = true;
  f.advance(60000);
  assert.equal((await f.run()).notification, "none");
  f.responseStatus = 503;
  f.advance(60000);
  assert.equal((await f.run()).notification, "failed");
  assert.ok(f.disk().incident.outageDeliveredAt);
  f.responseStatus = 200;
  f.advance(60000);
  assert.equal((await f.run()).notification, "recovery-sent");
  assert.equal(f.disk().incident, null);
  assert.equal((await f.run()).notification, "none");
  assert.equal(f.receipts.length, 2);
});

test("an undelivered short outage is retained and reported as already resolved instead of silently discarded", async (t) => {
  const f = await fixture(t);
  f.responseStatus = 401;
  await f.run();
  const incident = f.disk().incident;
  f.healthy = true;
  f.advance(30000);
  assert.equal((await f.run()).notification, "none");
  assert.equal(f.disk().incident.id, incident.id);
  f.advance(30000);
  f.responseStatus = 200;
  assert.equal((await f.run()).notification, "resolved-outage-sent");
  assert.match(f.messages[1].text, /AUSFALL NACHTRÄGLICH GEMELDET — inzwischen behoben/);
  assert.ok(f.messages[1].text.includes(incident.firstSeenAt));
  assert.match(f.messages[1].text, /HTTP 404/);
  assert.equal(f.disk().incident, null);
  assert.equal(f.receipts.length, 1);
});

test("a relapsed outage replaces an unsent recovery notice with the current availability failure", async (t) => {
  const f = await fixture(t);
  await f.run();
  f.healthy = true;
  await f.run();
  f.responseStatus = 503;
  assert.equal((await f.run()).notification, "failed");
  f.healthy = false;
  f.responseStatus = 200;
  f.advance(60000);
  assert.equal((await f.run()).notification, "outage-sent");
  assert.equal(f.messages.length, 3);
  assert.match(f.messages[2].text, /Verschlechterung/);
  assert.doesNotMatch(f.messages[2].text, /WIEDER ERREICHBAR/);
  assert.equal(f.disk().healthyStreak, 0);
  assert.ok(f.disk().incident);
});

test("Telegram 429 retry_after=600 is honored across repeated persisted cycles", async (t) => {
  const f = await fixture(t);
  f.responseStatus = 429;
  f.retryAfter = 600;
  await f.run();
  f.responseStatus = 200;
  for (let i = 1; i < 10; i++) {
    f.advance(60000);
    assert.equal((await f.run()).notification, "deferred");
    assert.equal(f.messages.length, 1);
    assert.equal(f.disk().delivery.attempts, 1);
  }
  f.advance(60000);
  assert.equal((await f.run()).notification, "outage-sent");
  assert.equal(f.messages.length, 2);
});

test("endpoint loss escalates a previously delivered source incident immediately and retries its failed notification", async (t) => {
  const f = await fixture(t);
  f.healthy = true;
  f.modifyPayloads = ({ status }) => { status.sourceStatus.eiaOfficial.lastScanAt = "2020-01-01T00:00:00Z"; };
  assert.equal((await f.run()).notification, "outage-sent");
  f.healthy = false;
  f.advance(60000);
  f.responseStatus = 503;
  assert.equal((await f.run()).notification, "failed");
  assert.match(f.messages[1].text, /Verschlechterung/);
  assert.match(f.messages[1].text, /HTTP 404/);
  assert.equal(f.disk().incident.escalationPending, true);
  f.advance(60000);
  f.responseStatus = 200;
  assert.equal((await f.run()).notification, "outage-sent");
  assert.equal(f.disk().incident.escalationPending, false);
  assert.equal((await f.run()).notification, "none");
  assert.equal(f.receipts.length, 2);
});

test("Telegram timeout never acknowledges delivery; probe timeout is an actionable health failure", async (t) => {
  const f = await fixture(t);
  f.stallTelegram = true;
  const failed = await f.run({ telegramTimeoutMs: 20 });
  assert.equal(failed.notification, "failed");
  assert.match(failed.error, /timeout/);
  assert.equal(f.disk().incident.outageDeliveredAt, null);
  f.stallTelegram = false;
  f.stallProbe = true;
  f.advance(60000);
  assert.equal((await f.run({ probeOptions: { attempts: 1, timeoutMs: 20, retryDelayMs: 0 } })).notification, "outage-sent");
  assert.match(f.messages[1].text, /timeout/);
});

test("credentials are redacted from health errors, transport errors, saved state and returned diagnostics", async (t) => {
  const f = await fixture(t);
  f.healthy = true;
  f.modifyPayloads = ({ status }) => { status.marketLastError = `${f.token} ${f.chatId} https://example.test/?token=another-secret`; };
  f.responseStatus = 401;
  f.description = `Bad ${f.token} ${f.chatId}`;
  const result = await f.run();
  const published = JSON.stringify({ result, state: f.disk(), text: f.messages[0].text });
  for (const secret of [f.token, f.chatId, "another-secret"]) assert.equal(published.includes(secret), false);
});

test("corrupt or different-target state fails closed without sending or overwriting incident history", async (t) => {
  const f = await fixture(t);
  await f.run();
  const before = fs.readFileSync(f.stateFile, "utf8");
  await assert.rejects(f.run({ baseUrl: "http://127.0.0.1:1" }), /different-target/);
  assert.equal(fs.readFileSync(f.stateFile, "utf8"), before);
  fs.writeFileSync(f.stateFile, "{broken");
  await assert.rejects(f.run());
  assert.equal(fs.readFileSync(f.stateFile, "utf8"), "{broken");
  assert.equal(f.messages.length, 1);
});

test("no external send occurs if durable intent cannot be persisted", async (t) => {
  const f = await fixture(t);
  t.mock.method(fs, "renameSync", () => { throw new Error("storage failed"); });
  await assert.rejects(f.run(), /storage failed/);
  assert.equal(f.messages.length, 0);
});

test("invalid persisted timestamps or inconsistent delivery receipts cannot silently suppress reminders", async (t) => {
  const f = await fixture(t);
  await f.run();
  const valid = f.disk();
  for (const update of [
    { lastOutageNoticeAt: "not-a-date" }, { outageDeliveredAt: "not-a-date" },
    { lastSeenAt: "not-a-date" }, { recoveryObservedAt: "not-a-date" },
    { outageDeliveredAt: null }
  ]) {
    const broken = structuredClone(valid);
    Object.assign(broken.incident, update);
    fs.writeFileSync(f.stateFile, JSON.stringify(broken));
    await assert.rejects(f.run(), /Invalid or different-target watchdog state/);
    assert.deepEqual(f.disk(), broken);
  }
  assert.equal(f.messages.length, 1);
});

test("credential-bearing targets and public state permissions are rejected", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run({ baseUrl: "https://user:secret@example.test" }), /without credentials/);
  fs.chmodSync(path.dirname(f.stateFile), 0o755);
  await assert.rejects(f.run(), /private/);
  assert.equal(f.messages.length, 0);
});

test("a dangling state-file symlink is rejected instead of silently resetting incident history", async (t) => {
  const f = await fixture(t);
  fs.symlinkSync(path.join(path.dirname(f.stateFile), "missing-target"), f.stateFile);
  await assert.rejects(f.run(), /Invalid watchdog state file/);
  assert.equal(f.messages.length, 0);
  assert.equal(fs.lstatSync(f.stateFile).isSymbolicLink(), true);
});
