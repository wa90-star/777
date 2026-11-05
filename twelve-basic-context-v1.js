"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const MINUTE = 60000, DAY = 86400000;
const DEFAULT_SYMBOLS = Object.freeze(["UUUU", "SPY", "GLD", "SLV", "USO", "UNG", "COPX", "DBA", "QQQ", "TLT", "UUP", "MU", "NVDA", "AMD"]);
const SOURCE = "twelve-data-basic-partial-us-venues";
const NY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hourCycle: "h23", hour: "2-digit", minute: "2-digit" });

function session(at) {
  const p = Object.fromEntries(NY.formatToParts(new Date(at)).map(x => [x.type, x.value]));
  const minute = +p.hour * 60 + +p.minute;
  return { date: `${p.year}-${p.month}-${p.day}`, open: !["Sat", "Sun"].includes(p.weekday) && minute >= 570 && minute < 960 };
}
function barTime(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d \d\d:\d\d:00$/.test(value)) return null;
  const iso = value.replace(" ", "T") + ".000Z", n = Date.parse(iso);
  return Number.isFinite(n) && new Date(n).toISOString() === iso ? n : null;
}
function positive(value) {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(String(value))) return null;
  const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null;
}
function parseObservation(data, symbol, now) {
  const m = data?.meta;
  if (data?.status !== "ok" || m?.symbol !== symbol || m?.interval !== "1min" || m?.currency !== "USD" ||
      !["Common Stock", "ETF"].includes(m?.type) || typeof m?.exchange !== "string" || !m.exchange ||
      !Array.isArray(data.values) || !data.values.length || data.values.length > 2) throw new Error("invalid_data");
  // datetime belongs to the requested UTC minute bar, never to receipt time or a daily quote opening.
  const bars = data.values.map(v => ({ at: barTime(v.datetime), price: positive(v.close) }));
  if (bars.some(v => v.at === null || v.price === null || v.at > now + 5000) ||
      bars.some((v, i) => i && v.at >= bars[i - 1].at)) throw new Error("invalid_data");
  const v = bars[0];
  return { symbol, price: v.price, currency: "USD", observedAt: v.at, receivedAt: now,
    source: SOURCE, timestampMeaning: "one-minute-bar-open-UTC", barMayBeIncomplete: now < v.at + MINUTE,
    venueCoverage: "partial-US-venues-about-5-percent-volume", exchange: m.exchange,
    executionEligible: false, internalOnly: true };
}
function validKey(key) { return typeof key === "string" && key.length >= 8 && key.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(key) && key !== "demo"; }
function safeFailure(code) { return Object.assign(new Error(code), { safeCode: code }); }

// A context provider only: no timer, order placement, message sender or public price endpoint.
function createTwelveBasicContext({ directory, apiKey, symbols = DEFAULT_SYMBOLS, fetchImpl = globalThis.fetch, now = Date.now,
  dailyLimit = 600, minuteLimit = 6, maxAgeMs = 3 * MINUTE } = {}) {
  if (!path.isAbsolute(directory || "") || !Array.isArray(symbols) || !symbols.length || symbols.length > 50 ||
      new Set(symbols).size !== symbols.length || symbols.some(s => !/^[A-Z][A-Z0-9.]{0,9}$/.test(s))) throw new Error("invalid_configuration");
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 600 || !Number.isInteger(minuteLimit) || minuteLimit < 1 || minuteLimit > 6 ||
      !Number.isFinite(maxAgeMs) || maxAgeMs < MINUTE || maxAgeMs > 5 * MINUTE) throw new Error("invalid_configuration");
  const configured = validKey(apiKey), allowed = new Set(symbols), observations = new Map(), previous = new Map(), outcomes = new Map();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "twelve-basic-quota.sqlite");
  if (fs.lstatSync(directory).isSymbolicLink() || (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())) throw new Error("unsafe_state_path");
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS calls(at INTEGER NOT NULL, symbol TEXT NOT NULL); CREATE INDEX IF NOT EXISTS calls_at ON calls(at); CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, value INTEGER NOT NULL);");
    fs.chmodSync(file, 0o600);
  } catch { db.close(); throw new Error("quota_storage_failed"); }
  let closed = false, pending = Promise.resolve(), running = 0;
  const getSetting = k => Number(db.prepare("SELECT value FROM settings WHERE k=?").get(k)?.value || 0);
  const setSetting = (k,v) => db.prepare("INSERT INTO settings(k,value) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET value=excluded.value").run(k,v);
  const interval = s => ["UUUU", "SPY"].includes(s) ? 5 * MINUTE : 15 * MINUTE;
  function checkOpen() { if (closed) throw new Error("provider_closed"); }
  function reserve(symbol, at) {
    checkOpen(); db.exec("BEGIN IMMEDIATE");
    try {
      const priorClock = getSetting("clock");
      if (at < priorClock) { db.exec("ROLLBACK"); return "clock_regressed"; }
      setSetting("clock", at);
      db.prepare("DELETE FROM calls WHERE at<?").run(Math.floor(at / DAY) * DAY - DAY);
      const last = Number(db.prepare("SELECT MAX(at) AS value FROM calls WHERE symbol=?").get(symbol)?.value || 0);
      const day = Number(db.prepare("SELECT COUNT(*) AS n FROM calls WHERE at>=?").get(Math.floor(at / DAY) * DAY).n);
      const minute = Number(db.prepare("SELECT COUNT(*) AS n FROM calls WHERE at>?").get(at - MINUTE).n);
      const reason = at < getSetting("cooldown") ? "provider_cooldown" : day >= dailyLimit ? "daily_budget" :
        minute >= minuteLimit ? "minute_budget" : at - last < interval(symbol) ? "cached_or_poll_interval" : null;
      if (!reason) db.prepare("INSERT INTO calls(at,symbol) VALUES(?,?)").run(at,symbol);
      db.exec("COMMIT"); return reason;
    } catch { try { db.exec("ROLLBACK"); } catch {} throw safeFailure("quota_storage_failed"); }
  }
  function postpone(response, at, code) {
    const h = response?.headers?.get("retry-after");
    const suggested = h && /^\d+$/.test(h) ? at + Number(h) * 1000 : h ? Date.parse(h) : NaN;
    // Never shorten a provider's valid Retry-After, including multi-day throttling.
    const excessiveNumeric = h && /^\d+$/.test(h) && !Number.isFinite(suggested);
    const until = code === "authentication_failed" ? at + DAY : excessiveNumeric ? 8640000000000000 : Number.isFinite(suggested) ?
      Math.max(at + 61 * 1000, Math.min(suggested, 8640000000000000)) : at + 15 * MINUTE;
    setSetting("cooldown", Math.max(getSetting("cooldown"), until));
  }
  async function request(symbol) {
    checkOpen(); const at = now();
    if (!configured) return { symbol, status: "not_configured", executionEligible: false };
    if (!allowed.has(symbol)) return { symbol, status: "symbol_not_allowed", executionEligible: false };
    if (!session(at).open) return { symbol, status: "outside_regular_session", executionEligible: false };
    let response;
    try {
      const denied = reserve(symbol, at);
      if (denied) return { symbol, status: denied, executionEligible: false };
      const params = new URLSearchParams({ symbol, country: "United States", interval: "1min", timezone: "UTC", outputsize: "2", order: "desc", prepost: "false", format: "JSON" });
      response = await fetchImpl(`https://api.twelvedata.com/time_series?${params}`, {
        headers: { Authorization: `apikey ${apiKey}`, Accept: "application/json", "User-Agent": "777-radar/5.3-personal-context" },
        redirect: "error", signal: AbortSignal.timeout(15000)
      });
      if (response.status === 429) { postpone(response, now(), "rate_limited"); throw safeFailure("rate_limited"); }
      if (response.status === 503 && response.headers.get("retry-after")) { postpone(response, now(), "provider_unavailable"); throw safeFailure("provider_unavailable"); }
      if ([401,403].includes(response.status)) { postpone(response, now(), "authentication_failed"); throw safeFailure("authentication_failed"); }
      if (!response.ok || response.redirected) throw safeFailure("provider_http_error");
      if (Number(response.headers.get("content-length")) > 65536) throw safeFailure("response_too_large");
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) { bytes += chunk.byteLength; if (bytes > 65536) throw safeFailure("response_too_large"); chunks.push(Buffer.from(chunk)); }
      let data; try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw safeFailure("invalid_data"); }
      if (Number(data?.code) === 429) { postpone(response, now(), "rate_limited"); throw safeFailure("rate_limited"); }
      if ([401,403].includes(Number(data?.code))) { postpone(response, now(), "authentication_failed"); throw safeFailure("authentication_failed"); }
      let value; try { value = parseObservation(data, symbol, now()); } catch { throw safeFailure("invalid_data"); }
      const old = observations.get(symbol);
      if (old && value.observedAt < old.observedAt) throw safeFailure("observation_regressed");
      if (old && value.observedAt > old.observedAt) previous.set(symbol, old);
      observations.set(symbol, value); outcomes.set(symbol, "ok");
      return { symbol, status: now() - value.observedAt <= maxAgeMs ? "fresh" : "stale", executionEligible: false };
    } catch (error) {
      try { await response?.body?.cancel(); } catch {}
      const code = error.safeCode || "provider_request_failed"; outcomes.set(symbol, code);
      return { symbol, status: code, executionEligible: false };
    }
  }
  function refresh(symbol) {
    if (closed) return Promise.reject(new Error("provider_closed"));
    running++;
    const job = pending.then(() => request(symbol)).finally(() => { running--; });
    pending = job.catch(() => {});
    return job;
  }
  async function pollDue({ maxRequests = 6 } = {}) {
    checkOpen();
    if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 6) throw new Error("invalid_poll_limit");
    const ordered = [...symbols].sort((a,b) => {
      const last = s => Number(db.prepare("SELECT MAX(at) AS v FROM calls WHERE symbol=?").get(s)?.v || 0);
      return (last(a) + interval(a)) - (last(b) + interval(b));
    });
    const result = [];
    // Skips do not spend this run's request allowance; persisted rate limits remain authoritative.
    for (const symbol of ordered) {
      if (result.filter(r => !["cached_or_poll_interval", "outside_regular_session", "not_configured"].includes(r.status)).length >= maxRequests) break;
      const r = await refresh(symbol); result.push(r);
      if (["daily_budget", "minute_budget", "provider_cooldown", "quota_storage_failed", "clock_regressed"].includes(r.status)) break;
    }
    return { source: SOURCE, results: result, executionEligible: false };
  }
  function readInternal(symbol) {
    checkOpen(); const v = observations.get(symbol); if (!v) return null;
    const at = now(), ageMs = at - v.observedAt;
    const fresh = ageMs >= -5000 && ageMs <= maxAgeMs && session(at).open && session(v.observedAt).open && session(at).date === session(v.observedAt).date;
    return { ...v, ageMs, fresh, currentFetchSucceeded: outcomes.get(symbol) === "ok", lastOutcome: outcomes.get(symbol) || null, executionEligible: false };
  }
  function evaluateReaction(symbol, { eventTime, minimumMovePercent = 0.5 } = {}) {
    const latest = readInternal(symbol), baseline = previous.get(symbol), at = typeof eventTime === "number" ? eventTime : Date.parse(eventTime);
    const result = { source: SOURCE, internalOnly: true, executionEligible: false, assessable: false, reason: "insufficient_fresh_bracketing_observations" };
    if (!latest?.fresh || !latest.currentFetchSucceeded || !baseline || !Number.isFinite(at) || !Number.isFinite(minimumMovePercent) || minimumMovePercent <= 0 ||
      baseline.observedAt + MINUTE > at || latest.observedAt < at || latest.observedAt - baseline.observedAt > 30 * MINUTE ||
      !session(baseline.observedAt).open || !session(at).open || session(baseline.observedAt).date !== session(latest.observedAt).date) return result;
    const movePercent = (latest.price / baseline.price - 1) * 100;
    return { ...result, assessable: true, reason: "partial_venue_observation_only", movePercent,
      thresholdReached: Math.abs(movePercent) >= minimumMovePercent, barMayBeIncomplete: latest.barMayBeIncomplete,
      direction: movePercent > 0 ? "up" : movePercent < 0 ? "down" : "unchanged",
      baselineAt: new Date(baseline.observedAt).toISOString(), observedAt: new Date(latest.observedAt).toISOString() };
  }
  function publicStatus() {
    checkOpen(); const at = now(), values = [...observations.keys()].map(readInternal);
    return { source: SOURCE, configured, mode: "internal-non-display-context", executionEligible: false,
      rawDataPublic: false, privatePriceDisplayEnabled: false, marketScope: "US-listed-stocks-and-ETFs-partial-venues", regularSessionWindow: session(at).open,
      holidayCalendarVerified: false, configuredSymbols: symbols.length, observedSymbols: values.length, freshSymbols: values.filter(v => v.fresh).length,
      failedSymbols: [...outcomes.values()].filter(v => v !== "ok").length, latestObservationAt: values.length ? new Date(Math.max(...values.map(v=>v.observedAt))).toISOString() : null,
      quota: { scope: "this-persisted-adapter-only-other-account-users-not-counted", utcDay: new Date(at).toISOString().slice(0,10), usedToday: Number(db.prepare("SELECT COUNT(*) AS n FROM calls WHERE at>=?").get(Math.floor(at/DAY)*DAY).n),
        dailyLimit, minuteLimit, cooldownUntil: getSetting("cooldown") > at ? new Date(getSetting("cooldown")).toISOString() : null },
      providerDocumentation: "https://twelvedata.com/pricing" };
  }
  function close() { if (running) throw new Error("requests_in_progress"); if (!closed) { db.close(); closed = true; observations.clear(); previous.clear(); } }
  return { refresh, pollDue, readInternal, evaluateReaction, publicStatus, close };
}
module.exports = { createTwelveBasicContext, DEFAULT_SYMBOLS };
