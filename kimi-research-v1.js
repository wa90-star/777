const crypto = require("crypto");

const APPROVERS = new Set(["andreas", "chatgpt", "codex"]);
const DIRECTION_MAP = new Map([
  ["up", "LONG"],
  ["down", "SHORT"]
]);
const MODES = new Set(["agent", "swarm"]);
const TIMESTAMP_PRECISIONS = new Set(["exact", "minute", "hour", "day", "unknown"]);
const NOVELTY_VALUES = new Set(["new", "update", "duplicate_suppressed", "stale"]);
const DIRECTIONAL_HYPOTHESES = new Set(["up", "down", "neutral", "none"]);
const TIME_HORIZONS = new Set(["days_to_weeks", "intraday_context", "weeks_to_months"]);
const SOURCE_CLASSES = new Set([
  "official_primary_documents",
  "direct_market_data_with_methodology",
  "news_agencies_specialist_media",
  "other_media",
  "social_aggregators"
]);
const ACCESS_STATUSES = new Set([
  "accessible",
  "partially_accessible",
  "paywalled",
  "blocked",
  "unavailable"
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

function validNullableUtc(value) {
  return value == null || validUtc(value);
}

function stringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function objectArray(value) {
  return Array.isArray(value) && value.every(isObject);
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

function sourcePublisherKey(source) {
  if (!isObject(source)) return "";
  if (nonEmptyString(source.publisher_author_account)) {
    const publisher = source.publisher_author_account
      .trim()
      .toLowerCase()
      .split(/\s+via\s+/i)[0]
      .replace(/\s*\([^)]*\)\s*$/, "")
      .trim();
    if (publisher) return `publisher:${publisher}`;
  }
  try {
    return `host:${new URL(source.url).hostname.toLowerCase().replace(/^www\./, "")}`;
  } catch {
    return "";
  }
}

function sourceFingerprintKey(source) {
  if (!isObject(source) || !nonEmptyString(source.content_fingerprint)) return "";
  return source.content_fingerprint.trim().toLowerCase();
}

function sourceHost(source) {
  try {
    return new URL(source?.url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isOriginalSocialAccountUrl(source) {
  return new Set([
    "truthsocial.com",
    "x.com",
    "twitter.com",
    "facebook.com",
    "instagram.com",
    "youtube.com"
  ]).has(sourceHost(source));
}

function independenceGroups(sources) {
  const parents = sources.map((_, index) => index);
  const find = (index) => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  const join = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  const publisherOwners = new Map();
  const fingerprintOwners = new Map();
  sources.forEach((source, index) => {
    const publisher = sourcePublisherKey(source);
    const fingerprint = sourceFingerprintKey(source);
    for (const [key, owners] of [[publisher, publisherOwners], [fingerprint, fingerprintOwners]]) {
      if (!key) continue;
      if (owners.has(key)) join(index, owners.get(key));
      else owners.set(key, index);
    }
  });
  return new Set(sources.map((_, index) => find(index)));
}

function validateSource(source, path) {
  const errors = [];
  if (!isObject(source)) return [`${path}:NOT_OBJECT`];

  if (!nonEmptyString(source.url) || !/^https?:\/\//i.test(source.url)) errors.push(`${path}.url:HTTP_URL_REQUIRED`);
  for (const field of ["title", "publisher_author_account", "supported_fact"]) {
    if (typeof source[field] !== "string") errors.push(`${path}.${field}:STRING_REQUIRED`);
  }
  if (source.original_timezone != null && typeof source.original_timezone !== "string") {
    errors.push(`${path}.original_timezone:STRING_OR_NULL_REQUIRED`);
  }
  for (const field of ["source_published_time", "first_seen_time", "research_accessed_time"]) {
    if (!validNullableUtc(source[field])) errors.push(`${path}.${field}:UTC_OR_NULL_REQUIRED`);
  }
  const sourceClass = String(source.source_class || "").trim().toLowerCase();
  if (!SOURCE_CLASSES.has(sourceClass)) errors.push(`${path}.source_class:UNSUPPORTED`);
  if (typeof source.is_primary !== "boolean") errors.push(`${path}.is_primary:BOOLEAN_REQUIRED`);
  if (!ACCESS_STATUSES.has(source.access_status)) errors.push(`${path}.access_status:UNSUPPORTED`);
  if (source.content_fingerprint != null && typeof source.content_fingerprint !== "string") {
    errors.push(`${path}.content_fingerprint:STRING_OR_NULL_REQUIRED`);
  }

  if (sourceClass === "social_aggregators" && source.is_primary === true && !isOriginalSocialAccountUrl(source)) {
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
  for (const field of ["entities", "symbols", "alternative_explanations", "contradictions", "missing_data", "falsifiers"]) {
    if (!stringArray(event[field])) errors.push(`${path}.${field}:STRING_ARRAY_REQUIRED`);
  }
  for (const field of [
    "facts",
    "calculations",
    "hypotheses",
    "evidence_for",
    "evidence_against"
  ]) {
    if (!objectArray(event[field])) errors.push(`${path}.${field}:OBJECT_ARRAY_REQUIRED`);
  }

  if (!validUtc(event.event_time_utc)) errors.push(`${path}.event_time_utc:UTC_TIMESTAMP_REQUIRED`);
  if (!TIMESTAMP_PRECISIONS.has(event.timestamp_precision)) errors.push(`${path}.timestamp_precision:UNSUPPORTED`);
  if (!NOVELTY_VALUES.has(event.novelty)) errors.push(`${path}.novelty:UNSUPPORTED`);

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
  if (!DIRECTIONAL_HYPOTHESES.has(directionalHypothesis)) {
    errors.push(`${path}.directional_hypothesis:UNSUPPORTED`);
  }
  if (!TIME_HORIZONS.has(event.time_horizon)) errors.push(`${path}.time_horizon:UNSUPPORTED`);
  if (typeof event.mechanism !== "string") errors.push(`${path}.mechanism:STRING_REQUIRED`);
  if (!isObject(event.materiality)) {
    errors.push(`${path}.materiality:OBJECT_REQUIRED`);
  } else {
    if (!Number.isInteger(event.materiality.score) || event.materiality.score < 0 || event.materiality.score > 100) {
      errors.push(`${path}.materiality.score:OUT_OF_RANGE`);
    }
    if (typeof event.materiality.rationale !== "string") {
      errors.push(`${path}.materiality.rationale:STRING_REQUIRED`);
    }
  }
  if (event.do_not_alert_reason != null && typeof event.do_not_alert_reason !== "string") {
    errors.push(`${path}.do_not_alert_reason:STRING_OR_NULL_REQUIRED`);
  }
  return errors;
}

function validateQa(qa) {
  if (!isObject(qa)) return ["qa:OBJECT_REQUIRED"];
  const errors = [];
  for (const field of [
    "schema_validated",
    "secrets_scanned",
    "deduplication_checked",
    "time_normalization_checked",
    "run_id_consistency_checked"
  ]) {
    if (qa[field] !== true) errors.push(`qa.${field}:MUST_BE_TRUE`);
  }
  return errors;
}

function validateResearchPacket(packet) {
  const errors = [];
  if (!isObject(packet)) return ["packet:OBJECT_REQUIRED"];

  if (packet.schema_version !== "1.0") errors.push("schema_version:MUST_EQUAL_1.0");
  if (!nonEmptyString(packet.task_id) || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(packet.task_id)) {
    errors.push("task_id:INVALID");
  }
  if (!nonEmptyString(packet.run_id)) errors.push("run_id:REQUIRED");
  if (!MODES.has(packet.mode)) errors.push("mode:UNSUPPORTED");
  if (!Number.isInteger(packet.revision) || packet.revision < 1) errors.push("revision:POSITIVE_INTEGER_REQUIRED");
  if (!validUtc(packet.generated_at_utc)) errors.push("generated_at_utc:UTC_TIMESTAMP_REQUIRED");
  if (!validUtc(packet.as_of_utc)) errors.push("as_of_utc:UTC_TIMESTAMP_REQUIRED");
  if (validUtc(packet.generated_at_utc) && validUtc(packet.as_of_utc)
    && new Date(packet.as_of_utc).getTime() > new Date(packet.generated_at_utc).getTime()) {
    errors.push("as_of_utc:AFTER_GENERATED_AT");
  }
  if (!isObject(packet.scope)) {
    errors.push("scope:OBJECT_REQUIRED");
  } else {
    if (!stringArray(packet.scope.included)) errors.push("scope.included:STRING_ARRAY_REQUIRED");
    if (!stringArray(packet.scope.excluded)) errors.push("scope.excluded:STRING_ARRAY_REQUIRED");
  }
  if (!isObject(packet.collection)) {
    errors.push("collection:OBJECT_REQUIRED");
  } else {
    if (!validUtc(packet.collection.started_utc)) errors.push("collection.started_utc:UTC_TIMESTAMP_REQUIRED");
    if (!validUtc(packet.collection.finished_utc)) errors.push("collection.finished_utc:UTC_TIMESTAMP_REQUIRED");
    if (!Number.isInteger(packet.collection.search_rounds_used)
      || packet.collection.search_rounds_used < 0
      || packet.collection.search_rounds_used > 2) {
      errors.push("collection.search_rounds_used:OUT_OF_RANGE");
    }
    if (packet.collection.workstreams != null && !stringArray(packet.collection.workstreams)) {
      errors.push("collection.workstreams:STRING_ARRAY_REQUIRED");
    }
    if (validUtc(packet.collection.started_utc) && validUtc(packet.collection.finished_utc)
      && new Date(packet.collection.finished_utc).getTime() < new Date(packet.collection.started_utc).getTime()) {
      errors.push("collection.finished_utc:BEFORE_STARTED_UTC");
    }
  }
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
