const fs = require("fs");

const ALLOWED_MODES = new Set(["off", "shadow"]);

function validBundle(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return false;
  if (bundle.schema_version !== "1.0" || bundle.mode !== "shadow") return false;
  if (bundle.approval?.verdict !== "approved") return false;
  if (!Array.isArray(bundle.candidates)) return false;
  return bundle.candidates.every((candidate) => (
    candidate
    && typeof candidate === "object"
    && candidate.status === "SHADOW_ONLY"
    && candidate.requires_deterministic_radar_review === true
  ));
}

function createResearchStore({
  mode = process.env.KIMI_RESEARCH_MODE || "off",
  filePath = process.env.KIMI_RESEARCH_FILE || "/data/kimi-research-shadow.json",
  now = () => Date.now()
} = {}) {
  const requestedMode = String(mode || "off").trim().toLowerCase();
  const activeMode = ALLOWED_MODES.has(requestedMode) ? requestedMode : "off";
  let bundle = null;
  let lastLoadedAt = null;
  let lastError = ALLOWED_MODES.has(requestedMode) ? null : `unsupported-mode:${requestedMode}`;

  function load() {
    if (activeMode === "off") return getState();
    try {
      if (!fs.existsSync(filePath)) {
        bundle = null;
        lastLoadedAt = null;
        lastError = null;
        return getState();
      }
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!validBundle(parsed)) throw new Error("invalid-or-non-shadow-bundle");
      bundle = parsed;
      lastLoadedAt = new Date(now()).toISOString();
      lastError = null;
    } catch (error) {
      bundle = null;
      lastLoadedAt = null;
      lastError = error.message;
    }
    return getState();
  }

  function getCandidates() {
    if (activeMode !== "shadow" || !bundle) return [];
    return bundle.candidates.map((candidate) => ({ ...candidate }));
  }

  function getState() {
    return {
      requestedMode,
      mode: activeMode,
      loaded: Boolean(bundle),
      candidateCount: bundle?.candidates?.length || 0,
      latestAsOfUtc: bundle?.as_of_utc || null,
      lastLoadedAt,
      lastError,
      productionInfluence: false,
      telegramInfluence: false
    };
  }

  return { getCandidates, getState, load };
}

module.exports = createResearchStore;
module.exports.validBundle = validBundle;
