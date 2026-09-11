const fs = require("fs");
const path = require("path");

const ECB_RSS_URL = "https://www.ecb.europa.eu/rss/press.html";
const ACTIVE_POLL_MS = 5 * 60 * 1000;
const IDLE_POLL_MS = 30 * 60 * 1000;
const SEEN_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const DISPLAY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

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
    publishedAt: xmlTag(m[0], "pubDate") || xmlTag(m[0], "dc:date") || null,
    description: xmlTag(m[0], "description")
  }));
}

function safeTime(value) {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

function isRecent(item) {
  if (!item.publishedAt) return true;
  const t = safeTime(item.publishedAt);
  return !t || Date.now() - t <= DISPLAY_MAX_AGE_MS;
}

function ecbRelevant(item) {
  const text = `${item.title || ""} ${item.description || ""}`.toLowerCase();
  const strong = [
    "monetary policy decision",
    "monetary policy statement",
    "key ecb interest rate",
    "ecb interest rate",
    "deposit facility",
    "main refinancing operations",
    "marginal lending facility",
    "staff projections",
    "eurosystem staff projections",
    "ecb staff projections"
  ].some((x) => text.includes(x));
  if (strong) return true;
  const policyContext = text.includes("governing council") || text.includes("monetary policy");
  const rateOrInflation = text.includes("interest rate") || text.includes("basis points") || text.includes("inflation outlook");
  return policyContext && rateOrInflation;
}

function classifyEcb(item) {
  const text = `${item.title || ""} ${item.description || ""}`.toLowerCase();
  let eventType = "MONETARY_POLICY";
  if (/raise|raised|increase|increased|lower|lowered|cut|reduc|basis points/.test(text) && text.includes("rate")) {
    eventType = "RATE_DECISION";
  } else if (text.includes("staff projections")) {
    eventType = "PROJECTIONS";
  }
  const keywordHits = [
    text.includes("monetary policy") ? "monetary policy" : null,
    text.includes("interest rate") || text.includes("key ecb interest rate") ? "interest rate" : null,
    text.includes("inflation") ? "inflation" : null,
    text.includes("staff projections") ? "staff projections" : null
  ].filter(Boolean);
  return {
    id: `ecb:${item.url || item.title}`,
    source: "European Central Bank · official",
    title: item.title,
    text: item.description,
    url: item.url,
    publishedAt: item.publishedAt,
    detectedAt: new Date().toISOString(),
    eventType,
    priority: "HIGH",
    score: eventType === "RATE_DECISION" ? 90 : 82,
    keywordHits,
    urgentKeywordHits: eventType === "RATE_DECISION" ? ["central-bank-rate-decision"] : [],
    directionalBiases: {},
    eventOnly: true,
    requiresMarketConfirmation: true,
    baseline: false
  };
}

function activeWindow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
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

function createEcbEngine({ onFreshRelevant }) {
  const seen = new Map();
  const preferredDir = process.env.RADAR_DATA_DIR || "/data";
  let storageFile = null;
  let persistenceMode = "memory-only";
  let primed = false;
  let timer = null;

  const state = {
    items: [],
    lastScanAt: null,
    source: { ok: null, lastScanAt: null, error: null },
    pollingMinutes: { active: ACTIVE_POLL_MS / 60000, idle: IDLE_POLL_MS / 60000 }
  };

  function initStorage() {
    for (const dir of [preferredDir, path.join("/tmp", "777-radar")]) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, ".ecb-write-test");
        fs.writeFileSync(probe, "ok");
        fs.unlinkSync(probe);
        storageFile = path.join(dir, "ecb-state.json");
        persistenceMode = dir === preferredDir ? `persistent:${dir}` : `fallback:${dir}`;
        return;
      } catch (error) {
        console.error(`777 ECB storage unavailable ${dir}:`, error.message);
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
        primed,
        seen: [...seen.entries()],
        items: state.items.slice(0, 30)
      }, null, 2));
      fs.renameSync(tmp, storageFile);
    } catch (error) {
      console.error("777 ECB persist error:", error.message);
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
      persist();
      console.log(`777 ECB state loaded: ${seen.size} seen, ${state.items.length} items, ${persistenceMode}`);
    } catch (error) {
      console.error("777 ECB state load error:", error.message);
    }
  }

  function prune() {
    const cutoff = Date.now() - SEEN_MAX_AGE_MS;
    for (const [key, ts] of seen.entries()) if (ts < cutoff) seen.delete(key);
    state.items = state.items
      .filter((x) => x?.detectedAt && Date.now() - safeTime(x.detectedAt) <= SEEN_MAX_AGE_MS)
      .slice(0, 30);
  }

  async function getText(url, timeout = 10000) {
    const t = timeoutSignal(timeout);
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "777-signal-radar/4.9 ECB-monitor",
          Accept: "application/rss+xml, application/xml, text/xml, */*"
        },
        signal: t.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } finally {
      t.clear();
    }
  }

  async function scan() {
    try {
      prune();
      const xml = await getText(ECB_RSS_URL);
      const raw = rssItems(xml).filter(isRecent).filter(ecbRelevant).slice(0, 30);
      const now = Date.now();

      if (!primed) {
        for (const item of raw) seen.set(`ecb:${item.url || item.title}`, now);
        state.items = raw.map((item) => ({ ...classifyEcb(item), baseline: true })).slice(0, 30);
        primed = true;
        persist();
        console.log(`777 ECB baseline primed: ${state.items.length} relevant items`);
      } else {
        const fresh = raw
          .filter((item) => !seen.has(`ecb:${item.url || item.title}`))
          .map(classifyEcb);
        for (const item of raw) seen.set(`ecb:${item.url || item.title}`, now);
        if (fresh.length) {
          state.items = [...fresh, ...state.items].slice(0, 30);
          persist();
          try {
            onFreshRelevant?.(fresh);
          } catch (error) {
            console.error("777 ECB trigger callback failed:", error.message);
          }
          console.log(`777 ECB material event detected: ${fresh.length}`);
        } else {
          persist();
        }
      }

      const at = new Date().toISOString();
      state.lastScanAt = at;
      state.source = { ok: true, lastScanAt: at, error: null };
      return state.items;
    } catch (error) {
      const at = new Date().toISOString();
      state.lastScanAt = at;
      state.source = { ok: false, lastScanAt: at, error: String(error.message).slice(0, 160) };
      console.error("777 ECB source error:", error.message);
      return state.items;
    }
  }

  function scheduleNext(delay = activeWindow() ? ACTIVE_POLL_MS : IDLE_POLL_MS) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      await scan();
      scheduleNext();
    }, delay);
    if (typeof timer.unref === "function") timer.unref();
  }

  function start() {
    scheduleNext(20000);
  }

  initStorage();
  load();

  return {
    start,
    scan,
    getState: () => ({
      ...state,
      sources: { europeanCentralBank: state.source },
      persistence: persistenceMode,
      rssUrl: ECB_RSS_URL,
      mode: "event-only; market confirmation required; no blind directional bias"
    })
  };
}

module.exports = createEcbEngine;
