import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assessHealth, assessInformationHealth, probe } from "../ops/health-check.mjs";
import { createIncidentReport, parseHealthOutput } from "../ops/health-report.mjs";

const NOW = Date.parse("2026-11-05T21:25:00Z"), FRESH = new Date(NOW).toISOString();
function fixtures() {
  const source = () => ({ ok: true, lastScanAt: FRESH, error: null, warning: null });
  const channel = () => ({ pending: 0, failed: 0, sent: 0, suppressed: 0, lastReceiptAt: null, error: null });
  return { status: {
    system: "777", version: "5.3.0", status: "online", publicApiMode: "read-only", telegramConfigured: true,
    marketDataConfigured: false, marketDataSource: "alpaca-iex", marketExecutionGate: "decision-engine-v5.executionQuality",
    extremeOverrideEnabled: false, marketDataMaxAgeMinutes: 5, oilDataConfigured: false,
    journalPersistence: "persistent:/data", catalystPersistence: "persistent:/data", eiaPersistence: "persistent:/data", ecbPersistence: "persistent:/data",
    sourceStatus: Object.fromEntries(["trumpTruth", "federalReserve", "whiteHouse", "federalRegister", "pelosiOfficial", "eiaOfficial", "europeanCentralBank"].map(name => [name, name === "trumpTruth" ? {
      ...source(), endpoint: "trump.fm-public-api", provider: "trump.fm", sourceClass: "public-archive",
      verification: "truth-id+canonical-url+utc-timestamp+checksum", requiresIndependentConfirmation: true, directTelegramAlerts: false
    } : source()])),
    kimiResearch: { mode: "off", productionInfluence: false, telegramInfluence: false },
    energyFuelsHandoff: { pendingCount: 0 },
    generalInformation: { enabled: true, notificationMode: "PRIMARY_SOURCE_INFORMATION", informationNoticesExecutionEligible: false, deliveryEnabled: true,
      informationDeliveryStatus: { policy: channel(), eia: channel(), ecb: channel() } },
    telegramDelivery: { configured: true, targetType: "private", targetVerifiedAt: FRESH },
    deliveryProbe: { status: "CONFIRMED", messageId: 108, providerAcceptedAt: FRESH },
    energyFuelsPrimary: { enabled: true, configured: true, intervalMinutes: 10, lastCollectionAt: FRESH, tradePermission: false,
      nativeFokusAutomationConnected: false, status: { pendingNotices: 0, pendingActionable: 0, pendingUnclassified: 0, deliveredNotices: 0,
        sources: Object.fromEntries(["dod", "doe-main", "doe-ne", "ef-ir", "eia", "mofcom-orders", "mofcom-press", "mofcom-remarks", "sec", "usgs"].map(name => [name, { status: "OK", lastSuccessAt: FRESH, warnings: [] }])) } }
  }, oil: { status: "offline", persistence: "persistent:/data", source: "alpaca-iex-oil-etf-proxy", provider: { configured: false, authenticated: false, connection: "disabled", provider: "alpaca" } } };
}
const assess = ({ status, oil }) => assessInformationHealth(status, oil, { nowMs: NOW });

test("information operation works but missing trading data is explicitly degraded, strict remains strict", () => {
  const pair = fixtures(), result = assess(pair);
  assert.equal(result.operationalOk, true); assert.equal(result.ok, false); assert.equal(result.goalComplete, false);
  assert.equal(result.state, "capability-degraded"); assert.equal(result.incidentRequired, false);
  assert.ok(result.capabilityDegraded.includes("market-data-not-configured"));
  assert.ok(assessHealth(pair.status, pair.oil, { nowMs: NOW }).includes("market-data-not-configured"));
  assert.equal(result.deliveryEvidence.connectionProbeObserved, true);
  assert.equal(result.deliveryEvidence.ordinaryReceiptObserved, false);
});
test("a connection probe cannot masquerade as an ordinary EF or information receipt", () => {
  const pair = fixtures(); pair.status.energyFuelsPrimary.status.deliveredNotices = 1;
  assert.equal(assess(pair).deliveryEvidence.ordinaryReceiptObserved, false);
  pair.status.energyFuelsPrimary.lastDeliveryAt = FRESH;
  const evidence = assess(pair).deliveryEvidence;
  assert.equal(evidence.efReceiptObserved, true); assert.equal(evidence.informationReceiptObserved, false);
  assert.equal(evidence.deviceReadConfirmed, false);
});
test("legacy expired Telegram channels remain review-required, mixed quote failures are not messages", () => {
  const pair = fixtures();
  pair.status.generalInformation.informationDeliveryStatus.policy = { pending: 0, failed: 4, sent: 0, suppressed: 0, error: "delivery-expired-requires-review" };
  pair.status.deliveryStatus = { policy: { pending: 0, failed: 8, error: "marketRecheck: Alpaca not configured" } };
  const result = assess(pair);
  assert.equal(result.ok, false); assert.equal(result.incidentRequired, true); assert.equal(result.operationalOk, true);
  assert.deepEqual(result.reviewRequired, ["information-delivery-expired:policy:4"]);
  assert.equal(result.operationalFailures.some(value => value.includes("Alpaca") || value.includes(":8")), false);
});
test("new channel send failures, missing status and unknown pending age cannot pass", () => {
  for (const change of [
    p => { p.status.generalInformation.informationDeliveryStatus.eia.error = "Telegram 403"; },
    p => { delete p.status.generalInformation.informationDeliveryStatus.ecb; },
    p => { p.status.generalInformation.informationDeliveryStatus.policy.pending = 1; },
    p => { p.status.telegramDelivery.targetType = "group"; },
    p => { p.status.energyFuelsPrimary.configured = false; }
  ]) { const pair = fixtures(); change(pair); assert.equal(assess(pair).operationalOk, false); }
});
test("pending age uses Telegram's own timestamp and catches true stale backlog", () => {
  const pair = fixtures(), channel = pair.status.generalInformation.informationDeliveryStatus.policy;
  channel.pending = 1; channel.oldestPendingAt = FRESH;
  pair.status.deliveryStatus = { policy: { pending: 1, oldestPendingAt: "2020-01-01", error: "marketRecheck: old" } };
  assert.equal(assess(pair).operationalOk, true);
  channel.oldestPendingAt = new Date(NOW - 5 * 60000 - 1).toISOString();
  assert.ok(assess(pair).operationalFailures.includes("information-delivery-backlog-stale:policy"));
});
test("all source, durable storage and safety failures remain operational failures", () => {
  for (const change of [
    p => { p.status.sourceStatus.whiteHouse.lastScanAt = "2020-01-01"; },
    p => { p.status.energyFuelsPrimary.lastCollectionAt = "2020-01-01"; },
    p => { p.status.energyFuelsPrimary.status.sources.sec.warnings = ["gap"]; },
    p => { p.status.energyFuelsPrimary.status.sources.other = p.status.energyFuelsPrimary.status.sources.sec; delete p.status.energyFuelsPrimary.status.sources.sec; },
    p => { p.status.generalInformation.informationNoticesExecutionEligible = true; },
    p => { p.status.journalPersistence = "persistent:/tmp"; },
    p => { p.status.energyFuelsPrimary.deliveryPaused = true; },
    p => { p.status.energyFuelsPrimary.tradePermission = true; },
    p => { p.status.energyFuelsPrimary.status.pendingActionable = "unavailable"; },
    p => { p.status.energyFuelsPrimary.status.pendingActionable = 1; }
  ]) { const pair = fixtures(); change(pair); assert.equal(assess(pair).operationalOk, false); }
});
test("unknown EF classification is review-required, never a successful delivery", () => {
  const pair = fixtures(); pair.status.energyFuelsPrimary.status.pendingUnclassified = 1;
  const result = assess(pair);
  assert.deepEqual(result.reviewRequired, ["ef-primary-unclassified:1"]);
  assert.equal(result.incidentRequired, true); assert.equal(result.deliveryEvidence.ordinaryReceiptObserved, false);
});
test("unconsumed native handoff is its own review class and never a Telegram error", () => {
  const pair = fixtures(); pair.status.energyFuelsHandoff.pendingCount = 143;
  const result = assess(pair);
  assert.deepEqual(result.reviewRequired, ["energy-fuels-handoff-unconsumed:143"]);
  assert.equal(result.operationalOk, true); assert.equal(result.ok, false); assert.equal(result.incidentRequired, true);
  assert.deepEqual(result.operationalFailures, []);
  for (const value of [undefined, null, "143", -1, 1.5, NaN]) {
    pair.status.energyFuelsHandoff.pendingCount = value;
    assert.ok(assess(pair).operationalFailures.includes("energy-fuels-handoff-pending-count-invalid"));
  }
});
test("alternative price context cannot weaken privacy/trading gates or hide a stalled runtime", () => {
  const pair = fixtures(); pair.status.alternativeMarketContext = { enabled: true, configured: true, running: true,
    executionEligible: false, lastPollAt: FRESH, provider: { rawDataPublic: false, privatePriceDisplayEnabled: false, regularSessionWindow: false, freshSymbols: 0 } };
  assert.equal(assess(pair).operationalOk, true);
  pair.status.alternativeMarketContext.lastPollAt = "2020-01-01";
  assert.ok(assess(pair).capabilityDegraded.includes("alternative-market-context-runtime-degraded"));
  pair.status.alternativeMarketContext.provider.rawDataPublic = true;
  assert.equal(assess(pair).operationalOk, false);
});
test("incident fingerprints ignore scan/run timestamps but change on actual faults", () => {
  const result = assess(fixtures());
  const first = createIncidentReport(result, { checkedAt: FRESH, runUrl: "run/1" });
  const later = createIncidentReport({ ...result, checkedAt: "later" }, { checkedAt: "later", runUrl: "run/2" });
  assert.equal(first.fingerprint, later.fingerprint);
  assert.notEqual(first.fingerprint, createIncidentReport({ ...result, operationalFailures: ["source-stale:whiteHouse"] }).fingerprint);
  assert.match(first.body, /Fehlende Fähigkeiten/);
  assert.match(first.body, /keine vollständige Zielerreichung/);
});
test("invalid health output fails closed without publishing arbitrary log text", () => {
  const result = parseHealthOutput("this could contain a secret, not a health result");
  assert.equal(result.incidentRequired, true);
  assert.doesNotMatch(createIncidentReport(result).body, /could contain a secret/);
  const valid = assess(fixtures());
  assert.deepEqual(parseHealthOutput('noise\nRADAR_INFORMATION_CAPABILITY_DEGRADED '+JSON.stringify(valid)), valid);
  for (const invalid of [{ ok: true }, { ...valid, operationalOk: false }, { ...valid, reviewRequired: ["unresolved"], incidentRequired: false }]) {
    assert.equal(parseHealthOutput('RADAR_INFORMATION_CAPABILITY_DEGRADED '+JSON.stringify(invalid)).incidentRequired, true);
  }
});
test("report CLI blocks recovery on missing/invalid reports and passes only validated no-incident output", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "radar-health-report-"));
  const input = path.join(directory, "probe.txt"), output = path.join(directory, "report.md");
  const cli = fileURLToPath(new URL("../ops/health-report.mjs", import.meta.url));
  const env = { ...process.env }; delete env.GITHUB_STEP_SUMMARY;
  try {
    const run = () => spawnSync(process.execPath, [cli, input, output], { encoding: "utf8", env });
    assert.notEqual(run().status, 0);
    fs.writeFileSync(input, "unrecognized log output");
    assert.equal(run().status, 1);
    assert.match(fs.readFileSync(output, "utf8"), /health-probe-output-missing-or-invalid/);
    const valid = assess(fixtures());
    fs.writeFileSync(input, 'RADAR_INFORMATION_CAPABILITY_DEGRADED '+JSON.stringify(valid));
    assert.equal(run().status, 0);
    const pair = fixtures(); pair.status.energyFuelsHandoff.pendingCount = 1;
    fs.writeFileSync(input, 'RADAR_INFORMATION_REVIEW_REQUIRED '+JSON.stringify(assess(pair)));
    assert.equal(run().status, 1);
  } finally {
    // Only the exact temporary files created above are removed; no recursive delete.
    for (const file of [input, output]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
});
test("HTTP information probe exposes degraded capabilities, ordinary receipt limits and refuses wrong profiles", async () => {
  const pair = fixtures();
  const server = http.createServer((req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(req.url === "/api/status" ? pair.status : pair.oil)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await probe({ profile: "information", baseUrl: `http://127.0.0.1:${server.address().port}`, attempts: 1, now: () => NOW });
    assert.equal(result.ok, false); assert.equal(result.operationalOk, true); assert.equal(result.incidentRequired, false);
    assert.equal(result.state, "capability-degraded");
    await assert.rejects(probe({ profile: "ignore-errors" }), /Invalid health profile/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("final HTTP failure cannot retain an earlier operationalOk information assessment", async () => {
  const pair = fixtures(); pair.status.energyFuelsPrimary.status.pendingUnclassified = 1;
  let calls = 0;
  const server = http.createServer((req, res) => {
    if (++calls > 2) { res.writeHead(503); res.end(); return; }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(req.url === "/api/status" ? pair.status : pair.oil));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await probe({ profile: "information", baseUrl: `http://127.0.0.1:${server.address().port}`, attempts: 2, retryDelayMs: 0, now: () => NOW });
    assert.equal(result.operationalOk, false); assert.equal(result.incidentRequired, true);
    assert.equal(result.state, "operational-failure"); assert.equal(result.errors.length, 2);
    const parsed = parseHealthOutput('RADAR_INFORMATION_OPERATIONAL_FAILURE '+JSON.stringify(result));
    assert.equal(parsed.incidentRequired, true);
    assert.ok(parsed.operationalFailures.some(value => value.includes('HTTP 503')));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
