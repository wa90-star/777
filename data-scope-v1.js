"use strict";

function publicOilScope(oilState = {}) {
  const provider = oilState.provider || {};
  const contracts = provider.contracts || {};
  const proxyMode = oilState.dataScope === "free-etf-proxy-iex"
    || provider.instrumentType === "etf-proxy";
  const configured = provider.configured === true;

  return {
    oilDataConfigured: configured,
    oilDataMode: oilState.dataMode || null,
    oilDataScope: oilState.dataScope || null,
    oilDataSource: oilState.source || null,
    oilDataLimitations: Array.isArray(oilState.limitations) ? [...oilState.limitations] : [],
    oilInstruments: { ...contracts },
    futuresDataConfigured: proxyMode ? false : configured,
    futuresDataStatus: proxyMode ? "not-configured" : (oilState.status || "offline"),
    futuresDataSource: proxyMode ? null : (oilState.source || null),
    futuresContracts: proxyMode ? {} : { ...contracts }
  };
}

module.exports = { publicOilScope };
