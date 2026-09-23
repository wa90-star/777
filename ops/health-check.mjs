import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://radar-v5-image-production.up.railway.app";
const DEFAULT_MIN_VERSION = "5.1.0";
const DEFAULT_EXPECTED_PERSISTENCE_PATH = "/data";

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

export function assessHealth(
  status,
  oil,
  {
    minimumVersion = DEFAULT_MIN_VERSION,
    expectedPersistencePath = DEFAULT_EXPECTED_PERSISTENCE_PATH
  } = {}
) {
  const failures = [];
  if (status?.system !== "777") failures.push("unexpected-system");
  if (status?.status !== "online") failures.push("service-not-online");
  if (!versionAtLeast(status?.version, minimumVersion)) failures.push(`version-below-${minimumVersion}`);
  if (status?.publicApiMode !== "read-only") failures.push("public-api-not-read-only");
  if (status?.telegramConfigured !== true) failures.push("telegram-not-configured");
  if (status?.oilDataConfigured !== true) failures.push("oil-data-not-configured");
  if (!isDurablePersistence(status?.journalPersistence, expectedPersistencePath)) {
    failures.push("journal-not-durable");
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
  for (const [name, source] of Object.entries(status?.sourceStatus || {})) {
    if (source?.error) failures.push(`source-error:${name}:${source.error}`);
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
