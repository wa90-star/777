const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createAlpacaOilProxyClient,
  marketSessionOpen,
  timestampMs
} = require("../alpaca-oil-proxy-v1");

class FakeWebSocket {
  static OPEN = 1;
  static instance = null;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.OPEN;
    this.handlers = new Map();
    this.sent = [];
    FakeWebSocket.instance = this;
  }

  addEventListener(name, handler) {
    this.handlers.set(name, handler);
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  emit(name, payload) {
    this.handlers.get(name)?.(payload);
  }

  close() {}
}

test("maps Alpaca IEX trades and round-lot quotes to the oil proxy products", () => {
  const client = createAlpacaOilProxyClient({
    apiKey: "key",
    secretKey: "secret",
    WebSocketImpl: FakeWebSocket
  });
  const quote = client.normalizeEvent({
    T: "q",
    S: "USO",
    bp: 80.1,
    bs: 2,
    ap: 80.12,
    as: 3,
    t: "2026-09-18T14:00:00.123456789Z"
  });
  const trade = client.normalizeEvent({
    T: "t",
    S: "BNO",
    p: 31.25,
    s: 40,
    i: 99,
    t: "2026-09-18T14:00:01Z"
  });

  assert.deepEqual(
    { type: quote.type, productCode: quote.productCode, ticker: quote.ticker, bidSize: quote.bidSize, askSize: quote.askSize },
    { type: "quote", productCode: "CL", ticker: "USO", bidSize: 200, askSize: 300 }
  );
  assert.deepEqual(
    { type: trade.type, productCode: trade.productCode, ticker: trade.ticker, price: trade.price, size: trade.size },
    { type: "trade", productCode: "BZ", ticker: "BNO", price: 31.25, size: 40 }
  );
  assert.equal(client.normalizeEvent({ T: "t", S: "SPY", p: 1, s: 1, t: "2026-09-18T14:00:01Z" }), null);
});

test("authenticates one free IEX stream and subscribes only to USO and BNO", async () => {
  const statuses = [];
  const client = createAlpacaOilProxyClient({
    apiKey: "key",
    secretKey: "secret",
    WebSocketImpl: FakeWebSocket,
    now: () => Date.parse("2026-09-18T14:00:00Z"),
    onStatus: (state) => statuses.push(state)
  });

  await client.start();
  const socket = FakeWebSocket.instance;
  socket.emit("message", { data: JSON.stringify([{ T: "success", msg: "connected" }]) });
  socket.emit("message", { data: JSON.stringify([{ T: "success", msg: "authenticated" }]) });

  assert.deepEqual(socket.sent[0], { action: "auth", key: "key", secret: "secret" });
  assert.deepEqual(socket.sent[1], {
    action: "subscribe",
    trades: ["USO", "BNO"],
    quotes: ["USO", "BNO"]
  });
  assert.equal(client.getState().authenticated, true);
  assert.equal(client.getState().mode, "free-proxy");
  assert.equal(statuses.at(-1).connection, "connected");
  client.stop();
});

test("loads paginated historical IEX minute bars and preserves trade counts", async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    const page = url.searchParams.get("page_token");
    return {
      ok: true,
      status: 200,
      json: async () => page
        ? {
            bars: [{ t: "2026-09-18T13:01:00Z", o: 80.1, h: 80.2, l: 80.05, c: 80.15, v: 90, n: 7, vw: 80.14 }],
            next_page_token: null
          }
        : {
            bars: [{ t: "2026-09-18T13:00:00Z", o: 80, h: 80.1, l: 79.9, c: 80.05, v: 100, n: 8, vw: 80.02 }],
            next_page_token: "next"
          }
    };
  };
  const now = Date.parse("2026-09-18T15:00:00Z");
  const client = createAlpacaOilProxyClient({
    apiKey: "key",
    secretKey: "secret",
    fetchImpl,
    WebSocketImpl: FakeWebSocket,
    now: () => now
  });
  const data = await client.aggregates("USO", {
    from: (BigInt(Date.parse("2026-09-18T12:00:00Z")) * 1000000n).toString(),
    to: (BigInt(now) * 1000000n).toString(),
    limit: 10
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].searchParams.get("feed"), "iex");
  assert.equal(calls[0].searchParams.get("timeframe"), "1Min");
  assert.equal(Date.parse(calls[0].searchParams.get("end")), now - 16 * 60 * 1000);
  assert.equal(data.results.length, 2);
  assert.equal(data.results[0].transactions, 8);
  assert.equal(timestampMs(data.results[0].window_start), Date.parse("2026-09-18T13:00:00Z"));
});

test("recognizes the free proxy session and stays offline without credentials", async () => {
  assert.equal(marketSessionOpen(Date.parse("2026-09-18T14:00:00Z")), true);
  assert.equal(marketSessionOpen(Date.parse("2026-09-19T14:00:00Z")), false);
  const client = createAlpacaOilProxyClient({ apiKey: "", secretKey: "", WebSocketImpl: FakeWebSocket });
  await client.start();
  assert.equal(client.getState().configured, false);
  assert.equal(client.getState().connection, "offline");
});
