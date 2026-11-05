const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createCatalyst = require('../catalyst-v4');
const row = (id, date) => `<div class="views-row evo-views-row"><div class="media-body"><div class="h3 mt-0 font-weight-bold"><a href="/news/press-releases/${id}">Emergency crude oil sanctions on Iran ${id}</a></div><div><div class="row"><div class="col-auto">${date}</div><div class="col-auto"><a href="/news/press-releases">Press Release</a></div></div><div class="evo-press-release__body">Public statement.</div></div></div></div>`;
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pelosi-date-'));
  const saved = process.env.RADAR_DATA_DIR; process.env.RADAR_DATA_DIR = directory;
  t.after(() => { if (saved === undefined) delete process.env.RADAR_DATA_DIR; else process.env.RADAR_DATA_DIR = saved; fs.rmSync(directory, { recursive: true, force: true }); });
  t.mock.method(Date, 'now', () => Date.parse('2026-11-05T22:00:00Z'));
  let html = row('baseline', 'November 5, 2026'); const messages = [];
  t.mock.method(global, 'fetch', async () => new Response(html));
  const engine = createCatalyst({ informationMode: true, telegramConfigured: () => true, sendMessage: async text => { messages.push(text); return { message_id: messages.length }; } });
  return { engine, messages, set(value) { html = value; } };
}
test('Pelosi: the original listing date prevents a historical article from becoming a fresh notice', async t => {
  const h = setup(t); await h.engine.scanPelosi();
  h.set(row('old-pipeline', 'September 8, 2026') + row('new-sanctions', 'November 5, 2026'));
  await h.engine.scanPelosi();
  assert.equal(h.messages.length, 1); assert.match(h.messages[0], /new-sanctions/); assert.match(h.messages[0], /2026-11-05/);
  assert.equal(h.engine.getState().sources.pelosiOfficial.ok, true);
});
test('Pelosi: an undated row cannot borrow its next neighbour date or pass as fresh', async t => {
  const h = setup(t); await h.engine.scanPelosi();
  h.set(row('unknown', '') + row('dated', 'November 5, 2026')); await h.engine.scanPelosi();
  assert.equal(h.messages.length, 1); assert.match(h.messages[0], /dated/); assert.doesNotMatch(h.messages[0], /unknown/);
  assert.equal(h.engine.getState().sources.pelosiOfficial.ok, false);
  assert.match(h.engine.getState().sources.pelosiOfficial.error, /publication date/);
});
test('Pelosi: impossible dates and an unrecognized listing are visible source gaps', async t => {
  const h = setup(t); await h.engine.scanPelosi(); h.set(row('impossible', 'February 30, 2026'));
  await h.engine.scanPelosi(); assert.equal(h.messages.length, 0); assert.equal(h.engine.getState().sources.pelosiOfficial.ok, false);
  h.set('<html>Temporary access page</html>'); await h.engine.scanPelosi();
  assert.equal(h.messages.length, 0); assert.equal(h.engine.getState().sources.pelosiOfficial.ok, false);
});
