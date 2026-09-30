import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { captureVolume, verifyVolume, restoreVolume } from '../ops/volume-migration.mjs';

const owner = { uid: process.getuid(), gid: process.getgid() };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-migration-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const bundle = path.join(root, 'bundle');
  const target = path.join(root, 'target');
  fs.mkdirSync(source, { mode: 0o700 }); fs.mkdirSync(target, { mode: 0o700 });
  const contents = {
    'signal-journal.json': JSON.stringify({ entries: [{ id: 'historical-alert', createdAt: '2026-09-24T08:00:00Z' }] }),
    'catalyst-state.json': JSON.stringify({ seen: [['old-id', 1780000000000]], deliveryOutbox: [{ id: 'pending', deliveries: { telegram: { status: 'pending', attempts: 2, nextAttemptAt: 1780000600000 } } }] }),
    'eia-state.json': '{"seen":["eia-release"]}',
    'ecb-state.json': '{"primed":true}',
    'trump-oil-monitor.json': '{"incidents":[{"id":"oil-incident"}]}',
    'kimi-research-shadow.json': '{"mode":"shadow"}',
    '.private-state': 'private-canary-value-not-for-output',
    '.radar-recovery/before-free/data/catalyst-state.json': '{"seen":["older-state"]}',
    '.radar-recovery/before-free/manifest.json': '{"historical":"manifest-retained-verbatim"}',
    'empty-file': ''
  };
  for (const [name, value] of Object.entries(contents)) {
    const location = path.join(source, name); fs.mkdirSync(path.dirname(location), { recursive: true, mode: 0o700 }); fs.writeFileSync(location, value, { mode: 0o600 });
  }
  fs.mkdirSync(path.join(source, 'empty-directory'));
  return { root, source, bundle, target, contents };
}
function capture(f) { return captureVolume({ source: f.source, bundle: f.bundle }); }
function restore(f, captured, extra = {}) { return restoreVolume({ bundle: f.bundle, target: f.target, expectedManifestSha256: captured.manifestSha256, owner, ...extra }); }
function rewriteManifest(bundle, change) {
  const location = path.join(bundle, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(location)); change(manifest);
  const raw = `${JSON.stringify(manifest)}\n`; fs.writeFileSync(location, raw); return digest(raw);
}

test('full export/verify/restore retains journal, pending outbox, recovery copies, dotfiles and empty paths', t => {
  const f = fixture(t);
  const captured = capture(f);
  assert.equal(captured.files, Object.keys(f.contents).length);
  assert.equal(fs.existsSync(`${f.bundle}.partial`), false);
  assert.equal(fs.statSync(f.bundle).mode & 0o077, 0);
  assert.equal(verifyVolume({ bundle: f.bundle, expectedManifestSha256: captured.manifestSha256 }).files, captured.files);
  const restored = restore(f, captured);
  assert.equal(restored.bytes, captured.bytes);
  for (const [name, value] of Object.entries(f.contents)) {
    assert.equal(fs.readFileSync(path.join(f.target, name), 'utf8'), value);
    assert.equal(fs.readFileSync(path.join(f.source, name), 'utf8'), value);
    assert.equal(fs.statSync(path.join(f.target, name)).uid, owner.uid);
    assert.equal(fs.statSync(path.join(f.target, name)).mode & 0o077, 0);
  }
  assert.ok(fs.statSync(path.join(f.target, 'empty-directory')).isDirectory());
  assert.equal(fs.existsSync(`${f.target}.radar-import.partial`), false);
});

test('capture and restore never overwrite existing output or nonempty target', t => {
  const f = fixture(t); const captured = capture(f);
  const before = fs.readFileSync(path.join(f.bundle, 'manifest.json'));
  assert.throws(() => capture(f), { code: 'DESTINATION_OR_PARTIAL_EXISTS' });
  fs.writeFileSync(path.join(f.target, 'keep'), 'existing-target-data');
  assert.throws(() => restore(f, captured), { code: 'TARGET_NOT_EMPTY' });
  assert.equal(fs.readFileSync(path.join(f.target, 'keep'), 'utf8'), 'existing-target-data');
  assert.deepEqual(fs.readFileSync(path.join(f.bundle, 'manifest.json')), before);
});

test('pre-existing partial bundles and restores are retained and require review', t => {
  const f = fixture(t);
  fs.mkdirSync(`${f.bundle}.partial`); fs.writeFileSync(path.join(`${f.bundle}.partial`, 'evidence'), 'capture-crash');
  assert.throws(() => capture(f), { code: 'DESTINATION_OR_PARTIAL_EXISTS' });
  assert.equal(fs.readFileSync(path.join(`${f.bundle}.partial`, 'evidence'), 'utf8'), 'capture-crash');
  const other = path.join(f.root, 'other-bundle');
  const captured = captureVolume({ source: f.source, bundle: other });
  fs.mkdirSync(`${f.target}.radar-import.partial`); fs.writeFileSync(path.join(`${f.target}.radar-import.partial`, 'evidence'), 'restore-crash');
  assert.throws(() => restoreVolume({ bundle: other, target: f.target, expectedManifestSha256: captured.manifestSha256, owner }), { code: 'PARTIAL_REQUIRES_REVIEW' });
  assert.equal(fs.readFileSync(path.join(`${f.target}.radar-import.partial`, 'evidence'), 'utf8'), 'restore-crash');
  assert.deepEqual(fs.readdirSync(f.target), []);
});

test('source symlinks and symlink output ancestors are rejected', t => {
  const f = fixture(t); const outside = path.join(f.root, 'outside'); fs.writeFileSync(outside, 'never-copy');
  fs.symlinkSync(outside, path.join(f.source, 'link'));
  assert.throws(() => capture(f), { code: 'SYMLINK_FORBIDDEN' });
  assert.equal(fs.existsSync(f.bundle), false); assert.equal(fs.existsSync(`${f.bundle}.partial`), false);
  fs.unlinkSync(path.join(f.source, 'link'));
  fs.symlinkSync(f.root, path.join(f.root, 'alias'));
  assert.throws(() => captureVolume({ source: f.source, bundle: path.join(f.root, 'alias', 'output') }), { code: 'UNSAFE_DIRECTORY' });
});

test('manifest hash mismatch, corrupt data, extra files and symlinked bundle files block restore', t => {
  const f = fixture(t); const captured = capture(f);
  assert.throws(() => restore(f, { manifestSha256: '0'.repeat(64) }), { code: 'MANIFEST_HASH_MISMATCH' });
  const dataFile = path.join(f.bundle, 'data', 'eia-state.json');
  fs.writeFileSync(dataFile, 'corrupt');
  assert.throws(() => restore(f, captured), { code: 'BUNDLE_DATA_MISMATCH' });
  fs.writeFileSync(dataFile, f.contents['eia-state.json']);
  fs.writeFileSync(path.join(f.bundle, 'data', 'unexpected'), 'extra');
  assert.throws(() => restore(f, captured), { code: 'BUNDLE_DATA_MISMATCH' });
  fs.unlinkSync(path.join(f.bundle, 'data', 'unexpected')); fs.unlinkSync(dataFile); fs.symlinkSync(path.join(f.source, 'eia-state.json'), dataFile);
  assert.throws(() => restore(f, captured), { code: 'SYMLINK_FORBIDDEN' });
  assert.deepEqual(fs.readdirSync(f.target), []);
});

test('even a repinned manifest cannot traverse paths or declare duplicate paths', t => {
  for (const badPath of ['../escape', '/absolute', 'nested/../../escape', 'windows\\escape', 'nested//file']) {
    const f = fixture(t); capture(f);
    const manifestSha256 = rewriteManifest(f.bundle, manifest => { manifest.entries[0].path = badPath; });
    assert.throws(() => restore(f, { manifestSha256 }), { code: 'UNSAFE_MANIFEST_PATH' });
    assert.deepEqual(fs.readdirSync(f.target), []);
  }
  const f = fixture(t); capture(f);
  const manifestSha256 = rewriteManifest(f.bundle, manifest => { manifest.entries.push(manifest.entries[0]); });
  assert.throws(() => restore(f, { manifestSha256 }), { code: 'DUPLICATE_MANIFEST_PATH' });
});

test('insufficient space creates neither a bundle stage nor a restore stage', t => {
  const f = fixture(t); const noSpace = () => ({ bsize: 4096, bavail: 0 });
  assert.throws(() => captureVolume({ ...f, statfs: noSpace }), { code: 'INSUFFICIENT_SPACE' });
  assert.equal(fs.existsSync(`${f.bundle}.partial`), false);
  const captured = capture(f);
  assert.throws(() => restore(f, captured, { statfs: noSpace }), { code: 'INSUFFICIENT_SPACE' });
  assert.equal(fs.existsSync(`${f.target}.radar-import.partial`), false);
  assert.deepEqual(fs.readdirSync(f.target), []);
});

test('source mutation during capture leaves evidence but no completed bundle', t => {
  const f = fixture(t);
  assert.throws(() => captureVolume({ ...f, statfs: directory => {
    fs.writeFileSync(path.join(f.source, 'eia-state.json'), 'concurrent-source-change'); return fs.statfsSync(directory);
  } }), { code: 'SOURCE_CHANGED' });
  assert.equal(fs.existsSync(f.bundle), false);
  assert.equal(fs.existsSync(`${f.bundle}.partial`), true);
  assert.throws(() => capture(f), { code: 'DESTINATION_OR_PARTIAL_EXISTS' });
  assert.equal(fs.readFileSync(path.join(f.source, 'eia-state.json'), 'utf8'), 'concurrent-source-change');
});

test('a corrupted source mid-restore leaves the target empty and never acknowledges success', t => {
  const f = fixture(t); const captured = capture(f);
  assert.throws(() => restore(f, captured, { statfs: directory => {
    fs.writeFileSync(path.join(f.bundle, 'data', 'eia-state.json'), 'changed-during-copy'); return fs.statfsSync(directory);
  } }), { code: 'SOURCE_CHANGED' });
  assert.deepEqual(fs.readdirSync(f.target), []);
  assert.ok(fs.existsSync(`${f.target}.radar-import.partial`));
});

test('a concurrently populated target cannot be replaced by the restored snapshot', t => {
  const f = fixture(t); const captured = capture(f);
  assert.throws(() => restore(f, captured, { statfs: directory => {
    fs.writeFileSync(path.join(f.target, 'new-owner-data'), 'keep'); return fs.statfsSync(directory);
  } }), { code: 'TARGET_CHANGED' });
  assert.equal(fs.readFileSync(path.join(f.target, 'new-owner-data'), 'utf8'), 'keep');
  assert.ok(fs.existsSync(`${f.target}.radar-import.partial`));
});

test('repository output, overlapping paths, empty sources and missing owner fail closed', t => {
  const f = fixture(t); const repo = path.join(f.root, 'repo'); fs.mkdirSync(repo); fs.mkdirSync(path.join(repo, '.git'));
  assert.throws(() => captureVolume({ source: f.source, bundle: path.join(repo, 'data-export') }), { code: 'REPOSITORY_OUTPUT_FORBIDDEN' });
  assert.throws(() => captureVolume({ source: f.source, bundle: path.join(f.source, 'bundle') }), { code: 'OVERLAPPING_PATHS' });
  assert.throws(() => captureVolume({ source: f.target, bundle: f.bundle }), { code: 'EMPTY_SOURCE' });
  const captured = capture(f);
  assert.throws(() => restore(f, captured, { owner: undefined }), { code: 'EXPLICIT_OWNER_REQUIRED' });
});

test('CLI emits counts/hash or bounded error codes, never state payloads or parser content', t => {
  const f = fixture(t);
  const tool = new URL('../ops/volume-migration.mjs', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [tool, 'capture', '--source', f.source, '--bundle', f.bundle], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.includes('private-canary-value-not-for-output'), false);
  assert.equal(result.stdout.includes(f.source), false);
  const captured = JSON.parse(result.stdout);
  const verified = spawnSync(process.execPath, [tool, 'verify', '--bundle', f.bundle, '--manifest-sha256', captured.manifestSha256], { encoding: 'utf8' });
  assert.equal(verified.status, 0);
  const manifestPath = path.join(f.bundle, 'manifest.json'); const raw = 'private-canary-invalid-json'; fs.writeFileSync(manifestPath, raw);
  const rejected = spawnSync(process.execPath, [tool, 'verify', '--bundle', f.bundle, '--manifest-sha256', digest(raw)], { encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.deepEqual(JSON.parse(rejected.stderr), { ok: false, error: 'INVALID_MANIFEST' });
  assert.equal(rejected.stderr.includes('private-canary'), false);
});
