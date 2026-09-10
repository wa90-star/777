const fs = require("fs");
const path = require("path");

const POLL_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const SEEN_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const FEEDS = [
  "https://www.eia.gov/about/new/WNtest3.php",
  "https://www.eia.gov/rss/press_rss.xml"
];

const ENERGY_TERMS = [
  "oil", "crude", "petroleum", "gasoline", "diesel", "refinery", "refineries",
  "natural gas", "lng", "storage", "inventory", "inventories", "production",
  "strait of hormuz", "pipeline"
];

const RELEASE_TERMS = [
  "short-term energy outlook",
  "weekly petroleum status report",
  "weekly natural gas storage report",
  "petroleum status report",
  "natural gas storage report"
];

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  if (typeof timer.unref === "function") timer.unref();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function stripHtml(value) {
  return String(value || "")
    .replace(/&amp;lt;/gi, "<")
    .replace(/&amp;gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&#39;/g, "'")
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function xmlTag(block, tag) {
  const match = String(block).match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? stripHtml(match[1].replace(/<!\[CDATA\[|\]\]>/g, "")) : "";
}

function rssItems(xml) {
  return [...String(xml).matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((match) => ({
    title: xmlTag(match[0], "title"),
    url: xmlTag(match[0], "link"),
    publishedAt: xmlTag(match[0], "pubDate") || null,
    text: xmlTag(match[0], "description")
  }));
}

function safeTime(value) {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

function hasAny(text, phrases) {
  return phrases.some((phrase) => text.includes(phrase));
}

function inferDirection(value) {
  const text = String(value || "").toLowerCase();
  const biases = {};

  const oilContext = hasAny(text, ["oil", "crude", "petroleum", "gasoline", "refinery", "strait of hormuz"]);
  const oilSupplyUp = oilContext && hasAny(text, [
    "production forecast increase", "production forecast increases", "production forecast raised",
    "production will rise", "production rises", "production increased", "output will rise",
    "inventories increased", "inventories increase", "inventory increased", "inventory increase",
    "stocks increased", "stocks increase", "supply increased", "supply increase",
    "opening of the strait of hormuz", "increasing flows through the strait of hormuz"
  ]);
  const oilSupplyDown = oilContext && hasAny(text, [
    "production forecast decrease", "production forecast decreases", "production forecast lowered",
    "production will fall", "production falls", "production decreased", "output will fall",
    "inventories decreased", "inventories decrease", "inventory decreased", "inventory decrease",
    "stocks decreased", "stocks decrease", "supply disruption", "supply decreased", "supply decrease",
    "constraints to exporting oil", "strait of hormuz closed", "strait of hormuz closure"
  ]);
  if (oilSupplyUp !== oilSupplyDown) biases.USO = oilSupplyUp ? "SHORT" : "LONG";

  const gasContext = hasAny(text, ["natural gas", "lng", "gas storage"]);
  const gasSupplyUp = gasContext && hasAny(text, [
    "inventories will increase", "inventories increased", "inventories increase",
    "storage increased", "storage increase", "production increased", "production increase",
    "production will rise", "supply increased", "supply increase"
  ]);
  const gasSupplyDown = gasContext && hasAny(text, [
    "inventories will decrease", "inventories decreased", "inventories decrease",
    "storage decreased", "storage decrease", "production decreased", "production decrease",
    "production will fall", "supply disruption", "supply decreased", "supply decrease"
  ]);
  if (gasSupplyUp !== gasSupplyDown) biases.UNG = gasSupplyUp ? "SHORT" : "LONG";

  return biases;
}

function classify(raw) {
  const combined = `${raw.title || ""} ${raw.text || ""}`;
  const lower = combined.toLowerCase();
  const hits = ENERGY_TERMS.filter((term) => lower.includes(term));
  if (!hits.length) return null;
  const releaseHits = RELEASE_TERMS.filter((term) => lower.includes(term));
  const directionalBiases = inferDirection(combined);
  const score = Math.min(100, 72 + Math.min(hits.length * 5, 15) + (releaseHits.length ? 10 : 0) + (Object.keys(directionalBiases).length ? 5 : 0));
  return {
    ...raw,
    source: "U.S. EIA · official",
    score,
    priority: score >= 80 ? "HIGH" : score >= 65 ? "MEDIUM" : "LOW",
    keywordHits: hits.slice(0, 6),
    urgentKeywordHits: releaseHits.slice(0, 4),
    directionalBiases
  };
}

function createEiaEngine({ sendMessage, telegramConfigured, onAlert, onFreshRelevant }) {
  const seen = new Map();
  const preferredDir = process.env.RADAR_DATA_DIR || "/data";
  let storageFile = null;
  let persistenceMode = "memory-only";
  let primed = false;

  const state = {
    items: [],
    lastScanAt: null,
    sources: {
      eiaOfficial: { ok: null, lastScanAt: null, error: null }
    }
  };

  function initStorage() {
    for (const dir of [preferredDir, path.join("/tmp", "777-radar")]) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, ".eia-write-test");
        fs.writeFileSync(probe, "ok");
        fs.unlinkSync(probe);
        storageFile = path.join(dir, "eia-state.json");
        persistenceMode = dir === preferredDir ? `persistent:${dir}` : `fallback:${dir}`;
        return;
      } catch (error) {
        console.error(`777 EIA storage unavailable ${dir}:`, error.message);
      }
    }
  }

  function persist() {
    if (!storageFile) return;
    try {
      const tmp = `${storageFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        seen: [...seen.entries()],
        primed,
        items: state.items.slice(0, 30)
      }, null, 2));
      fs.renameSync(tmp, storageFile);
    } catch (error) {
      console.error("777 EIA persist error:", error.message);
    }
  }

  function load() {
    if (!storageFile || !fs.existsSync(storageFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(storageFile, "utf8"));
      const cutoff = Date.now() - SEEN_MAX_AGE_MS;
      for (const pair of parsed.seen || []) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const ts = Number(pair[1]);
        if (Number.isFinite(ts) && ts >= cutoff) seen.set(pair[0], ts);
      }
      primed = Boolean(parsed.primed);
      state.items = (Array.isArray(parsed.items) ? parsed.items : [])
        .filter((x) => x?.detectedAt && Date.now() - safeTime(x.detectedAt) <= SEEN_MAX_AGE_MS)
        .slice(0, 30);
      console.log(`777 EIA state loaded: ${seen.size} seen, ${state.items.length} items, ${persistenceMode}`);
    } catch (error) {
      console.error("777 EIA state load error:", error.message);
    }
  }

  async function getText(url, timeout = 10000) {
    const t = timeoutSignal(timeout);
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "777-signal-radar/4.6 energy-monitor",
          "Accept": "application/rss+xml, application/xml, text/xml, */*"
        },
        signal: t.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } finally {
      t.clear();
    }
  }

  function normalizeUrl(url) {
    if (!url) return "";
    if (/^https?:\/\//i.test(url)) return url.replace(/^http:/i, "https:");
    return `https://www.eia.gov${url.startsWith("/") ? "" : "/"}${url}`;
  }

  function recent(raw) {
    if (!raw.publishedAt) return true;
    const t = safeTime(raw.publishedAt);
    return !t || Date.now() - t <= MAX_AGE_MS;
  }

  async function scan() {
    const results = await Promise.allSettled(FEEDS.map((url) => getText(url)));
    const successful = results.filter((x) => x.status === "fulfilled");
    const now = Date.now();
    state.lastScanAt = new Date(now).toISOString();

    if (!successful.length) {
      const errors = results.map((x) => x.status === "rejected" ? x.reason?.message : null).filter(Boolean);
      state.sources.eiaOfficial = { ok: false, lastScanAt: state.lastScanAt, error: errors.join(" | ").slice(0, 160) };
      console.error("777 EIA source error:", state.sources.eiaOfficial.error);
      return;
    }

    state.sources.eiaOfficial = { ok: true, lastScanAt: state.lastScanAt, error: null };
    const merged = new Map();
    for (const result of successful) {
      for (const raw of rssItems(result.value)) {
        const url = normalizeUrl(raw.url);
        const id = `eia:${url || raw.title}`;
        if (!merged.has(id)) merged.set(id, { ...raw, id, url });
      }
    }

    const normalized = [...merged.values()]
      .filter(recent)
      .map(classify)
      .filter(Boolean);

    if (!primed) {
      for (const raw of merged.values()) seen.set(raw.id, now);
      primed = true;
      state.items = normalized.map((x) => ({ ...x, detectedAt: state.lastScanAt, baseline: true })).slice(0, 30);
      persist();
      console.log(`777 EIA baseline primed: ${state.items.length} relevant`);
      return;
    }

    const fresh = normalized
      .filter((item) => !seen.has(item.id))
      .map((item) => ({ ...item, detectedAt: state.lastScanAt, baseline: false }));
    for (const raw of merged.values()) seen.set(raw.id, now);

    const cutoff = now - SEEN_MAX_AGE_MS;
    for (const [key, ts] of seen.entries()) if (ts < cutoff) seen.delete(key);
    if (fresh.length) state.items = [...fresh, ...state.items].slice(0, 30);
    persist();

    const alerts = fresh.filter((item) => item.priority === "HIGH").slice(0, 2);
    if (alerts.length) {
      try { onFreshRelevant?.(alerts); } catch (error) { console.error("777 EIA callback failed:", error.message); }
    }

    if (telegramConfigured()) {
      for (const item of alerts) {
        try {
          const directions = Object.entries(item.directionalBiases || {}).map(([symbol, direction]) => `${symbol} ${direction}`);
          await sendMessage([
            "777 EIA-KATALYSATOR",
            "",
            item.title,
            `Score: ${item.score}/100`,
            directions.length ? `Richtung: ${directions.join(", ")}` : "Richtung: offen · Marktreaktion wird geprüft",
            item.url || null
          ].filter(Boolean).join("\n"));
          onAlert?.(new Date().toISOString());
        } catch (error) {
          console.error("777 EIA alert failed:", error.message);
        }
      }
    }
  }

  function start() {
    const first = setTimeout(scan, 28000);
    const timer = setInterval(scan, POLL_MS);
    if (typeof first.unref === "function") first.unref();
    if (typeof timer.unref === "function") timer.unref();
  }

  initStorage();
  load();

  return {
    start,
    scan,
    getState: () => ({
      ...state,
      focus: "official US energy releases",
      persistence: persistenceMode,
      pollingMinutes: POLL_MS / 60000
    })
  };
}

module.exports = createEiaEngine;
