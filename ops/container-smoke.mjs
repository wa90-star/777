// Isolated container acceptance: no credentials, ports or external networking.
// Runs against a locally built image. All resources are owned by this invocation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { assessHealth } from './health-check.mjs';

const image = process.argv[2];
if (!image || image.startsWith('-')) throw new Error('Usage: node ops/container-smoke.mjs <local-image>');
const name = `radar-acceptance-${randomUUID()}`;
const volume = `${name}-data`;
const marker = randomUUID();
const backupId = 'ci-before-start';
const outboxFixture = JSON.stringify({ version: 3, ciPrestartMarker: marker, seen: [], primed: [], items: [], deliveryOutbox: [{
  id: marker, item: { id: marker, title: 'Isolated CI pending-delivery fixture' }, createdAt: Date.now(),
  deliveries: { telegram: { status: 'pending', attempts: 2, nextAttemptAt: Date.now() + 600000, error: null } }
}] });
const hash = (text) => createHash('sha256').update(text).digest('hex');
function docker(...args) { return execFileSync('docker', args, { encoding: 'utf8', timeout: 45000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function inside(code) { return docker('exec', '--user', 'node', name, 'node', '-e', code); }
function verifySnapshot() {
  const result = JSON.parse(docker('exec', '--user', '0', name, 'node', '-e', `
    const fs=require('node:fs'), crypto=require('node:crypto');
    const backup=require('./recovery-backup-v1').runRecoveryBackup({dataDir:'/data',id:${JSON.stringify(backupId)}});
    const root='/data/.radar-recovery/'+${JSON.stringify(backupId)};
    const digest=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    console.log(JSON.stringify({reused:backup.reused, manifestHash:digest(root+'/manifest.json'),
      outboxHash:digest(root+'/data/catalyst-state.json'), marker:JSON.parse(fs.readFileSync(root+'/data/ci-prestart-marker.json','utf8')).marker,
      copiedPoststartSentinel:fs.existsSync(root+'/data/ci-persistence-sentinel.json')}));
  `));
  assert.equal(result.reused, true);
  assert.equal(result.outboxHash, hash(outboxFixture));
  assert.equal(result.marker, marker);
  assert.equal(result.copiedPoststartSentinel, false);
  return result.manifestHash;
}
async function ready() {
  const configured = Number(process.env.RADAR_SMOKE_READY_TIMEOUT_MS || 180000);
  if (!Number.isInteger(configured) || configured < 5000 || configured > 300000) {
    throw new Error('Invalid RADAR_SMOKE_READY_TIMEOUT_MS');
  }
  const deadline = Date.now() + configured;
  let attempts = 0;
  do {
    attempts += 1;
    try {
      return JSON.parse(inside("fetch('http://127.0.0.1:3000/api/status',{signal:AbortSignal.timeout(1500)}).then(r=>r.json()).then(x=>console.log(JSON.stringify(x))).catch(()=>process.exit(1))"));
    } catch {
      if (Date.now() >= deadline) break;
      await new Promise(r => setTimeout(r, 500));
    }
  } while (Date.now() < deadline);
  throw new Error(`Container API did not start within ${configured}ms after ${attempts} probes`);
}
let started = false;
let volumeCreated = false;
try {
  docker('volume', 'create', volume);
  volumeCreated = true;
  docker('run', '--rm', '--network', 'none', '--read-only', '--mount', `type=volume,source=${volume},destination=/data`, '--entrypoint', 'node', image, '-e',
    `const fs=require('node:fs');fs.writeFileSync('/data/catalyst-state.json',${JSON.stringify(outboxFixture)});fs.writeFileSync('/data/ci-prestart-marker.json',${JSON.stringify(JSON.stringify({ marker }))});`);
  docker('run', '-d', '--rm', '--name', name, '--network', 'none', '--read-only', '--tmpfs', '/tmp:size=64m,mode=1777', '--mount', `type=volume,source=${volume},destination=/data`, '-e', 'RADAR_DATA_DIR=/data', '-e', `RADAR_RECOVERY_BACKUP_ID=${backupId}`, '-e', 'OIL_DATA_MODE=free-proxy', '-e', 'KIMI_RESEARCH_MODE=off', image);
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
  assert.equal(status.deliveryStatus.policy.pending, 1);
  const snapshotHash = verifySnapshot();

  assert.equal(status.kimiResearch.productionInfluence, false);
  assert.equal(status.kimiResearch.telegramInfluence, false);
  for (const key of ['journalPersistence', 'catalystPersistence', 'eiaPersistence', 'ecbPersistence']) assert.equal(status[key], 'persistent:/data', key);
  const denied = JSON.parse(inside("Promise.all(['/api/status','/api/oil-monitor','/api/catalysts','/api/eia','/api/ecb','/api/journal'].map(async p=>[p,(await fetch('http://127.0.0.1:3000'+p,{method:'POST'})).status])).then(x=>console.log(JSON.stringify(x)))"));
  for (const [route, code] of denied) assert.equal(code, 405, route);
  inside(`require('node:fs').writeFileSync('/data/ci-persistence-sentinel.json',${JSON.stringify(JSON.stringify({ marker }))}); if(process.getuid()===0)process.exit(1)`);
  docker('restart', '--time', '15', name);
  await ready();
  assert.equal(verifySnapshot(), snapshotHash);
  assert.equal(JSON.parse(inside("console.log(require('node:fs').readFileSync('/data/ci-persistence-sentinel.json','utf8'))")).marker, marker);
  const oil = JSON.parse(inside("fetch('http://127.0.0.1:3000/api/oil-monitor').then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))"));
  const failures = assessHealth(await ready(), oil);
  assert.ok(failures.includes('telegram-not-configured'));
  assert.ok(failures.includes('market-data-not-configured'));
  console.log(JSON.stringify({ result: 'PASS', tests: ['real-container-start', 'opt-in-prestart-backup', 'outbox-backup-integrity', 'backup-restart-idempotence', 'public-api-read-only', 'non-root-data-write', 'restart-persistence', 'missing-providers-fail-health', 'kimi-isolation'], scope: 'isolated-container-no-live-provider-or-Telegram-proof' }));
} finally {
  // Docker --rm removes a stopped emulated container asynchronously. Under QEMU
  // the volume can remain "in use" briefly after a successful smoke test.
  if (started) {
    try { docker('stop', '--time', '15', name); } catch {}
    for (let attempt = 0; attempt < 30; attempt += 1) {
      let containerPresent = false;
      try {
        containerPresent = Boolean(docker('ps', '-aq', '--filter', `name=^/${name}// Isolated container acceptance: no credentials, ports or external networking.
// Runs against a locally built image. All resources are owned by this invocation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { assessHealth } from './health-check.mjs';

const image = process.argv[2];
if (!image || image.startsWith('-')) throw new Error('Usage: node ops/container-smoke.mjs <local-image>');
const name = `radar-acceptance-${randomUUID()}`;
const volume = `${name}-data`;
const marker = randomUUID();
const backupId = 'ci-before-start';
const outboxFixture = JSON.stringify({ version: 3, ciPrestartMarker: marker, seen: [], primed: [], items: [], deliveryOutbox: [{
  id: marker, item: { id: marker, title: 'Isolated CI pending-delivery fixture' }, createdAt: Date.now(),
  deliveries: { telegram: { status: 'pending', attempts: 2, nextAttemptAt: Date.now() + 600000, error: null } }
}] });
const hash = (text) => createHash('sha256').update(text).digest('hex');
function docker(...args) { return execFileSync('docker', args, { encoding: 'utf8', timeout: 45000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function inside(code) { return docker('exec', '--user', 'node', name, 'node', '-e', code); }
function verifySnapshot() {
  const result = JSON.parse(docker('exec', '--user', '0', name, 'node', '-e', `
    const fs=require('node:fs'), crypto=require('node:crypto');
    const backup=require('./recovery-backup-v1').runRecoveryBackup({dataDir:'/data',id:${JSON.stringify(backupId)}});
    const root='/data/.radar-recovery/'+${JSON.stringify(backupId)};
    const digest=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    console.log(JSON.stringify({reused:backup.reused, manifestHash:digest(root+'/manifest.json'),
      outboxHash:digest(root+'/data/catalyst-state.json'), marker:JSON.parse(fs.readFileSync(root+'/data/ci-prestart-marker.json','utf8')).marker,
      copiedPoststartSentinel:fs.existsSync(root+'/data/ci-persistence-sentinel.json')}));
  `));
  assert.equal(result.reused, true);
  assert.equal(result.outboxHash, hash(outboxFixture));
  assert.equal(result.marker, marker);
  assert.equal(result.copiedPoststartSentinel, false);
  return result.manifestHash;
}
async function ready() {
  const configured = Number(process.env.RADAR_SMOKE_READY_TIMEOUT_MS || 180000);
  if (!Number.isInteger(configured) || configured < 5000 || configured > 300000) {
    throw new Error('Invalid RADAR_SMOKE_READY_TIMEOUT_MS');
  }
  const deadline = Date.now() + configured;
  let attempts = 0;
  do {
    attempts += 1;
    try {
      return JSON.parse(inside("fetch('http://127.0.0.1:3000/api/status',{signal:AbortSignal.timeout(1500)}).then(r=>r.json()).then(x=>console.log(JSON.stringify(x))).catch(()=>process.exit(1))"));
    } catch {
      if (Date.now() >= deadline) break;
      await new Promise(r => setTimeout(r, 500));
    }
  } while (Date.now() < deadline);
  throw new Error(`Container API did not start within ${configured}ms after ${attempts} probes`);
}
let started = false;
let volumeCreated = false;
try {
  docker('volume', 'create', volume);
  volumeCreated = true;
  docker('run', '--rm', '--network', 'none', '--read-only', '--mount', `type=volume,source=${volume},destination=/data`, '--entrypoint', 'node', image, '-e',
    `const fs=require('node:fs');fs.writeFileSync('/data/catalyst-state.json',${JSON.stringify(outboxFixture)});fs.writeFileSync('/data/ci-prestart-marker.json',${JSON.stringify(JSON.stringify({ marker }))});`);
  docker('run', '-d', '--rm', '--name', name, '--network', 'none', '--read-only', '--tmpfs', '/tmp:size=64m,mode=1777', '--mount', `type=volume,source=${volume},destination=/data`, '-e', 'RADAR_DATA_DIR=/data', '-e', `RADAR_RECOVERY_BACKUP_ID=${backupId}`, '-e', 'OIL_DATA_MODE=free-proxy', '-e', 'KIMI_RESEARCH_MODE=off', image);
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
  assert.equal(status.deliveryStatus.policy.pending, 1);
  const snapshotHash = verifySnapshot();

  assert.equal(status.kimiResearch.productionInfluence, false);
  assert.equal(status.kimiResearch.telegramInfluence, false);
  for (const key of ['journalPersistence', 'catalystPersistence', 'eiaPersistence', 'ecbPersistence']) assert.equal(status[key], 'persistent:/data', key);
  const denied = JSON.parse(inside("Promise.all(['/api/status','/api/oil-monitor','/api/catalysts','/api/eia','/api/ecb','/api/journal'].map(async p=>[p,(await fetch('http://127.0.0.1:3000'+p,{method:'POST'})).status])).then(x=>console.log(JSON.stringify(x)))"));
  for (const [route, code] of denied) assert.equal(code, 405, route);
  inside(`require('node:fs').writeFileSync('/data/ci-persistence-sentinel.json',${JSON.stringify(JSON.stringify({ marker }))}); if(process.getuid()===0)process.exit(1)`);
  docker('restart', '--time', '15', name);
  await ready();
  assert.equal(verifySnapshot(), snapshotHash);
  assert.equal(JSON.parse(inside("console.log(require('node:fs').readFileSync('/data/ci-persistence-sentinel.json','utf8'))")).marker, marker);
  const oil = JSON.parse(inside("fetch('http://127.0.0.1:3000/api/oil-monitor').then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))"));
  const failures = assessHealth(await ready(), oil);
  assert.ok(failures.includes('telegram-not-configured'));
  assert.ok(failures.includes('market-data-not-configured'));
  console.log(JSON.stringify({ result: 'PASS', tests: ['real-container-start', 'opt-in-prestart-backup', 'outbox-backup-integrity', 'backup-restart-idempotence', 'public-api-read-only', 'non-root-data-write', 'restart-persistence', 'missing-providers-fail-health', 'kimi-isolation'], scope: 'isolated-container-no-live-provider-or-Telegram-proof' }));
));
      } catch {}
      if (!containerPresent) break;
      try { docker('rm', '-f', name); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  if (volumeCreated) {
    let removed = false;
    let lastError = null;
    for (let attempt = 0; attempt < 30 && !removed; attempt += 1) {
      try {
        docker('volume', 'rm', volume);
        removed = true;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    if (!removed) throw lastError || new Error('Acceptance volume cleanup failed');
  }
}
