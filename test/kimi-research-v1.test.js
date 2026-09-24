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
    scope: {
      included: ["UUUU/EFR policy research"],
      excluded: ["production alerts and orders"]
    },
    collection: {
      started_utc: "2026-09-22T13:30:00Z",
      finished_utc: "2026-09-22T14:20:00Z",
      search_rounds_used: 1,
      workstreams: ["official records"]
    },
    events: [{
      event_id: "evt-001",
      entities: ["Energy Fuels"],
      symbols: ["UUUU", "EFR"],
      headline: "Official filing changes a documented project milestone",
      event_time_utc: "2026-09-22T13:00:00Z",
      timestamp_precision: "minute",
      facts: [{ statement: "A dated filing contains the milestone." }],
      calculations: [],
      hypotheses: [{ statement: "The milestone may change expected timing." }],
      sources: [
        {
          url: "https://example.test/official-filing",
          title: "Official filing",
          publisher_author_account: "Issuer",
          original_timezone: "America/New_York",
          source_published_time: "2026-09-22T13:00:00Z",
          first_seen_time: "2026-09-22T13:01:00Z",
          research_accessed_time: "2026-09-22T13:30:00Z",
          source_class: "official_primary_documents",
          is_primary: true,
          supported_fact: "The filing states the milestone.",
          access_status: "accessible",
          content_fingerprint: "issuer-filing"
        },
        {
          url: "https://example.test/market-data",
          title: "Market data",
          publisher_author_account: "Market Data Provider",
          original_timezone: "UTC",
          source_published_time: null,
          first_seen_time: "2026-09-22T13:02:00Z",
          research_accessed_time: "2026-09-22T13:30:00Z",
          source_class: "direct_market_data_with_methodology",
          is_primary: false,
          supported_fact: "The timestamped market response.",
          access_status: "accessible",
          content_fingerprint: "market-data"
        }
      ],
      independent_source_count: 2,
      novelty: "new",
      directional_hypothesis: "up",
      time_horizon: "days_to_weeks",
      mechanism: "milestone -> expected schedule -> valuation inputs",
      evidence_for: [{ statement: "Issuer filing" }],
      evidence_against: [{ statement: "No confirmed revenue impact yet" }],
      alternative_explanations: ["Already reflected in expectations"],
      contradictions: [],
      materiality: { score: 70, rationale: "Potential schedule impact" },
      research_confidence: 78,
      missing_data: ["Updated economics"],
      falsifiers: ["Milestone is withdrawn"],
      requires_gpt_review: true,
      do_not_alert_reason: null
    }],
    qa: {
      schema_validated: true,
      secrets_scanned: true,
      deduplication_checked: true,
      time_normalization_checked: true,
      run_id_consistency_checked: true
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
  invalid.events[0].sources[0].is_primary = true;
  const errors = validateResearchPacket(invalid);
  assert.ok(errors.includes("events[0].sources[0]:AGGREGATOR_CANNOT_BE_PRIMARY"));
});

test("allows an original official social-account URL as primary evidence for the post itself", () => {
  const valid = packet();
  valid.events[0].sources[0] = {
    ...valid.events[0].sources[0],
    url: "https://truthsocial.com/@realDonaldTrump/123456789",
    publisher_author_account: "realDonaldTrump (Truth Social)",
    source_class: "social_aggregators",
    is_primary: true,
    content_fingerprint: "truth-post-123456789"
  };

  assert.equal(validateResearchPacket(valid).includes("events[0].sources[0]:AGGREGATOR_CANNOT_BE_PRIMARY"), false);
});

test("rejects inflated independent-source counts", () => {
  const invalid = packet();
  invalid.events[0].sources[1].content_fingerprint = "issuer-filing";
  const errors = validateResearchPacket(invalid);
  assert.ok(errors.includes("events[0].independent_source_count:EXCEEDS_DOCUMENTED_GROUPS"));
});

test("does not count two documents from the same publisher as independent", () => {
  const invalid = packet();
  invalid.events[0].sources[1] = {
    ...invalid.events[0].sources[1],
    publisher_author_account: invalid.events[0].sources[0].publisher_author_account,
    content_fingerprint: "different-document-from-same-publisher"
  };
  const errors = validateResearchPacket(invalid);
  assert.ok(errors.includes("events[0].independent_source_count:EXCEEDS_DOCUMENTED_GROUPS"));
});

test("fails closed when the Kimi QA flags are incomplete", () => {
  const invalid = packet();
  invalid.qa.deduplication_checked = false;
  const packetText = JSON.stringify(invalid);
  const result = verifyApprovedPacket({ packetText, approval: approved(packetText), now: NOW });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("qa.deduplication_checked:MUST_BE_TRUE"));
});

test("accepts the current control-repository packet shape and maps down to SHORT", () => {
  const current = packet();
  current.events[0].directional_hypothesis = "down";
  const packetText = JSON.stringify(current);
  const result = verifyApprovedPacket({ packetText, approval: approved(packetText), now: NOW });

  assert.equal(result.ok, true);
  assert.equal(result.bundle.candidates[0].direction, "SHORT");
  assert.deepEqual(result.bundle.candidates[0].materiality, {
    score: 70,
    rationale: "Potential schedule impact"
  });
});

test("rejects the retired QA and materiality shapes", () => {
  const invalid = packet();
  invalid.events[0].materiality = "medium";
  invalid.qa = { schema_valid: true };
  const errors = validateResearchPacket(invalid);

  assert.ok(errors.includes("events[0].materiality:OBJECT_REQUIRED"));
  assert.ok(errors.includes("qa.schema_validated:MUST_BE_TRUE"));
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
