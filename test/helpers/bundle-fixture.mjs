// The bundle a test fixture writes, in one place.
//
// Both repair suites build their bundles through this, and test/fixture-v2.test.mjs checks the
// properties of what it produces. Keeping one implementation is the point: a fixture that writes a
// manifest the product would never write makes every test built on it prove the wrong thing.
//
// What a manifest is supposed to look like, and why:
//
//   renderDigest   a digest of the two rendered files, as the renderer computes it
//   contentDigest  the same, whole-directory, so a payload outside those two files is covered too
//   configDigest   the older, value-only digest — still written, still meaning what it meant
//   configDigestV2 the version 2 summary: transport, command, argv in order, namespace, values
//
// The argv is built from the directory the bundle is rendered *into*, because that is what the
// renderer does. A backup is therefore produced by rendering at the canonical path and then moving
// the directory — never by rendering into the backup slot, which would name a path the server was
// never configured to run from.
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import * as tx from '../../tx.js';

/** The version 1 scheme: sha256 over sorted `key\0value\0` pairs. Written out, not imported. */
export function configDigestOf(values) {
  const list = values === null || values === undefined ? {} : values;
  const hash = createHash('sha256');
  for (const key of Object.keys(list).sort()) {
    hash.update(key);
    hash.update(String.fromCharCode(0));
    hash.update(String(list[key]));
    hash.update(String.fromCharCode(0));
  }
  return hash.digest('hex');
}

/**
 * Write a bundle directory and the manifest that describes it.
 *
 * `evidence` decides what the manifest claims about its configuration, so that a fixture can build
 * a normal new version, an older one, and the two kinds of unusable evidence on purpose:
 *
 *   'v2'          version 1 and version 2 evidence (what a current installation writes)
 *   'v1-only'     only the older digest, as a bundle installed before version 2 existed
 *   'damaged'     a version 2 field that is not a digest this code could have written
 *   'unsupported' a version 2 field from a scheme this code does not compare
 *   'none'        no configuration evidence at all
 */
export function writeBundleFiles(options) {
  const {
    dir, txid = 'tx-test', tag = 'v1', evidence = 'v2', patch, manifestJson,
    pkg, slug, rowId, serverName = 'notes', transport = 'stdio', command = 'node',
    configKeys = [], values = {}, argumentValues = {}, payload = null, url = null,
    argv = null, prefix = '',
  } = options;
  mkdirSync(dir, { recursive: true });
  const files = { 'package.json': manifestJson, 'cordis.patch.yml': patch };
  if (payload !== null) {
    mkdirSync(join(dir, 'mcpb', 'extracted'), { recursive: true });
    writeFileSync(join(dir, 'mcpb', 'package.mcpb'), payload, 'utf8');
  }
  const rendered = argv === null ? [join(dir, 'server.js')] : argv;
  const isHttp = transport === 'streamable-http';
  const summary = tx.configSummaryOf({
    transport,
    command,
    args: rendered,
    env: isHttp ? null : values,
    headers: isHttp ? values : null,
  });
  const meta = {
    registryName: prefix + 'vendor.example/notes', registryVersion: '1.0.0', installedAt: '2026-01-01T00:00:00Z', source: 'registry',
    slug, pkg, rowId, serverName, kind: 'stdio', transport, command,
    args: rendered, argumentValues, configKeys, url,
    txid,
    renderDigest: tx.digestOf(files),
  };
  if (evidence !== 'none') {
    meta.contentDigest = tx.digestOf({ ...files, ...(payload === null ? {} : { 'mcpb/package.mcpb': payload }) });
    meta.configDigest = configDigestOf(values);
  }
  if (evidence === 'v2') {
    meta.configDigestV2 = summary.digest;
    meta.configDigestVersion = summary.version;
    meta.configNamespace = summary.namespace;
  }
  if (evidence === 'damaged') {
    meta.configDigestV2 = 'not-a-digest';
    meta.configDigestVersion = summary.version;
    meta.configNamespace = summary.namespace;
  }
  if (evidence === 'unsupported') {
    meta.configDigestV2 = summary.digest;
    meta.configDigestVersion = 99;
    meta.configNamespace = summary.namespace;
  }
  writeFileSync(join(dir, 'package.json'), manifestJson, 'utf8');
  writeFileSync(join(dir, 'cordis.patch.yml'), patch, 'utf8');
  writeFileSync(join(dir, 'market.meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

/** Move a rendered bundle into a backup slot, the way an update moves it: a rename, nothing else. */
export function moveBundleTo(sourceDir, targetDir) {
  mkdirSync(dirname(targetDir), { recursive: true });
  rmSync(targetDir, { recursive: true, force: true });
  renameSync(sourceDir, targetDir);
}

/** The patch text both suites render, kept here so the contract test writes the same bundle. */
export const patchFor = (tag, rowId) =>
  '# ' + tag + '\n- insert:\n    - id: ' + rowId + '\n      name: \'@deepseek-ai/dsh-mcp-client\'\n      config:\n        serverName: notes\n';
