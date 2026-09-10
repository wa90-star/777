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
  'monitoring: [\n        "market-signals",\n        "telegram-alerts",\n        "us-market-timing"\n      ]'
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

fs.writeFileSync(runtimePath, source, "utf8");
console.log("777 runtime v2 prepared and verified");
require(runtimePath);
