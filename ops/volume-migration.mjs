#!/usr/bin/env node
// Offline file operations only. No account access, network, deployment or source deletion.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const fail = code => { const error = new Error(code); error.code = code; throw error; };
const exists = location => Boolean(fs.lstatSync(location, { throwIfNoEntry: false }));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const noFollow = fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
function safe(action) {
  try { return action(); }
  catch (error) { fail(/^[A-Z][A-Z0-9_]*$/.test(error.code || '') ? error.code : 'MIGRATION_FAILED'); }
}
function directory(location) {
  const stat = fs.lstatSync(location);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(location) !== location) fail('UNSAFE_DIRECTORY');
  return stat;
}
function relativeName(name) {
  if (typeof name !== 'string' || !name || name.length > 4096 || /[\\\x00-\x1f]/.test(name) ||
      path.posix.isAbsolute(name) || name.split('/').some(part => !part || part === '.' || part === '..')) fail('UNSAFE_MANIFEST_PATH');
}
function noRepositoryOutput(location) {
  for (let parent = path.dirname(location); ; parent = path.dirname(parent)) {
    if (exists(path.join(parent, '.git'))) fail('REPOSITORY_OUTPUT_FORBIDDEN');
    if (parent === path.dirname(parent)) break;
  }
}
function syncDirectory(location) {
  const fd = fs.openSync(location, fs.constants.O_RDONLY | noFollow);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function readFile(location, destination) {
  directory(path.dirname(location));
  const beforePath = fs.lstatSync(location, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) fail('NON_REGULAR_FILE');
  const fd = fs.openSync(location, fs.constants.O_RDONLY | noFollow);
  let output;
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.ino !== beforePath.ino || before.dev !== beforePath.dev) fail('SOURCE_CHANGED');
    if (destination) {
      directory(path.dirname(destination));
      output = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    }
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(65536);
    let bytes = 0;
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      digest.update(buffer.subarray(0, count));
      if (output !== undefined) {
        let written = 0;
        while (written < count) written += fs.writeSync(output, buffer, written, count - written);
      }
      bytes += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const afterPath = fs.lstatSync(location, { bigint: true });
    if (before.ino !== afterPath.ino || before.dev !== afterPath.dev || afterPath.isSymbolicLink() ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(bytes) !== after.size) fail('SOURCE_CHANGED');
    if (output !== undefined) fs.fsyncSync(output);
    return { bytes, sha256: digest.digest('hex') };
  } finally { fs.closeSync(fd); if (output !== undefined) fs.closeSync(output); }
}
function inventory(root) {
  directory(root);
  const entries = [];
  function walk(parent, prefix = '') {
    directory(parent);
    for (const name of fs.readdirSync(parent).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      relativeName(relative);
      const location = path.join(parent, name);
      const stat = fs.lstatSync(location);
      if (stat.isSymbolicLink()) fail('SYMLINK_FORBIDDEN');
      if (stat.isDirectory()) {
        entries.push({ path: relative, type: 'directory' });
        walk(location, relative);
      } else if (stat.isFile()) entries.push({ path: relative, type: 'file', ...readFile(location) });
      else fail('NON_REGULAR_FILE');
    }
  }
  walk(root);
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function summary(entries) {
  return { files: entries.filter(entry => entry.type === 'file').length,
    directories: entries.filter(entry => entry.type === 'directory').length,
    bytes: entries.reduce((sum, entry) => sum + (entry.bytes || 0), 0) };
}
function requireSpace(parent, entries, statfs) {
  const space = statfs(parent);
  const block = Number(space.bsize);
  const available = Number(space.bavail) * block;
  const required = entries.reduce((sum, entry) => sum + (entry.type === 'file' ? Math.ceil(entry.bytes / block) * block : block), 0) + 1048576 + entries.length * 4096;
  if (!Number.isFinite(required) || !Number.isFinite(available) || block <= 0 || available < required) fail('INSUFFICIENT_SPACE');
}
function copyInventory(source, destination, entries) {
  for (const entry of entries.filter(entry => entry.type === 'directory').sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
    fs.mkdirSync(path.join(destination, entry.path), { mode: 0o700 });
  }
  for (const entry of entries.filter(entry => entry.type === 'file')) {
    const result = readFile(path.join(source, entry.path), path.join(destination, entry.path));
    if (result.bytes !== entry.bytes || result.sha256 !== entry.sha256) fail('SOURCE_CHANGED');
  }
  if (!equal(inventory(source), entries) || !equal(inventory(destination), entries)) fail('SOURCE_CHANGED');
}
function syncTree(root, entries) {
  for (const entry of entries.filter(entry => entry.type === 'directory').sort((a, b) => b.path.split('/').length - a.path.split('/').length)) syncDirectory(path.join(root, entry.path));
  syncDirectory(root);
}
function separated(source, destination) {
  if (source === destination || destination.startsWith(`${source}${path.sep}`) || source.startsWith(`${destination}${path.sep}`)) fail('OVERLAPPING_PATHS');
}
function inspectBundle(bundle, expectedManifestSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedManifestSha256 || '')) fail('EXPECTED_MANIFEST_HASH_REQUIRED');
  const stat = directory(bundle);
  if (stat.mode & 0o077) fail('PRIVATE_BUNDLE_REQUIRED');
  if (!equal(fs.readdirSync(bundle).sort(), ['data', 'manifest.json'])) fail('INVALID_BUNDLE');
  const manifestPath = path.join(bundle, 'manifest.json');
  const manifestStat = fs.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 32 * 1024 * 1024) fail('INVALID_MANIFEST');
  const fd = fs.openSync(manifestPath, fs.constants.O_RDONLY | noFollow);
  let raw;
  try {
    if (!fs.fstatSync(fd).isFile()) fail('INVALID_MANIFEST');
    raw = fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
  if (hash(raw) !== expectedManifestSha256) fail('MANIFEST_HASH_MISMATCH');
  let manifest;
  try { manifest = JSON.parse(raw.toString('utf8')); } catch { fail('INVALID_MANIFEST'); }
  if (manifest.version !== 1 || !Array.isArray(manifest.entries)) fail('INVALID_MANIFEST');
  const seen = new Set();
  for (const entry of manifest.entries) {
    relativeName(entry?.path);
    if (seen.has(entry.path)) fail('DUPLICATE_MANIFEST_PATH');
    seen.add(entry.path);
    if (!['file', 'directory'].includes(entry.type)) fail('INVALID_MANIFEST');
    if (entry.type === 'file' && (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256 || ''))) fail('INVALID_MANIFEST');
  }
  if (!equal(inventory(path.join(bundle, 'data')), manifest.entries)) fail('BUNDLE_DATA_MISMATCH');
  return manifest;
}

export function captureVolume({ source, bundle, statfs = fs.statfsSync }) {
  return safe(() => {
    source = path.resolve(source); bundle = path.resolve(bundle);
    const partial = `${bundle}.partial`;
    separated(source, bundle);
    noRepositoryOutput(bundle);
    directory(path.dirname(bundle));
    if (exists(bundle) || exists(partial)) fail('DESTINATION_OR_PARTIAL_EXISTS');
    const entries = inventory(source);
    if (!entries.some(entry => entry.type === 'file')) fail('EMPTY_SOURCE');
    requireSpace(path.dirname(bundle), entries, statfs);
    fs.mkdirSync(partial, { mode: 0o700 });
    fs.mkdirSync(path.join(partial, 'data'), { mode: 0o700 });
    copyInventory(source, path.join(partial, 'data'), entries);
    const manifest = { version: 1, capturedAt: new Date().toISOString(), entries };
    const raw = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestSha256 = hash(raw);
    const fd = fs.openSync(path.join(partial, 'manifest.json'), 'wx', 0o600);
    try { fs.writeFileSync(fd, raw); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    inspectBundle(partial, manifestSha256);
    syncTree(path.join(partial, 'data'), entries); syncDirectory(partial);
    if (exists(bundle)) fail('DESTINATION_OR_PARTIAL_EXISTS');
    fs.renameSync(partial, bundle); syncDirectory(path.dirname(bundle));
    return { ok: true, operation: 'capture', manifestSha256, ...summary(entries) };
  });
}

export function verifyVolume({ bundle, expectedManifestSha256 }) {
  return safe(() => {
    const manifest = inspectBundle(path.resolve(bundle), expectedManifestSha256);
    return { ok: true, operation: 'verify', manifestSha256: expectedManifestSha256, ...summary(manifest.entries) };
  });
}

export function restoreVolume({ bundle, target, expectedManifestSha256, owner, statfs = fs.statfsSync }) {
  return safe(() => {
    bundle = path.resolve(bundle); target = path.resolve(target);
    separated(bundle, target);
    noRepositoryOutput(target);
    const partial = `${target}.radar-import.partial`;
    if (!owner || ![owner.uid, owner.gid].every(id => Number.isInteger(id) && id >= 0 && id <= 4294967294)) fail('EXPLICIT_OWNER_REQUIRED');
    if (process.getuid() !== 0 && (owner.uid !== process.getuid() || owner.gid !== process.getgid())) fail('OWNER_PERMISSION_REQUIRED');
    const targetStat = directory(target);
    const parentStat = directory(path.dirname(target));
    if (targetStat.dev !== parentStat.dev) fail('RESTORE_REQUIRES_UNMOUNTED_HOST_DIRECTORY');
    if (fs.readdirSync(target).length) fail('TARGET_NOT_EMPTY');
    if (exists(partial)) fail('PARTIAL_REQUIRES_REVIEW');
    const manifest = inspectBundle(bundle, expectedManifestSha256);
    const entries = manifest.entries;
    requireSpace(path.dirname(target), entries, statfs);
    fs.mkdirSync(partial, { mode: 0o700 });
    copyInventory(path.join(bundle, 'data'), partial, entries);
    inspectBundle(bundle, expectedManifestSha256);
    for (const entry of [...entries].sort((a, b) => b.path.split('/').length - a.path.split('/').length)) fs.chownSync(path.join(partial, entry.path), owner.uid, owner.gid);
    fs.chownSync(partial, owner.uid, owner.gid);
    syncTree(partial, entries);
    const current = directory(target);
    if (current.ino !== targetStat.ino || current.dev !== targetStat.dev || fs.readdirSync(target).length) fail('TARGET_CHANGED');
    fs.renameSync(partial, target); syncDirectory(path.dirname(target));
    return { ok: true, operation: 'restore', manifestSha256: expectedManifestSha256, ...summary(entries) };
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const [operation, ...args] = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!args[i]?.startsWith('--') || !args[i + 1] || Object.hasOwn(options, args[i])) fail('INVALID_ARGUMENTS');
      options[args[i]] = args[i + 1];
    }
    const allowed = operation === 'capture' ? ['--source', '--bundle'] : operation === 'verify' ? ['--bundle', '--manifest-sha256'] : operation === 'restore' ? ['--bundle', '--target', '--manifest-sha256', '--owner'] : [];
    if (!allowed.length || !equal(Object.keys(options).sort(), [...allowed].sort())) fail('INVALID_ARGUMENTS');
    const config = { source: options['--source'], bundle: options['--bundle'], target: options['--target'], expectedManifestSha256: options['--manifest-sha256'] };
    if (operation === 'restore') {
      if (!/^\d+:\d+$/.test(options['--owner'])) fail('EXPLICIT_OWNER_REQUIRED');
      const [uid, gid] = options['--owner'].split(':').map(Number); config.owner = { uid, gid };
    }
    const result = operation === 'capture' ? captureVolume(config) : operation === 'verify' ? verifyVolume(config) : restoreVolume(config);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: /^[A-Z][A-Z0-9_]*$/.test(error.code || '') ? error.code : 'MIGRATION_FAILED' }));
    process.exitCode = 1;
  }
}
