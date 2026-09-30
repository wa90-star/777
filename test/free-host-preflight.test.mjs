import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkConfiguration, checkContainer, inspectBackup, runPreflight, STATE_FILES } from '../ops/free-host-preflight.mjs';

const secret = 'sensitive-test-value-must-never-appear';
const config = () => ({
  services: { radar: {
    environment: { APCA_API_KEY_ID: secret, APCA_API_SECRET_KEY: secret, TELEGRAM_BOT_TOKEN: secret, TELEGRAM_CHAT_ID: secret, OIL_DATA_MODE: 'free-proxy', KIMI_RESEARCH_MODE: 'off', RADAR_DATA_DIR: '/data' },
    volumes: [{ type: 'volume', source: 'radar-data', target: '/data' }],
    ports: [{ target: 3000, published: '3000', host_ip: '127.0.0.1' }],
    read_only: true, restart: 'unless-stopped',
  } }, volumes: { 'radar-data': { name: 'signal-radar-777-data' } },
});
const container = () => ({
  State: { Running: true, Health: { Status: 'healthy' } },
  Mounts: [{ Type: 'volume', Name: 'signal-radar-777-data', Destination: '/data', RW: true }],
  NetworkSettings: { Ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '3000' }] } },
  HostConfig: { ReadonlyRootfs: true },
});
const failedIds = checks => checks.filter(c => !c.ok).map(c => c.id);
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-preflight-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, '.env'), '# test fixture only\n', { mode: 0o600 });
  for (const name of STATE_FILES) fs.writeFileSync(path.join(directory, name), JSON.stringify({ fixture: true }));
  return directory;
}

test('resolved config is accepted without returning credential values', () => {
  const checks = checkConfiguration(config());
  assert.deepEqual(failedIds(checks), []);
  assert.equal(JSON.stringify(checks).includes(secret), false);
});
test('missing credentials, paid oil, Kimi live, public ports and ephemeral state fail', () => {
  const bad = config();
  bad.services.radar.environment.APCA_API_KEY_ID = '';
  bad.services.radar.environment.OIL_DATA_MODE = 'massive';
  bad.services.radar.environment.KIMI_RESEARCH_MODE = 'live';
  bad.services.radar.environment.RADAR_DATA_DIR = '/tmp';
  bad.services.radar.volumes[0].type = 'bind';
  bad.services.radar.ports[0].host_ip = '0.0.0.0';
  assert.deepEqual(failedIds(checkConfiguration(bad)), ['credentials-present', 'free-oil-mode', 'kimi-isolation', 'data-path', 'data-volume', 'loopback-binding']);
});
test('placeholder configuration and additional public ports fail', () => {
  const bad = config();
  bad.services.radar.environment.TELEGRAM_BOT_TOKEN = '${TOKEN}';
  bad.services.radar.ports.push({ target: 3000, published: '3001', host_ip: '0.0.0.0' });
  assert.deepEqual(failedIds(checkConfiguration(bad)), ['credentials-present', 'loopback-binding']);
});
test('runtime verification rejects stopped, unhealthy, wrong mount and public binding', () => {
  const actual = container();
  assert.deepEqual(failedIds(checkContainer(actual)), []);
  actual.State.Running = false;
  actual.State.Health.Status = 'unhealthy';
  actual.Mounts[0].Name = 'other-volume';
  actual.NetworkSettings.Ports['3000/tcp'][0].HostIp = '0.0.0.0';
  assert.deepEqual(failedIds(checkContainer(actual)), ['runtime-running', 'runtime-health', 'runtime-volume', 'runtime-loopback']);
});
test('backup inspection hashes valid state without changing it or returning content', t => {
  const root = fixture(t);
  const before = fs.readFileSync(path.join(root, STATE_FILES[0]), 'utf8');
  const result = inspectBackup(root);
  assert.deepEqual(failedIds(result.checks), []);
  assert.equal(result.files.length, 5);
  assert.match(result.files[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(path.join(root, STATE_FILES[0]), 'utf8'), before);
  assert.equal(JSON.stringify(result).includes('fixture'), false);
});
test('backup inspection rejects missing, malformed, null and symlinked state without leaking contents', t => {
  const root = fixture(t);
  fs.unlinkSync(path.join(root, STATE_FILES[0]));
  fs.writeFileSync(path.join(root, STATE_FILES[1]), secret);
  fs.writeFileSync(path.join(root, STATE_FILES[2]), 'null');
  fs.unlinkSync(path.join(root, STATE_FILES[3]));
  fs.symlinkSync(path.join(root, STATE_FILES[4]), path.join(root, STATE_FILES[3]));
  const result = inspectBackup(root);
  assert.equal(failedIds(result.checks).length, 4);
  assert.equal(JSON.stringify(result).includes(secret), false);
});
test('missing Docker and absent source backup are blockers; runner errors cannot leak', t => {
  const root = fixture(t);
  const report = runPreflight({ root, runner: () => ({ status: 1, stderr: secret, stdout: secret }), platform: 'linux', arch: 'x64' });
  assert.equal(report.technicalChecksPassed, false);
  assert.equal(report.productionReady, false);
  assert.ok(failedIds(report.checks).includes('docker-engine'));
  assert.ok(failedIds(report.checks).includes('backup-evidence'));
  assert.equal(JSON.stringify(report).includes(secret), false);
});
test('successful mocked inspection runs read-only commands and never proves production readiness', t => {
  const root = fixture(t);
  const called = [];
  const runner = (command, args) => {
    called.push([command, ...args]);
    let value;
    if (args[0] === 'info') value = { OSType: 'linux', Architecture: 'aarch64' };
    else if (args.includes('config')) value = config();
    else if (args[0] === 'volume') value = [{ Name: 'signal-radar-777-data' }];
    else if (args.includes('ps')) return { status: 0, stdout: 'a'.repeat(64) + '\n' };
    else if (args[0] === 'inspect') value = [container()];
    else assert.fail('Unexpected command');
    return { status: 0, stdout: JSON.stringify(value) };
  };
  const report = runPreflight({ root, backupDirectory: root, runner, platform: 'linux', arch: 'arm64' });
  assert.deepEqual(failedIds(report.checks), []);
  assert.equal(report.technicalChecksPassed, true);
  assert.equal(report.productionReady, false);
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(called.length, 5);
  assert.ok(called.every(c => c[0] === 'docker' && !c.some(a => ['up', 'run', 'exec', 'stop', 'restart', 'pull', 'build', 'rm', 'create'].includes(a))));
});
test('loose env permissions fail even when Docker cannot be inspected', t => {
  const root = fixture(t);
  fs.chmodSync(path.join(root, '.env'), 0o644);
  const report = runPreflight({ root, runner: () => ({ status: 1 }), platform: 'linux', arch: 'x64' });
  assert.ok(failedIds(report.checks).includes('env-permissions'));
});
test('multiple containers are rejected without inspecting or selecting one', t => {
  const root = fixture(t);
  const report = runPreflight({ root, runner: (_cmd, args) => {
    assert.notEqual(args[0], 'inspect');
    return args.includes('ps') ? { status: 0, stdout: `${'a'.repeat(64)}\n${'b'.repeat(64)}\n` } : { status: 1 };
  }, platform: 'linux', arch: 'x64' });
  assert.ok(failedIds(report.checks).includes('single-runtime'));
});
