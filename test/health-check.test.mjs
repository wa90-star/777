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
      persistence: "persistent:/data",
      provider: { configured: true, authenticated: true }
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
    "journal-not-persistent",
    "oil-provider-not-authenticated",
    "oil-monitor-not-live"
  ]);
});

