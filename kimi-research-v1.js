const crypto = require("crypto");

const APPROVERS = new Set(["andreas", "chatgpt", "codex"]);
const DIRECTION_MAP = new Map([
  ["bullish", "LONG"],
  ["bearish", "SHORT"],
  ["long", "LONG"],
  ["short", "SHORT"]
]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validUtc(value) {
  if (!nonEmptyString(value) || !/Z$/i.test(value.trim())) return false;
  return Number.isFinite(new Date(value).getTime());
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function parseJson(text, label) {
  try {
    return { value: JSON.parse(text), errors: [] };
  } catch (error) {
    return { value: null, errors: [`${label}:INVALID_JSON:${error.message}`] };
  }
}

function eventSources(event) {
  if (Array.isArray(event.sources)) return event.sources;
  if (Array.isArray(event.source_urls)) return event.source_urls;
  return [];
}

function independenceGroups(sources) {
  return new Set(sources.map((source) => {
    if (!isObject(source)) return "";
    if (nonEmptyString(source.independence_group)) return source.independence_group.trim().toLowerCase();
    return "";
  }).filter(Boolean));
}

function validateSource(source, path) {
  const errors = [];
  if (!isObject(source)) return [`${path}:NOT_OBJECT`];

  if (!nonEmptyString(source.url)) errors.push(`${path}.url:REQUIRED`);
  const sourceClass = String(source.source_class || "").trim().toLowerCase();
  if (!sourceClass) errors.push(`${path}.source_class:REQUIRED`);
  if (!nonEmptyString(source.independence_group)) errors.push(`${path}.independence_group:REQUIRED`);

  const isPrimary = source.primary_source === true || source.is_primary === true;
  if (["social_aggregators", "social_discovery", "aggregator"].includes(sourceClass) && isPrimary) {
    errors.push(`${path}:AGGREGATOR_CANNOT_BE_PRIMARY`);
  }
  return errors;
}

function validateEvent(event, index) {
  const path = `events[${index}]`;
  const errors = [];
  if (!isObject(event)) return [`${path}:NOT_OBJECT`];

  for (const field of ["event_id", "headline"]) {
    if (!nonEmptyString(event[field])) errors.push(`${path}.${field}:REQUIRED`);
  }
  for (const field of [
    "entities",
    "symbols",
    "facts",
    "calculations",
    "hypotheses",
    "evidence_for",
    "evidence_against",
    "alternative_explanations",
    "contradictions",
    "missing_data",
    "falsifiers"
  ]) {
    if (!Array.isArray(event[field])) errors.push(`${path}.${field}:ARRAY_REQUIRED`);
  }

  if (event.requires_gpt_review !== true) errors.push(`${path}.requires_gpt_review:MUST_BE_TRUE`);
  const confidence = Number(event.research_confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
    errors.push(`${path}.research_confidence:OUT_OF_RANGE`);
  }
  const claimedIndependence = Number(event.independent_source_count);
  if (!Number.isInteger(claimedIndependence) || claimedIndependence < 0) {
    errors.push(`${path}.independent_source_count:NON_NEGATIVE_INTEGER_REQUIRED`);
  }

  const sources = eventSources(event);
  if (!sources.length) errors.push(`${path}.sources:NON_EMPTY_ARRAY_REQUIRED`);
  sources.forEach((source, sourceIndex) => {
    errors.push(...validateSource(source, `${path}.sources[${sourceIndex}]`));
  });
  const groups = independenceGroups(sources);
  if (Number.isInteger(claimedIndependence) && claimedIndependence > groups.size) {
    errors.push(`${path}.independent_source_count:EXCEEDS_DOCUMENTED_GROUPS`);
  }

  const directionalHypothesis = String(event.directional_hypothesis || "").trim().toLowerCase();
  if (!directionalHypothesis) errors.push(`${path}.directional_hypothesis:REQUIRED`);
  if (!nonEmptyString(event.mechanism)) errors.push(`${path}.mechanism:REQUIRED`);
  if (!nonEmptyString(event.time_horizon)) errors.push(`${path}.time_horizon:REQUIRED`);
  if (!nonEmptyString(event.materiality)) errors.push(`${path}.materiality:REQUIRED`);
  return errors;
}

function validateQa(qa) {
  if (!isObject(qa)) return ["qa:OBJECT_REQUIRED"];
  const errors = [];
  for (const field of [
    "all_material_claims_cited",
    "timestamps_normalized",
    "duplicates_removed",
    "source_independence_checked",
    "primary_sources_prioritized",
    "schema_valid"
  ]) {
    if (qa[field] !== true) errors.push(`qa.${field}:MUST_BE_TRUE`);
  }
  if (!Array.isArray(qa.unresolved_conflicts)) errors.push("qa.unresolved_conflicts:ARRAY_REQUIRED");
  return errors;
}

function validateResearchPacket(packet) {
  const errors = [];
  if (!isObject(packet)) return ["packet:OBJECT_REQUIRED"];

  for (const field of ["schema_version", "task_id", "run_id", "mode"]) {
    if (!nonEmptyString(packet[field])) errors.push(`${field}:REQUIRED`);
  }
  if (!Number.isInteger(packet.revision) || packet.revision < 1) errors.push("revision:POSITIVE_INTEGER_REQUIRED");
  if (!validUtc(packet.generated_at_utc)) errors.push("generated_at_utc:UTC_TIMESTAMP_REQUIRED");
  if (!validUtc(packet.as_of_utc)) errors.push("as_of_utc:UTC_TIMESTAMP_REQUIRED");
  if (validUtc(packet.generated_at_utc) && validUtc(packet.as_of_utc)
    && new Date(packet.as_of_utc).getTime() > new Date(packet.generated_at_utc).getTime()) {
    errors.push("as_of_utc:AFTER_GENERATED_AT");
  }
  if (!isObject(packet.scope)) errors.push("scope:OBJECT_REQUIRED");
  if (!isObject(packet.collection)) errors.push("collection:OBJECT_REQUIRED");
  if (!Array.isArray(packet.events)) {
    errors.push("events:ARRAY_REQUIRED");
  } else {
    packet.events.forEach((event, index) => errors.push(...validateEvent(event, index)));
    if (packet.events.length === 0 && !nonEmptyString(packet.no_signal_reason)) {
      errors.push("no_signal_reason:REQUIRED_WHEN_EVENTS_EMPTY");
    }
  }
  errors.push(...validateQa(packet.qa));
  return errors;
}

function validateApproval(approval, packet, packetHash, now = Date.now()) {
  const errors = [];
  if (!isObject(approval)) return ["approval:OBJECT_REQUIRED"];
  if (approval.schema_version !== "1.0") errors.push("approval.schema_version:MUST_EQUAL_1.0");
  if (String(approval.verdict || "").toLowerCase() !== "approved") errors.push("approval.verdict:MUST_BE_APPROVED");

  const approver = String(approval.approved_by || "").trim().toLowerCase();
  if (!APPROVERS.has(approver)) errors.push("approval.approved_by:UNAUTHORIZED");
  if (!validUtc(approval.approved_at_utc)) {
    errors.push("approval.approved_at_utc:UTC_TIMESTAMP_REQUIRED");
  } else if (new Date(approval.approved_at_utc).getTime() > now + 5 * 60 * 1000) {
    errors.push("approval.approved_at_utc:FUTURE_TIMESTAMP");
  } else if (packet && validUtc(packet.generated_at_utc)
    && new Date(approval.approved_at_utc).getTime() < new Date(packet.generated_at_utc).getTime()) {
    errors.push("approval.approved_at_utc:BEFORE_PACKET_GENERATION");
  }
  if (!/^[a-f0-9]{64}$/i.test(String(approval.packet_sha256 || ""))) {
    errors.push("approval.packet_sha256:SHA256_REQUIRED");
  } else if (String(approval.packet_sha256).toLowerCase() !== packetHash) {
    errors.push("approval.packet_sha256:HASH_MISMATCH");
  }

  if (packet) {
    if (approval.task_id !== packet.task_id) errors.push("approval.task_id:IDENTITY_MISMATCH");
    if (approval.run_id !== packet.run_id) errors.push("approval.run_id:IDENTITY_MISMATCH");
    if (approval.revision !== packet.revision) errors.push("approval.revision:IDENTITY_MISMATCH");
  }
  return errors;
}

function normalizeDirection(value) {
  return DIRECTION_MAP.get(String(value || "").trim().toLowerCase()) || "UNKNOWN";
}

function sanitizePacket(packet, approval, packetHash, importedAtUtc) {
  return {
    schema_version: "1.0",
    mode: "shadow",
    source: "kimi-research-approved",
    task_id: packet.task_id,
    run_id: packet.run_id,
    revision: packet.revision,
    as_of_utc: packet.as_of_utc,
    imported_at_utc: importedAtUtc,
    approval: {
      verdict: "approved",
      approved_by: String(approval.approved_by).trim().toLowerCase(),
      approved_at_utc: approval.approved_at_utc,
      packet_sha256: packetHash,
      source_pr: nonEmptyString(approval.source_pr) ? approval.source_pr : null
    },
    candidates: packet.events.map((event) => ({
      event_id: event.event_id,
      symbols: [...new Set(event.symbols.map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean))],
      headline: event.headline,
      direction: normalizeDirection(event.directional_hypothesis),
      time_horizon: event.time_horizon,
      materiality: event.materiality,
      research_confidence: Number(event.research_confidence),
      independent_source_count: Number(event.independent_source_count),
      requires_deterministic_radar_review: true,
      status: "SHADOW_ONLY"
    }))
  };
}

function verifyApprovedPacket({ packetText, approval, now = Date.now() }) {
  const packetHash = sha256(packetText);
  const parsed = parseJson(packetText, "packet");
  if (parsed.errors.length) return { ok: false, errors: parsed.errors, packetSha256: packetHash, bundle: null };

  const packetErrors = validateResearchPacket(parsed.value);
  for (const field of ["generated_at_utc", "as_of_utc"]) {
    if (validUtc(parsed.value[field]) && new Date(parsed.value[field]).getTime() > now + 5 * 60 * 1000) {
      packetErrors.push(`${field}:FUTURE_TIMESTAMP`);
    }
  }
  const approvalErrors = validateApproval(approval, parsed.value, packetHash, now);
  const errors = [...packetErrors, ...approvalErrors];
  if (errors.length) return { ok: false, errors, packetSha256: packetHash, bundle: null };

  return {
    ok: true,
    errors: [],
    packetSha256: packetHash,
    bundle: sanitizePacket(parsed.value, approval, packetHash, new Date(now).toISOString())
  };
}

module.exports = {
  eventSources,
  sha256,
  validateApproval,
  validateResearchPacket,
  verifyApprovedPacket
};
