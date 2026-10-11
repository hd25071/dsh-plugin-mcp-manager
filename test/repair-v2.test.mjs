// What recovery is allowed to believe about a running configuration.
//
// Version 2 evidence exists because version 1 could not tell two configurations apart: it hashed the
// values and nothing else, so a changed command, reordered arguments or the other namespace looked
// identical. A recovery that authorises a dangerous operation on that comparison authorises it on
// evidence that cannot distinguish the very case it is protecting against.
//
// [defect]   the shipped comparison accepts a configuration the version 2 evidence rejects. These
//            assert on what the answer claims and on what happened to the journal, not on a status.
// [contract] the rules that replace it, and the actions that must keep working untouched.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'mcpm-v2c-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const market = await import('../market.js');
const tx = await import('../tx.js');
const host = await import('../index.js');

const ENTRY = 'vendor.example/notes';
const PROFILES = join(home, '.dsh', 'profiles');
const slug = market.slugFor(ENTRY);
const pkg = market.BUNDLE_PREFIX + slug;
const rowId = market.rowIdForSlug(slug);
const bundleDir = () => market.bundleDir(slug);
const slugRoot = () => join(market.MARKET_ROOT, '.tx', slug);
const journalPath = () => join(slugRoot(), 'journal.json');
const backupDir = (id) => join(slugRoot(), 'backup', id);
const stagingDir = (id) => join(slugRoot(), 'staging', id);
const API_KEY = 'sk-alpha';
const ROW_ARGS = () => [join(bundleDir(), 'server.js')];

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
const repair = (routes, payload) => call(routes, host.MARKET_REPAIR_PATH, payload);

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
      else out[key] = 'file:' + readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return out;
}
const changedKeys = (before, after) => {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].sort().filter((key) => !key.startsWith('.dsh/mcp-servers/.locks') && before[key] !== after[key]);
};

function seedProfile(name, { declares = false } = {}) {
  const dir = join(PROFILES, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-' + name, dependencies: {}, dsh: { profile: { bundles: declares ? [pkg] : [] } } }, null, 2), 'utf8');
  return dir;
}

const PATCH = (tag) => '# ' + tag + '\n- insert:\n    - id: ' + rowId + '\n      name: \'@deepseek-ai/dsh-mcp-client\'\n      config:\n        serverName: notes\n';

function writeBundle(dir, options = {}) {
  const { txid = 'tx-mine', tag = 'v2', evidence = 'v2', command = 'node', values = { API_KEY }, transport = 'stdio', args = null } = options;
  mkdirSync(dir, { recursive: true });
  const manifestJson = JSON.stringify({ name: pkg, version: '1.0.0' }, null, 2);
  const patch = PATCH(tag);
  const argv = args === null ? [join(dir, 'server.js')] : args;
  const isHttp = transport === 'streamable-http';
  const good = tx.configSummaryOf({ transport, command, args: argv, env: isHttp ? null : values, headers: isHttp ? values : null });
  const meta = {
    registryName: ENTRY, registryVersion: '1.0.0', installedAt: '2026-01-01T00:00:00Z', source: 'registry',
    slug, pkg, rowId, serverName: 'notes', kind: 'stdio', transport, command,
    args: argv, argumentValues: {}, configKeys: Object.keys(values),
    renderDigest: tx.digestOf({ 'package.json': manifestJson, 'cordis.patch.yml': patch }), txid,
  };
  if (evidence !== 'none') {
    meta.contentDigest = tx.digestOf({ 'package.json': manifestJson, 'cordis.patch.yml': patch });
    meta.configDigest = tx.configDigestOf(values);
  }
  if (evidence === 'v2') Object.assign(meta, { configDigestV2: good.digest, configDigestVersion: 2, configNamespace: good.namespace });
  if (evidence === 'damaged') Object.assign(meta, { configDigestV2: 'not-a-digest', configDigestVersion: 2, configNamespace: good.namespace });
  if (evidence === 'unsupported') Object.assign(meta, { configDigestV2: good.digest, configDigestVersion: 99, configNamespace: good.namespace });
  writeFileSync(join(dir, 'package.json'), manifestJson, 'utf8');
  writeFileSync(join(dir, 'cordis.patch.yml'), patch, 'utf8');
  writeFileSync(join(dir, 'market.meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

function writeJournal(record) {
  mkdirSync(slugRoot(), { recursive: true });
  writeFileSync(journalPath(), JSON.stringify({
    schema: 1, txid: 'tx-mine', slug, operation: 'install', phase: 'PUBLISHED', intent: 'test',
    expected: { rowId, serverName: 'notes' }, ...record,
  }, null, 2), 'utf8');
}

function makeCtx(options = {}) {
  mkdirSync(join(PROFILES, 'desktop'), { recursive: true });
  const routes = new Map();
  const row = options.row === undefined
    ? { transport: 'stdio', serverName: 'notes', command: 'node', args: ROW_ARGS(), env: { API_KEY }, headers: null }
    : options.row;
  const ctx = {
    get(key) {
      if (key === 'connection') return { fetch: { register(spec) { routes.set(spec.path, spec); } } };
      if (key === 'profileContext') return { name: 'desktop', dir: join(PROFILES, 'desktop') };
      if (key === 'pluginManager') {
        return {
          async installBundle() { return { application: 'applied' }; },
          async removeBundle() { return { application: 'applied' }; },
          listBundles() {
            return options.installed === false ? [] : [{ name: pkg, installed: true, enabled: true, removable: true, rows: [{ rowId, moduleName: host.MCP_MODULE }] }];
          },
        };
      }
      if (key === 'configEditor') {
        return { configuration() { return row === null ? [] : [{ entry: { options: { id: rowId, name: host.MCP_MODULE } }, inherited: {}, override: row }]; } };
      }
      return undefined;
    },
  };
  host.apply(ctx);
  return routes;
}

function seedUpdate(options = {}) {
  seedProfile('desktop', { declares: true });
  writeBundle(bundleDir(), { txid: 'tx-mine', tag: 'v2', ...options.published });
  writeBundle(backupDir('tx-mine'), { txid: 'tx-prev', tag: 'v1', ...options.backup });
  writeJournal(options.journal || {});
}

const FILES = ['cordis.patch.yml', 'market.meta.json', 'package.json'];
const listing = () => (existsSync(bundleDir()) ? readdirSync(bundleDir()).sort() : []);
const rowWith = (override) => ({ transport: 'stdio', serverName: 'notes', command: 'node', args: ROW_ARGS(), env: { API_KEY }, headers: null, ...override });

test('[defect] accept is not allowed to call a configuration live when the arguments differ', async () => {
  // Same name, same command, same keys, same values — the arguments are what changed, and the
  // shipped comparison never looked at them. It accepted, deleted the journal, and answered live.
  seedUpdate();
  const routes = makeCtx({ row: rowWith({ args: [join(bundleDir(), 'server.js'), '--extra'] }) });

  const answer = await repair(routes, { slug, action: 'accept', txid: 'tx-mine' });

  assert.equal(answer.body.value.live, false, 'a configuration that is not running may not be called live: ' + JSON.stringify(answer.body));
  assert.equal(answer.body.value.verified, false);
  assert.equal(existsSync(journalPath()), true, 'and the transaction must be left for a person');
});

test('[defect] accept is not allowed to call a configuration live on the older evidence alone', async () => {
  seedUpdate({ published: { evidence: 'v1-only' } });
  const routes = makeCtx();

  const answer = await repair(routes, { slug, action: 'accept', txid: 'tx-mine' });

  assert.equal(answer.body.value.verified, false, JSON.stringify(answer.body));
  assert.equal(answer.body.value.live, false);
  assert.equal(existsSync(journalPath()), true);
});

test('[defect] the installed listing does not hand out a secret that was passed as an argument', async () => {
  seedProfile('desktop');
  const meta = writeBundle(bundleDir(), { txid: 'tx-mine' });
  meta.args = ['--token', 'SECRET-ARGUMENT-VALUE'];
  writeFileSync(join(bundleDir(), 'market.meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  const routes = makeCtx();

  const listed = await call(routes, host.MARKET_INSTALLED_PATH, {});

  assert.equal(JSON.stringify(listed.body).includes('SECRET-ARGUMENT-VALUE'), false, 'the listing must not carry it');
});

test('[defect] the installed listing does not hand out a token that is part of a url', async () => {
  seedProfile('desktop');
  const meta = writeBundle(bundleDir(), { txid: 'tx-mine' });
  meta.url = 'https://example.test/mcp?token=SECRET-URL-TOKEN';
  writeFileSync(join(bundleDir(), 'market.meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  const routes = makeCtx();

  const listed = await call(routes, host.MARKET_INSTALLED_PATH, {});

  assert.equal(JSON.stringify(listed.body).includes('SECRET-URL-TOKEN'), false);
});

test('[defect] the install response does not hand out a digest it has no use for', async () => {
  mkdirSync(dirname(market.CACHE_PATH), { recursive: true });
  writeFileSync(market.CACHE_PATH, JSON.stringify({
    cacheVersion: market.CACHE_VERSION, fetchedAt: new Date().toISOString(), count: 1,
    servers: [{ name: ENTRY, title: 'Vendor Notes', description: 'one entry', version: '1.0.0', publishedAt: '2026-01-01T00:00:00Z', remotes: [], packages: [{ registryType: 'npm', identifier: '@example/notes', version: '1.0.0', transport: 'stdio', environmentVariables: [], packageArguments: [] }] }],
  }), 'utf8');
  market.resetCatalog();
  const routes = makeCtx();
  const done = await call(routes, host.MARKET_INSTALL_PATH, { name: ENTRY, optionIndex: 0, config: {} });

  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(JSON.stringify(done.body).includes('renderDigest'), false);
});

test('[contract] accept finishes a publish whose running configuration agrees', async () => {
  seedUpdate();
  const routes = makeCtx();

  const done = await repair(routes, { slug, action: 'accept', txid: 'tx-mine' });

  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.value.verified, true);
  assert.equal(done.body.value.live, true);
  assert.equal(existsSync(journalPath()), false, 'and the transaction is finished');
});

test('[contract] a changed command, different arguments and reordered arguments all refuse', async () => {
  const cases = [
    ['command', rowWith({ command: 'nodejs' })],
    ['argument content', rowWith({ args: [join(bundleDir(), 'server.js'), '--extra'] })],
    ['argument order', rowWith({ args: ['--extra', join(bundleDir(), 'server.js')] })],
  ];
  for (const [what, row] of cases) {
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    seedUpdate();
    const routes = makeCtx({ row });
    const before = fingerprint(home);

    const refused = await repair(routes, { slug, action: 'accept', txid: 'tx-mine' });

    assert.equal(refused.status, 409, what + ': ' + JSON.stringify(refused.body));
    assert.equal(refused.body.value.verified, false, what);
    assert.deepEqual(changedKeys(before, fingerprint(home)), [], what + ' must not touch anything');
    assert.equal(existsSync(journalPath()), true, what);
  }
});

test('[contract] the same values in the other namespace refuse', async () => {
  seedUpdate();
  const routes = makeCtx({ row: rowWith({ transport: 'streamable-http', env: null, headers: { API_KEY } }) });

  const refused = await repair(routes, { slug, action: 'accept', txid: 'tx-mine' });

  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.value.verified, false);
});

test('[contract] damaged or unsupported version 2 evidence is refused, and named', async () => {
  for (const [evidence, expected] of [['damaged', /damaged/i], ['unsupported', /version/i]]) {
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    seedUpdate({ published: { evidence } });
    const routes = makeCtx();

    const refused = await repair(routes, { slug, action: 'accept', txid: 'tx-mine' });

    assert.equal(refused.status, 409, evidence + ': ' + JSON.stringify(refused.body));
    assert.equal(expected.test(JSON.stringify(refused.body.error)), true, evidence + ': ' + JSON.stringify(refused.body.error).slice(0, 220));
  }
});

test('[contract] an update rollback is refused when neither version has usable version 2 evidence', async () => {
  seedUpdate({ published: { evidence: 'v1-only' }, backup: { evidence: 'v1-only' } });
  const routes = makeCtx();
  const before = fingerprint(home);

  const refused = await repair(routes, { slug, action: 'rollback', txid: 'tx-mine' });

  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.reasons.some((reason) => /version 2 configuration evidence/i.test(reason)), true, JSON.stringify(refused.body.error.reasons));
  assert.deepEqual(changedKeys(before, fingerprint(home)), []);
  assert.deepEqual(listing(), FILES);
});

test('[contract] a missing running row is not a pending restart: the restart has to be recorded', async () => {
  seedUpdate();
  const routes = makeCtx({ row: null });

  const refused = await repair(routes, { slug, action: 'accept', txid: 'tx-mine' });

  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.value.verified, false);
  assert.equal(refused.body.value.live, false);
  assert.equal(refused.body.value.pendingRestart, false, 'an absence is not evidence of a restart');
  assert.equal(existsSync(journalPath()), true);
});

test('[contract] a first-install rollback still runs on ownership, not on configuration evidence', async () => {
  seedProfile('desktop');
  writeBundle(bundleDir(), { txid: 'tx-mine', tag: 'v2', evidence: 'none' });
  writeJournal({ txid: 'tx-mine', phase: 'PUBLISHED' });
  const routes = makeCtx({ installed: false });

  const done = await repair(routes, { slug, action: 'rollback', txid: 'tx-mine' });

  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.value.outcome, 'rolled-back');
  assert.equal(existsSync(bundleDir()), false);
  assert.equal(existsSync(journalPath()), false);
});

test('[contract] discarding an unpublished staging run is not blocked by configuration evidence', async () => {
  seedProfile('desktop');
  writeBundle(stagingDir('tx-next'), { txid: 'tx-next', tag: 'v2', evidence: 'none' });
  writeJournal({ txid: 'tx-next', phase: 'STAGED' });
  const routes = makeCtx();

  const done = await repair(routes, { slug, action: 'discard-staging', txid: 'tx-next' });

  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(existsSync(stagingDir('tx-next')), false);
});

test('[contract] retry-recovery inherits the rollback conditions instead of relaxing them', async () => {
  seedUpdate({ published: { evidence: 'v1-only' }, backup: { evidence: 'v1-only' } });
  writeJournal({ txid: 'tx-mine', phase: 'NEEDS_ATTENTION' });
  const routes = makeCtx();

  const refused = await repair(routes, { slug, action: 'retry-recovery', txid: 'tx-mine' });

  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, 'repair-refused');
  assert.deepEqual(listing(), FILES, 'nothing was moved');
});

test('[contract] a live rollback still works when the version 2 evidence agrees', async () => {
  seedUpdate();
  const routes = makeCtx();

  const done = await repair(routes, { slug, action: 'rollback', txid: 'tx-mine' });

  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.value.outcome, 'rolled-back');
  assert.equal(readFileSync(join(bundleDir(), 'cordis.patch.yml'), 'utf8'), PATCH('v1'));
  assert.equal(existsSync(journalPath()), false);
});

test('[contract] the listing keeps the fields a person needs, and none of the digests', async () => {
  seedProfile('desktop');
  writeBundle(bundleDir(), { txid: 'tx-mine' });
  const routes = makeCtx();

  const listed = await call(routes, host.MARKET_INSTALLED_PATH, {});
  const item = (listed.body.value.items || []).find((entry) => entry.slug === slug);

  assert.equal(item !== undefined, true);
  for (const field of ['slug', 'pkg', 'rowId', 'serverName', 'kind', 'transport', 'command', 'configKeys']) {
    assert.equal(item[field] !== undefined, true, 'the listing still carries ' + field);
  }
  const text = JSON.stringify(item);
  for (const field of ['argumentValues', 'renderDigest', 'contentDigest', 'configDigest', 'configDigestV2', 'args', 'url']) {
    assert.equal(text.includes(field), false, 'and never ' + field + ': ' + text.slice(0, 240));
  }
});
