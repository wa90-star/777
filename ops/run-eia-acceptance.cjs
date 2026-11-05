"use strict";
// Standalone, opt-in acceptance test. Never import into the running radar server.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const COMMIT = "8b4f34195a0605be0b27ed454875dd2b49f9cd8a";
const RUN_ID = "general-eia-acceptance-20261105-v1";
const PINS = Object.freeze({
  "eia-v4.js": "5d22a487e3150cea31872fe41b27e8d97786cc160914182bf81db4a1fd90f3f8",
  "delivery-outbox-v1.js": "059a997d05888b06416733649879159678ab86136fa641778ac1427fd40cc56e",
  "general-information-v1.js": "14faf30de66e06ebd7e10b2396ac261623b6d633d4f8ac024e6836021117f65e",
  "signal-ownership-v1.js": "ddb9d3f4e1691c37e7715748695af7eebbcf7931b7fc8f56227396e2440c657c",
  "durable-state-v1.js": "50f8b8ef4221e9600aca0b4758e3df99ef0d4fe19f67e71d7433b31aca5302ab",
  "telegram-transport-v1.js": "d9c0f1bf4844cfc61fe3b976bca0ad1e282b2c310bc7a58827063dc4bdb727ba"
});
const FEEDS = ["https://www.eia.gov/about/new/WNtest3.php", "https://www.eia.gov/rss/press_rss.xml"];
const ARTICLE = Object.freeze({ id: "eia:https://www.eia.gov/petroleum/marketing/monthly/",
  url: "https://www.eia.gov/petroleum/marketing/monthly/", title: "Petroleum Marketing Monthly",
  publishedAt: "Mon, 02 Nov 2026 00:00:00 EST" });
const ORIGINAL_LABEL = "Einordnung: im Radar neu erkanntes Quellenereignis; Kursreaktion nicht bestätigt.";
const TEST_LABEL = "Einordnung: Test-Wiederverarbeitung einer bereits bekannten Originalquelle; keine neue Börsenmeldung. Kursreaktion nicht bestätigt.";
const sha256 = value => createHash("sha256").update(value).digest("hex");
const stamp = () => new Date().toISOString();
function fail(code) { const error = new Error(code); error.safeCode = code; throw error; }
function ensure(condition, code) { if (!condition) fail(code); }

function checkedDirectory(directory, create = false) {
  ensure(typeof directory === "string" && path.isAbsolute(directory), "absolute-directory-required");
  const absolute = path.resolve(directory), root = path.parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (create && !fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    ensure(stat.isDirectory() && !stat.isSymbolicLink(), "directory-link-or-type-rejected");
  }
  return absolute;
}
function checkFile(file, mustExist = true) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT" && !mustExist) return false; throw error; }
  ensure(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "file-link-or-type-rejected");
  ensure(stat.size <= 4 * 1024 * 1024, "local-file-too-large");
  return true;
}
function readJson(file) { checkFile(file); return JSON.parse(fs.readFileSync(file, "utf8")); }
function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function createExclusive(file, value) {
  checkFile(file, false);
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}
function verifyModules(appDir) {
  checkedDirectory(appDir);
  for (const [name, pin] of Object.entries(PINS)) {
    const file = path.join(appDir, name); checkFile(file);
    ensure(sha256(fs.readFileSync(file)) === pin, "production-module-hash-mismatch");
    ensure(!require.cache[file], "module-already-loaded-use-separate-process");
  }
}
async function boundedResponse(fetchImpl, url, options, limit, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetchImpl(url, { ...options, redirect: "error", signal });
  ensure(!response.redirected && (!response.url || response.url === url), "unexpected-response-origin");
  ensure(!Number.isFinite(Number(response.headers.get("content-length"))) || Number(response.headers.get("content-length")) <= limit, "response-too-large");
  const chunks = []; let size = 0;
  const reader = response.body?.getReader();
  try {
    if (reader) for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; ensure(size <= limit, "response-too-large"); chunks.push(Buffer.from(value));
    }
  } finally { if (reader) await reader.cancel().catch(() => {}); }
  return { response, body: Buffer.concat(chunks), size };
}
function assertArticle(item, baseline) {
  ensure(item && Object.entries(ARTICLE).every(([key, value]) => item[key] === value), "known-original-article-not-found");
  const age = Date.now() - Date.parse(item.publishedAt);
  ensure(age >= 0 && age <= 14 * 86400000, "known-article-outside-production-age-window");
  ensure(item.priority === "HIGH" && item.score >= 80 && item.baseline === baseline, "production-qualification-not-confirmed");
}
function receiptFrom(snapshot) {
  ensure(snapshot.primed === true && Array.isArray(snapshot.deliveryOutbox) && snapshot.deliveryOutbox.length === 1, "unexpected-outbox-shape");
  const entry = snapshot.deliveryOutbox[0]; assertArticle(entry.item, false);
  const delivery = entry.deliveries?.telegram;
  ensure(entry.id === ARTICLE.id && delivery?.status === "sent" && delivery.attempts === 1, "persistent-delivery-not-confirmed");
  ensure(/^[1-9]\d*$/.test(delivery.providerReceipt?.messageId || "") && Number.isFinite(Date.parse(delivery.acknowledgedAt)), "persistent-receipt-missing");
  ensure(snapshot.seen.some(([id]) => id === ARTICLE.id), "persistent-dedup-id-missing");
  return { provider: "telegram", messageId: delivery.providerReceipt.messageId, acknowledgedAt: delivery.acknowledgedAt };
}

async function runAcceptance({ appDir = "/app", dataRoot = process.env.RADAR_DATA_DIR || "/data", execute = false, fetchImpl = globalThis.fetch } = {}) {
  appDir = checkedDirectory(appDir); dataRoot = checkedDirectory(dataRoot);
  ensure(dataRoot !== path.parse(dataRoot).root, "filesystem-root-rejected");
  verifyModules(appDir);
  const directory = path.join(dataRoot, "acceptance", "general-eia-v1");
  const plan = { runId: RUN_ID, productionCommit: COMMIT, article: ARTICLE, directory,
    technicalReplay: true, maximumSendAttempts: 1, maximumSourceRequests: 2, maximumPrivateTargetChecks: 1,
    normalProductionStateChanged: false, codePins: PINS };
  if (!execute) return { status: "plan-only-no-network-no-writes", ...plan };
  checkedDirectory(directory, true);
  const file = name => path.join(directory, name);
  const stateFile = file("eia-state.json"), completeFile = file("CONFIRMED.json");
  // A completed invocation is read-only. Never silently reset a failed/ambiguous run.
  if (checkFile(completeFile, false)) {
    const proof = readJson(completeFile), receipt = receiptFrom(readJson(stateFile));
    ensure(proof.runId === RUN_ID && proof.receipt.messageId === receipt.messageId && proof.restartNoResendConfirmed === true, "existing-proof-invalid");
    return { status: "already-confirmed-no-network", runId: RUN_ID, receipt };
  }
  ensure(!fs.existsSync(file("RUN-STARTED.json")) && !fs.existsSync(stateFile) && !fs.existsSync(file("SEND-ATTEMPT-STARTED.json")), "existing-incomplete-run-requires-review-no-retry");
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  ensure(typeof token === "string" && /^[0-9]+:[A-Za-z0-9_-]+$/.test(token) && /^[1-9]\d{0,15}$/.test(chatId || "") && Number.isSafeInteger(Number(chatId)), "existing-private-telegram-configuration-required");
  createExclusive(file("RUN-STARTED.json"), { ...plan, startedAt: stamp() });
  const originalDataDir = process.env.RADAR_DATA_DIR, originalFetch = globalThis.fetch;
  const sourceReceipts = [], sourceCache = new Map(); let sourceCalls = 0, telegramChecks = 0, telegramSends = 0;
  let phase = "baseline", sendWrapperCalls = 0, receipt;
  try {
    process.env.RADAR_DATA_DIR = directory;
    const writeDurableState = require(path.join(appDir, "durable-state-v1.js"));
    const createEngine = require(path.join(appDir, "eia-v4.js"));
    const { createTelegramTransport } = require(path.join(appDir, "telegram-transport-v1.js"));
    const save = (name, value) => { const target = file(name); checkFile(target, false); return writeDurableState(target, value); };
    globalThis.fetch = async (url, options = {}) => {
      ensure(FEEDS.includes(url) && (!options.method || options.method === "GET"), "unapproved-source-request");
      if (phase === "baseline") {
        ensure(!sourceCache.has(url) && ++sourceCalls <= 2, "source-request-budget-exceeded");
        const { response, body, size } = await boundedResponse(fetchImpl, url, options, 1024 * 1024, 10000);
        ensure(response.status === 200, "source-http-failed");
        sourceCache.set(url, body);
        sourceReceipts.push({ url, fetchedAt: stamp(), status: response.status, bytes: size, sha256: sha256(body) });
      } else ensure(phase === "replay" && sourceCache.has(url), "unexpected-source-request-phase");
      return new Response(sourceCache.get(url), { status: 200 });
    };
    const transport = createTelegramTransport({ token, chatId, verifyPrivateTarget: true,
      fetchImpl: async (url, options) => {
        const endpoint = url === `https://api.telegram.org/bot${token}/getChat` ? "check" : url === `https://api.telegram.org/bot${token}/sendMessage` ? "send" : null;
        ensure(endpoint && options.method === "POST" && phase === "replay", "unapproved-telegram-request");
        if (endpoint === "check") ensure(++telegramChecks <= 1, "private-target-check-budget-exceeded");
        else ensure(++telegramSends <= 1 && checkFile(file("SEND-ATTEMPT-STARTED.json")), "telegram-send-budget-exceeded");
        const { response, body } = await boundedResponse(fetchImpl, url, options, 65536, 8000);
        return new Response(body, { status: response.status });
      }
    });
    const sendMessage = async text => {
      ensure(phase === "replay" && ++sendWrapperCalls === 1, "unexpected-delivery-attempt");
      const before = readJson(stateFile), entries = before.deliveryOutbox;
      ensure(entries?.length === 1 && entries[0].id === ARTICLE.id, "unexpected-replay-candidate");
      assertArticle(entries[0].item, false);
      ensure(entries[0].deliveries?.telegram?.status === "pending" && entries[0].deliveries.telegram.attempts === 1, "durable-intent-before-send-not-confirmed");
      ensure(text.includes(`Ereignis-ID: ${ARTICLE.id}`) && text.includes(`Veröffentlicht: ${ARTICLE.publishedAt}`) && text.includes(ORIGINAL_LABEL), "unexpected-production-message");
      const message = "TECHNISCHER DURCHLAUFTEST – KEINE NEUE BÖRSENWARNUNG\nBereits bekannte EIA-Originalquelle; einmalige Prüfung von Erkennung, Speicherung und Zustellung. Keine Handelsfreigabe.\n\n" + text.replace(ORIGINAL_LABEL, TEST_LABEL);
      createExclusive(file("SEND-ATTEMPT-STARTED.json"), { runId: RUN_ID, eventId: ARTICLE.id, attemptedAt: stamp(), durableIntentSha256: sha256(fs.readFileSync(stateFile)), testMessageSha256: sha256(message), maximumSendAttempts: 1 });
      try { return await transport.send(message); }
      catch { fail("telegram-attempt-unconfirmed-manual-review-no-retry"); }
    };
    const newEngine = () => {
      const engine = createEngine({ informationMode: true, telegramConfigured: () => phase === "replay" || phase === "verify", sendMessage });
      ensure(engine.getState().persistence === `persistent:${directory}`, "production-engine-storage-fallback-rejected");
      return engine;
    };
    let engine = newEngine(); await engine.scan();
    ensure(sourceReceipts.length === 2 && engine.getState().sources.eiaOfficial.ok === true, "both-real-feeds-required");
    const baseline = readJson(stateFile);
    ensure(baseline.primed === true && baseline.deliveryOutbox?.length === 0, "baseline-not-silent");
    assertArticle(baseline.items.find(item => item.id === ARTICLE.id), true);
    ensure(baseline.seen.some(([id]) => id === ARTICLE.id), "baseline-seen-id-missing");
    save("SOURCE-BASELINE.json", { runId: RUN_ID, article: ARTICLE, sourceReceipts, baselineSha256: sha256(fs.readFileSync(stateFile)), qualification: { priority: "HIGH", score: baseline.items.find(item => item.id === ARTICLE.id).score }, replayBytesUnchanged: true });
    // Explicit test-only replay: remove exactly one seen ID from this isolated state.
    baseline.seen = baseline.seen.filter(([id]) => id !== ARTICLE.id);
    writeDurableState(stateFile, baseline);
    phase = "replay"; engine = newEngine(); await engine.scan();
    receipt = receiptFrom(readJson(stateFile));
    ensure(telegramSends === 1 && telegramChecks === 1, "actual-transport-receipt-path-not-confirmed");
    phase = "verify"; engine = newEngine(); await engine.drainDeliveries();
    const rereadReceipt = receiptFrom(readJson(stateFile));
    ensure(rereadReceipt.messageId === receipt.messageId && sendWrapperCalls === 1 && telegramSends === 1 && engine.getState().informationDeliveryStatus.sent === 1, "restart-dedup-proof-failed");
    const proof = { ...plan, status: "confirmed-technical-replay", confirmedAt: stamp(), sourceReceipts, sourceCalls,
      telegramChecks, telegramSendAttempts: telegramSends, receipt, restartNoResendConfirmed: true,
      normalMarketWarning: false, executionEligible: false, stateSha256: sha256(fs.readFileSync(stateFile)),
      scope: "Unchanged EIA ingestion, qualification, durable outbox and Telegram transport; isolated replay, not spontaneous production delivery or all other source branches." };
    createExclusive(completeFile, proof);
    return { status: proof.status, runId: RUN_ID, receipt, restartNoResendConfirmed: true, normalMarketWarning: false };
  } catch (error) {
    // Leave the durable lock/attempt in place. Never log a provider error or credential-bearing URL.
    fail(error.safeCode || "acceptance-incomplete-manual-review-no-retry");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDataDir === undefined) delete process.env.RADAR_DATA_DIR; else process.env.RADAR_DATA_DIR = originalDataDir;
  }
}
if (require.main === module) {
  const args = process.argv.slice(2), options = {};
  try {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--execute") options.execute = true;
      else if (["--app-dir", "--data-root"].includes(args[i]) && args[i + 1]) options[args[i++] === "--app-dir" ? "appDir" : "dataRoot"] = args[i];
      else fail("unsupported-argument");
    }
    runAcceptance(options).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
      console.error(JSON.stringify({ status: "blocked-or-incomplete", code: error.safeCode || "acceptance-failed-no-retry" })); process.exitCode = 1;
    });
  } catch (error) { console.error(JSON.stringify({ status: "blocked", code: error.safeCode || "invalid-arguments" })); process.exitCode = 1; }
}
module.exports = { runAcceptance, PINS, ARTICLE, RUN_ID };
