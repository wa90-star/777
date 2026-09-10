const fs = require("fs");
const path = require("path");

const KEYWORDS = [
  "oil", "crude", "petroleum", "natural gas", "lng", "pipeline",
  "gold", "silver", "copper", "uranium", "steel", "aluminum", "aluminium",
  "rare earth", "mining", "minerals", "commodity", "commodities",
  "opec", "refinery", "drilling", "agriculture", "grain", "wheat",
  "corn", "soybean", "soybeans", "tariff", "tariffs", "sanction", "sanctions",
  "russia", "iran", "china", "export ban", "export control", "trade restriction",
  "interest rate", "rate cut", "rate hike", "inflation", "monetary policy", "fomc",
  "balance sheet", "liquidity", "dollar", "treasury", "strategic petroleum reserve", "spr"
];

const URGENT = [
  "tariff", "sanction", "opec", "iran", "russia", "export ban", "pipeline",
  "strategic petroleum reserve", "rate cut", "rate hike", "emergency",
  "executive order", "restriction", "war", "attack", "strike"
];

const POLL = {
  trump: 2 * 60 * 1000,
  fed: 5 * 60 * 1000,
  whitehouse: 5 * 60 * 1000,
  federalRegister: 10 * 60 * 1000,
  pelosi: 15 * 60 * 1000
};

const DISPLAY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const SEEN_MAX_AGE_MS = 72 * 60 * 60 * 1000;

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  if (typeof timer.unref === "function") timer.unref();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeXml(value) {
  return stripHtml(String(value || "").replace(/<!\[CDATA\[|\]\]>/g, ""));
}

function xmlTag(block, tag) {
  const match = String(block).match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}

function rssItems(xml) {
  return [...String(xml).matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((m) => ({
    title: xmlTag(m[0], "title"),
    url: xmlTag(m[0], "link"),
    publishedAt: xmlTag(m[0], "pubDate") || null,
    description: xmlTag(m[0], "description")
  }));
}

function hasAny(text, phrases) {
  return phrases.some((phrase) => text.includes(phrase));
}

function inferDirectionalBiases(value) {
  const text = String(value || "").toLowerCase();
  const biases = {};

  const contestedFraming = hasAny(text, [
    "challenging ", "challenges ", "challenge to ", "opposes ", "opposing ",
    "lawsuit", "sues ", "court challenge", "seeks to block", "seek to block",
    "attempts to block", "attempt to block"
  ]);
  if (contestedFraming) return biases;

  function set(symbol, longCondition, shortCondition) {
    if (longCondition === shortCondition) return;
    biases[symbol] = longCondition ? "LONG" : "SHORT";
  }

  const rateLong = hasAny(text, [
    "rate cut", "cut interest rates", "lower interest rates", "lower rates",
    "monetary easing", "easing monetary policy", "dovish", "weak dollar", "dollar weakness"
  ]);
  const rateShort = hasAny(text, [
    "rate hike", "raise interest rates", "higher interest rates", "higher rates",
    "monetary tightening", "tightening monetary policy", "hawkish", "strong dollar", "dollar strength"
  ]);
  const geopolitical = hasAny(text, ["war", "attack", "military strike", "missile", "invasion"]);
  const goldMention = hasAny(text, ["gold", "precious metal"]);
  const silverMention = text.includes("silver");
  set("GLD", rateLong || (goldMention && geopolitical), rateShort);
  set("SLV", rateLong || (silverMention && geopolitical), rateShort);

  const energyMention = hasAny(text, ["oil", "crude", "petroleum", "opec", "refinery"]);
  const sanctionOpposition = hasAny(text, [
    "oppose sanctions", "opposes sanctions", "opposing sanctions", "against sanctions",
    "lift sanctions", "sanctions relief"
  ]);
  const sanctionsEnergy = text.includes("sanction") && hasAny(text, ["iran", "russia", "oil", "petroleum"]) && !sanctionOpposition;
  const oilLong = energyMention && (
    hasAny(text, [
      "production cut", "output cut", "cut production", "cut output", "supply disruption",
      "pipeline shutdown", "pipeline disruption", "oil export ban", "block oil exports",
      "stop iranian oil", "strategic petroleum reserve refill", "spr refill"
    ]) || sanctionsEnergy
  );
  const oilShort = energyMention && hasAny(text, [
    "production increase", "output increase", "increase production", "increase output",
    "supply increase", "strategic petroleum reserve release", "spr release",
    "sanctions relief", "drill baby drill", "increase drilling", "more drilling",
    "lower oil prices", "oil prices down"
  ]);
  set("USO", oilLong, oilShort);

  const gasMention = hasAny(text, ["natural gas", "lng", "pipeline"]);
  const gasLong = gasMention && hasAny(text, [
    "supply disruption", "pipeline shutdown", "pipeline disruption", "lng export increase",
    "increase lng exports", "export ban", "sanctions"
  ]);
  const gasShort = gasMention && hasAny(text, [
    "production increase", "supply increase", "pipeline restart", "lng export halt", "reduce lng exports"
  ]);
  set("UNG", gasLong, gasShort);

  const copperMention = hasAny(text, ["copper", "mining", "mine"]);
  const copperLong = copperMention && hasAny(text, [
    "china stimulus", "stimulus package", "infrastructure spending", "mine strike",
    "mine shutdown", "supply disruption", "copper export ban"
  ]);
  const copperShort = copperMention && hasAny(text, [
    "china slowdown", "manufacturing slowdown", "recession", "mine restart", "copper supply increase"
  ]);
  set("COPX", copperLong, copperShort);

  const agricultureMention = hasAny(text, ["agriculture", "grain", "wheat", "corn", "soybean", "soybeans"]);
  const agricultureLong = agricultureMention && hasAny(text, [
    "export ban", "drought", "crop failure", "poor harvest", "grain corridor closed", "supply disruption"
  ]);
  const agricultureShort = agricultureMention && hasAny(text, [
    "record harvest", "bumper crop", "export increase", "grain corridor reopened", "supply increase"
  ]);
  set("DBA", agricultureLong, agricultureShort);

  return biases;
}

function relevant(text) {
  const lower = String(text || "").toLowerCase();
  const hits = KEYWORDS.filter((word) => lower.includes(word));
  const urgentHits = URGENT.filter((word) => lower.includes(word));
  return { hits, urgentHits };
}

function isRecent(item) {
  if (!item.publishedAt) return true;
  const t = new Date(item.publishedAt).getTime();
  if (!Number.isFinite(t)) return true;
  return Date.now() - t <= DISPLAY_MAX_AGE_MS;
}

function classify(item, baseScore) {
  const combined = `${item.title || ""} ${item.text || ""}`;
  const check = relevant(combined);
  if (!check.hits.length) return null;
  const score = Math.min(
    100,
    baseScore + Math.min(check.hits.length * 7, 21) + Math.min(check.urgentHits.length * 7, 14)
  );
  return {
    ...item,
    score,
    priority: score >= 75 ? "HIGH" : score >= 60 ? "MEDIUM" : "LOW",
    keywordHits: check.hits.slice(0, 6),
    urgentKeywordHits: check.urgentHits.slice(0, 6),
    directionalBiases: inferDirectionalBiases(combined)
  };
}

function createCatalystEngine({ sendMessage, telegramConfigured, onAlert, onFreshRelevant }) {
  const seen = new Map();
  const primed = new Set();
  const preferredDir = process.env.RADAR_DATA_DIR || "/data";
  let storageFile = null;
  let persistenceMode = "memory-only";

  const state = {
    items: [],
    lastScanAt: null,
    sources: {
      trumpTruth: { ok: null, lastScanAt: null, error: null },
      federalReserve: { ok: null, lastScanAt: null, error: null },
      whiteHouse: { ok: null, lastScanAt: null, error: null },
      federalRegister: { ok: null, lastScanAt: null, error: null },
      pelosiOfficial: { ok: null, lastScanAt: null, error: null }
    }
  };

  function initStorage() {
    for (const dir of [preferredDir, path.join("/tmp", "777-radar")]) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, ".catalyst-write-test");
        fs.writeFileSync(probe, "ok");
        fs.unlinkSync(probe);
        storageFile = path.join(dir, "catalyst-state.json");
        persistenceMode = dir === preferredDir ? `persistent:${dir}` : `fallback:${dir}`;
        return;
      } catch (error) {
        console.error(`777 catalyst storage unavailable ${dir}:`, error.message);
      }
    }
  }

  function persistState() {
    if (!storageFile) return;
    try {
      const tmp = `${storageFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({
        version: 2,
        savedAt: new Date().toISOString(),
        seen: [...seen.entries()],
        primed: [...primed],
        items: state.items.slice(0, 30)
      }, null, 2));
      fs.renameSync(tmp, storageFile);
    } catch (error) {
      console.error("777 catalyst persist error:", error.message);
    }
  }

  function loadState() {
    if (!storageFile || !fs.existsSync(storageFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(storageFile, "utf8"));
      const cutoff = Date.now() - SEEN_MAX_AGE_MS;
      for (const pair of parsed.seen || []) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const ts = Number(pair[1]);
        if (Number.isFinite(ts) && ts >= cutoff) seen.set(pair[0], ts);
      }
      for (const key of parsed.primed || []) primed.add(key);
      state.items = (Array.isArray(parsed.items) ? parsed.items : [])
        .filter((x) => x?.detectedAt && Date.now() - new Date(x.detectedAt).getTime() <= SEEN_MAX_AGE_MS)
        .map((x) => ({
          ...x,
          directionalBiases: inferDirectionalBiases(`${x.title || ""} ${x.text || ""}`)
        }))
        .slice(0, 30);
      persistState();
      console.log(`777 catalyst state loaded: ${seen.size} seen, ${state.items.length} items, ${persistenceMode}`);
    } catch (error) {
      console.error("777 catalyst state load error:", error.message);
    }
  }

  function markSource(name, ok, error = null) {
    state.sources[name] = {
      ok,
      lastScanAt: new Date().toISOString(),
      error: error ? String(error).slice(0, 160) : null
    };
    state.lastScanAt = new Date().toISOString();
  }

  async function getText(url, timeout = 9000, headers = {}) {
    const t = timeoutSignal(timeout);
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "777-signal-radar/4.4 market-monitor",
          Accept: "*/*",
          ...headers
        },
        signal: t.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } finally {
      t.clear();
    }
  }

  async function getJson(url, timeout = 9000) {
    const text = await getText(url, timeout, { Accept: "application/json" });
    return JSON.parse(text);
  }

  function pruneSeen() {
    const cutoff = Date.now() - SEEN_MAX_AGE_MS;
    for (const [key, value] of seen.entries()) {
      if (value < cutoff) seen.delete(key);
    }
    state.items = state.items
      .filter((x) => x?.detectedAt && Date.now() - new Date(x.detectedAt).getTime() <= SEEN_MAX_AGE_MS)
      .slice(0, 30);
  }

  async function accept(sourceKey, rawItems, baseScore) {
    pruneSeen();
    const now = Date.now();
    const isBaseline = !primed.has(sourceKey);
    const detectedAt = new Date(now).toISOString();

    const normalized = rawItems
      .filter(isRecent)
      .map((item) => classify(item, baseScore))
      .filter(Boolean)
      .map((item) => ({ ...item, detectedAt, baseline: isBaseline }));

    if (isBaseline) {
      for (const item of rawItems) seen.set(item.id || item.url, now);
      primed.add(sourceKey);
      if (normalized.length) state.items = [...normalized, ...state.items].slice(0, 30);
      persistState();
      console.log(`777 catalyst source primed: ${sourceKey}, ${normalized.length} recent relevant`);
      return;
    }

    const fresh = normalized
      .filter((item) => !seen.has(item.id || item.url))
      .map((item) => ({ ...item, baseline: false }));

    for (const item of rawItems) seen.set(item.id || item.url, now);
    if (fresh.length) state.items = [...fresh, ...state.items].slice(0, 30);
    persistState();

    const alerts = fresh
      .filter((item) => item.priority === "HIGH")
      .filter((item) => Object.keys(item.directionalBiases || {}).length > 0 || (item.urgentKeywordHits || []).length > 0)
      .slice(0, 2);

    if (alerts.length) {
      try {
        onFreshRelevant?.(alerts);
      } catch (error) {
        console.error("777 catalyst trigger callback failed:", error.message);
      }
    }

    if (telegramConfigured()) {
      for (const item of alerts) {
        try {
          await sendMessage(formatAlert(item));
          onAlert?.(new Date().toISOString());
        } catch (error) {
          console.error("777 catalyst alert failed:", error.message);
        }
      }
    }
  }

  function formatAlert(item) {
    const title = String(item.title || item.text || "").slice(0, 700);
    const biases = Object.entries(item.directionalBiases || {}).map(([symbol, direction]) => `${symbol} ${direction}`);
    return [
      "777 KATALYSATOR",
      "",
      item.source,
      title,
      `Score: ${item.score}/100`,
      biases.length ? `Richtung: ${biases.join(", ")}` : "Richtung: noch offen",
      item.keywordHits?.length ? `Treffer: ${item.keywordHits.join(", ")}` : null,
      item.url || null
    ].filter(Boolean).join("\n");
  }

  async function scanTrump() {
    try {
      const data = await getJson("https://trump.fm/api/posts?limit=10&platform=truth&includeDeleted=false", 9000);
      const posts = Array.isArray(data?.data) ? data.data : [];
      const items = posts.map((p) => ({
        id: `trump:${p.id}`,
        source: "Donald Trump · Truth Social mirror",
        title: stripHtml(p.content),
        text: stripHtml(p.content),
        url: p.id ? `https://trump.fm/post/${p.id}` : "",
        publishedAt: p.createdAt || null
      })).filter((x) => x.title);
      await accept("trump", items, 70);
      markSource("trumpTruth", true);
    } catch (error) {
      markSource("trumpTruth", false, error.message);
      console.error("777 Trump source error:", error.message);
    }
  }

  async function scanFed() {
    try {
      const xml = await getText("https://www.federalreserve.gov/feeds/press_all.xml");
      const items = rssItems(xml).slice(0, 20).map((x) => ({
        id: `fed:${x.url || x.title}`,
        source: "Federal Reserve · official",
        title: x.title,
        text: x.description,
        url: x.url,
        publishedAt: x.publishedAt
      }));
      await accept("fed", items, 72);
      markSource("federalReserve", true);
    } catch (error) {
      markSource("federalReserve", false, error.message);
      console.error("777 Fed source error:", error.message);
    }
  }

  async function scanWhiteHouse() {
    try {
      const xml = await getText("https://www.whitehouse.gov/presidential-actions/feed/");
      const items = rssItems(xml).slice(0, 20).map((x) => ({
        id: `wh:${x.url || x.title}`,
        source: "White House · Presidential Actions",
        title: x.title,
        text: x.description,
        url: x.url,
        publishedAt: x.publishedAt
      }));
      await accept("whitehouse", items, 72);
      markSource("whiteHouse", true);
    } catch (error) {
      markSource("whiteHouse", false, error.message);
      console.error("777 White House source error:", error.message);
    }
  }

  async function scanFederalRegister() {
    try {
      const params = new URLSearchParams({ per_page: "20", order: "newest" });
      const data = await getJson(`https://www.federalregister.gov/api/v1/documents.json?${params}`);
      const items = (data.results || []).map((x) => ({
        id: `fr:${x.document_number || x.html_url}`,
        source: "Federal Register · official",
        title: x.title || "",
        text: x.abstract || "",
        url: x.html_url || "",
        publishedAt: x.publication_date || null
      }));
      await accept("federal-register", items, 64);
      markSource("federalRegister", true);
    } catch (error) {
      markSource("federalRegister", false, error.message);
      console.error("777 Federal Register source error:", error.message);
    }
  }

  function pelosiItems(html) {
    const matches = [...String(html).matchAll(/href="([^"]*\/news\/press-releases\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
    const unique = new Map();
    for (const m of matches) {
      const href = m[1].startsWith("http") ? m[1] : `https://pelosi.house.gov${m[1]}`;
      const title = stripHtml(m[2]);
      if (!title || title.length < 12) continue;
      unique.set(href, {
        id: `pelosi:${href}`,
        source: "Nancy Pelosi · official statement",
        title,
        text: title,
        url: href,
        publishedAt: null
      });
    }
    return [...unique.values()].slice(0, 20);
  }

  async function scanPelosi() {
    try {
      const html = await getText("https://pelosi.house.gov/news/press-releases", 10000);
      const items = pelosiItems(html);
      await accept("pelosi", items, 65);
      markSource("pelosiOfficial", true);
    } catch (error) {
      markSource("pelosiOfficial", false, error.message);
      console.error("777 Pelosi source error:", error.message);
    }
  }

  function startTimer(fn, initialDelay, interval) {
    const first = setTimeout(fn, initialDelay);
    const timer = setInterval(fn, interval);
    if (typeof first.unref === "function") first.unref();
    if (typeof timer.unref === "function") timer.unref();
  }

  function start() {
    startTimer(scanTrump, 12000, POLL.trump);
    startTimer(scanFed, 18000, POLL.fed);
    startTimer(scanWhiteHouse, 24000, POLL.whitehouse);
    startTimer(scanFederalRegister, 32000, POLL.federalRegister);
    startTimer(scanPelosi, 42000, POLL.pelosi);
  }

  initStorage();
  loadState();

  return {
    start,
    scanTrump,
    scanFed,
    scanWhiteHouse,
    scanFederalRegister,
    scanPelosi,
    getState: () => ({
      ...state,
      focus: "commodity-relevant influential statements and official policy",
      displayMaxAgeDays: DISPLAY_MAX_AGE_MS / 86400000,
      persistence: persistenceMode,
      pollingMinutes: {
        trumpTruth: POLL.trump / 60000,
        federalReserve: POLL.fed / 60000,
        whiteHouse: POLL.whitehouse / 60000,
        federalRegister: POLL.federalRegister / 60000,
        pelosiOfficial: POLL.pelosi / 60000
      }
    })
  };
}

module.exports = createCatalystEngine;
