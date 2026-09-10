const fs = require("fs");
const path = require("path");

const sourcePath = path.join(__dirname, "index.js");
const runtimePath = path.join(__dirname, "runtime-index.js");
let source = fs.readFileSync(sourcePath, "utf8");

function replaceRequired(label, from, to) {
  if (!source.includes(from)) {
    throw new Error(`777 runtime patch failed: ${label}`);
  }
  source = source.replace(from, to);
}

replaceRequired(
  "watchlist",
  'const WATCHLIST = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN"];',
  'const WATCHLIST = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "TSLA"];'
);

replaceRequired(
  "scan interval",
  "const AUTO_SCAN_MS = 15 * 60 * 1000;",
  "const AUTO_SCAN_MS = 7 * 60 * 1000;"
);

replaceRequired(
  "movement score",
  "score += Math.min(Math.abs(percentChange) * 15, 60);",
  "score += Math.min(Math.abs(percentChange) * 25, 70);"
);

replaceRequired(
  "volume score",
  "score += Math.min(volumeRatio * 25, 40);",
  "score += Math.min(volumeRatio * 30, 30);"
);

replaceRequired(
  "long threshold",
  "if (percentChange >= 2) {",
  "if (percentChange >= 1.5) {"
);

replaceRequired(
  "short threshold",
  "if (percentChange <= -2) {",
  "if (percentChange <= -1.5) {"
);

replaceRequired(
  "dashboard",
  'path.join(\n      __dirname,\n      "public",\n      "index.html"\n    )',
  'path.join(\n      __dirname,\n      "public",\n      "dashboard-v2.html"\n    )'
);

replaceRequired(
  "monitoring labels",
  'monitoring: [\n        "market-signals",\n        "telegram-alerts",\n        "political-signals",\n        "corporate-events",\n        "global-market-timing"\n      ]',
  'monitoring: [\n        "market-signals",\n        "telegram-alerts",\n        "us-market-timing",\n        "macro-political-news",\n        "corporate-catalysts"\n      ]'
);

const cacheRoute = `  if (requestUrl.pathname === "/api/cache") {
    return sendJson(res, 200, scanCache
      ? { ...scanCache, cached: true }
      : {
          system: "777",
          scanner: "market-radar",
          watchlist: WATCHLIST,
          signals: [],
          errors: [],
          strongestSignal: null,
          cached: true,
          time: null
        }
    );
  }

`;

replaceRequired(
  "cache route",
  '  if (requestUrl.pathname === "/api/scan") {',
  cacheRoute + '  if (requestUrl.pathname === "/api/scan") {'
);

const windowFunction = `function automaticScanWindowOpen() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(new Date());

  const weekday = parts.find((p) => p.type === "weekday")?.value;
  if (weekday === "Sat" || weekday === "Sun") return false;

  const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);
  const minutes = hour * 60 + minute;

  return minutes >= 7 * 60 && minutes <= 20 * 60;
}

`;

replaceRequired(
  "market window",
  "async function runAutomaticRadar() {",
  windowFunction + "async function runAutomaticRadar() {\n  if (!automaticScanWindowOpen()) return;"
);

const newsModule = `const NEWS_SCAN_MS = 5 * 60 * 1000;
let newsCache = [];
let lastNewsScanAt = null;
let newsPrimed = false;
const newsSeen = new Map();

function classifyCatalystHeadline(title) {
  const text = String(title || "").toLowerCase();
  const macro = [
    "federal reserve", "jerome powell", "rate cut", "rate hike",
    "tariff", "sanction", "white house", "treasury", "executive order",
    "export ban", "trade restriction"
  ];
  const corporate = [
    "merger", "acquisition", "acquire", "buyout", "bankruptcy",
    "chapter 11", "guidance", "earnings", "buyback", "fda",
    "investigation", "antitrust", "ceo resign", "cfo resign"
  ];

  let score = 25;
  let category = "MARKET NEWS";
  let hits = 0;

  for (const word of macro) {
    if (text.includes(word)) {
      score += 45;
      category = "MACRO / POLITICS";
      hits += 1;
    }
  }

  for (const word of corporate) {
    if (text.includes(word)) {
      score += 45;
      category = "CORPORATE CATALYST";
      hits += 1;
    }
  }

  if (text.includes("unexpected") || text.includes("surprise") || text.includes("breaking")) {
    score += 10;
  }

  score = Math.min(score, 100);
  return {
    score,
    category,
    priority: score >= 70 ? "HIGH" : score >= 55 ? "MEDIUM" : "LOW",
    hits
  };
}

async function fetchCatalystNews() {
  const query = '("Federal Reserve" OR "Jerome Powell" OR "rate cut" OR "rate hike" OR tariff OR sanction OR "White House" OR "executive order" OR merger OR acquisition OR buyout OR bankruptcy OR guidance OR earnings OR buyback OR "FDA approval" OR antitrust)';
  const params = new URLSearchParams({
    query,
    mode: "artlist",
    maxrecords: "30",
    timespan: "15min",
    sort: "datedesc",
    format: "json"
  });

  const response = await fetch("https://api.gdeltproject.org/api/v2/doc/doc?" + params.toString());
  if (!response.ok) throw new Error("GDELT HTTP " + response.status);
  const data = await response.json();
  const articles = Array.isArray(data.articles) ? data.articles : [];

  return articles.map((article) => {
    const classified = classifyCatalystHeadline(article.title);
    return {
      title: article.title || "",
      url: article.url || "",
      domain: article.domain || "",
      sourceCountry: article.sourcecountry || "",
      seenDate: article.seendate || null,
      category: classified.category,
      score: classified.score,
      priority: classified.priority
    };
  }).filter((item) => item.title && item.url);
}

function formatCatalystAlert(item) {
  return [
    "777 CATALYST ALERT",
    "",
    item.category,
    item.title,
    "Score: " + item.score + "/100",
    item.domain ? "Quelle: " + item.domain : null,
    item.url
  ].filter(Boolean).join("\\n");
}

async function runNewsRadar() {
  try {
    const items = await fetchCatalystNews();
    newsCache = items;
    lastNewsScanAt = new Date().toISOString();

    const now = Date.now();
    for (const [url, seenAt] of newsSeen.entries()) {
      if (now - seenAt > 24 * 60 * 60 * 1000) newsSeen.delete(url);
    }

    if (!newsPrimed) {
      for (const item of items) newsSeen.set(item.url, now);
      newsPrimed = true;
      console.log("777 news radar primed: " + items.length + " articles");
      return;
    }

    const fresh = items.filter((item) => !newsSeen.has(item.url));
    for (const item of items) newsSeen.set(item.url, now);

    const alerts = fresh
      .filter((item) => item.priority === "HIGH")
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);

    if (telegramConfigured()) {
      for (const item of alerts) {
        try {
          await sendTelegramMessage(formatCatalystAlert(item));
          lastAlertAt = new Date().toISOString();
        } catch (error) {
          console.error("Catalyst alert failed:", error.message);
        }
      }
    }

    console.log("777 news scan complete: " + items.length + " articles, " + alerts.length + " alerts");
  } catch (error) {
    console.error("777 news radar error:", error.message);
  }
}

`;

replaceRequired(
  "news module",
  "async function runAutomaticRadar() {\n  if (!automaticScanWindowOpen()) return;",
  newsModule + "async function runAutomaticRadar() {\n  if (!automaticScanWindowOpen()) return;"
);

replaceRequired(
  "news status",
  "      lastAlertAt,\n      monitoring:",
  "      lastAlertAt,\n      lastNewsScanAt,\n      monitoring:"
);

const newsRoute = `  if (requestUrl.pathname === "/api/news") {
    return sendJson(res, 200, {
      system: "777",
      news: newsCache,
      lastNewsScanAt,
      time: new Date().toISOString()
    });
  }

`;

replaceRequired(
  "news route",
  '  if (requestUrl.pathname === "/api/quote") {',
  newsRoute + '  if (requestUrl.pathname === "/api/quote") {'
);

replaceRequired(
  "news schedule",
  "  setTimeout(runAutomaticRadar, 30 * 1000);\n  setInterval(runAutomaticRadar, AUTO_SCAN_MS);",
  "  setTimeout(runAutomaticRadar, 30 * 1000);\n  setInterval(runAutomaticRadar, AUTO_SCAN_MS);\n  setTimeout(runNewsRadar, 45 * 1000);\n  setInterval(runNewsRadar, NEWS_SCAN_MS);"
);

fs.writeFileSync(runtimePath, source, "utf8");
console.log("777 runtime v2 prepared and verified");
require(runtimePath);
