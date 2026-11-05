const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createEia = require('../eia-v4');
const url = 'https://www.eia.gov/petroleum/marketing/monthly/';
const baseId = `eia:${url}`;

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eia-release-'));
  const previous = process.env.RADAR_DATA_DIR;
  process.env.RADAR_DATA_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.RADAR_DATA_DIR; else process.env.RADAR_DATA_DIR = previous; fs.rmSync(dir, { recursive: true, force: true }); });
  let now = Date.parse('2026-11-05T22:00:00Z');
  let rows = [{ url, publishedAt: 'Mon, 02 Nov 2026 00:00:00 EST' }];
  const messages = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(global, 'fetch', async () => new Response(`<rss><channel>${rows.map(x => `<item><title>Petroleum Marketing Monthly</title><link>${x.url}</link><pubDate>${x.publishedAt || ''}</pubDate><description>Crude oil and petroleum production statistics</description></item>`).join('')}</channel></rss>`));
  const options = { informationMode: true, telegramConfigured: () => true, sendMessage: async text => { messages.push(text); return { message_id: messages.length }; } };
  const file = path.join(dir, 'eia-state.json');
  return { options, messages, file, disk: () => JSON.parse(fs.readFileSync(file, 'utf8')), setRows(value) { rows = value; }, advance(ms) { now += ms; }, now: () => now };
}

test('EIA recurring URL: a later publication is delivered once across restart', async t => {
  const h = setup(t); let engine = createEia(h.options);
  await engine.scan(); assert.equal(h.messages.length, 0);
  h.setRows([{ url, publishedAt: 'Thu, 05 Nov 2026 12:00:00 EST' }]);
  await engine.scan(); assert.equal(h.messages.length, 1, 'same report URL must not hide a new release');
  engine = createEia(h.options); await engine.scan();
  assert.equal(h.messages.length, 1);
  assert.equal(h.disk().deliveryOutbox.length, 1);
  assert.match(h.disk().deliveryOutbox[0].id, /release:2026-11-05T17:00:00.000Z$/);
});

test('EIA publication identity is unchanged by equivalent time-zone formatting', async t => {
  const h = setup(t); const engine = createEia(h.options); await engine.scan();
  h.setRows([{ url, publishedAt: 'Mon, 02 Nov 2026 05:00:00 GMT' }]);
  await engine.scan(); assert.equal(h.messages.length, 0);
});

test('EIA legacy failed delivery survives migration without blocking the next edition', async t => {
  const h = setup(t);
  const item = { id: baseId, url, title: 'Petroleum Marketing Monthly', publishedAt: 'Mon, 02 Nov 2026 00:00:00 EST', detectedAt: new Date(h.now() - 3600000).toISOString() };
  const old = { id: baseId, item, createdAt: h.now() - 3600000, deliveries: { telegram: { status: 'failed', attempts: 0, nextAttemptAt: 0, error: 'delivery-expired-requires-review' } } };
  fs.writeFileSync(h.file, JSON.stringify({ version: 2, primed: true, seen: [[baseId, h.now()]], items: [item], deliveryOutbox: [old] }));
  let engine = createEia(h.options); await engine.scan();
  assert.equal(h.messages.length, 0, 'migration must not resend the old edition');
  assert.deepEqual(h.disk().deliveryOutbox[0], old);
  h.setRows([{ url, publishedAt: 'Thu, 05 Nov 2026 12:00:00 EST' }]);
  engine = createEia(h.options); await engine.scan();
  assert.equal(h.messages.length, 1);
  assert.deepEqual(h.disk().deliveryOutbox[0], old, 'no forged receipt or cleared failure');
  assert.equal(h.disk().deliveryOutbox.length, 2);
});

test('EIA legacy URLs without saved publication receive one explicit quiet baseline, retained across restart', async t => {
  const h = setup(t); const other = 'https://www.eia.gov/naturalgas/monthly/';
  fs.writeFileSync(h.file, JSON.stringify({ version: 2, primed: true, seen: [[baseId, h.now()], [`eia:${other}`, h.now()]], items: [], deliveryOutbox: [] }));
  let engine = createEia(h.options); await engine.scan();
  assert.equal(h.messages.length, 0);
  assert.equal(engine.getState().pendingLegacyReleaseBaselines, 1);
  engine = createEia(h.options);
  h.setRows([{ url: other, publishedAt: 'Fri, 30 Oct 2026 00:00:00 EST' }]); await engine.scan();
  assert.equal(h.messages.length, 0);
  assert.equal(engine.getState().pendingLegacyReleaseBaselines, 0);
  h.setRows([{ url: other, publishedAt: 'Thu, 05 Nov 2026 12:00:00 EST' }]); await engine.scan();
  assert.equal(h.messages.length, 1);
});

test('EIA future publication is neither delivered nor consumed before its date', async t => {
  const h = setup(t); let engine = createEia(h.options); await engine.scan();
  h.setRows([{ url, publishedAt: 'Fri, 06 Nov 2026 00:00:00 GMT' }]);
  await engine.scan(); assert.equal(h.messages.length, 0);
  assert.ok(!h.disk().seen.some(([id]) => id.includes('2026-11-06')));
  h.advance(2 * 3600000); engine = createEia(h.options); await engine.scan();
  assert.equal(h.messages.length, 1);
});

test('EIA missing publication time keeps URL identity and cannot repeatedly create editions', async t => {
  const h = setup(t); h.setRows([{ url, publishedAt: null }]);
  let engine = createEia(h.options); await engine.scan();
  engine = createEia(h.options); h.setRows([{ url, publishedAt: 'unparseable' }]); await engine.scan();
  assert.equal(h.messages.length, 0);
  assert.ok(h.disk().seen.some(([id]) => id === baseId));
});
