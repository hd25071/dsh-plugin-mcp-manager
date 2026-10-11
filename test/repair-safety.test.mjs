// The recovery paths, held to their safety properties.
//
// Two questions run through every case here: is the *whole* previous version either moved or left
// alone — never half-removed — and does an action that cannot prove the running configuration
// matches what it is about to publish refuse instead of guessing.
//
// [defect]   cases fail on the previous revision for a substantive reason: a recursive delete was
//            the only step between "the published bundle" and "no published bundle", so anything
//            that made it partly fail left a directory that was neither.
// [contract] cases are new capability — a quarantine directory, a value-level configuration digest,
//            and the \`verification-incomplete\` refusal — and are labelled as such.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'mcpm-safety-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const market = await import('../market.js');
const tx = await import('../tx.js');
const host = await import('../index.js');

const PROFILES = join(home, '.dsh', 'profiles');
const ENTRY = 'vendor.example/notes';
const slug = market.slugFor(ENTRY);
const pkg = market.BUNDLE_PREFIX + slug;
const rowId = market.rowIdForSlug(slug);

const bundleDir = () => market.bundleDir(slug);
const txRoot = () => join(market.MARKET_ROOT, '.tx', slug);
const journalPath = () => join(txRoot(), 'journal.json');
const stagingDir = (id) => join(txRoot(), 'staging', id);
const backupDir = (id) => join(txRoot(), 'backup', id);
const quarantineDir = (id) => join(txRoot(), 'quarantine', id);

beforeEach(() => {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  delete process.env.MCP_MARKET_FAULT;
  market.resetCatalog();
});

const post = (payload) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
const call = async (routes, path, payload) => {
  const response = await routes.get(path).fetch(new Request('http://local' + path, post(payload)));
  return { status: response.status, body: await response.json() };
};
const repair = (routes, payload) => call(routes, host.MARKET_REPAIR_PATH, payload);
const install = (routes, payload) => call(routes, host.MARKET_INSTALL_PATH, { name: ENTRY, optionIndex: 0, config: {}, ...payload });
const readJournal = () => (existsSync(journalPath()) ? JSON.parse(readFileSync(journalPath(), 'utf8')) : null);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const json = (value) => JSON.stringify(value, null, 2);

function fingerprint(root) {
  const out = {};
  const walk = (current) => {
    let names;
    try { names = readdirSync(current); } catch { return; }
    for (const name of names) {
      const full = join(current, name);
      const key = relative(root, full).split('\\').join('/');
      let info;
      try { info = lstatSync(full); } catch { out[key] = 'vanished'; continue; }
      if (info.isSymbolicLink()) out[key] = 'link:' + String(readlinkSync(full));
      else if (info.isDirectory()) { out[key] = 'dir'; walk(full); }
      else if (info.isFile()) out[key] = 'file:' + readFileSync(full, 'utf8');
      else out[key] = 'other';
    }
  };
  walk(root);
  return out;
}

const LOCK_PATH = '.dsh/mcp-servers/.locks';
function changedKeys(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out = [];
  for (const key of [...keys].sort()) {
    if (key === LOCK_PATH || key.startsWith(LOCK_PATH + '/')) continue;
    if (before[key] !== after[key]) out.push(key);
  }
  return out;
}

function seedCache() {
  mkdirSync(dirname(market.CACHE_PATH), { recursive: true });
  writeFileSync(market.CACHE_PATH, json({
    cacheVersion: market.CACHE_VERSION, fetchedAt: new Date().toISOString(), count: 1,
    servers: [{
      name: ENTRY, title: 'Vendor Notes', description: 'one entry', version: '1.0.0',
      publishedAt: '2026-01-01T00:00:00Z', remotes: [],
      packages: [{ registryType: 'npm', identifier: '@example/notes', version: '1.0.0', transport: 'stdio', environmentVariables: [], packageArguments: [] }],
    }],
  }));
  market.resetCatalog();
}

function seedProfile(name, { declares = false } = {}) {
  const dir = join(PROFILES, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), json({ name: 'dsh-profile-' + name, dependencies: {}, dsh: { profile: { bundles: declares ? [pkg] : [] } } }), 'utf8');
  return dir;
}

/**
 * The scheme the manifest's \`configDigest\` is defined as: sha256 over sorted \`key\0value\0\` pairs.
 *
 * Written out here rather than imported, so this file does not depend on the function under test —
 * a fixture that calls the code it is checking proves nothing about it.
 */
function configDigestOf(values) {
  const hash = createHash('sha256');
  for (const key of Object.keys(values).sort()) {
    hash.update(key);
    hash.update('\u0000');
    hash.update(String(values[key]));
    hash.update('\u0000');
  }
  return hash.digest('hex');
}

const patchFor = (tag) => '# ' + tag + '\n- insert:\n    - id: ' + rowId + '\n      name: \'@deepseek-ai/dsh-mcp-client\'\n      config:\n        serverName: notes\n';
const API_KEY = 'sk-alpha';
const OTHER_API_KEY = 'sk-beta';

/**
 * A complete published bundle: the rendered files, an optional mcpb payload, the whole-content
 * digest, and a digest of the configured values that does not store them.
 */
function writeBundle(dir, options = {}) {
  const { txid = 'tx-test', tag = 'v1', apiKey = API_KEY, payload = null, legacy = false } = options;
  mkdirSync(dir, { recursive: true });
  const manifest = json({ name: pkg, version: '1.0.0' });
  const patch = patchFor(tag);
  const files = { 'package.json': manifest, 'cordis.patch.yml': patch };
  if (payload !== null) {
    mkdirSync(join(dir, 'mcpb', 'extracted'), { recursive: true });
    writeFileSync(join(dir, 'mcpb', 'package.mcpb'), payload, 'utf8');
  }
  const meta = {
    registryName: ENTRY, registryVersion: '1.0.0', installedAt: '2026-01-01T00:00:00Z', source: 'registry',
    slug, pkg, rowId, serverName: 'notes', kind: 'stdio', transport: 'stdio', command: 'node',
    args: [join(dir, 'server.js')], argumentValues: {}, configKeys: ['API_KEY'],
    txid, renderDigest: tx.digestOf(files),
  };
  if (!legacy) {
    meta.contentDigest = tx.digestOf({ ...files, ...(payload === null ? {} : { 'mcpb/package.mcpb': payload }) });
    meta.configDigest = configDigestOf({ API_KEY: apiKey });
  }
  writeFileSync(join(dir, 'package.json'), manifest, 'utf8');
  writeFileSync(join(dir, 'cordis.patch.yml'), patch, 'utf8');
  writeFileSync(join(dir, 'market.meta.json'), json(meta), 'utf8');
  return meta;
}

const journalRecord = (id, phase, extra = {}) => ({
  schema: 1, txid: id, slug, operation: 'install', phase, intent: 'test',
  expected: { rowId, serverName: 'notes' },
  staging: '.tx/' + slug + '/staging/' + id,
  backup: '.tx/' + slug + '/backup/' + id,
  ...extra,
});

function writeJournal(record) {
  mkdirSync(txRoot(), { recursive: true });
  writeFileSync(journalPath(), typeof record === 'string' ? record : json(record), 'utf8');
}

function makeCtx(options = {}) {
  mkdirSync(join(PROFILES, 'desktop'), { recursive: true });
  const routes = new Map();
  const calls = { install: [], remove: [] };
  const state = { installed: options.installed === true, unreadable: options.unreadable === true };
  const override = options.rowOverride === undefined
    ? { transport: 'stdio', serverName: 'notes', command: 'node', args: [join(bundleDir(), 'server.js')], env: { API_KEY: options.apiKey === undefined ? API_KEY : options.apiKey } }
    : options.rowOverride;
  const ctx = {
    get(key) {
      if (key === 'connection') return { fetch: { register(spec) { routes.set(spec.path, spec); } } };
      if (key === 'profileContext') return { name: 'desktop', dir: join(PROFILES, 'desktop') };
      if (key === 'pluginManager') {
        if (state.unreadable) return { async installBundle() { calls.install.push('x'); }, async removeBundle() { calls.remove.push('x'); } };
        return {
          async installBundle(dir) {
            calls.install.push(dir);
            if (options.editPublished !== undefined && options.editPublished !== null) writeFileSync(join(dir, 'cordis.patch.yml'), options.editPublished, 'utf8');
            if (options.editPayload !== undefined && options.editPayload !== null) {
              mkdirSync(join(dir, 'mcpb'), { recursive: true });
              writeFileSync(join(dir, 'mcpb', 'package.mcpb'), options.editPayload, 'utf8');
            }
            if (options.installResult !== undefined) return options.installResult;
            return { application: 'applied' };
          },
          async removeBundle(name) { calls.remove.push(name); return { application: 'applied' }; },
          listBundles() {
            return state.installed
              ? [{ name: pkg, installed: true, enabled: true, removable: true, rows: [options.rowAbsent === true ? { rowId: 'other', moduleName: host.MCP_MODULE } : { rowId, moduleName: host.MCP_MODULE }] }]
              : [];
          },
        };
      }
      if (key === 'configEditor') {
        if (state.unreadable) return undefined;
        const rows = options.rowContent === false ? [] : [{ entry: { options: { id: rowId, name: host.MCP_MODULE } }, inherited: {}, override }];
        return { configuration() { return rows; } };
      }
      return undefined;
    },
  };
  host.apply(ctx);
  return { routes, calls, state };
}

/** An update that was published but never verified: journal PUBLISHED, backup and published present. */
function seedPublishedUpdate(options = {}) {
  seedCache();
  seedProfile('desktop', { declares: true });
  const published = writeBundle(bundleDir(), { txid: 'tx-mine', tag: 'v2', ...options.published });
  writeBundle(backupDir('tx-mine'), { txid: 'tx-prev', tag: 'v1', ...options.backup });
  writeJournal(journalRecord('tx-mine', 'PUBLISHED'));
  return published;
}

const FILES = ['cordis.patch.yml', 'market.meta.json', 'package.json'];


// --- [defect] a recovery may never leave a half-removed published bundle ------------------------

test('[defect] a failed restore must not already have destroyed the published version', async () => {
  seedPublishedUpdate();
  const { routes } = makeCtx({ installed: true });
  // The recovery is interrupted exactly where the previous revision did its damage: after the
  // published directory was dealt with and before the backup was moved into place.
  process.env.MCP_MARKET_FAULT = 'repair-restore';

  const failed = await repair(routes, { slug, action: 'rollback', txid: 'tx-mine' });
  delete process.env.MCP_MARKET_FAULT;

  const quarantined = join(quarantineDir('tx-mine'), 'cordis.patch.yml');
  const inQuarantine = existsSync(quarantined) && readFileSync(quarantined, 'utf8') === patchFor('v2');
  const stillPublished = existsSync(join(bundleDir(), 'cordis.patch.yml'))
    && readFileSync(join(bundleDir(), 'cordis.patch.yml'), 'utf8') === patchFor('v2');
  assert.equal(inQuarantine || stillPublished, true,
    'the version that was published is still somewhere: a recovery that removes it first has nothing left to recover');
  assert.notEqual(failed.status, 200);
});

// --- [contract] the quarantine, and what a crash in the middle of it looks like -----------------

test('[contract] a quarantine rename that fails keeps the published bundle and the backup', async () => {
  seedPublishedUpdate();
  const { routes } = makeCtx({ installed: true });
  process.env.MCP_MARKET_FAULT = 'repair-quarantine';

  const failed = await repair(routes, { slug, action: 'rollback', txid: 'tx-mine' });
  delete process.env.MCP_MARKET_FAULT;

  assert.equal(failed.body.error.code, 'needs-attention');
  assert.deepEqual(publishedListing(), FILES, 'the published bundle is still whole');
  assert.equal(readFileSync(join(bundleDir(), 'cordis.patch.yml'), 'utf8'), patchFor('v2'));
  assert.equal(readFileSync(join(backupDir('tx-mine'), 'cordis.patch.yml'), 'utf8'), patchFor('v1'), 'and so is the previous version');
  assert.equal(readJournal().phase, 'NEEDS_ATTENTION');
  assert.equal(existsSync(quarantineDir('tx-mine')), false, 'nothing was moved aside');
});

test('[contract] a restore that fails after the quarantine leaves a state a person can finish', async () => {
  seedPublishedUpdate();
  const { routes } = makeCtx({ installed: true });
  process.env.MCP_MARKET_FAULT = 'repair-restore';

  const failed = await repair(routes, { slug, action: 'rollback', txid: 'tx-mine' });
  delete process.env.MCP_MARKET_FAULT;

  assert.equal(failed.body.error.code, 'needs-attention');
  assert.equal(existsSync(bundleDir()), false, 'the published version was moved aside, not deleted');
  assert.deepEqual(readdirSync(quarantineDir('tx-mine')).sort(), FILES, 'and it is all there');
  assert.equal(readFileSync(join(backupDir('tx-mine'), 'cordis.patch.yml'), 'utf8'), patchFor('v1'), 'the previous version is untouched');

  // A second attempt finishes what the first could not, because everything it needs is still there.
  const done = await repair(routes, { slug, action: 'retry-recovery', txid: 'tx-mine' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(readFileSync(join(bundleDir(), 'cordis.patch.yml'), 'utf8'), patchFor('v1'));
  assert.equal(existsSync(quarantineDir('tx-mine')), false);
  assert.equal(existsSync(journalPath()), false);
});

test('[contract] a crash between the two renames is diagnosed, not mistaken for a clean slug', async () => {
  seedCache();
  seedProfile('desktop', { declares: true });
  writeBundle(bundleDir(), { txid: 'tx-mine', tag: 'v2' });
  writeBundle(backupDir('tx-mine'), { txid: 'tx-prev', tag: 'v1' });
  // Exactly what a crash between the renames leaves: the published version moved aside, the backup
  // still waiting, and a journal that says the quarantine step was the one under way.
  mkdirSync(dirname(quarantineDir('tx-mine')), { recursive: true });
  renameSync(bundleDir(), quarantineDir('tx-mine'));
  writeJournal(journalRecord('tx-mine', 'ROLLED_BACK', { intent: 'quarantine-published', repair: 'rollback' }));
  const { routes } = makeCtx({ installed: true });

  const planned = await repair(routes, { slug, action: 'dryRun-not-an-action', dryRun: true });
  assert.equal(planned.status, 400, 'an unknown action is still an unknown action');

  const listed = await call(routes, host.MARKET_INSTALLED_PATH, {});
  const entry = (listed.body.value.transactions || []).find((item) => item.slug === slug);
  assert.equal(entry.state, 'quarantine-pending', JSON.stringify(entry.findings));
  assert.equal(entry.risk, 'manual');

  const done = await repair(routes, { slug, action: 'retry-recovery', txid: 'tx-mine' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(readFileSync(join(bundleDir(), 'cordis.patch.yml'), 'utf8'), patchFor('v1'), 'the previous version ends up published');
  assert.equal(existsSync(quarantineDir('tx-mine')), false, 'and the quarantined copy is cleared');
});

test('[contract] a quarantine that cannot be cleaned does not damage the restored bundle', async () => {
  seedPublishedUpdate();
  const { routes } = makeCtx({ installed: true });
  process.env.MCP_MARKET_FAULT = 'repair-quarantine-clean';

  const done = await repair(routes, { slug, action: 'rollback', txid: 'tx-mine' });
  delete process.env.MCP_MARKET_FAULT;

  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.value.outcome, 'rolled-back', 'the rollback itself succeeded');
  assert.equal(done.body.value.quarantineLeft, true, 'and the answer says what was left behind');
  assert.equal(readFileSync(join(bundleDir(), 'cordis.patch.yml'), 'utf8'), patchFor('v1'), 'the restored bundle is intact');
  assert.deepEqual(publishedListing(), FILES);
  assert.deepEqual(readdirSync(quarantineDir('tx-mine')).sort(), FILES, 'the quarantined copy is still there to be removed by hand');
});

// --- [contract] accept has to prove the values, not just the shape -------------------------------

test('[contract] accept refuses when the configured value differs under the same key name', async () => {
  seedPublishedUpdate();
  const { routes } = makeCtx({ installed: true, apiKey: OTHER_API_KEY });
  const before = fingerprint(home);

  const refused = await repair(routes, { slug, action: 'accept', txid: 'tx-mine' });

  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'repair-refused');
  assert.equal(refused.body.error.reasons.some((reason) => /value|configuration|digest/i.test(reason)), true, JSON.stringify(refused.body.error.reasons));
  assert.deepEqual(changedKeys(before, fingerprint(home)), []);
});

test('[contract] accept says verification-incomplete when the values cannot be compared', async () => {
  seedPublishedUpdate({ published: { legacy: true } });
  const { routes } = makeCtx({ installed: true });

  const refused = await repair(routes, { slug, action: 'accept', txid: 'tx-mine' });

  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'verification-incomplete');
  assert.equal(refused.body.value.verified, false, 'an incomplete check may not report a verification');
  assert.equal(refused.body.value.live, false);
  assert.equal(existsSync(journalPath()), true, 'and the transaction is left for a person');
});

test('[contract] accept will not call a missing row a pending restart without persisted evidence', async () => {
  seedPublishedUpdate();
  // Nothing in the profile says this bundle is installed, so "the running row is missing" is not
  // evidence of a restart — it is evidence that the install never took effect.
  const { routes } = makeCtx({ installed: false, rowContent: false });

  const refused = await repair(routes, { slug, action: 'accept', txid: 'tx-mine' });

  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'repair-refused');
  assert.equal(refused.body.error.reasons.some((reason) => /persist|installed/i.test(reason)), true, JSON.stringify(refused.body.error.reasons));
});

test('[contract] accept treats a persisted bundle with a missing running row as a pending restart', async () => {
  seedPublishedUpdate();
  const { routes } = makeCtx({ installed: true, rowContent: false });

  const done = await repair(routes, { slug, action: 'accept', txid: 'tx-mine' });

  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.value.pendingRestart, true);
  assert.equal(done.body.value.live, false, 'persisted and running are not the same claim');
  assert.equal(done.body.value.verified, true);
  assert.equal(done.body.value.restartEvidence.some((item) => /installed/i.test(item)), true, JSON.stringify(done.body.value.restartEvidence));
});

// --- [contract] rollback has to look at the configuration, not only at "installed" --------------

test('[contract] a rollback is refused when the running configuration matches neither version', async () => {
  seedPublishedUpdate();
  const { routes } = makeCtx({ installed: true, apiKey: 'sk-changed-outside-this-transaction' });
  const before = fingerprint(home);

  const refused = await repair(routes, { slug, action: 'rollback', txid: 'tx-mine' });

  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'repair-refused');
  assert.equal(refused.body.error.reasons.some((reason) => /configuration|value/i.test(reason)), true, JSON.stringify(refused.body.error.reasons));
  assert.deepEqual(changedKeys(before, fingerprint(home)), [], 'and it did not touch anything');
});

test('[contract] a rollback whose profile cannot be compared fails closed', async () => {
  seedPublishedUpdate();
  const { routes } = makeCtx({ installed: true, rowContent: false });
  const before = fingerprint(home);

  const refused = await repair(routes, { slug, action: 'rollback', txid: 'tx-mine' });

  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'repair-refused');
  assert.deepEqual(changedKeys(before, fingerprint(home)), []);
});

// --- [contract] integrity covers the whole bundle, not only the rendered two files --------------

test('[contract] a modified mcpb payload is caught even though the patch is untouched', async () => {
  seedPublishedUpdate({ published: { payload: 'original-payload-bytes' } });
  writeFileSync(join(bundleDir(), 'mcpb', 'package.mcpb'), 'tampered-payload-bytes', 'utf8');
  const { routes } = makeCtx({ installed: true });
  const before = fingerprint(home);

  const refused = await repair(routes, { slug, action: 'rollback', txid: 'tx-mine' });

  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'repair-refused');
  assert.equal(refused.body.error.reasons.some((reason) => /content|digest/i.test(reason)), true, JSON.stringify(refused.body.error.reasons));
  assert.deepEqual(changedKeys(before, fingerprint(home)), [], 'the tampered bundle is not removed either');
});

test('[contract] the install compensation also refuses a bundle whose payload was changed', async () => {
  seedCache();
  seedProfile('desktop', { declares: true });
  const first = makeCtx({ installed: true });
  assert.equal((await install(first.routes)).status, 200);
  const second = makeCtx({ installed: true, editPayload: 'changed-during-the-install', installResult: { application: 'failed' } });

  const refused = await install(second.routes, { config: {} });

  assert.equal(refused.body.error.code, 'needs-attention');
  assert.equal(readFileSync(join(bundleDir(), 'mcpb', 'package.mcpb'), 'utf8'), 'changed-during-the-install', 'the changed payload is left alone');
});

// --- [contract] a plan and the run after it ------------------------------------------------------

test('[contract] a change on disk between the dry run and the run is refused', async () => {
  seedCache();
  seedProfile('desktop');
  writeBundle(bundleDir(), { txid: 'tx-prev', tag: 'v1' });
  writeJournal(journalRecord('tx-next', 'STAGED'));
  writeBundle(stagingDir('tx-next'), { txid: 'tx-next', tag: 'v2' });
  const { routes } = makeCtx({ installed: true });
  const planned = await repair(routes, { slug, action: 'discard-staging', txid: 'tx-next', dryRun: true });
  assert.equal(planned.body.value.allowed, true);

  // The staged content is edited, but the state and phase are exactly what the plan expected.
  writeFileSync(join(stagingDir('tx-next'), 'cordis.patch.yml'), patchFor('edited-after-the-plan'), 'utf8');
  const refused = await repair(routes, {
    slug, action: 'discard-staging', txid: 'tx-next',
    expect: { state: planned.body.value.state, phase: planned.body.value.phase },
  });

  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'repair-refused', 'the same state is not the same content');
  assert.equal(readFileSync(join(stagingDir('tx-next'), 'cordis.patch.yml'), 'utf8'), patchFor('edited-after-the-plan'));
});
