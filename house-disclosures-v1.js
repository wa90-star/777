// Free House Clerk filing discovery. No transaction extraction or signal callbacks.
const fs = require("node:fs");
const path = require("node:path");
const { inflateRawSync, crc32 } = require("node:zlib");
const { createHash } = require("node:crypto");

const ORIGIN = "https://disclosures-clerk.house.gov";
const POLL_MS = 15 * 60000;
const MAX_ARCHIVE = 2 * 1024 * 1024;
const MAX_TEXT = 4 * 1024 * 1024;
const DAILY_BUDGET = 8 * 1024 * 1024;
const DEFAULT_NAMES = ["Nancy Pelosi", "Marjorie Taylor Greene"];
const hash = (s) => createHash("sha256").update(s).digest("hex");
const normalizeName = (s) => String(s).trim().toLowerCase().replace(/\s+/g, " ");

// Read only the named TXT entry. No files are extracted; sizes and CRC are checked.
function indexText(zip, year) {
  if (!Buffer.isBuffer(zip) || zip.length > MAX_ARCHIVE) throw new Error("archive-size-limit");
  let end = -1;
  for (let p = zip.length - 22; p >= Math.max(0, zip.length - 65557); p--) {
    if (zip.readUInt32LE(p) === 0x06054b50 && p + 22 + zip.readUInt16LE(p + 20) === zip.length) { end = p; break; }
  }
  if (end < 0) throw new Error("invalid-zip-directory");
  if (zip.readUInt32LE(end + 4) !== 0) throw new Error("unsupported-multipart-zip");
  const count = zip.readUInt16LE(end + 10);
  if (count > 20) throw new Error("archive-entry-limit");
  let p = zip.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || zip.readUInt32LE(p) !== 0x02014b50) throw new Error("invalid-zip-entry");
    const nameLen = zip.readUInt16LE(p + 28);
    const next = p + 46 + nameLen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
    if (next > end) throw new Error("invalid-zip-entry");
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    if (name === `${year}FD.txt`) {
      const method = zip.readUInt16LE(p + 10);
      const size = zip.readUInt32LE(p + 24);
      const compressed = zip.readUInt32LE(p + 20);
      const offset = zip.readUInt32LE(p + 42);
      if ((zip.readUInt16LE(p + 8) & 1) || ![0, 8].includes(method)) throw new Error("unsupported-zip-entry");
      if (size > MAX_TEXT || offset + 30 > p || zip.readUInt32LE(offset) !== 0x04034b50) throw new Error("invalid-zip-data");
      const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
      if (start + compressed > p) throw new Error("invalid-zip-data");
      const data = zip.subarray(start, start + compressed);
      const text = method === 8 ? inflateRawSync(data, { maxOutputLength: MAX_TEXT }) : data;
      if (text.length !== size || crc32(text) !== zip.readUInt32LE(p + 16)) throw new Error("archive-checksum-mismatch");
      return text.toString("utf8").replace(/^\uFEFF/, "");
    }
    p = next;
  }
  throw new Error("filing-index-missing");
}

function dateOnly(value) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!m) throw new Error("invalid-filing-date");
  const iso = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== iso) throw new Error("invalid-filing-date");
  return iso; // A filing day is not a midnight UTC publication timestamp.
}

function parseIndex(text, year, names) {
  const lines = text.trim().split(/\r?\n/);
  const fields = lines.shift()?.split("\t");
  const required = ["Last", "First", "FilingType", "Year", "FilingDate", "DocID"];
  if (!fields || required.some((x) => !fields.includes(x)) || fields.length !== new Set(fields).size) throw new Error("invalid-index-schema");
  const allowed = new Set(names.map(normalizeName));
  const result = new Map();
  for (const line of lines) {
    const cells = line.split("\t");
    if (cells.length !== fields.length) throw new Error("invalid-index-row");
    const row = Object.fromEntries(fields.map((f, i) => [f, cells[i]]));
    const member = `${row.First} ${row.Last}`.trim();
    if (row.FilingType !== "P" || !allowed.has(normalizeName(member))) continue;
    if (row.Year !== String(year) || !/^\d{1,12}$/.test(row.DocID)) throw new Error("invalid-filing-identity");
    const filingDate = dateOnly(row.FilingDate);
    const id = `house-ptr:${year}:${row.DocID}`;
    const record = {
      id, documentId: row.DocID, member, filingYear: year, filingDate,
      source: "US House Clerk · PTR filing index", sourceClass: "official-primary-index",
      url: `${ORIGIN}/public_disc/ptr-pdfs/${year}/${row.DocID}.pdf`,
      originKey: id, independentSourceCount: 1,
      indexFingerprint: hash(JSON.stringify([row.DocID, member, filingDate, year])),
      transactionDate: null, publishedAt: null, symbols: [], directionalBiases: {},
      status: "RESEARCH_ONLY", requiresDocumentReview: true,
      directTelegramAlerts: false, productionInfluence: false
    };
    if (result.has(id) && result.get(id).indexFingerprint !== record.indexFingerprint) throw new Error("conflicting-filing-id");
    result.set(id, record);
  }
  return [...result.values()];
}

function createHouseDisclosures({
  dataDir = process.env.RADAR_DATA_DIR || "/data", fetchImpl = globalThis.fetch, now = Date.now,
  names = DEFAULT_NAMES
} = {}) {
  const watchNames = [...new Set(names.map(normalizeName))].filter(Boolean).slice(0, 20);
  const file = path.join(dataDir, "house-disclosures-state.json");
  let state = { version: 1, years: {}, items: [], day: "", bytesToday: 0, nextScanAt: 0 };
  let error = null, lastAttemptAt = null, lastSuccessAt = null, loaded = false;
  let flight = null, timer = null, first = null;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved.version !== 1 || !saved.years || Array.isArray(saved.years) || !Array.isArray(saved.items) || !Number.isFinite(saved.bytesToday) || saved.bytesToday < 0 || !Number.isFinite(saved.nextScanAt) || !Number.isFinite(new Date(saved.nextScanAt).getTime())) throw new Error();
      if (saved.lastSuccessAt != null && (typeof saved.lastSuccessAt !== "string" || !Number.isFinite(Date.parse(saved.lastSuccessAt)))) throw new Error();
      for (const [year, entry] of Object.entries(saved.years)) {
        if (!/^\d{4}$/.test(year) || !entry || typeof entry.initialized !== "boolean" || !entry.seen || Array.isArray(entry.seen)) throw new Error();
        for (const [id, seen] of Object.entries(entry.seen)) {
          if (!new RegExp(`^house-ptr:${year}:\\d{1,12}$`).test(id) || !/^[a-f0-9]{64}$/.test(seen?.fingerprint) || !Number.isFinite(Date.parse(seen?.firstSeenAt))) throw new Error();
        }
      }
      for (const item of saved.items) {
        if (!item || item.url !== `${ORIGIN}/public_disc/ptr-pdfs/${item.filingYear}/${item.documentId}.pdf` ||
            !/^\d{1,12}$/.test(item.documentId) || !/^\d{4}$/.test(String(item.filingYear)) ||
            item.id !== `house-ptr:${item.filingYear}:${item.documentId}` || !Number.isFinite(Date.parse(item.firstSeenAt)) ||
            !Number.isFinite(Date.parse(item.lastObservedAt)) || !/^\d{4}-\d{2}-\d{2}$/.test(item.filingDate)) throw new Error();
      }
      state = saved;
      lastSuccessAt = saved.lastSuccessAt || null;
      error = saved.error || null;
    }
    loaded = true;
  } catch { error = "disclosure-state-unreadable"; }

  function save() {
    try {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...state, lastSuccessAt, error }));
      fs.renameSync(`${file}.tmp`, file);
    } catch { throw new Error("disclosure-state-write-failed"); }
  }
  async function download(year) {
    const previous = state.years[year];
    const headers = { Accept: "application/zip", "User-Agent": "777-signal-radar/5.3 personal-research" };
    if (previous?.etag) headers["If-None-Match"] = previous.etag;
    if (previous?.lastModified) headers["If-Modified-Since"] = previous.lastModified;
    const response = await fetchImpl(`${ORIGIN}/public_disc/financial-pdfs/${year}FD.zip`, {
      headers, signal: AbortSignal.timeout(20000), redirect: "error"
    });
    if (response.status === 304) {
      if (!previous?.initialized) throw new Error("unexpected-304-without-baseline");
      for (const item of state.items) if (item.filingYear === year) item.lastObservedAt = new Date(now()).toISOString();
      return;
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429) {
        const retry = response.headers.get("retry-after");
        const ms = /^\d+$/.test(retry || "") ? Number(retry) * 1000 : Date.parse(retry || "") - now();
        const retryAt = now() + ms;
        if (Number.isFinite(ms) && ms > 0 && Number.isFinite(new Date(retryAt).getTime())) state.nextScanAt = Math.max(state.nextScanAt, retryAt);
      }
      throw new Error(`house-index-HTTP-${response.status}`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      state.bytesToday += chunk.length;
      if (size > MAX_ARCHIVE || state.bytesToday > DAILY_BUDGET) throw new Error("disclosure-download-budget-exceeded");
      chunks.push(Buffer.from(chunk));
    }
    const records = parseIndex(indexText(Buffer.concat(chunks), year), year, watchNames);
    const seen = { ...(previous?.seen || {}) };
    const timestamp = new Date(now()).toISOString();
    const fresh = [];
    for (const record of records) {
      if (seen[record.id]?.fingerprint === record.indexFingerprint) continue;
      const firstSeenAt = seen[record.id]?.firstSeenAt || timestamp;
      fresh.push({ ...record, firstSeenAt, lastObservedAt: timestamp, lastIndexChangeAt: timestamp,
        novelty: !previous ? "baseline" : seen[record.id] ? "index-update" : "newly-observed" });
      seen[record.id] = { fingerprint: record.indexFingerprint, firstSeenAt };
    }
    const replaced = new Set(fresh.map((x) => x.id));
    const present = new Set(records.map((x) => x.id));
    for (const item of state.items) if (present.has(item.id)) item.lastObservedAt = timestamp;
    state.items = [...fresh, ...state.items.filter((x) => !replaced.has(x.id))]
      .sort((a, b) => (b.lastIndexChangeAt || b.firstSeenAt).localeCompare(a.lastIndexChangeAt || a.firstSeenAt) || b.filingDate.localeCompare(a.filingDate)).slice(0, 100);
    state.years[year] = { initialized: true, seen, etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified") };
  }
  async function run() {
    if (!loaded || now() < state.nextScanAt) return getState();
    const d = new Date(now()), day = d.toISOString().slice(0, 10), year = d.getUTCFullYear();
    if (state.day !== day) { state.day = day; state.bytesToday = 0; }
    state.nextScanAt = now() + POLL_MS;
    lastAttemptAt = d.toISOString();
    try {
      // Reserve budget/rate state before any network access; persist across restarts.
      save();
      if (state.bytesToday >= DAILY_BUDGET) throw new Error("disclosure-daily-budget-exhausted");
      // First ever scan is a quiet baseline. A new year after monitoring began is not.
      if (Object.keys(state.years).length && !state.years[year]) state.years[year] = { initialized: false, seen: {} };
      const years = [year];
      if (d.getUTCMonth() < 2 && state.years[year - 1]) years.push(year - 1);
      let failure = null;
      for (const y of years) {
        try { await download(y); } catch (e) { failure ||= e; }
        // A missing new-year archive must not hide late prior-year filings.
        // Provider backoff and exhausted budget, however, stop all requests.
        if (state.nextScanAt > now() + POLL_MS || state.bytesToday >= DAILY_BUDGET || /HTTP-(429|403)/.test(failure?.message || "")) break;
      }
      if (failure) throw failure;
      state.years = Object.fromEntries(Object.entries(state.years).filter(([y]) => Number(y) >= year - 1));
      lastSuccessAt = new Date(now()).toISOString();
      error = null;
      save();
    } catch (e) {
      error = /^(house-index-|disclosure-|invalid-|archive-|unsupported-|filing-index-|unexpected-|conflicting-)/.test(e.message) ? e.message : "house-index-fetch-or-parse-failed";
      try { save(); } catch { error = "disclosure-state-write-failed"; loaded = false; }
    }
    return getState();
  }
  function scan() {
    if (!flight) flight = run().finally(() => { flight = null; });
    return flight;
  }
  function getState() {
    return { mode: "filing-discovery-only", scope: "US-House-PTR-index", watchNames,
      pollingMinutes: POLL_MS / 60000, lastAttemptAt, lastSuccessAt,
      nextScanAt: state.nextScanAt ? new Date(state.nextScanAt).toISOString() : null,
      stale: !lastSuccessAt || now() - Date.parse(lastSuccessAt) > 45 * 60000,
      error, persistence: loaded ? `persistent:${dataDir}` : "unavailable",
      budget: { bytesToday: state.bytesToday, day: state.day || null, dailyLimitBytes: DAILY_BUDGET },
      directTelegramAlerts: false, productionInfluence: false, transactionExtraction: false,
      items: structuredClone(state.items) };
  }
  function start() {
    if (timer) return;
    first = setTimeout(scan, 50000); first.unref?.();
    timer = setInterval(scan, POLL_MS); timer.unref?.();
  }
  function stop() { clearTimeout(first); clearInterval(timer); first = timer = null; }
  if (loaded) {
    try { save(); } catch { error = "disclosure-state-write-failed"; loaded = false; }
  }
  return { scan, start, stop, getState };
}
module.exports = createHouseDisclosures;
module.exports._test = { indexText, parseIndex, dateOnly, POLL_MS, DAILY_BUDGET };
