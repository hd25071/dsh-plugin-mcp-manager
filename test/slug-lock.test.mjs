// One slug, one operation at a time — across requests, and across profiles.
//
// Every profile under this HOME links to the SAME physical bundle directory
// (\`MARKET_ROOT\` is keyed by HOME, not by profile), so two operations that touch one slug are two
// writers on one directory. DSH's own \`withFileLock\` covers the profile's \`package.json\` only; it
// says nothing about the bundle files this plugin writes, and nothing about a second profile.
//
// These tests assert what reached the installer and what is on disk, not just the status code.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'mcpm-lock-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const host = await import('../index.js');
const market = await import('../market.js');

const PROFILES = join(home, '.dsh', 'profiles');
const A = 'vendor.example/alpha';
const B = 'vendor.example/beta';

beforeEach(() => {
  rmSync(market.MARKET_ROOT, { recursive: true, force: true });
  rmSync(market.CACHE_DIR, { recursive: true, force: true });
  rmSync(PROFILES, { recursive: true, force: true });
  market.resetCatalog();
});

const slugOf = (name) => market.slugFor(name);
const rowIdOf = (name) => market.rowIdForSlug(slugOf(name));
const bundleOf = (name) => market.bundleDir(slugOf(name));
const lockOf = (name) => join(market.MARKET_ROOT, '.locks', slugOf(name) + '.lock');
const profileLinkOf = (profile, name) => join(PROFILES, profile, 'node_modules', market.BUNDLE_SCOPE, slugOf(name));

function seedCache() {
  mkdirSync(dirname(market.CACHE_PATH), { recursive: true });
  const entry = (name) => ({
    name, title: name, description: 'an entry', version: '1.0.0',
    publishedAt: '2026-01-01T00:00:00Z', remotes: [],
    packages: [{
      registryType: 'npm', identifier: '@example/' + slugOf(name), version: '1.0.0', transport: 'stdio',
      environmentVariables: [], packageArguments: [],
    }],
  });
  writeFileSync(market.CACHE_PATH, JSON.stringify({
    cacheVersion: market.CACHE_VERSION, fetchedAt: new Date().toISOString(), count: 2,
    servers: [entry(A), entry(B)],
  }));
  market.resetCatalog();
}

/** A bundle on disk with a row live in the profile, i.e. the shape an update starts from. */
function seedInstalled(name) {
  const dir = bundleOf(name);
  mkdirSync(dir, { recursive: true });
  const patch = '# installed bundle\n- insert:\n    - id: ' + rowIdOf(name) + '\n      name: \'@deepseek-ai/dsh-mcp-client\'\n        serverName: "x"\n';
  writeFileSync(join(dir, 'cordis.patch.yml'), patch, 'utf8');
  writeFileSync(join(dir, 'market.meta.json'), JSON.stringify({
    registryName: name, registryVersion: '1.0.0', slug: slugOf(name), pkg: market.BUNDLE_PREFIX + slugOf(name),
    rowId: rowIdOf(name), serverName: 'x', kind: 'stdio', source: 'registry', configKeys: [], argumentValues: {},
  }), 'utf8');
  return patch;
}

/**
 * A gate the fake installer waits on, so one request can be held inside the operation.
 *
 * `limit` is how many waiters it tolerates before letting everyone through. That is not a timeout:
 * with no lock the second request also reaches the installer, and a wait that never ended would
 * hang the suite instead of failing it. One waiter is the expectation; the second means a lock is
 * missing, so the gate opens and the assertion gets to speak.
 */
function gate(limit = 1) {
  let open;
  let waiting = 0;
  const promise = new Promise((resolve) => { open = resolve; });
  return {
    promise,
    arrive() {
      waiting += 1;
      if (waiting > limit) open();
    },
    open,
  };
}

/**
 * A profile whose state follows what is on disk.
 *
 * A bundle that exists with its manifest is a bundle the profile has installed and loaded — which
 * is what the fake installer makes true, and what \`seedInstalled\` sets up for the update cases.
 * An always-empty listing would trip P2-3A's verification instead of testing the lock.
 */
function makeCtx({ hold = null } = {}) {
  const routes = new Map();
  const calls = { install: [], remove: [] };
  const known = () => [slugOf(A), slugOf(B)].filter((slug) => existsSync(join(market.MARKET_ROOT, slug, 'market.meta.json')));
  const ctx = {
    get(key) {
      if (key === 'connection') return { fetch: { register(spec) { routes.set(spec.path, spec); } } };
      if (key === 'pluginManager') return {
        async installBundle(dir, options) {
          calls.install.push({ dir, options });
          // `hold` is either a promise or a function of the directory, so one case can keep exactly
          // one slug waiting: a shared gate would deadlock the test that checks two slugs run at once.
          const wait = typeof hold === 'function' ? hold(dir) : hold;
          if (wait !== null && wait !== undefined) {
            wait.arrive();
            await wait.promise;
          }
          return { application: 'applied' };
        },
        async removeBundle(name) {
          calls.remove.push(name);
          for (const slug of known()) if (market.BUNDLE_PREFIX + slug === name) rmSync(join(market.MARKET_ROOT, slug), { recursive: true, force: true });
          return { application: 'applied' };
        },
        listBundles() {
          return known().map((slug) => ({
            name: market.BUNDLE_PREFIX + slug, installed: true, enabled: true, removable: true,
            rows: [{ rowId: market.ROW_PREFIX + slug, moduleName: host.MCP_MODULE }],
          }));
        },
      };
      if (key === 'configEditor') {
        return {
          configuration() {
            return known().map((slug) => ({
              entry: { options: { id: market.ROW_PREFIX + slug, name: host.MCP_MODULE } },
              inherited: {}, override: { transport: 'stdio', serverName: 'x' },
            }));
          },
        };
      }
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
const install = (routes, name, extra = {}) => call(routes, host.MARKET_INSTALL_PATH, { name, optionIndex: 0, config: {}, ...extra });
const uninstall = (routes, name) => call(routes, host.MARKET_UNINSTALL_PATH, { slug: slugOf(name) });

/** Let the held request reach the point where it is waiting inside the installer. */
const settle = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

const writeLock = (name, record) => {
  mkdirSync(dirname(lockOf(name)), { recursive: true });
  writeFileSync(lockOf(name), typeof record === 'string' ? record : JSON.stringify(record), 'utf8');
};

// --- one slug, one operation -------------------------------------------------------------------

test('two concurrent installs of one slug: exactly one runs, the other is refused', async () => {
  seedCache();
  const held = gate();
  const { routes, calls } = makeCtx({ hold: held });
  const first = install(routes, A);
  await settle();
  const second = await install(routes, A);

  assert.equal(second.status, 409, 'the second install must not start while the first holds the slug');
  assert.equal(second.body.error.code, 'install-in-progress');
  assert.equal(calls.install.length, 1, 'only the first request may reach the installer');

  held.open();
  const firstResult = await first;
  assert.equal(firstResult.status, 200);
  assert.equal(calls.install.length, 1);
  assert.equal(existsSync(join(bundleOf(A), 'cordis.patch.yml')), true);
});

test('an uninstall cannot run while an install holds the slug', async () => {
  seedCache();
  const held = gate();
  const { routes, calls } = makeCtx({ hold: held });
  const installing = install(routes, A);
  await settle();
  const removing = await uninstall(routes, A);

  assert.equal(removing.status, 409);
  assert.equal(removing.body.error.code, 'install-in-progress');
  assert.deepEqual(calls.remove, [], 'nothing may be uninstalled while the slug is held');

  held.open();
  await installing;
  assert.equal(existsSync(join(bundleOf(A), 'cordis.patch.yml')), true, 'the bundle the install wrote is still there');
});

test('two different slugs do not block each other', async () => {
  seedCache();
  const held = gate();
  // Only the slow slug waits here, so the case measures the locks rather than the gate.
  const { routes, calls } = makeCtx({ hold: (dir) => (dir === bundleOf(A) ? held : null) });
  const slow = install(routes, A);
  await settle();
  const other = await install(routes, B);

  assert.equal(other.status, 200, 'a different slug is a different lock');
  assert.equal(calls.install.length, 2);
  assert.equal(existsSync(join(bundleOf(B), 'cordis.patch.yml')), true);

  held.open();
  assert.equal((await slow).status, 200);
});

test('the lock is released after a refused install, so the next one runs', async () => {
  seedCache();
  const { routes, calls } = makeCtx({});
  writeLock(A, { schema: 1, slug: slugOf(A), op: 'install', txid: 'someone-else', pid: 4, profile: 'desktop', at: new Date().toISOString() });
  const refused = await install(routes, A);
  assert.equal(refused.status, 409);
  assert.equal(calls.install.length, 0);
  assert.equal(existsSync(bundleOf(A)), false, 'a refused install writes nothing');

  rmSync(lockOf(A), { force: true });
  assert.equal((await install(routes, A)).status, 200, 'the refusal did not leave this process holding the slug');
});

// --- what a lock file may and may not cause ----------------------------------------------------

test('a lock held by a live holder is refused, and the lock file is left alone', async () => {
  seedCache();
  const { routes, calls } = makeCtx({});
  writeLock(A, { schema: 1, slug: slugOf(A), op: 'install', txid: 'live-holder', pid: process.pid, profile: 'desktop', at: new Date().toISOString() });
  const refused = await install(routes, A);

  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'install-in-progress');
  assert.equal(calls.install.length, 0);
  assert.equal(existsSync(lockOf(A)), true, 'the holder\'s lock is not ours to delete');
  assert.equal(existsSync(bundleOf(A)), false);
});

test('a corrupt lock file fails closed and is not deleted', async () => {
  seedCache();
  const { routes, calls } = makeCtx({});
  writeLock(A, 'this is not JSON');
  const refused = await install(routes, A);

  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'install-locked');
  assert.match(refused.body.error.message, /holder|could not|JSON/i);
  assert.equal(calls.install.length, 0);
  assert.equal(existsSync(lockOf(A)), true, 'an unreadable lock is never removed on a guess');
  assert.equal(readFileSync(lockOf(A), 'utf8'), 'this is not JSON');
});

test('a lock left by a dead process is reported, not taken over', async () => {
  seedCache();
  const { routes, calls } = makeCtx({});
  // A real pid that has certainly exited: take one from a process that has just finished.
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  writeLock(A, { schema: 1, slug: slugOf(A), op: 'install', txid: 'left-behind', pid: dead, profile: 'desktop', at: new Date().toISOString() });
  const refused = await install(routes, A);

  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'install-in-progress');
  assert.equal(refused.body.error.holderAlive, false, 'the caller is told the holder is gone');
  assert.equal(calls.install.length, 0);
  assert.equal(existsSync(lockOf(A)), true, 'age or a dead pid is not proof enough to delete a lock');
});

test('releasing a lock that is no longer ours deletes nothing', async () => {
  seedCache();
  mkdirSync(join(market.MARKET_ROOT, '.locks'), { recursive: true });
  const path = lockOf(A);
  writeFileSync(path, JSON.stringify({ schema: 1, slug: slugOf(A), op: 'install', txid: 'mine', pid: process.pid, profile: '', at: new Date().toISOString() }), 'utf8');
  const foreign = market.releaseSlugLock({ path, txid: 'not-mine' });

  assert.equal(foreign.ok, false);
  assert.match(foreign.reason, /mine/);
  assert.equal(existsSync(path), true, 'a lock owned by another transaction is left where it is');

  const mine = market.releaseSlugLock({ path, txid: 'mine' });
  assert.equal(mine.ok, true);
  assert.equal(existsSync(path), false);
});

test('a lock path that is a name, not a slug, is refused before any path is built', () => {
  for (const slug of ['../../../etc/passwd', 'a/b', '', 'A', '.hidden', 'x\\y']) {
    const held = market.acquireOperationLock({ slug, op: 'install' });
    assert.equal(held.ok, false, JSON.stringify(slug) + ' must not become a lock path');
    assert.equal(held.code, 'install-locked');
  }
});

// --- a second profile that uses the same physical bundle ----------------------------------------

const linkProfile = (profile, name, target) => {
  const link = profileLinkOf(profile, name);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link, 'junction');
  return link;
};

test('an update is refused when another profile also uses this bundle', async () => {
  seedCache();
  const patch = seedInstalled(A);
  const { routes, calls } = makeCtx({});
  linkProfile('desktop', A, bundleOf(A));
  linkProfile('laptop', A, bundleOf(A));

  const refused = await install(routes, A);
  assert.equal(refused.status, 409, 'rewriting the content another profile loads is not this request\'s to do');
  assert.equal(refused.body.error.code, 'shared-bundle');
  assert.deepEqual(refused.body.error.sharedWith.map((item) => item.profile).sort(), ['desktop', 'laptop']);
  assert.equal(calls.install.length, 0, 'nothing may be installed while the bundle is shared');
  assert.equal(readFileSync(join(bundleOf(A), 'cordis.patch.yml'), 'utf8'), patch, 'the shared content is untouched');
});

test('the only profile using the bundle is the one installing, so the update runs', async () => {
  seedCache();
  seedInstalled(A);
  const { routes, calls } = makeCtx({});
  linkProfile('desktop', A, bundleOf(A));

  const installed = await install(routes, A);
  assert.equal(installed.status, 200, 'a single reference is this profile\'s own');
  assert.equal(calls.install.length, 1);
});

test('a link to some other directory is not a reference to this bundle', async () => {
  seedCache();
  const patch = seedInstalled(A);
  const elsewhere = join(home, 'somewhere-else');
  mkdirSync(elsewhere, { recursive: true });
  const { routes, calls } = makeCtx({});
  linkProfile('desktop', A, bundleOf(A));
  linkProfile('laptop', A, elsewhere);

  const installed = await install(routes, A);
  assert.equal(installed.status, 200, 'the targets are compared by real path, not by name or by string');
  assert.equal(calls.install.length, 1);
  assert.notEqual(readFileSync(join(bundleOf(A), 'cordis.patch.yml'), 'utf8'), patch, 'the update really did replace it');
});

test('a profiles directory that cannot be read fails closed', async () => {
  seedCache();
  const patch = seedInstalled(A);
  const { routes, calls } = makeCtx({});
  // A file where the profile directory should be: the references cannot be enumerated at all.
  mkdirSync(join(home, '.dsh'), { recursive: true });
  writeFileSync(PROFILES, 'not a directory', 'utf8');

  const refused = await install(routes, A);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'shared-bundle-unknown');
  assert.equal(calls.install.length, 0, 'an unreadable profile set is not an empty one');
  assert.equal(readFileSync(join(bundleOf(A), 'cordis.patch.yml'), 'utf8'), patch);
});

test('a dangling link is residue, not a live reference', async () => {
  seedCache();
  seedInstalled(A);
  const { routes, calls } = makeCtx({});
  linkProfile('desktop', A, bundleOf(A));
  const gone = join(home, 'deleted-target');
  mkdirSync(gone, { recursive: true });
  const dangling = linkProfile('laptop', A, gone);
  rmSync(gone, { recursive: true, force: true });

  const installed = await install(routes, A);
  assert.equal(installed.status, 200);
  assert.equal(calls.install.length, 1);
  // The link entry itself is what has to still be there: `existsSync` follows the link and would
  // report the vanished target, while this check only reads.
  assert.equal(lstatSync(dangling).isSymbolicLink(), true, 'residue is left alone; this check only reads');
});
