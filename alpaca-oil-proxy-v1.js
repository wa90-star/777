const DEFAULT_REST_URL = "https://data.alpaca.markets";
const DEFAULT_WS_URL = "wss://stream.data.alpaca.markets/v2/iex";
const HISTORY_REALTIME_GAP_MS = 16 * 60 * 1000;
const STALE_STREAM_MS = 3 * 60 * 1000;

const DEFAULT_PRODUCTS = {
  CL: {
    ticker: "USO",
    name: "United States Oil Fund",
    displayName: "WTI-Proxy (USO ETF)",
    proxyFor: "WTI Crude Oil"
  },
  BZ: {
    ticker: "BNO",
    name: "United States Brent Oil Fund",
    displayName: "Brent-Proxy (BNO ETF)",
    proxyFor: "Brent Crude Oil"
  }
};

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  if (typeof timer.unref === "function") timer.unref();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestampMs(value) {
  if (typeof value === "string" && /[T:-]/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n > 1e16) return Math.floor(n / 1e6);
  if (n > 1e14) return Math.floor(n / 1e3);
  return Math.floor(n);
}

function marketSessionOpen(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(new Date(timestamp));
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  if (weekday === "Sat" || weekday === "Sun") return false;
  const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value || 0);
  const clock = hour * 60 + minute;
  return clock >= 4 * 60 && clock <= 20 * 60;
}

function createAlpacaOilProxyClient({
  apiKey = process.env.APCA_API_KEY_ID,
  secretKey = process.env.APCA_API_SECRET_KEY,
  productCodes = ["CL", "BZ"],
  restUrl = process.env.ALPACA_DATA_URL || DEFAULT_REST_URL,
  websocketUrl = process.env.ALPACA_OIL_WS_URL || DEFAULT_WS_URL,
  fetchImpl = fetch,
  WebSocketImpl = WebSocket,
  now = () => Date.now(),
  onEvent = () => {},
  onStatus = () => {}
} = {}) {
  const products = Object.fromEntries(productCodes
    .filter((code) => DEFAULT_PRODUCTS[code])
    .map((code) => [code, DEFAULT_PRODUCTS[code]]));
  const tickerToProduct = new Map(Object.entries(products).map(([code, item]) => [item.ticker, code]));
  let socket = null;
  let stopped = true;
  let reconnectTimer = null;
  let watchdogTimer = null;
  let reconnectAttempt = 0;
  let lastMessageAt = 0;

  const contracts = Object.fromEntries(Object.entries(products).map(([productCode, item]) => [productCode, {
    productCode,
    ticker: item.ticker,
    name: item.name,
    displayName: item.displayName,
    proxyFor: item.proxyFor,
    instrumentType: "ETF proxy",
    venue: "IEX"
  }]));

  const state = {
    configured: Boolean(apiKey && secretKey),
    provider: "alpaca",
    source: "alpaca-iex-oil-etf-proxy",
    label: "Alpaca IEX Öl-ETF-Proxys",
    mode: "free-proxy",
    instrumentType: "etf-proxy",
    dataQuality: "real-time IEX-only ETF trades and quotes",
    limitations: [
      "USO and BNO are ETF proxies, not WTI/Brent futures",
      "IEX is a subset of US equity trading",
      "coverage follows US equity extended hours, not futures 24/6"
    ],
    connection: "idle",
    authenticated: false,
    sessionOpen: marketSessionOpen(now()),
    contracts,
    lastConnectedAt: null,
    lastMessageAt: null,
    lastContractRefreshAt: new Date(now()).toISOString(),
    lastError: null,
    reconnects: 0
  };

  function snapshot() {
    return { ...state, contracts: { ...state.contracts }, limitations: [...state.limitations] };
  }

  function publishStatus(patch = {}) {
    Object.assign(state, patch);
    onStatus(snapshot());
  }

  async function request(pathname, params = {}, timeout = 20000) {
    if (!state.configured) throw new Error("Alpaca API credentials are not configured");
    const url = new URL(pathname, restUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value == null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const t = timeoutSignal(timeout);
      try {
        const response = await fetchImpl(url, {
          headers: {
            Accept: "application/json",
            "APCA-API-KEY-ID": apiKey,
            "APCA-API-SECRET-KEY": secretKey,
            "User-Agent": "777-oil-proxy-monitor/1.0"
          },
          signal: t.signal
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          const error = new Error(data.message || `Alpaca HTTP ${response.status}`);
          error.retryable = response.status === 429 || response.status >= 500;
          throw error;
        }
        return data;
      } catch (error) {
        lastError = error;
        if (attempt >= 3 || error.retryable === false) throw error;
      } finally {
        t.clear();
      }
      await delay(500 * (2 ** (attempt - 1)));
    }
    throw lastError;
  }

  async function refreshContracts() {
    publishStatus({
      contracts,
      lastContractRefreshAt: new Date(now()).toISOString(),
      lastError: null
    });
    return contracts;
  }

  async function aggregates(ticker, { from, to, limit = 50000 } = {}) {
    if (!tickerToProduct.has(ticker)) throw new Error(`Unsupported oil proxy ticker ${ticker}`);
    const fromMs = timestampMs(from);
    const requestedToMs = timestampMs(to) || now();
    const toMs = Math.min(requestedToMs, now() - HISTORY_REALTIME_GAP_MS);
    if (!fromMs || toMs <= fromMs) return { status: "OK", results: [] };

    const results = [];
    const seenPageTokens = new Set();
    let pageToken = null;
    do {
      if (pageToken) {
        if (seenPageTokens.has(pageToken)) throw new Error("Alpaca repeated a historical pagination token");
        seenPageTokens.add(pageToken);
      }
      const remaining = Math.max(1, Math.min(10000, Number(limit) - results.length));
      const data = await request(`/v2/stocks/${encodeURIComponent(ticker)}/bars`, {
        timeframe: "1Min",
        start: new Date(fromMs).toISOString(),
        end: new Date(toMs).toISOString(),
        limit: remaining,
        adjustment: "raw",
        feed: "iex",
        sort: "asc",
        page_token: pageToken
      }, 30000);
      for (const bar of data.bars || []) {
        const start = Date.parse(bar.t);
        if (!Number.isFinite(start)) continue;
        results.push({
          ticker,
          window_start: (BigInt(start) * 1000000n).toString(),
          open: Number(bar.o),
          high: Number(bar.h),
          low: Number(bar.l),
          close: Number(bar.c),
          volume: Number(bar.v || 0),
          transactions: Number(bar.n || 0),
          vwap: Number(bar.vw || 0)
        });
        if (results.length >= Number(limit)) break;
      }
      pageToken = results.length < Number(limit) ? data.next_page_token : null;
    } while (pageToken);
    return { status: "OK", results };
  }

  function normalizeEvent(raw) {
    const productCode = tickerToProduct.get(raw?.S);
    if (!productCode) return null;
    const timestamp = Date.parse(raw.t);
    if (!Number.isFinite(timestamp)) return null;
    if (raw.T === "q") {
      return {
        type: "quote",
        provider: "alpaca",
        productCode,
        ticker: raw.S,
        bid: Number(raw.bp || 0),
        bidSize: Number(raw.bs || 0) * 100,
        ask: Number(raw.ap || 0),
        askSize: Number(raw.as || 0) * 100,
        timestamp
      };
    }
    if (raw.T === "t") {
      return {
        type: "trade",
        provider: "alpaca",
        productCode,
        ticker: raw.S,
        price: Number(raw.p || 0),
        size: Number(raw.s || 0),
        timestamp,
        sequence: raw.i || null
      };
    }
    return null;
  }

  function clearReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect(reason) {
    if (stopped || reconnectTimer) return;
    reconnectAttempt += 1;
    const delay = Math.min(60000, 1000 * (2 ** Math.min(reconnectAttempt - 1, 6))) + Math.floor(Math.random() * 500);
    publishStatus({
      connection: "reconnecting",
      authenticated: false,
      lastError: reason,
      reconnects: state.reconnects + 1
    });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch((error) => scheduleReconnect(error.message));
    }, delay);
    if (typeof reconnectTimer.unref === "function") reconnectTimer.unref();
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
      lastMessageAt = now();
      state.lastMessageAt = new Date(lastMessageAt).toISOString();
      if (message?.T === "success" && message.msg === "connected") {
        socket.send(JSON.stringify({ action: "auth", key: apiKey, secret: secretKey }));
        continue;
      }
      if (message?.T === "success" && message.msg === "authenticated") {
        reconnectAttempt = 0;
        publishStatus({
          connection: "connected",
          authenticated: true,
          sessionOpen: marketSessionOpen(now()),
          lastConnectedAt: new Date(now()).toISOString(),
          lastError: null
        });
        const symbols = Object.values(products).map((item) => item.ticker);
        socket.send(JSON.stringify({ action: "subscribe", trades: symbols, quotes: symbols }));
        continue;
      }
      if (message?.T === "error") {
        publishStatus({
          connection: "error",
          authenticated: false,
          lastError: message.msg || `Alpaca stream error ${message.code || "unknown"}`
        });
        continue;
      }
      const event = normalizeEvent(message);
      if (event) onEvent(event);
    }
  }

  async function connect() {
    if (stopped || !state.configured) return;
    clearReconnect();
    publishStatus({ connection: "connecting", authenticated: false, sessionOpen: marketSessionOpen(now()) });
    socket = new WebSocketImpl(websocketUrl);
    socket.addEventListener("message", (event) => handleMessages(event.data));
    socket.addEventListener("error", () => {
      publishStatus({ connection: "error", authenticated: false, lastError: "Alpaca WebSocket error" });
    });
    socket.addEventListener("close", (event) => {
      socket = null;
      if (!stopped) scheduleReconnect(`Alpaca WebSocket closed (${event.code || "unknown"})`);
    });
  }

  async function start() {
    if (!state.configured) {
      publishStatus({ connection: "offline", lastError: "Alpaca API credentials missing" });
      return;
    }
    if (!stopped) return;
    stopped = false;
    await refreshContracts();
    watchdogTimer = setInterval(() => {
      const sessionOpen = marketSessionOpen(now());
      state.sessionOpen = sessionOpen;
      if (sessionOpen && state.authenticated && lastMessageAt && now() - lastMessageAt > STALE_STREAM_MS) {
        if (socket) {
          try { socket.close(1000, "stale-stream"); } catch {}
        }
        socket = null;
        scheduleReconnect("stale-stream");
      }
    }, 30000);
    if (typeof watchdogTimer.unref === "function") watchdogTimer.unref();
    await connect();
  }

  function stop() {
    stopped = true;
    clearReconnect();
    if (watchdogTimer) clearInterval(watchdogTimer);
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
    aggregates,
    normalizeEvent,
    getState: snapshot
  };
}

module.exports = {
  createAlpacaOilProxyClient,
  marketSessionOpen,
  timestampMs
};
