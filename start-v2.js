const fs = require("fs");
const path = require("path");

const sourcePath = path.join(__dirname, "index.js");
const runtimePath = path.join(__dirname, "runtime-index.js");
let source = fs.readFileSync(sourcePath, "utf8");

source = source.replace(
  'const WATCHLIST = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN"];',
  'const WATCHLIST = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "TSLA"];'
);

source = source.replace(
  "const AUTO_SCAN_MS = 15 * 60 * 1000;",
  "const AUTO_SCAN_MS = 7 * 60 * 1000;"
);

source = source.replace(
  "score += Math.min(Math.abs(percentChange) * 15, 60);",
  "score += Math.min(Math.abs(percentChange) * 25, 70);"
);

source = source.replace(
  "score += Math.min(volumeRatio * 25, 40);",
  "score += Math.min(volumeRatio * 30, 30);"
);

source = source.replace(
  "if (percentChange >= 2) {",
  "if (percentChange >= 1.5) {"
);

source = source.replace(
  "if (percentChange <= -2) {",
  "if (percentChange <= -1.5) {"
);

source = source.replace(
  'path.join(__dirname, "public", "index.html")',
  'path.join(__dirname, "public", "dashboard-v2.html")'
);

const windowFunction = `
function automaticScanWindowOpen() {
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

source = source.replace(
  "async function runAutomaticRadar() {",
  windowFunction + "async function runAutomaticRadar() {\n  if (!automaticScanWindowOpen()) return;"
);

fs.writeFileSync(runtimePath, source, "utf8");
console.log("777 runtime v2 prepared");
require(runtimePath);
