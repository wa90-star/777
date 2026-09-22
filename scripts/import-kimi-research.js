#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { verifyApprovedPacket } = require("../kimi-research-v1");

function usage() {
  return [
    "Usage:",
    "  node scripts/import-kimi-research.js --packet <research_packet.json>",
    "    --approval <approval.json> --out <shadow-bundle.json> [--replace]",
    "",
    "The command validates an approved Kimi research packet and writes a",
    "sanitized SHADOW_ONLY bundle. It cannot enable live signals or Telegram."
  ].join("\n");
}

function parseArgs(argv) {
  const result = { replace: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--replace") {
      result.replace = true;
      continue;
    }
    if (!["--packet", "--approval", "--out"].includes(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    result[arg.slice(2)] = value;
    index += 1;
  }
  for (const required of ["packet", "approval", "out"]) {
    if (!result[required]) throw new Error(`Missing --${required}`);
  }
  return result;
}

function atomicWrite(targetPath, text, replace) {
  const absolute = path.resolve(targetPath);
  const directory = path.dirname(absolute);
  fs.mkdirSync(directory, { recursive: true });

  if (fs.existsSync(absolute)) {
    const current = fs.readFileSync(absolute, "utf8");
    if (current === text) return { path: absolute, changed: false };
    if (!replace) throw new Error(`Output already exists with different content: ${absolute}; pass --replace explicitly`);
  }

  const temporary = path.join(directory, `.${path.basename(absolute)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, absolute);
  } catch (error) {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } catch {}
    throw error;
  }
  return { path: absolute, changed: true };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  try {
    const packetText = fs.readFileSync(path.resolve(args.packet), "utf8");
    const approval = JSON.parse(fs.readFileSync(path.resolve(args.approval), "utf8"));
    const result = verifyApprovedPacket({ packetText, approval });
    if (!result.ok) {
      console.error("Kimi research import rejected:");
      result.errors.forEach((error) => console.error(`- ${error}`));
      process.exitCode = 1;
      return;
    }

    const output = `${JSON.stringify(result.bundle, null, 2)}\n`;
    const written = atomicWrite(args.out, output, args.replace);
    console.log(JSON.stringify({
      status: written.changed ? "IMPORTED" : "UNCHANGED",
      mode: "shadow",
      task_id: result.bundle.task_id,
      run_id: result.bundle.run_id,
      revision: result.bundle.revision,
      candidates: result.bundle.candidates.length,
      packet_sha256: result.packetSha256,
      production_influence: false,
      telegram_influence: false
    }));
  } catch (error) {
    console.error(`Kimi research import failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { atomicWrite, parseArgs };
