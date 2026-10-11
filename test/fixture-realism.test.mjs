// What a backup actually is, and what a fixture has to do to be honest about it.
//
// An update never renders the old version into the backup directory. The old version was published
// at the canonical path, and then the directory *moved*: a rename rewrites nothing, so the argv and
// the command recorded inside its manifest still name the path it was published at. A fixture that
// renders a fresh manifest straight into backup/<txid> records the backup path instead, and every
// comparison that reads that manifest is then comparing a configuration that never existed.
//
// This file states that as a property, and it also states the difference, so a reader can see what
// the old shape got wrong rather than take it on trust.
//
// Everything here builds the bundle by hand and reads bytes back: no expectation below is produced
// by the helper it is checking.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'mcpm-fixture-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const market = await import('../market.js');
const tx = await import('../tx.js');

const ENTRY = 'vendor.example/notes';
const slug = market.slugFor(ENTRY);
const pkg = market.BUNDLE_PREFIX + slug;
const rowId = market.rowIdForSlug(slug);
const bundleDir = () => market.bundleDir(slug);
const txRoot = () => join(market.MARKET_ROOT, '.tx', slug);
const backupDir = (id) => join(txRoot(), 'backup', id);
const heldDir = () => join(txRoot(), 'held-while-rendering');

beforeEach(() => {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
});

const json = (value) => JSON.stringify(value, null, 2);
const PATCH = (tag) => '# ' + tag + '\n- insert:\n    - id: ' + rowId + '\n';
const PAYLOAD = 'mcpb-payload-bytes-0123456789';

/** A published bundle, built the way the renderer builds one: argv names the directory it is in. */
function renderBundle(dir, options = {}) {
  const { txid = 'tx-prev', tag = 'v1', payload = null } = options;
  mkdirSync(dir, { recursive: true });
  const manifest = json({ name: pkg, version: '1.0.0' });
  const patch = PATCH(tag);
  const files = { 'package.json': manifest, 'cordis.patch.yml': patch };
  if (payload !== null) {
    mkdirSync(join(dir, 'mcpb', 'extracted'), { recursive: true });
    writeFileSync(join(dir, 'mcpb', 'package.mcpb'), payload, 'utf8');
  }
  writeFileSync(join(dir, 'package.json'), manifest, 'utf8');
  writeFileSync(join(dir, 'cordis.patch.yml'), patch, 'utf8');
  writeFileSync(join(dir, 'market.meta.json'), json({
    registryName: ENTRY, registryVersion: '1.0.0', installedAt: '2026-01-01T00:00:00Z', source: 'registry',
    slug, pkg, rowId, serverName: 'notes', kind: 'stdio', transport: 'stdio', command: 'node',
    args: [join(dir, 'server.js')], argumentValues: { LOG_LEVEL: 'info' }, configKeys: ['API_KEY'],
    txid, renderDigest: tx.digestOf(files),
  }), 'utf8');
}

/** What an update really does: publish, then move the directory aside. Nothing is re-rendered. */
function movePublishedIntoBackup(backupTxid, options = {}) {
  const held = heldDir();
  const hadPublished = existsSync(bundleDir());
  if (hadPublished) {
    mkdirSync(dirname(held), { recursive: true });
    renameSync(bundleDir(), held);
  }
  renderBundle(bundleDir(), { txid: backupTxid, ...options });
  mkdirSync(dirname(backupDir(backupTxid)), { recursive: true });
  rmSync(backupDir(backupTxid), { recursive: true, force: true });
  renameSync(bundleDir(), backupDir(backupTxid));
  if (hadPublished) renameSync(held, bundleDir());
}

/** A snapshot of every byte under a directory, keyed by its relative path. */
function bytesUnder(root) {
  const out = {};
  const walk = (current, relative) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const key = relative === '' ? name : relative + '/' + name;
      if (statSync(full).isDirectory()) walk(full, key);
      else out[key] = readFileSync(full, 'utf8');
    }
  };
  walk(root, '');
  return out;
}

const manifestAt = (dir) => JSON.parse(readFileSync(join(dir, 'market.meta.json'), 'utf8'));

// --- the real invariant ------------------------------------------------------------------------

test('[contract] a directory that moves into a backup keeps every byte it had', () => {
  renderBundle(bundleDir(), { txid: 'tx-prev', tag: 'v1', payload: PAYLOAD });
  const before = bytesUnder(bundleDir());
  mkdirSync(dirname(backupDir('tx-prev')), { recursive: true });
  renameSync(bundleDir(), backupDir('tx-prev'));

  const after = bytesUnder(backupDir('tx-prev'));
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), 'the same files are there, under the same names');
  for (const key of Object.keys(before)) {
    assert.equal(after[key], before[key], key + ' is byte for byte what it was');
  }
  assert.equal(existsSync(join(backupDir('tx-prev'), 'mcpb', 'package.mcpb')), true);
});

test('[contract] the argv inside a backup still names the path it was published at', () => {
  movePublishedIntoBackup('tx-prev', { tag: 'v1' });
  const manifest = manifestAt(backupDir('tx-prev'));

  // The expectation is written out here, from the rule rather than from the fixture.
  assert.deepEqual(manifest.args, [join(bundleDir(), 'server.js')]);
  assert.equal(manifest.command, 'node');
  assert.deepEqual(manifest.argumentValues, { LOG_LEVEL: 'info' });
  assert.deepEqual(manifest.configKeys, ['API_KEY']);
  assert.equal(manifest.transport, 'stdio');
  assert.notEqual(manifest.args[0], join(backupDir('tx-prev'), 'server.js'),
    'the backup path is where it is stored now, not where it was configured to run');
});

test('[contract] a manifest rendered straight into the backup directory is observably different', () => {
  // The shape the old fixtures used: a fresh render with the backup directory as its location.
  renderBundle(backupDir('tx-prev'), { txid: 'tx-prev', tag: 'v1' });
  const rendered = manifestAt(backupDir('tx-prev'));
  rmSync(backupDir('tx-prev'), { recursive: true, force: true });

  movePublishedIntoBackup('tx-prev', { tag: 'v1' });
  const moved = manifestAt(backupDir('tx-prev'));

  assert.deepEqual(rendered.args, [join(backupDir('tx-prev'), 'server.js')]);
  assert.deepEqual(moved.args, [join(bundleDir(), 'server.js')]);
  assert.notDeepEqual(rendered.args, moved.args, 'the two fixtures disagree, which is the whole point');
});

test('[contract] restoring the previous version puts the canonical path back in its argv', () => {
  movePublishedIntoBackup('tx-prev', { tag: 'v1' });
  renameSync(backupDir('tx-prev'), bundleDir());
  const manifest = manifestAt(bundleDir());

  assert.deepEqual(manifest.args, [join(bundleDir(), 'server.js')]);
  assert.equal(existsSync(join(bundleDir(), 'server.js')), false);
});

test('[contract] nothing but the location changes when a published version becomes a backup', () => {
  renderBundle(bundleDir(), { txid: 'tx-prev', tag: 'v1' });
  const before = manifestAt(bundleDir());
  mkdirSync(dirname(backupDir('tx-prev')), { recursive: true });
  renameSync(bundleDir(), backupDir('tx-prev'));
  const after = manifestAt(backupDir('tx-prev'));

  for (const key of ['command', 'args', 'argumentValues', 'configKeys', 'transport', 'kind', 'serverName', 'rowId', 'slug', 'pkg', 'txid', 'renderDigest']) {
    assert.deepEqual(after[key], before[key], key + ' is untouched by the move');
  }
  assert.equal(existsSync(join(backupDir('tx-prev'), 'package.json')), true);
  assert.equal(readFileSync(join(backupDir('tx-prev'), 'package.json'), 'utf8'), json({ name: pkg, version: '1.0.0' }));
});

test('[contract] the same bundle in two different backup slots is the same bundle', () => {
  renderBundle(bundleDir(), { txid: 'tx-prev', tag: 'v1' });
  const snapshot = bytesUnder(bundleDir());
  mkdirSync(dirname(backupDir('tx-a')), { recursive: true });
  renameSync(bundleDir(), backupDir('tx-a'));
  renderBundle(bundleDir(), { txid: 'tx-prev', tag: 'v1' });
  renameSync(bundleDir(), backupDir('tx-b'));

  const one = bytesUnder(backupDir('tx-a'));
  const two = bytesUnder(backupDir('tx-b'));
  assert.deepEqual(two, one, 'where a copy is stored does not change what it says');
  assert.deepEqual(one, snapshot, 'and neither changed the version itself');
});

test('[contract] an mcpb payload is intact after the move back', () => {
  renderBundle(bundleDir(), { txid: 'tx-prev', tag: 'v1', payload: PAYLOAD });
  mkdirSync(dirname(backupDir('tx-prev')), { recursive: true });
  renameSync(bundleDir(), backupDir('tx-prev'));
  const stored = readFileSync(join(backupDir('tx-prev'), 'mcpb', 'package.mcpb'), 'utf8');
  renameSync(backupDir('tx-prev'), bundleDir());

  assert.equal(stored, PAYLOAD);
  assert.equal(readFileSync(join(bundleDir(), 'mcpb', 'package.mcpb'), 'utf8'), PAYLOAD);
  assert.equal(existsSync(join(bundleDir(), 'mcpb', 'extracted')), true);
});

// --- and the deliberately damaged case, which must stay damaged ---------------------------------

test('[contract] a backup damaged on purpose is still refused, realistically stored or not', () => {
  movePublishedIntoBackup('tx-prev', { tag: 'v1' });
  const clean = tx.verifyBundleContent(backupDir('tx-prev'));
  assert.equal(clean.verifiable, true);
  assert.equal(clean.matches, true);

  // This one is *meant* to be wrong: the anomaly is the edit, not how it got there.
  writeFileSync(join(backupDir('tx-prev'), 'cordis.patch.yml'), '# edited-after-the-move\n', 'utf8');
  const damaged = tx.verifyBundleContent(backupDir('tx-prev'));
  assert.equal(damaged.matches, false, 'the content no longer matches what the manifest recorded');
  assert.equal(damaged.verifiable, true);
});
