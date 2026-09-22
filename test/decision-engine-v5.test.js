const test = require("node:test");
const assert = require("node:assert/strict");
const {
  antiLate,
  decide,
  executionQuality,
  latency,
  score9,
  wave2
} = require("../decision-engine-v5");

const NOW = Date.parse("2026-09-22T15:00:00Z");
const QUOTE = {
  bid: 100,
  ask: 100.1,
  last: 100.05,
  quoteTime: "2026-09-22T14:59:30Z",
  phase: "regular"
};
const CANDIDATE = {
  newInformation: true,
  material: true,
  expectationChanging: true,
  transmissionChannel: "official policy -> commodity -> proxy",
  direction: "LONG",
  novelty: 2,
  materiality: 2,
  surprise: true,
  independentConfirmation: true,
  marketConfirmation: true,
  timing: true,
  confidence: "HIGH",
  confirmationCategories: ["official", "market"],
  moveConsumedPct: 25
};

test("qualifies a fully evidenced, executable candidate", () => {
  const result = decide(CANDIDATE, QUOTE, NOW);
  assert.equal(result.pass, true);
  assert.equal(result.status, "QUALIFIED");
  assert.equal(result.score.total, 9);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.execution.reference, 100.1);
});

test("fails closed when information is not demonstrably new", () => {
  const result = decide({ ...CANDIDATE, newInformation: false }, QUOTE, NOW);
  assert.equal(result.pass, false);
  assert.ok(result.reasons.includes("NOT_NEW"));
});

test("rejects stale and implausibly future-dated quotes", () => {
  const stale = executionQuality({ ...QUOTE, quoteTime: "2026-09-22T14:54:59Z", direction: "LONG" }, NOW);
  const future = executionQuality({ ...QUOTE, quoteTime: "2026-09-22T15:00:31Z", direction: "LONG" }, NOW);
  assert.equal(stale.plausible, false);
  assert.equal(future.plausible, false);
  assert.ok(stale.failures.includes("STALE_OR_INVALID_QUOTE_TIME"));
  assert.ok(future.failures.includes("STALE_OR_INVALID_QUOTE_TIME"));
});

test("uses stricter regular-session spread limits", () => {
  const regular = executionQuality({ ...QUOTE, bid: 100, ask: 100.5, direction: "LONG" }, NOW);
  const premarket = executionQuality({ ...QUOTE, bid: 100, ask: 100.5, phase: "premarket", direction: "LONG" }, NOW);
  assert.equal(regular.plausible, false);
  assert.equal(premarket.plausible, true);
});

test("rejects unknown repricing and late entries", () => {
  assert.equal(antiLate({}).status, "UNKNOWN_REPRICING");
  assert.equal(antiLate({ moveConsumedPct: -1 }).pass, false);
  assert.equal(antiLate({ moveConsumedPct: 81 }).status, "ZU_SPAET");
  assert.equal(antiLate({ moveConsumedPct: 65 }).pass, false);
  assert.equal(antiLate({ moveConsumedPct: 65, exceptionalSetup: true }).pass, true);
});

test("requires fresh evidence, retest and expansion for wave two", () => {
  assert.equal(wave2({ wave2: false }).pass, true);
  const rejected = wave2({ wave2: true, retestOrConsolidation: true, renewedExpansion: true });
  assert.equal(rejected.pass, false);
  assert.ok(rejected.failures.includes("WAVE2_NO_NEW_EVIDENCE"));
  assert.equal(wave2({
    wave2: true,
    newIndependentConfirmation: true,
    retestOrConsolidation: true,
    renewedExpansion: true
  }).pass, true);
});

test("deduplicates confirmation categories before applying independence", () => {
  const result = decide({
    ...CANDIDATE,
    confirmationCategories: ["Official", "official", " "]
  }, QUOTE, NOW);
  assert.equal(result.independentCategories, 1);
  assert.equal(result.pass, false);
  assert.ok(result.reasons.includes("INSUFFICIENT_INDEPENDENT_CATEGORIES"));
});

test("permits only an explicit official mechanical-flow exception", () => {
  const result = decide({
    ...CANDIDATE,
    confirmationCategories: ["official"],
    finalOfficialMechanicalForcedFlow: true
  }, QUOTE, NOW);
  assert.equal(result.pass, true);
  assert.equal(result.mechanicalException, true);
});

test("vetoes an equal-strength counter-signal", () => {
  const result = decide({ ...CANDIDATE, equalStrengthCounterSignal: true }, QUOTE, NOW);
  assert.equal(result.pass, false);
  assert.ok(result.reasons.includes("COUNTER_SIGNAL_VETO"));
});

test("does not coerce truthy strings into score points", () => {
  const scored = score9({
    novelty: 2,
    materiality: 2,
    surprise: "true",
    independentConfirmation: 1,
    marketConfirmation: true,
    timing: true,
    execution: true
  });
  assert.equal(scored.total, 7);
});

test("returns null rather than negative or invented latency", () => {
  assert.deepEqual(latency({
    publishedAt: "2026-09-22T14:00:00Z",
    detectedAt: "2026-09-22T14:01:00Z",
    firstReactionAt: "2026-09-22T14:02:00Z",
    notifiedAt: "2026-09-22T14:03:00Z"
  }), {
    sourceLatencyMs: 60_000,
    decisionLatencyMs: 120_000,
    reactionToNotificationMs: 60_000
  });
  assert.equal(latency({
    publishedAt: "2026-09-22T14:02:00Z",
    detectedAt: "2026-09-22T14:01:00Z"
  }).sourceLatencyMs, null);
});
