import test from "node:test";
import assert from "node:assert/strict";
import { assessHealth, versionAtLeast } from "../ops/health-check.mjs";

function healthyPayloads() {
  return {
    status: {
      system: "777",
      version: "5.1.0",
      status: "online",
      publicApiMode: "read-only",
      telegramConfigured: true,
      oilDataConfigured: true,
      journalPersistence: "persistent:/data"
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
  assert.equal(versionAtLeast("5.1.0", "5.1.0"), true);
  assert.equal(versionAtLeast("5.2.0", "5.1.0"), true);
  assert.equal(versionAtLeast("5.0.9", "5.1.0"), false);
  assert.equal(versionAtLeast("unknown", "5.1.0"), false);
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
  status.sourceStatus = {
    eiaOfficial: { ok: false, error: "HTTP 503" },
    trumpTruth: { ok: true, error: null, warning: "official endpoint unavailable" }
  };
  oil.provider.connection = "reconnecting";
  oil.provider.lastError = "stream closed";
  oil.lastError = "no current bucket";
  assert.deepEqual(assessHealth(status, oil), [
    "oil-provider-not-connected",
    "oil-provider-error:stream closed",
    "oil-monitor-error:no current bucket",
    "source-error:eiaOfficial:HTTP 503"
  ]);
});
