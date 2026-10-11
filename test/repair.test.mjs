// Repair changes a slug on purpose, so every case here has to show two things: that the action was
// allowed only with evidence, and that the files and the profile are exactly what the answer says
// they are afterwards. A status code proves neither.
//
// Two kinds of case live in this file and they are labelled where they appear:
//
//   [defect]  — a real, reproducible failure of the code before this round. It goes through the
//               install route, which already existed, and it fails on the old revision for a
//               substantive reason: content that does not match its recorded digest was deleted.
//   [contract]— a capability that did not exist at all (there was no repair route). These are new,
//               and they are written as contracts rather than dressed up as regressions.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'mcpm-repair-'));
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

beforeEach(() => {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  delete process.env.MCP_MARKET_FAULT;
  market.resetCatalog();
});

// --- instruments --------------------------------------------------------------------------------

/** Every path under a root: kind, bytes, and a link's target. Nothing here writes. */
function fingerprint(root) {
  const out = {};
  const walk = (current) => {
    let names;
    try {
      names = readdirSync(current);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(current, name);
      const key = relative(root, full).split('\\').join('/');
      let info;
      try {
        info = lstatSync(full);
      } catch {
        out[key] = 'vanished';
        continue;
      }
      if (info.isSymbolicLink()) out[key] = 'link:' + String(readlinkSync(full));
      else if (info.isDirectory()) { out[key] = 'dir'; walk(full); }
      else if (info.isFile()) out[key] = 'file:' + readFileSync(full, 'utf8');
      else out[key] = 'other';
    }
  };
  walk(root);
  return out;
}

/**
 * What the request changed, ignoring the lock directory.
 *
 * Taking the lock is a write, and it is the documented price of *asking* for a change — a request
 * that is refused still had to be serialized against installs of the same slug. Everything else has
 * to be exactly as it was. A dry run is held to the stricter rule and may not create it at all.
 */
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

const post = (payload) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
const call = async (routes, path, payload) => {
  const response = await routes.get(path).fetch(new Request('http://local' + path, post(payload)));
  return { status: response.status, body: await response.json() };
};
const repair = (routes, payload) => call(routes, host.MARKET_REPAIR_PATH, payload);
const install = (routes, payload) => call(routes, host.MARKET_INSTALL_PATH, { name: ENTRY, optionIndex: 0, config: {}, ...payload });
const readJournal = () => (existsSync(journalPath()) ? JSON.parse(readFileSync(journalPath(), 'utf8')) : null);

// --- fixtures -----------------------------------------------------------------------------------

function seedCache() {
  mkdirSync(dirname(market.CACHE_PATH), { recursive: true });
  writeFileSync(market.CACHE_PATH, JSON.stringify({
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
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-' + name, dependencies: {}, dsh: { profile: { bundles: declares ? [pkg] : [] } },
  }), 'utf8');
  return dir;
}

/** A distinct patch per tag, so a restore can be checked by content rather than by existence. */
const configDigestOf = (values) => {
  const hash = createHash('sha256');
  for (const key of Object.keys(values).sort()) {
    hash.update(key); hash.update('\u0000'); hash.update(String(values[key])); hash.update('\u0000');
  }
  return hash.digest('hex');
};

const patchFor = (tag) => '# ' + tag + '\n- insert:\n    - id: ' + rowId + '\n      name: \'@deepseek-ai/dsh-mcp-client\'\n      config:\n        serverName: notes\n';

/**
 * A complete bundle directory: the three files a transaction writes, a manifest that names the
 * transaction that wrote it, and a digest of exactly what it rendered.
 */
function writeBundle(dir, options = {}) {
  const { txid = 'tx-test', tag = 'v1' } = options;
  mkdirSync(dir, { recursive: true });
  const manifest = JSON.stringify({ name: pkg, version: '1.0.0' }, null, 2);
  const patch = patchFor(tag);
  const meta = {
    registryName: ENTRY, registryVersion: '1.0.0', installedAt: '2026-01-01T00:00:00Z', source: 'registry',
    slug, pkg, rowId, serverName: 'notes', kind: 'stdio', transport: 'stdio', command: 'node',
    args: [join(dir, 'server.js')], argumentValues: {}, configKeys: ['API_TOKEN'], configDigest: configDigestOf({ API_TOKEN: 'configured' }),
    contentDigest: tx.digestOf({ 'package.json': manifest, 'cordis.patch.yml': patch }),
    txid, renderDigest: tx.digestOf({ 'package.json': manifest, 'cordis.patch.yml': patch }),
  };
  writeFileSync(join(dir, 'package.json'), manifest, 'utf8');
  writeFileSync(join(dir, 'cordis.patch.yml'), patch, 'utf8');
  writeFileSync(join(dir, 'market.meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

/** The same three files in a staging or backup directory, without touching the published one. */
function writeDirectoryWithBundle(dir, options = {}) {
  return writeBundle(dir, options);
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
  writeFileSync(journalPath(), typeof record === 'string' ? record : JSON.stringify(record, null, 2), 'utf8');
}

/**
 * The host, with the two official services and the recorder that proves they were never called.
 *
 * \`installed\` is what the profile's own bundle list says; \`rowContent\` is what the running row
 * carries, which is a different question and the one accept has to answer.
 */
function makeCtx(options = {}) {
  mkdirSync(join(PROFILES, 'desktop'), { recursive: true });
  const routes = new Map();
  const calls = { install: [], remove: [] };
  const state = { installed: options.installed === true, unreadable: options.unreadable === true };
  const ctx = {
    get(key) {
      if (key === 'connection') return { fetch: { register(spec) { routes.set(spec.path, spec); } } };
      if (key === 'profileContext') return { name: 'desktop', dir: join(PROFILES, 'desktop') };
      if (key === 'pluginManager') {
        if (state.unreadable) return { async installBundle() { calls.install.push('x'); }, async removeBundle() { calls.remove.push('x'); } };
        return {
          async installBundle(dir) {
            calls.install.push(dir);
            if (options.editPublished !== undefined && options.editPublished !== null) {
              writeFileSync(join(dir, 'cordis.patch.yml'), options.editPublished, 'utf8');
            }
            if (options.installResult !== undefined) return options.installResult;
            return { application: 'applied' };
          },
          async removeBundle(name) { calls.remove.push(name); return { application: 'applied' }; },
          listBundles() {
            return state.installed
              ? [{ name: pkg, installed: true, enabled: true, removable: true, rows: [{ rowId, moduleName: host.MCP_MODULE }] }]
              : [];
          },
        };
      }
      if (key === 'configEditor') {
        if (state.unreadable) return undefined;
        const rows = options.rowContent === false ? [] : [{
          entry: { options: { id: rowId, name: host.MCP_MODULE } },
          inherited: {},
          override: options.rowOverride === undefined
            ? { transport: 'stdio', serverName: 'notes', command: 'node', args: [join(bundleDir(), 'server.js')], env: { API_TOKEN: 'configured' } }
            : options.rowOverride,
        }];
        return { configuration() { return rows; } };
      }
      return undefined;
    },
  };
  host.apply(ctx);
  return { routes, calls, state };
}

// --- [defect] compensation that deletes what it did not render ----------------------------------

test('[defect] a published directory edited after it was rendered is not deleted as ours', async () => {
  seedCache();
  seedProfile('desktop', { declares: true });
  const first = makeCtx({ installed: true });
  const seeded = await install(first.routes);
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
  const seededPatch = readFileSync(join(bundleDir(), 'cordis.patch.yml'), 'utf8');
  assert.equal(seededPatch.length > 0, true, 'the seed install wrote a patch');

  // The installer rewrites the published content and then fails, with the profile untouched.
  const edited = patchFor('edited-by-someone-else');
  const second = makeCtx({ installed: true, editPublished: edited, installResult: { application: 'failed' } });
  const refused = await install(second.routes, { config: {} });

  assert.notEqual(refused.body.ok, true);
  assert.equal(existsSync(bundleDir()), true, 'a directory whose content does not match its digest is not this transaction to remove');
  assert.equal(readFileSync(join(bundleDir(), 'cordis.patch.yml'), 'utf8'), edited, 'and it is left exactly as it was found');
  assert.equal(refused.body.error.code, 'needs-attention', 'the transaction cannot undo what it cannot identify');
  assert.equal(readJournal().phase, 'NEEDS_ATTENTION');
});

// --- [contract] dry run -------------------------------------------------------------------------

test('[contract] a dry run decides without touching anything', async () => {
  seedCache();
  seedProfile('desktop');
  writeBundle(bundleDir(), { txid: 'tx-prev', tag: 'v1' });
  writeJournal(journalRecord('tx-next', 'STAGED'));
  writeBundle(stagingDir('tx-next'), { txid: 'tx-next', tag: 'v2' });
  const { routes, calls } = makeCtx({ installed: true });

  const before = fingerprint(home);
  const planned = await repair(routes, { slug, action: 'discard-staging', txid: 'tx-next', dryRun: true });
  const after = fingerprint(home);

  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  assert.equal(planned.body.value.dryRun, true);
  assert.equal(planned.body.value.allowed, true);
  assert.equal(planned.body.value.outcome, 'planned');
  assert.equal(planned.body.value.changes.some((change) => change.path.includes('staging/tx-next')), true, JSON.stringify(planned.body.value.changes));
  assert.deepEqual(changedKeys(before, after), [], 'a dry run is a read, including the lock');
  assert.equal(existsSync(market.lockPathFor(slug)), false, 'and it does not take the lock to look');
  assert.deepEqual(calls.install, []);
  assert.deepEqual(calls.remove, []);
});

test('[contract] a dry run over a state it would refuse still answers with the reason', async () => {
  seedCache();
  seedProfile('desktop');
  writeBundle(bundleDir(), { txid: 'tx-ours', tag: 'v1' });
  writeJournal(journalRecord('tx-ours', 'BACKED_UP'));
  const { routes } = makeCtx({ installed: true });

  const planned = await repair(routes, { slug, action: 'discard-staging', txid: 'tx-ours', dryRun: true });

  assert.equal(planned.status, 200);
  assert.equal(planned.body.value.allowed, false);
  assert.equal(planned.body.value.reasons.length > 0, true, 'the refusal is explained, not just returned');
  assert.equal(planned.body.value.outcome, 'refused');
});

test('[contract] a dry run and the run after it must agree, or the run is refused', async () => {
  seedCache();
  seedProfile('desktop');
  writeBundle(bundleDir(), { txid: 'tx-prev', tag: 'v1' });
  writeJournal(journalRecord('tx-next', 'STAGED'));
  writeBundle(stagingDir('tx-next'), { txid: 'tx-next', tag: 'v2' });
  const { routes } = makeCtx({ installed: true });
  const planned = await repair(routes, { slug, action: 'discard-staging', txid: 'tx-next', dryRun: true });
  assert.equal(planned.body.value.allowed, true);

  // The world moves between the plan and the commit: the journal now says the backup happened.
  writeJournal(journalRecord('tx-next', 'BACKED_UP'));
  const refused = await repair(routes, {
    slug, action: 'discard-staging', txid: 'tx-next',
    expect: { state: planned.body.value.state, phase: planned.body.value.phase },
  });

  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'stale-transaction');
  assert.equal(existsSync(stagingDir('tx-next')), true, 'a stale plan changes nothing');
});

// --- [contract] discard-staging -----------------------------------------------------------------

test('[contract] staging that is provably this transaction\'s and unpublished can be discarded', async () => {
  seedCache();
  seedProfile('desktop');
  const live = writeBundle(bundleDir(), { txid: 'tx-prev', tag: 'v1' });
  writeJournal(journalRecord('tx-next', 'STAGED'));
  writeBundle(stagingDir('tx-next'), { txid: 'tx-next', tag: 'v2' });
  const { routes, calls } = makeCtx({ installed: true });

  const done = await repair(routes, { slug, action: 'discard-staging', txid: 'tx-next' });

  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.value.outcome, 'discarded');
  assert.equal(existsSync(stagingDir('tx-next')), false, 'the staged version is gone');
  assert.equal(existsSync(journalPath()), false, 'and so is the journal that described it');
  assert.equal(readFileSync(join(bundleDir(), 'cordis.patch.yml'), 'utf8'), patchFor('v1'), 'the published bundle is untouched');
  assert.equal(JSON.parse(readFileSync(join(bundleDir(), 'market.meta.json'), 'utf8')).txid, live.txid);
  assert.deepEqual(calls.install, []);
  assert.deepEqual(calls.remove, []);
});

test('[contract] staging that was edited after it was rendered is not discarded', async () => {
  seedCache();
  seedProfile('desktop');
  writeBundle(bundleDir(), { txid: 'tx-prev', tag: 'v1' });
  writeJournal(journalRecord('tx-next', 'STAGED'));
  writeBundle(stagingDir('tx-next'), { txid: 'tx-next', tag: 'v2' });
  writeFileSync(join(stagingDir('tx-next'), 'cordis.patch.yml'), patchFor('tampered'), 'utf8');
  const { routes } = makeCtx({ installed: true });
  const before = fingerprint(home);

  const refused = await repair(routes, { slug, action: 'discard-staging', txid: 'tx-next' });

  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'repair-refused');
  assert.equal(refused.body.error.reasons.some((reason) => /digest|rendered/i.test(reason)), true, JSON.stringify(refused.body.error.reasons));
  assert.deepEqual(changedKeys(before, fingerprint(home)), [], 'the refusal changed nothing');
});

test('[contract] discarding twice is idempotent and the second call says so', async () => {
  seedCache();
  seedProfile('desktop');
  writeBundle(bundleDir(), { txid: 'tx-prev', tag: 'v1' });
  writeJournal(journalRecord('tx-next', 'STAGED'));
  writeBundle(stagingDir('tx-next'), { txid: 'tx-next', tag: 'v2' });
  const { routes } = makeCtx({ installed: true });
  assert.equal((await repair(routes, { slug, action: 'discard-staging', txid: 'tx-next' })).status, 200);
  const before = fingerprint(home);

  const again = await repair(routes, { slug, action: 'discard-staging', txid: 'tx-next' });

  assert.equal(again.status, 200);
  assert.equal(again.body.value.outcome, 'already-completed');
  assert.deepEqual(changedKeys(before, fingerprint(home)), [], 'the second call is a no-op');
});

// --- [contract] rollback ------------------------------------------------------------------------

test('[contract] an update with a verifiable backup and a missing published directory is restored', async () => {
  seedCache();
  seedProfile('desktop', { declares: true });
  writeDirectoryWithBundle(backupDir('tx-mid'), { txid: 'tx-prev', tag: 'v1' });
  writeJournal(journalRecord('tx-mid', 'BACKED_UP'));
  const { routes, calls } = makeCtx({ installed: true });
  assert.equal(existsSync(bundleDir()), false, 'the published directory is the thing that is missing');

  const done = await repair(routes, { slug, action: 'rollback', txid: 'tx-mid' });

  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.value.outcome, 'rolled-back');
  assert.equal(readFileSync(join(bundleDir(), 'cordis.patch.yml'), 'utf8'), patchFor('v1'), 'the previous version is where it belongs');
  assert.equal(existsSync(backupDir('tx-mid')), false, 'the backup became the published bundle');
  assert.equal(existsSync(journalPath()), false);
  assert.deepEqual(calls.remove, [], 'a rollback is not an uninstall');
  assert.deepEqual(calls.install, []);
});

test('[contract] a backup that does not match its own digest is not restored', async () => {
  seedCache();
  seedProfile('desktop', { declares: true });
  writeDirectoryWithBundle(backupDir('tx-mid'), { txid: 'tx-prev', tag: 'v1' });
  writeFileSync(join(backupDir('tx-mid'), 'cordis.patch.yml'), patchFor('tampered'), 'utf8');
  writeJournal(journalRecord('tx-mid', 'BACKED_UP'));
  const { routes } = makeCtx({ installed: true });
  const before = fingerprint(home);

  const refused = await repair(routes, { slug, action: 'rollback', txid: 'tx-mid' });

  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'repair-refused');
  assert.deepEqual(changedKeys(before, fingerprint(home)), [], 'a backup that cannot be verified is left alone');
});

test('[contract] a published directory claiming another transaction is never replaced', async () => {
  seedCache();
  seedProfile('desktop', { declares: true });
  writeBundle(bundleDir(), { txid: 'tx-someone-else', tag: 'v9' });
  writeDirectoryWithBundle(backupDir('tx-mine'), { txid: 'tx-prev', tag: 'v1' });
  writeJournal(journalRecord('tx-mine', 'BACKED_UP'));
  const { routes } = makeCtx({ installed: true });
  const before = fingerprint(home);

  const refused = await repair(routes, { slug, action: 'rollback', txid: 'tx-mine' });

  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'repair-refused');
  assert.deepEqual(changedKeys(before, fingerprint(home)), []);
  assert.equal(readFileSync(join(bundleDir(), 'cordis.patch.yml'), 'utf8'), patchFor('v9'), 'the other transaction\'s version survives');
});

test('[contract] a rollback the profile would contradict is refused, not attempted', async () => {
  seedCache();
  seedProfile('desktop');
  writeDirectoryWithBundle(backupDir('tx-mid'), { txid: 'tx-prev', tag: 'v1' });
  writeJournal(journalRecord('tx-mid', 'BACKED_UP'));
  const { routes } = makeCtx({ installed: false });
  const before = fingerprint(home);

  const refused = await repair(routes, { slug, action: 'rollback', txid: 'tx-mid' });

  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'repair-refused');
  assert.equal(refused.body.error.reasons.some((reason) => /profile|installed/i.test(reason)), true, JSON.stringify(refused.body.error.reasons));
  assert.deepEqual(changedKeys(before, fingerprint(home)), [], 'the backup is kept for a person to look at');
});

test('[contract] an unreadable profile fails closed instead of guessing', async () => {
  seedCache();
  seedProfile('desktop');
  writeDirectoryWithBundle(backupDir('tx-mid'), { txid: 'tx-prev', tag: 'v1' });
  writeJournal(journalRecord('tx-mid', 'BACKED_UP'));
  const { routes } = makeCtx({ unreadable: true });
  const before = fingerprint(home);

  const refused = await repair(routes, { slug, action: 'rollback', txid: 'tx-mid' });

  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'repair-refused');
  assert.deepEqual(changedKeys(before, fingerprint(home)), []);
});

test('[contract] a rollback that fails halfway keeps the backup and the journal', async () => {
  seedCache();
  seedProfile('desktop', { declares: true });
  writeDirectoryWithBundle(backupDir('tx-mid'), { txid: 'tx-prev', tag: 'v1' });
  writeJournal(journalRecord('tx-mid', 'BACKED_UP'));
  const { routes } = makeCtx({ installed: true });
  process.env.MCP_MARKET_FAULT = 'repair-restore';

  const failed = await repair(routes, { slug, action: 'rollback', txid: 'tx-mid' });
  delete process.env.MCP_MARKET_FAULT;

  assert.notEqual(failed.body.ok, true);
  assert.equal(failed.body.error.code, 'needs-attention');
  assert.equal(existsSync(backupDir('tx-mid')), true, 'the only copy of the previous version is still there');
  assert.equal(readFileSync(join(backupDir('tx-mid'), 'cordis.patch.yml'), 'utf8'), patchFor('v1'));
  assert.equal(readJournal().phase, 'NEEDS_ATTENTION', 'and the journal says the recovery itself was interrupted');
  assert.equal(readJournal().intent, 'restore-failed');
});

test('[contract] retrying a stuck recovery re-checks everything before trying again', async () => {
  seedCache();
  seedProfile('desktop', { declares: true });
  writeDirectoryWithBundle(backupDir('tx-mid'), { txid: 'tx-prev', tag: 'v1' });
  writeJournal(journalRecord('tx-mid', 'NEEDS_ATTENTION', { intent: 'restore-failed' }));
  const { routes } = makeCtx({ installed: true });

  const done = await repair(routes, { slug, action: 'retry-recovery', txid: 'tx-mid' });

  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.value.outcome, 'rolled-back');
  assert.equal(existsSync(bundleDir()), true);
  assert.equal(existsSync(journalPath()), false);
});

// --- [contract] accept --------------------------------------------------------------------------

test('[contract] accept finishes a transaction whose profile state checks out', async () => {
  seedCache();
  seedProfile('desktop', { declares: true });
  writeBundle(bundleDir(), { txid: 'tx-ours', tag: 'v2' });
  writeJournal(journalRecord('tx-ours', 'PUBLISHED'));
  const { routes } = makeCtx({ installed: true });

  const done = await repair(routes, { slug, action: 'accept', txid: 'tx-ours' });

  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.value.outcome, 'accepted');
  assert.equal(done.body.value.verified, true);
  assert.equal(done.body.value.pendingRestart, false);
  assert.equal(existsSync(journalPath()), false);
  assert.equal(existsSync(bundleDir()), true, 'accept keeps the published version; it is not a rollback');
});

test('[contract] accept refuses when the running configuration is not the published one', async () => {
  seedCache();
  seedProfile('desktop', { declares: true });
  writeBundle(bundleDir(), { txid: 'tx-ours', tag: 'v2' });
  writeJournal(journalRecord('tx-ours', 'PUBLISHED'));
  const { routes } = makeCtx({
    installed: true,
    rowOverride: { transport: 'stdio', serverName: 'something-else', command: 'node', args: [], env: {} },
  });
  const before = fingerprint(home);

  const refused = await repair(routes, { slug, action: 'accept', txid: 'tx-ours' });

  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'repair-refused');
  assert.equal(refused.body.error.reasons.some((reason) => /serverName|configuration|row/i.test(reason)), true, JSON.stringify(refused.body.error.reasons));
  assert.deepEqual(changedKeys(before, fingerprint(home)), []);
});

test('[contract] accept keeps the pending-restart meaning instead of calling it live', async () => {
  seedCache();
  seedProfile('desktop', { declares: true });
  writeBundle(bundleDir(), { txid: 'tx-ours', tag: 'v2' });
  writeJournal(journalRecord('tx-ours', 'PUBLISHED'));
  const { routes } = makeCtx({ installed: true, rowContent: false });

  const done = await repair(routes, { slug, action: 'accept', txid: 'tx-ours' });

  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.value.outcome, 'accepted');
  assert.equal(done.body.value.pendingRestart, true, 'persisted, not running: the answer has to say which');
  assert.equal(done.body.value.verified, true, 'the persisted state was verified');
  assert.equal(done.body.value.live, false);
});

test('[contract] accept refuses a state that cannot be verified at all', async () => {
  seedCache();
  seedProfile('desktop');
  writeBundle(bundleDir(), { txid: 'tx-ours', tag: 'v2' });
  writeJournal(journalRecord('tx-ours', 'APPLYING'));
  const { routes } = makeCtx({ installed: true });
  const before = fingerprint(home);

  const refused = await repair(routes, { slug, action: 'accept', txid: 'tx-ours' });

  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'repair-refused');
  assert.deepEqual(changedKeys(before, fingerprint(home)), []);
});

// --- [contract] the guards around every action --------------------------------------------------

test('[contract] a lock left behind blocks repair the same way it blocks an install', async () => {
  seedCache();
  seedProfile('desktop');
  writeBundle(bundleDir(), { txid: 'tx-prev', tag: 'v1' });
  writeJournal(journalRecord('tx-next', 'STAGED'));
  writeBundle(stagingDir('tx-next'), { txid: 'tx-next', tag: 'v2' });
  const path = market.lockPathFor(slug);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ schema: 1, slug, op: 'install', txid: 'tx-dead', pid: 999999, profile: '', at: '2026-01-01T00:00:00Z' }), 'utf8');
  const { routes } = makeCtx({ installed: true });
  const before = fingerprint(home);

  const refused = await repair(routes, { slug, action: 'discard-staging', txid: 'tx-next' });

  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'lock-blocked');
  assert.equal(refused.body.error.lock.alive, false, 'a dead holder is still a holder');
  assert.deepEqual(changedKeys(before, fingerprint(home)), []);
});

test('[contract] a corrupt journal refuses every action without deleting anything', async () => {
  seedCache();
  seedProfile('desktop');
  writeBundle(bundleDir(), { txid: 'tx-ours', tag: 'v1' });
  writeDirectoryWithBundle(stagingDir('tx-next'), { txid: 'tx-next', tag: 'v2' });
  writeJournal('{ not json at all');
  const { routes } = makeCtx({ installed: true });
  const before = fingerprint(home);

  for (const action of ['discard-staging', 'rollback', 'accept', 'retry-recovery']) {
    const refused = await repair(routes, { slug, action, txid: 'tx-next' });
    assert.equal(refused.status, 409, action + ' must be refused on a journal it cannot read');
    assert.equal(refused.body.error.code, 'repair-refused');
  }
  assert.deepEqual(changedKeys(before, fingerprint(home)), [], 'nothing was removed because nothing could be attributed');
});

test('[contract] a staging directory replaced by a link is refused, and the link is not followed', async () => {
  seedCache();
  seedProfile('desktop');
  const outside = join(home, 'outside-please-keep');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'important.txt'), 'do not delete me', 'utf8');
  writeBundle(bundleDir(), { txid: 'tx-prev', tag: 'v1' });
  writeJournal(journalRecord('tx-next', 'STAGED'));
  mkdirSync(dirname(stagingDir('tx-next')), { recursive: true });
  symlinkSync(outside, stagingDir('tx-next'), 'junction');
  const { routes } = makeCtx({ installed: true });

  const refused = await repair(routes, { slug, action: 'discard-staging', txid: 'tx-next' });

  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'repair-refused');
  assert.equal(existsSync(join(outside, 'important.txt')), true, 'what the link pointed at is untouched');
  assert.equal(lstatSync(stagingDir('tx-next')).isSymbolicLink(), true, 'and the link is still a link');
});

test('[contract] a slug that is not a slug, and a journal naming a path outside, are refused', async () => {
  seedCache();
  seedProfile('desktop');
  writeBundle(bundleDir(), { txid: 'tx-prev', tag: 'v1' });
  writeBundle(stagingDir('tx-next'), { txid: 'tx-next', tag: 'v2' });
  writeJournal(journalRecord('tx-next', 'STAGED', { staging: '../../outside-anywhere' }));
  const { routes } = makeCtx({ installed: true });
  const before = fingerprint(home);

  const traversal = await repair(routes, { slug: '../../elsewhere', action: 'discard-staging', txid: 'tx-next' });
  assert.equal(traversal.status, 400);
  assert.equal(traversal.body.error.code, 'bad-request');

  const untrusted = await repair(routes, { slug, action: 'discard-staging', txid: 'tx-next' });
  assert.equal(untrusted.status, 409);
  assert.equal(untrusted.body.error.code, 'repair-refused');
  assert.deepEqual(changedKeys(before, fingerprint(home)), []);
});

test('[contract] an action that would disturb another profile\'s bundle is refused', async () => {
  seedCache();
  seedProfile('desktop', { declares: true });
  const other = join(PROFILES, 'laptop');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'dsh-profile-laptop', dependencies: {}, dsh: { profile: { bundles: [pkg] } } }), 'utf8');
  writeBundle(bundleDir(), { txid: 'tx-ours', tag: 'v2' });
  writeDirectoryWithBundle(backupDir('tx-ours'), { txid: 'tx-prev', tag: 'v1' });
  writeJournal(journalRecord('tx-ours', 'PUBLISHED'));
  const { routes } = makeCtx({ installed: true });
  const before = fingerprint(home);

  const refused = await repair(routes, { slug, action: 'rollback', txid: 'tx-ours' });

  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'repair-refused');
  assert.equal(refused.body.error.reasons.some((reason) => /profile|laptop|read by/i.test(reason)), true, JSON.stringify(refused.body.error.reasons));
  assert.deepEqual(changedKeys(before, fingerprint(home)), []);
});

// --- a real, held file handle, rather than an injected failure ----------------------------------

/**
 * Wait until another process is really holding the file open, by asking the filesystem.
 *
 * Windows refuses to rename a file that another process opened without sharing deletion, so a
 * rename only failing is evidence the handle is there. Polling for that beats sleeping and hoping,
 * which on a loaded machine is how a test becomes flaky.
 */
async function waitUntilLocked(file) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      renameSync(file, file + '.probe');
      renameSync(file + '.probe', file);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test('[contract] a file another process holds open never leaves a half-removed rollback', async () => {
  seedCache();
  seedProfile('desktop', { declares: true });
  writeBundle(bundleDir(), { txid: 'tx-mine', tag: 'v2' });
  writeDirectoryWithBundle(backupDir('tx-mine'), { txid: 'tx-prev', tag: 'v1' });
  writeJournal(journalRecord('tx-mine', 'PUBLISHED'));
  const held = join(bundleDir(), 'cordis.patch.yml');
  const holder = spawn('powershell', ['-NoProfile', '-Command',
    "$f=[IO.File]::Open('" + held + "','Open','Read','None'); Start-Sleep -Seconds 30; $f.Close()"], { stdio: 'ignore' });
  const locked = await waitUntilLocked(held);
  try {
    const { routes } = makeCtx({ installed: true });
    const answer = await repair(routes, { slug, action: 'rollback', txid: 'tx-mine' });
    // Whichever way this platform answers, one of two complete states must be on disk: the previous
    // version published with its backup gone, or everything kept with the journal saying so. A
    // directory that was half-removed, or a backup that disappeared while the buy was not restored,
    // is the failure this case exists to catch.
    if (answer.body.ok === true) {
      assert.equal(existsSync(backupDir('tx-mine')), false, 'a completed rollback has no backup left');
      assert.equal(readFileSync(join(bundleDir(), 'cordis.patch.yml'), 'utf8'), patchFor('v1'), 'and the previous version is the published one');
      assert.equal(existsSync(journalPath()), false);
    } else {
      assert.equal(answer.body.error.code, 'needs-attention');
      assert.equal(readJournal().phase, 'NEEDS_ATTENTION');
      assert.equal(readFileSync(join(backupDir('tx-mine'), 'cordis.patch.yml'), 'utf8'), patchFor('v1'),
        'the previous version is still the only copy, and it is still there');
    }
    assert.equal(existsSync(join(bundleDir(), 'market.meta.json')) || existsSync(backupDir('tx-mine')), true,
      'the transaction is accounted for somewhere: no state was left unowned');
  } finally {
    holder.kill();
  }
  assert.equal(locked || process.platform !== 'win32', true, 'the handle really was held while the run happened');
});

test('[contract] a quarantine that fails keeps the published directory, the backup and the journal', async () => {
  seedCache();
  seedProfile('desktop', { declares: true });
  const published = writeBundle(bundleDir(), { txid: 'tx-mine', tag: 'v2' });
  writeDirectoryWithBundle(backupDir('tx-mine'), { txid: 'tx-prev', tag: 'v1' });
  writeJournal(journalRecord('tx-mine', 'PUBLISHED'));
  const { routes } = makeCtx({ installed: true });
  process.env.MCP_MARKET_FAULT = 'repair-quarantine';

  const failed = await repair(routes, { slug, action: 'rollback', txid: 'tx-mine' });
  delete process.env.MCP_MARKET_FAULT;

  assert.equal(failed.body.error.code, 'needs-attention');
  assert.equal(readFileSync(join(bundleDir(), 'cordis.patch.yml'), 'utf8'), patchFor('v2'), 'the published version is untouched');
  assert.equal(JSON.parse(readFileSync(join(bundleDir(), 'market.meta.json'), 'utf8')).txid, published.txid);
  assert.equal(readFileSync(join(backupDir('tx-mine'), 'cordis.patch.yml'), 'utf8'), patchFor('v1'), 'and so is the previous one');
  assert.equal(readJournal().phase, 'NEEDS_ATTENTION');
  assert.equal(readJournal().intent, 'restore-failed');
});

test('[contract] an unknown action is a bad request, not a silent success', async () => {
  seedCache();
  seedProfile('desktop');
  writeBundle(bundleDir(), { txid: 'tx-ours', tag: 'v1' });
  const { routes } = makeCtx({ installed: true });

  const refused = await repair(routes, { slug, action: 'delete-everything', txid: 'tx-ours' });

  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, 'unknown-action');
});
