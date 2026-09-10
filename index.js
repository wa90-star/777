const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const TWELVE_API_KEY = process.env.TWELVE;

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

  return response.json();
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

      if (data.status === "error" || data.code) {
        return sendJson(res, 502, {
          error: "Market data provider returned an error",
          details: data
        });
      }

      return sendJson(res, 200, {
        system: "777",
        symbol,
        data,
        time: new Date().toISOString()
      });
    } catch (error) {
      console.error("Market data error:", error);

      return sendJson(res, 502, {
        error: "Market data request failed"
      });
    }
  }

  if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") {
    const filePath = path.join(__dirname, "public", "index.html");

    fs.readFile(filePath, (error, data) => {
      if (error) {
        console.error("HTML error:", error);

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
