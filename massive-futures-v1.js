const DEFAULT_REST_URL = "https://api.massive.com";
const DEFAULT_WS_URL = "wss://socket.massive.com/futures";
const CONTRACT_REFRESH_MS = 6 * 60 * 60 * 1000;
const STALE_STREAM_MS = 3 * 60 * 1000;
const MIN_ROLL_DAYS = 5;

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  if (typeof timer.unref === "function") timer.unref();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function utcDate(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function boundedNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeTradePrice(rawValue, referenceValue) {
  const raw = boundedNumber(rawValue);
  const reference = boundedNumber(referenceValue);
  if (raw <= 0 || reference <= 0) return raw;
  const directDistance = Math.abs(Math.log(raw / reference));
  let best = raw;
  let bestDistance = directDistance;
  for (let exponent = -6; exponent <= 6; exponent += 1) {
    const candidate = raw * (10 ** exponent);
    if (candidate <= 0) continue;
    const distance = Math.abs(Math.log(candidate / reference));
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= Math.log(2) ? best : raw;
}

function createMassiveFuturesClient({
  apiKey = process.env.MASSIVE_API_KEY,
  productCodes = ["CL", "BZ"],
  restUrl = process.env.MASSIVE_REST_URL || DEFAULT_REST_URL,
  websocketUrl = process.env.MASSIVE_WS_URL || DEFAULT_WS_URL,
  fetchImpl = fetch,
  WebSocketImpl = WebSocket,
  now = () => Date.now(),
  onEvent = () => {},
  onStatus = () => {}
} = {}) {
  let socket = null;
  let stopped = true;
  let reconnectTimer = null;
  let contractTimer = null;
  let watchdogTimer = null;
  let reconnectAttempt = 0;
  let lastMessageAt = 0;
  const references = new Map();

  const state = {
    configured: Boolean(apiKey),
    provider: "massive",
    mode: websocketUrl.includes("delayed") ? "delayed" : "real-time",
    connection: "idle",
    authenticated: false,
    contracts: {},
    lastConnectedAt: null,
    lastMessageAt: null,
    lastContractRefreshAt: null,
    lastError: null,
    reconnects: 0,
    tradesDroppedBeforeQuote: 0
  };

  function publishStatus(patch = {}) {
    Object.assign(state, patch);
    onStatus({ ...state, contracts: { ...state.contracts } });
  }

  async function request(pathname, params = {}, timeout = 15000) {
    if (!apiKey) throw new Error("Massive API key is not configured");
    const url = new URL(pathname, restUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value == null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    url.searchParams.set("apiKey", apiKey);
    const t = timeoutSignal(timeout);
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": "777-trump-oil-monitor/1.0" },
        signal: t.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.status === "ERROR") {
        throw new Error(data.error || data.message || `Massive HTTP ${response.status}`);
      }
      return data;
    } finally {
      t.clear();
    }
  }

  async function contractsFor(productCode, date = utcDate(now())) {
    const data = await request("/futures/v1/contracts", {
      product_code: productCode,
      date,
      active: true,
      type: "single",
      limit: 1000,
      sort: "ticker.asc"
    });
    return (data.results || [])
      .filter((item) => item?.ticker && item.active !== false)
      .sort((a, b) => {
        const aDays = boundedNumber(a.days_to_maturity, Number.MAX_SAFE_INTEGER);
        const bDays = boundedNumber(b.days_to_maturity, Number.MAX_SAFE_INTEGER);
        return aDays - bDays;
      });
  }

  function chooseFrontContract(contracts) {
    return contracts.find((item) => boundedNumber(item.days_to_maturity) >= MIN_ROLL_DAYS)
      || contracts[0]
      || null;
  }

  async function refreshContracts() {
    const next = {};
    for (const productCode of productCodes) {
      const contracts = await contractsFor(productCode);
      const selected = chooseFrontContract(contracts);
      if (!selected) throw new Error(`No active Massive contract for ${productCode}`);
      next[productCode] = {
        productCode,
        ticker: selected.ticker,
        name: selected.name || productCode,
        daysToMaturity: boundedNumber(selected.days_to_maturity, null),
        lastTradeDate: selected.last_trade_date || null,
        tradeTickSize: boundedNumber(selected.trade_tick_size, null),
        venue: selected.trading_venue || null
      };
    }
    const changed = JSON.stringify(next) !== JSON.stringify(state.contracts);
    publishStatus({ contracts: next, lastContractRefreshAt: new Date(now()).toISOString(), lastError: null });
    if (changed && socket && socket.readyState === WebSocketImpl.OPEN) reconnect("contract-roll");
    return next;
  }

  async function aggregates(ticker, {
    resolution = "1min",
    from,
    to,
    limit = 50000,
    sort = "window_start.asc"
  } = {}) {
    return request(`/futures/v1/aggs/${encodeURIComponent(ticker)}`, {
      resolution,
      "window_start.gte": from,
      "window_start.lte": to,
      limit,
      sort
    }, 30000);
  }

  async function latestTrade(ticker) {
    const data = await request(`/futures/v1/trades/${encodeURIComponent(ticker)}`, {
      limit: 1,
      sort: "timestamp.desc"
    });
    return data.results?.[0] || null;
  }

  async function latestQuote(ticker) {
    const data = await request(`/futures/v1/quotes/${encodeURIComponent(ticker)}`, {
      limit: 1,
      sort: "timestamp.desc"
    });
    return data.results?.[0] || null;
  }

  function referenceFor(ticker) {
    const ref = references.get(ticker) || {};
    const mid = ref.bid > 0 && ref.ask > 0 ? (ref.bid + ref.ask) / 2 : 0;
    return mid || ref.lastTrade || 0;
  }

  function normalizeEvent(raw) {
    if (!raw || !raw.ev || !raw.sym) return null;
    const productCode = Object.values(state.contracts).find((item) => item.ticker === raw.sym)?.productCode || null;
    if (!productCode) return null;
    if (raw.ev === "Q") {
      const event = {
        type: "quote",
        provider: "massive",
        productCode,
        ticker: raw.sym,
        bid: boundedNumber(raw.bp),
        bidSize: boundedNumber(raw.bs),
        ask: boundedNumber(raw.ap),
        askSize: boundedNumber(raw.as),
        bidTime: boundedNumber(raw.bt),
        askTime: boundedNumber(raw.at),
        timestamp: Math.max(boundedNumber(raw.t), boundedNumber(raw.bt), boundedNumber(raw.at))
      };
      references.set(raw.sym, {
        ...(references.get(raw.sym) || {}),
        bid: event.bid,
        ask: event.ask
      });
      return event;
    }
    if (raw.ev === "T") {
      const reference = referenceFor(raw.sym);
      if (raw.z != null && reference <= 0) {
        state.tradesDroppedBeforeQuote += 1;
        return null;
      }
      const price = normalizeTradePrice(raw.p, reference);
      references.set(raw.sym, { ...(references.get(raw.sym) || {}), lastTrade: price });
      return {
        type: "trade",
        provider: "massive",
        productCode,
        ticker: raw.sym,
        price,
        rawPrice: boundedNumber(raw.p),
        size: boundedNumber(raw.s),
        timestamp: boundedNumber(raw.t),
        sequence: boundedNumber(raw.q),
        priceScale: raw.z == null ? null : boundedNumber(raw.z)
      };
    }
    if (raw.ev === "A" || raw.ev === "AM") {
      return {
        type: raw.ev === "A" ? "second-aggregate" : "minute-aggregate",
        provider: "massive",
        productCode,
        ticker: raw.sym,
        open: boundedNumber(raw.o),
        high: boundedNumber(raw.h),
        low: boundedNumber(raw.l),
        close: boundedNumber(raw.c),
        volume: boundedNumber(raw.v),
        vwap: boundedNumber(raw.a),
        windowStart: boundedNumber(raw.s),
        windowEnd: boundedNumber(raw.e),
        timestamp: boundedNumber(raw.e) || boundedNumber(raw.s)
      };
    }
    return null;
  }

  function subscriptions() {
    return Object.values(state.contracts)
      .flatMap((contract) => [`T.${contract.ticker}`, `Q.${contract.ticker}`, `A.${contract.ticker}`])
      .join(",");
  }

  function clearReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect(reason) {
    if (stopped || reconnectTimer) return;
    reconnectAttempt += 1;
    const delay = Math.min(60000, 1000 * (2 ** Math.min(reconnectAttempt - 1, 6))) + Math.floor(Math.random() * 500);
    publishStatus({ connection: "reconnecting", authenticated: false, lastError: reason, reconnects: state.reconnects + 1 });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch((error) => scheduleReconnect(error.message));
    }, delay);
    if (typeof reconnectTimer.unref === "function") reconnectTimer.unref();
  }

  function reconnect(reason) {
    if (socket) {
      try { socket.close(1000, reason); } catch {}
    }
    socket = null;
    scheduleReconnect(reason);
  }

  function handleMessages(payload) {
    let messages;
    try {
      messages = JSON.parse(String(payload));
    } catch {
      return;
    }
    if (!Array.isArray(messages)) messages = [messages];
    for (const message of messages) {
      if (message?.ev === "status") {
        if (message.status === "connected") {
          socket.send(JSON.stringify({ action: "auth", params: apiKey }));
        } else if (message.status === "auth_success") {
          reconnectAttempt = 0;
          lastMessageAt = now();
          publishStatus({ connection: "connected", authenticated: true, lastConnectedAt: new Date(now()).toISOString(), lastError: null });
          socket.send(JSON.stringify({ action: "subscribe", params: subscriptions() }));
        } else if (message.status === "auth_failed" || message.status === "error") {
          publishStatus({ connection: "error", authenticated: false, lastError: message.message || message.status });
        }
        continue;
      }
      const event = normalizeEvent(message);
      if (!event) continue;
      lastMessageAt = now();
      state.lastMessageAt = new Date(lastMessageAt).toISOString();
      onEvent(event);
    }
  }

  async function connect() {
    if (stopped || !apiKey) return;
    clearReconnect();
    if (!Object.keys(state.contracts).length) await refreshContracts();
    publishStatus({ connection: "connecting", authenticated: false });
    socket = new WebSocketImpl(websocketUrl);
    socket.addEventListener("message", (event) => handleMessages(event.data));
    socket.addEventListener("error", () => {
      publishStatus({ connection: "error", authenticated: false, lastError: "Massive WebSocket error" });
    });
    socket.addEventListener("close", (event) => {
      socket = null;
      if (!stopped) scheduleReconnect(`Massive WebSocket closed (${event.code || "unknown"})`);
    });
  }

  function startTimers() {
    contractTimer = setInterval(() => {
      refreshContracts().catch((error) => publishStatus({ lastError: error.message }));
    }, CONTRACT_REFRESH_MS);
    watchdogTimer = setInterval(() => {
      if (!stopped && state.authenticated && lastMessageAt && now() - lastMessageAt > STALE_STREAM_MS) {
        reconnect("stale-stream");
      }
    }, 30000);
    for (const timer of [contractTimer, watchdogTimer]) {
      if (typeof timer.unref === "function") timer.unref();
    }
  }

  async function start() {
    if (!apiKey) {
      publishStatus({ connection: "offline", lastError: "MASSIVE_API_KEY missing" });
      return;
    }
    if (!stopped) return;
    stopped = false;
    await refreshContracts();
    startTimers();
    await connect();
  }

  function stop() {
    stopped = true;
    clearReconnect();
    if (contractTimer) clearInterval(contractTimer);
    if (watchdogTimer) clearInterval(watchdogTimer);
    contractTimer = null;
    watchdogTimer = null;
    if (socket) {
      try { socket.close(1000, "shutdown"); } catch {}
    }
    socket = null;
    publishStatus({ connection: "stopped", authenticated: false });
  }

  return {
    start,
    stop,
    refreshContracts,
    contractsFor,
    aggregates,
    latestTrade,
    latestQuote,
    normalizeEvent,
    getState: () => ({ ...state, contracts: { ...state.contracts } })
  };
}

module.exports = {
  createMassiveFuturesClient,
  normalizeTradePrice
};
