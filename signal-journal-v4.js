const fs = require("fs");
const path = require("path");

const HORIZONS = {
  "30m": 30 * 60 * 1000,
  "2h": 2 * 60 * 60 * 1000
};
const MAX_ENTRIES = 1000;
const TRUSTED_MAX_DELAY_MS = 15 * 60 * 1000;

function round(value, digits = 2) {
  const p = 10 ** digits;
  return Math.round(Number(value || 0) * p) / p;
}

function safeTime(value) {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

function createSignalJournal({ quote }) {
  const entries = [];
  const timers = new Map();
  const preferredDir = process.env.RADAR_DATA_DIR || "/data";
  let storageDir = preferredDir;
  let storageFile = null;
  let persistenceMode = "memory-only";

  function log(event, payload) {
    console.log(`777 JOURNAL ${event} ${JSON.stringify(payload)}`);
  }

  function ensureStorage() {
    const candidates = [preferredDir, path.join("/tmp", "777-radar")];
    for (const dir of candidates) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, ".write-test");
        fs.writeFileSync(probe, "ok");
        fs.unlinkSync(probe);
        storageDir = dir;
        storageFile = path.join(dir, "signal-journal.json");
        persistenceMode = dir === preferredDir ? `persistent:${dir}` : `fallback:${dir}`;
        return;
      } catch (error) {
        log("STORAGE_UNAVAILABLE", { dir, error: error.message });
      }
    }
  }

  function persist() {
    if (!storageFile) return;
    try {
      const tmp = `${storageFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 2, savedAt: new Date().toISOString(), entries }, null, 2));
      fs.renameSync(tmp, storageFile);
    } catch (error) {
      log("PERSIST_ERROR", { error: error.message });
    }
  }

  function load() {
    if (!storageFile || !fs.existsSync(storageFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(storageFile, "utf8"));
      const loaded = Array.isArray(parsed) ? parsed : parsed.entries;
      if (!Array.isArray(loaded)) return;
      for (const raw of loaded.slice(0, MAX_ENTRIES)) {
        if (!raw?.id || !raw?.symbol || !raw?.direction || !safeTime(raw.createdAt)) continue;
        entries.push({
          ...raw,
          score: Number(raw.score || 0),
          entryPrice: Number(raw.entryPrice || 0),
          correlationCount: Number(raw.correlationCount || 0),
          confirmations: Array.isArray(raw.confirmations) ? raw.confirmations : [],
          mfePct: Number(raw.mfePct || 0),
          maePct: Number(raw.maePct || 0),
          checks: raw.checks && typeof raw.checks === "object" ? raw.checks : {}
        });
      }
      entries.sort((a, b) => safeTime(b.createdAt) - safeTime(a.createdAt));
      log("LOADED", { count: entries.length, persistence: persistenceMode });
    } catch (error) {
      log("LOAD_ERROR", { error: error.message });
    }
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

  function checkFromPrice(entry, horizon, price, source, observedAt = new Date().toISOString()) {
    if (entry.checks[horizon]) return false;
    const targetAt = safeTime(entry.createdAt) + HORIZONS[horizon];
    const observedMs = safeTime(observedAt) || Date.now();
    if (observedMs < targetAt) return false;

    const movePct = round(directionalMove(entry, price));
    const lateByMs = Math.max(0, observedMs - targetAt);
    entry.mfePct = round(Math.max(entry.mfePct, movePct));
    entry.maePct = round(Math.min(entry.maePct, movePct));
    entry.lastObservedPrice = price;
    entry.lastObservedAt = observedAt;
    entry.checks[horizon] = {
      checkedAt: observedAt,
      targetAt: new Date(targetAt).toISOString(),
      price,
      movePct,
      result: classify(movePct),
      source,
      lateByMinutes: round(lateByMs / 60000, 1),
      trusted: lateByMs <= TRUSTED_MAX_DELAY_MS
    };
    log(`CHECK_${horizon}`, { id: entry.id, symbol: entry.symbol, direction: entry.direction, ...entry.checks[horizon] });
    clearScheduled(entry.id, horizon);
    return true;
  }

  function timerKey(id, horizon) {
    return `${id}:${horizon}`;
  }

  function clearScheduled(id, horizon) {
    const key = timerKey(id, horizon);
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);
  }

  function scheduleCheck(id, horizon) {
    const entry = entries.find((x) => x.id === id);
    if (!entry || entry.checks[horizon]) return;
    const dueAt = safeTime(entry.createdAt) + HORIZONS[horizon];
    const delayMs = Math.max(3000, dueAt - Date.now());
    const key = timerKey(id, horizon);
    clearScheduled(id, horizon);
    const timer = setTimeout(() => evaluate(id, horizon), delayMs);
    if (typeof timer.unref === "function") timer.unref();
    timers.set(key, timer);
  }

  function schedulePending() {
    for (const entry of entries) {
      for (const horizon of Object.keys(HORIZONS)) scheduleCheck(entry.id, horizon);
    }
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
      score: Number(signal.score || 0),
      priority: signal.priority,
      percentChangeAtAlert: Number(signal.percentChange || 0),
      correlationCount: Number(correlation.count || 0),
      confirmations: Array.isArray(correlation.labels) ? correlation.labels : [],
      confirmationTypes: Array.isArray(correlation.confirmations) ? correlation.confirmations.map((x) => x.type) : [],
      mfePct: 0,
      maePct: 0,
      lastObservedPrice: Number(signal.price),
      lastObservedAt: createdAt,
      checks: {}
    };

    entries.unshift(entry);
    if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
    persist();
    log("ALERT", entry);
    scheduleCheck(entry.id, "30m");
    scheduleCheck(entry.id, "2h");
    return entry;
  }

  function observe(signals) {
    const now = new Date().toISOString();
    const bySymbol = new Map((signals || []).map((s) => [s.symbol, Number(s.price)]));
    let changed = false;

    for (const entry of entries) {
      if (entry.checks["2h"]) continue;
      const price = bySymbol.get(entry.symbol);
      if (!Number.isFinite(price) || price <= 0) continue;
      const move = directionalMove(entry, price);
      const nextMfe = round(Math.max(entry.mfePct, move));
      const nextMae = round(Math.min(entry.maePct, move));
      if (nextMfe !== entry.mfePct || nextMae !== entry.maePct || entry.lastObservedPrice !== price) changed = true;
      entry.mfePct = nextMfe;
      entry.maePct = nextMae;
      entry.lastObservedPrice = price;
      entry.lastObservedAt = now;

      if (checkFromPrice(entry, "30m", price, "core-scan", now)) changed = true;
      if (checkFromPrice(entry, "2h", price, "core-scan", now)) changed = true;
    }

    if (changed) persist();
  }

  async function evaluate(id, horizon) {
    const entry = entries.find((x) => x.id === id);
    if (!entry || entry.checks[horizon]) return;
    try {
      const q = await quote(entry.symbol);
      const price = Number(q.price);
      if (!Number.isFinite(price) || price <= 0) throw new Error("Invalid evaluation price");
      if (checkFromPrice(entry, horizon, price, q.source || "quote")) persist();
    } catch (error) {
      log(`CHECK_${horizon}_ERROR`, { id: entry.id, symbol: entry.symbol, error: error.message });
      clearScheduled(id, horizon);
      const retry = setTimeout(() => evaluate(id, horizon), 10 * 60 * 1000);
      if (typeof retry.unref === "function") retry.unref();
      timers.set(timerKey(id, horizon), retry);
    }
  }

  function completedTrusted() {
    return entries.filter((x) => x.checks?.["2h"]?.trusted);
  }

  function stats() {
    const completed = entries.filter((x) => x.checks["2h"]);
    const trusted = completedTrusted();
    const wins = trusted.filter((x) => x.checks["2h"].result === "WIN").length;
    const losses = trusted.filter((x) => x.checks["2h"].result === "LOSS").length;
    const flat = trusted.filter((x) => x.checks["2h"].result === "FLAT").length;
    const decisive = wins + losses;
    const avgMovePct = trusted.length
      ? round(trusted.reduce((sum, x) => sum + Number(x.checks["2h"].movePct || 0), 0) / trusted.length)
      : null;
    return {
      totalSignals: entries.length,
      completed2h: completed.length,
      trustedCompleted2h: trusted.length,
      wins,
      losses,
      flat,
      decisive,
      winRatePct: decisive ? round((wins / decisive) * 100, 1) : null,
      avgDirectionalMovePct: avgMovePct
    };
  }

  function groupedPerformance() {
    const trusted = completedTrusted();
    const groups = new Map();
    for (const entry of trusted) {
      const result = entry.checks["2h"].result;
      const keys = [`symbol:${entry.symbol}`, ...((entry.confirmationTypes || []).map((x) => `confirmation:${x}`))];
      for (const key of keys) {
        if (!groups.has(key)) groups.set(key, { key, count: 0, wins: 0, losses: 0, flat: 0, moveSum: 0 });
        const g = groups.get(key);
        g.count += 1;
        g.moveSum += Number(entry.checks["2h"].movePct || 0);
        if (result === "WIN") g.wins += 1;
        else if (result === "LOSS") g.losses += 1;
        else g.flat += 1;
      }
    }
    return [...groups.values()].map((g) => {
      const decisive = g.wins + g.losses;
      return {
        key: g.key,
        count: g.count,
        wins: g.wins,
        losses: g.losses,
        flat: g.flat,
        winRatePct: decisive ? round((g.wins / decisive) * 100, 1) : null,
        avgDirectionalMovePct: g.count ? round(g.moveSum / g.count) : null
      };
    }).sort((a, b) => b.count - a.count);
  }

  function calibration() {
    const s = stats();
    const minimumDecisive = 20;
    if (s.decisive < minimumDecisive) {
      return {
        status: "collecting",
        decisiveSamples: s.decisive,
        minimumDecisive,
        action: "no-auto-tuning"
      };
    }
    let recommendation = "keep-thresholds";
    if (s.winRatePct < 45) recommendation = "tighten-thresholds";
    else if (s.winRatePct >= 65 && Number(s.avgDirectionalMovePct || 0) > 0.5) recommendation = "quality-strong-review-expansion";
    return {
      status: "review-ready",
      decisiveSamples: s.decisive,
      minimumDecisive,
      recommendation,
      action: "manual-review-before-change"
    };
  }

  function recentAlertFor(symbol, direction, maxAgeMs = 60 * 60 * 1000) {
    const now = Date.now();
    return entries.find((x) =>
      x.symbol === symbol &&
      x.direction === direction &&
      now - safeTime(x.createdAt) <= maxAgeMs
    ) || null;
  }

  ensureStorage();
  load();
  schedulePending();

  return {
    record,
    observe,
    recentAlertFor,
    getState: () => ({
      entries: entries.slice(0, 100),
      stats: stats(),
      performance: groupedPerformance(),
      calibration: calibration(),
      horizons: Object.keys(HORIZONS),
      persistence: persistenceMode,
      storageFile
    })
  };
}

module.exports = createSignalJournal;
