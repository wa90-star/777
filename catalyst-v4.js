const KEYWORDS = [
  "oil", "crude", "petroleum", "gas", "natural gas", "lng", "pipeline",
  "gold", "silver", "copper", "uranium", "steel", "aluminum", "aluminium",
  "rare earth", "mining", "minerals", "commodity", "commodities",
  "opec", "energy", "refinery", "drilling", "agriculture", "grain", "wheat",
  "corn", "soybean", "soybeans", "tariff", "tariffs", "sanction", "sanctions",
  "russia", "iran", "china", "export ban", "export control", "trade restriction",
  "interest rate", "rate cut", "rate hike", "inflation", "federal reserve",
  "dollar", "treasury", "strategic petroleum reserve", "spr"
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

function relevant(text) {
  const lower = String(text || "").toLowerCase();
  const hits = KEYWORDS.filter((word) => lower.includes(word));
  const urgentHits = URGENT.filter((word) => lower.includes(word));
  return { hits, urgentHits };
}

function classify(item, baseScore) {
  const check = relevant(`${item.title || ""} ${item.text || ""}`);
  if (!check.hits.length) return null;
  const score = Math.min(100, baseScore + Math.min(check.hits.length * 7, 21) + Math.min(check.urgentHits.length * 7, 14));
  return {
    ...item,
    score,
    priority: score >= 75 ? "HIGH" : score >= 60 ? "MEDIUM" : "LOW",
    keywordHits: check.hits.slice(0, 6)
  };
}

function createCatalystEngine({ sendMessage, telegramConfigured, onAlert }) {
  const seen = new Map();
  let trumpLatestId = null;
  const primed = new Set();
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
          "User-Agent": "777-signal-radar/4 market-monitor",
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
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    for (const [key, value] of seen.entries()) {
      if (value < cutoff) seen.delete(key);
    }
  }

  async function accept(sourceKey, rawItems, baseScore) {
    pruneSeen();
    const now = Date.now();
    const normalized = rawItems
      .map((item) => classify(item, baseScore))
      .filter(Boolean);

    if (!primed.has(sourceKey)) {
      for (const item of rawItems) seen.set(item.id || item.url, now);
      primed.add(sourceKey);
      if (normalized.length) {
        state.items = [...normalized, ...state.items].slice(0, 30);
      }
      console.log(`777 catalyst source primed: ${sourceKey}, ${normalized.length} relevant`);
      return;
    }

    const fresh = normalized.filter((item) => !seen.has(item.id || item.url));
    for (const item of rawItems) seen.set(item.id || item.url, now);
    if (fresh.length) state.items = [...fresh, ...state.items].slice(0, 30);

    const alerts = fresh.filter((item) => item.priority === "HIGH").slice(0, 2);
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
    return [
      "777 KATALYSATOR",
      "",
      item.source,
      title,
      `Score: ${item.score}/100`,
      item.keywordHits?.length ? `Treffer: ${item.keywordHits.join(", ")}` : null,
      item.url || null
    ].filter(Boolean).join("\n");
  }

  async function scanTrump() {
    try {
      const params = new URLSearchParams({ exclude_replies: "true" });
      if (trumpLatestId) params.set("min_id", trumpLatestId);
      const data = await getJson(
        `https://truthsocial.com/api/v1/accounts/107780257626128497/statuses?${params}`,
        9000
      );
      const statuses = Array.isArray(data) ? data : [];
      const items = statuses.map((s) => {
        const text = stripHtml(s.content);
        const quoteText = stripHtml(s.quote?.content);
        const combined = [text, quoteText].filter(Boolean).join(" ");
        return {
          id: `trump:${s.id}`,
          source: "Donald Trump · Truth Social",
          title: combined,
          text: combined,
          url: s.url || s.uri || "",
          publishedAt: s.created_at || null
        };
      }).filter((x) => x.title);

      const ids = statuses.map((s) => s.id).filter(Boolean);
      if (ids.length) {
        trumpLatestId = ids.reduce((a, b) => BigInt(a) > BigInt(b) ? a : b);
      }
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
        text: `${x.abstract || ""} ${(x.agencies || []).map((a) => a.name || a.raw_name || "").join(" ")}`,
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
      await accept("pelosi", items, 58);
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
