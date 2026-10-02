const fs = require("fs");
const path = require("path");

const MAX_WATCHLIST = 8;
const DEFAULT_WATCHLIST = ["UUUU", "MU", "MP", "INTC"];
const DISPLAY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CLUSTER_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const THEMES = Object.freeze([
  {
    id: "memory",
    label: "Memory / DRAM",
    query: 'DRAM ("mass production" OR "capacity expansion" OR "production increase" OR DDR5 OR LPDDR5X OR HBM)',
    terms: ["dram", "ddr5", "lpddr", "hbm", "nand", "memory chip", "memory chips"],
    symbols: ["MU"]
  },
  {
    id: "critical-minerals",
    label: "Uranium / Rare Earths",
    query: '(uranium OR "rare earth" OR monazite) (production OR capacity OR offtake OR processing OR "export ban" OR "export restriction")',
    terms: ["uranium", "rare earth", "rare-earth", "monazite", "neodymium", "praseodymium"],
    symbols: ["UUUU", "MP"]
  },
  {
    id: "semiconductors",
    label: "Semiconductor capacity",
    query: '(semiconductor OR foundry OR chip) ("mass production" OR "capacity expansion" OR "new fab" OR qualification OR "technology platform")',
    terms: ["semiconductor", "foundry", "chip", "wafer", "fab"],
    symbols: ["INTC", "MU"]
  }
]);

const EVENT_PATTERNS = Object.freeze({
  supply_expansion: [
    "mass production", "entered mass production", "enters mass production", "capacity expansion",
    "expand capacity", "expands capacity", "production increase", "increase production",
    "ramp production", "ramping production", "output increase", "increase output", "new fab",
    "new plant", "new production line", "dies per wafer", "die per wafer"
  ],
  supply_constraint: [
    "supply shortage", "shortage", "production halt", "halt production", "shutdown",
    "mine closure", "plant closure", "output cut", "production cut", "supply disruption"
  ],
  export_restriction: [
    "export ban", "export restriction", "export restrictions", "export control", "export controls",
    "trade restriction", "trade restrictions", "sanction", "sanctions"
  ],
  technology_step: [
    "new generation", "next-generation", "technology platform", "new process", "process node",
    "higher density", "lower cost", "cost competitiveness", "yield improvement", "qualification",
    "qualified", "commercial production", "commercially available", "product launch", "launches"
  ],
  demand_expansion: [
    "offtake", "purchase agreement", "supply agreement", "long-term contract", "multi-year contract",
    "customer qualification", "customer qualified", "orders surged", "demand surged", "demand increase",
    "demand growth", "ai demand", "data center demand", "hyperscaler demand"
  ],
  competitive_entry: [
    "new supplier", "new entrant", "domestically produced", "domestic production", "homegrown",
    "alternative supplier", "additional source of supply", "compete with", "competitor to", "rivaling", "rival to"
  ]
});

const ENTITY_ALIASES = Object.freeze({
  cxmt: ["cxmt", "changxin memory", "changxin memory technologies"],
  micron: ["micron", "micron technology"],
  energy_fuels: ["energy fuels", "white mesa", "toliara", "uuuu"],
  mp_materials: ["mp materials", "mountain pass"],
  intel: ["intel", "intel foundry"]
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseWatchlist(value) {
  const raw = String(value === undefined ? (process.env.RADAR_EQUITY_WATCHLIST || "") : value).trim();
  const source = raw ? raw.split(",") : DEFAULT_WATCHLIST;
  const seen = new Set();
  const out = [];
  for (const symbol of source) {
    const clean = String(symbol || "").trim().toUpperCase();
    if (!/^[A-Z.]{1,10}$/.test(clean) || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= MAX_WATCHLIST) break;
  }
  return out;
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
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

function xmlTag(block, tag) {
  const match = String(block || "").match(new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + tag + ">", "i"));
  return match ? stripHtml(match[1]) : "";
}

function rssItems(xml) {
  return [...String(xml || "").matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((match) => ({
    title: xmlTag(match[0], "title"),
    url: xmlTag(match[0], "link"),
    publishedAt: xmlTag(match[0], "pubDate") || null,
    description: xmlTag(match[0], "description"),
    publisher: xmlTag(match[0], "source") || "unknown"
  })).filter((item) => item.title && item.url);
}

function hasAny(text, phrases) {
  return phrases.some((phrase) => text.includes(phrase));
}

function entitiesIn(text) {
  const lower = String(text || "").toLowerCase();
  return Object.entries(ENTITY_ALIASES)
    .filter((entry) => entry[1].some((alias) => lower.includes(alias)))
    .map((entry) => entry[0]);
}

function eventTypesIn(text) {
  const lower = String(text || "").toLowerCase();
  return Object.entries(EVENT_PATTERNS)
    .filter((entry) => hasAny(lower, entry[1]))
    .map((entry) => entry[0]);
}

function sourceGroup(publisher) {
  return String(publisher || "unknown")
    .toLowerCase()
    .replace(/\b(inc\.?|corp\.?|corporation|company|co\.?|ltd\.?|limited|news|media)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "unknown";
}

function inferDirectionalBiases({ text, themeId, eventTypes, entities, watchlist }) {
  const lower = String(text || "").toLowerCase();
  const types = new Set(eventTypes || []);
  const entitySet = new Set(entities || []);
  const allowed = new Set(watchlist || []);
  const biases = {};

  function set(symbol, direction, mechanism) {
    if (!allowed.has(symbol) || biases[symbol]) return;
    biases[symbol] = { direction, mechanism, hypothesisOnly: true };
  }

  if (themeId === "memory") {
    if (entitySet.has("cxmt") && (types.has("supply_expansion") || types.has("technology_step") || types.has("competitive_entry"))) {
      set("MU", "SHORT", "CXMT capacity/technology progress -> more DRAM competition/supply -> potential pricing pressure on incumbent memory vendors");
    }
    if (entitySet.has("micron") && (types.has("technology_step") || types.has("demand_expansion"))) {
      set("MU", "LONG", "Micron-specific technology/customer progress -> potential earnings or positioning improvement");
    }
    if (!entitySet.has("micron") && types.has("supply_constraint") && hasAny(lower, ["dram", "memory", "ddr5", "hbm"])) {
      set("MU", "LONG", "industry memory supply constraint -> potential pricing support");
    }
  }

  if (themeId === "critical-minerals") {
    if (entitySet.has("energy_fuels") && (types.has("supply_expansion") || types.has("technology_step") || types.has("demand_expansion"))) {
      set("UUUU", "LONG", "Energy Fuels project/production/offtake progress -> potential company-specific cash-flow or strategic value improvement");
    }
    if (entitySet.has("mp_materials") && (types.has("supply_expansion") || types.has("technology_step") || types.has("demand_expansion"))) {
      set("MP", "LONG", "MP Materials project/production/customer progress -> potential company-specific cash-flow or strategic value improvement");
    }
    if (types.has("export_restriction") && hasAny(lower, ["china", "chinese"]) && hasAny(lower, ["rare earth", "rare-earth", "monazite", "neodymium", "praseodymium"])) {
      set("MP", "LONG", "Chinese rare-earth export restriction -> potential strategic premium for ex-China supply");
      set("UUUU", "LONG", "Chinese rare-earth export restriction -> potential strategic premium for ex-China processing or supply");
    }
  }

  if (themeId === "semiconductors" && entitySet.has("intel") &&
      (types.has("technology_step") || types.has("demand_expansion") || types.has("supply_expansion"))) {
    set("INTC", "LONG", "Intel-specific process/fab/customer milestone -> potential foundry or product execution improvement");
  }

  return biases;
}

function structuralScore({ text, eventTypes, entities, publisher }) {
  let score = 42;
  score += Math.min((eventTypes || []).length * 10, 30);
  if ((entities || []).length) score += 8;
  if (/\b\d+(?:\.\d+)?\s*(?:%|gb|tb|mt|kt|tonnes?|tons?|wafers?|dies?|mw|gw)\b/i.test(text)) score += 8;
  if (/\b(mass production|commercial production|capacity expansion|offtake|export ban|export restriction)\b/i.test(text)) score += 7;
  if (sourceGroup(publisher) !== "unknown") score += 3;
  return Math.min(100, score);
}

function classifyStructuralItem(raw, theme, watchlist) {
  const list = watchlist || parseWatchlist();
  const text = String((raw.title || "") + " " + (raw.description || raw.text || "")).trim();
  const lower = text.toLowerCase();
  if (!theme || !theme.terms.some((term) => lower.includes(term))) return null;
  const eventTypes = eventTypesIn(text);
  if (!eventTypes.length) return null;
  const entities = entitiesIn(text);
  const score = structuralScore({ text, eventTypes, entities, publisher: raw.publisher });
  const hypotheses = inferDirectionalBiases({ text, themeId: theme.id, eventTypes, entities, watchlist: list });
  const directionalBiases = Object.fromEntries(Object.entries(hypotheses).map((entry) => [entry[0], entry[1].direction]));

  return {
    id: raw.id || (theme.id + ":" + (raw.url || raw.title)),
    source: "Structural discovery · " + (raw.publisher || "unknown"),
    publisher: raw.publisher || "unknown",
    sourceGroup: sourceGroup(raw.publisher),
    sourceClass: "secondary-discovery",
    title: raw.title || "",
    text: raw.description || raw.text || "",
    url: raw.url || "",
    publishedAt: raw.publishedAt || null,
    theme: theme.id,
    themeLabel: theme.label,
    eventTypes,
    entities,
    score,
    priority: score >= 78 ? "HIGH" : score >= 64 ? "MEDIUM" : "LOW",
    impactedSymbols: [...new Set(theme.symbols.filter((symbol) => list.includes(symbol)))],
    directionalBiases,
    directionalHypotheses: hypotheses,
    keywordHits: [...new Set([...theme.terms.filter((term) => lower.includes(term)), ...eventTypes])].slice(0, 8),
    structural: true,
    hypothesisOnly: true,
    requiresIndependentConfirmation: true,
    directTelegramAlerts: false
  };
}

function clusterKey(item) {
  const entity = (item.entities || [])[0] || "sector";
  const types = new Set(item.eventTypes || []);
  let mechanism = "structural";
  if (item.theme === "memory" && entity === "cxmt" &&
      (types.has("supply_expansion") || types.has("technology_step") || types.has("competitive_entry"))) {
    mechanism = "capacity-competition";
  } else if (types.has("export_restriction")) mechanism = "export-restriction";
  else if (types.has("supply_constraint")) mechanism = "supply-constraint";
  else if (types.has("supply_expansion")) mechanism = "supply-expansion";
  else if (types.has("demand_expansion")) mechanism = "demand-expansion";
  else if (types.has("technology_step")) mechanism = "technology-step";
  return item.theme + ":" + entity + ":" + mechanism;
}

function isRecent(value) {
  if (!value) return true;
  const time = new Date(value).getTime();
  return !Number.isFinite(time) || Date.now() - time <= DISPLAY_MAX_AGE_MS;
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  if (typeof timer.unref === "function") timer.unref();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function googleNewsUrl(query) {
  const params = new URLSearchParams({ q: query, hl: "en-US", gl: "US", ceid: "US:en" });
  return "https://news.google.com/rss/search?" + params.toString();
}

function createStructuralIntelligence({ onFreshRelevant } = {}) {
  const watchlist = parseWatchlist();
  const preferredDir = process.env.RADAR_DATA_DIR || "/data";
  const pollMinutes = clamp(Number(process.env.STRUCTURAL_SCAN_MINUTES || 15) || 15, 10, 60);
  const pollMs = pollMinutes * 60 * 1000;
  let storageFile = null;
  let persistenceMode = "memory-only";
  const seen = new Map();
  const primed = new Set();

  const state = {
    items: [],
    verified: [],
    clusters: {},
    sources: {},
    lastScanAt: null,
    watchlist
  };

  function initStorage() {
    for (const dir of [preferredDir, path.join("/tmp", "777-radar")]) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, ".structural-write-test");
        fs.writeFileSync(probe, "ok");
        fs.unlinkSync(probe);
        storageFile = path.join(dir, "structural-intelligence.json");
        persistenceMode = dir === preferredDir ? "persistent:" + dir : "fallback:" + dir;
        return;
      } catch (error) {
        console.error("777 structural storage unavailable " + dir + ":", error.message);
      }
    }
  }

  function prune() {
    const cutoff = Date.now() - CLUSTER_MAX_AGE_MS;
    for (const [key, time] of seen.entries()) if (Number(time) < cutoff) seen.delete(key);
    state.items = state.items.filter((item) => new Date(item.detectedAt || 0).getTime() >= cutoff).slice(0, 80);
    state.verified = state.verified.filter((item) => new Date(item.verifiedAt || 0).getTime() >= cutoff).slice(0, 30);
    for (const [key, cluster] of Object.entries(state.clusters)) {
      if (new Date(cluster.lastSeenAt || 0).getTime() < cutoff) delete state.clusters[key];
    }
  }

  function persist() {
    if (!storageFile) return false;
    try {
      const temporary = storageFile + ".tmp";
      fs.writeFileSync(temporary, JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        seen: [...seen.entries()],
        primed: [...primed],
        items: state.items.slice(0, 80),
        verified: state.verified.slice(0, 30),
        clusters: state.clusters
      }, null, 2));
      fs.renameSync(temporary, storageFile);
      return true;
    } catch (error) {
      console.error("777 structural persist error:", error.message);
      return false;
    }
  }

  function load() {
    if (!storageFile || !fs.existsSync(storageFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(storageFile, "utf8"));
      const cutoff = Date.now() - CLUSTER_MAX_AGE_MS;
      for (const pair of parsed.seen || []) {
        if (Array.isArray(pair) && pair.length === 2 && Number(pair[1]) >= cutoff) {
          seen.set(String(pair[0]), Number(pair[1]));
        }
      }
      for (const key of parsed.primed || []) primed.add(String(key));
      state.items = Array.isArray(parsed.items) ? parsed.items : [];
      state.verified = Array.isArray(parsed.verified) ? parsed.verified : [];
      state.clusters = parsed.clusters && typeof parsed.clusters === "object" ? parsed.clusters : {};
      prune();
      persist();
    } catch (error) {
      console.error("777 structural state load error:", error.message);
    }
  }

  function updateCluster(item, baseline) {
    const key = clusterKey(item);
    const nowIso = new Date().toISOString();
    const previous = state.clusters[key] || {
      key,
      theme: item.theme,
      entities: item.entities,
      eventTypes: item.eventTypes,
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
      publishers: [],
      evidence: [],
      bestScore: 0,
      promotedAt: null
    };
    const publishers = new Set(previous.publishers || []);
    if (item.sourceGroup && item.sourceGroup !== "unknown") publishers.add(item.sourceGroup);
    const evidence = Array.isArray(previous.evidence) ? previous.evidence : [];
    if (!evidence.some((entry) => entry.id === item.id)) {
      evidence.push({
        id: item.id,
        publisher: item.publisher,
        title: item.title,
        url: item.url,
        publishedAt: item.publishedAt,
        score: item.score
      });
    }
    const cluster = {
      ...previous,
      lastSeenAt: nowIso,
      publishers: [...publishers],
      evidence: evidence.slice(-8),
      bestScore: Math.max(Number(previous.bestScore || 0), Number(item.score || 0))
    };
    state.clusters[key] = cluster;

    const qualified = !baseline &&
      !cluster.promotedAt &&
      cluster.publishers.length >= 2 &&
      Object.keys(item.directionalBiases || {}).length > 0 &&
      cluster.bestScore >= 70;
    if (!qualified) return null;

    cluster.promotedAt = nowIso;
    const verified = {
      ...item,
      id: "verified:" + key + ":" + nowIso,
      source: "Structural verified · " + cluster.publishers.length + " independent publishers",
      sourceClass: "multi-source-secondary-confirmation",
      verifiedAt: nowIso,
      detectedAt: item.detectedAt || nowIso,
      independentSourceCount: cluster.publishers.length,
      sourcePublishers: [...cluster.publishers],
      verificationKey: key,
      requiresIndependentConfirmation: false,
      directTelegramAlerts: false,
      baseline: false
    };
    state.verified = [verified, ...state.verified].slice(0, 30);
    return verified;
  }

  async function acceptTheme(theme, rawItems) {
    prune();
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const baseline = !primed.has(theme.id);
    const normalized = rawItems
      .filter((item) => isRecent(item.publishedAt))
      .map((item) => classifyStructuralItem({ ...item, id: theme.id + ":" + (item.url || item.title) }, theme, watchlist))
      .filter(Boolean);

    const fresh = [];
    const verified = [];
    for (const item of normalized) {
      const key = item.id || item.url;
      const firstSeen = !seen.has(key);
      seen.set(key, now);
      if (!firstSeen) continue;
      const enriched = { ...item, detectedAt: nowIso, baseline };
      fresh.push(enriched);
      const promoted = updateCluster(enriched, baseline);
      if (promoted) verified.push(promoted);
    }

    if (fresh.length) state.items = [...fresh, ...state.items].slice(0, 80);
    if (baseline) primed.add(theme.id);
    persist();
    if (verified.length && onFreshRelevant) await onFreshRelevant(verified);
    return { fresh, verified, baseline };
  }

  async function getText(url, timeout = 10000) {
    const timing = timeoutSignal(timeout);
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "777-signal-radar/5.3 structural-intelligence",
          Accept: "application/rss+xml, application/xml, text/xml, */*"
        },
        signal: timing.signal
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      return await response.text();
    } finally {
      timing.clear();
    }
  }

  async function scanTheme(theme) {
    const sourceKey = "googleNews:" + theme.id;
    try {
      const xml = await getText(googleNewsUrl(theme.query));
      const items = rssItems(xml).slice(0, 30);
      const accepted = await acceptTheme(theme, items);
      state.sources[sourceKey] = {
        ok: true,
        lastScanAt: new Date().toISOString(),
        error: null,
        sourceClass: "secondary-discovery",
        directTelegramAlerts: false,
        requiresIndependentConfirmation: true,
        itemCount: items.length
      };
      state.lastScanAt = state.sources[sourceKey].lastScanAt;
      persist();
      return accepted;
    } catch (error) {
      state.sources[sourceKey] = {
        ok: false,
        lastScanAt: new Date().toISOString(),
        error: String(error.message || error).slice(0, 180),
        sourceClass: "secondary-discovery",
        directTelegramAlerts: false,
        requiresIndependentConfirmation: true
      };
      state.lastScanAt = state.sources[sourceKey].lastScanAt;
      persist();
      console.error("777 structural " + theme.id + " source error:", error.message);
      return { fresh: [], verified: [], baseline: !primed.has(theme.id) };
    }
  }

  async function scan() {
    const results = [];
    for (const theme of THEMES) results.push(await scanTheme(theme));
    return results;
  }

  function start() {
    const first = setTimeout(() => scan().catch((error) => console.error("777 structural initial scan failed:", error.message)), 55000);
    const timer = setInterval(() => scan().catch((error) => console.error("777 structural scan failed:", error.message)), pollMs);
    if (typeof first.unref === "function") first.unref();
    if (typeof timer.unref === "function") timer.unref();
  }

  initStorage();
  load();

  return {
    start,
    scan,
    scanTheme,
    acceptTheme,
    getState: () => ({
      ...state,
      focus: "structural supply/demand, capacity, technology, competitive-entry and export-restriction events",
      discoverySource: "Google News RSS discovery only; no direct alert effect",
      verificationRule: "2 independent publisher groups + directional hypothesis + score >= 70",
      directTelegramAlerts: false,
      maxWatchlistSymbols: MAX_WATCHLIST,
      watchlist,
      pollingMinutes: pollMs / 60000,
      persistence: persistenceMode
    })
  };
}

module.exports = createStructuralIntelligence;
module.exports._test = {
  THEMES,
  clusterKey,
  classifyStructuralItem,
  eventTypesIn,
  inferDirectionalBiases,
  parseWatchlist,
  rssItems,
  sourceGroup,
  structuralScore
};
