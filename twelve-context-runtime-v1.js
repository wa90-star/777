"use strict";
const { createHash } = require("node:crypto");
const { createTwelveBasicContext, DEFAULT_SYMBOLS } = require("./twelve-basic-context-v1");
const POLL_MS = 10000, EVENT_AGE_MS = 30 * 60000, CAPACITY = 100;
const SOURCE = "twelve-data-basic-partial-us-venues";
const validKey = key => typeof key === "string" && key.length >= 8 && key.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(key) && key !== "demo";
const count = n => Number.isSafeInteger(n) && n >= 0 ? n : 0;
function timestamp(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 && value <= 8640000000000000 ? value : null;
  if (typeof value !== "string" || value.length > 100 || !/(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)\s*$/i.test(value)) return null;
  const n = Date.parse(value); return Number.isFinite(n) ? n : null;
}
const iso = value => { const n = timestamp(value); return n === null ? null : new Date(n).toISOString(); };

// Only explicit asset identifiers and the company's unambiguous name/ticker are mapped.
// In particular, an oil/rates/dollar headline does not imply an ETF or a direction.
function eventSymbols(item, allowed) {
  const found = new Set();
  const add = value => {
    const symbol = typeof value === "string" ? value : value?.symbol;
    if (typeof symbol !== "string" || symbol.length > 20) return;
    const normalized = symbol.trim().toUpperCase();
    if (allowed.has(normalized)) found.add(normalized);
  };
  for (const field of ["affectedAssets", "relatedSymbols"]) {
    if (Array.isArray(item[field])) for (const value of item[field].slice(0, 50)) add(value);
  }
  for (const field of ["directionalBiases", "dirBias", "dirbias"]) {
    const value = item[field];
    if (value && typeof value === "object" && !Array.isArray(value)) for (const key of Object.keys(value).slice(0, 50)) add(key);
  }
  if (allowed.has("UUUU")) {
    for (const field of ["title", "headline", "summary", "description", "text"]) {
      if (typeof item[field] === "string" && /\b(?:UUUU|Energy\s+Fuels)\b/i.test(item[field].slice(0, 8192))) { found.add("UUUU"); break; }
    }
  }
  return [...found];
}

// Non-display processing only. There is deliberately no result getter, callback,
// sender, price route or logger. Event context is bounded RAM, not a durable queue.
function createTwelveContextRuntime({ enabled = false, apiKey, directory, providerFactory = createTwelveBasicContext,
  symbols = DEFAULT_SYMBOLS, now = Date.now, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
  const activeConfig = enabled === true, configured = validKey(apiKey);
  const validSymbols = Array.isArray(symbols) && symbols.length > 0 && symbols.length <= 50 &&
    new Set(symbols).size === symbols.length && symbols.every(s => typeof s === "string" && /^[A-Z][A-Z0-9.]{0,9}$/.test(s));
  const allowed = new Set(validSymbols ? symbols : []);
  const pending = new Map(), results = new Map();
  const events = { received: 0, accepted: 0, duplicates: 0, ignoredInactive: 0, ignoredBaseline: 0,
    ignoredNoSymbols: 0, rejected: 0, expired: 0, capacityDropped: 0, completed: 0, evaluations: 0, evaluationFailures: 0 };
  let provider = null, timer = null, running = false, flight = null, stopping = null, lastPollAt = null, lastError = null;
  let polls = 0, pollFailures = 0, overlapSkips = 0;
  function clock() {
    try { const at = now(); return typeof at === "number" && Number.isFinite(at) && at > 0 && at < 8640000000000000 ? at : null; }
    catch { return null; }
  }
  function trim(at) {
    for (const [id, event] of pending) if (at - event.at > EVENT_AGE_MS || at < event.at - 5000) { pending.delete(id); events.expired++; }
    for (const [id, result] of results) if (at - result.completedAt > EVENT_AGE_MS) results.delete(id);
  }
  function safeProviderStatus() {
    if (!provider) return null;
    try {
      const p = provider.publicStatus();
      // Project individual safe fields rather than spreading even a provider's public object.
      return { source: SOURCE, configured: configured && p?.configured === true, mode: "internal-non-display-context",
        executionEligible: false, rawDataPublic: false, privatePriceDisplayEnabled: false,
        marketScope: "US-listed-stocks-and-ETFs-partial-venues", holidayCalendarVerified: false,
        regularSessionWindow: p?.regularSessionWindow === true,
        configuredSymbols: count(p?.configuredSymbols), observedSymbols: count(p?.observedSymbols),
        freshSymbols: count(p?.freshSymbols), failedSymbols: count(p?.failedSymbols), latestObservationAt: iso(p?.latestObservationAt),
        quota: { scope: "this-persisted-adapter-only-other-account-users-not-counted", utcDay: typeof p?.quota?.utcDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.quota.utcDay) ? p.quota.utcDay : null,
          usedToday: count(p?.quota?.usedToday), dailyLimit: count(p?.quota?.dailyLimit), minuteLimit: count(p?.quota?.minuteLimit), cooldownUntil: iso(p?.quota?.cooldownUntil) },
        providerDocumentation: "https://twelvedata.com/pricing" };
    } catch { lastError = "provider_status_failed"; return null; }
  }
  function getState() {
    const providerStatus = safeProviderStatus();
    return { enabled: activeConfig, configured, running, stopping: stopping !== null, inFlight: flight !== null,
      mode: "internal-non-display-context", executionEligible: false, pollIntervalMs: POLL_MS, maxRequestsPerPoll: 1,
      polls, pollFailures, overlapSkips, lastPollAt: iso(lastPollAt), lastError,
      eventContext: { storage: "bounded-memory-reset-on-restart", resultsExposure: "none", capacity: CAPACITY,
        maxEventAgeMs: EVENT_AGE_MS, pending: pending.size, storedResults: results.size, countersScope: "runtime-instance", ...events },
      provider: providerStatus };
  }
  function observeEvents(items) {
    const at = clock();
    if (!Array.isArray(items) || at === null) { events.rejected++; return getState().eventContext; }
    trim(at);
    // A caller's unusually large batch must not cause unbounded parsing work.
    const batch = items.slice(0, 1000);
    events.received += items.length;
    if (items.length > batch.length) events.capacityDropped += items.length - batch.length;
    if (!activeConfig || !configured || !validSymbols) { events.ignoredInactive += batch.length; return getState().eventContext; }
    for (const item of batch) {
      try {
        if (!item || typeof item !== "object") { events.rejected++; continue; }
        if (item.baseline === true) { events.ignoredBaseline++; continue; }
        const rawId = item.id ?? item.eventId;
        if (typeof rawId !== "string" || !rawId.trim() || rawId.length > 2048) { events.rejected++; continue; }
        const sourceMissing = item.publishedAt === undefined || item.publishedAt === null || item.publishedAt === "";
        const eventAt = timestamp(sourceMissing ? item.detectedAt : item.publishedAt);
        if (eventAt === null || eventAt > at + 5000) { events.rejected++; continue; }
        if (at - eventAt > EVENT_AGE_MS) { events.expired++; continue; }
        const mapped = eventSymbols(item, allowed);
        if (!mapped.length) { events.ignoredNoSymbols++; continue; }
        // Distinct source-time revisions with the same event ID remain distinct observations.
        const id = createHash("sha256").update(rawId).update("\0").update(String(eventAt)).digest("hex");
        if (results.has(id)) {
          const existing = results.get(id), added = mapped.filter(symbol => !existing.symbols.has(symbol));
          if (added.length) {
            for (const symbol of added) existing.symbols.add(symbol);
            results.delete(id);
            if (pending.size >= CAPACITY) { pending.delete(pending.keys().next().value); events.capacityDropped++; }
            pending.set(id, existing);
          }
          events.duplicates++; continue;
        }
        if (pending.has(id)) {
          const existing = pending.get(id);
          for (const symbol of mapped) existing.symbols.add(symbol);
          events.duplicates++; continue;
        }
        if (pending.size >= CAPACITY) { pending.delete(pending.keys().next().value); events.capacityDropped++; }
        pending.set(id, { at: eventAt, timeBasis: sourceMissing ? "detectedAt-source-time-missing" : "publishedAt",
          symbols: new Set(mapped), reactions: new Map() });
        events.accepted++;
      } catch { events.rejected++; }
    }
    return getState().eventContext;
  }
  function evaluatePending(at) {
    trim(at);
    for (const [id, event] of pending) {
      for (const symbol of event.symbols) {
        if (event.reactions.has(symbol)) continue;
        try {
          events.evaluations++;
          const r = provider.evaluateReaction(symbol, { eventTime: event.at });
          if (r?.assessable !== true || r?.executionEligible !== false || r?.internalOnly !== true ||
              !Number.isFinite(r.movePercent) || !["up", "down", "unchanged"].includes(r.direction)) continue;
          event.reactions.set(symbol, { movePercent: r.movePercent, direction: r.direction,
            thresholdReached: r.thresholdReached === true, barMayBeIncomplete: r.barMayBeIncomplete === true,
            baselineAt: iso(r.baselineAt), observedAt: iso(r.observedAt), assessedAt: at, executionEligible: false });
        } catch { events.evaluationFailures++; lastError = "event_evaluation_failed"; }
      }
      if (event.reactions.size === event.symbols.size) {
        if (results.size >= CAPACITY) results.delete(results.keys().next().value);
        if (!Number.isFinite(event.completedAt)) events.completed++;
        results.set(id, { ...event, completedAt: at }); pending.delete(id);
      }
    }
  }
  function tick() {
    if (!running || !provider) return;
    if (flight) { overlapSkips++; return; }
    const at = clock();
    if (at === null) { lastError = "invalid_clock"; return; }
    lastPollAt = at; polls++;
    flight = Promise.resolve().then(async () => {
      if (!running || !provider) return;
      try {
        await provider.pollDue({ maxRequests: 1 });
        lastError = null;
        const completedAt = clock();
        if (running && completedAt !== null) evaluatePending(completedAt);
      } catch { pollFailures++; lastError = "provider_poll_failed"; }
    }).finally(() => { flight = null; });
  }
  function start() {
    if (running || stopping || !activeConfig || !configured) return getState();
    if (!validSymbols || typeof providerFactory !== "function") { lastError = "invalid_configuration"; return getState(); }
    try {
      provider = providerFactory({ directory, apiKey, symbols: [...symbols], now });
      if (!provider || ["pollDue", "evaluateReaction", "publicStatus", "close"].some(key => typeof provider[key] !== "function")) throw new Error("invalid_provider");
      running = true;
      timer = setIntervalImpl(tick, POLL_MS);
      timer?.unref?.();
      tick();
    } catch {
      running = false; lastError = "runtime_start_failed";
      if (timer !== null) { try { clearIntervalImpl(timer); } catch {} timer = null; }
      try { provider?.close?.(); } catch {} provider = null;
    }
    return getState();
  }
  function stop() {
    if (stopping) return stopping;
    running = false;
    if (timer !== null) { try { clearIntervalImpl(timer); } catch { lastError = "timer_stop_failed"; } timer = null; }
    const current = flight;
    stopping = Promise.resolve(current).catch(() => {}).then(() => {
      try { provider?.close(); } catch { lastError = "provider_close_failed"; }
      provider = null; pending.clear(); results.clear();
    }).finally(() => { stopping = null; });
    return stopping;
  }
  return { start, stop, getState, observeEvents };
}
module.exports = { createTwelveContextRuntime };
