"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

// Existing engine snapshot + seen IDs + outbox stay one atomic state file.
function writeDurableState(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  let fd = null, created = false;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    created = true;
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
    fs.renameSync(temporary, file);
    if (process.platform !== "win32") {
      const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
    return true;
  } finally {
    if (fd !== null) fs.closeSync(fd);
    if (created) try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

module.exports = writeDurableState;
