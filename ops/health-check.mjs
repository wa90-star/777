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
  const match = String(value || "").match(/^(\d+)\.(\d+)\.(\d+)/);
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
  if (oil?.status !== "live") failures.push("oil-monitor-not-live");
  return failures;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "777-radar-health-watchdog" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`${url.pathname}: HTTP ${response.status}`);
  return response.json();
}

export async function probe({
  baseUrl = process.env.RADAR_BASE_URL || DEFAULT_BASE_URL,
  minimumVersion = process.env.RADAR_MIN_VERSION || DEFAULT_MIN_VERSION,
  expectedPersistencePath = process.env.RADAR_EXPECTED_PERSISTENCE_PATH || DEFAULT_EXPECTED_PERSISTENCE_PATH,
  attempts = Number(process.env.RADAR_HEALTH_ATTEMPTS || 3),
  timeoutMs = Number(process.env.RADAR_HEALTH_TIMEOUT_MS || 12000),
  retryDelayMs = Number(process.env.RADAR_HEALTH_RETRY_DELAY_MS || 8000)
} = {}) {
  const base = new URL(baseUrl);
  const statusUrl = new URL("/api/status", base);
  const oilUrl = new URL("/api/oil-monitor", base);
  const errors = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const [status, oil] = await Promise.all([
        fetchJson(statusUrl, timeoutMs),
        fetchJson(oilUrl, timeoutMs)
      ]);
      const failures = assessHealth(status, oil, { minimumVersion, expectedPersistencePath });
      if (!failures.length) {
        return {
          ok: true,
          checkedAt: new Date().toISOString(),
          baseUrl: base.origin,
          version: status.version,
          oilSource: oil.source,
          oilDataMode: oil.dataMode
        };
      }
      errors.push(`attempt ${attempt}: ${failures.join(",")}`);
    } catch (error) {
      errors.push(`attempt ${attempt}: ${error.message}`);
    }
    if (attempt < attempts) await wait(retryDelayMs);
  }

  return {
    ok: false,
    checkedAt: new Date().toISOString(),
    baseUrl: base.origin,
    errors
  };
}

async function main() {
  const result = await probe();
  const prefix = result.ok ? "RADAR_HEALTH_OK" : "RADAR_HEALTH_FAILED";
  const output = `${prefix} ${JSON.stringify(result)}`;
  if (result.ok) console.log(output);
  else console.error(output);
  process.exitCode = result.ok ? 0 : 1;
}

const executedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (executedDirectly) await main();
