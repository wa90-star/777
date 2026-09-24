const test = require("node:test");
const assert = require("node:assert/strict");
const { publicOilScope } = require("../data-scope-v1");

test("labels free Alpaca IEX ETFs as oil proxies and not as futures", () => {
  const result = publicOilScope({
    status: "live",
    source: "alpaca-iex-oil-etf-proxy",
    dataMode: "free-proxy",
    dataScope: "free-etf-proxy-iex",
    limitations: ["ETF proxy"],
    provider: {
      configured: true,
      instrumentType: "etf-proxy",
      contracts: { CL: { ticker: "USO" }, BZ: { ticker: "BNO" } }
    }
  });

  assert.equal(result.oilDataConfigured, true);
  assert.deepEqual(Object.keys(result.oilInstruments), ["CL", "BZ"]);
  assert.equal(result.futuresDataConfigured, false);
  assert.equal(result.futuresDataStatus, "not-configured");
  assert.equal(result.futuresDataSource, null);
  assert.deepEqual(result.futuresContracts, {});
});

test("exposes futures fields only for an actual futures provider", () => {
  const result = publicOilScope({
    status: "live",
    source: "massive-futures",
    dataMode: "real-time",
    dataScope: "futures-orderflow",
    limitations: [],
    provider: {
      configured: true,
      instrumentType: "futures",
      contracts: { CL: { ticker: "CLZ6" }, BZ: { ticker: "BZV6" } }
    }
  });

  assert.equal(result.futuresDataConfigured, true);
  assert.equal(result.futuresDataStatus, "live");
  assert.equal(result.futuresDataSource, "massive-futures");
  assert.deepEqual(Object.keys(result.futuresContracts), ["CL", "BZ"]);
});
