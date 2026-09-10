// 777 Signal Radar Pro v4.3 - commodity-first directional correlation runtime
const http = require("http");
const fs = require("fs");
const path = require("path");
const createMarketEngine = require("./market-engine-v4");
const createCatalystEngine = require("./catalyst-v4");
const createSignalJournal = require("./signal-journal-v4");

const PORT = Number(process.env.PORT || 3000);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
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

function recordAlert(iso) {
  lastAlertAt = iso || new Date().toISOString();
}

const catalysts = createCatalystEngine({
  sendMessage: sendTelegramMessage,
  telegramConfigured,
  onAlert: recordAlert,
  onFreshRelevant: (items) => {
    if (!market || !items?.length) return;
    const timer = setTimeout(() => market.runCore(true), 0);
    if (typeof timer.unref === "function") timer.unref();
    console.log(`777 event-driven market check queued: ${items.length} fresh catalyst(s)`);
  }
});

market = createMarketEngine({
  sendMessage: sendTelegramMessage,
  telegramConfigured,
  onAlert: recordAlert,
  getCatalystState: () => catalysts.getState(),
  recentSignalAlert: (symbol, direction, maxAgeMs) => journal?.recentAlertFor(symbol, direction, maxAgeMs) || null,
  onSignalAlert: (entry) => journal?.record(entry),
  onCoreScan: (signals) => journal?.observe(signals)
});

journal = createSignalJournal({ quote: market.quote });

function statusPayload() {
  const marketState = market.getState();
  const catalystState = catalysts.getState();
  const journalState = journal.getState();
  return {
    system: "777",
    version: "4.3",
    status: "online",
    focus: "commodity-first",
    strategy: [
      "commodity-price-anomalies",
      "correlation-gate-2-independent-confirmations",
      "direction-consistent-catalyst-confirmation",
      "restricted-directional-cross-market-confirmation",
      "influential-public-statements",
      "official-policy-catalysts",
      "directional-options-confirmation",
      "persistent-30m-2h-outcome-journal",
      "event-driven-market-recheck-after-fresh-catalyst"
    ],
    telegramConfigured: telegramConfigured(),
    marketDataConfigured: marketState.alpacaConfigured,
    marketDataSource: marketState.source,
    marketWindowOpen: marketState.marketWindowOpen,
    coreSymbols: marketState.coreSymbols,
    contextSymbols: marketState.contextSymbols,
    coreIntervalMinutes: marketState.coreIntervalMinutes,
    contextIntervalMinutes: marketState.contextIntervalMinutes,
    correlationRequired: marketState.correlationRequired,
    catalystCorrelationMaxAgeMinutes: marketState.catalystCorrelationMaxAgeMinutes,
    contextConfirmationScope: marketState.contextConfirmationScope,
    optionsMode: marketState.optionsMode,
    lastCoreScanAt: marketState.lastCoreScanAt,
    lastContextScanAt: marketState.lastContextScanAt,
    lastCatalystScanAt: catalystState.lastScanAt,
    lastOptionsScanAt: marketState.lastOptionsScanAt,
    lastAlertAt,
    journalStats: journalState.stats,
    journalPersistence: journalState.persistence,
    catalystPersistence: catalystState.persistence,
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
      if (requestUrl.searchParams.get("refresh") === "1") await market.runCore(true);
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
      if (requestUrl.searchParams.get("refresh") === "1") await market.runContext(true);
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

    if (requestUrl.pathname === "/api/catalysts") return sendJson(res, 200, catalysts.getState());
    if (requestUrl.pathname === "/api/journal") return sendJson(res, 200, journal.getState());

    if (requestUrl.pathname === "/api/options") {
      const cached = market.getState().options;
      const requested = requestUrl.searchParams.get("symbol");
      const refresh = requestUrl.searchParams.get("refresh") === "1";
      if (!requested || !refresh) {
        return sendJson(res, 200, cached || { mode: "INDICATIVE / DELAYED", top: [], time: null });
      }
      const symbol = requested.trim().toUpperCase();
      if (!["GLD", "SLV", "USO"].includes(symbol)) {
        return sendJson(res, 400, { error: "Options confirmation is limited to GLD, SLV and USO" });
      }
      const result = await market.optionConfirmation(symbol);
      return sendJson(res, 200, result || { symbol, mode: "INDICATIVE / DELAYED", top: [], time: new Date().toISOString() });
    }

    if (requestUrl.pathname === "/api/quote") {
      const symbol = (requestUrl.searchParams.get("symbol") || "GLD").trim().toUpperCase();
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
  console.log(`777 v4.3 running on port ${PORT}`);
  console.log(`777 focus: commodity-first + directional correlation gate ${market.getState().correlationRequired}; Telegram ${telegramConfigured() ? "configured" : "offline"}`);
  console.log(`777 persistence: journal ${journal.getState().persistence}; catalysts ${catalysts.getState().persistence}`);
  market.start();
  catalysts.start();
});
