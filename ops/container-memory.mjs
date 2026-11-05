// Bounded Linux software acceptance, not a production scheduler or monitor.
// Uses fresh synthetic storage, real public GET sources, and no credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const image = process.argv[2];
if (process.platform !== 'linux') throw new Error('This acceptance requires a native Linux Docker runner');
if (!image || image.startsWith('-')) throw new Error('Usage: node ops/container-memory.mjs <local-image>');
const seconds = Number(process.env.RADAR_PROFILE_SECONDS || 180);
if (!Number.isInteger(seconds) || seconds < 120 || seconds > 300) throw new Error('Profile duration must be 120..300 seconds');
const name = `radar-memory-${randomUUID()}`;
const volume = `${name}-data`;
const samples = [];
let created = false;
let started = false;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 45000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function numericFields(file) {
  return Object.fromEntries(fs.readFileSync(file, 'utf8').trim().split('\n').map(line => {
    const [key, value] = line.trim().split(/\s+/); return [key, Number(value)];
  }));
}
function cgroupFor(pid) {
  const entry = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n').find(line => line.startsWith('0::'));
  if (!entry) throw new Error('Expected cgroup v2 on the native Ubuntu runner');
  const root = '/sys/fs/cgroup';
  const target = path.resolve(root, '.' + entry.slice(3));
  if (target !== root && !target.startsWith(root + '/')) throw new Error('Invalid cgroup path');
  return target;
}
function sample(pid, group) {
  const proc = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const kb = key => Number(proc.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1] || 0) * 1024;
  const memory = numericFields(path.join(group, 'memory.stat'));
  const cpu = numericFields(path.join(group, 'cpu.stat'));
  const peakFile = path.join(group, 'memory.peak');
  return {
    at: Date.now(), rss: kb('VmRSS'), rssHighWater: kb('VmHWM'),
    containerBytes: Number(fs.readFileSync(path.join(group, 'memory.current'), 'utf8')),
    containerPeak: fs.existsSync(peakFile) ? Number(fs.readFileSync(peakFile, 'utf8')) : null,
    anonymousBytes: memory.anon || 0, fileCacheBytes: memory.file || 0,
    cpuUsec: cpu.usage_usec, uid: Number(proc.match(/^Uid:\s+(\d+)/m)?.[1])
  };
}
function average(rows, key) { return rows.reduce((sum, row) => sum + row[key], 0) / rows.length; }
function mib(bytes) { return Math.round(bytes / 1024 / 1024 * 100) / 100; }
async function get(base, route) {
  const response = await fetch(base + route, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`Acceptance endpoint HTTP ${response.status}`);
  return response.json();
}
async function ready(base) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    try { return await get(base, '/api/status'); } catch { await wait(300); }
  }
  throw new Error('Runtime did not become ready within 30 seconds');
}

try {
  const expectedArchitecture = process.arch === 'x64' ? 'amd64' : process.arch;
  assert.equal(docker('image', 'inspect', '--format', '{{.Architecture}}', image), expectedArchitecture,
    'Memory acceptance must run natively, not under architecture emulation');
  docker('volume', 'create', volume); created = true;
  const began = Date.now();
  // Explicit environment only: never forward the runner's secrets or a user's
  // data directory. Docker healthchecks are excluded from this measurement.
  docker('run', '-d', '--name', name, '--no-healthcheck', '--read-only',
    '--memory', '128m', '--memory-swap', '128m', '--cpus', '1', '--pids-limit', '32',
    '--tmpfs', '/tmp:size=16m,mode=1777', '--mount', `type=volume,source=${volume},destination=/data`,
    '-p', '127.0.0.1::3000', '-e', 'PORT=3000', '-e', 'RADAR_DATA_DIR=/data',
    '-e', 'RADAR_EF_PRIMARY_ENABLED=true', '-e', 'EF_POLL_MINUTES=10',
    '-e', 'OIL_DATA_MODE=free-proxy', '-e', 'KIMI_RESEARCH_MODE=off',
    '-e', 'TELEGRAM_BOT_TOKEN=', '-e', 'TELEGRAM_CHAT_ID=',
    '-e', 'APCA_API_KEY_ID=', '-e', 'APCA_API_SECRET_KEY=', '-e', 'TWELVE=', image);
  started = true;
  const inspection = JSON.parse(docker('inspect', name))[0];
  assert.equal(inspection.Platform, 'linux');
  const pid = inspection.State.Pid;
  const group = cgroupFor(pid);
  const port = inspection.NetworkSettings.Ports['3000/tcp'][0];
  assert.equal(port.HostIp, '127.0.0.1');
  const base = `http://127.0.0.1:${port.HostPort}`;
  samples.push(sample(pid, group));
  const status = await ready(base);
  const readyAt = Date.now();
  assert.equal(status.telegramConfigured, false);
  assert.equal(status.telegramDelivery.lastSuccessAt, null);
  assert.equal(status.marketDataConfigured, false);
  assert.equal(status.publicApiMode, 'read-only');
  const tasks = docker('top', name, '-eo', 'pid,ppid,args').split('\n').slice(1).filter(Boolean);
  assert.equal(tasks.length, 1, 'Expected one persistent application process, with no Node supervisor');
  while (Date.now() - began < seconds * 1000) {
    samples.push(sample(pid, group));
    await wait(1000);
  }
  samples.push(sample(pid, group));
  const finalStatus = await get(base, '/api/status');
  const ef = await get(base, '/api/ef-primary/status');
  assert.equal(finalStatus.telegramConfigured, false);
  assert.equal(finalStatus.telegramDelivery.lastSuccessAt, null);
  assert.equal(ef.enabled, true);
  assert.ok(ef.lastCollectionAt, 'The bounded primary-source scan must have completed');
  assert.ok(samples.filter(row => row.at >= readyAt).every(row => Number.isInteger(row.uid) && row.uid !== 0), 'Ready runtime must be unprivileged');
  const latest = samples.at(-1);
  const idle = samples.filter(row => row.at >= latest.at - 30000);
  const elapsed = (latest.at - began) / 1000;
  const cpuSeconds = latest.cpuUsec / 1e6;
  const meanCPU = cpuSeconds / elapsed;
  const meanRAM = average(samples, 'containerBytes');
  const monthSeconds = 31 * 86400;
  const estimate = usedVolumeGB => Math.round((monthSeconds *
    (meanRAM / 1e9 * 0.00000386 + meanCPU * 0.00000772 + usedVolumeGB * 0.00000006) + 0.05) * 10000) / 10000;
  const result = {
    result: 'PASS', scope: 'bounded-native-Linux-software-test-no-delivery-or-production-uptime-proof',
    seconds: Math.round(elapsed * 100) / 100, samples: samples.length,
    processCount: tasks.length, runtimeUid: latest.uid,
    processRSSMiB: { first: mib(samples[0].rss), peak: mib(Math.max(...samples.map(row => row.rssHighWater))),
      mean: mib(average(samples, 'rss')), last30SecondsMean: mib(average(idle, 'rss')) },
    containerMiB: { mean: mib(meanRAM), peak: mib(Math.max(...samples.map(row => row.containerPeak || row.containerBytes))),
      last30SecondsMean: mib(average(idle, 'containerBytes')), finalAnonymous: mib(latest.anonymousBytes), finalFileCache: mib(latest.fileCacheBytes) },
    cpuSeconds: Math.round(cpuSeconds * 1000) / 1000, meanVCPU: Math.round(meanCPU * 1e6) / 1e6,
    sourceRun: { lastCollectionAt: ef.lastCollectionAt, lastCollectionError: ef.lastCollectionError, run: ef.status?.lastRun || null },
    noExternalMessagesSent: true,
    costScenarioUSD: { days: 31, egressGBProvision: 1, usedVolume52MB: estimate(0.052), usedVolume500MB: estimate(0.5),
      caveat: 'Extrapolates this short startup/workload window, including container file cache. Not observed Railway billing or a steady-state CPU guarantee.' }
  };
  docker('stop', '--time', '15', name);
  const ended = JSON.parse(docker('inspect', name))[0].State;
  assert.equal(ended.OOMKilled, false, '128MiB acceptance container must not run out of memory');
  assert.equal(ended.ExitCode, 0, 'SIGTERM must reach the same-process server and complete cleanly');
  result.cleanShutdown = true;
  console.log('RADAR_MEMORY_PROFILE ' + JSON.stringify(result));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `\n### Bounded Linux memory acceptance\n\nOne unprivileged process; clean SIGTERM; no provider credentials or messages.\n\n` +
    `Process RSS: ${result.processRSSMiB.last30SecondsMean} MiB final-window mean; ${result.processRSSMiB.peak} MiB peak. ` +
    `Container: ${result.containerMiB.mean} MiB mean; ${result.containerMiB.peak} MiB peak. CPU: ${result.cpuSeconds}s over ${result.seconds}s.\n\n` +
    `Primary-source result: ${result.sourceRun.run?.status || 'see log'}. This is a bounded software measurement, not a production cost or availability guarantee.\n`);
} catch (error) {
  if (started) {
    try { console.error(docker('logs', '--tail', '15', name)); } catch {}
  }
  throw error;
} finally {
  if (started) { try { docker('rm', '-f', name); } catch {} }
  if (created) docker('volume', 'rm', volume);
}
