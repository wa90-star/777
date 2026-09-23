import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { parsePasswdEntry } = require("../container-entrypoint.js");

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
