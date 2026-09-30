const test = require("node:test");
const assert = require("node:assert/strict");
const { createTelegramTransport, redactError } = require("../telegram-transport-v1");

const token = "123456:private-test-token";
const chatId = "-100987654321";
const response = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

test("records a confirmed Telegram receipt and clears consecutive failures after recovery", async () => {
  let clock = Date.parse("2026-09-30T20:59:00Z");
  const requests = [];
  let healthy = false;
  const transport = createTelegramTransport({ token, chatId, now: () => clock,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return healthy ? response(200, { ok: true, result: { message_id: 7 } }) : response(503, { ok: false, description: "Service unavailable" });
    }
  });
  assert.deepEqual(transport.getState(), { configured: true, lastAttemptAt: null, lastSuccessAt: null, lastError: null, failureCount: 0 });
  await assert.rejects(transport.send("test message"), /HTTP 503: Service unavailable/);
  assert.equal(transport.getState().failureCount, 1);
  assert.equal(transport.getState().lastSuccessAt, null);
  healthy = true;
  clock += 1000;
  assert.deepEqual(await transport.send("test message"), { message_id: 7 });
  assert.deepEqual(transport.getState(), {
    configured: true, lastAttemptAt: "2026-09-30T20:59:01.000Z", lastSuccessAt: "2026-09-30T20:59:01.000Z", lastError: null, failureCount: 0
  });
  assert.equal(requests[1].url, `https://api.telegram.org/bot${token}/sendMessage`);
  assert.equal(requests[1].options.method, "POST");
  assert.deepEqual(JSON.parse(requests[1].options.body), { chat_id: chatId, text: "test message", disable_web_page_preview: true });
  assert.equal(JSON.stringify(transport.getState()).includes(token), false);
  assert.equal(JSON.stringify(transport.getState()).includes(chatId), false);
});

test("401 is a delivery failure with the exact HTTP and API reason", async () => {
  const transport = createTelegramTransport({ token, chatId,
    fetchImpl: async () => response(401, { ok: false, error_code: 401, description: "Unauthorized" })
  });
  await assert.rejects(transport.send("test"), { message: "Telegram HTTP 401 (API 401): Unauthorized" });
  assert.equal(transport.getState().lastError, "Telegram HTTP 401 (API 401): Unauthorized");
  assert.equal(transport.getState().lastSuccessAt, null);
  assert.equal(transport.getState().failureCount, 1);
});

test("429 preserves retry_after and never resolves as sent or suppressed", async () => {
  const transport = createTelegramTransport({ token, chatId,
    fetchImpl: async () => response(429, { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 12 } })
  });
  await assert.rejects(transport.send("test"), { message: "Telegram HTTP 429 (API 429): Too Many Requests; retry_after=12s" });
  await assert.rejects(transport.send("test"), /HTTP 429/);
  assert.equal(transport.getState().failureCount, 2);
  assert.equal(transport.getState().lastSuccessAt, null);
});

test("429 exposes a sanitized numeric 600-second retry delay for the durable outbox", async () => {
  const transport = createTelegramTransport({ token, chatId,
    fetchImpl: async () => response(429, { ok: false, error_code: 429,
      description: `Too Many Requests ${token} ${chatId}`, parameters: { retry_after: 600, secret: token } })
  });
  await assert.rejects(transport.send("test"), (error) => {
    assert.equal(error.retryAfterMs, 600000);
    assert.equal(error.message.includes(token), false);
    assert.equal(error.message.includes(chatId), false);
    assert.deepEqual(Object.keys(error), ["retryAfterMs"]);
    assert.equal(transport.getState().lastError, error.message);
    return true;
  });
});

test("retry metadata is numeric, finite and nonnegative; message text is never parsed", async () => {
  for (const seconds of [undefined, "600", -1, NaN, Infinity, Number.MAX_VALUE]) {
    const transport = createTelegramTransport({ token, chatId,
      fetchImpl: async () => response(429, { ok: false, description: "retry_after=600s", parameters: { retry_after: seconds } })
    });
    await assert.rejects(transport.send("test"), (error) => {
      assert.equal(Object.hasOwn(error, "retryAfterMs"), false);
      return true;
    });
  }
  const transport = createTelegramTransport({ token, chatId,
    fetchImpl: async () => response(429, { ok: false, parameters: { retry_after: 0 } })
  });
  await assert.rejects(transport.send("test"), (error) => error.retryAfterMs === 0);
});

test("timeout aborts the request and reports a bounded failure", async () => {
  let signal;
  const transport = createTelegramTransport({ token, chatId, timeoutMs: 10,
    fetchImpl: async (_url, options) => { signal = options.signal; return new Promise(() => {}); }
  });
  await assert.rejects(transport.send("test"), { message: "Telegram timeout after 10ms" });
  assert.equal(signal.aborted, true);
  assert.equal(transport.getState().failureCount, 1);
  assert.equal(transport.getState().lastSuccessAt, null);
});

test("timeout also covers stalled response bodies", async () => {
  const transport = createTelegramTransport({ token, chatId, timeoutMs: 10,
    fetchImpl: async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) })
  });
  await assert.rejects(transport.send("test"), /timeout after 10ms/);
  assert.equal(transport.getState().lastSuccessAt, null);
});

test("HTTP 200 without a valid Telegram receipt cannot count as a delivery", async () => {
  const transport = createTelegramTransport({ token, chatId,
    fetchImpl: async () => response(200, { ok: true })
  });
  await assert.rejects(transport.send("test"), /missing sendMessage receipt/);
  assert.equal(transport.getState().lastSuccessAt, null);
});

test("malformed response reports its HTTP status without raw response content", async () => {
  const transport = createTelegramTransport({ token, chatId,
    fetchImpl: async () => ({ ok: false, status: 502, json: async () => { throw new Error(`invalid ${token}`); } })
  });
  await assert.rejects(transport.send("test"), { message: "Telegram HTTP 502: invalid JSON response" });
});

test("configuration failures do not send requests", async () => {
  let calls = 0;
  const transport = createTelegramTransport({ token: "", chatId, fetchImpl: async () => { calls++; } });
  await assert.rejects(transport.send("test"), /Telegram not configured/);
  assert.equal(calls, 0);
  assert.equal(transport.getState().configured, false);
  assert.equal(transport.getState().failureCount, 1);
});

test("network and API errors redact tokens/chat ids before throwing or publishing", async () => {
  const transport = createTelegramTransport({ token, chatId,
    fetchImpl: async () => { throw new Error(`Failed https://api.telegram.org/bot${token}/sendMessage chat=${chatId}\n${"detail ".repeat(100)}`); }
  });
  await assert.rejects(transport.send("test"), (error) => {
    assert.equal(error.message.includes(token), false);
    assert.equal(error.message.includes(chatId), false);
    assert.equal(error.message.includes("\n"), false);
    assert.ok(error.message.length <= 400);
    assert.equal(transport.getState().lastError, error.message);
    return true;
  });
  assert.equal(redactError("https://example.org/?apikey=other-secret&symbol=USO"), "https://example.org/?apikey=[redacted]&symbol=USO");
});
