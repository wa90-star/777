const test = require("node:test");
const assert = require("node:assert/strict");
const { createTelegramTransport } = require("../telegram-transport-v1");
const good = { message_id: 9, chat: { id: 1234, type: "private" } };
function setup(result = good, chat = { id: 1234, type: "private" }) {
  const calls = [];
  const transport = createTelegramTransport({ token: "fake-token", chatId: "1234", verifyPrivateTarget: true,
    fetchImpl: async (url) => { calls.push(url.endsWith("/getChat") ? "verify" : "send"); return { ok: true, status: 200, json: async () => ({ ok: true, result: url.endsWith("/getChat") ? chat : result }) }; } });
  return { calls, transport };
}
test("private target is verified before first send and receipt matches it", async () => {
  const f = setup(); await f.transport.send("test"); await f.transport.send("test2");
  assert.deepEqual(f.calls, ["verify", "send", "send"]); assert.equal(f.transport.getState().targetType, "private");
});
test("group or different target fails before any message is sent", async () => {
  for (const chat of [{ id: 1234, type: "group" }, { id: 2345, type: "private" }]) {
    const f = setup(good, chat); await assert.rejects(f.transport.send("test"), /target verification failed/); assert.deepEqual(f.calls, ["verify"]);
  }
});
test("wrong recipient or nonpositive message receipt is never successful", async () => {
  for (const receipt of [{ ...good, message_id: 0 }, { ...good, chat: { id: 99, type: "private" } }, { message_id: 9 }]) {
    const f = setup(receipt); await assert.rejects(f.transport.send("test")); assert.equal(f.transport.getState().lastSuccessAt, null);
  }
});
test("preflight errors redact token and private chat identifier", async () => {
  const t = createTelegramTransport({ token: "secret-token", chatId: "1234", verifyPrivateTarget: true,
    fetchImpl: async () => { throw new Error("secret-token 1234 failed"); } });
  await assert.rejects(t.send("test"), e => !e.message.includes("secret-token") && !e.message.includes("1234"));
});
