// The restart requirement: a thing an operation records, never a thing an absence implies.
//
// A successful install can leave the running process without the configuration it just persisted —
// the installer says restart-required and the change waits for a reload. That answer belongs to the
// operation that received it, so it is written down with the transaction, the profile and the row it
// was about, and a later recovery reads it instead of inferring it from a row that is not there.
//
// [contract] this round adds that evidence chain; nothing here is a regression of shipped behaviour,
//            because until now the answer was simply not recorded.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'mcpm-restart-'));
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

function seedCache() {
  mkdirSync(dirname(market.CACHE_PATH), { recursive: true });
  writeFileSync(market.CACHE_PATH, JSON.stringify({
    cacheVersion: market.CACHE_VERSION, fetchedAt: new Date().toISOString(), count: 1,
    servers: [{ name: ENTRY, title: 'Vendor Notes', description: 'one entry', version: '1.0.0', publishedAt: '2026-01-01T00:00:00Z', remotes: [], packages: [{ registryType: 'npm', identifier: '@example/notes', version: '1.0.0', transport: 'stdio', environmentVariables: [], packageArguments: [] }] }],
  }), 'utf8');
  market.resetCatalog();
}

function seedProfile(name, { declares = true } = {}) {
  const dir = join(PROFILES, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-' + name, dependencies: {}, dsh: { profile: { bundles: declares ? [pkg] : [] } } }, null, 2), 'utf8');
  return dir;
}

/** The running configuration the profile reports, as a row. */
function rowFor(options = {}) {
  // The running row is what the plugin rendered, so it is read back from the published manifest
  // rather than guessed: a fixture that invents a command line is testing its own invention.
  const written = existsSync(manifestPath()) ? manifest() : null;
  const { command = written === null ? 'node' : written.command, args = written === null ? [] : written.args || [], values = {}, transport = 'stdio' } = options;
  return {
    transport, serverName: 'notes', command, args,
    env: transport === 'streamable-http' ? null : values,
    headers: transport === 'streamable-http' ? values : null,
  };
}

function makeCtx(options = {}) {
  const profile = options.profile || 'desktop';
  seedProfile(profile);
  const routes = new Map();
  const row = options.row === undefined ? rowFor() : options.row;
  const ctx = {
    get(key) {
      if (key === 'connection') return { fetch: { register(spec) { routes.set(spec.path, spec); } } };
      if (key === 'profileContext') return { name: profile, dir: join(PROFILES, profile) };
      if (key === 'pluginManager') {
        return {
          async installBundle() { return options.installResult === undefined ? { application: 'applied' } : options.installResult; },
          async removeBundle() { return { application: 'applied' }; },
          listBundles() {
            return [{ name: pkg, installed: true, enabled: true, removable: true, rows: [{ rowId, moduleName: host.MCP_MODULE }] }];
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

/** Install through the real route, with the running row deliberately absent. */
async function install(options = {}) {
  seedCache();
  const routes = makeCtx({ row: null, ...options });
  const done = await call(routes, host.MARKET_INSTALL_PATH, { name: ENTRY, optionIndex: 0, config: {} });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return { routes, done, txid: done.body.value.txid };
}

/** Put the published version back into the unfinished state a recovery would find it in. */
/** Leave the published version in the unfinished state a recovery would find it in. */
function leavePublished(txid) {
  mkdirSync(slugRoot(), { recursive: true });
  writeFileSync(journalPath(), JSON.stringify({
    schema: 1, txid, slug, operation: 'install', phase: 'PUBLISHED', intent: 'test',
    expected: { rowId, serverName: 'notes' },
  }, null, 2), 'utf8');
  return txid;
}

const accept = (routes, txid) => call(routes, host.MARKET_REPAIR_PATH, { slug, action: 'accept', txid });

// --- the evidence the install records -------------------------------------------------------------

test('[contract] an install that needs a restart records the installer\'s own answer', async () => {
  await install({ installResult: { application: 'restart-required' } });

  const written = manifest();
  assert.equal(typeof written.published, 'object', 'the answer is written down: ' + JSON.stringify(written.published));
  assert.equal(written.published.application, 'restart-required');
  assert.equal(written.published.profile, 'desktop');
  assert.equal(written.published.rowId, rowId);
  assert.equal(written.published.txid, manifest().txid, 'bound to the transaction that received it');
  assert.equal(typeof written.published.at, 'string');
});

test('[contract] the evidence the install records survives the journal being cleared', async () => {
  await install({ installResult: { application: 'restart-required' } });
  assert.equal(existsSync(journalPath()), false, 'a finished install keeps no journal');
  assert.equal(manifest().published.application, 'restart-required', 'and the evidence is still readable');
});

// --- what recovery may conclude from it ------------------------------------------------------------

test('[contract] the recorded answer is what makes a pending restart a claim that can be made', async () => {
  const { routes, txid } = await install({ installResult: { application: 'restart-required' } });
  leavePublished(txid);

  const done = await accept(routes);

  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.value.pendingRestart, true);
  assert.equal(done.body.value.verified, true, 'the persisted state was verified');
  assert.equal(done.body.value.live, false, 'persisted and running are not the same claim');
  assert.equal(Array.isArray(done.body.value.restartEvidence), true);
  assert.equal(done.body.value.restartEvidence.length >= 3, true, JSON.stringify(done.body.value.restartEvidence));
  assert.equal(existsSync(journalPath()), false, 'and the transaction is finished');
});

test('[contract] applied, failed, cancelled, overridden and an unknown word are never a restart', async () => {
  for (const application of ['applied', 'failed', 'cancelled', 'overridden', 'something-new']) {
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    const { routes, txid } = await install({ installResult: { application: 'restart-required' } });
    leavePublished(txid);
    const meta = manifest();
    meta.published = { ...meta.published, application };
    writeFileSync(manifestPath(), JSON.stringify(meta, null, 2), 'utf8');

    const refused = await accept(routes);

    assert.equal(refused.status, 409, application + ': ' + JSON.stringify(refused.body));
    assert.equal(refused.body.value.pendingRestart, false, application);
    assert.equal(refused.body.value.verified, false, application);
    assert.equal(refused.body.value.live, false, application);
    assert.equal(existsSync(journalPath()), true, application + ' leaves the transaction for a person');
  }
});

test('[contract] evidence from another transaction, profile or version proves nothing here', async () => {
  const cases = [
    ['another transaction', (meta) => { meta.published = { ...meta.published, txid: 'tx-other' }; }],
    ['another profile', (meta) => { meta.published = { ...meta.published, profile: 'somewhere-else' }; }],
    ['another bundle version', (meta) => { meta.published = { ...meta.published, rowId: 'mcp-something-else' }; }],
    ['no evidence at all', (meta) => { delete meta.published; }],
  ];
  for (const [what, mutate] of cases) {
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    const { routes, txid } = await install({ installResult: { application: 'restart-required' } });
    leavePublished(txid);
    const meta = manifest();
    mutate(meta);
    writeFileSync(manifestPath(), JSON.stringify(meta, null, 2), 'utf8');

    const refused = await accept(routes);

    assert.equal(refused.status, 409, what + ': ' + JSON.stringify(refused.body));
    assert.equal(refused.body.value.pendingRestart, false, what);
    assert.equal(refused.body.value.verified, false, what);
  }
});

test('[contract] a newer installation replaces the evidence instead of inheriting it', async () => {
  const first = await install({ installResult: { application: 'restart-required' } });
  assert.equal(manifest().published.application, 'restart-required');
  // The same slug is installed again, and this time the installer applied it: the older restart
  // requirement belonged to the older transaction and must not travel to the new one.
  const second = makeCtx({ row: null, installResult: { application: 'applied' } });
  const again = await call(second, host.MARKET_INSTALL_PATH, { name: ENTRY, optionIndex: 0, config: {} });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(manifest().published.application, 'applied');
  assert.equal(manifest().published.txid, again.body.value.txid);
  leavePublished(again.body.value.txid);

  const refused = await accept(second, again.body.value.txid);

  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.value.pendingRestart, false, 'the older answer is not this transaction\'s');
  assert.equal(first.routes !== undefined, true);
});

test('[contract] once the running configuration matches, the answer is live and not a pending restart', async () => {
  const installed = await install({ installResult: { application: 'restart-required' } });
  leavePublished(installed.txid);
  const routes = makeCtx({ row: rowFor() });

  const done = await accept(routes, installed.txid);

  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.value.live, true);
  assert.equal(done.body.value.pendingRestart, false);
  assert.equal(existsSync(journalPath()), false);
});

test('[contract] older evidence cannot bypass the version 2 requirement', async () => {
  const { routes, txid } = await install({ installResult: { application: 'restart-required' } });
  leavePublished(txid);
  const meta = manifest();
  delete meta.configDigestV2;
  delete meta.configDigestVersion;
  delete meta.configNamespace;
  meta.configDigest = tx.configDigestOf({});
  writeFileSync(manifestPath(), JSON.stringify(meta, null, 2), 'utf8');

  const refused = await accept(routes);

  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.value.pendingRestart, false, 'a restart claim still needs the configuration to be provable');
  assert.equal(refused.body.value.verified, false);
});

// --- and what must not happen ---------------------------------------------------------------------

test('[contract] reading the state never writes evidence in order to complete itself', async () => {
  const installed = await install({ installResult: { application: 'restart-required' } });
  leavePublished(installed.txid);
  const routes = makeCtx({ row: null });
  const before = fingerprint(home);

  await call(routes, host.MARKET_INSTALLED_PATH, {});
  await call(routes, host.MARKET_REPAIR_PATH, { slug, action: 'accept', txid: installed.txid, dryRun: true });

  // A dry run and a listing are reads: whatever they conclude, they leave the disk alone. (The one
  // documented exception is the slug lock a real repair takes, which is why it is filtered above.)
  const diff = changedKeys(before, fingerprint(home));
  assert.deepEqual(diff.filter((key) => !key.startsWith('.dsh/mcp-servers/.locks')), []);
});

test('[contract] neither the answer nor the listing carries a digest or a configured value', async () => {
  const { routes, txid } = await install({ installResult: { application: 'restart-required' } });
  leavePublished(txid);
  const accepted = await accept(routes);
  const listed = await call(routes, host.MARKET_INSTALLED_PATH, {});
  const text = JSON.stringify(accepted.body) + JSON.stringify(listed.body);

  for (const field of ['configDigest', 'contentDigest', 'renderDigest', 'argumentValues']) {
    assert.equal(text.includes(field), false, 'no ' + field + ' in a response');
  }
});
