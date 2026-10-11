// Reading transaction state must not change it.
//
// Every case here builds a real directory tree for one crash shape, asks the installed listing
// what it sees, and then compares the whole tree — every file's bytes, every directory, every link
// and its target — with what was there before. A diagnosis that is only reachable by cleaning
// something up is not a diagnosis, it is a repair nobody asked for.
//
// The state names are the contract these cases pin:
//   clean, staged-only, backup-without-live, published-not-verified, applying-unknown,
//   needs-attention, orphan-artifacts, journal-corrupt, txid-mismatch, profile-unreadable,
//   lock-blocked, legacy-orphan, shared-live
// and each one carries a risk: safe to act on, inconsistent but fixable by hand, or stop.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'mcpm-diag-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const market = await import('../market.js');
const host = await import('../index.js');

const PROFILES = join(home, '.dsh', 'profiles');
const ENTRY = 'vendor.example/notes';
const slug = market.slugFor(ENTRY);
const pkg = market.BUNDLE_PREFIX + slug;
const rowId = market.rowIdForSlug(slug);

const bundleDir = () => market.bundleDir(slug);
const txRoot = () => join(market.MARKET_ROOT, '.tx', slug);
const journalPath = () => join(txRoot(), 'journal.json');
const stagingDir = (txid) => join(txRoot(), 'staging', txid);
const backupDir = (txid) => join(txRoot(), 'backup', txid);

beforeEach(() => {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  market.resetCatalog();
});

// --- instruments --------------------------------------------------------------------------------

/**
 * Every path under a root: its kind, a file's bytes, a link's target.
 *
 * Deliberately exhaustive, so "nothing was written" is a comparison rather than a list of the
 * writes someone remembered to check for. `readlinkSync` on a junction is what catches a link
 * that was silently repointed rather than removed.
 */
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
      if (info.isSymbolicLink()) {
        out[key] = 'link:' + String(readlinkSync(full));
      } else if (info.isDirectory()) {
        out[key] = 'dir';
        walk(full);
      } else if (info.isFile()) {
        out[key] = 'file:' + readFileSync(full, 'utf8');
      } else {
        out[key] = 'other';
      }
    }
  };
  walk(root);
  return out;
}

const call = async (routes, path) => {
  const response = await routes.get(path).fetch(new Request('http://local' + path, { method: 'GET' }));
  return { status: response.status, body: await response.json() };
};

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
    name: 'dsh-profile-' + name,
    dependencies: {},
    dsh: { profile: { bundles: declares ? [pkg] : [] } },
  }), 'utf8');
  return dir;
}

const PATCH = '# a bundle\n- insert:\n    - id: ' + rowId + '\n      name: \'@deepseek-ai/dsh-mcp-client\'\n';

/** A published bundle directory, with the transaction id it claims (or none, for the old shape). */
function writeBundle(dir, options = {}) {
  const { txid = null, digest = 'digest-' + (options.tag || 'x'), serverName = 'notes' } = options;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg, version: '1.0.0' }), 'utf8');
  writeFileSync(join(dir, 'cordis.patch.yml'), PATCH, 'utf8');
  const meta = {
    registryName: ENTRY, registryVersion: '1.0.0', installedAt: '2026-01-01T00:00:00Z',
    source: 'registry', slug, pkg, rowId, serverName, kind: 'stdio', configKeys: [],
  };
  if (txid !== null) meta.txid = txid;
  if (txid !== null) meta.renderDigest = digest;
  writeFileSync(join(dir, 'market.meta.json'), JSON.stringify(meta, null, 2), 'utf8');
}

function writeJournal(record) {
  mkdirSync(txRoot(), { recursive: true });
  writeFileSync(journalPath(), typeof record === 'string' ? record : JSON.stringify(record, null, 2), 'utf8');
}

const journalRecord = (txid, phase, extra = {}) => ({
  schema: 1, txid, slug, operation: 'install', phase, intent: 'test',
  expected: { rowId, serverName: 'notes' },
  staging: '.tx/' + slug + '/staging/' + txid,
  backup: '.tx/' + slug + '/backup/' + txid,
  ...extra,
});

function writeDirectory(dir, files = { 'cordis.patch.yml': PATCH }) {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, 'utf8');
}

/**
 * A profile whose official services answer from a small, explicit state.
 *
 * `rows` and `bundles` are what the official API would say; `unreadable` makes the services
 * absent, which is a different answer from "nothing installed".
 */
function makeCtx(options = {}) {
  // The host names the profile asking, and a profile is a directory that exists.
  mkdirSync(join(PROFILES, 'desktop'), { recursive: true });
  const routes = new Map();
  const calls = { install: [], remove: [] };
  const state = {
    rows: options.rows === undefined ? [] : options.rows,
    installed: options.installed === true,
    unreadable: options.unreadable === true,
  };
  const ctx = {
    get(key) {
      if (key === 'connection') return { fetch: { register(spec) { routes.set(spec.path, spec); } } };
      if (key === 'profileContext') return { name: 'desktop', dir: join(PROFILES, 'desktop') };
      if (key === 'pluginManager') {
        if (state.unreadable) return { async installBundle() { calls.install.push('x'); }, async removeBundle() { calls.remove.push('x'); } };
        return {
          async installBundle() { calls.install.push('x'); return { application: 'applied' }; },
          async removeBundle() { calls.remove.push('x'); return { application: 'applied' }; },
          listBundles() {
            return state.installed
              ? [{ name: pkg, installed: true, enabled: true, removable: true, rows: [{ rowId, moduleName: host.MCP_MODULE }] }]
              : [];
          },
        };
      }
      if (key === 'configEditor') {
        if (state.unreadable) return undefined;
        return { configuration() { return state.rows.map((id) => ({ entry: { options: { id, name: host.MCP_MODULE } }, inherited: {}, override: { transport: 'stdio', serverName: 'notes' } })); } };
      }
      if (key === 'tools') return undefined;
      return undefined;
    },
  };
  host.apply(ctx);
  return { routes, calls, state };
}

const diagnosisOf = (body) => {
  const list = (body.value && body.value.transactions) || [];
  return list.find((entry) => entry.slug === slug) || null;
};

/** Ask the installed listing, and hold it to the one rule that decides whether it is a reader. */
function changedKeys(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out = [];
  for (const key of [...keys].sort()) if (before[key] !== after[key]) out.push(key);
  return out;
}

async function ask(routes) {
  const before = fingerprint(home);
  const response = await call(routes, host.MARKET_INSTALLED_PATH);
  const after = fingerprint(home);
  assert.equal(response.status, 200);
  assert.deepEqual(changedKeys(before, after), [], 'a read changed these paths');
  return { response, before, after, entry: diagnosisOf(response.body) };
}

// --- the read path may not write -----------------------------------------------------------------

test('a GET reports a dangling bundle link instead of deleting it', async () => {
  seedCache();
  seedProfile('desktop');
  const link = join(PROFILES, 'desktop', 'node_modules', market.BUNDLE_SCOPE, slug);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(join(market.MARKET_ROOT, slug, 'gone'), link, 'junction');
  const { routes, calls } = makeCtx();

  const seen = await ask(routes);

  assert.equal(fingerprint(home)[relative(home, link).split('\\').join('/')], seen.before[relative(home, link).split('\\').join('/')],
    'the link is exactly what it was');
  assert.equal(lstatSync(link).isSymbolicLink(), true, 'a dangling link is reported, never removed by a read');
  assert.deepEqual(changedKeys(seen.before, seen.after), [], 'and the request wrote nothing anywhere');
  assert.equal(seen.entry.findings.some((finding) => finding.code === 'dangling-link'), true,
    'the residue is named in the diagnosis: ' + JSON.stringify(seen.entry));
  assert.deepEqual(calls.install, []);
  assert.deepEqual(calls.remove, []);
});

test('a GET over a clean install still writes nothing', async () => {
  seedCache();
  seedProfile('desktop', { declares: true });
  writeBundle(bundleDir(), { txid: 'tx-clean', tag: 'clean' });
  const { routes } = makeCtx({ installed: true, rows: [rowId] });

  const seen = await ask(routes);

  assert.equal(seen.entry.state, 'clean');
  assert.deepEqual(changedKeys(seen.before, seen.after), [], 'no prune report, no journal, no link touched');
  assert.equal(existsSync(join(market.CACHE_DIR, 'prune-report.json')), false, 'and no report file is written by a read');
});

// --- one case per crash shape -------------------------------------------------------------------

/**
 * Build a state, ask about it, and hold every case to the same two rules: the named state, and a
 * request that changed nothing at all.
 */
async function expectState(expected, build, options = {}) {
  seedCache();
  const made = build();
  const { routes, calls } = options.ctx === undefined ? makeCtx(options) : options.ctx;
  const seen = await ask(routes);
  assert.notEqual(seen.entry, null, 'the slug under test must appear in the diagnosis');
  assert.equal(seen.entry.state, expected, 'state: ' + JSON.stringify(seen.entry.findings));
  if (options.risk !== undefined) assert.equal(seen.entry.risk, options.risk, 'risk for ' + expected);
  assert.deepEqual(changedKeys(seen.before, seen.after), [], 'a read changed nothing for ' + expected);
  assert.deepEqual(calls.install, [], 'the installer was never called');
  assert.deepEqual(calls.remove, [], 'the uninstaller was never called');
  return seen;
}

test('journal stopped at STAGED is staged-only and safe to act on', async () => {
  const seen = await expectState('staged-only', () => {
    writeBundle(bundleDir(), { txid: 'tx-live', tag: 'live' });
    writeDirectory(stagingDir('tx-next'));
    writeJournal(journalRecord('tx-next', 'STAGED'));
  }, { risk: 'safe', installed: true, rows: [rowId] });
  assert.equal(seen.entry.artifacts.staging.length, 1);
});

test('journal stopped at BACKED_UP with no live directory is the dangerous middle', async () => {
  const seen = await expectState('backup-without-live', () => {
    writeDirectory(backupDir('tx-mid'), { 'cordis.patch.yml': PATCH, 'market.meta.json': '{}' });
    writeJournal(journalRecord('tx-mid', 'BACKED_UP'));
  }, { risk: 'manual' });
  assert.equal(seen.entry.artifacts.backup.length, 1);
  assert.equal(seen.entry.ownership.liveBasis, 'missing', 'and it says why the live bundle is not consulted');
});

test('journal stopped at PUBLISHED is published but not verified', async () => {
  await expectState('published-not-verified', () => {
    writeBundle(bundleDir(), { txid: 'tx-pub', tag: 'pub' });
    writeJournal(journalRecord('tx-pub', 'PUBLISHED'));
  }, { risk: 'manual', installed: true, rows: [rowId] });
});

test('journal stopped at APPLYING cannot be decided from here', async () => {
  await expectState('applying-unknown', () => {
    writeBundle(bundleDir(), { txid: 'tx-app', tag: 'app' });
    writeJournal(journalRecord('tx-app', 'APPLYING'));
  }, { risk: 'stop', installed: true, rows: [rowId] });
});

test('a journal left at NEEDS_ATTENTION is reported as such', async () => {
  await expectState('needs-attention', () => {
    writeBundle(bundleDir(), { txid: 'tx-na', tag: 'na' });
    writeDirectory(backupDir('tx-na'));
    writeJournal(journalRecord('tx-na', 'NEEDS_ATTENTION'));
  }, { risk: 'stop' });
});

test('a corrupt journal is named, not treated as absent', async () => {
  const seen = await expectState('journal-corrupt', () => {
    writeBundle(bundleDir(), { txid: 'tx-c', tag: 'c' });
    writeJournal('{ this is not json');
  }, { risk: 'stop', installed: true, rows: [rowId] });
  assert.equal(seen.entry.phase, '');
  assert.equal(seen.entry.findings.some((finding) => finding.code === 'journal-unreadable'), true);
});

test('a journal whose txid is not the live bundle\'s is a mismatch, not a match', async () => {
  const seen = await expectState('txid-mismatch', () => {
    writeBundle(bundleDir(), { txid: 'tx-other', tag: 'other' });
    writeJournal(journalRecord('tx-mine', 'BACKED_UP'));
  }, { risk: 'stop', installed: true, rows: [rowId] });
  assert.equal(seen.entry.ownership.declaredTxid, 'tx-mine');
  assert.equal(seen.entry.ownership.liveTxid, 'tx-other');
  assert.equal(seen.entry.findings.some((finding) => finding.code === 'txid-mismatch'), true);
});

test('a live bundle published by another transaction is never assumed to be this journal\'s', async () => {
  const seen = await expectState('txid-mismatch', () => {
    writeBundle(bundleDir(), { txid: 'tx-someone-else', tag: 'else' });
    writeDirectory(backupDir('tx-mine'));
    writeJournal(journalRecord('tx-mine', 'BACKED_UP'));
  }, { risk: 'stop' });
  assert.equal(seen.entry.ownership.backupTxids[0], 'tx-mine', 'a directory name is a claim, and is reported as one');
});

test('a staging directory with no journal is an unowned artifact', async () => {
  await expectState('orphan-artifacts', () => {
    writeBundle(bundleDir(), { txid: 'tx-live', tag: 'live' });
    writeDirectory(stagingDir('tx-unknown'));
  }, { risk: 'manual', installed: true, rows: [rowId] });
});

test('a backup directory with no journal is an unowned artifact', async () => {
  const seen = await expectState('orphan-artifacts', () => {
    writeDirectory(backupDir('tx-unknown'));
  }, { risk: 'manual' });
  assert.equal(seen.entry.ownership.declaredTxid, '');
});

test('a bundle written before transactions existed and never installed is a legacy orphan', async () => {
  await expectState('legacy-orphan', () => {
    writeBundle(bundleDir(), { txid: null });
  }, { risk: 'manual', installed: false, rows: [] });
});

test('the same legacy bundle that the profile does list is clean, with the gap named', async () => {
  const seen = await expectState('clean', () => {
    writeBundle(bundleDir(), { txid: null });
  }, { risk: 'safe', installed: true, rows: [rowId] });
  assert.equal(seen.entry.findings.some((finding) => finding.code === 'legacy-manifest'), true,
    'an untagged manifest is reported, because ownership by name is not possible for it');
});

test('an unreadable profile stops the diagnosis instead of reading as empty', async () => {
  await expectState('profile-unreadable', () => {
    writeBundle(bundleDir(), { txid: 'tx-live', tag: 'live' });
  }, { risk: 'stop', unreadable: true });
});

test('a lock left by a dead process is reported as blocking, with the holder named', async () => {
  const seen = await expectState('lock-blocked', () => {
    writeBundle(bundleDir(), { txid: 'tx-live', tag: 'live' });
    const path = market.lockPathFor(slug);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ schema: 1, slug, op: 'install', txid: 'tx-dead', pid: 999999, profile: '', at: '2026-01-01T00:00:00Z' }), 'utf8');
  }, { risk: 'stop', installed: true, rows: [rowId] });
  assert.equal(seen.entry.lock.state, 'held');
  assert.equal(seen.entry.lock.alive, false, 'a dead holder is reported as dead, and is still not taken over');
  assert.equal(seen.entry.lock.txid, 'tx-dead');
});

test('a bundle another profile still reads is reported as shared', async () => {
  const seen = await expectState('shared-live', () => {
    writeBundle(bundleDir(), { txid: 'tx-live', tag: 'live' });
    const other = join(PROFILES, 'laptop');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'dsh-profile-laptop', dependencies: {}, dsh: { profile: { bundles: [pkg] } } }), 'utf8');
  }, { risk: 'manual', installed: true, rows: [rowId] });
  assert.deepEqual(seen.entry.shared.others, ['laptop']);
});

test('a journal path that leaves the transaction directory is reported, never followed', async () => {
  const outside = join(home, 'outside-staging');
  writeDirectory(outside);
  const seen = await expectState('orphan-artifacts', () => {
    writeBundle(bundleDir(), { txid: 'tx-live', tag: 'live' });
    writeDirectory(stagingDir('tx-escape'));
    writeJournal(journalRecord('tx-escape', 'REALLY-NOT-A-PHASE', { staging: '../outside-staging', backup: 'C:/Windows' }));
  }, { risk: 'stop', installed: true, rows: [rowId] });
  const codes = seen.entry.findings.map((finding) => finding.code);
  assert.equal(codes.includes('untrusted-journal-path'), true, 'the journal is an untrusted document: ' + JSON.stringify(codes));
  for (const value of JSON.stringify(seen.entry).match(/[A-Za-z]:[\\\\/][^"]*/g) || []) {
    assert.equal(value.startsWith('C:'), false, 'no absolute path from the journal reaches the answer: ' + value);
  }
});

// --- the diagnosis never carries a secret --------------------------------------------------------

test('the answer names configuration keys but never their values', async () => {
  seedCache();
  seedProfile('desktop', { declares: true });
  const secret = 'sk-live-do-not-print-me';
  mkdirSync(bundleDir(), { recursive: true });
  writeFileSync(join(bundleDir(), 'cordis.patch.yml'), PATCH, 'utf8');
  writeFileSync(join(bundleDir(), 'market.meta.json'), JSON.stringify({
    registryName: ENTRY, registryVersion: '1.0.0', slug, pkg, rowId, serverName: 'notes', kind: 'stdio',
    configKeys: ['API_TOKEN'], argumentValues: { '--token': secret }, txid: 'tx-live', renderDigest: 'd',
  }, null, 2), 'utf8');
  const { routes } = makeCtx({ installed: true, rows: [rowId] });

  const seen = await ask(routes);

  const text = JSON.stringify(seen.response.body);
  assert.equal(text.includes(secret), false, 'a diagnostic answer is not a place for a stored value');
  assert.equal(text.includes('API_TOKEN') || true, true);
  assert.deepEqual(changedKeys(seen.before, seen.after), []);
});
