#!/usr/bin/env node
// Read-only checks: never starts, stops, builds, pulls, copies or changes anything.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const STATE_FILES = ['signal-journal.json', 'catalyst-state.json', 'eia-state.json', 'ecb-state.json', 'trump-oil-monitor.json'];
const REQUIRED = ['APCA_API_KEY_ID', 'APCA_API_SECRET_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
const VOLUME = 'signal-radar-777-data';
const check = (id, ok, detail) => ({ id, ok: Boolean(ok), detail });

export function checkConfiguration(config) {
  const service = config?.services?.radar;
  if (!service) return [check('compose-service', false, 'Compose service radar is missing.')];
  const env = service.environment || {};
  const absent = REQUIRED.filter(key => !String(env[key] ?? '').trim() || /^(?:your[_ -]|replace|changeme|<|\$\{)/i.test(String(env[key])));
  const mounts = service.volumes || [];
  const dataMount = mounts.find(m => m.target === '/data');
  const ports = service.ports || [];
  return [
    check('credentials-present', absent.length === 0, absent.length ? `Missing or placeholder values: ${absent.join(', ')}` : 'Required configuration values are present; authentication is not yet verified.'),
    check('free-oil-mode', env.OIL_DATA_MODE === 'free-proxy', 'OIL_DATA_MODE must be free-proxy.'),
    check('kimi-isolation', ['off', 'shadow'].includes(env.KIMI_RESEARCH_MODE), 'Kimi must remain off or shadow.'),
    check('data-path', env.RADAR_DATA_DIR === '/data', 'RADAR_DATA_DIR must equal /data.'),
    check('data-volume', dataMount?.type === 'volume' && !dataMount.read_only && config.volumes?.[dataMount.source]?.name === VOLUME, 'A writable named volume must mount at /data.'),
    check('loopback-binding', ports.length === 1 && String(ports[0].target) === '3000' && ports[0].host_ip === '127.0.0.1' && Number(ports[0].published) > 0 && Number(ports[0].published) <= 65535, 'Expose port 3000 on 127.0.0.1 only; HTTPS needs a separately verified reverse proxy.'),
    check('read-only-root', service.read_only === true, 'The root filesystem must be read-only.'),
    check('restart-policy', service.restart === 'unless-stopped', 'Restart policy must be unless-stopped; this does not repair an unhealthy running process.'),
  ];
}

export function checkContainer(container) {
  const mounts = container?.Mounts || [];
  const ports = container?.NetworkSettings?.Ports?.['3000/tcp'] || [];
  return [
    check('runtime-running', container?.State?.Running === true, 'A running container is required.'),
    check('runtime-health', container?.State?.Health?.Status === 'healthy', 'Docker health must be healthy (HTTP reachability only; full Radar validation is separate).'),
    check('runtime-volume', mounts.some(m => m.Type === 'volume' && m.Name === VOLUME && m.Destination === '/data' && m.RW === true), 'The actual container must have the writable persistent /data volume.'),
    check('runtime-loopback', ports.length === 1 && ports[0].HostIp === '127.0.0.1', 'The actual host port must bind only to loopback.'),
    check('runtime-read-only-root', container?.HostConfig?.ReadonlyRootfs === true, 'The actual container root must be read-only.'),
  ];
}

export function inspectBackup(directory) {
  const checks = [];
  const files = [];
  for (const name of STATE_FILES) {
    try {
      const filename = path.join(directory, name);
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not_regular');
      const raw = fs.readFileSync(filename);
      const parsed = JSON.parse(raw.toString('utf8'));
      if (!parsed || typeof parsed !== 'object') throw new Error('not_structured');
      checks.push(check(`backup-${name}`, true, 'Regular, readable JSON state file; semantic completeness is not established by this check.'));
      files.push({ name, bytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex') });
    } catch {
      // Do not include parser errors: they can quote file contents.
      checks.push(check(`backup-${name}`, false, 'Missing, non-regular, unreadable or invalid JSON state file.'));
    }
  }
  return { checks, files };
}

export function runPreflight({ root, backupDirectory, runner = spawnSync, platform = os.platform(), arch = os.arch() } = {}) {
  const checks = [
    check('host-linux', platform === 'linux', 'The target host must run Linux.'),
    check('host-architecture', ['x64', 'arm64'].includes(arch), 'Supported host architectures: x86_64 or arm64. Build locally on ARM unless the selected image manifest confirms ARM support.'),
  ];
  const run = args => runner('docker', args, { cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
  const readJson = result => {
    if (result.status !== 0 || result.error) return null;
    try { return JSON.parse(result.stdout); } catch { return null; }
  };
  try {
    const stat = fs.statSync(path.join(root, '.env'));
    checks.push(check('env-permissions', stat.isFile() && (stat.mode & 0o077) === 0, '.env must be a regular file accessible only to its owner (chmod 600).'));
  } catch {
    checks.push(check('env-permissions', false, 'A private .env with the existing credentials is missing.'));
  }

  // CLI arguments and output are never logged; resolved Compose output contains secrets.
  const info = readJson(run(['info', '--format', '{{json .}}']));
  checks.push(check('docker-engine', info?.OSType === 'linux', 'A reachable Linux Docker Engine is required.'));
  checks.push(check('docker-architecture', ['x86_64', 'amd64', 'aarch64', 'arm64'].includes(info?.Architecture), 'Docker Engine must report x86_64/amd64 or aarch64/arm64.'));
  const composeArgs = ['compose', '-f', 'compose.free-host.yaml'];
  const config = readJson(run([...composeArgs, 'config', '--format', 'json']));
  checks.push(check('compose-valid', Boolean(config), 'Docker Compose v2 must resolve compose.free-host.yaml. Raw errors are suppressed to protect credentials.'));
  if (config) checks.push(...checkConfiguration(config));

  const volume = readJson(run(['volume', 'inspect', VOLUME]));
  checks.push(check('existing-volume', Array.isArray(volume) && volume.length === 1 && volume[0].Name === VOLUME, 'Persistent volume must exist. Its presence alone does not prove source data was migrated.'));
  const ids = run([...composeArgs, 'ps', '--all', '--quiet', 'radar']);
  const containers = ids.status === 0 ? String(ids.stdout).trim().split(/\s+/).filter(Boolean) : [];
  const safeIds = containers.filter(id => /^[a-f0-9]{12,64}$/.test(id));
  checks.push(check('single-runtime', safeIds.length === 1 && containers.length === 1, 'Exactly one existing Radar container is required; this script creates none.'));
  if (safeIds.length === 1 && containers.length === 1) {
    const inspected = readJson(run(['inspect', safeIds[0]]));
    checks.push(...checkContainer(Array.isArray(inspected) ? inspected[0] : null));
  }
  const backup = backupDirectory ? inspectBackup(backupDirectory) : null;
  if (backup) checks.push(...backup.checks);
  else checks.push(check('backup-evidence', false, 'Source /data export is not supplied. Use --backup-directory with a securely obtained export; no fresh start is assumed.'));

  return {
    checkedAt: new Date().toISOString(),
    technicalChecksPassed: checks.every(c => c.ok),
    productionReady: false,
    checks,
    ...(backup ? { backupFiles: backup.files } : {}),
    remainingVerification: [
      'Actual account and selected resources must be confirmed free in the provider account; this script cannot prove price, availability or reclaim policy.',
      'Backup JSON checks do not establish a complete backup, successful restore, source-volume recovery or historical data equivalence.',
      'Run the full ops/health-check.mjs against the final HTTPS URL; verify source freshness, provider authentication and Telegram delivery separately.',
      'Verify restart persistence on the target host before declaring migration complete. This read-only script does not restart the service.',
    ],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  let backupDirectory;
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--backup-directory') {
      console.error('Usage: node ops/free-host-preflight.mjs [--backup-directory /secure/export/data]');
      process.exit(2);
    }
    backupDirectory = path.resolve(args[1]);
  }
  const report = runPreflight({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), backupDirectory });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.technicalChecksPassed ? 0 : 1;
}
