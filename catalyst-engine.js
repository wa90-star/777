const FED_URL = "https://www.federalreserve.gov/feeds/press_all.xml";
const WHITE_HOUSE_URL = "https://www.whitehouse.gov/presidential-actions/feed/";
const SEC_BASE = "https://www.sec.gov/cgi-bin/browse-edgar";

const SEC_SYMBOLS = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "META", "AMD", "AVGO"];
const OFFICIAL_POLL_MS = 2 * 60 * 1000;
const SEC_POLL_MS = 2 * 60 * 1000;
const MAX_CACHE_ITEMS = 60;
const SEEN_TTL_MS = 48 * 60 * 60 * 1000;

function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

function stripTags(value) {
  return decodeXml(String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
}

function tag(block, name) {
  const match = String(block || "").match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + name + ">", "i"));
  return match ? decodeXml(match[1]) : "";
}

function attribute(block, tagName, attributeName) {
  const re = new RegExp("<" + tagName + "\\b[^>]*\\b" + attributeName + "=[\\\"']([^\\\"']+)[\\\"'][^>]*>", "i");
  const match = String(block || "").match(re);
  return match ? decodeXml(match[1]) : "";
}

function rssItems(xml) {
  const blocks = String(xml || "").match(/<item\b[\s\S]*?<\/item>/gi) || [];
  return blocks.map((block) => ({
    title: stripTags(tag(block, "title")),
    url: stripTags(tag(block, "link")),
    datetime: stripTags(tag(block, "pubDate")) || stripTags(tag(block, "dc:date")),
    summary: stripTags(tag(block, "description"))
  })).filter((item) => item.title && item.url);
}

function atomEntries(xml) {
  const blocks = String(xml || "").match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  return blocks.map((block) => ({
    title: stripTags(tag(block, "title")),
    url: attribute(block, "link", "href"),
    datetime: stripTags(tag(block, "updated")) || stripTags(tag(block, "filing-date")),
    summary: stripTags(tag(block, "summary")),
    filingType: stripTags(tag(block, "filing-type"))
  })).filter((item) => item.title && item.url);
}

function scoreByKeywords(text, keywords, base, hitValue, cap = 100) {
  const lower = String(text || "").toLowerCase();
  let score = base;
  let hits = 0;
  for (const keyword of keywords) {
    if (lower.includes(keyword)) {
      score += hitValue;
      hits += 1;
    }
  }
  return { score: Math.min(score, cap), hits };
}

function classifyFed(item) {
  const important = [
    "fomc", "monetary policy", "federal funds", "interest rate", "discount rate",
    "balance sheet", "economic outlook", "emergency", "liquidity", "inflation"
  ];
  const result = scoreByKeywords(item.title + " " + item.summary, important, 35, 35);
  return {
    ...item,
    id: "fed:" + item.url,
    source: "Federal Reserve",
    category: "MACRO / FED",
    score: result.score,
    priority: result.score >= 70 ? "HIGH" : result.score >= 50 ? "MEDIUM" : "LOW"
  };
}

function classifyWhiteHouse(item) {
  const important = [
    "tariff", "duties", "import", "export", "trade", "sanction", "emergency",
    "defense production", "energy", "oil", "gas", "semiconductor", "chip",
    "artificial intelligence", "technology", "digital asset", "crypto", "steel",
    "aluminum", "vehicle", "automobile", "pharmaceutical", "drug", "competition"
  ];
  const result = scoreByKeywords(item.title + " " + item.summary, important, 30, 25);
  return {
    ...item,
    id: "whitehouse:" + item.url,
    source: "White House",
    category: "POLITICS / POLICY",
    score: result.score,
    priority: result.score >= 70 ? "HIGH" : result.score >= 50 ? "MEDIUM" : "LOW"
  };
}

function classifySec(item, symbol) {
  return {
    ...item,
    id: "sec:" + symbol + ":" + item.url,
    source: "SEC EDGAR",
    category: "CORPORATE / 8-K",
    symbol,
    score: 72,
    priority: "HIGH"
  };
}

async function fetchText(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error("HTTP " + response.status);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = function createCatalystEngine(options) {
  const sendMessage = options.sendMessage;
  const telegramConfigured = options.telegramConfigured;
  const marketWindowOpen = options.marketWindowOpen;
  const onAlert = typeof options.onAlert === "function" ? options.onAlert : () => {};

  const seen = new Map();
  const primedSources = new Set();
  const cache = new Map();
  const sourceStatus = {
    federalReserve: { ok: null, lastSuccessAt: null, lastError: null },
    whiteHouse: { ok: null, lastSuccessAt: null, lastError: null },
    secEdgar: { ok: null, lastSuccessAt: null, lastError: null }
  };

  let lastScanAt = null;
  let lastAlertAt = null;
  let secIndex = 0;
  let started = false;

  function cleanupSeen() {
    const now = Date.now();
    for (const [id, time] of seen.entries()) {
      if (now - time > SEEN_TTL_MS) seen.delete(id);
    }
  }

  function remember(items) {
    for (const item of items) {
      if (item.id) cache.set(item.id, item);
    }
    if (cache.size > MAX_CACHE_ITEMS * 2) {
      const sorted = getItems();
      cache.clear();
      sorted.slice(0, MAX_CACHE_ITEMS).forEach((item) => cache.set(item.id, item));
    }
  }

  function getItems() {
    return [...cache.values()]
      .sort((a, b) => {
        const at = a.datetime ? new Date(a.datetime).getTime() : 0;
        const bt = b.datetime ? new Date(b.datetime).getTime() : 0;
        return bt - at;
      })
      .slice(0, MAX_CACHE_ITEMS);
  }

  function alertText(item) {
    return [
      "777 CATALYST ALERT",
      "",
      item.category,
      item.symbol ? item.symbol : null,
      item.title,
      "Score: " + item.score + "/100",
      "Quelle: " + item.source,
      item.url || null
    ].filter(Boolean).join("\n");
  }

  async function processSource(sourceKey, items) {
    cleanupSeen();
    remember(items);
    const now = Date.now();

    if (!primedSources.has(sourceKey)) {
      items.forEach((item) => seen.set(item.id, now));
      primedSources.add(sourceKey);
      console.log("777 catalyst primed: " + sourceKey + " " + items.length + " items");
      return 0;
    }

    const fresh = items.filter((item) => item.id && !seen.has(item.id));
    items.forEach((item) => seen.set(item.id, now));

    const alerts = fresh
      .filter((item) => item.priority === "HIGH")
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    if (telegramConfigured()) {
      for (const item of alerts) {
        try {
          await sendMessage(alertText(item));
          lastAlertAt = new Date().toISOString();
          onAlert(lastAlertAt);
        } catch (error) {
          console.error("777 catalyst alert failed:", item.source, error.message);
        }
      }
    }

    return alerts.length;
  }

  async function pollFed() {
    try {
      const xml = await fetchText(FED_URL, {
        headers: { "User-Agent": "SignalRadarPro777/1.0" }
      });
      const items = rssItems(xml).map(classifyFed).slice(0, 25);
      const alerts = await processSource("fed", items);
      sourceStatus.federalReserve = { ok: true, lastSuccessAt: new Date().toISOString(), lastError: null };
      console.log("777 Fed scan: " + items.length + " items, " + alerts + " alerts");
    } catch (error) {
      sourceStatus.federalReserve = { ...sourceStatus.federalReserve, ok: false, lastError: error.message };
      console.error("777 Fed scan error:", error.message);
    }
  }

  async function pollWhiteHouse() {
    try {
      const xml = await fetchText(WHITE_HOUSE_URL, {
        headers: { "User-Agent": "SignalRadarPro777/1.0" }
      });
      const items = rssItems(xml).map(classifyWhiteHouse).slice(0, 25);
      const alerts = await processSource("whitehouse", items);
      sourceStatus.whiteHouse = { ok: true, lastSuccessAt: new Date().toISOString(), lastError: null };
      console.log("777 White House scan: " + items.length + " items, " + alerts + " alerts");
    } catch (error) {
      sourceStatus.whiteHouse = { ...sourceStatus.whiteHouse, ok: false, lastError: error.message };
      console.error("777 White House scan error:", error.message);
    }
  }

  async function pollOfficialSources() {
    await Promise.allSettled([pollFed(), pollWhiteHouse()]);
    lastScanAt = new Date().toISOString();
  }

  async function pollSec() {
    if (typeof marketWindowOpen === "function" && !marketWindowOpen()) return;

    const symbol = SEC_SYMBOLS[secIndex % SEC_SYMBOLS.length];
    secIndex += 1;
    const params = new URLSearchParams({
      action: "getcompany",
      CIK: symbol,
      type: "8-K",
      output: "atom",
      count: "10"
    });

    try {
      const xml = await fetchText(SEC_BASE + "?" + params.toString(), {
        headers: {
          "User-Agent": "SignalRadarPro777/1.0 (+https://chic-caring-production-d403.up.railway.app)",
          "Accept-Encoding": "gzip, deflate"
        }
      }, 30000);
      const items = atomEntries(xml).map((item) => classifySec(item, symbol)).slice(0, 10);
      const alerts = await processSource("sec:" + symbol, items);
      sourceStatus.secEdgar = { ok: true, lastSuccessAt: new Date().toISOString(), lastError: null, lastSymbol: symbol };
      console.log("777 SEC scan: " + symbol + " " + items.length + " filings, " + alerts + " alerts");
    } catch (error) {
      sourceStatus.secEdgar = { ...sourceStatus.secEdgar, ok: false, lastError: error.message, lastSymbol: symbol };
      console.error("777 SEC scan error:", symbol, error.message);
    }
  }

  function start() {
    if (started) return;
    started = true;
    setTimeout(pollOfficialSources, 12000);
    setInterval(pollOfficialSources, OFFICIAL_POLL_MS);
    setTimeout(pollSec, 45000);
    setInterval(pollSec, SEC_POLL_MS);
  }

  function getState() {
    return {
      system: "777",
      lastScanAt,
      lastAlertAt,
      sources: sourceStatus,
      monitoredSecSymbols: SEC_SYMBOLS,
      items: getItems(),
      time: new Date().toISOString()
    };
  }

  return { start, getState };
};
