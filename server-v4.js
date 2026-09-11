// 777 Signal Radar Pro v4.8.1 - focused commodity runtime with duplicate-signal suppression
const http = require("http");
const fs = require("fs");
const path = require("path");
const createMarketEngine = require("./market-engine-v4");
const createCatalystEngine = require("./catalyst-v4");
const createEiaEngine = require("./eia-v4");
const createSignalJournal = require("./signal-journal-v4");

const PORT = Number(process.env.PORT || 3000);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ALLOWED_QUOTES = new Set(["GLD", "SLV", "USO", "UNG", "COPX", "DBA", "SPY", "QQQ", "TLT", "UUP"]);
const MARKET_REPEAT_SUPPRESS_MS = 8 * 60 * 60 * 1000;
const MARKET_ESCALATION_MOVE_PCT = 2;
const marketDispatchHistory = new Map();
const marketDispatchDecision = new Map();
let lastMarketDispatchSent = true;
let lastAlertAt = null;
let journal = null;
let market = null;

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(data));
}

function telegramConfigured() {
  return Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
}

async function sendTelegramMessage(text) {
  if (!telegramConfigured()) throw new Error("Telegram not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
      signal: controller.signal
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.description || `Telegram HTTP ${response.status}`);
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

function parseMarketAlert(text) {
  const raw = String(text || "");
  if (!raw.startsWith("777 EXTREMES ROHSTOFF-SIGNAL") && !raw.startsWith("777 KORRELIERTES ROHSTOFF-SIGNAL")) return null;
  const signal = raw.match(/\r?\n+(LONG|SHORT)\s+.+?\s+\(([A-Z.]+)\)/);
  if (!signal) return null;
  const score = raw.match(/Score:\s*(\d+)\/100/);
  const confirmations = raw.match(/Bestätigungen:\s*(\d+)\/(\d+)/);
  const dayMove = raw.match(/Tagesbewegung:\s*([+-]?\d+(?:\.\d+)?)%/);
  const labels = [...raw.matchAll(/^•\s*(.+)$/gm)].map((m) => m[1].trim());
  const types = labels.map((label) => {
    if (label === "Rohstoffbewegung") return "price";
    if (/^(CALL|PUT)\b/.test(label)) return "options";
    if (/^(UUP|TLT)\b/.test(label)) return "context";
    return "catalyst";
  });
  return {
    direction: signal[1],
    symbol: signal[2],
    score: Number(score?.[1] || 0),
    confirmations: Number(confirmations?.[1] || 1),
    dayMove: Number(dayMove?.[1] || 0),
    types: [...new Set(types)]
  };
}

function marketSignalKey(meta) {
  return `${meta.symbol}:${meta.direction}`;
}

function priorMarketDispatch(meta) {
  const key = marketSignalKey(meta);
  const memory = marketDispatchHistory.get(key) || null;
  const durableEntry = journal?.recentAlertFor(meta.symbol, meta.direction, MARKET_REPEAT_SUPPRESS_MS) || null;
  const durable = durableEntry ? {
    sentAt: new Date(durableEntry.createdAt).getTime(),
    score: Number(durableEntry.score || 0),
    confirmations: Number(durableEntry.correlationCount || 1),
    dayMove: Number(durableEntry.percentChangeAtAlert || 0),
    types: Array.isArray(durableEntry.confirmationTypes) ? durableEntry.confirmationTypes : []
  } : null;
  if (!memory) return durable;
  if (!durable) return memory;
  return memory.sentAt >= durable.sentAt ? memory : durable;
}

function shouldDispatchMarketAlert(meta) {
  const prior = priorMarketDispatch(meta);
  if (!prior) return true;
  if (meta.confirmations > Number(prior.confirmations || 1)) return true;
  if (meta.score >= Number(prior.score || 0) + 15) return true;
  if (Math.abs(meta.dayMove) >= Math.abs(Number(prior.dayMove || 0)) + MARKET_ESCALATION_MOVE_PCT) return true;
  const priorTypes = new Set(Array.isArray(prior.types) ? prior.types : []);
  if (meta.types.some((type) => !priorTypes.has(type))) return true;
  return Date.now() - Number(prior.sentAt || 0) >= MARKET_REPEAT_SUPPRESS_MS;
}

async function sendMarketTelegramMessage(text) {
  const meta = parseMarketAlert(text);
  if (!meta) {
    lastMarketDispatchSent = true;
    return sendTelegramMessage(text);
  }
  const key = marketSignalKey(meta);
  const sent = shouldDispatchMarketAlert(meta);
  marketDispatchDecision.set(key, { sent, at: Date.now() });
  lastMarketDispatchSent = sent;
  if (!sent) {
    console.log(`777 duplicate market alert suppressed: ${key}`);
    return { suppressed: true };
  }
  const result = await sendTelegramMessage(text);
  marketDispatchHistory.set(key, { ...meta, sentAt: Date.now() });
  return result;
}

function recordAlert(iso) {
  lastAlertAt = iso || new Date().toISOString();
}

function recordMarketAlert(iso) {
  if (lastMarketDispatchSent) recordAlert(iso);
}

function recordMarketSignal(entry) {
  const signal = entry?.signal;
  if (!signal?.symbol || !signal?.direction) return journal?.record(entry);
  const key = `${signal.symbol}:${signal.direction}`;
  const decision = marketDispatchDecision.get(key);
  if (decision && Date.now() - decision.at <= 5000 && !decision.sent) {
    console.log(`777 duplicate journal signal suppressed: ${key}`);
    return null;
  }
  return journal?.record(entry);
}

function queueMarketRecheck(items, source) {
  if (!market || !items?.length) return;
  const timer = setTimeout(() => market.runCore(), 0);
  if (typeof timer.unref === "function") timer.unref();
  console.log(`777 event-driven market check queued: ${items.length} fresh ${source} catalyst(s); market-window gate retained`);
}

const catalysts = createCatalystEngine({
  sendMessage: sendTelegramMessage,
  telegramConfigured,
  onAlert: recordAlert,
  onFreshRelevant: (items) => queueMarketRecheck(items, "policy")
});

const eia = createEiaEngine({
  sendMessage: sendTelegramMessage,
  telegramConfigured,
  onAlert: recordAlert,
  onFreshRelevant: (items) => queueMarketRecheck(items, "EIA")
});

function combinedCatalystState() {
  const policy = catalysts.getState();
  const energy = eia.getState();
  const items = [...(policy.items || []), ...(energy.items || [])]
    .sort((a, b) => new Date(b.detectedAt || b.publishedAt || 0).getTime() - new Date(a.detectedAt || a.publishedAt || 0).getTime())
    .slice(0, 40);
  const scanTimes = [policy.lastScanAt, energy.lastScanAt]
    .filter(Boolean)
    .map((x) => new Date(x).getTime())
    .filter(Number.isFinite);
  return {
    items,
    lastScanAt: scanTimes.length ? new Date(Math.max(...scanTimes)).toISOString() : null,
    sources: { ...(policy.sources || {}), ...(energy.sources || {}) },
    focus: "commodity-relevant policy and official US energy releases",
    persistence: {
      policy: policy.persistence,
      eia: energy.persistence
    },
    pollingMinutes: {
      ...(policy.pollingMinutes || {}),
      eiaOfficial: energy.pollingMinutes
    }
  };
}

market = createMarketEngine({
  sendMessage: sendMarketTelegramMessage,
  telegramConfigured,
  onAlert: recordMarketAlert,
  getCatalystState: combinedCatalystState,
  recentSignalAlert: (symbol, direction, maxAgeMs) => journal?.recentAlertFor(symbol, direction, maxAgeMs) || null,
  onSignalAlert: recordMarketSignal,
  onCoreScan: (signals) => journal?.observe(signals)
});

journal = createSignalJournal({ quote: market.quote });
const latestRecordedSignal = journal.getState().entries?.[0];
if (latestRecordedSignal?.createdAt) lastAlertAt = latestRecordedSignal.createdAt;

function statusPayload() {
  const marketState = market.getState();
  const catalystState = combinedCatalystState();
  const policyState = catalysts.getState();
  const eiaState = eia.getState();
  const journalState = journal.getState();
  return {
    system: "777",
    version: "4.8.1",
    status: "online",
    focus: "commodity-first",
    publicApiMode: "read-only",
    strategy: [
      "commodity-price-anomalies",
      "correlation-gate-2-independent-confirmations",
      "extreme-commodity-override-for-gld-slv-uso-ung",
      "duplicate-signal-suppression-8h-with-material-escalation",
      "direction-consistent-catalyst-confirmation",
      "official-eia-energy-catalysts",
      "restricted-directional-cross-market-confirmation",
      "influential-public-statements",
      "official-policy-catalysts",
      "directional-options-confirmation",
      "persistent-30m-2h-outcome-journal",
      "event-driven-market-recheck-inside-market-window",
      "public-api-read-only-to-protect-data-budget"
    ],
    telegramConfigured: telegramConfigured(),
    marketDataConfigured: marketState.alpacaConfigured,
    marketDataSource: marketState.source,
    marketWindowOpen: marketState.marketWindowOpen,
    coreSymbols: marketState.coreSymbols,
    contextSymbols: marketState.contextSymbols,
    allowedQuoteSymbols: [...ALLOWED_QUOTES],
    coreIntervalMinutes: marketState.coreIntervalMinutes,
    contextIntervalMinutes: marketState.contextIntervalMinutes,
    correlationRequired: marketState.correlationRequired,
    catalystCorrelationMaxAgeMinutes: marketState.catalystCorrelationMaxAgeMinutes,
    contextConfirmationScope: marketState.contextConfirmationScope,
    extremeOverrideSymbols: marketState.extremeOverrideSymbols,
    extremeDayMultiplier: marketState.extremeDayMultiplier,
    extremeVelocityMultiplier: marketState.extremeVelocityMultiplier,
    marketRepeatSuppressHours: MARKET_REPEAT_SUPPRESS_MS / 3600000,
    optionsMode: marketState.optionsMode,
    eiaPollingMinutes: eiaState.pollingMinutes,
    lastCoreScanAt: marketState.lastCoreScanAt,
    lastContextScanAt: marketState.lastContextScanAt,
    lastCatalystScanAt: catalystState.lastScanAt,
    lastPolicyScanAt: policyState.lastScanAt,
    lastEiaScanAt: eiaState.lastScanAt,
    lastOptionsScanAt: marketState.lastOptionsScanAt,
    lastAlertAt,
    journalStats: journalState.stats,
    journalPersistence: journalState.persistence,
    catalystPersistence: policyState.persistence,
    eiaPersistence: eiaState.persistence,
    calibration: journalState.calibration,
    sourceStatus: catalystState.sources,
    time: new Date().toISOString()
  };
}

function serveDashboard(res) {
  const filePath = path.join(__dirname, "public", "dashboard-v4.html");
  fs.readFile(filePath, (error, data) => {
    if (error) {
      console.error("777 dashboard read error:", error.message);
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Server error");
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (requestUrl.pathname === "/api/status") return sendJson(res, 200, statusPayload());

    if (requestUrl.pathname === "/api/scan" || requestUrl.pathname === "/api/core") {
      const state = market.getState();
      return sendJson(res, 200, {
        system: "777",
        scanner: "commodity-core",
        source: state.source,
        correlationRequired: state.correlationRequired,
        signals: state.core,
        correlations: state.correlations,
        lastScanAt: state.lastCoreScanAt,
        time: new Date().toISOString()
      });
    }

    if (requestUrl.pathname === "/api/context") {
      const state = market.getState();
      return sendJson(res, 200, {
        system: "777",
        scanner: "extreme-context",
        source: state.source,
        signals: state.context,
        lastScanAt: state.lastContextScanAt,
        time: new Date().toISOString()
      });
    }

    if (requestUrl.pathname === "/api/catalysts") return sendJson(res, 200, combinedCatalystState());
    if (requestUrl.pathname === "/api/eia") return sendJson(res, 200, eia.getState());
    if (requestUrl.pathname === "/api/journal") return sendJson(res, 200, journal.getState());

    if (requestUrl.pathname === "/api/options") {
      const cached = market.getState().options;
      return sendJson(res, 200, cached || { mode: "INDICATIVE / DELAYED", top: [], time: null });
    }

    if (requestUrl.pathname === "/api/quote") {
      const symbol = (requestUrl.searchParams.get("symbol") || "GLD").trim().toUpperCase();
      if (!ALLOWED_QUOTES.has(symbol)) {
        return sendJson(res, 400, { error: "Symbol outside focused radar scope", allowed: [...ALLOWED_QUOTES] });
      }
      try {
        return sendJson(res, 200, { system: "777", data: await market.quote(symbol), time: new Date().toISOString() });
      } catch (error) {
        return sendJson(res, 502, { error: "Quote request failed", message: error.message });
      }
    }

    if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") return serveDashboard(res);
    return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("777 request error:", error.message);
    return sendJson(res, 500, { error: "Server error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`777 v4.8.1 running on port ${PORT}`);
  console.log(`777 focus: commodity-first + directional correlation gate ${market.getState().correlationRequired} + extreme override + EIA; Telegram ${telegramConfigured() ? "configured" : "offline"}`);
  console.log(`777 market duplicate suppression: ${MARKET_REPEAT_SUPPRESS_MS / 3600000}h unless confirmation/score/move materially escalates`);
  console.log(`777 public API: read-only; persistence journal ${journal.getState().persistence}; catalysts ${catalysts.getState().persistence}; EIA ${eia.getState().persistence}`);
  market.start();
  catalysts.start();
  eia.start();
});