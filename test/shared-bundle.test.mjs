// Who else is using this bundle, and is the profile asking really the one it belongs to?
//
// MARKET_ROOT is keyed by HOME, so a bundle written for one profile can be the bundle another
// profile loads. Two things have to be true before an update or an uninstall may touch it:
//
// 1. the other users have to be known — the profile manifests are the evidence, because that is
//    what DSH itself reads (\\\`pluginManager.listBundles\\\` composes \\\`dsh.profile.bundles\\\` with the
//    profile's dependencies); a physical link that points at this directory counts too, because
//    that profile is reading the same bytes whatever its manifest says;
// 2. the asking profile has to be identifiable, so that \\\`one reference\\\` is not silently read as
//    \\\`my reference\\\`. That identity comes from the DSH host's \\\`profileContext\\\`, which carries the
//    profile's name and directory.
//
// Every case below checks the installer's call count and the bytes on disk, not just the status.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'mcpm-shared-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const host = await import('../index.js');
const market = await import('../market.js');

const PROFILES = join(home, '.dsh', 'profiles');
const ENTRY = 'vendor.example/notes';
const slug = () => market.slugFor(ENTRY);
const pkg = () => market.BUNDLE_PREFIX + slug();
const bundleDir = () => market.bundleDir(slug());
const rowId = () => market.rowIdForSlug(slug());

beforeEach(() => {
  rmSync(market.MARKET_ROOT, { recursive: true, force: true });
  rmSync(market.CACHE_DIR, { recursive: true, force: true });
  rmSync(PROFILES, { recursive: true, force: true });
  market.resetCatalog();
});

function seedCache() {
  mkdirSync(dirname(market.CACHE_PATH), { recursive: true });
  writeFileSync(market.CACHE_PATH, JSON.stringify({
    cacheVersion: market.CACHE_VERSION, fetchedAt: new Date().toISOString(), count: 1,
    servers: [{
      name: ENTRY, title: 'Vendor Notes', description: 'one entry', version: '1.0.0',
      publishedAt: '2026-01-01T00:00:00Z', remotes: [],
      packages: [{
        registryType: 'npm', identifier: '@example/notes', version: '1.0.0', transport: 'stdio',
        environmentVariables: [], packageArguments: [],
      }],
    }],
  }));
  market.resetCatalog();
}

/** A bundle on disk with a row live in the running profile. */
const PATCH = '# installed bundle\n- insert:\n    - id: mcp-x\n      name: \'@deepseek-ai/dsh-mcp-client\'\n';
function seedBundle() {
  mkdirSync(bundleDir(), { recursive: true });
  writeFileSync(join(bundleDir(), 'cordis.patch.yml'), PATCH, 'utf8');
  writeFileSync(join(bundleDir(), 'market.meta.json'), JSON.stringify({
    registryName: ENTRY, registryVersion: '1.0.0', slug: slug(), pkg: pkg(),
    rowId: rowId(), serverName: 'notes', kind: 'stdio', source: 'registry', configKeys: [], argumentValues: {},
  }), 'utf8');
}

/** A profile directory that declares this bundle, the way DSH reads it. */
function profileDeclaring(name, { declare = true, link = false } = {}) {
  const dir = join(PROFILES, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-' + name,
    dependencies: declare ? { [pkg()]: '1.0.0' } : {},
    dsh: { profile: { bundles: declare ? [pkg()] : [] } },
  }), 'utf8');
  if (link) {
    const target = join(dir, 'node_modules', market.BUNDLE_SCOPE, slug());
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(bundleDir(), target, 'junction');
  }
  return dir;
}

/** A profile directory that is on disk but says nothing about this bundle. */
function profileSilent(name) {
  const dir = join(PROFILES, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-' + name, dependencies: {}, dsh: { profile: { bundles: [] } } }), 'utf8');
  return dir;
}

function makeCtx({ currentProfile = 'alpha' } = {}) {
  const routes = new Map();
  const calls = { install: [], remove: [] };
  const ctx = {
    get(key) {
      if (key === 'connection') return { fetch: { register(spec) { routes.set(spec.path, spec); } } };
      if (key === 'profileContext' && currentProfile !== null) {
        return { name: currentProfile, dir: join(PROFILES, currentProfile), installAnchor: join(home, 'app', 'package.json') };
      }
      if (key === 'pluginManager') return {
        async installBundle(dir, options) { calls.install.push({ dir, options }); return { application: 'applied' }; },
        async removeBundle(name) { calls.remove.push(name); return { application: 'applied' }; },
        listBundles() {
          return existsSync(join(bundleDir(), 'market.meta.json'))
            ? [{ name: pkg(), installed: true, enabled: true, removable: true, rows: [{ rowId: rowId(), moduleName: host.MCP_MODULE }] }]
            : [];
        },
      };
      if (key === 'configEditor') return {
        configuration() {
          return existsSync(join(bundleDir(), 'market.meta.json'))
            ? [{ entry: { options: { id: rowId(), name: host.MCP_MODULE } }, inherited: {}, override: { transport: 'stdio', serverName: 'notes' } }]
            : [];
        },
      };
      return undefined;
    },
  };
  host.apply(ctx);
  return { routes, calls };
}

const post = (payload) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
const call = async (routes, path, payload) => {
  const response = await routes.get(path).fetch(new Request('http://local' + path, post(payload)));
  return { status: response.status, body: await response.json() };
};
const install = (routes) => call(routes, host.MARKET_INSTALL_PATH, { name: ENTRY, optionIndex: 0, config: {} });
const uninstall = (routes) => call(routes, host.MARKET_UNINSTALL_PATH, { slug: slug() });

/** The bundle has to be byte-for-byte what it was, and still there. */
function assertBundleUntouched() {
  assert.equal(existsSync(bundleDir()), true, 'the shared directory must still exist');
  assert.deepEqual(readdirSync(bundleDir()).sort(), ['cordis.patch.yml', 'market.meta.json']);
  assert.equal(readFileSync(join(bundleDir(), 'cordis.patch.yml'), 'utf8'), PATCH, 'the shared content must be byte-identical');
}

// --- the requesting profile is not the one holding the only reference ---------------------------

test('an update is refused when the only reference belongs to another profile', async () => {
  seedCache();
  seedBundle();
  profileSilent('alpha');
  profileDeclaring('beta');
  const { routes, calls } = makeCtx({ currentProfile: 'alpha' });

  const refused = await install(routes);
  assert.equal(refused.status, 409, 'one reference is not automatically this profile\'s');
  assert.equal(refused.body.error.code, 'shared-bundle');
  assert.deepEqual(refused.body.error.sharedWith.map((item) => item.profile), ['beta']);
  assert.equal(calls.install.length, 0);
  assertBundleUntouched();
});

test('two profiles referencing the bundle is never read as one own reference', async () => {
  seedCache();
  seedBundle();
  profileDeclaring('alpha');
  profileDeclaring('beta');
  const { routes, calls } = makeCtx({ currentProfile: 'alpha' });

  const refused = await install(routes);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'shared-bundle');
  assert.deepEqual(refused.body.error.sharedWith.map((item) => item.profile), ['beta']);
  assert.equal(calls.install.length, 0);
  assertBundleUntouched();
});

test('without a current profile identity an update is refused rather than guessed', async () => {
  seedCache();
  seedBundle();
  profileDeclaring('alpha');
  const { routes, calls } = makeCtx({ currentProfile: null });

  const refused = await install(routes);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'shared-bundle-unknown');
  assert.equal(calls.install.length, 0);
  assertBundleUntouched();
});

// --- uninstall ---------------------------------------------------------------------------------

test('an uninstall is refused while another profile still references the bundle', async () => {
  seedCache();
  seedBundle();
  profileDeclaring('alpha');
  profileDeclaring('beta');
  const { routes, calls } = makeCtx({ currentProfile: 'alpha' });

  const refused = await uninstall(routes);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'shared-bundle');
  assert.deepEqual(calls.remove, [], 'a refused uninstall must not touch the profile at all');
  assertBundleUntouched();
});

test('an uninstall is refused when the references cannot be read', async () => {
  seedCache();
  seedBundle();
  mkdirSync(join(home, '.dsh'), { recursive: true });
  writeFileSync(PROFILES, 'not a directory', 'utf8');
  const { routes, calls } = makeCtx({ currentProfile: 'alpha' });

  const refused = await uninstall(routes);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'shared-bundle-unknown');
  assert.deepEqual(calls.remove, []);
  assertBundleUntouched();
});

test('an uninstall is refused without a current profile identity when anyone references it', async () => {
  seedCache();
  seedBundle();
  profileDeclaring('alpha');
  const { routes, calls } = makeCtx({ currentProfile: null });

  const refused = await uninstall(routes);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'shared-bundle-unknown');
  assert.deepEqual(calls.remove, []);
  assertBundleUntouched();
});

// --- the ordinary single-profile cases must still work -----------------------------------------

test('a single profile that owns the bundle can uninstall it', async () => {
  seedCache();
  seedBundle();
  profileDeclaring('alpha');
  const { routes, calls } = makeCtx({ currentProfile: 'alpha' });

  const removed = await uninstall(routes);
  assert.equal(removed.status, 200);
  assert.deepEqual(calls.remove, [pkg()], 'the official removal is the one that runs');
  assert.equal(existsSync(bundleDir()), false, 'and the directory goes only after it');
});

test('a single profile that owns the bundle can update it', async () => {
  seedCache();
  seedBundle();
  profileDeclaring('alpha');
  const { routes, calls } = makeCtx({ currentProfile: 'alpha' });

  const installed = await install(routes);
  assert.equal(installed.status, 200);
  assert.equal(calls.install.length, 1);
  assert.notEqual(readFileSync(join(bundleDir(), 'cordis.patch.yml'), 'utf8'), PATCH, 'the update really wrote');
});

test('a profile that only links the bundle counts as a reference even without declaring it', async () => {
  seedCache();
  seedBundle();
  profileDeclaring('alpha');
  profileDeclaring('beta', { declare: false, link: true });
  const { routes, calls } = makeCtx({ currentProfile: 'alpha' });

  const refused = await uninstall(routes);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'shared-bundle');
  assert.deepEqual(calls.remove, []);
  assertBundleUntouched();
});

test('a silent profile directory is not a reference at all', async () => {
  seedCache();
  seedBundle();
  profileDeclaring('alpha');
  profileSilent('beta');
  profileSilent('gamma');
  const { routes, calls } = makeCtx({ currentProfile: 'alpha' });

  const removed = await uninstall(routes);
  assert.equal(removed.status, 200, 'directories that say nothing about this bundle do not block it');
  assert.deepEqual(calls.remove, [pkg()]);
});
