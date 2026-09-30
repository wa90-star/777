import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { assessHealth, probe, versionAtLeast } from "../ops/health-check.mjs";

function healthyPayloads() {
  const lastScanAt = new Date().toISOString();
  const healthySource = () => ({ ok: true, error: null, warning: null, lastScanAt });
  return {
    status: {
      system: "777",
      version: "5.2.1",
      status: "online",
      publicApiMode: "read-only",
      telegramConfigured: true,
      marketDataConfigured: true,
      marketDataSource: "alpaca-iex",
      oilDataConfigured: true,
      oilDataScope: "free-etf-proxy-iex",
      futuresDataConfigured: false,
      futuresDataStatus: "not-configured",
      futuresDataSource: null,
      futuresContracts: {},
      journalPersistence: "persistent:/data",
      catalystPersistence: "persistent:/data",
      eiaPersistence: "persistent:/data",
      ecbPersistence: "persistent:/data",
      sourceStatus: {
        trumpTruth: {
          ...healthySource(),
          ok: true,
          endpoint: "trump.fm-public-api",
          provider: "trump.fm",
          sourceClass: "public-archive",
          verification: "truth-id+canonical-url+utc-timestamp+checksum",
          requiresIndependentConfirmation: true,
          directTelegramAlerts: false
        },
        federalReserve: healthySource(),
        whiteHouse: healthySource(),
        federalRegister: healthySource(),
        pelosiOfficial: healthySource(),
        eiaOfficial: healthySource(),
        europeanCentralBank: healthySource()
      },
      kimiResearch: {
        mode: "off",
        lastError: null,
        productionInfluence: false,
        telegramInfluence: false
      }
    },
    oil: {
      status: "live",
      source: "alpaca-iex-oil-etf-proxy",
      persistence: "persistent:/data",
      provider: {
        configured: true,
        authenticated: true,
        connection: "connected",
        provider: "alpaca",
        lastError: null
      },
      lastError: null
    }
  };
}

test("compares semantic release versions without accepting malformed values", () => {
  assert.equal(versionAtLeast("5.2.1", "5.2.1"), true);
  assert.equal(versionAtLeast("5.3.0", "5.2.1"), true);
  assert.equal(versionAtLeast("5.2.0", "5.2.1"), false);
  assert.equal(versionAtLeast("unknown", "5.2.1"), false);
});

test("accepts a live, durable and authenticated deployment", () => {
  const { status, oil } = healthyPayloads();
  assert.deepEqual(assessHealth(status, oil), []);
});

test("reports independent persistence and provider failures", () => {
  const { status, oil } = healthyPayloads();
  status.journalPersistence = "fallback:/tmp/777-radar";
  oil.provider.authenticated = false;
  oil.status = "offline";
  assert.deepEqual(assessHealth(status, oil), [
    "journal-not-durable",
    "oil-provider-not-authenticated",
    "oil-monitor-not-live"
  ]);
});

test("rejects writable but ephemeral tmp persistence", () => {
  const { status, oil } = healthyPayloads();
  status.journalPersistence = "persistent:/tmp/radar-data";
  oil.persistence = "persistent:/tmp/radar-data";
  assert.deepEqual(assessHealth(status, oil), [
    "journal-not-durable",
    "oil-state-not-durable"
  ]);
});

test("reports provider connection and concrete source errors", () => {
  const { status, oil } = healthyPayloads();
  status.sourceStatus.eiaOfficial = { ok: false, error: "HTTP 503" };
  oil.provider.connection = "reconnecting";
  oil.provider.lastError = "stream closed";
  oil.lastError = "no current bucket";
  assert.deepEqual(assessHealth(status, oil), [
    "oil-provider-not-connected",
    "oil-provider-error:stream closed",
    "oil-monitor-error:no current bucket",
    "source-not-ok:eiaOfficial",
    "source-stale:eiaOfficial",
    "source-error:eiaOfficial:HTTP 503"
  ]);
});

test("fails closed on a missing or weakened Trump archive contract", () => {
  const { status, oil } = healthyPayloads();
  status.sourceStatus.trumpTruth.ok = false;
  status.sourceStatus.trumpTruth.endpoint = "mirror-fallback";
  status.sourceStatus.trumpTruth.verification = "truth-id+timestamp";
  status.sourceStatus.trumpTruth.requiresIndependentConfirmation = false;
  status.sourceStatus.trumpTruth.directTelegramAlerts = true;
  status.sourceStatus.trumpTruth.warning = "archive verification degraded";

  assert.deepEqual(assessHealth(status, oil), [
    "source-not-ok:trumpTruth",
    "source-warning:trumpTruth:archive verification degraded",
    "trump-truth-source-not-ok",
    "trump-truth-endpoint-unexpected",
    "trump-truth-verification-incomplete",
    "trump-truth-independent-confirmation-disabled",
    "trump-truth-direct-alerts-enabled"
  ]);
});

test("fails closed when the Trump source status is absent", () => {
  const { status, oil } = healthyPayloads();
  delete status.sourceStatus.trumpTruth;
  assert.deepEqual(assessHealth(status, oil), ["source-missing:trumpTruth"]);
});

test("fails closed on missing, stale or warning-only required sources", () => {
  const { status, oil } = healthyPayloads();
  delete status.sourceStatus.whiteHouse;
  status.sourceStatus.federalRegister.lastScanAt = "2026-01-01T00:00:00Z";
  status.sourceStatus.pelosiOfficial.warning = "unexpected payload";

  assert.deepEqual(assessHealth(status, oil), [
    "source-missing:whiteHouse",
    "source-stale:federalRegister",
    "source-warning:pelosiOfficial:unexpected payload"
  ]);
});

test("fails closed when Kimi safety isolation is weakened", () => {
  const { status, oil } = healthyPayloads();
  status.kimiResearch.mode = "live";
  status.kimiResearch.productionInfluence = true;
  status.kimiResearch.telegramInfluence = true;
  status.kimiResearch.lastError = "invalid-bundle";

  assert.deepEqual(assessHealth(status, oil), [
    "kimi-mode-unsafe",
    "kimi-production-influence-enabled",
    "kimi-telegram-influence-enabled",
    "kimi-error:invalid-bundle"
  ]);
});

test("checks every persisted subsystem and the primary market feed", () => {
  const { status, oil } = healthyPayloads();
  status.marketDataConfigured = false;
  status.marketDataSource = "unknown";
  status.catalystPersistence = "fallback:/tmp/777-radar";
  status.eiaPersistence = "memory-only";
  status.ecbPersistence = null;

  assert.deepEqual(assessHealth(status, oil), [
    "market-data-not-configured",
    "market-data-source-unexpected",
    "catalyst-state-not-durable",
    "eia-state-not-durable",
    "ecb-state-not-durable"
  ]);
});

test("fails closed when an ETF proxy is exposed as futures data", () => {
  const { status, oil } = healthyPayloads();
  status.futuresDataConfigured = true;
  status.futuresDataStatus = "live";
  status.futuresDataSource = "alpaca-iex-oil-etf-proxy";
  status.futuresContracts = { CL: { ticker: "USO" } };

  assert.deepEqual(assessHealth(status, oil), [
    "oil-proxy-mislabeled-as-futures",
    "futures-status-unexpected-for-proxy",
    "futures-source-present-for-proxy",
    "futures-contracts-present-for-proxy"
  ]);
});


test("rejects prerelease or malformed suffix masquerading as a stable release", () => {
  for (const value of ["5.2.1-rc.1", "5.2.1oops", "5.2.1.4"]) assert.equal(versionAtLeast(value, "5.2.1"), false);
  assert.equal(versionAtLeast("5.2.1+build.1", "5.2.1"), true);
});

test("enforces exact freshness boundary and future tolerance", () => {
  const { status, oil } = healthyPayloads();
  const nowMs = Date.now();
  status.sourceStatus.eiaOfficial.lastScanAt = new Date(nowMs - 45 * 60000).toISOString();
  assert.deepEqual(assessHealth(status, oil, { nowMs }), []);
  status.sourceStatus.eiaOfficial.lastScanAt = new Date(nowMs - 45 * 60000 - 1).toISOString();
  assert.ok(assessHealth(status, oil, { nowMs }).includes("source-stale:eiaOfficial"));
  status.sourceStatus.eiaOfficial.lastScanAt = new Date(nowMs + 5 * 60000 + 1).toISOString();
  assert.ok(assessHealth(status, oil, { nowMs }).includes("source-stale:eiaOfficial"));
});

test("alarms on provider and delivery failures despite otherwise healthy endpoints", () => {
  const { status, oil } = healthyPayloads();
  status.marketLastError = "HTTP 401";
  status.telegramDelivery = { lastError: "Telegram HTTP 429" };
  status.deliveryStatus = { policy: { pending: 1, failed: 2, error: "retry-exhausted", oldestPendingAt: new Date(Date.now() - 6 * 60000).toISOString() } };
  assert.deepEqual(assessHealth(status, oil), ["market-provider-error:HTTP 401", "telegram-delivery-error:Telegram HTTP 429", "delivery-error:policy:retry-exhausted", "delivery-failed:policy:2", "delivery-backlog-stale:policy"]);
});

async function withServer(handler, task) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await task(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

test("HTTP probe records both unavailable endpoints with bounded retries", async () => {
  let calls = 0;
  await withServer((req, res) => { calls++; res.writeHead(404); res.end("Application not found"); }, async (baseUrl) => {
    const result = await probe({ baseUrl, attempts: 2, retryDelayMs: 0, timeoutMs: 1000 });
    assert.equal(result.ok, false);
    assert.equal(calls, 4);
    assert.equal(result.errors.length, 2);
    for (const error of result.errors) {
      assert.match(error, /\/api\/status: HTTP 404/);
      assert.match(error, /\/api\/oil-monitor: HTTP 404/);
    }
  });
});

test("HTTP probe recovers from one transient failure and checks real response JSON", async () => {
  let statusCalls = 0;
  await withServer((req, res) => {
    const { status, oil } = healthyPayloads();
    if (req.url === "/api/status" && ++statusCalls === 1) { res.writeHead(503); res.end(); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url === "/api/status" ? status : oil));
  }, async (baseUrl) => {
    const result = await probe({ baseUrl, attempts: 2, retryDelayMs: 0, timeoutMs: 1000 });
    assert.equal(result.ok, true);
    assert.equal(statusCalls, 2);
  });
});

test("HTTP probe rejects malformed JSON and reports the endpoint", async () => {
  await withServer((req, res) => res.end("{broken"), async (baseUrl) => {
    const result = await probe({ baseUrl, attempts: 1, timeoutMs: 1000 });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /\/api\/status:/);
    assert.match(result.errors[0], /\/api\/oil-monitor:/);
  });
});

test("HTTP probe times out stalled responses without hanging", async () => {
  await withServer(() => {}, async (baseUrl) => {
    const result = await probe({ baseUrl, attempts: 1, timeoutMs: 40 });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /\/api\/status: timeout/);
    assert.match(result.errors[0], /\/api\/oil-monitor: timeout/);
  });
});

test("HTTP probe refuses invalid budgets rather than silently passing or looping", async () => {
  for (const attempts of [0, -1, NaN, Infinity, 1.5, 6]) await assert.rejects(probe({ attempts }), /Invalid attempts/);
});
