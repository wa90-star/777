// SIGNAL-RADAR 2.0 deterministic decision gate
const MAX_QUOTE_AGE_MS = 5 * 60 * 1000;

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function ageMs(ts, now = Date.now()) { const t = new Date(ts || '').getTime(); return Number.isFinite(t) ? now - t : Infinity; }

function executionQuality(q = {}, now = Date.now()) {
  const bid = n(q.bid), ask = n(q.ask), last = n(q.last);
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
  const spreadPct = mid ? ((ask - bid) / mid) * 100 : Infinity;
  const fresh = ageMs(q.quoteTime || q.marketTime, now) >= -300000 && ageMs(q.quoteTime || q.marketTime, now) <= MAX_QUOTE_AGE_MS;
  const phase = String(q.phase || '').toLowerCase();
  const liquidPhase = ['regular','premarket','afterhours','overnight'].includes(phase);
  const maxSpread = phase === 'regular' ? 0.35 : 0.75;
  const plausible = bid > 0 && ask >= bid && fresh && liquidPhase && spreadPct <= maxSpread;
  return { plausible, bid, ask, last, spreadPct, fresh, phase, reference: plausible ? (q.direction === 'SHORT' ? bid : ask) : null };
}

function informationGate(c = {}) {
  const failures = [];
  if (!c.newInformation) failures.push('NOT_NEW');
  if (!c.material) failures.push('NOT_MATERIAL');
  if (!c.expectationChanging) failures.push('NO_EXPECTATION_CHANGE');
  if (!c.transmissionChannel) failures.push('NO_TRANSMISSION_CHANNEL');
  if (!['LONG','SHORT'].includes(c.direction)) failures.push('NO_DIRECTION');
  return { pass: failures.length === 0, failures };
}

function score9(c = {}) {
  const s = {
    novelty: Math.max(0, Math.min(2, Number(c.novelty || 0))),
    materiality: Math.max(0, Math.min(2, Number(c.materiality || 0))),
    surprise: c.surprise ? 1 : 0,
    independentConfirmation: c.independentConfirmation ? 1 : 0,
    marketConfirmation: c.marketConfirmation ? 1 : 0,
    timing: c.timing ? 1 : 0,
    execution: c.execution ? 1 : 0
  };
  return { components: s, total: Object.values(s).reduce((a,b) => a+b, 0) };
}

function antiLate(c = {}) {
  const consumed = n(c.moveConsumedPct);
  if (consumed == null) return { pass: false, status: 'UNKNOWN_REPRICING' };
  if (consumed > 80) return { pass: false, status: 'ZU_SPAET' };
  if (consumed > 60 && !c.exceptionalSetup) return { pass: false, status: 'ZU_SPAET' };
  return { pass: true, status: consumed <= 30 ? 'EARLY' : 'PARTIAL' };
}

function wave2(c = {}) {
  if (!c.wave2) return true;
  return Boolean((c.newInformation || c.newIndependentConfirmation) && c.retestOrConsolidation && c.renewedExpansion);
}

function decide(candidate = {}, quote = {}, now = Date.now()) {
  const info = informationGate(candidate);
  const exec = executionQuality({ ...quote, direction: candidate.direction }, now);
  const late = antiLate(candidate);
  const scored = score9({ ...candidate, execution: exec.plausible && candidate.execution !== false });
  const independentCategories = new Set(candidate.confirmationCategories || []).size;
  const opposing = Boolean(candidate.equalStrengthCounterSignal);
  const wave2Pass = wave2(candidate);
  const confidence = String(candidate.confidence || '').toUpperCase();
  const confidencePass = ['MITTEL','MEDIUM','HOCH','HIGH'].includes(confidence);
  const mechanicalException = Boolean(candidate.finalOfficialMechanicalForcedFlow);
  const pass = info.pass && exec.plausible && late.pass && wave2Pass && !opposing && confidencePass && scored.total >= 7 && (independentCategories >= 2 || mechanicalException);
  return { pass, info, execution: exec, antiLate: late, score: scored, independentCategories, opposing, wave2Pass, confidencePass, status: pass ? 'QUALIFIED' : 'REJECTED' };
}

function latency({ publishedAt, detectedAt, firstReactionAt, notifiedAt }) {
  const diff = (a,b) => { const x=new Date(a||'').getTime(), y=new Date(b||'').getTime(); return Number.isFinite(x)&&Number.isFinite(y) ? y-x : null; };
  return { sourceLatencyMs: diff(publishedAt, detectedAt), decisionLatencyMs: diff(detectedAt, notifiedAt), reactionToNotificationMs: diff(firstReactionAt, notifiedAt) };
}

module.exports = { executionQuality, informationGate, score9, antiLate, wave2, decide, latency };
