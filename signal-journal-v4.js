function round(value, digits = 2) {
  const p = 10 ** digits;
  return Math.round(Number(value || 0) * p) / p;
}

function createSignalJournal({ quote }) {
  const entries = [];
  const MAX_ENTRIES = 200;

  function log(event, payload) {
    console.log(`777 JOURNAL ${event} ${JSON.stringify(payload)}`);
  }

  function directionalMove(entry, price) {
    const raw = entry.entryPrice ? ((price - entry.entryPrice) / entry.entryPrice) * 100 : 0;
    return entry.direction === "SHORT" ? -raw : raw;
  }

  function classify(movePct) {
    if (movePct >= 0.25) return "WIN";
    if (movePct <= -0.25) return "LOSS";
    return "FLAT";
  }

  function scheduleCheck(id, horizon, delayMs) {
    const timer = setTimeout(() => evaluate(id, horizon), delayMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  function record({ signal, correlation }) {
    const createdAt = new Date().toISOString();
    const entry = {
      id: `${signal.symbol}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      createdAt,
      symbol: signal.symbol,
      name: signal.name,
      direction: signal.direction,
      entryPrice: Number(signal.price),
      score: signal.score,
      priority: signal.priority,
      percentChangeAtAlert: signal.percentChange,
      correlationCount: correlation.count,
      confirmations: correlation.labels,
      mfePct: 0,
      maePct: 0,
      lastObservedPrice: Number(signal.price),
      lastObservedAt: createdAt,
      checks: {}
    };

    entries.unshift(entry);
    if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
    log("ALERT", entry);
    scheduleCheck(entry.id, "30m", 30 * 60 * 1000);
    scheduleCheck(entry.id, "2h", 2 * 60 * 60 * 1000);
    return entry;
  }

  function observe(signals) {
    const now = new Date().toISOString();
    const bySymbol = new Map((signals || []).map((s) => [s.symbol, Number(s.price)]));
    for (const entry of entries) {
      if (entry.checks["2h"]) continue;
      const price = bySymbol.get(entry.symbol);
      if (!Number.isFinite(price) || price <= 0) continue;
      const move = directionalMove(entry, price);
      entry.mfePct = round(Math.max(entry.mfePct, move));
      entry.maePct = round(Math.min(entry.maePct, move));
      entry.lastObservedPrice = price;
      entry.lastObservedAt = now;
    }
  }

  async function evaluate(id, horizon) {
    const entry = entries.find((x) => x.id === id);
    if (!entry || entry.checks[horizon]) return;
    try {
      const q = await quote(entry.symbol);
      const price = Number(q.price);
      const movePct = round(directionalMove(entry, price));
      entry.mfePct = round(Math.max(entry.mfePct, movePct));
      entry.maePct = round(Math.min(entry.maePct, movePct));
      entry.lastObservedPrice = price;
      entry.lastObservedAt = new Date().toISOString();
      entry.checks[horizon] = {
        checkedAt: entry.lastObservedAt,
        price,
        movePct,
        result: classify(movePct)
      };
      log(`CHECK_${horizon}`, { id: entry.id, symbol: entry.symbol, direction: entry.direction, ...entry.checks[horizon] });
    } catch (error) {
      log(`CHECK_${horizon}_ERROR`, { id: entry.id, symbol: entry.symbol, error: error.message });
      const retry = setTimeout(() => evaluate(id, horizon), 10 * 60 * 1000);
      if (typeof retry.unref === "function") retry.unref();
    }
  }

  function stats() {
    const completed = entries.filter((x) => x.checks["2h"]);
    const wins = completed.filter((x) => x.checks["2h"].result === "WIN").length;
    const losses = completed.filter((x) => x.checks["2h"].result === "LOSS").length;
    const flat = completed.filter((x) => x.checks["2h"].result === "FLAT").length;
    const decisive = wins + losses;
    return {
      totalSignals: entries.length,
      completed2h: completed.length,
      wins,
      losses,
      flat,
      winRatePct: decisive ? round((wins / decisive) * 100, 1) : null
    };
  }

  return {
    record,
    observe,
    getState: () => ({
      entries: entries.slice(0, 50),
      stats: stats(),
      horizons: ["30m", "2h"],
      persistence: "runtime + Railway logs"
    })
  };
}

module.exports = createSignalJournal;
