"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createDeliveryProbe } = require("../delivery-probe-v1");
const { createTelegramTransport } = require("../telegram-transport-v1");

const probeId = "isolated_probe_20261105";
const fakeToken = "123456:unit-test-token-not-a-credential";
const receiptPath = directory => path.join(directory, `delivery-probe-${probeId}.json`);

async function temporaryDirectory(t) {
  const base = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(base, "radar-delivery-probe-test-"));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), base);
    assert.ok(path.basename(resolved).startsWith("radar-delivery-probe-test-"));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return directory;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fakeTelegram({ token = fakeToken, chatId = "1234", verificationError = null, onSend } = {}) {
  const calls = [];
  const transport = createTelegramTransport({
    token, chatId, verifyPrivateTarget: true,
    fetchImpl: async (url, options) => {
      const method = url.endsWith("/getChat") ? "getChat" : "sendMessage";
      assert.ok(url === `https://api.telegram.org/bot${token}/${method}`);
      const body = JSON.parse(options.body);
      assert.equal(String(body.chat_id), chatId);
      assert.equal(body.allow_paid_broadcast, undefined);
      calls.push(method);
      if (method === "getChat") {
        if (verificationError) throw verificationError;
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: Number(chatId), type: "private" } }) };
      }
      if (onSend) await onSend(body);
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 78, chat: { id: Number(chatId), type: "private" } } }) };
    }
  });
  return { transport, calls };
}

async function seedReceipt(directory, transport, changes = {}) {
  const receipt = {
    id: probeId, provider: "telegram", targetFingerprint: transport.identityFingerprint(),
    messageId: 78, providerAcceptedAt: "2026-11-05T18:00:00.000Z", deviceReadConfirmed: false,
    ...changes
  };
  await fs.writeFile(receiptPath(directory), JSON.stringify(receipt), { mode: 0o600 });
  return receipt;
}

test("persists a real receipt file; restart re-verifies target and never resends the confirmed probe", async t => {
  const directory = await temporaryDirectory(t);
  const first = fakeTelegram();
  const probe = createDeliveryProbe({ id: probeId, directory, transport: first.transport });
  await probe.run();
  assert.equal(probe.getState().status, "CONFIRMED");
  assert.deepEqual(first.calls, ["getChat", "sendMessage"]);
  const serialized = await fs.readFile(receiptPath(directory), "utf8");
  const receipt = JSON.parse(serialized);
  assert.equal(receipt.id, probeId);
  assert.equal(receipt.provider, "telegram");
  assert.equal(receipt.messageId, 78);
  assert.equal(receipt.targetFingerprint, first.transport.identityFingerprint());
  assert.ok(Number.isFinite(Date.parse(receipt.providerAcceptedAt)));
  assert.equal(receipt.deviceReadConfirmed, false);
  assert.equal(serialized.includes(fakeToken), false);
  assert.equal(JSON.stringify(probe.getState()).includes(receipt.targetFingerprint), false);
  const restarted = fakeTelegram();
  const afterRestart = createDeliveryProbe({ id: probeId, directory, transport: restarted.transport });
  await afterRestart.run();
  await afterRestart.run();
  assert.equal(afterRestart.getState().status, "CONFIRMED");
  assert.equal(afterRestart.getState().messageId, receipt.messageId);
  assert.equal(afterRestart.getState().providerAcceptedAt, receipt.providerAcceptedAt);
  assert.deepEqual(restarted.calls, ["getChat"]);
  assert.equal(await fs.readFile(receiptPath(directory), "utf8"), serialized);
});

test("a different chat or bot fingerprint cannot reuse or overwrite an old probe confirmation", async t => {
  for (const change of [{ chatId: "5678" }, { token: "999999:another-unit-test-token" }]) {
    const directory = await temporaryDirectory(t);
    const original = fakeTelegram();
    await seedReceipt(directory, original.transport);
    const before = await fs.readFile(receiptPath(directory), "utf8");
    const changed = fakeTelegram(change);
    const probe = createDeliveryProbe({ id: probeId, directory, transport: changed.transport });
    await probe.run();
    assert.equal(probe.getState().status, "FAILED");
    assert.match(probe.getState().error, /target changed/);
    assert.equal(probe.getState().providerAcceptedAt, null);
    assert.deepEqual(changed.calls, ["getChat"]);
    assert.equal(await fs.readFile(receiptPath(directory), "utf8"), before);
  }
});

test("stored confirmation is not trusted when current private-target verification fails", async t => {
  const directory = await temporaryDirectory(t);
  const mock = fakeTelegram({ verificationError: new Error("simulated verification failure") });
  await seedReceipt(directory, mock.transport);
  const probe = createDeliveryProbe({ id: probeId, directory, transport: mock.transport });
  await probe.run();
  assert.equal(probe.getState().status, "FAILED");
  assert.equal(probe.getState().messageId, null);
  assert.deepEqual(mock.calls, ["getChat"]);
});

test("malformed stored receipts are never CONFIRMED and never trigger a replacement send", async t => {
  const invalid = [
    { name: "wrong id", changes: { id: "different_probe_id" } },
    { name: "zero message", changes: { messageId: 0 } },
    { name: "missing message", changes: { messageId: null } },
    { name: "missing time", changes: { providerAcceptedAt: null } },
    { name: "invalid time", changes: { providerAcceptedAt: "kein-datum" } },
    { name: "wrong provider", changes: { provider: "email" } },
    { name: "missing fingerprint", changes: { targetFingerprint: null } },
    { name: "invalid JSON", raw: "{not-json" }
  ];
  for (const example of invalid) {
    await t.test(example.name, async sub => {
      const directory = await temporaryDirectory(sub);
      const mock = fakeTelegram();
      if (example.raw) await fs.writeFile(receiptPath(directory), example.raw);
      else await seedReceipt(directory, mock.transport, example.changes);
      const before = await fs.readFile(receiptPath(directory), "utf8");
      const probe = createDeliveryProbe({ id: probeId, directory, transport: mock.transport });
      await probe.run();
      assert.equal(probe.getState().status, "FAILED");
      assert.equal(probe.getState().providerAcceptedAt, null);
      assert.deepEqual(mock.calls, ["getChat"]);
      assert.equal(await fs.readFile(receiptPath(directory), "utf8"), before);
    });
  }
});

test("suppressed, missing, zero or malformed new send receipts cannot create a confirmation file", async t => {
  for (const result of [undefined, { suppressed: true }, { message_id: 0 }, { message_id: "78" }, { message_id: -1 }]) {
    const directory = await temporaryDirectory(t);
    let sends = 0;
    const transport = {
      configured: () => true, verifyTarget: async () => ({ verified: true, type: "private" }),
      identityFingerprint: () => "a".repeat(64), send: async () => { sends++; return result; }
    };
    const probe = createDeliveryProbe({ id: probeId, directory, transport });
    await probe.run();
    assert.equal(sends, 1);
    assert.equal(probe.getState().status, "FAILED");
    assert.equal(probe.getState().providerAcceptedAt, null);
    await assert.rejects(fs.readFile(receiptPath(directory)), { code: "ENOENT" });
  }
});

test("a real-file rename failure after provider acceptance never reports CONFIRMED", async t => {
  const directory = await temporaryDirectory(t);
  const mock = fakeTelegram();
  const io = { ...fs, rename: async () => { throw Object.assign(new Error("simulated disk error"), { code: "EIO" }); } };
  const probe = createDeliveryProbe({ id: probeId, directory, transport: mock.transport, io });
  await probe.run();
  assert.deepEqual(mock.calls, ["getChat", "sendMessage"]);
  assert.equal(probe.getState().status, "FAILED");
  assert.match(probe.getState().error, /simulated disk error/);
  assert.match(probe.getState().deliveryLimitation, /doppelt/);
  await assert.rejects(fs.readFile(receiptPath(directory)), { code: "ENOENT" });
  const files = await fs.readdir(directory);
  assert.equal(files.length, 1);
  assert.ok(files[0].endsWith(".tmp"));
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, files[0]), "utf8")).messageId, 78);
});

test("parallel run calls share one send and one durable receipt", { timeout: 3000 }, async t => {
  const directory = await temporaryDirectory(t);
  const began = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const mock = fakeTelegram({ onSend: async () => { began.resolve(); await release.promise; } });
  const probe = createDeliveryProbe({ id: probeId, directory, transport: mock.transport });
  const runs = [probe.run(), probe.run(), probe.run()];
  await began.promise;
  assert.equal(mock.calls.filter(call => call === "sendMessage").length, 1);
  release.resolve();
  await Promise.all(runs);
  assert.equal(probe.getState().status, "CONFIRMED");
  assert.deepEqual(mock.calls, ["getChat", "sendMessage"]);
  assert.deepEqual(await fs.readdir(directory), [path.basename(receiptPath(directory))]);
});

test("stop waits for the in-flight provider send and durable acknowledgement", { timeout: 3000 }, async t => {
  const directory = await temporaryDirectory(t);
  const began = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const mock = fakeTelegram({ onSend: async () => { began.resolve(); await release.promise; } });
  const probe = createDeliveryProbe({ id: probeId, directory, transport: mock.transport });
  const run = probe.run();
  await began.promise;
  let stopped = false;
  const stopping = probe.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release.resolve();
  await Promise.all([run, stopping]);
  assert.equal(stopped, true);
  assert.equal(probe.getState().status, "CONFIRMED");
  assert.equal(JSON.parse(await fs.readFile(receiptPath(directory), "utf8")).messageId, 78);
  await probe.run();
  assert.deepEqual(mock.calls, ["getChat", "sendMessage"]);
});

test("stop also waits for real file fsync after provider acceptance", { timeout: 3000 }, async t => {
  const directory = await temporaryDirectory(t);
  const began = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const mock = fakeTelegram();
  const io = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    if (args[1] !== "wx") return handle;
    return {
      writeFile: (...writeArgs) => handle.writeFile(...writeArgs),
      sync: async () => { began.resolve(); await release.promise; await handle.sync(); },
      close: () => handle.close()
    };
  } };
  const probe = createDeliveryProbe({ id: probeId, directory, transport: mock.transport, io });
  const run = probe.run();
  await began.promise;
  let stopped = false;
  const stopping = probe.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  await assert.rejects(fs.readFile(receiptPath(directory)), { code: "ENOENT" });
  release.resolve();
  await Promise.all([run, stopping]);
  assert.equal(probe.getState().status, "CONFIRMED");
  assert.equal(JSON.parse(await fs.readFile(receiptPath(directory), "utf8")).messageId, 78);
});

test("stop before a run prevents verification, send and file writes", async t => {
  const directory = await temporaryDirectory(t);
  const mock = fakeTelegram();
  const probe = createDeliveryProbe({ id: probeId, directory, transport: mock.transport });
  await probe.stop();
  await probe.run();
  assert.deepEqual(mock.calls, []);
  assert.deepEqual(await fs.readdir(directory), []);
  assert.notEqual(probe.getState().status, "CONFIRMED");
});
