import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://radar-v5-image-production.up.railway.app";
const DEFAULT_MIN_VERSION = "5.2.1";
const DEFAULT_EXPECTED_PERSISTENCE_PATH = "/data";
const DEFAULT_SOURCE_MAX_AGE_MS = 45 * 60 * 1000;
const REQUIRED_SOURCES = [
  "trumpTruth",
  "federalReserve",
  "whiteHouse",
  "federalRegister",
  "pelosiOfficial",
  "eiaOfficial",
  "europeanCentralBank"
];

function numericVersion(value) {
  const match = String(value || "").match(/^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/);
  return match ? match.slice(1).map(Number) : null;
}

export function versionAtLeast(actual, minimum) {
  const left = numericVersion(actual);
  const right = numericVersion(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

function isDurablePersistence(value, expectedPath) {
  return String(value || "") === `persistent:${expectedPath}`;
}

function isFreshTimestamp(value, nowMs, maxAgeMs) {
  const timestamp = new Date(value || "").getTime();
  const age = nowMs - timestamp;
  return Number.isFinite(timestamp) && age >= -5 * 60 * 1000 && age <= maxAgeMs;
}

export function assessHealth(
  status,
  oil,
  {
    minimumVersion = DEFAULT_MIN_VERSION,
    expectedPersistencePath = DEFAULT_EXPECTED_PERSISTENCE_PATH,
    sourceMaxAgeMs = DEFAULT_SOURCE_MAX_AGE_MS,
    nowMs = Date.now()
  } = {}
) {
  const failures = [];
  if (status?.system !== "777") failures.push("unexpected-system");
  if (status?.status !== "online") failures.push("service-not-online");
  if (!versionAtLeast(status?.version, minimumVersion)) failures.push(`version-below-${minimumVersion}`);
  if (status?.publicApiMode !== "read-only") failures.push("public-api-not-read-only");
  if (status?.telegramConfigured !== true) failures.push("telegram-not-configured");
  if (status?.marketDataConfigured !== true) failures.push("market-data-not-configured");
  if (status?.marketDataSource !== "alpaca-iex") failures.push("market-data-source-unexpected");
  if (status?.marketExecutionGate !== "decision-engine-v5.executionQuality") {
    failures.push("market-execution-gate-unexpected");
  }
  if (status?.extremeOverrideEnabled !== false) failures.push("extreme-override-enabled-or-unknown");
  if (!Number.isFinite(status?.marketDataMaxAgeMinutes) || status.marketDataMaxAgeMinutes <= 0
      || status.marketDataMaxAgeMinutes > 5) failures.push("market-data-age-gate-weakened");
  if (status?.oilDataConfigured !== true) failures.push("oil-data-not-configured");
  if (status?.oilDataScope === "free-etf-proxy-iex") {
    if (status?.futuresDataConfigured !== false) failures.push("oil-proxy-mislabeled-as-futures");
    if (status?.futuresDataStatus !== "not-configured") failures.push("futures-status-unexpected-for-proxy");
    if (status?.futuresDataSource != null) failures.push("futures-source-present-for-proxy");
    if (Object.keys(status?.futuresContracts || {}).length > 0) failures.push("futures-contracts-present-for-proxy");
  }
  if (!isDurablePersistence(status?.journalPersistence, expectedPersistencePath)) {
    failures.push("journal-not-durable");
  }
  if (!isDurablePersistence(status?.catalystPersistence, expectedPersistencePath)) {
    failures.push("catalyst-state-not-durable");
  }
  if (!isDurablePersistence(status?.eiaPersistence, expectedPersistencePath)) {
    failures.push("eia-state-not-durable");
  }
  if (!isDurablePersistence(status?.ecbPersistence, expectedPersistencePath)) {
    failures.push("ecb-state-not-durable");
  }
  if (!isDurablePersistence(oil?.persistence, expectedPersistencePath)) {
    failures.push("oil-state-not-durable");
  }
  if (oil?.provider?.configured !== true) failures.push("oil-provider-not-configured");
  if (oil?.provider?.authenticated !== true) failures.push("oil-provider-not-authenticated");
  if (oil?.provider?.connection !== "connected") failures.push("oil-provider-not-connected");
  if (oil?.provider?.provider !== "alpaca" || oil?.source !== "alpaca-iex-oil-etf-proxy") {
    failures.push("oil-source-unexpected");
  }
  if (oil?.provider?.lastError) failures.push(`oil-provider-error:${oil.provider.lastError}`);
  if (oil?.lastError) failures.push(`oil-monitor-error:${oil.lastError}`);
  const sourceStatus = status?.sourceStatus || {};
  for (const name of REQUIRED_SOURCES) {
    const source = sourceStatus[name];
    if (!source) {
      failures.push(`source-missing:${name}`);
      continue;
    }
    if (source.ok !== true) failures.push(`source-not-ok:${name}`);
    if (!isFreshTimestamp(source.lastScanAt, nowMs, sourceMaxAgeMs)) failures.push(`source-stale:${name}`);
  }
  for (const [name, source] of Object.entries(sourceStatus)) {
    if (source?.error) failures.push(`source-error:${name}:${source.error}`);
    if (source?.warning) failures.push(`source-warning:${name}:${source.warning}`);
  }
  const trumpTruth = sourceStatus.trumpTruth;
  if (trumpTruth) {
    if (trumpTruth.ok !== true) failures.push("trump-truth-source-not-ok");
    if (trumpTruth.endpoint !== "trump.fm-public-api") failures.push("trump-truth-endpoint-unexpected");
    if (trumpTruth.provider !== "trump.fm") failures.push("trump-truth-provider-unexpected");
    if (trumpTruth.sourceClass !== "public-archive") failures.push("trump-truth-source-class-unexpected");
    if (trumpTruth.verification !== "truth-id+canonical-url+utc-timestamp+checksum") {
      failures.push("trump-truth-verification-incomplete");
    }
    if (trumpTruth.requiresIndependentConfirmation !== true) {
      failures.push("trump-truth-independent-confirmation-disabled");
    }
    if (trumpTruth.directTelegramAlerts !== false) failures.push("trump-truth-direct-alerts-enabled");
  }
  const kimi = status?.kimiResearch;
  if (!kimi) failures.push("kimi-status-missing");
  else {
    if (!new Set(["off", "shadow"]).has(kimi.mode)) failures.push("kimi-mode-unsafe");
    if (kimi.productionInfluence !== false) failures.push("kimi-production-influence-enabled");
    if (kimi.telegramInfluence !== false) failures.push("kimi-telegram-influence-enabled");
    if (kimi.lastError) failures.push(`kimi-error:${kimi.lastError}`);
  }
  if (status?.marketLastError) failures.push(`market-provider-error:${status.marketLastError}`);
  for (const field of ["lastError", "lastEquityError"]) {
    if (status?.energyFuelsHandoff?.[field]) failures.push(`energy-fuels-handoff-error:${field}:${status.energyFuelsHandoff[field]}`);
  }
  if (status?.telegramDelivery?.lastError) failures.push(`telegram-delivery-error:${status.telegramDelivery.lastError}`);
  const ef = status?.energyFuelsPrimary;
  if (ef?.enabled === true) {
    if (ef.deliveryPaused) failures.push("ef-primary-delivery-paused");
    if (ef.lastDeliveryError) failures.push("ef-primary-delivery-error");
    if (ef.lastCollectionError) failures.push("ef-primary-collection-degraded");
    const maxAge = Math.min(45, Math.max(10, Number(ef.intervalMinutes || 10) * 2)) * 60000;
    if (!isFreshTimestamp(ef.lastCollectionAt, nowMs, maxAge)) failures.push("ef-primary-scan-stale");
    const efSources = Object.entries(ef.status?.sources || {});
    if (efSources.length !== 10) failures.push("ef-primary-source-coverage-incomplete");
    for (const [name, source] of efSources) {
      if (source.status !== "OK" || source.warnings?.length || !isFreshTimestamp(source.lastSuccessAt, nowMs, maxAge)) failures.push(`ef-primary-source-degraded:${name}`);
    }
  }
  for (const [name, delivery] of Object.entries(status?.deliveryStatus || {})) {
    if (delivery?.error) failures.push(`delivery-error:${name}:${delivery.error}`);
    if (Number(delivery?.failed || 0) > 0) failures.push(`delivery-failed:${name}:${delivery.failed}`);
    if (Number(delivery?.pending || 0) > 0 && !isFreshTimestamp(delivery.oldestPendingAt, nowMs, 5 * 60 * 1000)) {
      failures.push(`delivery-backlog-stale:${name}`);
    }
  }
  if (oil?.status !== "live") failures.push("oil-monitor-not-live");
  return failures;
}

// The original strict profile remains the default. Information mode cannot make
// absent trading data or an unproved ordinary delivery look fully healthy.
const CAPABILITY_FAILURE = /^(?:market-data-not-configured|market-data-source-unexpected|oil-data-not-configured|oil-provider-not-configured|oil-provider-not-authenticated|oil-provider-not-connected|oil-source-unexpected|oil-monitor-not-live|market-provider-error:|oil-provider-error:|oil-monitor-error:)/;
const MIXED_DELIVERY_FAILURE = /^delivery-(?:error|failed|backlog-stale):/;

export function assessInformationHealth(status, oil, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const strictFailures = assessHealth(status, oil, options);
  const capabilityDegraded = strictFailures.filter(value => CAPABILITY_FAILURE.test(value));
  // Mixed channel totals include Alpaca rechecks. Use Telegram's own totals;
  // never mislabel those quote failures as failed messages.
  const operationalFailures = strictFailures.filter(value => !CAPABILITY_FAILURE.test(value) && !MIXED_DELIVERY_FAILURE.test(value));
  const reviewRequired = [];
  const handoffPending = status?.energyFuelsHandoff?.pendingCount;
  if (!Number.isInteger(handoffPending) || handoffPending < 0) operationalFailures.push("energy-fuels-handoff-pending-count-invalid");
  else if (handoffPending > 0) reviewRequired.push(`energy-fuels-handoff-unconsumed:${handoffPending}`);
  const info = status?.generalInformation;
  if (info?.enabled !== true) operationalFailures.push("information-mode-not-enabled");
  if (info?.notificationMode !== "PRIMARY_SOURCE_INFORMATION") operationalFailures.push("information-mode-contract-unexpected");
  if (info?.informationNoticesExecutionEligible !== false) operationalFailures.push("information-trading-gate-unsafe");
  if (info?.deliveryEnabled !== true) operationalFailures.push("information-delivery-not-enabled");
  if (status?.energyFuelsPrimary?.enabled !== true) operationalFailures.push("ef-primary-not-enabled");
  if (status?.energyFuelsPrimary?.configured !== true) operationalFailures.push("ef-primary-sender-not-configured");
  const transport = status?.telegramDelivery;
  if (transport?.configured !== true) operationalFailures.push("telegram-transport-not-configured");
  if (transport?.targetType !== "private" || !Number.isFinite(Date.parse(transport?.targetVerifiedAt || ""))
      || Date.parse(transport.targetVerifiedAt) > nowMs + 5 * 60000) {
    operationalFailures.push("telegram-private-target-not-verified");
  }
  const channels = {};
  for (const name of ["policy", "eia", "ecb"]) {
    const channel = info?.informationDeliveryStatus?.[name];
    channels[name] = channel || null;
    if (!channel || ["pending", "failed", "sent", "suppressed"].some(key => !Number.isInteger(channel[key]) || channel[key] < 0)) {
      operationalFailures.push(`information-delivery-state-invalid:${name}`);
      continue;
    }
    if (Object.hasOwn(channel, "reviewSchema")) {
      const valid = channel.reviewSchema === 1 && channel.reviewScope === "MANUAL_SOURCE_DATE_NOTICE_TYPE" &&
        ["ok", "missing", "error"].includes(channel.reviewStoreStatus) &&
        ["expiredFailed", "reviewedFailed", "unreviewedFailed", "otherFailed"].every(key => Number.isSafeInteger(channel[key]) && channel[key] >= 0) &&
        channel.failed === channel.expiredFailed + channel.otherFailed && channel.expiredFailed === channel.reviewedFailed + channel.unreviewedFailed &&
        (channel.reviewStoreStatus === "ok" || channel.reviewedFailed === 0) &&
        [null, "telegram-delivery-error", "delivery-state-persistence-failed"].includes(channel.activeDeliveryError);
      if (!valid) {
        operationalFailures.push(`information-review-state-invalid:${name}`);
        if (channel.failed > 0) reviewRequired.push(`information-delivery-review-unverified:${name}:${channel.failed}`);
      } else {
        if (channel.reviewStoreStatus === "error") operationalFailures.push(`information-review-store-error:${name}`);
        if (channel.unreviewedFailed > 0) reviewRequired.push(`information-delivery-expired:${name}:${channel.unreviewedFailed}`);
        if (channel.otherFailed > 0) operationalFailures.push(`information-delivery-failed:${name}:${channel.otherFailed}`);
        if (channel.activeDeliveryError) operationalFailures.push(`information-delivery-error:${name}:${channel.activeDeliveryError}`);
        if (channel.error && channel.error !== "delivery-expired-requires-review") operationalFailures.push(`information-delivery-error:${name}:${channel.error}`);
      }
    } else if (channel.error === "delivery-expired-requires-review" && channel.failed > 0) {
      reviewRequired.push(`information-delivery-expired:${name}:${channel.failed}`);
    } else {
      if (channel.error) operationalFailures.push(`information-delivery-error:${name}:${channel.error}`);
      if (channel.failed > 0) operationalFailures.push(`information-delivery-failed:${name}:${channel.failed}`);
    }
    if (channel.pending > 0) {
      // Older APIs do not expose a Telegram-specific timestamp. Do not borrow
      // the age of an unrelated market/handoff channel or silently assume fresh.
      if (!channel.oldestPendingAt) operationalFailures.push(`information-delivery-pending-age-unavailable:${name}`);
      else if (!isFreshTimestamp(channel.oldestPendingAt, nowMs, 5 * 60000)) operationalFailures.push(`information-delivery-backlog-stale:${name}`);
    }
  }
  const ef = status?.energyFuelsPrimary;
  if (ef?.tradePermission !== false) operationalFailures.push("ef-primary-trading-gate-unsafe");
  for (const key of ["pendingNotices", "pendingActionable", "pendingUnclassified", "deliveredNotices"]) {
    if (!Number.isInteger(ef?.status?.[key]) || ef.status[key] < 0) operationalFailures.push(`ef-primary-delivery-count-invalid:${key}`);
  }
  for (const name of ["dod", "doe-main", "doe-ne", "ef-ir", "eia", "mofcom-orders", "mofcom-press", "mofcom-remarks", "sec", "usgs"]) {
    if (!ef?.status?.sources?.[name]) operationalFailures.push(`ef-primary-required-source-missing:${name}`);
  }
  if (Number(ef?.status?.pendingActionable || 0) > 0) operationalFailures.push("ef-primary-actionable-backlog");
  if (Number(ef?.status?.pendingUnclassified || 0) > 0) reviewRequired.push(`ef-primary-unclassified:${ef.status.pendingUnclassified}`);
  if (ef?.nativeFokusAutomationConnected !== true) capabilityDegraded.push("native-fokus-consumer-not-connected");
  const alternative = status?.alternativeMarketContext;
  if (alternative?.enabled === true) {
    if (alternative.executionEligible !== false || alternative.provider?.rawDataPublic !== false || alternative.provider?.privatePriceDisplayEnabled !== false) {
      operationalFailures.push("alternative-market-context-safety-contract-invalid");
    }
    if (!alternative.configured || !alternative.running || alternative.lastError || !isFreshTimestamp(alternative.lastPollAt, nowMs, 60000)) {
      capabilityDegraded.push("alternative-market-context-runtime-degraded");
    }
    if (alternative.provider?.regularSessionWindow === true && Number(alternative.provider.freshSymbols || 0) === 0) {
      capabilityDegraded.push("alternative-market-context-no-fresh-observations");
    }
  }
  const ordinaryReceipts = Object.values(channels).map(channel => channel?.lastReceiptAt)
    .filter(value => Number.isFinite(Date.parse(value || "")) && Date.parse(value) <= nowMs + 5 * 60000);
  const informationReceiptObserved = ordinaryReceipts.length > 0;
  const efStoredReceiptAt = ef?.status?.lastSourceTelegramReceiptAt;
  const efStoredReceiptMs = typeof efStoredReceiptAt === "string" ? Date.parse(efStoredReceiptAt) : NaN;
  const efReceiptObserved = Number(ef?.status?.deliveredNotices) > 0 && Number.isFinite(efStoredReceiptMs)
    && new Date(efStoredReceiptMs).toISOString() === efStoredReceiptAt && efStoredReceiptMs <= nowMs + 5 * 60000;
  if (efReceiptObserved) ordinaryReceipts.push(efStoredReceiptAt);
  const probe = status?.deliveryProbe;
  const connectionProbeObserved = probe?.status === "CONFIRMED" && Number.isInteger(probe.messageId) && probe.messageId > 0
    && Number.isFinite(Date.parse(probe.providerAcceptedAt || "")) && Date.parse(probe.providerAcceptedAt) <= nowMs + 5 * 60000;
  const state = operationalFailures.length ? "operational-failure" : reviewRequired.length ? "review-required"
    : capabilityDegraded.length ? "capability-degraded" : ordinaryReceipts.length ? "monitored-checks-passed" : "delivery-verification-incomplete";
  return {
    profile: "information", state,
    ok: !operationalFailures.length && !reviewRequired.length && !capabilityDegraded.length && ordinaryReceipts.length > 0,
    operationalOk: operationalFailures.length === 0,
    incidentRequired: operationalFailures.length > 0 || reviewRequired.length > 0,
    goalComplete: false,
    operationalFailures, capabilityDegraded, reviewRequired,
    information: { enabled: info?.enabled === true, deliveryEnabled: info?.deliveryEnabled === true, channels },
    deliveryEvidence: { ordinaryReceiptObserved: ordinaryReceipts.length > 0, informationReceiptObserved, efReceiptObserved,
      latestStoredOrdinaryReceiptAt: ordinaryReceipts.sort().at(-1) || null,
      connectionProbeObserved, connectionProbeAt: connectionProbeObserved ? probe.providerAcceptedAt : null,
      deviceReadConfirmed: false,
      limitation: "Saved provider receipts are historical evidence; they do not prove continuous delivery or that today's ordinary notice arrived." },
    monitoringLimitation: "A successful sample does not prove continuous monitoring. Scheduled-run gaps need a separate observer."
  };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchJson(url, timeoutMs) {
  let response;
  try {
    response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "777-radar-health-watchdog" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    const reason = new Set(["TimeoutError", "AbortError"]).has(error.name) ? "timeout" : error.message;
    throw new Error(`${url.pathname}: ${reason}`);
  }
}

export async function probe({
  profile = process.env.RADAR_HEALTH_PROFILE || "strict",
  baseUrl = process.env.RADAR_BASE_URL || DEFAULT_BASE_URL,
  minimumVersion = process.env.RADAR_MIN_VERSION || DEFAULT_MIN_VERSION,
  expectedPersistencePath = process.env.RADAR_EXPECTED_PERSISTENCE_PATH || DEFAULT_EXPECTED_PERSISTENCE_PATH,
  attempts = Number(process.env.RADAR_HEALTH_ATTEMPTS || 3),
  timeoutMs = Number(process.env.RADAR_HEALTH_TIMEOUT_MS || 12000),
  retryDelayMs = Number(process.env.RADAR_HEALTH_RETRY_DELAY_MS || 8000),
  now = Date.now
} = {}) {
  if (!new Set(["strict", "information"]).has(profile)) throw new Error(`Invalid health profile: ${profile}`);
  for (const [name, value, min, max] of [["attempts", attempts, 1, 5], ["timeoutMs", timeoutMs, 1, 30000], ["retryDelayMs", retryDelayMs, 0, 60000]]) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}: expected integer ${min}..${max}`);
  }
  const base = new URL(baseUrl);
  if (!new Set(["http:", "https:"]).has(base.protocol) || base.username || base.password) throw new Error("Invalid health base URL");
  const statusUrl = new URL("/api/status", base);
  const oilUrl = new URL("/api/oil-monitor", base);
  const errors = [];
  let assessment = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const responses = await Promise.allSettled([
        fetchJson(statusUrl, timeoutMs),
        fetchJson(oilUrl, timeoutMs)
      ]);
      const failedRequests = responses.filter((result) => result.status === "rejected");
      if (failedRequests.length) throw new Error(failedRequests.map((result) => result.reason.message).join("; "));
      const [status, oil] = responses.map((result) => result.value);
      if (profile === "information") {
        assessment = assessInformationHealth(status, oil, { minimumVersion, expectedPersistencePath, nowMs: now() });
        if (!assessment.incidentRequired) return { ...assessment, checkedAt: new Date(now()).toISOString(), baseUrl: base.origin, version: status.version };
        errors.push(`attempt ${attempt}: ${[...assessment.operationalFailures, ...assessment.reviewRequired].join(",")}`);
        if (attempt < attempts) await wait(retryDelayMs);
        continue;
      }
      const failures = assessHealth(status, oil, { minimumVersion, expectedPersistencePath, nowMs: now() });
      if (!failures.length) {
        return {
          ok: true,
          checkedAt: new Date(now()).toISOString(),
          baseUrl: base.origin,
          version: status.version,
          oilSource: oil.source,
          oilDataMode: oil.dataMode
        };
      }
      errors.push(`attempt ${attempt}: ${failures.join(",")}`);
    } catch (error) {
      assessment = null;
      errors.push(`attempt ${attempt}: ${error.message}`);
    }
    if (attempt < attempts) await wait(retryDelayMs);
  }

  return {
    ...(assessment || {}),
    ok: false,
    profile,
    ...(profile === "information" ? { incidentRequired: true, ...(!assessment ? { state: "operational-failure", operationalOk: false, goalComplete: false,
      operationalFailures: [...errors], capabilityDegraded: [], reviewRequired: [] } : {}) } : {}),
    checkedAt: new Date(now()).toISOString(),
    baseUrl: base.origin,
    errors
  };
}

async function main() {
  const result = await probe();
  const prefix = result.profile === "information" ? `RADAR_INFORMATION_${String(result.state || "operational-failure").toUpperCase().replaceAll("-", "_")}`
    : result.ok ? "RADAR_HEALTH_OK" : "RADAR_HEALTH_FAILED";
  const output = `${prefix} ${JSON.stringify(result)}`;
  if (result.ok) console.log(output);
  else console.error(output);
  // In information mode a missing capability remains explicitly degraded, but
  // is not falsely called an endpoint outage. Operational/review failures fail.
  process.exitCode = result.profile === "information" ? (result.incidentRequired ? 1 : 0) : (result.ok ? 0 : 1);
}

const executedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (executedDirectly) await main();
