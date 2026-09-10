const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const TWELVE_API_KEY = process.env.TWELVE;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const WATCHLIST = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN"];
const SCAN_CACHE_MS = 60 * 1000;
const AUTO_SCAN_MS = 15 * 60 * 1000;
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

let scanCache = null;
let scanCacheTime = 0;
let lastAutoScanAt = null;
let lastAlertAt = null;

const alertState = new Map();

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });

  res.end(JSON.stringify(data));
}

function telegramConfigured() {
  return Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
}

async function sendTelegramMessage(text) {
  if (!telegramConfigured()) {
    throw new Error("Telegram is not configured");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true
      })
    }
  );

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(
      data.description || `Telegram HTTP ${response.status}`
    );
  }

  return data.result;
}

async function getQuote(symbol) {
  const url =
    "https://api.twelvedata.com/quote" +
    "?symbol=" + encodeURIComponent(symbol) +
    "&apikey=" + encodeURIComponent(TWELVE_API_KEY);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Twelve Data HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.status === "error" || data.code) {
    throw new Error(data.message || "Twelve Data error");
  }

  return data;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function analyzeQuote(symbol, data) {
  const price = number(data.close);
  const previousClose = number(data.previous_close);
  const percentChange = number(data.percent_change);
  const volume = number(data.volume);
  const averageVolume = number(data.average_volume);

  const volumeRatio =
    averageVolume > 0
      ? volume / averageVolume
      : 0;

  let score = 0;

  score += Math.min(Math.abs(percentChange) * 15, 60);
  score += Math.min(volumeRatio * 25, 40);

  score = Math.round(Math.min(score, 100));

  let direction = "KEIN SIGNAL";

  if (percentChange >= 2) {
    direction = "LONG";
  }

  if (percentChange <= -2) {
    direction = "SHORT";
  }

  let priority = "LOW";

  if (score >= 70) {
    priority = "HIGH";
  } else if (score >= 45) {
    priority = "MEDIUM";
  }

  return {
    symbol,
    price,
    previousClose,
    percentChange,
    volume,
    averageVolume,
    volumeRatio: Number(volumeRatio.toFixed(2)),
    direction,
    score,
    priority,
    marketTime: data.datetime || null
  };
}

async function runMarketScan() {
  const now = Date.now();

  if (scanCache && now - scanCacheTime < SCAN_CACHE_MS) {
    return {
      ...scanCache,
      cached: true
    };
  }

  const signals = [];
  const errors = [];

  for (const symbol of WATCHLIST) {
    try {
      const data = await getQuote(symbol);
      signals.push(analyzeQuote(symbol, data));
    } catch (error) {
      errors.push({
        symbol,
        error: error.message
      });
    }
  }

  signals.sort((a, b) => b.score - a.score);

  const result = {
    system: "777",
    scanner: "market-radar",
    watchlist: WATCHLIST,
    signals,
    errors,
    strongestSignal: signals[0] || null,
    cached: false,
    time: new Date().toISOString()
  };

  scanCache = result;
  scanCacheTime = now;

  return result;
}

function formatSignalMessage(signal) {
  const change =
    signal.percentChange >= 0
      ? `+${signal.percentChange.toFixed(2)}%`
      : `${signal.percentChange.toFixed(2)}%`;

  return [
    "777 RADAR SIGNAL",
    "",
    `${signal.direction} ${signal.symbol}`,
    `Preis: ${signal.price}`,
    `Tagesbewegung: ${change}`,
    `Volumenfaktor: ${signal.volumeRatio.toFixed(2)}x`,
    `Score: ${signal.score}/100`,
    `Priorität: ${signal.priority}`,
    signal.marketTime ? `Marktzeit: ${signal.marketTime}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

function shouldAlert(signal) {
  if (signal.direction === "KEIN SIGNAL") {
    return false;
  }

  if (signal.priority !== "HIGH") {
    return false;
  }

  const key = `${signal.symbol}:${signal.direction}`;
  const previous = alertState.get(key);
  const now = Date.now();

  if (!previous) {
    return true;
  }

  if (
    previous.marketTime &&
    signal.marketTime &&
    previous.marketTime === signal.marketTime
  ) {
    return false;
  }

  return now - previous.sentAt >= ALERT_COOLDOWN_MS;
}

async function sendSignalAlerts(scanResult) {
  if (!telegramConfigured()) {
    return;
  }

  for (const signal of scanResult.signals) {
    if (!shouldAlert(signal)) {
      continue;
    }

    await sendTelegramMessage(formatSignalMessage(signal));

    const key = `${signal.symbol}:${signal.direction}`;

    alertState.set(key, {
      sentAt: Date.now(),
      marketTime: signal.marketTime
    });

    lastAlertAt = new Date().toISOString();
  }
}

async function runAutomaticRadar() {
  if (!TWELVE_API_KEY) {
    console.error("Automatic radar skipped: Twelve Data is not configured");
    return;
  }

  try {
    const result = await runMarketScan();
    lastAutoScanAt = new Date().toISOString();
    await sendSignalAlerts(result);

    console.log(
      `777 automatic scan complete: ${result.signals.length} signals, ${result.errors.length} errors`
    );
  } catch (error) {
    console.error("Automatic radar error:", error);
  }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  if (requestUrl.pathname === "/api/status") {
    return sendJson(res, 200, {
      system: "777",
      status: "online",
      marketDataConfigured: Boolean(TWELVE_API_KEY),
      telegramConfigured: telegramConfigured(),
      automaticScanner: true,
      autoScanMinutes: AUTO_SCAN_MS / 60000,
      alertCooldownMinutes: ALERT_COOLDOWN_MS / 60000,
      lastAutoScanAt,
      lastAlertAt,
      monitoring: [
        "market-signals",
        "telegram-alerts",
        "political-signals",
        "corporate-events",
        "global-market-timing"
      ],
      time: new Date().toISOString()
    });
  }

  if (requestUrl.pathname === "/api/quote") {
    if (!TWELVE_API_KEY) {
      return sendJson(res, 500, {
        error: "Market data API key is not configured"
      });
    }

    const symbol =
      (requestUrl.searchParams.get("symbol") || "AAPL")
        .trim()
        .toUpperCase();

    try {
      const data = await getQuote(symbol);

      return sendJson(res, 200, {
        system: "777",
        symbol,
        data,
        time: new Date().toISOString()
      });
    } catch (error) {
      return sendJson(res, 502, {
        error: "Market data request failed",
        message: error.message
      });
    }
  }

  if (requestUrl.pathname === "/api/scan") {
    if (!TWELVE_API_KEY) {
      return sendJson(res, 500, {
        error: "Market data API key is not configured"
      });
    }

    try {
      const result = await runMarketScan();
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, 502, {
        error: "Scanner failed",
        message: error.message
      });
    }
  }

  if (
    requestUrl.pathname === "/" ||
    requestUrl.pathname === "/index.html"
  ) {
    const filePath = path.join(
      __dirname,
      "public",
      "index.html"
    );

    fs.readFile(filePath, (error, data) => {
      if (error) {
        res.writeHead(500, {
          "Content-Type": "text/plain; charset=utf-8"
        });

        return res.end("Server error");
      }

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8"
      });

      res.end(data);
    });

    return;
  }

  sendJson(res, 404, {
    error: "Not found"
  });
});

server.listen(PORT, "0.0.0.0", async () => {
  console.log(`777 running on port ${PORT}`);

  if (telegramConfigured()) {
    try {
      await sendTelegramMessage(
        "777 ist online. Telegram-Alerts sind verbunden."
      );
      console.log("777 Telegram startup confirmation sent");
    } catch (error) {
      console.error("Telegram startup confirmation failed:", error);
    }
  }

  setTimeout(runAutomaticRadar, 30 * 1000);
  setInterval(runAutomaticRadar, AUTO_SCAN_MS);
});
