// Isolated container acceptance: no credentials, ports or external networking.
// Runs against a locally built image. All resources are owned by this invocation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { assessHealth } from './health-check.mjs';

const image = process.argv[2];
if (!image || image.startsWith('-')) throw new Error('Usage: node ops/container-smoke.mjs <local-image>');
const name = `radar-acceptance-${randomUUID()}`;
const marker = randomUUID();
function docker(...args) { return execFileSync('docker', args, { encoding: 'utf8', timeout: 45000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function inside(code) { return docker('exec', '--user', 'node', name, 'node', '-e', code); }
async function ready() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try { return JSON.parse(inside("fetch('http://127.0.0.1:3000/api/status',{signal:AbortSignal.timeout(1000)}).then(r=>r.json()).then(x=>console.log(JSON.stringify(x))).catch(()=>process.exit(1))")); }
    catch { await new Promise(r => setTimeout(r, 300)); }
  }
  throw new Error('Container API did not start');
}
let started = false;
try {
  docker('run', '-d', '--rm', '--name', name, '--network', 'none', '--read-only', '--tmpfs', '/tmp:size=64m,mode=1777', '--mount', 'type=volume,destination=/data', '-e', 'RADAR_DATA_DIR=/data', '-e', 'OIL_DATA_MODE=free-proxy', '-e', 'KIMI_RESEARCH_MODE=off', image);
  started = true;
  const status = await ready();
  assert.equal(status.publicApiMode, 'read-only');
  assert.equal(status.telegramConfigured, false);
  assert.equal(status.marketDataConfigured, false);
  assert.equal(status.telegramDelivery.configured, false);
  assert.equal(status.telegramDelivery.lastSuccessAt, null);
  assert.ok(Object.hasOwn(status.telegramDelivery, 'lastError'));
  assert.ok(Object.hasOwn(status, 'marketLastError'));
  for (const source of ['policy', 'eia']) assert.ok(Object.hasOwn(status.deliveryStatus[source], 'pending'));

  assert.equal(status.kimiResearch.productionInfluence, false);
  assert.equal(status.kimiResearch.telegramInfluence, false);
  for (const key of ['journalPersistence', 'catalystPersistence', 'eiaPersistence', 'ecbPersistence']) assert.equal(status[key], 'persistent:/data', key);
  const denied = JSON.parse(inside("Promise.all(['/api/status','/api/oil-monitor','/api/catalysts','/api/eia','/api/ecb','/api/journal'].map(async p=>[p,(await fetch('http://127.0.0.1:3000'+p,{method:'POST'})).status])).then(x=>console.log(JSON.stringify(x)))"));
  for (const [route, code] of denied) assert.equal(code, 405, route);
  inside(`require('node:fs').writeFileSync('/data/ci-persistence-sentinel.json',${JSON.stringify(JSON.stringify({ marker }))}); if(process.getuid()===0)process.exit(1)`);
  docker('restart', '--time', '15', name);
  await ready();
  assert.equal(JSON.parse(inside("console.log(require('node:fs').readFileSync('/data/ci-persistence-sentinel.json','utf8'))")).marker, marker);
  const oil = JSON.parse(inside("fetch('http://127.0.0.1:3000/api/oil-monitor').then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))"));
  const failures = assessHealth(await ready(), oil);
  assert.ok(failures.includes('telegram-not-configured'));
  assert.ok(failures.includes('market-data-not-configured'));
  console.log(JSON.stringify({ result: 'PASS', tests: ['real-container-start', 'public-api-read-only', 'non-root-data-write', 'restart-persistence', 'missing-providers-fail-health', 'kimi-isolation'], scope: 'isolated-container-no-live-provider-or-Telegram-proof' }));
} finally {
  if (started) docker('stop', '--time', '15', name); // --rm also removes this invocation's anonymous volume.
}
