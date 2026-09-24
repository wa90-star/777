import test from "node:test";
import assert from "node:assert/strict";
import { assessHealth, versionAtLeast } from "../ops/health-check.mjs";

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
