// One notification owner for Energy Fuels across its exchange symbols.
// This contract supplies context to that owner; it is not a second alert engine.
const ENERGY_FUELS_OWNER = "energy-fuels-fokus";
const ENERGY_FUELS_ALIASES = Object.freeze(["UUUU", "EFR", "EF2"]);
const ENERGY_FUELS_CONTEXT_PATH = "/api/energy-fuels-context";

function isEnergyFuels(symbol) {
  const normalized = String(symbol || "").trim().toUpperCase();
  // Accept common exchange-qualified forms without changing their quote identity.
  const ticker = normalized.split(":").pop().replace(/\.(TO|F|DE)$/, "");
  return ENERGY_FUELS_ALIASES.includes(ticker);
}

function signalOwnership(symbol) {
  const delegated = isEnergyFuels(symbol);
  return {
    owner: delegated ? ENERGY_FUELS_OWNER : "777",
    mode: delegated ? "context-only" : "general-radar",
    directAlertAllowed: !delegated,
    contextPath: delegated ? ENERGY_FUELS_CONTEXT_PATH : null
  };
}

function energyFuelsPolicy() {
  return {
    owner: ENERGY_FUELS_OWNER,
    aliases: [...ENERGY_FUELS_ALIASES],
    mode: "context-only",
    directAlertAllowed: false,
    contextPath: ENERGY_FUELS_CONTEXT_PATH,
    deliveryConfirmed: false
  };
}

function isEnergyFuelsRelevant(item) {
  if (!item || typeof item !== "object") return false;
  return isEnergyFuels(item.symbol) || item.entities?.includes("energy_fuels") ||
    /\benergy\s+fuels\b|\bUUUU\b/i.test([item.title, item.text, item.description].filter(Boolean).join(" "));
}

function isEnergyFuelsSpecific(item) {
  if (!isEnergyFuelsRelevant(item)) return false;
  // Relevance is not ownership. A broad policy event mentioning EF must keep
  // its general alert, especially when it has another instrument's direction.
  if (Object.keys(item.directionalBiases || {}).some((symbol) => !isEnergyFuels(symbol))) return false;
  if ((item.impactedSymbols || []).some((symbol) => !isEnergyFuels(symbol))) return false;
  if (isEnergyFuels(item.symbol)) return true;
  // Only clear company-action headlines are delegated automatically. Ambiguous
  // headlines and mentions in article bodies remain general-market news.
  return /^(?:Energy\s+Fuels(?:\s+Inc\.?)?|UUUU)\s+(?:announces|reports|receives|obtains|secures|completes|commissions|expands|halts|resumes|signs|awarded)\b/i
    .test(String(item.title || "").trim());
}

function relevantContext(item) {
  if (!item || typeof item !== "object") return false;
  return item.theme === "critical-minerals" ||
    isEnergyFuelsRelevant(item) ||
    (item.impactedSymbols || []).some(isEnergyFuels) ||
    Object.keys(item.directionalBiases || {}).some(isEnergyFuels);
}

function contextRows(rows) {
  const seen = new Set();
  return (rows || []).filter(relevantContext).filter((item) => {
    // Preserve the collector's existing identity. Do not invent global dedupe.
    if (!item.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  }).map((item) => ({
    ...item,
    contextOwner: ENERGY_FUELS_OWNER,
    contextOnly: true,
    tradeDecisionAllowed: false
  }));
}

function energyFuelsContext(structuralState = {}, equityState = {}, policyState = {}) {
  return {
    schemaVersion: 1,
    sourceSystem: "777",
    ...energyFuelsPolicy(),
    status: "available-for-owner-review",
    ownerReadConfirmed: false,
    tradeDecisionAllowed: false,
    generatedAt: new Date().toISOString(),
    lastSourceScanAt: structuralState.lastScanAt || null,
    persistence: structuralState.persistence || "unknown",
    collectorRetentionMaxHours: { structural: 72, policyDisplay: 336, policySeenIds: 72 },
    collectorLimits: { structuralDiscoveries: 80, structuralClusters: 30, policyDiscoveries: 30 },
    sources: structuralState.sources || {},
    policySources: policyState.sources || {},
    policyPersistence: policyState.persistence || "unknown",
    // Discovery is visible even without a quote, direction or promotion.
    // Multi-publisher confirmation is not primary-source verification.
    discoveries: contextRows(structuralState.items),
    confirmedClusters: contextRows(structuralState.verified),
    policyDiscoveries: contextRows((policyState.items || []).filter(isEnergyFuelsRelevant)),
    marketContext: (equityState.signals || []).filter((signal) => isEnergyFuels(signal.symbol))
      .map((signal) => ({ ...signal, alertRouting: signalOwnership(signal.symbol), tradeDecisionAllowed: false })),
    lastMarketScanAt: equityState.lastScanAt || null,
    marketError: equityState.lastError || null,
    limitations: [
      "Context availability is not an acknowledgement from Energy Fuels Fokus or a delivered notification.",
      "The owner must verify primary sources, materiality, timing and its own event deduplication.",
      "Discovery collectors have age and row limits. The separate handoff section retains deferred alerts without automatic deletion; it is not proof of delivery."
    ]
  };
}

module.exports = { isEnergyFuels, isEnergyFuelsRelevant, isEnergyFuelsSpecific, signalOwnership, energyFuelsPolicy, energyFuelsContext, ENERGY_FUELS_CONTEXT_PATH };
