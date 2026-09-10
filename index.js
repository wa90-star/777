const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const TWELVE_API_KEY = process.env.TWELVE;

const WATCHLIST = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN"];

let scanCache = null;
let scanCacheTime = 0;

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });

  res.end(JSON.stringify(data));
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
    priority
  };
}

async function runMarketScan() {
  const now = Date.now();

  if (scanCache && now - scanCacheTime < 60000) {
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
      monitoring: [
        "market-signals",
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

server.listen(PORT, "0.0.0.0", () => {
  console.log(`777 running on port ${PORT}`);
});
