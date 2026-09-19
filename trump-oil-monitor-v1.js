const fs = require("fs");
const path = require("path");
const { createMassiveFuturesClient } = require("./massive-futures-v1");

const BUCKET_MS = 60 * 1000;
const HISTORY_DAYS = 21;
const HISTORY_LAG_MS = 5 * 60 * 1000;
const RETAIN_DAYS = 45;
const MAX_ANOMALIES = 500;
const MAX_INCIDENTS = 250;
const MAX_POSTS = 200;
const MIN_PRICE_BASELINE = 240;
const MIN_MICRO_BASELINE = 120;
const INCIDENT_CLUSTER_MS = 30 * 60 * 1000;
const POST_BURST_MS = 30 * 60 * 1000;
const POST_LOOKBACK_MS = 45 * 60 * 1000;
const POST_FORWARD_MS = 30 * 60 * 1000;
const CATALYST_LOOKBACK_MS = 30 * 60 * 1000;
const HEALTH_GRACE_MS = 5 * 60 * 1000;
const OUTCOME_GRACE_MS = 5 * 60 * 1000;
const FOLLOW_THROUGH_BPS = 2;
const MIN_OUTCOMES_FOR_REVIEW = 30;
const OUTCOME_HORIZONS = {
  m30: 30 * 60 * 1000,
  m120: 120 * 60 * 1000
};

const PRODUCTS = {
  CL: { name: "WTI Crude Oil" },
  BZ: { name: "Brent Crude Oil" }
};

function round(value, digits = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function isFiniteMetric(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function metricNumber(value) {
  return isFiniteMetric(value) ? Number(value) : Number.NaN;
}

function safeTime(value) {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

function epochMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n > 1e16) return Math.floor(n / 1e6);
  if (n > 1e14) return Math.floor(n / 1e3);
  return Math.floor(n);
}

function epochNanoseconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return (BigInt(Math.floor(n)) * 1000000n).toString();
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function robustZ(value, values) {
  if (!Number.isFinite(value) || values.length < 20) return null;
  const center = median(values);
  const deviations = values.map((item) => Math.abs(item - center));
  const mad = median(deviations);
  if (mad > 1e-12) return (value - center) / (1.4826 * mad);
  const mean = values.reduce((sum, item) => sum + item, 0) / values.length;
  const variance = values.reduce((sum, item) => sum + ((item - mean) ** 2), 0) / Math.max(1, values.length - 1);
  const deviation = Math.sqrt(variance);
  return deviation > 1e-12 ? (value - mean) / deviation : 0;
}

function slotOf(timestamp) {
  const d = new Date(timestamp);
  return (d.getUTCHours() * 4) + Math.floor(d.getUTCMinutes() / 15);
}

function freshBucket(productCode, ticker, timestamp) {
  const start = Math.floor(timestamp / BUCKET_MS) * BUCKET_MS;
  return {
    productCode,
    ticker,
    start,
    end: start + BUCKET_MS,
    open: null,
    high: null,
    low: null,
    close: null,
    volume: 0,
    buyVolume: 0,
    sellVolume: 0,
    signedVolume: 0,
    tradeCount: 0,
    quoteCount: 0,
    ofi: 0,
    spreadBpsSum: 0,
    spreadSamples: 0,
    lastTradePrice: null,
    lastTradeSign: 0,
    lastQuote: null
  };
}

function eiaWindow(timestamp) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(new Date(timestamp));
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value || 0);
  const clock = (hour * 60) + minute;
  return weekday === "Wed" && clock >= 10 * 60 + 25 && clock <= 10 * 60 + 40;
}

function createTrumpOilMonitor({
  sendMessage,
  telegramConfigured,
  getPublicCatalysts = () => ({ items: [] }),
  dataDir = process.env.RADAR_DATA_DIR || "/data",
  now = () => Date.now(),
  providerFactory = createMassiveFuturesClient
} = {}) {
  let storageFile = null;
  let persistence = "memory-only";
  let closeTimer = null;
  let persistTimer = null;
  let healthTimer = null;
  let everAuthenticated = false;
  let healthIncidentOpen = false;
  let lastHealthAlertAt = 0;
  const current = new Map();
  const liveQuotes = new Map();

  const state = {
    version: 2,
    status: "initializing",
    source: "massive-futures",
    provider: null,
    products: Object.fromEntries(Object.keys(PRODUCTS).map((code) => [code, {
      productCode: code,
      name: PRODUCTS[code].name,
      ticker: null,
      baseline: [],
      latestBucket: null,
      lastEventAt: null,
      lastAlertAt: null
    }])),
    anomalies: [],
    incidents: [],
    posts: [],
    observation: {
      startedAt: null,
      lastBucketAt: null
    },
    metrics: {
      bucketsEvaluated: 0,
      anomaliesDetected: 0,
      incidentsCreated: 0,
      incidentAlertsSent: 0,
      duplicateAnomaliesSuppressed: 0,
      crossMarketConfirmations: 0,
      unexplainedAlerts: 0,
      confirmedPostLinks: 0,
      postEventAnomalies: 0
    },
    persistence,
    lastStartedAt: null,
    lastPersistedAt: null,
    lastError: null
  };

  function initStorage() {
    for (const dir of [dataDir, path.join("/tmp", "777-radar")]) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, ".oil-monitor-write-test");
        fs.writeFileSync(probe, "ok");
        fs.unlinkSync(probe);
        storageFile = path.join(dir, "trump-oil-monitor.json");
        persistence = dir === dataDir ? `persistent:${dir}` : `fallback:${dir}`;
        state.persistence = persistence;
        return;
      } catch (error) {
        console.error(`777 oil monitor storage unavailable ${dir}:`, error.message);
      }
    }
  }

  function prune() {
    const cutoff = now() - RETAIN_DAYS * 86400000;
    for (const product of Object.values(state.products)) {
      product.baseline = product.baseline
        .filter((bucket) => Number(bucket.start) >= cutoff)
        .slice(-70000);
    }
    state.anomalies = state.anomalies
      .filter((item) => safeTime(item.detectedAt) >= cutoff)
      .slice(0, MAX_ANOMALIES);
    state.incidents = state.incidents
      .filter((item) => safeTime(item.firstEventAt || item.openedAt) >= cutoff)
      .slice(0, MAX_INCIDENTS);
    state.posts = state.posts
      .filter((item) => safeTime(item.publishedAt || item.detectedAt) >= cutoff)
      .slice(0, MAX_POSTS);
  }

  function persistState() {
    if (!storageFile) return;
    prune();
    try {
      const tmp = `${storageFile}.tmp`;
      const payload = {
        version: 2,
        savedAt: new Date(now()).toISOString(),
        products: Object.fromEntries(Object.entries(state.products).map(([code, product]) => [code, {
          ...product,
          baseline: product.baseline
        }])),
        anomalies: state.anomalies,
        incidents: state.incidents,
        posts: state.posts,
        observation: state.observation,
        metrics: state.metrics
      };
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, storageFile);
      state.lastPersistedAt = payload.savedAt;
    } catch (error) {
      state.lastError = error.message;
      console.error("777 oil monitor persist error:", error.message);
    }
  }

  function loadState() {
    if (!storageFile || !fs.existsSync(storageFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(storageFile, "utf8"));
      for (const code of Object.keys(PRODUCTS)) {
        const saved = parsed.products?.[code];
        if (!saved) continue;
        state.products[code] = {
          ...state.products[code],
          ...saved,
          baseline: Array.isArray(saved.baseline) ? saved.baseline : []
        };
      }
      state.anomalies = Array.isArray(parsed.anomalies) ? parsed.anomalies : [];
      state.incidents = Array.isArray(parsed.incidents) ? parsed.incidents : [];
      state.posts = Array.isArray(parsed.posts) ? parsed.posts : [];
      state.observation = { ...state.observation, ...(parsed.observation || {}) };
      state.metrics = { ...state.metrics, ...(parsed.metrics || {}) };
      delete state.metrics.falseAlertRatePerDay;
      prune();
      console.log(`777 oil monitor state loaded: ${state.incidents.length} incidents, ${state.anomalies.length} anomalies, ${state.posts.length} Trump oil posts`);
    } catch (error) {
      state.lastError = error.message;
      console.error("777 oil monitor load error:", error.message);
    }
  }

  function updateProviderStatus(next) {
    state.provider = next;
    for (const [code, contract] of Object.entries(next.contracts || {})) {
      if (state.products[code]) state.products[code].ticker = contract.ticker;
    }
    if (next.authenticated) {
      everAuthenticated = true;
      state.status = "live";
      state.lastError = null;
      if (healthIncidentOpen) {
        healthIncidentOpen = false;
        if (telegramConfigured?.()) {
          sendMessage([
            "777 DATENQUELLE WIEDERHERGESTELLT",
            "",
            "Massive Futures ist wieder verbunden und authentifiziert.",
            `Zeit: ${new Date(now()).toISOString()}`
          ].join("\n")).catch((error) => console.error("777 oil monitor recovery alert failed:", error.message));
        }
      }
    } else if (next.lastError) {
      state.lastError = next.lastError;
      if (state.status !== "initializing") state.status = next.configured ? "degraded" : "offline";
      scheduleHealthAlert();
    }
  }

  function scheduleHealthAlert() {
    if (!everAuthenticated || healthTimer) return;
    healthTimer = setTimeout(async () => {
      healthTimer = null;
      if (state.provider?.authenticated || now() - lastHealthAlertAt < HEALTH_GRACE_MS) return;
      healthIncidentOpen = true;
      lastHealthAlertAt = now();
      if (!telegramConfigured?.()) return;
      try {
        await sendMessage([
          "777 DATENQUELLE GESTÖRT",
          "",
          "Massive Futures liefert seit mindestens fünf Minuten keinen authentifizierten Live-Stream.",
          `Status: ${state.provider?.connection || "unbekannt"}`,
          `Fehler: ${state.provider?.lastError || "keine Detailmeldung"}`,
          "Während der Störung werden keine Orderflow-Alarme ausgegeben."
        ].join("\n"));
      } catch (error) {
        console.error("777 oil monitor health alert failed:", error.message);
      }
    }, HEALTH_GRACE_MS);
    if (typeof healthTimer.unref === "function") healthTimer.unref();
  }

  function rotate(event) {
    const timestamp = epochMs(event.timestamp) || now();
    const existing = current.get(event.productCode);
    if (!existing) {
      const bucket = freshBucket(event.productCode, event.ticker, timestamp);
      current.set(event.productCode, bucket);
      return bucket;
    }
    if (timestamp < existing.end && event.ticker === existing.ticker) return existing;
    closeBucket(existing, false);
    const bucket = freshBucket(event.productCode, event.ticker, timestamp);
    current.set(event.productCode, bucket);
    return bucket;
  }

  function quoteOfi(previous, next) {
    if (!previous || !next) return 0;
    let value = 0;
    if (next.bid > previous.bid) value += next.bidSize;
    else if (next.bid === previous.bid) value += next.bidSize - previous.bidSize;
    else value -= previous.bidSize;

    if (next.ask < previous.ask) value -= next.askSize;
    else if (next.ask === previous.ask) value += previous.askSize - next.askSize;
    else value += previous.askSize;
    return value;
  }

  function handleQuote(event) {
    const bucket = rotate(event);
    const quote = {
      bid: Number(event.bid || 0),
      bidSize: Number(event.bidSize || 0),
      ask: Number(event.ask || 0),
      askSize: Number(event.askSize || 0),
      timestamp: epochMs(event.timestamp) || now()
    };
    if (quote.bid <= 0 || quote.ask <= 0 || quote.ask < quote.bid) return;
    bucket.ofi += quoteOfi(bucket.lastQuote, quote);
    bucket.quoteCount += 1;
    const mid = (quote.bid + quote.ask) / 2;
    bucket.spreadBpsSum += mid > 0 ? ((quote.ask - quote.bid) / mid) * 10000 : 0;
    bucket.spreadSamples += 1;
    bucket.lastQuote = quote;
    liveQuotes.set(event.productCode, quote);
  }

  function aggressorSign(bucket, price) {
    const quote = bucket.lastQuote || liveQuotes.get(bucket.productCode);
    if (quote?.ask > 0 && price >= quote.ask) return 1;
    if (quote?.bid > 0 && price <= quote.bid) return -1;
    if (bucket.lastTradePrice != null && price !== bucket.lastTradePrice) return price > bucket.lastTradePrice ? 1 : -1;
    return bucket.lastTradeSign || 0;
  }

  function handleTrade(event) {
    const bucket = rotate(event);
    const price = Number(event.price);
    const size = Number(event.size);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size <= 0) return;
    const sign = aggressorSign(bucket, price);
    if (bucket.open == null) bucket.open = price;
    bucket.high = bucket.high == null ? price : Math.max(bucket.high, price);
    bucket.low = bucket.low == null ? price : Math.min(bucket.low, price);
    bucket.close = price;
    bucket.volume += size;
    bucket.tradeCount += 1;
    bucket.signedVolume += sign * size;
    if (sign > 0) bucket.buyVolume += size;
    if (sign < 0) bucket.sellVolume += size;
    bucket.lastTradePrice = price;
    if (sign) bucket.lastTradeSign = sign;
  }

  function handleProviderEvent(event) {
    if (!state.products[event.productCode]) return;
    state.products[event.productCode].lastEventAt = new Date(epochMs(event.timestamp) || now()).toISOString();
    if (event.type === "quote") handleQuote(event);
    else if (event.type === "trade") handleTrade(event);
  }

  function bucketFeatures(bucket, previousClose = null) {
    const close = Number(bucket.close);
    const open = Number(bucket.open);
    const high = Number(bucket.high);
    const low = Number(bucket.low);
    const denominator = previousClose > 0 ? previousClose : open;
    const returnBps = denominator > 0 && close > 0 ? ((close - denominator) / denominator) * 10000 : 0;
    const rangeBps = open > 0 && high > 0 && low > 0 ? ((high - low) / open) * 10000 : 0;
    return {
      start: bucket.start,
      end: bucket.end,
      ticker: bucket.ticker,
      open: round(open, 5),
      high: round(high, 5),
      low: round(low, 5),
      close: round(close, 5),
      returnBps: round(returnBps),
      rangeBps: round(rangeBps),
      volume: round(bucket.volume),
      tradeCount: bucket.tradeCount,
      quoteCount: bucket.quoteCount,
      imbalance: bucket.volume > 0 ? round(bucket.signedVolume / bucket.volume, 5) : null,
      ofiPerQuote: bucket.quoteCount > 0 ? round(bucket.ofi / Math.sqrt(bucket.quoteCount), 5) : null,
      spreadBps: bucket.spreadSamples > 0 ? round(bucket.spreadBpsSum / bucket.spreadSamples, 5) : null,
      historical: false
    };
  }

  function referenceValues(product, feature, start, ticker) {
    const targetSlot = slotOf(start);
    const all = product.baseline
      .filter((item) => (!ticker || item.ticker === ticker) && isFiniteMetric(item[feature]))
      .map((item) => ({ value: Number(item[feature]), slot: slotOf(item.start) }));
    const slot = all.filter((item) => item.slot === targetSlot).map((item) => item.value);
    return slot.length >= 30 ? slot : all.map((item) => item.value);
  }

  function scoreFeatures(product, features) {
    const raw = {
      returnZ: robustZ(metricNumber(features.returnBps), referenceValues(product, "returnBps", features.start, features.ticker)),
      rangeZ: robustZ(metricNumber(features.rangeBps), referenceValues(product, "rangeBps", features.start, features.ticker)),
      volumeZ: robustZ(metricNumber(features.volume), referenceValues(product, "volume", features.start, features.ticker)),
      tradeCountZ: robustZ(metricNumber(features.tradeCount), referenceValues(product, "tradeCount", features.start, features.ticker)),
      imbalanceZ: robustZ(metricNumber(features.imbalance), referenceValues(product, "imbalance", features.start, features.ticker)),
      ofiZ: robustZ(metricNumber(features.ofiPerQuote), referenceValues(product, "ofiPerQuote", features.start, features.ticker)),
      spreadZ: robustZ(metricNumber(features.spreadBps), referenceValues(product, "spreadBps", features.start, features.ticker))
    };
    const z = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, round(value)]));
    const priceBaseline = referenceValues(product, "volume", features.start, features.ticker).length;
    const microBaseline = Math.min(
      referenceValues(product, "imbalance", features.start, features.ticker).length,
      referenceValues(product, "ofiPerQuote", features.start, features.ticker).length
    );
    const directional = [z.returnZ, z.imbalanceZ, z.ofiZ]
      .filter((value) => Number.isFinite(value) && Math.abs(value) >= 2)
      .map((value) => Math.sign(value));
    const longVotes = directional.filter((value) => value > 0).length;
    const shortVotes = directional.filter((value) => value < 0).length;
    const agreement = Math.max(longVotes, shortVotes);
    const direction = longVotes === shortVotes ? null : longVotes > shortVotes ? "LONG" : "SHORT";
    const components = [
      Math.abs(Number(z.returnZ || 0)),
      Math.max(0, Number(z.rangeZ || 0)),
      Math.max(0, Number(z.volumeZ || 0)),
      Math.max(0, Number(z.tradeCountZ || 0)),
      Math.abs(Number(z.imbalanceZ || 0)),
      Math.abs(Number(z.ofiZ || 0))
    ];
    const composite = round(
      components[0] * 0.18 + components[1] * 0.10 + components[2] * 0.17 +
      components[3] * 0.10 + components[4] * 0.23 + components[5] * 0.22
    );
    const microExtreme = Math.max(Math.abs(Number(z.imbalanceZ || 0)), Math.abs(Number(z.ofiZ || 0))) >= 3.5;
    const activityExtreme = Math.max(
      Math.abs(Number(z.returnZ || 0)),
      Math.max(0, Number(z.rangeZ || 0)),
      Math.max(0, Number(z.volumeZ || 0)),
      Math.max(0, Number(z.tradeCountZ || 0))
    ) >= 3;
    const qualified = priceBaseline >= MIN_PRICE_BASELINE &&
      microBaseline >= MIN_MICRO_BASELINE &&
      microExtreme && activityExtreme && agreement >= 2 && composite >= 3.5 && Boolean(direction);
    return { z, priceBaseline, microBaseline, composite, agreement, direction, microExtreme, activityExtreme, qualified };
  }

  function nearbyPost(timestamp) {
    return state.posts.find((post) => {
      const postTime = safeTime(post.publishedAt || post.detectedAt);
      return postTime && timestamp >= postTime && timestamp - postTime <= POST_FORWARD_MS;
    }) || null;
  }

  function knownCatalyst(timestamp) {
    if (eiaWindow(timestamp)) return { source: "EIA scheduled release window", title: "Weekly Petroleum Status Report" };
    const items = getPublicCatalysts?.()?.items || [];
    return items.find((item) => {
      if (/trump|truth social/i.test(String(item.source || ""))) return false;
      const itemTime = safeTime(item.publishedAt || item.detectedAt);
      if (!itemTime || itemTime > timestamp || timestamp - itemTime > CATALYST_LOOKBACK_MS) return false;
      const text = `${item.title || ""} ${item.text || ""} ${(item.keywordHits || []).join(" ")}`.toLowerCase();
      return /\boil\b|\bcrude\b|petroleum|opec|iran|russia|refiner|pipeline|spr\b/.test(text);
    }) || null;
  }

  function recentIncident(timestamp, direction) {
    return state.incidents.find((incident) => {
      const first = safeTime(incident.firstEventAt || incident.openedAt);
      return incident.direction === direction && timestamp >= first && timestamp - first <= INCIDENT_CLUSTER_MS;
    }) || null;
  }

  function updateIncidentClassification(incident) {
    if (incident.post) {
      incident.classification = safeTime(incident.firstEventAt) <= safeTime(incident.post.publishedAt)
        ? "PRE_POST_LINK"
        : "POST_EVENT_ANOMALY";
    } else if (incident.knownCatalysts?.length) {
      incident.classification = "EXPLAINED_EVENT";
    } else {
      incident.classification = "UNEXPLAINED_FLOW";
    }
    incident.unexplained = incident.classification === "UNEXPLAINED_FLOW";
  }

  function anomalyText(anomaly) {
    const sign = anomaly.direction === "LONG" ? "Kaufdruck" : "Verkaufsdruck";
    const postLinked = anomaly.classification === "POST_EVENT_ANOMALY" || anomaly.classification === "PRE_POST_LINK";
    return [
      "777 TRUMP-ÖL-FLOWALARM",
      "",
      postLinked ? "AUFFÄLLIGKEIT IM TRUMP-POST-FENSTER" : "UNERKLÄRTE ORDERFLOW-ANOMALIE",
      `${anomaly.productName} (${anomaly.ticker}) · ${anomaly.direction}`,
      `Muster: ${sign} · Score ${anomaly.score}/100`,
      `Preisbewegung: ${anomaly.features.returnBps >= 0 ? "+" : ""}${anomaly.features.returnBps} bp`,
      `Volumen-Z: ${anomaly.z.volumeZ ?? "n/a"} · Trades-Z: ${anomaly.z.tradeCountZ ?? "n/a"}`,
      `Trade-Imbalance-Z: ${anomaly.z.imbalanceZ ?? "n/a"} · Quote-OFI-Z: ${anomaly.z.ofiZ ?? "n/a"}`,
      `Baseline: ${anomaly.microBaseline} Mikrostruktur-Minuten / ${anomaly.priceBaseline} Preis-Minuten`,
      anomaly.post ? `Trump-Post: ${anomaly.post.title.slice(0, 240)}` : "Kein zeitnaher Trump-Post erkannt.",
      anomaly.knownCatalyst ? `Öffentlicher Auslöser: ${anomaly.knownCatalyst.source} · ${anomaly.knownCatalyst.title}` : "Kein zeitnaher öffentlicher Öl-Auslöser erkannt.",
      `Zeitfenster: ${anomaly.windowStart} bis ${anomaly.windowEnd}`,
      "Hinweis: statistische Auffälligkeit, kein Beweis für Insiderhandel und noch kein Handelssignal."
    ].filter(Boolean).join("\n");
  }

  function crossMarketText(incident) {
    return [
      "777 MARKTÜBERGREIFENDE ÖL-ANOMALIE",
      "",
      `${incident.direction} gleichzeitig in ${incident.productCodes.join(" und ")}`,
      `Höchster Score: ${incident.maxScore}/100`,
      `Erstes Fenster: ${incident.firstEventAt}`,
      `Letztes Fenster: ${incident.lastEventAt}`,
      `Vorfall-ID: ${incident.id}`,
      "Die Bestätigung in zwei Futures reduziert Einzelmarkt-Fehlalarme. Sie beweist weder Ursache noch Insiderhandel."
    ].join("\n");
  }

  async function dispatchAnomaly(anomaly, incident) {
    if (!telegramConfigured?.()) return false;
    try {
      await sendMessage(anomalyText(anomaly));
      state.metrics.incidentAlertsSent += 1;
      if (incident?.post || anomaly.post) state.metrics.postEventAnomalies += 1;
      else state.metrics.unexplainedAlerts += 1;
      state.products[anomaly.productCode].lastAlertAt = anomaly.detectedAt;
      return true;
    } catch (error) {
      console.error("777 oil anomaly alert failed:", error.message);
      if (incident) incident.alertIssuedAt = null;
      return false;
    }
  }

  async function dispatchCrossMarket(incident) {
    if (!telegramConfigured?.()) return false;
    try {
      await sendMessage(crossMarketText(incident));
      state.metrics.incidentAlertsSent += 1;
      state.metrics.crossMarketConfirmations += 1;
      return true;
    } catch (error) {
      console.error("777 cross-market oil alert failed:", error.message);
      incident.crossMarketAlertIssuedAt = null;
      return false;
    }
  }

  function createIncident(anomaly) {
    const incident = {
      id: `oil-${safeTime(anomaly.eventAt)}-${anomaly.direction.toLowerCase()}`,
      openedAt: anomaly.detectedAt,
      firstEventAt: anomaly.eventAt,
      lastEventAt: anomaly.eventAt,
      direction: anomaly.direction,
      classification: anomaly.classification,
      unexplained: anomaly.unexplained,
      anomalyIds: [anomaly.id],
      productCodes: [anomaly.productCode],
      primaryProductCode: anomaly.productCode,
      primaryTicker: anomaly.ticker,
      anchorPrice: anomaly.features.close,
      maxScore: anomaly.score,
      post: anomaly.post,
      postLinkedAt: anomaly.post ? anomaly.detectedAt : null,
      postBurstId: anomaly.post?.burstId || null,
      knownCatalysts: anomaly.knownCatalyst ? [anomaly.knownCatalyst] : [],
      alertIssuedAt: null,
      crossMarketAlertIssuedAt: null,
      outcomes: {}
    };
    updateIncidentClassification(incident);
    state.incidents.unshift(incident);
    state.incidents = state.incidents.slice(0, MAX_INCIDENTS);
    state.metrics.incidentsCreated += 1;
    if (incident.post) state.metrics.confirmedPostLinks += 1;
    return incident;
  }

  function mergeIntoIncident(incident, anomaly) {
    const newProduct = !incident.productCodes.includes(anomaly.productCode);
    incident.anomalyIds.push(anomaly.id);
    if (newProduct) incident.productCodes.push(anomaly.productCode);
    incident.lastEventAt = anomaly.eventAt;
    incident.maxScore = Math.max(Number(incident.maxScore || 0), Number(anomaly.score || 0));
    if (anomaly.knownCatalyst && !incident.knownCatalysts.some((item) =>
      item.source === anomaly.knownCatalyst.source && item.title === anomaly.knownCatalyst.title)) {
      incident.knownCatalysts.push(anomaly.knownCatalyst);
    }
    if (anomaly.post && !incident.post) {
      incident.post = anomaly.post;
      incident.postLinkedAt = anomaly.detectedAt;
      incident.postBurstId = anomaly.post.burstId || null;
      state.metrics.confirmedPostLinks += 1;
    }
    updateIncidentClassification(incident);
    return newProduct;
  }

  function recordAnomaly(product, features, scored) {
    const timestamp = features.end;
    const post = nearbyPost(timestamp);
    const catalyst = knownCatalyst(timestamp);
    const unexplained = !post && !catalyst;
    const classification = post ? "POST_EVENT_ANOMALY" : catalyst ? "EXPLAINED_EVENT" : "UNEXPLAINED_FLOW";
    const anomaly = {
      id: `${product.productCode}-${features.end}-${scored.direction}`,
      detectedAt: new Date(now()).toISOString(),
      eventAt: new Date(timestamp).toISOString(),
      windowStart: new Date(features.start).toISOString(),
      windowEnd: new Date(features.end).toISOString(),
      productCode: product.productCode,
      productName: product.name,
      ticker: features.ticker,
      direction: scored.direction,
      classification,
      unexplained,
      score: Math.min(100, Math.round(scored.composite * 18)),
      composite: scored.composite,
      agreement: scored.agreement,
      priceBaseline: scored.priceBaseline,
      microBaseline: scored.microBaseline,
      features,
      z: scored.z,
      post: post ? { id: post.id, title: post.title, publishedAt: post.publishedAt, burstId: post.burstId || null } : null,
      knownCatalyst: catalyst ? { source: catalyst.source, title: catalyst.title || "" } : null,
      postLinkedAt: post ? new Date(now()).toISOString() : null,
      incidentId: null
    };
    let incident = recentIncident(timestamp, scored.direction);
    const isNewIncident = !incident;
    if (!incident) incident = createIncident(anomaly);
    const newProduct = isNewIncident ? false : mergeIntoIncident(incident, anomaly);
    anomaly.incidentId = incident.id;
    anomaly.classification = incident.classification;
    anomaly.unexplained = incident.unexplained;
    state.anomalies.unshift(anomaly);
    state.anomalies = state.anomalies.slice(0, MAX_ANOMALIES);
    state.metrics.anomaliesDetected += 1;
    if (incident.classification !== "EXPLAINED_EVENT") {
      if (!incident.alertIssuedAt && telegramConfigured?.()) {
        incident.alertIssuedAt = new Date(now()).toISOString();
        dispatchAnomaly(anomaly, incident);
      } else if (newProduct && incident.productCodes.length >= 2 && !incident.crossMarketAlertIssuedAt && telegramConfigured?.()) {
        incident.crossMarketAlertIssuedAt = new Date(now()).toISOString();
        dispatchCrossMarket(incident);
      } else if (!isNewIncident) {
        state.metrics.duplicateAnomaliesSuppressed += 1;
      }
    }
    persistState();
    return anomaly;
  }

  function evaluateIncidentOutcomes(productCode, features) {
    let updated = 0;
    for (const incident of state.incidents) {
      if (incident.primaryProductCode !== productCode || !Number.isFinite(Number(incident.anchorPrice))) continue;
      const eventAt = safeTime(incident.firstEventAt);
      if (!eventAt) continue;
      incident.outcomes ||= {};
      for (const [key, horizonMs] of Object.entries(OUTCOME_HORIZONS)) {
        if (incident.outcomes[key] || features.end < eventAt + horizonMs) continue;
        const target = eventAt + horizonMs;
        const lateByMs = features.end - target;
        if (features.ticker !== incident.primaryTicker) {
          incident.outcomes[key] = {
            valid: false,
            reason: "contract-roll",
            targetAt: new Date(target).toISOString(),
            observedAt: new Date(features.end).toISOString(),
            expectedTicker: incident.primaryTicker,
            observedTicker: features.ticker
          };
          updated += 1;
          continue;
        }
        if (lateByMs > OUTCOME_GRACE_MS) {
          incident.outcomes[key] = {
            valid: false,
            reason: "data-gap",
            targetAt: new Date(target).toISOString(),
            observedAt: new Date(features.end).toISOString(),
            lateByMinutes: round(lateByMs / 60000, 1)
          };
          updated += 1;
          continue;
        }
        const rawReturnBps = ((Number(features.close) - Number(incident.anchorPrice)) / Number(incident.anchorPrice)) * 10000;
        const directionalReturnBps = incident.direction === "SHORT" ? -rawReturnBps : rawReturnBps;
        incident.outcomes[key] = {
          valid: true,
          targetAt: new Date(target).toISOString(),
          observedAt: new Date(features.end).toISOString(),
          close: features.close,
          rawReturnBps: round(rawReturnBps),
          directionalReturnBps: round(directionalReturnBps),
          followThrough: directionalReturnBps >= FOLLOW_THROUGH_BPS,
          adverseMove: directionalReturnBps <= -FOLLOW_THROUGH_BPS
        };
        updated += 1;
      }
    }
    return updated;
  }

  function calibrationState() {
    const candidates = state.incidents.filter((incident) => incident.classification !== "EXPLAINED_EVENT");
    const horizon = (key) => {
      const outcomes = candidates.map((incident) => incident.outcomes?.[key]).filter((item) => item?.valid);
      const followed = outcomes.filter((item) => item.followThrough).length;
      const adverse = outcomes.filter((item) => item.adverseMove).length;
      return {
        evaluated: outcomes.length,
        followThrough: followed,
        followThroughRate: outcomes.length ? round(followed / outcomes.length, 3) : null,
        adverse: adverse,
        adverseRate: outcomes.length ? round(adverse / outcomes.length, 3) : null
      };
    };
    const m30 = horizon("m30");
    const m120 = horizon("m120");
    const started = safeTime(state.observation.startedAt);
    const ended = safeTime(state.observation.lastBucketAt);
    const observedDays = started && ended >= started ? (ended - started + BUCKET_MS) / 86400000 : 0;
    const unexplained = state.incidents.filter((incident) => incident.classification === "UNEXPLAINED_FLOW").length;
    return {
      status: m120.evaluated >= MIN_OUTCOMES_FOR_REVIEW ? "reviewable" : "collecting",
      thresholdPolicy: "fixed-until-reviewed",
      minimumOutcomesForReview: MIN_OUTCOMES_FOR_REVIEW,
      followThroughThresholdBps: FOLLOW_THROUGH_BPS,
      totalIncidents: state.incidents.length,
      unexplainedIncidents: unexplained,
      postLinkedIncidents: state.incidents.filter((incident) => Boolean(incident.post)).length,
      explainedIncidents: state.incidents.filter((incident) => incident.classification === "EXPLAINED_EVENT").length,
      crossMarketIncidents: state.incidents.filter((incident) => incident.productCodes.length >= 2).length,
      observedDays: round(observedDays, 2),
      unexplainedIncidentsPerObservedDay: observedDays >= 1 ? round(unexplained / observedDays, 2) : null,
      m30,
      m120
    };
  }

  function closeBucket(bucket, historical) {
    const product = state.products[bucket.productCode];
    if (!product) return null;
    const previous = [...product.baseline].reverse().find((item) => item.ticker === bucket.ticker);
    const features = bucketFeatures(bucket, Number(previous?.close || 0));
    features.historical = Boolean(historical);
    if (!features.close || features.volume <= 0) return null;
    let anomaly = null;
    if (!historical) {
      state.metrics.bucketsEvaluated += 1;
      const bucketAt = new Date(features.end).toISOString();
      if (!state.observation.startedAt) state.observation.startedAt = bucketAt;
      state.observation.lastBucketAt = bucketAt;
      const outcomesUpdated = evaluateIncidentOutcomes(product.productCode, features);
      if (outcomesUpdated) persistState();
      const scored = scoreFeatures(product, features);
      if (scored.qualified) anomaly = recordAnomaly(product, features, scored);
    }
    if (!anomaly || anomaly.classification === "EXPLAINED_EVENT") product.baseline.push(features);
    product.baseline = product.baseline.slice(-70000);
    product.latestBucket = features;
    return { features, anomaly };
  }

  function seedAggregate(productCode, ticker, aggregate, previousClose) {
    const start = epochMs(aggregate.window_start);
    const open = Number(aggregate.open);
    const high = Number(aggregate.high);
    const low = Number(aggregate.low);
    const close = Number(aggregate.close);
    if (!start || !open || !close) return close || previousClose;
    const product = state.products[productCode];
    if (product.baseline.some((item) => item.start === start && item.ticker === ticker)) return close;
    const denominator = previousClose > 0 ? previousClose : open;
    product.baseline.push({
      start,
      end: start + BUCKET_MS,
      ticker,
      open: round(open, 5),
      high: round(high, 5),
      low: round(low, 5),
      close: round(close, 5),
      returnBps: round(((close - denominator) / denominator) * 10000),
      rangeBps: round(((high - low) / open) * 10000),
      volume: Number(aggregate.volume || 0),
      tradeCount: Number(aggregate.transactions || 0),
      quoteCount: null,
      imbalance: null,
      ofiPerQuote: null,
      spreadBps: null,
      historical: true
    });
    return close;
  }

  async function bootstrapHistory() {
    const contracts = provider.getState().contracts || {};
    const to = epochNanoseconds(now() - HISTORY_LAG_MS);
    const from = epochNanoseconds(now() - HISTORY_DAYS * 86400000);
    for (const [code, contract] of Object.entries(contracts)) {
      try {
        const data = await provider.aggregates(contract.ticker, { resolution: "1min", from, to, limit: 50000 });
        let previousClose = null;
        for (const aggregate of data.results || []) previousClose = seedAggregate(code, contract.ticker, aggregate, previousClose);
        state.products[code].baseline.sort((a, b) => a.start - b.start);
        console.log(`777 oil monitor history seeded ${code}: ${state.products[code].baseline.length} minutes`);
      } catch (error) {
        state.lastError = `History ${code}: ${error.message}`;
        console.error(`777 oil monitor history seed failed ${code}:`, error.message);
      }
    }
    persistState();
  }

  function isOilPost(item) {
    const text = `${item?.title || ""} ${item?.text || ""} ${(item?.keywordHits || []).join(" ")}`.toLowerCase();
    return /\boil\b|\bcrude\b|petroleum|opec|refiner|pipeline|strategic petroleum reserve|\bspr\b|iranian oil|russian oil/.test(text);
  }

  function confirmationText(post, links) {
    return [
      "777 TRUMP-ÖL-EREIGNIS BESTÄTIGT",
      "",
      `Trump-Post: ${String(post.title || post.text || "").slice(0, 500)}`,
      `Veröffentlicht: ${post.publishedAt || post.detectedAt}`,
      ...links.map((anomaly) => {
        const minutes = round((safeTime(post.publishedAt || post.detectedAt) - safeTime(anomaly.eventAt)) / 60000, 1);
        const relation = minutes >= 0 ? `${Math.abs(minutes)} Minuten vor dem Post` : `${Math.abs(minutes)} Minuten nach dem Post`;
        return `${anomaly.productName} ${anomaly.direction}: Anomalie ${relation}, Score ${anomaly.score}/100`;
      }),
      post.url || null,
      "Ein zeitlicher Zusammenhang ist bestätigt. Ursache, beteiligte Händler und Insiderwissen sind damit nicht bewiesen."
    ].filter(Boolean).join("\n");
  }

  function postBurst(postTime) {
    const nearby = state.posts.find((post) => {
      const burstStart = safeTime(post.burstStartedAt || post.publishedAt || post.detectedAt);
      return burstStart && postTime >= burstStart && postTime - burstStart <= POST_BURST_MS;
    });
    return nearby
      ? { id: nearby.burstId, startedAt: nearby.burstStartedAt || nearby.publishedAt || nearby.detectedAt }
      : { id: `truth-burst-${postTime}`, startedAt: new Date(postTime).toISOString() };
  }

  async function recordTrumpPost(item) {
    if (!item || !isOilPost(item)) return { accepted: false, reason: "not-oil-related" };
    const key = item.id || item.url || `${item.publishedAt}:${item.title}`;
    if (state.posts.some((post) => post.id === key)) return { accepted: false, reason: "duplicate" };
    const postTime = safeTime(item.publishedAt || item.detectedAt) || now();
    const burst = postBurst(postTime);
    const post = {
      id: key,
      title: String(item.title || item.text || ""),
      url: item.url || null,
      source: item.source || "Donald Trump · Truth Social",
      publishedAt: item.publishedAt || item.detectedAt || new Date(now()).toISOString(),
      detectedAt: item.detectedAt || new Date(now()).toISOString(),
      burstId: burst.id,
      burstStartedAt: burst.startedAt
    };
    state.posts.unshift(post);
    state.posts = state.posts.slice(0, MAX_POSTS);
    const linkedIncidents = state.incidents.filter((incident) => {
      if (incident.postLinkedAt) return false;
      return incident.anomalyIds.some((id) => {
        const anomaly = state.anomalies.find((candidate) => candidate.id === id);
        const eventTime = safeTime(anomaly?.eventAt);
        return eventTime >= postTime - POST_LOOKBACK_MS && eventTime <= postTime + 15 * 60 * 1000;
      });
    });
    const links = [];
    if (linkedIncidents.length) {
      const linkedAt = new Date(now()).toISOString();
      for (const incident of linkedIncidents) {
        incident.postLinkedAt = linkedAt;
        incident.postBurstId = post.burstId;
        incident.post = { id: post.id, title: post.title, publishedAt: post.publishedAt, burstId: post.burstId };
        updateIncidentClassification(incident);
        const incidentAnomalies = incident.anomalyIds
          .map((id) => state.anomalies.find((candidate) => candidate.id === id))
          .filter(Boolean);
        const representative = incidentAnomalies.sort((a, b) => Number(b.score || 0) - Number(a.score || 0))[0];
        if (representative) links.push(representative);
        for (const anomaly of incidentAnomalies) {
          anomaly.postLinkedAt = linkedAt;
          anomaly.post = { id: post.id, title: post.title, publishedAt: post.publishedAt, burstId: post.burstId };
          anomaly.classification = safeTime(anomaly.eventAt) <= postTime ? "PRE_POST_LINK" : "POST_EVENT_ANOMALY";
          anomaly.unexplained = false;
        }
      }
      state.metrics.confirmedPostLinks += linkedIncidents.length;
      if (telegramConfigured?.()) {
        try { await sendMessage(confirmationText(post, links)); }
        catch (error) { console.error("777 Trump oil confirmation alert failed:", error.message); }
      }
    }
    persistState();
    return { accepted: true, linked: linkedIncidents.length, burstId: post.burstId };
  }

  function closeExpiredBuckets() {
    for (const [code, bucket] of current.entries()) {
      if (now() >= bucket.end + 5000) {
        closeBucket(bucket, false);
        current.delete(code);
      }
    }
  }

  const provider = providerFactory({
    productCodes: Object.keys(PRODUCTS),
    now,
    onEvent: handleProviderEvent,
    onStatus: updateProviderStatus
  });

  async function start() {
    if (state.lastStartedAt) return;
    state.lastStartedAt = new Date(now()).toISOString();
    state.status = provider.getState().configured ? "starting" : "offline";
    await provider.start();
    if (provider.getState().configured) bootstrapHistory().catch((error) => {
      state.lastError = error.message;
      console.error("777 oil monitor bootstrap failed:", error.message);
    });
    closeTimer = setInterval(closeExpiredBuckets, 15000);
    persistTimer = setInterval(persistState, 5 * 60 * 1000);
    for (const timer of [closeTimer, persistTimer]) {
      if (typeof timer.unref === "function") timer.unref();
    }
  }

  function stop() {
    if (closeTimer) clearInterval(closeTimer);
    if (persistTimer) clearInterval(persistTimer);
    if (healthTimer) clearTimeout(healthTimer);
    closeTimer = null;
    persistTimer = null;
    healthTimer = null;
    provider.stop();
    persistState();
    state.status = "stopped";
  }

  initStorage();
  loadState();

  return {
    start,
    stop,
    recordTrumpPost,
    bootstrapHistory,
    getState: () => {
      const providerState = provider.getState();
      return {
        ...state,
        products: Object.fromEntries(Object.entries(state.products).map(([code, product]) => {
          const active = product.baseline.filter((item) => !product.ticker || item.ticker === product.ticker);
          const baselineCounts = {
            total: active.length,
            microstructure: active.filter((item) => isFiniteMetric(item.imbalance) && isFiniteMetric(item.ofiPerQuote)).length,
            retainedAcrossContracts: product.baseline.length
          };
          const reason = !providerState.authenticated
            ? "data-source-offline"
            : baselineCounts.total < MIN_PRICE_BASELINE
              ? "price-warm-up"
              : baselineCounts.microstructure < MIN_MICRO_BASELINE
                ? "microstructure-warm-up"
                : "armed";
          return [code, {
            ...product,
            baseline: undefined,
            baselineCounts,
            alertReadiness: { armed: reason === "armed", reason }
          }];
        })),
        anomalies: state.anomalies.slice(0, 100),
        incidents: state.incidents.slice(0, 100),
        posts: state.posts.slice(0, 50),
        provider: providerState,
        calibration: calibrationState(),
        thresholds: {
          minimumPriceMinutes: MIN_PRICE_BASELINE,
          minimumMicrostructureMinutes: MIN_MICRO_BASELINE,
          incidentClusterMinutes: INCIDENT_CLUSTER_MS / 60000,
          postBurstMinutes: POST_BURST_MS / 60000,
          postLookbackMinutes: POST_LOOKBACK_MS / 60000,
          postForwardMinutes: POST_FORWARD_MS / 60000,
          outcomeHorizonsMinutes: Object.values(OUTCOME_HORIZONS).map((value) => value / 60000)
        }
      };
    },
    _test: {
      handleProviderEvent,
      closeExpiredBuckets,
      scoreFeatures,
      seedAggregate,
      recordAnomaly,
      evaluateIncidentOutcomes,
      calibrationState,
      state,
      current
    }
  };
}

module.exports = createTrumpOilMonitor;
