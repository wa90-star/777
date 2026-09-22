const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createResearchStore = require("../research-store-v1");

function bundle(overrides = {}) {
  return {
    schema_version: "1.0",
    mode: "shadow",
    task_id: "task-1",
    run_id: "run-1",
    revision: 1,
    as_of_utc: "2026-09-22T14:00:00Z",
    approval: { verdict: "approved" },
    candidates: [{
      event_id: "event-1",
      status: "SHADOW_ONLY",
      requires_deterministic_radar_review: true
    }],
    ...overrides
  };
}

test("defaults to off and never exposes candidates", () => {
  const store = createResearchStore({ mode: "off" });
  assert.equal(store.getState().mode, "off");
  assert.deepEqual(store.getCandidates(), []);
  assert.equal(store.getState().productionInfluence, false);
});

test("fails closed for an unsupported live mode", () => {
  const store = createResearchStore({ mode: "live" });
  const state = store.getState();
  assert.equal(state.mode, "off");
  assert.equal(state.requestedMode, "live");
  assert.equal(state.lastError, "unsupported-mode:live");
});

test("loads only a valid SHADOW_ONLY bundle", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "777-kimi-store-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "bundle.json");
  fs.writeFileSync(filePath, JSON.stringify(bundle()), "utf8");

  const store = createResearchStore({ mode: "shadow", filePath, now: () => Date.parse("2026-09-22T15:00:00Z") });
  const state = store.load();
  assert.equal(state.loaded, true);
  assert.equal(state.candidateCount, 1);
  assert.equal(state.productionInfluence, false);
  assert.equal(state.telegramInfluence, false);
  assert.equal(store.getCandidates()[0].status, "SHADOW_ONLY");
});

test("rejects a bundle that attempts to opt into live use", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "777-kimi-store-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "bundle.json");
  fs.writeFileSync(filePath, JSON.stringify(bundle({ mode: "live" })), "utf8");

  const store = createResearchStore({ mode: "shadow", filePath });
  const state = store.load();
  assert.equal(state.loaded, false);
  assert.equal(state.candidateCount, 0);
  assert.equal(state.lastError, "invalid-or-non-shadow-bundle");
});
