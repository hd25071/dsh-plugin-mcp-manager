// The install transaction, from the outside.
//
// Everything below is asserted against what is on disk, what the fake profile holds and how often
// the installer was called — never against a status code alone. The point of the transaction is
// that a failure leaves the machine in a state a person can reason about: either the previous
// bundle is exactly where and what it was, or the transaction says out loud that it could not get
// back there. So the interesting cases are all failures, and each one names the damage it would
// have caused without the transaction.
//
// The staging/backup/journal layout is part of the contract these cases pin:
//   <MARKET_ROOT>/.tx/<slug>/journal.json
//   <MARKET_ROOT>/.tx/<slug>/staging/<txid>/
//   <MARKET_ROOT>/.tx/<slug>/backup/<txid>/
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

const home = mkdtempSync(join(tmpdir(), 'mcpm-tx-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const market = await import('../market.js');
const host = await import('../index.js');

const ENTRY = 'vendor.example/notes';
const slug = market.slugFor(ENTRY);
const pkg = market.BUNDLE_PREFIX + slug;

const bundleDir = () => market.bundleDir(slug);
const txRoot = () => join(market.MARKET_ROOT, '.tx', slug);
const journalPath = () => join(txRoot(), 'journal.json');
const stagingRoot = () => join(txRoot(), 'staging');
const backupRoot = () => join(txRoot(), 'backup');
const entriesIn = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);

/** Every byte under a directory, so a restore can be compared rather than assumed. */
function snapshot(dir) {
  const out = {};
  const walk = (current, prefix) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full, prefix + name + '/');
      else out[prefix + name] = readFileSync(full, 'utf8');
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return out;
}

const OLD_TOKEN = 'old-token-abc123';
const OLD_SECRET = 'Bearer old-secret-xyz';

beforeEach(() => {
  rmSync(market.MARKET_ROOT, { recursive: true, force: true });
  rmSync(market.CACHE_DIR, { recursive: true, force: true });
  rmSync(join(home, '.dsh', 'profiles'), { recursive: true, force: true });
  delete process.env.MCP_MARKET_FAULT;
  market.resetCatalog();
});

/** One registry entry with an env var and a named argument, so an update has something to lose. */
function seedCache() {
  mkdirSync(dirname(market.CACHE_PATH), { recursive: true });
  writeFileSync(market.CACHE_PATH, JSON.stringify({
    cacheVersion: market.CACHE_VERSION, fetchedAt: new Date().toISOString(), count: 1,
    servers: [{
      name: ENTRY, title: 'Vendor Notes', description: 'one entry', version: '1.0.0',
      publishedAt: '2026-01-01T00:00:00Z', remotes: [],
      packages: [{
        registryType: 'npm', identifier: '@example/notes', version: '1.0.0', transport: 'stdio',
        environmentVariables: [{ name: 'NOTE_TOKEN', description: 'the token', isRequired: true, isSecret: true }],
        packageArguments: [{ type: 'named', name: '--out', description: 'where to write', isRequired: false, value: '' }],
      }],
    }],
  }));
  market.resetCatalog();
}

/** A profile directory the host can name, so the shared-reference check has an owner to compare. */
function seedProfile(name) {
  const dir = join(home, '.dsh', 'profiles', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-' + name, dependencies: {}, dsh: { profile: { bundles: [] } },
  }), 'utf8');
  return dir;
}

const rowFromBundle = (dir) => {
  const patch = yaml.load(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')) || [];
  for (const entry of patch) {
    for (const row of entry.insert || []) {
      if (row.name === host.MCP_MODULE) {
        return { entry: { options: { id: row.id, name: host.MCP_MODULE } }, inherited: {}, override: row.config || {} };
      }
    }
  }
  throw new Error('the staged bundle declares no MCP row: ' + dir);
};

/**
 * The fake DSH: a mutable profile plus a manager that applies what the bundle declares.
 *
 * `state.install` is what `installBundle` answers, `state.mutate` makes it change the profile and
 * then fail anyway, and `state.rowFresh = false` is a runtime that has not picked the change up
 * yet — the case where a persisted change must not be reported as a live one.
 */
function makeCtx(options = {}) {
  const routes = new Map();
  const calls = { install: [], remove: [] };
  const state = {
    install: options.install === undefined ? 'applied' : options.install,
    mutate: null,
    rowFresh: options.rowFresh !== false,
    rowsReadable: options.rowsReadable !== false,
    profile: { rows: [], bundles: [] },
  };
  const ctx = {
    get(key) {
      if (key === 'connection') return { fetch: { register(spec) { routes.set(spec.path, spec); } } };
      if (key === 'profileContext') return { name: 'desktop', dir: join(home, '.dsh', 'profiles', 'desktop') };
      if (key === 'pluginManager') return {
        async installBundle(dir, installOptions) {
          calls.install.push({ dir, options: installOptions });
          const row = rowFromBundle(dir);
          if (state.mutate === 'row') state.profile.rows = [row];
          if (state.mutate === 'bundles') state.profile.bundles = [pkg];
          if (state.install === 'throw') throw new Error('the installer exploded');
          if (state.install === 'applied' || state.install === 'restart-required') {
            state.profile.bundles = [pkg];
            if (state.rowFresh) state.profile.rows = [row];
            return { application: state.install };
          }
          if (state.install === 'raw') return options.rawResult;
          return { application: state.install };
        },
        async removeBundle(name) { calls.remove.push(name); return { application: 'applied' }; },
        listBundles() {
          return state.profile.bundles.includes(pkg)
            ? [{ name: pkg, installed: true, enabled: true, removable: true, rows: state.profile.rows.map((r) => ({ rowId: r.entry.options.id, moduleName: host.MCP_MODULE })) }]
            : [];
        },
      };
      if (key === 'configEditor') {
        if (!state.rowsReadable) return undefined;
        return { configuration() { return state.profile.rows.map((row) => ({ ...row })); } };
      }
      return undefined;
    },
  };
  host.apply(ctx);
  return { routes, calls, state };
}

const post = (payload) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
const call = async (routes, path, payload) => {
  const response = await routes.get(path).fetch(new Request('http://local' + path, post(payload)));
  return { status: response.status, body: await response.json() };
};
const install = (routes, extra = {}) => call(routes, host.MARKET_INSTALL_PATH, {
  name: ENTRY, optionIndex: 0, config: { NOTE_TOKEN: OLD_TOKEN }, arguments: { '--out': 'D:\\out' }, ...extra,
});

/** Install once for real, so the next call is an update with something to lose. */
async function seedInstalled(seedOptions = {}) {
  seedCache();
  seedProfile('desktop');
  const made = makeCtx(seedOptions);
  const first = await install(made.routes);
  assert.equal(first.status, 200, 'the seed install must succeed: ' + JSON.stringify(first.body));
  // The seed is setup, not the behaviour under test: what the cases below count is the installer
  // calls made by the request they actually exercise.
  made.calls.install.length = 0;
  return made;
}

const readJournal = () => (existsSync(journalPath()) ? JSON.parse(readFileSync(journalPath(), 'utf8')) : null);

// --- R1: a failed first install may not leave an orphan manifest --------------------------------

test('R1 a failed first install leaves no bundle, no manifest and no journal', async () => {
  seedCache();
  seedProfile('desktop');
  const { routes, calls, state } = makeCtx({ install: 'failed' });

  const refused = await install(routes);

  assert.notEqual(refused.body.ok, true, 'a failed install is not a success');
  assert.equal(refused.body.value.install.application, 'failed');
  assert.equal(existsSync(bundleDir()), false, 'nothing may be left where the bundle would go');
  assert.deepEqual(market.listInstalled(), [], 'and the market may not list it as installed');
  assert.deepEqual(state.profile.rows, [], 'the profile was never touched');
  assert.deepEqual(state.profile.bundles, []);
  assert.deepEqual(calls.remove, [], 'no uninstall is invented to clean up after a failure');
  assert.equal(existsSync(journalPath()), false, 'a completed rollback leaves no journal');
  assert.deepEqual(entriesIn(stagingRoot()), [], 'and no staging directory');
});

// --- R2 / R3: a failed update restores the previous bundle, and reports failure ------------------

test('R2 a failed update puts the previous bundle back byte for byte', async () => {
  const { routes, state } = await seedInstalled();
  const before = snapshot(bundleDir());
  const rowsBefore = JSON.parse(JSON.stringify(state.profile.rows));
  assert.notEqual(before['cordis.patch.yml'], undefined);

  state.install = 'failed';
  const refused = await install(routes, { config: { NOTE_TOKEN: 'the-new-token' } });

  assert.notEqual(refused.body.ok, true);
  assert.deepEqual(snapshot(bundleDir()), before, 'the previous version is exactly what it was');
  assert.deepEqual(state.profile.rows, rowsBefore, 'and the profile is exactly what it was');
  assert.deepEqual(entriesIn(stagingRoot()), []);
  assert.equal(existsSync(journalPath()), false);
});

test('R3 a resolved promise carrying application failed is never reported as success', async () => {
  const { routes, state } = await seedInstalled();
  const before = snapshot(bundleDir());
  state.install = 'failed';

  const refused = await install(routes, { config: { NOTE_TOKEN: 'the-new-token' } });

  assert.notEqual(refused.body.ok, true, 'resolve() is not the thing that decides success');
  assert.equal(refused.body.value.install.application, 'failed', 'the classification is preserved');
  assert.notEqual(refused.body.value.phase, 'DONE', 'and the transaction did not claim to be done');
  assert.deepEqual(snapshot(bundleDir()), before);
});

// --- R4: a partial profile change is never undone by calling removeBundle -----------------------

test('R4 a partial profile change is reported, not undone with removeBundle', async () => {
  seedCache();
  seedProfile('desktop');
  const { routes, calls, state } = makeCtx({ install: 'throw' });
  state.mutate = 'row';

  const refused = await install(routes);

  assert.notEqual(refused.body.ok, true);
  assert.equal(refused.body.error.code, 'needs-attention', 'a half-applied profile is not a clean failure');
  assert.deepEqual(calls.remove, [], 'an HTTP-level failure is not proof that the change is ours to undo');
  assert.equal(state.profile.rows.length, 1, 'the row the installer wrote is left exactly as it is');
  const journal = readJournal();
  assert.notEqual(journal, null, 'the journal is kept so a person can see what happened');
  assert.equal(journal.phase, 'NEEDS_ATTENTION');
  assert.equal(journal.txid, refused.body.value.txid, 'and it names the transaction that got stuck');
});

// --- R5: the second rename fails, so the first one is undone ------------------------------------

test('R5 a failed publish rename puts the backed-up bundle back', async () => {
  const { routes, calls, state } = await seedInstalled();
  const before = snapshot(bundleDir());
  process.env.MCP_MARKET_FAULT = 'publish-rename';

  const refused = await install(routes, { config: { NOTE_TOKEN: 'the-new-token' } });
  delete process.env.MCP_MARKET_FAULT;

  assert.notEqual(refused.body.ok, true);
  assert.deepEqual(snapshot(bundleDir()), before, 'the directory that was moved aside is moved back');
  assert.deepEqual(calls.install, [], 'the installer was never reached');
  assert.deepEqual(calls.remove, []);
  assert.equal(state.profile.bundles.includes(pkg), true, 'the profile still has the old bundle');
  assert.deepEqual(entriesIn(stagingRoot()), [], 'the staging directory does not survive the failure');
  assert.equal(existsSync(journalPath()), false);
});

// --- R6: a staging failure may not touch the published bundle -----------------------------------

test('R6 a staging failure leaves the published bundle untouched', async () => {
  const { routes, calls } = await seedInstalled();
  const before = snapshot(bundleDir());
  process.env.MCP_MARKET_FAULT = 'stage-write';

  const refused = await install(routes, { config: { NOTE_TOKEN: 'the-new-token' } });
  delete process.env.MCP_MARKET_FAULT;

  assert.notEqual(refused.body.ok, true);
  assert.deepEqual(snapshot(bundleDir()), before, 'staging is not the published directory');
  assert.deepEqual(calls.install, [], 'nothing was applied');
  assert.deepEqual(entriesIn(stagingRoot()), [], 'and the half-written staging directory is gone');
  assert.equal(existsSync(journalPath()), false, 'nothing was ever announced as an intent');
  assert.equal(existsSync(backupRoot()), false, 'and nothing was backed up');
});

// --- fixtures this half needs ------------------------------------------------------------------

import { execFileSync } from 'node:child_process';

const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const zipWork = mkdtempSync(join(tmpdir(), 'mcpm-tx-zip-'));

/** A real .mcpb, so the download under test is the download the app performs. */
function buildZip() {
  const dir = join(zipWork, 'packed');
  mkdirSync(join(dir, 'server'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 0.3, name: 'notes', version: '1.0.0',
    server: {
      type: 'node', entry_point: 'server/index.js',
      mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'], env: { NOTE: 'from-mcpb' } },
    },
    compatibility: { platforms: ['win32'], runtimes: { node: '>=18.0.0' } },
  }, null, 2));
  writeFileSync(join(dir, 'server', 'index.js'), 'console.log("mcpb");');
  const zip = join(zipWork, 'notes.mcpb');
  execFileSync(tar, ['-a', '-c', '-f', zip, '-C', dir, '.'], { stdio: 'ignore' });
  return readFileSync(zip);
}

// --- R7: a journal that cannot be written stops the transaction before any rename ---------------

test('R7 a journal write failure stops everything before a directory is touched', async () => {
  const { routes, calls, state } = await seedInstalled();
  const before = snapshot(bundleDir());
  process.env.MCP_MARKET_FAULT = 'journal-write';

  const refused = await install(routes, { config: { NOTE_TOKEN: 'the-new-token' } });
  delete process.env.MCP_MARKET_FAULT;

  assert.notEqual(refused.body.ok, true);
  assert.deepEqual(snapshot(bundleDir()), before, 'an unannounced rename never happens');
  assert.deepEqual(calls.install, []);
  assert.deepEqual(entriesIn(stagingRoot()), [], 'the staging directory is not left for a journal that failed');
  assert.equal(existsSync(backupRoot()), false, 'and nothing was moved aside');
  assert.equal(state.profile.bundles.includes(pkg), true);
});

// --- R8 / R12 / R13: leftovers of another transaction block this one ----------------------------

test('R8 a backup nobody can prove belongs to this transaction blocks the install', async () => {
  const { routes, calls } = await seedInstalled();
  const before = snapshot(bundleDir());
  const stranger = join(backupRoot(), 'from-an-earlier-run');
  mkdirSync(stranger, { recursive: true });
  writeFileSync(join(stranger, 'cordis.patch.yml'), '# somebody else pending recovery\n', 'utf8');

  const refused = await install(routes, { config: { NOTE_TOKEN: 'the-new-token' } });

  assert.notEqual(refused.body.ok, true);
  assert.equal(refused.body.error.code, 'residue-present');
  assert.deepEqual(snapshot(bundleDir()), before, 'the published bundle is not touched');
  assert.deepEqual(calls.install, [], 'and nothing is applied');
  assert.equal(readFileSync(join(stranger, 'cordis.patch.yml'), 'utf8'), '# somebody else pending recovery\n',
    'a backup of unknown ownership is left exactly where it is');
});

test('R12 a journal from another transaction is never adopted', async () => {
  const { routes, calls } = await seedInstalled();
  const before = snapshot(bundleDir());
  mkdirSync(txRoot(), { recursive: true });
  writeFileSync(journalPath(), JSON.stringify({
    schema: 1, txid: 'another-transaction', slug, operation: 'install', phase: 'JOURNALED', intent: 'publish',
  }), 'utf8');
  const otherStaging = join(stagingRoot(), 'another-transaction');
  mkdirSync(otherStaging, { recursive: true });
  writeFileSync(join(otherStaging, 'marker'), 'keep me', 'utf8');

  const refused = await install(routes, { config: { NOTE_TOKEN: 'the-new-token' } });

  assert.notEqual(refused.body.ok, true);
  assert.equal(refused.body.error.code, 'residue-present');
  assert.equal(readJournal().txid, 'another-transaction', 'the other record is untouched');
  assert.equal(readFileSync(join(otherStaging, 'marker'), 'utf8'), 'keep me');
  assert.deepEqual(snapshot(bundleDir()), before);
  assert.deepEqual(calls.install, []);
});

test('R13 a transaction interrupted between the two renames is detected, not recovered', async () => {
  const { routes, calls } = await seedInstalled();
  const stranded = snapshot(bundleDir());
  // Exactly what a crash between the two renames leaves: the bundle moved aside, a journal saying
  // the backup happened, and no published directory.
  mkdirSync(backupRoot(), { recursive: true });
  const aside = join(backupRoot(), 'interrupted-tx');
  mkdirSync(aside, { recursive: true });
  for (const [name, content] of Object.entries(stranded)) writeFileSync(join(aside, name), content, 'utf8');
  rmSync(bundleDir(), { recursive: true, force: true });
  mkdirSync(txRoot(), { recursive: true });
  writeFileSync(journalPath(), JSON.stringify({
    schema: 1, txid: 'interrupted-tx', slug, operation: 'update', phase: 'BACKED_UP',
    intent: 'move-staging-into-place', expected: { rowId: market.rowIdForSlug(slug), serverName: 'notes' },
    staging: '.tx/' + slug + '/staging/interrupted-tx', backup: '.tx/' + slug + '/backup/interrupted-tx',
  }), 'utf8');

  const refused = await install(routes, { config: { NOTE_TOKEN: 'the-new-token' } });

  assert.notEqual(refused.body.ok, true);
  assert.equal(refused.body.error.code, 'residue-present', 'an interrupted transaction is reported, not papered over');
  assert.equal(existsSync(bundleDir()), false, 'nothing was published on top of a half-finished transaction');
  assert.deepEqual(entriesIn(aside), Object.keys(stranded).sort(),
    'the stranded version is still there for a person to recover');
  assert.deepEqual(calls.install, [], 'and no automatic recovery ran');
  assert.equal(readJournal().phase, 'BACKED_UP', 'the journal still describes the state it was found in');
});

// --- R9 / R10: a failed compensation keeps everything and leaks nothing -------------------------

test('R9 a compensation that fails itself keeps the backup and asks for attention', async () => {
  const { routes, calls } = await seedInstalled();
  const before = snapshot(bundleDir());
  process.env.MCP_MARKET_FAULT = 'publish-rename,restore-rename';

  const refused = await install(routes, { config: { NOTE_TOKEN: 'the-new-token' } });
  delete process.env.MCP_MARKET_FAULT;

  assert.notEqual(refused.body.ok, true);
  assert.equal(refused.body.error.code, 'needs-attention',
    'a rollback that could not finish may never be reported as one that did');
  const journal = readJournal();
  assert.notEqual(journal, null, 'the record of what was attempted is kept');
  assert.equal(journal.phase, 'NEEDS_ATTENTION');
  assert.deepEqual(calls.install, [], 'nothing was applied while the transaction was unaccounted for');
  assert.deepEqual(calls.remove, [], 'and nothing was uninstalled to tidy up');
  const backups = entriesIn(backupRoot());
  assert.equal(backups.length, 1, 'the only copy of the previous version is left alone');
  assert.deepEqual(snapshot(join(backupRoot(), backups[0])), before, 'and it is the previous version, whole');
});

test('R10 the previous bundle keeps its env, headers and arguments, and the journal keeps no secrets', async () => {
  const { routes } = await seedInstalled();
  const seeded = readFileSync(join(bundleDir(), 'cordis.patch.yml'), 'utf8');
  assert.equal(seeded.includes('NOTE_TOKEN'), true, 'the seed really did write an env var');
  assert.equal(seeded.includes(OLD_TOKEN), true, 'and the value it was installed with');
  assert.equal(seeded.includes('--out'), true, 'and a named argument');
  const before = snapshot(bundleDir());

  process.env.MCP_MARKET_FAULT = 'publish-rename,restore-rename';
  const refused = await install(routes, { config: { NOTE_TOKEN: OLD_SECRET }, arguments: { '--out': 'D:\\new-out' } });
  delete process.env.MCP_MARKET_FAULT;

  assert.notEqual(refused.body.ok, true);
  const backups = entriesIn(backupRoot());
  assert.equal(backups.length, 1);
  assert.deepEqual(snapshot(join(backupRoot(), backups[0])), before, 'the previous version is recoverable byte for byte');
  assert.equal(readFileSync(join(backupRoot(), backups[0], 'cordis.patch.yml'), 'utf8').includes(OLD_TOKEN), true);

  const journalText = readFileSync(journalPath(), 'utf8');
  assert.equal(journalText.includes(OLD_TOKEN), false, 'a journal is not a place for a secret');
  assert.equal(journalText.includes(OLD_SECRET), false);
  assert.equal(journalText.includes('D:\\new-out'), false, 'nor for the values that were being installed');
  const journal = JSON.parse(journalText);
  assert.equal(journal.txid, refused.body.value.txid);
  assert.equal(journal.slug, slug);
  assert.equal(journal.expected.rowId, market.rowIdForSlug(slug));
  assert.equal(journal.expected.serverName, 'notes');
  assert.equal(typeof journal.intent, 'string');
});

// --- R11: the shared-reference check is repeated after staging, before publishing ---------------

test('R11 a reference that appears while staging is refused before anything is published', async () => {
  seedCache();
  seedProfile('desktop');
  // A package that has to be downloaded: the download is the real window between the first
  // shared-reference check and the publish, so this case needs no artificial pause.
  mkdirSync(market.CACHE_DIR, { recursive: true });
  writeFileSync(market.CACHE_PATH, JSON.stringify({
    cacheVersion: market.CACHE_VERSION, fetchedAt: new Date().toISOString(), count: 1,
    servers: [{
      name: ENTRY, title: 'Vendor Notes', description: 'an mcpb package', version: '1.0.0',
      publishedAt: '2026-01-01T00:00:00Z', remotes: [],
      packages: [{ registryType: 'mcpb', identifier: 'https://packages.test/notes.mcpb', version: '1.0.0', transport: 'stdio' }],
    }],
  }));
  market.resetCatalog();
  const zip = buildZip();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    // While the bytes are in flight, another profile starts using this bundle.
    const link = join(home, '.dsh', 'profiles', 'laptop', 'node_modules', market.BUNDLE_SCOPE, slug);
    mkdirSync(dirname(link), { recursive: true });
    writeFileSync(join(home, '.dsh', 'profiles', 'laptop', 'package.json'), JSON.stringify({
      name: 'dsh-profile-laptop', dependencies: {}, dsh: { profile: { bundles: [pkg] } },
    }), 'utf8');
    return { ok: true, status: 200, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) };
  };
  const { routes, calls } = makeCtx();

  const refused = await install(routes, { config: {} });
  globalThis.fetch = realFetch;

  assert.notEqual(refused.body.ok, true);
  assert.equal(refused.body.error.code, 'shared-bundle', 'the reference is read again before publishing');
  assert.equal(existsSync(bundleDir()), false, 'and nothing is published for a bundle another profile now uses');
  assert.deepEqual(calls.install, []);
  assert.deepEqual(entriesIn(stagingRoot()), [], 'the staged payload goes with the refusal');
  assert.equal(existsSync(journalPath()), false);
});

// --- R14: restart-required is not the same claim as live ----------------------------------------

test('R14 a persisted change with the old row still in force is not reported as live', async () => {
  const { routes, state } = await seedInstalled();
  const before = readFileSync(join(bundleDir(), 'cordis.patch.yml'), 'utf8');
  state.install = 'restart-required';
  state.rowFresh = false;

  const installed = await install(routes, { config: { NOTE_TOKEN: 'the-new-token' } });

  assert.equal(installed.status, 200, 'persisting the change is a success');
  assert.equal(installed.body.ok, true);
  assert.equal(installed.body.value.install.application, 'restart-required');
  // The claim under test: the profile still holds the previous row, so nothing may be called live.
  assert.notEqual(installed.body.value.verification.state, 'live');
  assert.equal(installed.body.value.runtime.state, 'stale',
    'the row the profile still holds is the previous configuration, and the answer must say so');
  assert.equal(installed.body.value.outcome, 'restart-required');
  assert.notEqual(readFileSync(join(bundleDir(), 'cordis.patch.yml'), 'utf8'), before, 'the new version did reach the disk');
});

test('R14b a claim of applied the profile contradicts is not called applied either', async () => {
  const { routes, state } = await seedInstalled();
  state.install = 'applied';
  state.rowFresh = false;

  const installed = await install(routes, { config: { NOTE_TOKEN: 'the-new-token' } });

  assert.equal(installed.body.ok, true, 'the change was persisted');
  assert.equal(installed.body.value.outcome, 'persisted-not-live',
    'the installer said applied while the profile still holds the previous row, so it is not applied here');
});

// --- the ordinary cases still work --------------------------------------------------------------

test('a first install leaves the bundle, no journal and no backup', async () => {
  seedCache();
  seedProfile('desktop');
  const { routes, calls, state } = makeCtx();

  const installed = await install(routes);

  assert.equal(installed.status, 200);
  assert.equal(installed.body.value.phase, 'DONE');
  assert.equal(typeof installed.body.value.txid, 'string');
  assert.equal(calls.install.length, 1);
  assert.equal(calls.install[0].dir, bundleDir(), 'the installer is handed the published bundle');
  assert.equal(existsSync(join(bundleDir(), 'market.meta.json')), true);
  assert.equal(JSON.parse(readFileSync(join(bundleDir(), 'market.meta.json'), 'utf8')).txid, installed.body.value.txid,
    'the manifest says which transaction wrote it');
  assert.equal(existsSync(journalPath()), false, 'a finished transaction leaves no journal');
  assert.equal(existsSync(backupRoot()), false);
  assert.deepEqual(entriesIn(stagingRoot()), []);
  assert.equal(state.profile.bundles.includes(pkg), true);
});

test('a manifest written before this round still updates and keeps its identity', async () => {
  const { routes } = await seedInstalled();
  const metaPath = join(bundleDir(), 'market.meta.json');
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  // Exactly what an older install left behind: no transaction id, no digest. Both are optional.
  delete meta.txid;
  delete meta.renderDigest;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  const before = market.manifestFor(slug);
  assert.equal(before.txid, undefined, 'the fixture really is the old shape');

  const installed = await install(routes, { config: { NOTE_TOKEN: 'the-new-token' } });

  assert.equal(installed.status, 200, 'an older manifest is not a reason to refuse an update');
  const after = JSON.parse(readFileSync(metaPath, 'utf8'));
  assert.equal(after.txid, installed.body.value.txid, 'the update records the transaction that wrote it');
  assert.equal(typeof after.renderDigest, 'string');
  assert.equal(after.rowId, before.rowId, 'the row identity carries over untouched');
  assert.equal(after.serverName, before.serverName);
  assert.deepEqual(after.configKeys, before.configKeys, 'and so does the set of configuration keys');
});

test('an old manifest is still restored when an update fails', async () => {
  const { routes, state } = await seedInstalled();
  const metaPath = join(bundleDir(), 'market.meta.json');
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  delete meta.txid;
  delete meta.renderDigest;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  const before = snapshot(bundleDir());
  state.install = 'failed';

  const refused = await install(routes, { config: { NOTE_TOKEN: 'the-new-token' } });

  assert.notEqual(refused.body.ok, true);
  assert.deepEqual(snapshot(bundleDir()), before, 'the old version is put back exactly as it was');
  assert.equal(JSON.parse(readFileSync(metaPath, 'utf8')).txid, undefined, 'including its old manifest shape');
});

test('an update keeps the row id and the server name the row already had', async () => {
  const { routes } = await seedInstalled();
  const before = JSON.parse(readFileSync(join(bundleDir(), 'market.meta.json'), 'utf8'));

  const installed = await install(routes, { config: { NOTE_TOKEN: 'the-new-token' } });

  assert.equal(installed.status, 200);
  const after = JSON.parse(readFileSync(join(bundleDir(), 'market.meta.json'), 'utf8'));
  assert.equal(after.rowId, before.rowId, 'an update may not move the row');
  assert.equal(after.serverName, before.serverName, 'nor rename the server');
  assert.notEqual(after.renderDigest, before.renderDigest, 'but the content really is the new one');
  assert.equal(after.txid, installed.body.value.txid);
});
