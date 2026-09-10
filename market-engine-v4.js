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

const OPTION_SYMBOLS = new Set(["GLD", "SLV", "USO"]);
const CORE_INTERVAL_MS = 5 * 60 * 1000;
const CONTEXT_INTERVAL_MS = 20 * 60 * 1000;
const OPTION_COOLDOWN_MS = 30 * 60 * 1000;
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

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

function createMarketEngine({ sendMessage, telegramConfigured, onAlert }) {
  const alpacaKey = process.env.APCA_API_KEY_ID;
  const alpacaSecret = process.env.APCA_API_SECRET_KEY;
  const twelveKey = process.env.TWELVE;
  const previous = new Map();
  const alertState = new Map();
  const optionCheckedAt = new Map();
  const optionSeen = new Set();
  let corePrimed = false;
  let contextPrimed = false;

  const state = {
    source: "alpaca-iex",
    core: [],
    context: [],
    options: null,
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
          "User-Agent": "777-signal-radar/4"
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
    const params = new URLSearchParams({
      symbols: symbols.join(","),
      feed: "iex",
      currency: "USD"
    });
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
    let score = 0;
    score += Math.min(dayRatio * 45, 60);
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

  function stateKey(signal) {
    return `${signal.kind}:${signal.symbol}:${signal.direction}`;
  }

  function primeSignals(signals) {
    const now = Date.now();
    for (const signal of signals) {
      if (signal.priority === "HIGH" && signal.direction !== "KEIN SIGNAL") {
        alertState.set(stateKey(signal), { sentAt: now, score: signal.score });
      }
    }
  }

  function shouldAlert(signal) {
    if (signal.priority !== "HIGH" || signal.direction === "KEIN SIGNAL") return false;
    const prior = alertState.get(stateKey(signal));
    if (!prior) return true;
    if (signal.score >= prior.score + 15) return true;
    return Date.now() - prior.sentAt >= ALERT_COOLDOWN_MS;
  }

  function marketAlertText(signal) {
    const sign = signal.percentChange >= 0 ? "+" : "";
    const velocity = signal.velocityMinutes == null
      ? "noch keine Vergleichsmessung"
      : `${signal.velocityPct >= 0 ? "+" : ""}${signal.velocityPct.toFixed(2)}% / ${signal.velocityMinutes} min`;
    return [
      "777 ROHSTOFF-SIGNAL",
      "",
      `${signal.direction} ${signal.name} (${signal.symbol})`,
      `Preis: ${signal.price}`,
      `Tagesbewegung: ${sign}${signal.percentChange.toFixed(2)}%`,
      `Kurzfristig: ${velocity}`,
      `Score: ${signal.score}/100`,
      `Priorität: ${signal.priority}`,
      `Quelle: ${signal.source}`
    ].join("\n");
  }

  async function alertSignals(signals) {
    if (!telegramConfigured()) return;
    for (const signal of signals.filter(shouldAlert).sort((a, b) => b.score - a.score).slice(0, 2)) {
      try {
        await sendMessage(marketAlertText(signal));
        alertState.set(stateKey(signal), { sentAt: Date.now(), score: signal.score });
        onAlert?.(new Date().toISOString());
      } catch (error) {
        console.error("777 market alert failed:", error.message);
      }
    }
  }

  async function optionConfirmation(symbol) {
    if (!OPTION_SYMBOLS.has(symbol) || !alpacaConfigured()) return null;
    const last = optionCheckedAt.get(symbol) || 0;
    if (Date.now() - last < OPTION_COOLDOWN_MS) return state.options;
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
        candidates.push({
          contract,
          side: m?.[3] === "C" ? "CALL" : m?.[3] === "P" ? "PUT" : "OPTION",
          strike: m ? Number(m[4]) / 1000 : null,
          price: round(price, 2),
          size,
          notional: Math.round(notional),
          time
        });
      }
      candidates.sort((a, b) => b.notional - a.notional);
      state.options = {
        symbol,
        mode: "INDICATIVE / DELAYED",
        top: candidates.slice(0, 3),
        time: new Date().toISOString()
      };
      state.lastOptionsScanAt = state.options.time;

      const big = candidates[0];
      const key = big ? `${big.contract}:${big.time}` : null;
      if (big && big.notional >= 1000000 && !optionSeen.has(key) && telegramConfigured()) {
        optionSeen.add(key);
        try {
          await sendMessage([
            "777 OPTIONS-BESTÄTIGUNG",
            "",
            `${symbol} ${big.side}${big.strike ? ` ${big.strike}` : ""}`,
            `Letzter Trade: ${big.size} Kontrakte`,
            `Indikativer Nominalwert: $${Math.round(big.notional).toLocaleString("en-US")}`,
            "Datenmodus: indikativ / verzögert – nur Bestätigung, kein Echtzeit-Flow"
          ].join("\n"));
          onAlert?.(new Date().toISOString());
        } catch (error) {
          console.error("777 option confirmation alert failed:", error.message);
        }
      }
      return state.options;
    } catch (error) {
      console.error("777 option confirmation failed:", error.message);
      return null;
    }
  }

  async function runGroup(config, kind, allowAlerts) {
    const symbols = Object.keys(config);
    const snapshots = await fetchSnapshots(symbols);
    const results = symbols
      .filter((symbol) => snapshots?.[symbol])
      .map((symbol) => analyze(symbol, snapshots[symbol], config[symbol], kind))
      .sort((a, b) => b.score - a.score);
    if (allowAlerts) await alertSignals(results);
    return results;
  }

  async function runCore(force = false) {
    state.marketWindowOpen = marketWindowOpen();
    if (!force && !state.marketWindowOpen) return state.core;
    try {
      const wasPrimed = corePrimed;
      state.core = await runGroup(CORE, "commodity", wasPrimed);
      state.lastCoreScanAt = new Date().toISOString();
      state.lastError = null;
      if (!corePrimed) {
        primeSignals(state.core);
        corePrimed = true;
        console.log("777 commodity baseline primed; startup alerts suppressed");
      }
      const elevated = state.core.find((s) => s.priority === "HIGH" && OPTION_SYMBOLS.has(s.symbol));
      if (wasPrimed && elevated) await optionConfirmation(elevated.symbol);
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
      const wasPrimed = contextPrimed;
      state.context = await runGroup(CONTEXT, "extreme-context", wasPrimed);
      state.lastContextScanAt = new Date().toISOString();
      state.lastError = null;
      if (!contextPrimed) {
        primeSignals(state.context);
        contextPrimed = true;
        console.log("777 context baseline primed; startup alerts suppressed");
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
      return {
        symbol: clean,
        price: round(price, price < 20 ? 3 : 2),
        previousClose: round(previousClose, 2),
        percentChange: round(pct(price, previousClose), 2),
        source: "Alpaca IEX",
        time: trade?.t ?? trade?.timestamp ?? null
      };
    } catch (alpacaError) {
      if (!twelveKey) throw alpacaError;
      const t = timeoutSignal(8000);
      try {
        const response = await fetch(`https://api.twelvedata.com/quote?symbol=${encodeURIComponent(clean)}&apikey=${encodeURIComponent(twelveKey)}`, { signal: t.signal });
        const data = await response.json();
        if (!response.ok || data.status === "error" || data.code) throw new Error(data.message || `Twelve Data HTTP ${response.status}`);
        return {
          symbol: clean,
          price: num(data.close),
          previousClose: num(data.previous_close),
          percentChange: num(data.percent_change),
          source: "Twelve Data fallback",
          time: data.datetime || null
        };
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
    for (const timer of [a, b, coreTimer, contextTimer]) {
      if (typeof timer.unref === "function") timer.unref();
    }
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
      optionsMode: "indicative-confirmation-only",
      alpacaConfigured: alpacaConfigured()
    })
  };
}

module.exports = createMarketEngine;
