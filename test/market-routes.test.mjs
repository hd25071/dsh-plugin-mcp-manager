// The market routes, driven through a fake connection service.
//
// The fake pluginManager records install/remove calls, so the install path is asserted
// end to end: generated files on disk, then the sanctioned installer invoked with them.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'mcp-routes-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const host = await import('../index.js');
const market = await import('../market.js');

// Each test starts from an empty market root, so installed-count assertions mean what
// they say instead of depending on the order the tests ran in.
beforeEach(() => {
  rmSync(market.MARKET_ROOT, { recursive: true, force: true });
  rmSync(market.CACHE_DIR, { recursive: true, force: true });
  market.resetCatalog();
});

/** A cache with two entries: one npm, one remote-only. */
function seedCache() {
  mkdirSync(dirname(market.CACHE_PATH), { recursive: true });
  writeFileSync(market.CACHE_PATH, JSON.stringify({
    cacheVersion: market.CACHE_VERSION,
    fetchedAt: new Date().toISOString(),
    count: 2,
    servers: [
      {
        name: 'vendor.example/notes', title: 'Vendor Notes', description: 'npm based', version: '6.3.0',
        publishedAt: '2026-02-02T00:00:00Z', remotes: [],
        packages: [{
          registryType: 'npm', identifier: '@example/notes-mcp', version: '6.3.0', transport: 'stdio',
          environmentVariables: [{ name: 'EXAMPLE_API_KEY', description: 'key', isRequired: true, isSecret: true, default: '' }],
          packageArguments: [],
        }],
      },
      {
        name: 'vendor.example/mcp', title: 'Vendor HTTP', description: 'remote only', version: '1.0.0',
        publishedAt: '2026-01-01T00:00:00Z', packages: [],
        remotes: [{ type: 'streamable-http', url: 'https://vendor.example/mcp', headers: [] }],
      },
      {
        name: 'vendor.example/tree', title: 'Vendor Tree', description: 'needs a directory', version: '1.0.0',
        publishedAt: '2026-03-03T00:00:00Z', remotes: [],
        packages: [{
          registryType: 'npm', identifier: '@example/tree', version: '1.0.0', transport: 'stdio',
          registryBaseUrl: '', runtimeHint: '', environmentVariables: [],
          runtimeArguments: [{ value: '-y' }],
          packageArguments: [{ type: 'named', name: '--out', value: '', description: 'output root', isRequired: true, format: 'filepath' }],
        }],
      },
      {
        name: 'vendor.example/legacy-sse', title: 'Vendor SSE', description: 'sse only', version: '1.0.0',
        publishedAt: '2026-04-04T00:00:00Z', packages: [],
        remotes: [{ type: 'sse', url: 'https://vendor.example/sse', headers: [] }],
      },
    ],
  }));
}

/** A context with a recording connection and a recording plugin manager. */
function makeCtx() {
  const routes = new Map();
  const calls = { install: [], remove: [] };
  const ctx = {
    get(key) {
      if (key === 'connection') return { fetch: { register(spec) { routes.set(spec.path, spec); } } };
      if (key === 'pluginManager') {
        return {
          async installBundle(spec, options) { calls.install.push({ spec, options }); return { exitCode: 0 }; },
          async removeBundle(name) { calls.remove.push(name); return { exitCode: 0 }; },
        };
      }
      return undefined;
    },
  };
  host.apply(ctx);
  return { routes, calls };
}

async function call(routes, path, url, init) {
  const spec = routes.get(path);
  const response = await spec.fetch(new Request('http://local' + url, init));
  return { status: response.status, body: await response.json() };
}

const post = (payload) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

test('the market routes are all registered', () => {
  seedCache();
  const { routes } = makeCtx();
  for (const path of [host.MARKET_PATH, host.MARKET_SEARCH_PATH, host.MARKET_DETAIL_PATH, host.MARKET_INSTALLED_PATH, host.MARKET_REFRESH_PATH, host.MARKET_INSTALL_PATH, host.MARKET_UNINSTALL_PATH]) {
    assert.equal(routes.has(path), true, path + ' must be registered');
  }
  assert.deepEqual(routes.get(host.MARKET_INSTALL_PATH).methods, ['POST']);
  assert.deepEqual(routes.get(host.MARKET_PATH).methods, ['GET', 'HEAD']);
});

test('status, search and detail answer from the cached snapshot', async () => {
  seedCache();
  const { routes } = makeCtx();

  const status = await call(routes, host.MARKET_PATH, host.MARKET_PATH);
  assert.equal(status.status, 200);
  assert.equal(status.body.value.count, 4);
  assert.equal(status.body.value.source, 'cache');

  const search = await call(routes, host.MARKET_SEARCH_PATH, host.MARKET_SEARCH_PATH + '?q=notes');
  assert.equal(search.body.value.total, 1);
  assert.equal(search.body.value.results[0].name, 'vendor.example/notes');

  const detail = await call(routes, host.MARKET_DETAIL_PATH, host.MARKET_DETAIL_PATH + '?name=' + encodeURIComponent('vendor.example/notes'));
  assert.equal(detail.body.value.options.length, 1);
  assert.equal(detail.body.value.options[0].kind, 'stdio');
  assert.equal(detail.body.value.serverName.length > 0, true);

  const missing = await call(routes, host.MARKET_DETAIL_PATH, host.MARKET_DETAIL_PATH + '?name=nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'not-found');
});

test('install writes the bundle and hands it to the official installer', async () => {
  seedCache();
  const { routes, calls } = makeCtx();

  const installed = await call(routes, host.MARKET_INSTALL_PATH, host.MARKET_INSTALL_PATH,
    post({ name: 'vendor.example/notes', optionIndex: 0, config: { EXAMPLE_API_KEY: 'abc123', UNDECLARED: 'dropped' } }));
  assert.equal(installed.status, 200);
  assert.equal(calls.install.length, 1, 'the official installer must be the one that changes the profile');
  assert.equal(calls.install[0].spec, installed.body.value.dir);
  assert.equal(calls.install[0].options.activateNewBundles, true);
  assert.equal(existsSync(join(installed.body.value.dir, 'cordis.patch.yml')), true);

  const patch = readFileSync(join(installed.body.value.dir, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /EXAMPLE_API_KEY: "abc123"/);
  assert.doesNotMatch(patch, /UNDECLARED/, 'a variable the entry never declared must not reach the row');

  const meta = JSON.parse(readFileSync(join(installed.body.value.dir, 'market.meta.json'), 'utf8'));
  assert.deepEqual(meta.configKeys, ['EXAMPLE_API_KEY']);

  // Reinstalling the same entry is an update, not a second copy.
  const again = await call(routes, host.MARKET_INSTALL_PATH, host.MARKET_INSTALL_PATH,
    post({ name: 'vendor.example/notes', optionIndex: 0, config: { EXAMPLE_API_KEY: 'abc123' } }));
  assert.equal(again.body.value.slug, installed.body.value.slug);
  assert.equal(again.body.value.reinstalled, true);
  assert.equal(market.listInstalled().filter((item) => item.registryName === 'vendor.example/notes').length, 1);

  const listed = await call(routes, host.MARKET_INSTALLED_PATH, host.MARKET_INSTALLED_PATH);
  assert.equal(listed.body.value.count, 1);
  assert.equal(listed.body.value.items[0].registryName, 'vendor.example/notes');
  assert.equal(typeof listed.body.value.items[0].state, 'string');
});

test('a required variable with no value is refused before anything is written', async () => {
  seedCache();
  const { routes, calls } = makeCtx();
  const refused = await call(routes, host.MARKET_INSTALL_PATH, host.MARKET_INSTALL_PATH,
    post({ name: 'vendor.example/notes', optionIndex: 0, config: {} }));
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, 'missing-config');
  assert.equal(calls.install.length, 0);
  assert.equal(market.listInstalled().length, 0, 'nothing may be written when the install is refused');
});

test('uninstall removes the bundle first and the directory after', async () => {
  seedCache();
  const { routes, calls } = makeCtx();
  const installed = await call(routes, host.MARKET_INSTALL_PATH, host.MARKET_INSTALL_PATH,
    post({ name: 'vendor.example/mcp', optionIndex: 0, config: {} }));
  const slug = installed.body.value.slug;

  const removed = await call(routes, host.MARKET_UNINSTALL_PATH, host.MARKET_UNINSTALL_PATH, post({ slug }));
  assert.equal(removed.status, 200);
  assert.deepEqual(calls.remove, [market.BUNDLE_PREFIX + slug]);
  assert.equal(existsSync(installed.body.value.dir), false);
  assert.equal(market.listInstalled().length, 0);

  const again = await call(routes, host.MARKET_UNINSTALL_PATH, host.MARKET_UNINSTALL_PATH, post({ slug }));
  assert.equal(again.status, 404);
});

test('without the plugin manager the install routes degrade instead of throwing', async () => {
  seedCache();
  const routes = new Map();
  host.apply({ get(key) { return key === 'connection' ? { fetch: { register(spec) { routes.set(spec.path, spec); } } } : undefined; } });
  const refused = await call(routes, host.MARKET_INSTALL_PATH, host.MARKET_INSTALL_PATH, post({ name: 'vendor.example/notes' }));
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error.code, 'service-unavailable');
});

test('a reinstall keeps the configuration the row already carries', async () => {
  seedCache();
  const routes = new Map();
  const slug = market.slugFor('vendor.example/notes');
  // The editor reports the generated row with the values a user typed last time.
  const ctx = {
    get(key) {
      if (key === 'connection') return { fetch: { register(spec) { routes.set(spec.path, spec); } } };
      if (key === 'pluginManager') {
        return { async installBundle() { return { exitCode: 0 }; }, async removeBundle() { return { exitCode: 0 }; } };
      }
      if (key === 'configEditor') {
        return {
          configuration() {
            return [{
              entry: { options: { id: 'mcp-' + slug, name: '@deepseek-ai/dsh-mcp-client' } },
              inherited: {},
              override: { transport: 'stdio', serverName: 'notes', command: 'node', args: [], env: { EXAMPLE_API_KEY: 'first-secret' } },
            }];
          },
        };
      }
      return undefined;
    },
  };
  host.apply(ctx);

  const first = await call(routes, host.MARKET_INSTALL_PATH, host.MARKET_INSTALL_PATH,
    post({ name: 'vendor.example/notes', config: { EXAMPLE_API_KEY: 'first-secret' } }));
  assert.equal(first.status, 200);

  const again = await call(routes, host.MARKET_INSTALL_PATH, host.MARKET_INSTALL_PATH,
    post({ name: 'vendor.example/notes', config: {} }));
  assert.equal(again.body.value.reinstalled, true);
  assert.deepEqual(again.body.value.keptConfigKeys, ['EXAMPLE_API_KEY']);
  const kept = readFileSync(join(again.body.value.dir, 'cordis.patch.yml'), 'utf8');
  assert.match(kept, /EXAMPLE_API_KEY: "first-secret"/, 'a reinstall must not wipe the stored secret');

  const replaced = await call(routes, host.MARKET_INSTALL_PATH, host.MARKET_INSTALL_PATH,
    post({ name: 'vendor.example/notes', config: { EXAMPLE_API_KEY: 'second-secret' } }));
  const after = readFileSync(join(replaced.body.value.dir, 'cordis.patch.yml'), 'utf8');
  assert.match(after, /EXAMPLE_API_KEY: "second-secret"/, 'a supplied value replaces the stored one');
});

test('a required command argument left empty is refused before anything is written', async () => {
  seedCache();
  const { routes, calls } = makeCtx();
  const refused = await call(routes, host.MARKET_INSTALL_PATH, host.MARKET_INSTALL_PATH,
    post({ name: 'vendor.example/tree', config: {} }));
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, 'missing-arguments');
  assert.equal(calls.install.length, 0);

  // Filling it installs, and the flag reaches the generated argv.
  const filled = await call(routes, host.MARKET_INSTALL_PATH, host.MARKET_INSTALL_PATH,
    post({ name: 'vendor.example/tree', config: {}, arguments: { '--out': 'D:\\out' } }));
  assert.equal(filled.status, 200);
  const patch = readFileSync(join(filled.body.value.dir, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /- "--out"/);
  assert.match(patch, /- "D:\\\\out"/);
});

test('an SSE-only entry is refused with a reason instead of minting a dead row', async () => {
  seedCache();
  const { routes, calls } = makeCtx();
  const detail = await call(routes, host.MARKET_DETAIL_PATH, host.MARKET_DETAIL_PATH + '?name=' + encodeURIComponent('vendor.example/legacy-sse'));
  assert.equal(detail.body.value.options.length, 0, 'no plan may be offered for an unsupported transport');
  assert.match(JSON.stringify(detail.body.value.blocked), /sse/);

  const refused = await call(routes, host.MARKET_INSTALL_PATH, host.MARKET_INSTALL_PATH,
    post({ name: 'vendor.example/legacy-sse' }));
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'no-install-option');
  assert.equal(calls.install.length, 0);
});

test('search paginates and decorates every card with its state', async () => {
  seedCache();
  const { routes } = makeCtx();

  const first = await call(routes, host.MARKET_SEARCH_PATH, host.MARKET_SEARCH_PATH + '?limit=2&offset=0');
  assert.equal(first.body.value.limit, 2);
  assert.equal(first.body.value.offset, 0);
  assert.equal(first.body.value.results.length, 2);
  assert.equal(first.body.value.total, 4);
  // Each card carries its own state, so the grid needs no second request.
  for (const card of first.body.value.results) {
    assert.equal(typeof card.installable, 'boolean');
    assert.equal(typeof card.needsConfig, 'boolean');
    assert.equal(typeof card.installedSlug, 'string');
  }
  const sse = await call(routes, host.MARKET_SEARCH_PATH, host.MARKET_SEARCH_PATH + '?q=legacy-sse');
  assert.equal(sse.body.value.results[0].installable, false);
  assert.match(sse.body.value.results[0].unsupportedReason, /sse/);
  const tree = await call(routes, host.MARKET_SEARCH_PATH, host.MARKET_SEARCH_PATH + '?q=tree');
  assert.equal(tree.body.value.results[0].needsConfig, true, 'a required command argument counts as needing configuration');
  const keyed = await call(routes, host.MARKET_SEARCH_PATH, host.MARKET_SEARCH_PATH + '?q=notes');
  assert.equal(keyed.body.value.results[0].needsConfig, true, 'a required secret counts as needing configuration');

  const second = await call(routes, host.MARKET_SEARCH_PATH, host.MARKET_SEARCH_PATH + '?limit=2&offset=2');
  assert.equal(second.body.value.results.length, 2);
  assert.equal(second.body.value.results[0].name !== first.body.value.results[0].name, true, 'page two must not repeat page one');
});

test('a search result reflects that the entry is already installed', async () => {
  seedCache();
  const { routes } = makeCtx();

  const before = await call(routes, host.MARKET_SEARCH_PATH, host.MARKET_SEARCH_PATH + '?q=notes');
  assert.equal(before.body.value.results[0].installedSlug, '', 'not installed yet');
  assert.equal(before.body.value.results[0].updateAvailable, false);

  const installed = await call(routes, host.MARKET_INSTALL_PATH, host.MARKET_INSTALL_PATH,
    post({ name: 'vendor.example/notes', config: { EXAMPLE_API_KEY: 'k' } }));
  assert.equal(installed.status, 200);
  const slug = installed.body.value.slug;

  // The same entry, searched again: the card must now say it is installed, or a user
  // clicking 安装 again would silently start an overwrite instead of opening the row.
  const after = await call(routes, host.MARKET_SEARCH_PATH, host.MARKET_SEARCH_PATH + '?q=notes');
  assert.equal(after.body.value.results[0].installedSlug, slug);
  assert.equal(after.body.value.results[0].updateAvailable, false, 'same version is not an update');

  // And when the registry moves on, the same card says so.
  const cache = JSON.parse(readFileSync(market.CACHE_PATH, 'utf8'));
  cache.servers = cache.servers.map((server) => (server.name === 'vendor.example/notes' ? { ...server, version: '7.7.7' } : server));
  writeFileSync(market.CACHE_PATH, JSON.stringify(cache));
  market.resetCatalog();
  const moved = await call(routes, host.MARKET_SEARCH_PATH, host.MARKET_SEARCH_PATH + '?q=notes');
  assert.equal(moved.body.value.results[0].installedSlug, slug);
  assert.equal(moved.body.value.results[0].updateAvailable, true);
});

test('the refresh route takes its mode from the body, and defaults to the cheap one', async () => {
  seedCache();
  const { routes } = makeCtx();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, async json() { return { servers: [], metadata: {} }; } });
  try {
    const full = await call(routes, host.MARKET_REFRESH_PATH, host.MARKET_REFRESH_PATH, post({ mode: 'full' }));
    assert.equal(full.status, 200);
    assert.equal(full.body.value.refreshing.mode, 'full', 'the body selects the mode');
    // Let the detached pull finish before the fetch stub goes away.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const plain = await call(routes, host.MARKET_REFRESH_PATH, host.MARKET_REFRESH_PATH, post({}));
    assert.equal(plain.body.value.refreshing.mode, 'incremental', 'the button refreshes incrementally');
    await new Promise((resolve) => setTimeout(resolve, 30));

    const bare = await call(routes, host.MARKET_REFRESH_PATH, host.MARKET_REFRESH_PATH, { method: 'POST' });
    assert.equal(bare.status, 200, 'a bodyless POST is the incremental case, not an error');
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    globalThis.fetch = realFetch;
    market.resetCatalog();
  }
});

test('the installed list compares versions by inequality only', async () => {
  seedCache();
  const { routes } = makeCtx();
  const installed = await call(routes, host.MARKET_INSTALL_PATH, host.MARKET_INSTALL_PATH,
    post({ name: 'vendor.example/notes', config: { EXAMPLE_API_KEY: 'k' } }));
  assert.equal(installed.status, 200);

  const same = await call(routes, host.MARKET_INSTALLED_PATH, host.MARKET_INSTALLED_PATH);
  assert.equal(same.body.value.items[0].updateAvailable, false, 'the same version is not an update');

  // The registry moves on: any difference is reported, with no ordering claim.
  const cache = JSON.parse(readFileSync(market.CACHE_PATH, 'utf8'));
  cache.servers = cache.servers.map((server) => (server.name === 'vendor.example/notes' ? { ...server, version: '9.9.9' } : server));
  writeFileSync(market.CACHE_PATH, JSON.stringify(cache));
  market.resetCatalog();

  const moved = await call(routes, host.MARKET_INSTALLED_PATH, host.MARKET_INSTALLED_PATH);
  assert.equal(moved.body.value.items[0].updateAvailable, true);
  assert.equal(moved.body.value.items[0].latestVersion, '9.9.9');
  assert.equal(moved.body.value.items[0].registryVersion, '6.3.0', 'the installed version stays the recorded one');
});
