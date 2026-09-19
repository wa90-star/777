const test = require("node:test");
const assert = require("node:assert/strict");
const { createMassiveFuturesClient, normalizeTradePrice } = require("../massive-futures-v1");

class NoopWebSocket {
  static OPEN = 1;
  constructor() { this.readyState = 0; }
  addEventListener() {}
  close() {}
}

test("normalizes an integer encoded websocket trade against the live quote", () => {
  assert.equal(normalizeTradePrice(606450, 6064.5), 6064.5);
  assert.equal(normalizeTradePrice(70.25, 70.24), 70.25);
});

test("selects a front contract outside the roll window and maps events", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("sort"), "ticker.asc");
    const product = url.searchParams.get("product_code");
    const results = product === "CL"
      ? [
          { ticker: "CLV6", product_code: "CL", active: true, days_to_maturity: 3, last_trade_date: "2026-09-20", type: "single" },
          { ticker: "CLX6", product_code: "CL", active: true, days_to_maturity: 34, last_trade_date: "2026-10-20", type: "single", trade_tick_size: 0.01 }
        ]
      : [{ ticker: "BZX6", product_code: "BZ", active: true, days_to_maturity: 31, last_trade_date: "2026-10-30", type: "single" }];
    return { ok: true, status: 200, json: async () => ({ status: "OK", results }) };
  };
  const client = createMassiveFuturesClient({
    apiKey: "test-key",
    fetchImpl,
    WebSocketImpl: NoopWebSocket,
    now: () => Date.parse("2026-09-17T12:00:00Z")
  });

  await client.refreshContracts();
  assert.equal(client.getState().contracts.CL.ticker, "CLX6");
  assert.equal(client.getState().contracts.BZ.ticker, "BZX6");

  const unscaledBeforeQuote = client.normalizeEvent({ ev: "T", sym: "CLX6", p: 7001, z: 2, s: 4, t: 999, q: 7 });
  assert.equal(unscaledBeforeQuote, null);
  assert.equal(client.getState().tradesDroppedBeforeQuote, 1);

  const quote = client.normalizeEvent({ ev: "Q", sym: "CLX6", bp: 70, bs: 10, ap: 70.02, as: 12, bt: 1002, at: 1003, t: 1000 });
  const trade = client.normalizeEvent({ ev: "T", sym: "CLX6", p: 7001, z: 2, s: 4, t: 1001, q: 8 });
  assert.deepEqual({ type: quote.type, productCode: quote.productCode, ticker: quote.ticker }, { type: "quote", productCode: "CL", ticker: "CLX6" });
  assert.equal(quote.timestamp, 1003);
  assert.equal(trade.price, 70.01);
  assert.equal(trade.size, 4);
});

test("stays explicitly offline without a key", async () => {
  const client = createMassiveFuturesClient({ apiKey: "", WebSocketImpl: NoopWebSocket });
  await client.start();
  assert.equal(client.getState().configured, false);
  assert.equal(client.getState().connection, "offline");
});
