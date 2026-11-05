#!/usr/bin/env node
"use strict";
const path = require("node:path");
const { importReviews, readTargets } = require("../manual-source-review-v1");

function main(argv) {
  const args = { apply: false, list: false };
  try {
    for (let i = 0; i < argv.length; i++) {
      const key = argv[i];
      if (key === "--apply") { args.apply = true; continue; }
      if (key === "--list-targets") { args.list = true; continue; }
      if (!["--data-dir", "--input", "--expected-input-sha256"].includes(key) || !argv[i + 1] || argv[i + 1].startsWith("--") || Object.hasOwn(args, key)) throw new Error("arguments");
      args[key] = argv[++i];
    }
    if (!args["--data-dir"] || !path.isAbsolute(args["--data-dir"])) throw new Error("arguments");
    if (args.list) {
      if (args.apply || args["--input"] || args["--expected-input-sha256"]) throw new Error("arguments");
      console.log(JSON.stringify({ schema: 1, targets: [...readTargets(args["--data-dir"]).values()], readOnly: true }));
    } else {
      if (!args["--input"] || !path.isAbsolute(args["--input"])) throw new Error("arguments");
      console.log(JSON.stringify(importReviews({ directory: args["--data-dir"], inputFile: args["--input"],
        expectedInputSha256: args["--expected-input-sha256"], apply: args.apply })));
    }
  } catch (error) {
    // Never echo input content, filesystem paths, provider messages or credentials.
    console.error(/^source-review-[a-z-]+$/.test(error.message) ? error.message : "source-review-import-failed");
    process.exitCode = 1;
  }
}
if (require.main === module) main(process.argv.slice(2));
module.exports = { main };
