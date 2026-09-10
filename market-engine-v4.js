const CORE = {
  GLD: { name: "Gold", day: 1.2, velocity: 0.55 },
  SLV: { name: "Silver", day: 1.8, velocity: 0.80 },
  USO: { name: "Crude Oil", day: 2.0, velocity: 0.90 },
  UNG: { name: "Natural Gas", day: 3.0, velocity: 1.25 },
  COPX: { name: "Copper", day: 2.0, velocity: 0.90 },
  DBA: { name: "Agriculture", day: 1.5, velocity: 0.65 }
};

const CONTEXT = {
  SPY: { name: "S&P 500", day: 2.0, velocity: 0.80 },
  QQQ: { name: "Nasdaq 100", day: 2.5, velocity: 1.00 },
  TLT: { name: "US Treasuries", day: 1.5, velocity: 0.65 },
  UUP: { name: "US Dollar", day: 1.0, velocity: 0.40 }
};

const COMMODITY_KEYWORDS = {
  GLD: ["gold", "silver", "inflation", "interest rate", "rate cut", "rate hike", "fomc", "monetary policy", "dollar", "treasury", "sanction", "war", "attack"],
  SLV: ["silver", "gold", "inflation", "interest rate", "rate cut", "rate hike", "fomc", "dollar", "mining", "sanction", "war"],
  USO: ["oil", "crude", "petroleum", "opec", "refinery", "pipeline", "iran", "russia", "sanction", "strategic petroleum reserve", "spr", "war", "attack"],
  UNG: ["natural gas", "lng", "pipeline", "russia", "sanction", "export ban", "war", "attack"],
  COPX: ["copper", "mining", "minerals", "china", "tariff", "tariffs", "export ban", "export control", "trade restriction"],
  DBA: ["agriculture", "grain", "wheat", "corn", "soybean", "soybeans", "tariff", "tariffs", "export ban", "russia", "war"]
};

const OPTION_SYMBOLS = new Set(["GLD", "SLV", "USO"]);
const CORE_INTERVAL_MS = 5 * 60 * 1000;
const CONTEXT_INTERVAL_MS = 20 * 60 * 1000;
const OPTION_COOLDOWN_MS = 30 * 60 * 1000;
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;
const CATALYST_CORRELATION_MAX_AGE_MS = 90 * 60 * 1000;
const CONTEXT_CORRELATION_MAX_AGE_MS = 30 * 60 * 1000;
const CORRELATION_REQUIRED = 2;

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  if (typeof timer.unref === "function") timer.unref();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function pct(a, b) {
  return b ? ((a - b) / b) * 100 : 0;
}

function round(value, digits = 2) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function pick(snapshot, camel, snake) {
  return snapshot?.[camel] || snapshot?.[snake] || null;
}

function marketWindowOpen() {
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

function createMarketEngine({
  sendMessage,
  telegramConfigured,
  onAlert,
  onSignalAlert,
  onCoreScan,
  getCatalystState = () => ({ items: [] })
}) {
  const alpacaKey = process.env.APCA_API_KEY_ID;
  const alpacaSecret = process.env.APCA_API_SECRET_KEY;
  const twelveKey = process.env.TWELVE;
  const previous = new Map();
  const alertState = new Map();
  const optionCheckedAt = new Map();
  const optionsBySymbol = new Map();
  let corePrimed = false;
  let contextPrimed = false;

  const state = {
    source: "alpaca-iex",
    core: [],
    context: [],
    options: null,
    correlations: [],
    lastCoreScanAt: null,
    lastContextScanAt: null,
    lastOptionsScanAt: null,
    lastError: null,
    marketWindowOpen: false
  };

  function alpacaConfigured() {
    return Boolean(alpacaKey && alpacaSecret);
  }

  async function alpacaJson(url, timeout = 9000) {
    if (!alpacaConfigured()) throw new Error("Alpaca market data is not configured");
    const t = timeoutSignal(timeout);
    try {
      const response = await fetch(url, {
        headers: {
          "APCA-API-KEY-ID": alpacaKey,
          "APCA-API-SECRET-KEY": alpacaSecret,
          "User-Agent": "777-signal-radar/4.1"
        },
        signal: t.signal
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.message || `Alpaca HTTP ${response.status}`);
      return data;
    } finally {
      t.clear();
    }
  }

  async function fetchSnapshots(symbols) {
    const params = new URLSearchParams({ symbols: symbols.join(","), feed: "iex", currency: "USD" });
    const data = await alpacaJson(`https://data.alpaca.markets/v2/stocks/snapshots?${params}`);
    return data.snapshots || data;
  }

  function analyze(symbol, snapshot, config, kind) {
    const latestTrade = pick(snapshot, "latestTrade", "latest_trade");
    const latestQuote = pick(snapshot, "latestQuote", "latest_quote");
    const daily = pick(snapshot, "dailyBar", "daily_bar") || {};
    const prevDaily = pick(snapshot, "prevDailyBar", "previous_daily_bar") || pick(snapshot, "previousDailyBar", "previous_daily_bar") || {};
    const bid = num(latestQuote?.bp ?? latestQuote?.bid_price);
    const ask = num(latestQuote?.ap ?? latestQuote?.ask_price);
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
    const price = num(latestTrade?.p ?? latestTrade?.price) || num(daily.c ?? daily.close) || mid;
    const previousClose = num(prevDaily.c ?? prevDaily.close);
    const high = num(daily.h ?? daily.high);
    const low = num(daily.l ?? daily.low);
    const dayPct = pct(price, previousClose);
    const rangePct = previousClose ? ((high - low) / previousClose) * 100 : 0;

    const prior = previous.get(symbol);
    const velocityPct = prior?.price ? pct(price, prior.price) : 0;
    const minutesSincePrior = prior?.time ? Math.max((Date.now() - prior.time) / 60000, 0) : null;
    previous.set(symbol, { price, time: Date.now() });

    const dayRatio = Math.abs(dayPct) / config.day;
    const velocityRatio = Math.abs(velocityPct) / config.velocity;
    const rangeRatio = Math.abs(rangePct) / (config.day * 1.5);
    let score = Math.min(dayRatio * 45, 60);
    if (prior) score += Math.min(velocityRatio * 25, 25);
    score += Math.min(rangeRatio * 15, 15);
    score = Math.round(Math.min(score, 100));

    let direction = "KEIN SIGNAL";
    if (dayRatio >= 1 || (prior && velocityRatio >= 1)) {
      const driver = prior && velocityRatio >= dayRatio ? velocityPct : dayPct;
      direction = driver >= 0 ? "LONG" : "SHORT";
    }

    let priority = "LOW";
    if (score >= 70 && direction !== "KEIN SIGNAL") priority = "HIGH";
    else if (score >= 45 && direction !== "KEIN SIGNAL") priority = "MEDIUM";

    return {
      symbol,
      name: config.name,
      kind,
      price: round(price, price < 20 ? 3 : 2),
      previousClose: round(previousClose, 2),
      percentChange: round(dayPct, 2),
      velocityPct: round(velocityPct, 2),
      velocityMinutes: minutesSincePrior == null ? null : round(minutesSincePrior, 1),
      rangePct: round(rangePct, 2),
      direction,
      score,
      priority,
      source: "Alpaca IEX",
      marketTime: latestTrade?.t ?? latestTrade?.timestamp ?? daily.t ?? daily.timestamp ?? null
    };
  }

  function signalKey(signal) {
    return `${signal.symbol}:${signal.direction}`;
  }

  function primeSignals(signals) {
    const now = Date.now();
    for (const signal of signals) {
      if (signal.priority === "HIGH" && signal.direction !== "KEIN SIGNAL") {
        alertState.set(signalKey(signal), { sentAt: now, score: signal.score, correlationCount: 1, startupBaseline: true });
      }
    }
  }

  function recentCatalystFor(signal) {
    const keywords = COMMODITY_KEYWORDS[signal.symbol] || [];
    const items = getCatalystState()?.items || [];
    return items
      .filter((item) => !item.baseline && item.detectedAt)
      .filter((item) => Date.now() - new Date(item.detectedAt).getTime() <= CATALYST_CORRELATION_MAX_AGE_MS)
      .filter((item) => {
        const hits = (item.keywordHits || []).map((x) => String(x).toLowerCase());
        const text = `${item.title || ""} ${item.text || ""}`.toLowerCase();
        return keywords.some((k) => hits.includes(k) || text.includes(k));
      })
      .sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null;
  }

  function directionalOptionFor(signal) {
    const snapshot = optionsBySymbol.get(signal.symbol);
    if (!snapshot?.time || Date.now() - new Date(snapshot.time).getTime() > 90 * 60 * 1000) return null;
    const wanted = signal.direction === "LONG" ? "CALL" : "PUT";
    return (snapshot.top || [])
      .filter((x) => x.side === wanted && x.notional >= 1000000)
      .sort((a, b) => b.notional - a.notional)[0] || null;
  }

  function extremeContext() {
    if (!state.lastContextScanAt) return null;
    if (Date.now() - new Date(state.lastContextScanAt).getTime() > CONTEXT_CORRELATION_MAX_AGE_MS) return null;
    return state.context
      .filter((x) => x.priority === "HIGH" && x.score >= 85 && x.direction !== "KEIN SIGNAL")
      .sort((a, b) => b.score - a.score)[0] || null;
  }

  function correlationFor(signal) {
    const confirmations = [{ type: "price", label: "Rohstoffbewegung", weight: 1 }];
    const catalyst = recentCatalystFor(signal);
    const option = directionalOptionFor(signal);
    const context = extremeContext();

    if (catalyst) confirmations.push({ type: "catalyst", label: `${catalyst.source}`, weight: 1, detail: catalyst.title });
    if (option) confirmations.push({ type: "options", label: `${option.side} ~$${Math.round(option.notional).toLocaleString("en-US")}`, weight: 1, detail: option.contract });
    if (context) confirmations.push({ type: "context", label: `Extremkontext ${context.symbol} ${context.direction}`, weight: 1, detail: `${context.percentChange}% · Score ${context.score}` });

    const count = confirmations.reduce((sum, x) => sum + x.weight, 0);
    return {
      count,
      required: CORRELATION_REQUIRED,
      qualified: count >= CORRELATION_REQUIRED,
      labels: confirmations.map((x) => x.label),
      confirmations,
      catalyst: catalyst ? { source: catalyst.source, title: catalyst.title, score: catalyst.score } : null,
      option: option || null,
      context: context ? { symbol: context.symbol, direction: context.direction, score: context.score } : null
    };
  }

  function shouldAlert(signal, correlation) {
    if (signal.priority !== "HIGH" || signal.direction === "KEIN SIGNAL" || !correlation.qualified) return false;
    const prior = alertState.get(signalKey(signal));
    if (!prior) return true;
    if ((prior.correlationCount || 1) < correlation.count) return true;
    if (signal.score >= (prior.score || 0) + 15) return true;
    return Date.now() - prior.sentAt >= ALERT_COOLDOWN_MS;
  }

  function marketAlertText(signal, correlation) {
    const sign = signal.percentChange >= 0 ? "+" : "";
    const velocity = signal.velocityMinutes == null
      ? "noch keine Vergleichsmessung"
      : `${signal.velocityPct >= 0 ? "+" : ""}${signal.velocityPct.toFixed(2)}% / ${signal.velocityMinutes} min`;
    return [
      "777 KORRELIERTES ROHSTOFF-SIGNAL",
      "",
      `${signal.direction} ${signal.name} (${signal.symbol})`,
      `Preis: ${signal.price}`,
      `Tagesbewegung: ${sign}${signal.percentChange.toFixed(2)}%`,
      `Kurzfristig: ${velocity}`,
      `Score: ${signal.score}/100`,
      `Bestätigungen: ${correlation.count}/${correlation.required}`,
      ...correlation.labels.map((x) => `• ${x}`),
      `Quelle Preis: ${signal.source}`
    ].join("\n");
  }

  async function alertSignals(signals) {
    state.correlations = [];
    if (!telegramConfigured()) return;
    const candidates = signals.filter((s) => s.priority === "HIGH" && s.direction !== "KEIN SIGNAL").sort((a, b) => b.score - a.score);

    for (const signal of candidates) {
      const correlation = correlationFor(signal);
      signal.correlation = { count: correlation.count, required: correlation.required, qualified: correlation.qualified, labels: correlation.labels };
      state.correlations.push({ symbol: signal.symbol, direction: signal.direction, score: signal.score, ...signal.correlation });
      if (!shouldAlert(signal, correlation)) continue;
      try {
        await sendMessage(marketAlertText(signal, correlation));
        alertState.set(signalKey(signal), { sentAt: Date.now(), score: signal.score, correlationCount: correlation.count, startupBaseline: false });
        const iso = new Date().toISOString();
        onAlert?.(iso);
        onSignalAlert?.({ signal: { ...signal }, correlation });
      } catch (error) {
        console.error("777 correlated market alert failed:", error.message);
      }
    }
  }

  async function optionConfirmation(symbol) {
    if (!OPTION_SYMBOLS.has(symbol) || !alpacaConfigured()) return null;
    const last = optionCheckedAt.get(symbol) || 0;
    if (Date.now() - last < OPTION_COOLDOWN_MS) return optionsBySymbol.get(symbol) || null;
    optionCheckedAt.set(symbol, Date.now());

    const updatedSince = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    const params = new URLSearchParams({ feed: "indicative", limit: "200", updated_since: updatedSince });
    try {
      const data = await alpacaJson(`https://data.alpaca.markets/v1beta1/options/snapshots/${encodeURIComponent(symbol)}?${params}`, 12000);
      const snapshots = data.snapshots || {};
      const candidates = [];
      for (const [contract, snapshot] of Object.entries(snapshots)) {
        const trade = pick(snapshot, "latestTrade", "latest_trade");
        if (!trade) continue;
        const price = num(trade.p ?? trade.price);
        const size = num(trade.s ?? trade.size);
        const time = trade.t ?? trade.timestamp ?? null;
        const notional = price * size * 100;
        if (!time || Date.now() - new Date(time).getTime() > 60 * 60 * 1000) continue;
        if (notional < 500000) continue;
        const m = contract.match(/^([A-Z.]+)(\d{6})([CP])(\d{8})$/);
        candidates.push({ contract, side: m?.[3] === "C" ? "CALL" : m?.[3] === "P" ? "PUT" : "OPTION", strike: m ? Number(m[4]) / 1000 : null, price: round(price, 2), size, notional: Math.round(notional), time });
      }
      candidates.sort((a, b) => b.notional - a.notional);
      const snapshot = { symbol, mode: "INDICATIVE / DELAYED", top: candidates.slice(0, 5), time: new Date().toISOString() };
      optionsBySymbol.set(symbol, snapshot);
      state.options = snapshot;
      state.lastOptionsScanAt = snapshot.time;
      return snapshot;
    } catch (error) {
      console.error("777 option confirmation failed:", error.message);
      return optionsBySymbol.get(symbol) || null;
    }
  }

  async function runGroup(config, kind) {
    const symbols = Object.keys(config);
    const snapshots = await fetchSnapshots(symbols);
    return symbols.filter((symbol) => snapshots?.[symbol]).map((symbol) => analyze(symbol, snapshots[symbol], config[symbol], kind)).sort((a, b) => b.score - a.score);
  }

  async function runCore(force = false) {
    state.marketWindowOpen = marketWindowOpen();
    if (!force && !state.marketWindowOpen) return state.core;
    try {
      const wasPrimed = corePrimed;
      state.core = await runGroup(CORE, "commodity");
      state.lastCoreScanAt = new Date().toISOString();
      state.lastError = null;
      if (!corePrimed) {
        primeSignals(state.core);
        corePrimed = true;
        console.log("777 commodity baseline primed; startup alerts suppressed");
      }
      const elevated = state.core.find((s) => s.priority === "HIGH" && s.direction !== "KEIN SIGNAL" && OPTION_SYMBOLS.has(s.symbol));
      if (wasPrimed && elevated) await optionConfirmation(elevated.symbol);
      if (wasPrimed) await alertSignals(state.core);
      onCoreScan?.(state.core);
      console.log(`777 commodity scan complete: ${state.core.length} instruments`);
      return state.core;
    } catch (error) {
      state.lastError = error.message;
      console.error("777 commodity scan error:", error.message);
      return state.core;
    }
  }

  async function runContext(force = false) {
    state.marketWindowOpen = marketWindowOpen();
    if (!force && !state.marketWindowOpen) return state.context;
    try {
      state.context = await runGroup(CONTEXT, "extreme-context");
      state.lastContextScanAt = new Date().toISOString();
      state.lastError = null;
      if (!contextPrimed) {
        contextPrimed = true;
        console.log("777 context baseline primed; standalone context alerts disabled");
      }
      console.log(`777 context scan complete: ${state.context.length} sentinels`);
      return state.context;
    } catch (error) {
      state.lastError = error.message;
      console.error("777 context scan error:", error.message);
      return state.context;
    }
  }

  async function quote(symbol) {
    const clean = String(symbol || "").trim().toUpperCase();
    if (!clean || !/^[A-Z.]{1,10}$/.test(clean)) throw new Error("Invalid symbol");
    try {
      const snapshots = await fetchSnapshots([clean]);
      const s = snapshots?.[clean];
      if (!s) throw new Error("No Alpaca snapshot");
      const trade = pick(s, "latestTrade", "latest_trade");
      const daily = pick(s, "dailyBar", "daily_bar") || {};
      const prevDaily = pick(s, "prevDailyBar", "previous_daily_bar") || pick(s, "previousDailyBar", "previous_daily_bar") || {};
      const price = num(trade?.p ?? trade?.price) || num(daily.c ?? daily.close);
      const previousClose = num(prevDaily.c ?? prevDaily.close);
      return { symbol: clean, price: round(price, price < 20 ? 3 : 2), previousClose: round(previousClose, 2), percentChange: round(pct(price, previousClose), 2), source: "Alpaca IEX", time: trade?.t ?? trade?.timestamp ?? null };
    } catch (alpacaError) {
      if (!twelveKey) throw alpacaError;
      const t = timeoutSignal(8000);
      try {
        const response = await fetch(`https://api.twelvedata.com/quote?symbol=${encodeURIComponent(clean)}&apikey=${encodeURIComponent(twelveKey)}`, { signal: t.signal });
        const data = await response.json();
        if (!response.ok || data.status === "error" || data.code) throw new Error(data.message || `Twelve Data HTTP ${response.status}`);
        return { symbol: clean, price: num(data.close), previousClose: num(data.previous_close), percentChange: num(data.percent_change), source: "Twelve Data fallback", time: data.datetime || null };
      } finally {
        t.clear();
      }
    }
  }

  function start() {
    const a = setTimeout(() => runCore(), 8000);
    const b = setTimeout(() => runContext(), 18000);
    const coreTimer = setInterval(() => runCore(), CORE_INTERVAL_MS);
    const contextTimer = setInterval(() => runContext(), CONTEXT_INTERVAL_MS);
    for (const timer of [a, b, coreTimer, contextTimer]) if (typeof timer.unref === "function") timer.unref();
  }

  return {
    start,
    runCore,
    runContext,
    quote,
    optionConfirmation,
    marketWindowOpen,
    getState: () => ({
      ...state,
      coreSymbols: Object.keys(CORE),
      contextSymbols: Object.keys(CONTEXT),
      coreIntervalMinutes: CORE_INTERVAL_MS / 60000,
      contextIntervalMinutes: CONTEXT_INTERVAL_MS / 60000,
      correlationRequired: CORRELATION_REQUIRED,
      catalystCorrelationMaxAgeMinutes: CATALYST_CORRELATION_MAX_AGE_MS / 60000,
      optionsMode: "indicative-confirmation-only",
      alpacaConfigured: alpacaConfigured()
    })
  };
}

module.exports = createMarketEngine;
