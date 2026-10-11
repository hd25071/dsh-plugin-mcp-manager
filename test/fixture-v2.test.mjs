// What the fixture writes, checked independently of the suites that use it.
//
// A test is only as good as the bundle it builds. If the fixture writes a manifest the product would
// never write — an argv naming a backup slot, a digest of values that were never rendered — then
// every case built on it proves something about a situation that cannot happen. This file checks the
// fixture itself, and checks that the two repair suites actually go through it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configDigestOf, moveBundleTo, patchFor, writeBundleFiles } from './helpers/bundle-fixture.mjs';

const tx = await import('../tx.js');

const root = mkdtempSync(join(tmpdir(), 'mcpm-fixturev2-'));
const SLUG = 'vendor-example-notes-06e87d';
const ROW = 'mcp-vendor-example-notes-06e87d';
const PKG = 'dsh-mcp-' + SLUG;
const ENTRY = 'vendor.example/notes';
const MANIFEST = JSON.stringify({ name: PKG, version: '1.0.0' }, null, 2);

let counter = 0;
function render(options = {}) {
  counter += 1;
  const dir = join(root, 'bundle-' + counter);
  const meta = writeBundleFiles({
    dir, patch: patchFor('v1', ROW), manifestJson: MANIFEST, pkg: PKG, slug: SLUG, rowId: ROW,
    configKeys: ['API_KEY'], values: { API_KEY: 'sk-alpha' }, ...options,
  });
  return { dir, meta, onDisk: JSON.parse(readFileSync(join(dir, 'market.meta.json'), 'utf8')) };
}

/** The version 1 scheme written out here, so the fixture is not checked against itself. */
function v1ByHand(values) {
  const hash = createHash('sha256');
  for (const key of Object.keys(values).sort()) {
    hash.update(key);
    hash.update(String.fromCharCode(0));
    hash.update(String(values[key]));
    hash.update(String.fromCharCode(0));
  }
  return hash.digest('hex');
}

test('[contract] the version 1 digest the fixture writes is the one the old scheme produced', () => {
  const { meta } = render();
  assert.equal(meta.configDigest, v1ByHand({ API_KEY: 'sk-alpha' }));
  assert.equal(meta.configDigest, configDigestOf({ API_KEY: 'sk-alpha' }));
});

test('[contract] the version 2 evidence describes the configuration that was rendered', () => {
  const { dir, onDisk } = render();
  const expected = tx.configSummaryOf({ transport: 'stdio', command: 'node', args: [join(dir, 'server.js')], env: { API_KEY: 'sk-alpha' }, headers: null });
  assert.equal(onDisk.configDigestV2, expected.digest);
  assert.equal(onDisk.configDigestVersion, 2);
  assert.equal(onDisk.configNamespace, 'env');
  assert.notEqual(onDisk.configDigestV2, onDisk.configDigest, 'two different computations, both present');
});

test('[contract] the command and the arguments are part of what the fixture digests', () => {
  const base = render();
  const otherCommand = render({ command: 'nodejs' });
  const otherArgs = render({ argv: ['/elsewhere/server.js'] });
  assert.notEqual(otherCommand.onDisk.configDigestV2, base.onDisk.configDigestV2, 'a different command');
  assert.notEqual(otherArgs.onDisk.configDigestV2, base.onDisk.configDigestV2, 'different arguments');
  assert.equal(otherCommand.onDisk.configDigest, base.onDisk.configDigest, 'while the older digest, which cannot see either, stays the same');
});

test('[contract] the argv the fixture writes names the directory the bundle is rendered into', () => {
  const { dir, onDisk } = render();
  assert.deepEqual(onDisk.args, [join(dir, 'server.js')]);
});

test('[contract] moving the bundle into a backup changes neither the argv nor the digest', () => {
  const { dir, onDisk } = render();
  const backup = join(root, 'backup-slot', 'tx-prev');
  moveBundleTo(dir, backup);

  const moved = JSON.parse(readFileSync(join(backup, 'market.meta.json'), 'utf8'));
  assert.deepEqual(moved.args, [join(dir, 'server.js')], 'the path it was published at, which a rename does not rewrite');
  assert.equal(moved.configDigestV2, onDisk.configDigestV2, 'and the summary of that configuration is unchanged');
  assert.equal(moved.configDigest, onDisk.configDigest);
  assert.equal(tx.verifyBundleContent(backup).matches, true);
  assert.equal(tx.readLiveBundle(backup).configEvidence, 'v2');
});

test('[contract] the namespace the fixture records follows the transport', () => {
  const stdio = render();
  const http = render({ transport: 'streamable-http', values: { Authorization: 'Bearer test' } });
  assert.equal(stdio.onDisk.configNamespace, 'env');
  assert.equal(http.onDisk.configNamespace, 'headers');
  assert.equal(http.onDisk.configDigestV2, tx.configSummaryOf({
    transport: 'streamable-http', command: 'node', args: [join(http.dir, 'server.js')], env: null, headers: { authorization: 'Bearer test' },
  }).digest, 'and it is the folded-header summary');
});

test('[contract] an edited configuration is not quietly corrected by the fixture', () => {
  const { dir, onDisk } = render();
  writeFileSync(join(dir, 'cordis.patch.yml'), '# edited after the fixture ran\n', 'utf8');

  const after = JSON.parse(readFileSync(join(dir, 'market.meta.json'), 'utf8'));
  assert.deepEqual(after, onDisk, 'the fixture writes the manifest once and never re-derives it');
  assert.equal(tx.verifyBundleContent(dir).matches, false, 'so the edit is visible as what it is');
});

test('[contract] the older fixture shape is still constructible, and has no version 2 fields', () => {
  const { onDisk } = render({ evidence: 'v1-only' });
  assert.equal(typeof onDisk.configDigest, 'string');
  assert.equal(onDisk.configDigestV2, undefined);
  assert.equal(onDisk.configDigestVersion, undefined);
  assert.equal(onDisk.configNamespace, undefined);
  assert.equal(tx.configEvidenceOf(onDisk).configEvidence, 'v1-only');
});

test('[contract] unusable version 2 evidence and no evidence at all are constructible too', () => {
  assert.equal(tx.configEvidenceOf(render({ evidence: 'damaged' }).onDisk).configEvidence, 'damaged');
  assert.equal(tx.configEvidenceOf(render({ evidence: 'unsupported' }).onDisk).configEvidence, 'unsupported-version');
  assert.equal(tx.configEvidenceOf(render({ evidence: 'none' }).onDisk).configEvidence, 'absent');
});

test('[contract] both repair suites build their bundles through this fixture', () => {
  for (const name of ['repair.test.mjs', 'repair-safety.test.mjs']) {
    const text = readFileSync(join(import.meta.dirname, name), 'utf8');
    assert.equal(text.includes("from './helpers/bundle-fixture.mjs'"), true, name + ' imports the shared fixture');
    assert.equal(/function writeBundle\(dir/.test(text), true, name + ' still writes bundles through a local wrapper');
    assert.equal(text.includes('function configDigestOf'), false, name + ' no longer keeps its own copy of the version 1 scheme');
  }
});
