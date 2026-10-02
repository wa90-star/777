const { executionQuality } = require("./decision-engine-v5");
const { _test: structuralTest } = require("./structural-intelligence-v1");

const WATCHLIST = structuralTest.parseWatchlist();
const SCAN_INTERVAL_MS = 10 * 60 * 1000;
const STRUCTURAL_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_THRESHOLDS = Object.freeze({ day: 2.5, velocity: 0.8 });
const EQUITY_CONFIG = Object.freeze({
  UUUU: { name: "Energy Fuels", day: 3.0, velocity: 1.0 },
  MU: { name: "Micron Technology", day: 2.5, velocity: 0.8 },
  MP: { name: "MP Materials", day: 3.0, velocity: 1.0 },
  INTC: { name: "Intel", day: 2.5, velocity: 0.8 }
});

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  if (typeof timer.unref === "function") timer.unref();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function pct(a, b) {
  return b ? ((a - b) / b) * 100 : 0;
}

function round(value, digits = 2) {
  const power = 10 ** digits;
  return Math.round(Number(value || 0) * power) / power;
}

function pick(snapshot, camel, snake) {
  return snapshot?.[camel] || snapshot?.[snake] || null;
}

function safeTime(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function marketPhaseAt(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(date);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  if (weekday === "Sat" || weekday === "Sun") return "closed";
  const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value || 0);
  const minutes = hour * 60 + minute;
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return "regular";
  if (minutes >= 7 * 60 && minutes < 9 * 60 + 30) return "premarket";
  if (minutes >= 16 * 60 && minutes <= 20 * 60) return "afterhours";
  return "closed";
}

function directionConfirmed(direction, dayPct, velocityPct, config) {
  const sign = direction === "LONG" ? 1 : direction === "SHORT" ? -1 : 0;
  if (!sign) return false;
  return sign * dayPct >= config.day || sign * velocityPct >= config.velocity;
}

function createEquityStructuralEngine({
  sendMessage,
  telegramConfigured,
  getStructuralState = () => ({ verified: [] }),
  recentSignalAlert = () => null,
  onSignalAlert,
  onAlert
}) {
  const alpacaKey = process.env.APCA_API_KEY_ID;
  const alpacaSecret = process.env.APCA_API_SECRET_KEY;
  const twelveKey = process.env.TWELVE;
  const previous = new Map();
  const alertState = new Map();
  let primed = false;

  const state = {
    watchlist: WATCHLIST,
    signals: [],
    lastScanAt: null,
    lastError: null,
    marketWindowOpen: false,
    source: "alpaca-iex"
  };

  function alpacaConfigured() {
    return Boolean(alpacaKey && alpacaSecret);
  }

  async function alpacaJson(url, timeout = 9000) {
    if (!alpacaConfigured()) throw new Error("Alpaca market data is not configured");
    const timing = timeoutSignal(timeout);
    try {
      const response = await fetch(url, {
        headers: {
          "APCA-API-KEY-ID": alpacaKey,
          "APCA-API-SECRET-KEY": alpacaSecret,
          "User-Agent": "777-signal-radar/5.3 structural-equity"
        },
        signal: timing.signal
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.message || ("Alpaca HTTP " + response.status));
      return data;
    } finally {
      timing.clear();
    }
  }

  async function twelveSnapshot(symbol) {
    if (!twelveKey) return null;
    const timing = timeoutSignal(10000);
    try {
      const url = "https://api.twelvedata.com/quote?symbol=" + encodeURIComponent(symbol) +
        "&apikey=" + encodeURIComponent(twelveKey);
      const response = await fetch(url, { signal: timing.signal });
      const data = await response.json();
      if (!response.ok || data.status === "error" || data.code) {
        throw new Error(data.message || ("Twelve Data HTTP " + response.status));
      }
      const price = num(data.close);
      const previousClose = num(data.previous_close);
      if (!price || !previousClose) throw new Error("Incomplete Twelve Data quote for " + symbol);
      return [symbol, {
        __source: "Twelve Data fallback",
        latestTrade: { p: price, t: data.datetime || new Date().toISOString() },
        dailyBar: { c: price, h: num(data.high) || price, l: num(data.low) || price },
        prevDailyBar: { c: previousClose }
      }];
    } catch (error) {
      console.error("777 structural equity Twelve fallback failed for " + symbol + ":", error.message);
      return null;
    } finally {
      timing.clear();
    }
  }

  async function fetchSnapshots(symbols) {
    const params = new URLSearchParams({ symbols: symbols.join(","), feed: "iex", currency: "USD" });
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const data = await alpacaJson("https://data.alpaca.markets/v2/stocks/snapshots?" + params.toString(), 12000);
        return data.snapshots || data;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await delay(750 * (2 ** (attempt - 1)));
      }
    }
    if (!twelveKey) throw lastError;
    console.warn("777 structural equity Alpaca retries exhausted; using Twelve Data fallback:", lastError.message);
    const rows = await Promise.all(symbols.map(twelveSnapshot));
    const snapshots = Object.fromEntries(rows.filter(Boolean));
    if (!Object.keys(snapshots).length) throw lastError;
    return snapshots;
  }

  function configFor(symbol) {
    return EQUITY_CONFIG[symbol] || { name: symbol, ...DEFAULT_THRESHOLDS };
  }

  function recentStructural(symbol) {
    return (getStructuralState()?.verified || [])
      .filter((item) => !item.baseline && item.verifiedAt)
      .filter((item) => Date.now() - safeTime(item.verifiedAt) <= STRUCTURAL_MAX_AGE_MS)
      .filter((item) => item.directionalBiases?.[symbol] === "LONG" || item.directionalBiases?.[symbol] === "SHORT")
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))[0] || null;
  }

  function analyze(symbol, snapshot) {
    const config = configFor(symbol);
    const structural = recentStructural(symbol);
    const latestTrade = pick(snapshot, "latestTrade", "latest_trade");
    const latestQuote = pick(snapshot, "latestQuote", "latest_quote");
    const daily = pick(snapshot, "dailyBar", "daily_bar") || {};
    const previousDaily = pick(snapshot, "prevDailyBar", "previous_daily_bar") ||
      pick(snapshot, "previousDailyBar", "previous_daily_bar") || {};
    const bid = num(latestQuote?.bp ?? latestQuote?.bid_price);
    const ask = num(latestQuote?.ap ?? latestQuote?.ask_price);
    const quoteTime = latestQuote?.t ?? latestQuote?.timestamp ?? null;
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
    const price = num(latestTrade?.p ?? latestTrade?.price) || num(daily.c ?? daily.close) || mid;
    const previousClose = num(previousDaily.c ?? previousDaily.close);
    const dayPct = pct(price, previousClose);
    const prior = previous.get(symbol);
    const velocityPct = prior?.price ? pct(price, prior.price) : 0;
    const velocityMinutes = prior?.time ? Math.max((Date.now() - prior.time) / 60000, 0) : null;
    previous.set(symbol, { price, time: Date.now() });

    const direction = structural?.directionalBiases?.[symbol] || "KEIN SIGNAL";
    const marketConfirmed = structural ? directionConfirmed(direction, dayPct, velocityPct, config) : false;
    const execution = direction === "KEIN SIGNAL"
      ? { plausible: false, failures: ["NO_DIRECTION"], reference: null, spreadPct: null, ageMs: null, phase: marketPhaseAt() }
      : executionQuality({ bid, ask, last: price, quoteTime, phase: marketPhaseAt(), direction }, Date.now());

    const signedDay = direction === "LONG" ? dayPct : direction === "SHORT" ? -dayPct : 0;
    const signedVelocity = direction === "LONG" ? velocityPct : direction === "SHORT" ? -velocityPct : 0;
    const dayProgress = config.day ? Math.max(0, signedDay / config.day) : 0;
    const velocityProgress = config.velocity ? Math.max(0, signedVelocity / config.velocity) : 0;
    const marketScore = Math.round(Math.min(100, Math.max(dayProgress, velocityProgress) * 70));
    const structuralScore = Number(structural?.score || 0);
    const score = structural ? Math.round(Math.min(100, structuralScore * 0.55 + marketScore * 0.45)) : 0;

    return {
      symbol,
      name: config.name,
      kind: "equity-structural",
      price: round(price, price < 20 ? 3 : 2),
      previousClose: round(previousClose, 2),
      percentChange: round(dayPct, 2),
      velocityPct: round(velocityPct, 2),
      velocityMinutes: velocityMinutes == null ? null : round(velocityMinutes, 1),
      marketTime: latestTrade?.t ?? latestTrade?.timestamp ?? daily.t ?? daily.timestamp ?? null,
      quoteTime,
      direction,
      structuralConfirmed: Boolean(structural),
      marketConfirmed,
      score,
      source: snapshot.__source || "Alpaca IEX",
      executionQuality: {
        plausible: execution.plausible,
        failures: execution.failures,
        spreadPct: execution.spreadPct,
        ageMs: execution.ageMs,
        phase: execution.phase,
        reference: execution.reference
      },
      structural: structural ? {
        id: structural.id,
        title: structural.title,
        theme: structural.theme,
        score: structural.score,
        verifiedAt: structural.verifiedAt,
        independentSourceCount: structural.independentSourceCount,
        sourcePublishers: structural.sourcePublishers,
        mechanism: structural.directionalHypotheses?.[symbol]?.mechanism || null
      } : null
    };
  }

  function signalKey(signal) {
    return signal.symbol + ":" + signal.direction;
  }

  function priorAlertFor(signal) {
    const memory = alertState.get(signalKey(signal));
    const durable = recentSignalAlert(signal.symbol, signal.direction, ALERT_COOLDOWN_MS);
    if (!durable) return memory || null;
    const normalized = {
      sentAt: safeTime(durable.createdAt),
      score: Number(durable.score || 0),
      independentSourceCount: Number(durable.correlationCount || 2)
    };
    if (!memory) return normalized;
    return memory.sentAt >= normalized.sentAt ? memory : normalized;
  }

  function shouldAlert(signal) {
    if (!signal.structuralConfirmed || !signal.marketConfirmed) return false;
    if (!signal.executionQuality?.plausible) return false;
    if (signal.direction !== "LONG" && signal.direction !== "SHORT") return false;
    const prior = priorAlertFor(signal);
    if (!prior) return true;
    if (Number(signal.structural?.independentSourceCount || 0) > Number(prior.independentSourceCount || 0)) return true;
    if (signal.score >= Number(prior.score || 0) + 15) return true;
    return Date.now() - Number(prior.sentAt || 0) >= ALERT_COOLDOWN_MS;
  }

  function alertText(signal) {
    const sign = signal.percentChange >= 0 ? "+" : "";
    const velocity = signal.velocityMinutes == null
      ? "noch keine Vergleichsmessung"
      : (signal.velocityPct >= 0 ? "+" : "") + signal.velocityPct.toFixed(2) + "% / " + signal.velocityMinutes + " min";
    return [
      "777 KORRELIERTES AKTIEN-SIGNAL",
      "",
      signal.direction + " " + signal.name + " (" + signal.symbol + ")",
      "Preis: " + signal.price,
      "Tagesbewegung: " + sign + signal.percentChange.toFixed(2) + "%",
      "Kurzfristig: " + velocity,
      "Score: " + signal.score + "/100",
      "Unabhängige Evidenzgruppen: 2/2",
      "• Strukturelles Ereignis · " + (signal.structural?.independentSourceCount || 0) + " unabhängige Publisher",
      "• Kursreaktion bestätigt Richtung",
      signal.structural?.mechanism ? "Mechanismus: " + signal.structural.mechanism : null,
      signal.structural?.title ? "Ereignis: " + signal.structural.title : null,
      signal.structural?.sourcePublishers?.length ? "Quellen: " + signal.structural.sourcePublishers.join(", ") : null,
      "Quelle Preis: " + signal.source
    ].filter(Boolean).join("\n");
  }

  async function alertSignals(signals) {
    if (!telegramConfigured()) return;
    for (const signal of signals.filter(shouldAlert).sort((a, b) => b.score - a.score)) {
      try {
        const result = await sendMessage(alertText(signal));
        if (result?.suppressed) continue;
        const sentAt = Date.now();
        alertState.set(signalKey(signal), {
          sentAt,
          score: signal.score,
          independentSourceCount: signal.structural?.independentSourceCount || 2
        });
        onAlert?.(new Date(sentAt).toISOString());
        onSignalAlert?.({
          signal: { ...signal, priority: "HIGH", extreme: false },
          correlation: {
            count: 2,
            required: 2,
            qualified: true,
            extremeOverride: false,
            labels: ["verified structural event", "directional price confirmation"],
            independentGroups: ["fundamental-structural", "market-price"],
            confirmations: [
              { type: "structural", independenceGroup: "fundamental-structural", label: "verified structural event" },
              { type: "price", independenceGroup: "market-price", label: "directional price confirmation" }
            ]
          }
        });
      } catch (error) {
        console.error("777 structural equity alert failed:", error.message);
      }
    }
  }

  async function run(force = false) {
    state.marketWindowOpen = marketPhaseAt() !== "closed";
    if (!force && !state.marketWindowOpen) return state.signals;
    if (!WATCHLIST.length) return state.signals;
    try {
      const snapshots = await fetchSnapshots(WATCHLIST);
      state.signals = WATCHLIST
        .filter((symbol) => snapshots?.[symbol])
        .map((symbol) => analyze(symbol, snapshots[symbol]))
        .sort((a, b) => b.score - a.score);
      state.lastScanAt = new Date().toISOString();
      state.lastError = null;
      if (!primed) {
        primed = true;
        console.log("777 structural equity baseline primed: " + WATCHLIST.join(", "));
      } else {
        await alertSignals(state.signals);
      }
      return state.signals;
    } catch (error) {
      state.lastError = error.message;
      console.error("777 structural equity scan error:", error.message);
      return state.signals;
    }
  }

  function start() {
    const first = setTimeout(() => run().catch((error) => console.error("777 structural equity initial scan failed:", error.message)), 20000);
    const timer = setInterval(() => run().catch((error) => console.error("777 structural equity scan failed:", error.message)), SCAN_INTERVAL_MS);
    if (typeof first.unref === "function") first.unref();
    if (typeof timer.unref === "function") timer.unref();
  }

  return {
    start,
    run,
    marketWindowOpen: () => marketPhaseAt() !== "closed",
    getState: () => ({
      ...state,
      scanIntervalMinutes: SCAN_INTERVAL_MS / 60000,
      structuralMaxAgeHours: STRUCTURAL_MAX_AGE_MS / 3600000,
      alertCooldownHours: ALERT_COOLDOWN_MS / 3600000,
      alpacaConfigured: alpacaConfigured(),
      evidenceRule: "verified structural event + same-direction market confirmation + execution-quality gate"
    })
  };
}

module.exports = createEquityStructuralEngine;
module.exports._test = { directionConfirmed, marketPhaseAt };
