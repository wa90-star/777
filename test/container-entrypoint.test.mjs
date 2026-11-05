import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { parsePasswdEntry, main } = require("../container-entrypoint.js");

test("resolves the unprivileged runtime account from passwd", () => {
  const passwd = "root:x:0:0:root:/root:/bin/sh\nnode:x:1000:1000::/home/node:/bin/sh\n";
  assert.deepEqual(parsePasswdEntry(passwd, "node"), { uid: 1000, gid: 1000 });
});

test("fails closed when the runtime account is missing", () => {
  assert.throws(() => parsePasswdEntry("root:x:0:0:root:/root:/bin/sh\n", "node"), /not found/);
});

test("container starts through the privilege-dropping entrypoint", () => {
  const dockerfile = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /CMD \["node", "container-entrypoint\.js"\]/);
  assert.doesNotMatch(dockerfile, /^USER node$/m);
});

test("startup keeps backup and journal checks before loading the server in the current process", () => {
  const calls = [];
  const result = main({
    env: { RADAR_DATA_DIR: "/fixture/data", RADAR_RECOVERY_BACKUP_ID: "before-test" },
    prepare: (options) => calls.push(["prepare", options]),
    runDedupe: () => { calls.push(["dedupe"]); return { status: 0 }; },
    loadServer: () => { calls.push(["server"]); return { pid: process.pid }; }
  });
  assert.deepEqual(calls, [["prepare", { dataDir: "/fixture/data", recoveryBackupId: "before-test", backupAccessKey: undefined }], ["dedupe"], ["server"]]);
  assert.equal(result.pid, process.pid);
});

test("failed preparation never starts journal mutation or the runtime", () => {
  let laterCalled = false;
  assert.throws(() => main({ env: {}, prepare: () => { throw new Error("backup-not-safe"); },
    runDedupe: () => { laterCalled = true; }, loadServer: () => { laterCalled = true; }
  }), /backup-not-safe/);
  assert.equal(laterCalled, false);
});

test("failed or killed journal precheck blocks the runtime and preserves a failure exit status", () => {
  for (const dedupe of [{ status: 7 }, { status: null, signal: "SIGKILL" }, { error: new Error("cannot-spawn") }]) {
    let started = false;
    assert.throws(() => main({ env: {}, prepare: () => {}, runDedupe: () => dedupe,
      loadServer: () => { started = true; }
    }), (error) => dedupe.error ? error === dedupe.error : error.exitCode === (dedupe.status || 1));
    assert.equal(started, false);
  }
});
