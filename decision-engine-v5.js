// SIGNAL-RADAR 2.0 deterministic decision gate.
//
// The gate is deliberately side-effect free. It may classify a candidate, but
// it never sends a message, places an order, mutates thresholds, or writes
// production state.

const DEFAULT_MAX_QUOTE_AGE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_FUTURE_SKEW_MS = 30 * 1000;

function finiteNumber(value) {
  if (value == null || typeof value === "boolean" || (typeof value === "string" && !value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, min, max) {
  const parsed = finiteNumber(value);
  if (parsed == null) return min;
  return Math.max(min, Math.min(max, parsed));
}

function timestampMs(value) {
  const parsed = new Date(value || "").getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function executionQuality(quote = {}, now = Date.now(), limits = {}) {
  const maxQuoteAgeMs = finiteNumber(limits.maxQuoteAgeMs) ?? DEFAULT_MAX_QUOTE_AGE_MS;
  const maxFutureSkewMs = finiteNumber(limits.maxFutureSkewMs) ?? DEFAULT_MAX_FUTURE_SKEW_MS;
  const bid = finiteNumber(quote.bid);
  const ask = finiteNumber(quote.ask);
  const last = finiteNumber(quote.last);
  const quoteTimeMs = timestampMs(quote.quoteTime || quote.marketTime);
  const ageMs = quoteTimeMs == null ? null : now - quoteTimeMs;
  const phase = String(quote.phase || "").trim().toLowerCase();
  const liquidPhase = ["regular", "premarket", "afterhours", "overnight"].includes(phase);
  const validBook = bid != null && ask != null && bid > 0 && ask >= bid;
  const mid = validBook ? (bid + ask) / 2 : null;
  const spreadPct = mid ? ((ask - bid) / mid) * 100 : null;
  const fresh = ageMs != null && ageMs >= -maxFutureSkewMs && ageMs <= maxQuoteAgeMs;
  const maxSpreadPct = phase === "regular" ? 0.35 : 0.75;
  const spreadAccepted = spreadPct != null && spreadPct <= maxSpreadPct;
  const direction = String(quote.direction || "").toUpperCase();
  const failures = [];

  if (!validBook) failures.push("INVALID_BOOK");
  if (!fresh) failures.push("STALE_OR_INVALID_QUOTE_TIME");
  if (!liquidPhase) failures.push("UNSUPPORTED_MARKET_PHASE");
  if (!spreadAccepted) failures.push("SPREAD_TOO_WIDE");
  if (!["LONG", "SHORT"].includes(direction)) failures.push("INVALID_DIRECTION");

  const plausible = failures.length === 0;
  return {
    plausible,
    failures,
    bid,
    ask,
    last,
    mid,
    spreadPct,
    maxSpreadPct,
    fresh,
    ageMs,
    phase,
    reference: plausible ? (direction === "SHORT" ? bid : ask) : null
  };
}

function informationGate(candidate = {}) {
  const failures = [];
  if (candidate.newInformation !== true) failures.push("NOT_NEW");
  if (candidate.material !== true) failures.push("NOT_MATERIAL");
  if (candidate.expectationChanging !== true) failures.push("NO_EXPECTATION_CHANGE");
  if (!String(candidate.transmissionChannel || "").trim()) failures.push("NO_TRANSMISSION_CHANNEL");
  if (!["LONG", "SHORT"].includes(String(candidate.direction || "").toUpperCase())) failures.push("NO_DIRECTION");
  return { pass: failures.length === 0, failures };
}

function score9(candidate = {}) {
  const components = {
    novelty: clamp(candidate.novelty, 0, 2),
    materiality: clamp(candidate.materiality, 0, 2),
    surprise: candidate.surprise === true ? 1 : 0,
    independentConfirmation: candidate.independentConfirmation === true ? 1 : 0,
    marketConfirmation: candidate.marketConfirmation === true ? 1 : 0,
    timing: candidate.timing === true ? 1 : 0,
    execution: candidate.execution === true ? 1 : 0
  };
  return {
    components,
    total: Object.values(components).reduce((sum, value) => sum + value, 0)
  };
}

function antiLate(candidate = {}) {
  const consumed = finiteNumber(candidate.moveConsumedPct);
  if (consumed == null || consumed < 0) return { pass: false, status: "UNKNOWN_REPRICING", consumedPct: consumed };
  if (consumed > 80) return { pass: false, status: "ZU_SPAET", consumedPct: consumed };
  if (consumed > 60 && candidate.exceptionalSetup !== true) {
    return { pass: false, status: "ZU_SPAET", consumedPct: consumed };
  }
  return {
    pass: true,
    status: consumed <= 30 ? "EARLY" : "PARTIAL",
    consumedPct: consumed
  };
}

function wave2(candidate = {}) {
  if (candidate.wave2 !== true) return { pass: true, failures: [] };
  const failures = [];
  if (candidate.newInformation !== true && candidate.newIndependentConfirmation !== true) {
    failures.push("WAVE2_NO_NEW_EVIDENCE");
  }
  if (candidate.retestOrConsolidation !== true) failures.push("WAVE2_NO_RETEST");
  if (candidate.renewedExpansion !== true) failures.push("WAVE2_NO_EXPANSION");
  return { pass: failures.length === 0, failures };
}

function normalizedCategories(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean))];
}

function decide(candidate = {}, quote = {}, now = Date.now(), limits = {}) {
  const direction = String(candidate.direction || "").toUpperCase();
  const information = informationGate({ ...candidate, direction });
  const execution = executionQuality({ ...quote, direction }, now, limits);
  const antiLateResult = antiLate(candidate);
  const wave2Result = wave2(candidate);
  const score = score9({
    ...candidate,
    execution: execution.plausible && candidate.execution !== false
  });
  const categories = normalizedCategories(candidate.confirmationCategories);
  const confidence = String(candidate.confidence || "").trim().toUpperCase();
  const confidencePass = ["MITTEL", "MEDIUM", "HOCH", "HIGH"].includes(confidence);
  const counterSignalVeto = candidate.equalStrengthCounterSignal === true;
  const mechanicalException = candidate.finalOfficialMechanicalForcedFlow === true;
  const independencePass = categories.length >= 2 || mechanicalException;
  const reasons = [
    ...information.failures,
    ...execution.failures,
    ...wave2Result.failures
  ];

  if (!antiLateResult.pass) reasons.push(antiLateResult.status);
  if (counterSignalVeto) reasons.push("COUNTER_SIGNAL_VETO");
  if (!confidencePass) reasons.push("CONFIDENCE_TOO_LOW");
  if (score.total < 7) reasons.push("SCORE_BELOW_7");
  if (!independencePass) reasons.push("INSUFFICIENT_INDEPENDENT_CATEGORIES");

  const pass = reasons.length === 0;
  return {
    pass,
    status: pass ? "QUALIFIED" : "REJECTED",
    reasons: [...new Set(reasons)],
    information,
    execution,
    antiLate: antiLateResult,
    wave2: wave2Result,
    score,
    confirmationCategories: categories,
    independentCategories: categories.length,
    independencePass,
    mechanicalException,
    counterSignalVeto,
    confidencePass
  };
}

function latency({ publishedAt, detectedAt, firstReactionAt, notifiedAt } = {}) {
  function difference(start, end) {
    const startMs = timestampMs(start);
    const endMs = timestampMs(end);
    if (startMs == null || endMs == null || endMs < startMs) return null;
    return endMs - startMs;
  }

  return {
    sourceLatencyMs: difference(publishedAt, detectedAt),
    decisionLatencyMs: difference(detectedAt, notifiedAt),
    reactionToNotificationMs: difference(firstReactionAt, notifiedAt)
  };
}

module.exports = {
  DEFAULT_MAX_FUTURE_SKEW_MS,
  DEFAULT_MAX_QUOTE_AGE_MS,
  antiLate,
  decide,
  executionQuality,
  informationGate,
  latency,
  score9,
  wave2
};
