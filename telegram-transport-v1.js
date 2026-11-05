const MAX_ERROR_LENGTH = 400;
const { createHash } = require("node:crypto");

function redactError(error, secrets = []) {
  let message = String(error?.message || error || "Unknown error");
  for (const secret of secrets.filter(Boolean).map(String).sort((a, b) => b.length - a.length)) {
    message = message.split(secret).join("[redacted]");
  }
  return message
    .replace(/(api\.telegram\.org\/bot)[^/\s]+/gi, "$1[redacted]")
    .replace(/([?&](?:api[_-]?key|token|secret)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, MAX_ERROR_LENGTH);
}

function createTelegramTransport({ token, chatId, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 8000, verifyPrivateTarget = false }) {
  const state = { lastAttemptAt: null, lastSuccessAt: null, lastError: null, failureCount: 0, targetVerifiedAt: null, targetType: null };
  const configured = () => Boolean(token && chatId);
  const timestamp = () => new Date(now()).toISOString();
  let verification = null;
  async function verifyTarget() {
    if (!configured()) throw new Error("Telegram not configured");
    if (!/^[1-9]\d{0,15}$/.test(String(chatId)) || !Number.isSafeInteger(Number(chatId))) throw new Error("Telegram requires the existing positive numeric private-chat target");
    if (state.targetVerifiedAt) return { verified: true, type: state.targetType };
    if (verification) return verification;
    verification = (async () => {
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/getChat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId }), signal: AbortSignal.timeout(timeoutMs)
      });
      const data = await response.json();
      if (!response.ok || data?.ok !== true || data.result?.type !== "private" || String(data.result?.id) !== String(chatId)) throw new Error("Telegram private target verification failed");
      state.targetVerifiedAt = timestamp(); state.targetType = "private";
      return { verified: true, type: "private" };
    })();
    try { return await verification; }
    catch (error) { throw new Error(redactError(error, [token, chatId])); }
    finally { verification = null; }
  }

  async function send(text) {
    state.lastAttemptAt = timestamp();
    const controller = new AbortController();
    let timer;
    let timedOut = false;
    try {
      if (!configured()) throw new Error("Telegram not configured");
      if (verifyPrivateTarget) await verifyTarget();
      const responseData = (async () => {
        const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
          signal: controller.signal
        });
        let data;
        try {
          data = await response.json();
        } catch {
          throw new Error(`Telegram HTTP ${response.status}: invalid JSON response`);
        }
        if (!response.ok || data?.ok !== true) {
          const code = Number.isInteger(data?.error_code) ? ` (API ${data.error_code})` : "";
          const seconds = data?.parameters?.retry_after;
          const validRetry = Number.isFinite(seconds) && seconds >= 0 && Number.isFinite(seconds * 1000);
          const retry = validRetry ? `; retry_after=${seconds}s` : "";
          const error = new Error(`Telegram HTTP ${response.status}${code}: ${data?.description || "sendMessage rejected"}${retry}`);
          if (validRetry) error.retryAfterMs = seconds * 1000;
          throw error;
        }
        if (!Number.isInteger(data.result?.message_id) || data.result.message_id <= 0) {
          throw new Error(`Telegram HTTP ${response.status}: missing sendMessage receipt`);
        }
        if (verifyPrivateTarget && (String(data.result?.chat?.id) !== String(chatId) || data.result?.chat?.type !== "private")) {
          throw new Error("Telegram receipt does not match verified private target");
        }
        return data.result;
      })();
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error(`Telegram timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      });
      const result = await Promise.race([responseData, timeout]);
      state.lastSuccessAt = timestamp();
      state.lastError = null;
      state.failureCount = 0;
      return result;
    } catch (error) {
      const message = timedOut ? `Telegram timeout after ${timeoutMs}ms` : redactError(error, [token, chatId]);
      state.lastError = message;
      state.failureCount += 1;
      // Callers must observe delivery failure, never a successful/suppressed result.
      const failure = new Error(message);
      if (!timedOut && Number.isFinite(error?.retryAfterMs) && error.retryAfterMs >= 0) {
        failure.retryAfterMs = error.retryAfterMs;
      }
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }

  return { send, configured, verifyTarget,
    identityFingerprint: () => configured() ? createHash("sha256").update(`${token}:${chatId}`).digest("hex") : null,
    getState: () => ({ configured: configured(), ...state }) };
}

module.exports = { createTelegramTransport, redactError };
