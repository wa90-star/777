"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { redactError } = require("./telegram-transport-v1");

function createDeliveryProbe({ id = process.env.RADAR_DELIVERY_PROBE_ID, directory = process.env.RADAR_DATA_DIR || "/data", transport, io = fs } = {}) {
  const state = { requested: Boolean(id), status: id ? "PENDING" : "DISABLED", providerAcceptedAt: null, messageId: null, error: null };
  let pending, stopped = false;
  async function run() {
    if (stopped || !id || state.status === "CONFIRMED") return;
    if (pending) return pending;
    pending = (async () => {
      try {
        if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id)) throw new Error("Invalid probe identifier");
        if (!transport?.configured()) throw new Error("Telegram not configured");
        await transport.verifyTarget();
        const targetFingerprint = transport.identityFingerprint();
        if (!/^[a-f0-9]{64}$/.test(targetFingerprint || "")) throw new Error("Missing probe target fingerprint");
        const file = path.join(directory, `delivery-probe-${id}.json`);
        try {
          const prior = JSON.parse(await io.readFile(file, "utf8"));
          if (prior.id !== id || prior.provider !== "telegram" || !Number.isInteger(prior.messageId) || prior.messageId <= 0 || typeof prior.providerAcceptedAt !== "string" || !Number.isFinite(Date.parse(prior.providerAcceptedAt))) throw new Error("Stored probe receipt is invalid");
          if (prior.targetFingerprint !== targetFingerprint) throw new Error("Probe target changed; use a new probe identifier");
          Object.assign(state, { status: "CONFIRMED", messageId: prior.messageId, providerAcceptedAt: prior.providerAcceptedAt }); return;
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (stopped) return;
        const result = await transport.send(`RADAR | Verbindungstest\nDer kostenlose Meldeweg für Aktienradar und Energy Fuels ist erreichbar.\nDies ist eine technische Prüfnachricht, kein Börsensignal.\nTestkennung: ${id}`);
        if (!Number.isInteger(result?.message_id) || result.message_id <= 0) throw new Error("Probe receipt missing");
        const receipt = { id, provider: "telegram", targetFingerprint, messageId: result.message_id, providerAcceptedAt: new Date().toISOString(), deviceReadConfirmed: false };
        await io.mkdir(directory, { recursive: true });
        const temporary = `${file}.${randomUUID()}.tmp`;
        const handle = await io.open(temporary, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); } finally { await handle.close(); }
        await io.rename(temporary, file);
        if (process.platform !== "win32") { const dir = await io.open(directory, "r"); try { await dir.sync(); } finally { await dir.close(); } }
        Object.assign(state, { status: "CONFIRMED", messageId: receipt.messageId, providerAcceptedAt: receipt.providerAcceptedAt, error: null });
      } catch (error) { state.status = "FAILED"; state.error = redactError(error); }
    })();
    try { return await pending; } finally { pending = null; }
  }
  return { run, stop: async () => { stopped = true; await pending; }, getState: () => ({ ...state, deviceReadConfirmed: false,
    deliveryLimitation: "Bei Abbruch nach Anbieterannahme und vor Speicherung kann der Verbindungstest beim Neustart doppelt ankommen." }) };
}
module.exports = { createDeliveryProbe };
