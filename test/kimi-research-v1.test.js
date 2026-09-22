const test = require("node:test");
const assert = require("node:assert/strict");
const {
  sha256,
  validateResearchPacket,
  verifyApprovedPacket
} = require("../kimi-research-v1");

const NOW = Date.parse("2026-09-22T15:00:00Z");

function packet(overrides = {}) {
  return {
    schema_version: "1.0",
    task_id: "uuuu-policy-scan-001",
    run_id: "run-20260922-001",
    revision: 1,
    generated_at_utc: "2026-09-22T14:30:00Z",
    as_of_utc: "2026-09-22T14:25:00Z",
    mode: "agent",
    scope: { symbols: ["UUUU", "EFR"] },
    collection: { sources_checked: 2 },
    events: [{
      event_id: "evt-001",
      entities: ["Energy Fuels"],
      symbols: ["UUUU", "EFR"],
      headline: "Official filing changes a documented project milestone",
      event_time_utc: "2026-09-22T13:00:00Z",
      timestamp_precision: "minute",
      facts: ["A dated filing contains the milestone."],
      calculations: [],
      hypotheses: ["The milestone may change expected timing."],
      sources: [
        {
          url: "https://example.test/official-filing",
          source_class: "primary",
          primary_source: true,
          independence_group: "issuer-filing"
        },
        {
          url: "https://example.test/market-data",
          source_class: "direct_data",
          primary_source: false,
          independence_group: "market-data"
        }
      ],
      independent_source_count: 2,
      novelty: "new",
      directional_hypothesis: "bullish",
      time_horizon: "weeks",
      mechanism: "milestone -> expected schedule -> valuation inputs",
      evidence_for: ["Issuer filing"],
      evidence_against: ["No confirmed revenue impact yet"],
      alternative_explanations: ["Already reflected in expectations"],
      contradictions: [],
      materiality: "medium",
      research_confidence: 78,
      missing_data: ["Updated economics"],
      falsifiers: ["Milestone is withdrawn"],
      requires_gpt_review: true,
      do_not_alert_reason: null
    }],
    no_signal_reason: null,
    qa: {
      all_material_claims_cited: true,
      timestamps_normalized: true,
      duplicates_removed: true,
      source_independence_checked: true,
      primary_sources_prioritized: true,
      schema_valid: true,
      unresolved_conflicts: []
    },
    ...overrides
  };
}

function approved(packetText, overrides = {}) {
  const parsed = JSON.parse(packetText);
  return {
    schema_version: "1.0",
    task_id: parsed.task_id,
    run_id: parsed.run_id,
    revision: parsed.revision,
    verdict: "approved",
    approved_by: "codex",
    approved_at_utc: "2026-09-22T14:45:00Z",
    packet_sha256: sha256(packetText),
    source_pr: "private-control-pr-7",
    ...overrides
  };
}

test("imports a reviewed packet only as a sanitized shadow bundle", () => {
  const packetText = JSON.stringify(packet());
  const result = verifyApprovedPacket({ packetText, approval: approved(packetText), now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.bundle.mode, "shadow");
  assert.equal(result.bundle.candidates.length, 1);
  assert.equal(result.bundle.candidates[0].direction, "LONG");
  assert.equal(result.bundle.candidates[0].status, "SHADOW_ONLY");
  assert.equal(result.bundle.candidates[0].requires_deterministic_radar_review, true);
  assert.equal("facts" in result.bundle.candidates[0], false);
});

test("rejects a packet when its approved byte hash does not match", () => {
  const packetText = JSON.stringify(packet());
  const result = verifyApprovedPacket({
    packetText,
    approval: approved(packetText, { packet_sha256: "0".repeat(64) }),
    now: NOW
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("approval.packet_sha256:HASH_MISMATCH"));
});

test("rejects cross-run approval reuse", () => {
  const packetText = JSON.stringify(packet());
  const result = verifyApprovedPacket({
    packetText,
    approval: approved(packetText, { run_id: "another-run" }),
    now: NOW
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("approval.run_id:IDENTITY_MISMATCH"));
});

test("keeps requires_gpt_review mandatory even after approval", () => {
  const invalid = packet();
  invalid.events[0].requires_gpt_review = false;
  const errors = validateResearchPacket(invalid);
  assert.ok(errors.includes("events[0].requires_gpt_review:MUST_BE_TRUE"));
});

test("does not count an aggregator as a primary source", () => {
  const invalid = packet();
  invalid.events[0].sources[0].source_class = "social_aggregators";
  invalid.events[0].sources[0].primary_source = true;
  const errors = validateResearchPacket(invalid);
  assert.ok(errors.includes("events[0].sources[0]:AGGREGATOR_CANNOT_BE_PRIMARY"));
});

test("rejects inflated independent-source counts", () => {
  const invalid = packet();
  invalid.events[0].sources[1].independence_group = "issuer-filing";
  const errors = validateResearchPacket(invalid);
  assert.ok(errors.includes("events[0].independent_source_count:EXCEEDS_DOCUMENTED_GROUPS"));
});

test("fails closed when the Kimi QA flags are incomplete", () => {
  const invalid = packet();
  invalid.qa.duplicates_removed = false;
  const packetText = JSON.stringify(invalid);
  const result = verifyApprovedPacket({ packetText, approval: approved(packetText), now: NOW });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("qa.duplicates_removed:MUST_BE_TRUE"));
});

test("accepts an explicit no-signal result without inventing a candidate", () => {
  const noSignal = packet({ events: [], no_signal_reason: "No material change survived QA." });
  const packetText = JSON.stringify(noSignal);
  const result = verifyApprovedPacket({ packetText, approval: approved(packetText), now: NOW });
  assert.equal(result.ok, true);
  assert.deepEqual(result.bundle.candidates, []);
});

test("rejects future-dated approvals", () => {
  const packetText = JSON.stringify(packet());
  const result = verifyApprovedPacket({
    packetText,
    approval: approved(packetText, { approved_at_utc: "2026-09-22T15:06:00Z" }),
    now: NOW
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("approval.approved_at_utc:FUTURE_TIMESTAMP"));
});

test("rejects approval timestamps that predate packet generation", () => {
  const packetText = JSON.stringify(packet());
  const result = verifyApprovedPacket({
    packetText,
    approval: approved(packetText, { approved_at_utc: "2026-09-22T14:29:59Z" }),
    now: NOW
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("approval.approved_at_utc:BEFORE_PACKET_GENERATION"));
});

test("rejects future packet timestamps and an as-of time after generation", () => {
  const futurePacket = packet({
    generated_at_utc: "2026-09-22T15:06:00Z",
    as_of_utc: "2026-09-22T15:07:00Z"
  });
  const packetText = JSON.stringify(futurePacket);
  const result = verifyApprovedPacket({
    packetText,
    approval: approved(packetText, { approved_at_utc: "2026-09-22T15:04:00Z" }),
    now: NOW
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("as_of_utc:AFTER_GENERATED_AT"));
  assert.ok(result.errors.includes("generated_at_utc:FUTURE_TIMESTAMP"));
  assert.ok(result.errors.includes("as_of_utc:FUTURE_TIMESTAMP"));
});

test("reports invalid JSON without attempting an import", () => {
  const result = verifyApprovedPacket({ packetText: "{", approval: {}, now: NOW });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /^packet:INVALID_JSON:/);
  assert.equal(result.bundle, null);
});
