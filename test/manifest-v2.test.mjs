// What a new installation writes down about its configuration, and what it must not hand out.
//
// Two kinds of case:
//
//   [defect]    the listing returned digests of the installed bundle to anyone who asked. That is a
//               real behaviour of the shipped code — a digest of a low-entropy value is a guessing
//               oracle — so this case fails on it and is labelled as the regression it is.
//   [contract]  the version 2 evidence a manifest should carry from now on, and how a reader must
//               treat it when it is missing, damaged or of an unknown version.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'mcpm-v2b-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const market = await import('../market.js');
const tx = await import('../tx.js');
const host = await import('../index.js');

const ENTRY = 'vendor.example/notes';
const PROFILES = join(home, '.dsh', 'profiles');
const slug = market.slugFor(ENTRY);
const bundleDir = () => market.bundleDir(slug);
const manifestPath = () => join(bundleDir(), 'market.meta.json');
const manifest = () => JSON.parse(readFileSync(manifestPath(), 'utf8'));

beforeEach(() => {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  market.resetCatalog();
});

const post = (payload) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
const call = async (routes, path, payload) => {
  const response = await routes.get(path).fetch(new Request('http://local' + path, post(payload)));
  return { status: response.status, body: await response.json() };
};

function seedCache() {
  mkdirSync(dirname(market.CACHE_PATH), { recursive: true });
  writeFileSync(market.CACHE_PATH, JSON.stringify({
    cacheVersion: market.CACHE_VERSION, fetchedAt: new Date().toISOString(), count: 1,
    servers: [{
      name: ENTRY, title: 'Vendor Notes', description: 'one entry', version: '1.0.0',
      publishedAt: '2026-01-01T00:00:00Z', remotes: [],
      packages: [{ registryType: 'npm', identifier: '@example/notes', version: '1.0.0', transport: 'stdio', environmentVariables: [], packageArguments: [] }],
    }],
  }), 'utf8');
  market.resetCatalog();
}

function makeCtx() {
  mkdirSync(join(PROFILES, 'desktop'), { recursive: true });
  const routes = new Map();
  const ctx = {
    get(key) {
      if (key === 'connection') return { fetch: { register(spec) { routes.set(spec.path, spec); } } };
      if (key === 'profileContext') return { name: 'desktop', dir: join(PROFILES, 'desktop') };
      if (key === 'pluginManager') {
        return {
          async installBundle() { return { application: 'applied' }; },
          async removeBundle() { return { application: 'applied' }; },
          listBundles() { return [{ name: market.BUNDLE_PREFIX + slug, installed: true, enabled: true, removable: true, rows: [{ rowId: market.rowIdForSlug(slug), moduleName: host.MCP_MODULE }] }]; },
        };
      }
      if (key === 'configEditor') {
        return { configuration() { return [{ entry: { options: { id: market.rowIdForSlug(slug), name: host.MCP_MODULE } }, inherited: {}, override: { transport: 'stdio', serverName: 'notes' } }]; } };
      }
      return undefined;
    },
  };
  host.apply(ctx);
  return routes;
}

/** Install the one entry the cache holds, and hand back the routes for more requests. */
async function install() {
  seedCache();
  const routes = makeCtx();
  const response = await call(routes, host.MARKET_INSTALL_PATH, { name: ENTRY, optionIndex: 0, config: {} });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(existsSync(manifestPath()), true, 'the install wrote a manifest');
  return routes;
}

// --- the listing must not hand out digests -------------------------------------------------------

test('[defect] the installed listing does not return digests of the bundle', async () => {
  const routes = await install();
  const listed = await call(routes, host.MARKET_INSTALLED_PATH, {});
  const item = (listed.body.value.items || []).find((entry) => entry.slug === slug);
  assert.equal(item !== undefined, true, 'the bundle is listed');
  const text = JSON.stringify(item);
  for (const field of ['renderDigest', 'contentDigest', 'configDigest', 'configDigestV2']) {
    assert.equal(text.includes(field), false, 'the listing must not carry ' + field + ': ' + text.slice(0, 200));
  }
});

test('[contract] the listing carries the fields a person needs and no configured values', async () => {
  const routes = await install();
  const listed = await call(routes, host.MARKET_INSTALLED_PATH, {});
  const item = (listed.body.value.items || []).find((entry) => entry.slug === slug);
  for (const field of ['slug', 'pkg', 'rowId', 'serverName', 'kind', 'transport', 'installedAt']) {
    assert.equal(item[field] !== undefined, true, 'the listing still carries ' + field);
  }
  assert.equal(JSON.stringify(item).includes('argumentValues'), false);
  assert.equal(JSON.stringify(item).includes('"env"'), false, 'and no environment block');
});

// --- the evidence a new installation writes ------------------------------------------------------

test('[contract] a new installation writes both a version 1 and a version 2 summary', async () => {
  await install();
  const written = manifest();
  assert.equal(typeof written.configDigest, 'string');
  assert.equal(written.configDigest.length, 64, 'the version 1 field is still written, unchanged in shape');
  assert.equal(typeof written.configDigestV2, 'string');
  assert.equal(written.configDigestV2.length, 64, 'and a separate version 2 summary beside it');
  assert.equal(written.configDigestVersion, 2);
  assert.equal(written.configNamespace, 'env');
  assert.notEqual(written.configDigestV2, written.configDigest, 'the two are different computations, not one copied twice');
});

test('[contract] the version 1 field still means exactly what it meant', async () => {
  await install();
  const written = manifest();
  // Version 1 hashes the configured values and nothing else. This install configures none, so the
  // digest must be the digest of an empty set — the old computation, unchanged.
  assert.equal(written.configDigest, tx.configDigestOf({}));
  assert.deepEqual(written.configKeys, []);
});

test('[contract] the version 2 summary describes the command and arguments that were rendered', async () => {
  await install();
  const written = manifest();
  const expected = tx.configSummaryOf({
    transport: written.transport,
    command: written.command,
    args: written.args || [],
    env: {},
    headers: null,
  });
  assert.equal(written.configDigestV2, expected.digest, 'computed from what the manifest says was rendered');
  assert.equal(typeof written.command, 'string', 'the command that was rendered is recorded, resolved or not');
  assert.equal(written.command.length > 0, true);
  assert.equal(Array.isArray(written.args), true, 'the arguments are recorded as the argv they became');
});

test('[contract] the namespace follows the transport, not the shape of the values', async () => {
  await install();
  assert.equal(manifest().configNamespace, 'env', 'a stdio server configures environment variables');
});

test('[contract] a header-named server is summarised as headers, and their names are folded', () => {
  const dir = join(home, 'headers-bundle');
  mkdirSync(dir, { recursive: true });
  const plan = { kind: 'http', registryType: 'npm', transport: 'streamable-http', command: 'node', url: 'https://example.test/mcp' };
  const server = { name: ENTRY, version: '1.0.0', title: 'Vendor Notes', source: 'registry' };
  const written = market.writeBundle({
    slug, rowId: market.rowIdForSlug(slug), server, serverName: 'notes', plan, args: [], config: { Authorization: 'Bearer test' },
    argumentValues: {}, txid: 'tx-h', dir,
  });
  const onDisk = JSON.parse(readFileSync(join(dir, 'market.meta.json'), 'utf8'));
  assert.equal(onDisk.configNamespace, 'headers');
  assert.equal(onDisk.configDigestVersion, 2);
  // From what the manifest itself says was rendered: an http plan carries no command, and its
  // argument list is empty rather than absent.
  assert.equal(onDisk.configDigestV2, tx.configSummaryOf({
    transport: onDisk.transport, command: onDisk.command, args: onDisk.args || [], env: null,
    headers: { authorization: 'Bearer test' },
  }).digest, 'and the digest is the folded-header one');
  assert.equal(typeof written.txid, 'string');
});

test('[contract] a duplicate header name in two spellings is reported, never silently merged', () => {
  const summary = tx.configSummaryOf({ transport: 'streamable-http', env: null, headers: { Authorization: 'Bearer a', authorization: 'Bearer b' } });
  assert.deepEqual(summary.collisions, ['authorization'], 'two spellings of one header are a collision that has to be visible');
  // Both spellings are inside the digest, so neither value was dropped: dropping one would make
  // this equal to the digest of the other alone.
  const one = tx.configSummaryOf({ transport: 'streamable-http', env: null, headers: { authorization: 'Bearer a' } });
  assert.notEqual(summary.digest, one.digest);
  assert.notEqual(summary.digest, tx.configSummaryOf({ transport: 'streamable-http', env: null, headers: { authorization: 'Bearer b' } }).digest);
  assert.deepEqual(summary.configuredKeys, ['authorization', 'authorization'], 'the folded names are reported as what was digested');
});

// --- what a reader makes of the evidence ---------------------------------------------------------

function writeManifest(fields) {
  mkdirSync(bundleDir(), { recursive: true });
  const manifestJson = JSON.stringify({ name: 'x', version: '1.0.0' }, null, 2);
  const patch = '# patch\n';
  writeFileSync(join(bundleDir(), 'package.json'), manifestJson, 'utf8');
  writeFileSync(join(bundleDir(), 'cordis.patch.yml'), patch, 'utf8');
  writeFileSync(manifestPath(), JSON.stringify({
    slug, pkg: market.BUNDLE_PREFIX + slug, txid: 'tx-1', rowId: market.rowIdForSlug(slug),
    renderDigest: tx.digestOf({ 'package.json': manifestJson, 'cordis.patch.yml': patch }),
    ...fields,
  }, null, 2), 'utf8');
  return tx.readLiveBundle(bundleDir());
}

test('[contract] an older manifest without version 2 evidence still reads as version 1 only', () => {
  const live = writeManifest({ configDigest: tx.configDigestOf({}) });
  assert.equal(live.configEvidence, 'v1-only');
  assert.equal(live.configDigestV2, '', 'there is no version 2 summary to report');
  assert.equal(live.configDigestVersion, 0);
});

test('[contract] absent, damaged and unknown version 2 evidence are not read as a match', () => {
  assert.equal(writeManifest({}).configEvidence, 'absent', 'no digest at all');
  assert.equal(writeManifest({ configDigestV2: 'not-a-digest', configDigestVersion: 2, configNamespace: 'env' }).configEvidence, 'damaged');
  assert.equal(writeManifest({ configDigestV2: 'a'.repeat(64), configDigestVersion: 99, configNamespace: 'env' }).configEvidence, 'unsupported-version');
  assert.equal(writeManifest({ configDigestV2: 'a'.repeat(64), configDigestVersion: 2, configNamespace: 'somewhere' }).configEvidence, 'damaged');
  const good = writeManifest({ configDigestV2: 'a'.repeat(64), configDigestVersion: 2, configNamespace: 'env' });
  assert.equal(good.configEvidence, 'v2');
  assert.equal(good.configDigestVersion, 2);
});

test('[contract] the version 1 reader keeps returning the version 1 digest', () => {
  const values = { API_KEY: 'x' };
  const live = writeManifest({ configDigest: tx.configDigestOf(values) });
  assert.equal(live.configDigest, tx.configDigestOf(values), 'repair still compares against this field');
  assert.equal(live.configEvidence, 'v1-only', 'and it is not mistaken for version 2 evidence');
});

// --- and a bundle that moves keeps its evidence --------------------------------------------------

test('[contract] a version 2 summary survives being moved into a backup', async () => {
  await install();
  const before = manifest();
  const backup = join(market.MARKET_ROOT, '.tx', slug, 'backup', 'tx-mine');
  mkdirSync(dirname(backup), { recursive: true });
  renameSync(bundleDir(), backup);
  const after = JSON.parse(readFileSync(join(backup, 'market.meta.json'), 'utf8'));

  assert.equal(after.configDigestV2, before.configDigestV2, 'the move rewrote nothing');
  assert.equal(after.configNamespace, before.configNamespace);
  assert.equal(tx.readLiveBundle(backup).configEvidence, 'v2');
  assert.equal(tx.verifyBundleContent(backup).matches, true);
});
