// The market core: filtering, search, plan selection, and the generated bundle.
//
// The market root is redirected to a temp home BEFORE the module is imported, so the
// suite never touches the real ~/.dsh/mcp-servers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'mcp-market-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const market = await import('../market.js');

/** One registry entry, shaped exactly like the live API answers. */
function entry(name, { status = 'active', latest = true, packages = [], remotes = [], publishedAt = '2026-01-01T00:00:00Z', version = '1.2.3' } = {}) {
  return {
    server: { name, title: name, description: 'desc of ' + name, version, packages, remotes },
    _meta: { 'io.modelcontextprotocol.registry/official': { status, isLatest: latest, publishedAt } },
  };
}

const npmPackage = (identifier, environmentVariables = [], packageArguments = []) => ({
  registryType: 'npm', identifier, version: '1.2.3', transport: { type: 'stdio' }, environmentVariables, packageArguments,
});

test('normalize drops deprecated and non-latest entries', () => {
  assert.equal(market.normalize(entry('a/keep')).name, 'a/keep');
  assert.equal(market.normalize(entry('a/gone', { status: 'deprecated' })), null);
  assert.equal(market.normalize(entry('a/old', { latest: false })), null);
  assert.equal(market.normalize({ server: { title: 'no name' }, _meta: {} }), null);
});

// The registry carries `repository: {url, source}` on the entry, and it is the only identity that
// means the same thing in the official registry, in a community list and in a hosted directory.
// Cross-source dedup will key on it, so dropping it at normalize time would quietly make that
// impossible — the mistake this case exists to prevent.
test('normalize keeps the repository url, and says so plainly when there is none', () => {
  const withRepo = { ...entry('a/repo'), server: { ...entry('a/repo').server, repository: { url: 'https://github.com/example/notes', source: 'github' } } };
  assert.equal(market.normalize(withRepo).repository, 'https://github.com/example/notes');
  // A flat entry (already in this shape) must survive being normalized again.
  assert.equal(market.normalize({ ...market.normalize(withRepo), repository: 'https://github.com/example/notes' }).repository, 'https://github.com/example/notes');
  assert.equal(market.normalize(entry('a/none')).repository, null, 'absent is null, not an empty string');
  assert.equal(market.normalize({ ...entry('a/blank'), server: { ...entry('a/blank').server, repository: { url: '' } } }).repository, null);
  assert.equal(market.normalize({ ...entry('a/junk'), server: { ...entry('a/junk').server, repository: 'not-an-object' } }).repository, 'not-an-object', 'a string is taken at face value');
});

test('normalize keeps the fields an install needs', () => {
  const server = market.normalize(entry('vendor.example/notes', {
    packages: [npmPackage('@example/notes-mcp', [{ name: 'AI_KEY', isRequired: true, isSecret: true, description: 'key' }], [{ value: 'serve', type: 'positional' }])],
    remotes: [{ type: 'streamable-http', url: 'https://example.test/mcp' }],
  }));
  assert.equal(server.name, 'vendor.example/notes');
  assert.equal(server.packages[0].identifier, '@example/notes-mcp');
  assert.equal(server.packages[0].environmentVariables[0].isSecret, true);
  assert.equal(server.packages[0].packageArguments[0].value, 'serve');
  assert.equal(server.remotes[0].url, 'https://example.test/mcp');
});

test('search ranks a name match above a description match and filters by kind', () => {
  const cache = {
    cacheVersion: market.CACHE_VERSION,
    fetchedAt: new Date().toISOString(),
    count: 3,
    servers: [
      market.normalize(entry('alpha/filesystem', { packages: [npmPackage('fs-mcp')] })),
      market.normalize(entry('beta/other', { remotes: [{ type: 'streamable-http', url: 'https://x.test/mcp' }] })),
      market.normalize(entry('gamma/notes', { remotes: [{ type: 'streamable-http', url: 'https://y.test/mcp' }] })),
    ],
  };
  cache.servers[2].description = 'a filesystem helper over http';
  mkdirSync(market.CACHE_DIR, { recursive: true });
  writeFileSync(market.CACHE_PATH, JSON.stringify(cache));
  market.resetCatalog();

  const all = market.searchCatalog('filesystem', {});
  assert.equal(all.total, 2);
  assert.equal(all.results[0].name, 'alpha/filesystem', 'a name match must outrank a description match');

  assert.equal(market.searchCatalog('', { kind: 'local' }).total, 1);
  assert.equal(market.searchCatalog('', { kind: 'remote' }).total, 2);
  assert.equal(market.searchCatalog('nothing-matches-this', {}).total, 0);
});

test('a cache written by another format version is ignored, not half-read', () => {
  mkdirSync(market.CACHE_DIR, { recursive: true });
  writeFileSync(market.CACHE_PATH, JSON.stringify({ fetchedAt: new Date().toISOString(), servers: [{ name: 'x/y' }] }));
  market.resetCatalog();
  assert.equal(market.catalog().source, 'none', 'a cache without cacheVersion must be discarded');
});

test('plans: npm needs Node, pypi needs uv, remote-only becomes http, oci is deferred', () => {
  const server = market.normalize(entry('x/multi', {
    packages: [
      { registryType: 'oci', identifier: 'ghcr.io/x/y', transport: { type: 'stdio' } },
      npmPackage('x-mcp'),
      { registryType: 'pypi', identifier: 'x-mcp', transport: { type: 'stdio' } },
    ],
  }));
  const withNode = market.plansFor(server, { platform: 'win32', node: { path: 'C:\\node\\node.exe', available: true, withoutNpm: '' }, npx: { available: true, command: 'C:\\node\\node.exe', prefix: ['C:\\npm\\npx-cli.js'] }, uvx: { available: false }, docker: { available: true } });
  assert.equal(withNode.options.length, 1, 'only the npm package is runnable here');
  assert.equal(withNode.options[0].kind, 'stdio');
  assert.equal(withNode.options[0].command, 'C:\\node\\node.exe');
  assert.deepEqual(market.resolveArgv(withNode.options[0]).args.slice(0, 2), ['C:\\npm\\npx-cli.js', '-y']);
  assert.equal(withNode.blocked.some((item) => item.registryType === 'pypi'), true);
  assert.equal(withNode.blocked.some((item) => item.registryType === 'oci'), true);

  const withUv = market.plansFor(server, { platform: 'linux', node: { path: '', available: false, withoutNpm: '' }, npx: { available: false }, uvx: { available: true, path: '/usr/bin/uvx' }, docker: { available: false } });
  assert.equal(withUv.options.length, 1);
  assert.equal(withUv.options[0].command, '/usr/bin/uvx');

  const remoteOnly = market.normalize(entry('x/http', { remotes: [{ type: 'streamable-http', url: 'https://x.test/mcp' }] }));
  const remotePlan = market.plansFor(remoteOnly, { platform: 'win32', node: { path: '', available: false, withoutNpm: '' }, npx: { available: false }, uvx: { available: false }, docker: { available: false } });
  assert.equal(remotePlan.options.length, 1);
  assert.equal(remotePlan.options[0].kind, 'http');
  assert.equal(remotePlan.options[0].transport, 'streamable-http');
});

test('the generated command is a real Node install, never the Electron shell', () => {
  const server = market.normalize(entry('x/npm', { packages: [npmPackage('x-mcp')] }));
  const runtimes = market.detectRuntimes();
  if (runtimes.npx.available) {
    const plan = market.plansFor(server, runtimes).options[0];
    assert.match(plan.command, /(^[A-Za-z]:[\\/]|\/)/, 'the command must be an absolute path, not a PATH lookup');
    assert.match(plan.command.split(/[\\/]/).pop(), /^node(\.exe)?$/i, 'the command must be a node executable');
    assert.doesNotMatch(plan.command, /electron/i, 'the Electron shell is never a valid command');
    assert.match(runtimes.npx.cli, /npx-cli\.js$/, 'npx must run through npm\'s own CLI');
    assert.doesNotMatch(runtimes.npx.cli, /electron/i);
  } else {
    // A machine with no usable Node must say so rather than mint a broken row.
    const { options, blocked } = market.plansFor(server, runtimes);
    assert.equal(options.length, 0);
    assert.match(blocked[0].reason, /Node/);
  }
  // A Node without npm is explicitly not enough.
  const noNpm = market.plansFor(server, { platform: 'win32', node: { path: 'C:\\dsh\\node.exe', available: true, withoutNpm: 'C:\\dsh\\node.exe' }, npx: { available: false, command: '', prefix: [] }, uvx: { available: false }, docker: { available: false } });
  assert.equal(noNpm.options.length, 0);
  assert.match(noNpm.blocked[0].reason, /npm/);
});

test('both argument layers reach the argv, and a valueless named flag becomes a slot', () => {
  const pack = {
    registryType: 'npm', identifier: '@aquex/stage1', version: '1.0.0', transport: 'stdio',
    registryBaseUrl: '', runtimeHint: 'npx',
    environmentVariables: [],
    runtimeArguments: [{ value: '-y' }, { value: '--package' }],
    packageArguments: [
      { type: 'positional', name: '', value: 'stage1-mcp', description: '', isRequired: false, format: '' },
      { type: 'named', name: '--out', value: '', description: 'Absolute writable output root', isRequired: true, format: 'filepath' },
    ],
  };
  const server = market.normalize(entry('ai.aquex/stage1', { packages: [pack] }));
  const plan = market.plansFor(server, market.detectRuntimes()).options[0];

  const filled = market.resolveArgv(plan, { '--out': 'D:\\out' });
  // The trailing entries are the registry's own argv; the leading ones launch the runner.
  assert.deepEqual(filled.args.slice(-6), ['-y', '--package', '@aquex/stage1', 'stage1-mcp', '--out', 'D:\\out']);
  assert.deepEqual(filled.missing, []);
  assert.equal(filled.args.filter((value) => value === '-y').length, 1, 'the registry -y must not be doubled');

  const empty = market.resolveArgv(plan, {});
  assert.deepEqual(empty.missing, ['--out'], 'a required named flag must be reported, not silently dropped');

  // A registry-provided value is used verbatim instead of becoming a slot.
  const fixed = market.normalize(entry('x/fixed', { packages: [{ ...pack, packageArguments: [{ type: 'named', name: '--mode', value: 'fast', description: '', isRequired: false, format: '' }] }] }));
  const fixedPlan = market.plansFor(fixed, market.detectRuntimes()).options[0];
  assert.equal(fixedPlan.slots.length, 0);
  assert.equal(market.resolveArgv(fixedPlan).args.includes('fast'), true);
});

test('a custom registry base url is passed to the runner', () => {
  const server = market.normalize(entry('x/private', { packages: [{ ...npmPackage('x-private'), registryBaseUrl: 'https://npm.corp.test/' }] }));
  const plan = market.plansFor(server, market.detectRuntimes()).options[0];
  assert.equal(market.resolveArgv(plan).args.includes('--registry=https://npm.corp.test/'), true);
});

test('a short full pull keeps the previous snapshot instead of blanking the market', async () => {
  mkdirSync(market.CACHE_DIR, { recursive: true });
  const good = {
    cacheVersion: market.CACHE_VERSION,
    fetchedAt: new Date().toISOString(),
    count: 2,
    servers: [market.normalize(entry('a/keep')), market.normalize(entry('b/keep'))],
  };
  writeFileSync(market.CACHE_PATH, JSON.stringify(good));
  market.resetCatalog();
  assert.equal(market.catalog().count, 2);

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return { servers: [entry('only/one')], metadata: {} };
    },
  });
  try {
    const state = await market.refreshCatalog({ mode: 'full' });
    assert.match(state.error, /only 1 usable entries/);
  } finally {
    globalThis.fetch = realFetch;
  }
  market.resetCatalog();
  assert.equal(market.catalog().count, 2, 'the previous snapshot must survive a failed pull');
});

test('the refresh button asks only for what changed, and merges instead of replacing', async () => {
  mkdirSync(market.CACHE_DIR, { recursive: true });
  const fetchedAt = new Date(Date.now() - 3600000).toISOString();
  writeFileSync(market.CACHE_PATH, JSON.stringify({
    cacheVersion: market.CACHE_VERSION,
    fetchedAt,
    count: 2,
    servers: [market.normalize(entry('a/keep')), market.normalize(entry('b/old', { version: '1.0.0' }))],
  }));
  market.resetCatalog();

  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return {
      ok: true,
      async json() {
        // Only one entry changed since the last pull, and one is brand new.
        return { servers: [entry('b/old', { version: '2.0.0' }), entry('c/new')], metadata: {} };
      },
    };
  };
  try {
    const state = await market.refreshCatalog();
    assert.equal(state.mode, 'incremental', 'the default refresh is the cheap one');
    assert.equal(state.error, '');
    // It asked for changes only, from a little before the last pull.
    assert.equal(seen.length, 1);
    assert.match(seen[0], /updated_since=/);
    const since = Date.parse(decodeURIComponent(/updated_since=([^&]+)/.exec(seen[0])[1]));
    assert.equal(since < Date.parse(fetchedAt), true, 'the cursor starts before the last pull, never after it');
    assert.equal(Date.parse(fetchedAt) - since, 10 * 60 * 1000, 'the safety margin is ten minutes');
  } finally {
    globalThis.fetch = realFetch;
  }
  market.resetCatalog();

  const after = market.catalog();
  assert.equal(after.count, 3, 'an incremental pull adds and updates, and drops nothing');
  const names = after.servers.map((server) => server.name).sort();
  assert.deepEqual(names, ['a/keep', 'b/old', 'c/new']);
  assert.equal(after.servers.find((server) => server.name === 'b/old').version, '2.0.0');
});

test('an incremental pull that finds nothing new leaves the snapshot alone', async () => {
  mkdirSync(market.CACHE_DIR, { recursive: true });
  writeFileSync(market.CACHE_PATH, JSON.stringify({
    cacheVersion: market.CACHE_VERSION,
    fetchedAt: new Date().toISOString(),
    count: 2,
    servers: [market.normalize(entry('a/keep')), market.normalize(entry('b/keep'))],
  }));
  market.resetCatalog();

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, async json() { return { servers: [], metadata: {} }; } });
  try {
    const state = await market.refreshCatalog();
    assert.equal(state.error, '', 'an empty answer is a real answer here, not a failure');
  } finally {
    globalThis.fetch = realFetch;
  }
  market.resetCatalog();
  assert.equal(market.catalog().count, 2, 'nothing changed means nothing is dropped');
});

test('card state: installable, needs-config, installed and update are decided on the host', () => {
  const plain = market.normalize(entry('x/plain', { packages: [npmPackage('x-plain')] }));
  const keyed = market.normalize(entry('x/keyed', { packages: [npmPackage('x-keyed', [{ name: 'K', isRequired: true, isSecret: true }])] }));
  const sse = market.normalize(entry('x/sse', { remotes: [{ type: 'sse', url: 'https://x.test/sse' }] }));
  const oci = market.normalize(entry('x/oci', { packages: [{ registryType: 'oci', identifier: 'ghcr.io/x', transport: { type: 'stdio' } }] }));
  const runtimes = market.detectRuntimes();

  const idle = market.cardStateFor(plain, runtimes);
  assert.equal(idle.installable, true);
  assert.equal(idle.needsConfig, false);
  assert.equal(idle.installedSlug, '');

  assert.equal(market.cardStateFor(keyed, runtimes).needsConfig, true, 'a required secret makes the card say so');
  const unsupported = market.cardStateFor(sse, runtimes);
  assert.equal(unsupported.installable, false);
  assert.match(unsupported.unsupportedReason, /sse/);
  assert.match(market.cardStateFor(oci, runtimes).unsupportedReason, /oci/);

  // Installed, then the registry moves on: inequality only, no ordering claim.
  const installed = new Map([['x/plain', { slug: 'x-plain-000000', registryVersion: '1.2.3' }]]);
  const same = market.cardStateFor(plain, runtimes, installed);
  assert.equal(same.installedSlug, 'x-plain-000000');
  assert.equal(same.updateAvailable, false);
  const moved = market.cardStateFor({ ...plain, version: '9.9.9' }, runtimes, installed);
  assert.equal(moved.updateAvailable, true);
});

test('serverName stays inside the client contract and avoids collisions', () => {
  assert.equal(market.serverNameFor('agency.kesey/pretrip', []), 'pretrip');
  assert.equal(market.serverNameFor('vendor.example/mcp', []), 'vendor-example', 'a generic last segment falls back to the vendor');
  const collided = market.serverNameFor('agency.kesey/pretrip', ['pretrip']);
  assert.notEqual(collided, 'pretrip');
  for (const name of ['agency.kesey/pretrip', 'vendor.example/mcp', 'a/b/c', '@scope/thing', '///']) {
    assert.match(market.serverNameFor(name, []), /^[A-Za-z0-9_-]{1,32}$/, name + ' must satisfy the client pattern');
  }
  assert.notEqual(market.slugFor('a/b'), market.slugFor('a-b'), 'slugs must stay unique across names that sanitize alike');
  assert.match(market.slugFor('vendor.example/notes'), /^[a-z0-9-]+$/);
});

test('the generated bundle is a loadable patch plus its manifest', () => {
  const server = market.normalize(entry('vendor.example/notes', {
    packages: [npmPackage('@example/notes-mcp', [{ name: 'AI_KEY', isRequired: true, isSecret: true }])],
  }));
  const runtimes = market.detectRuntimes();
  const plan = market.plansFor(server, runtimes).options[0];
  const slug = market.slugFor(server.name);
  const written = market.writeBundle({ slug, server, serverName: 'notes', plan, config: { AI_KEY: 'secret-value' } });

  assert.equal(existsSync(join(written.dir, 'package.json')), true);
  assert.equal(existsSync(join(written.dir, 'cordis.patch.yml')), true);
  assert.equal(existsSync(join(written.dir, 'market.meta.json')), true);

  const manifest = JSON.parse(readFileSync(join(written.dir, 'package.json'), 'utf8'));
  assert.equal(manifest.name, market.BUNDLE_PREFIX + slug);
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');

  const patch = readFileSync(join(written.dir, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /name: '@deepseek-ai\/dsh-mcp-client'/);
  assert.match(patch, /transport: "stdio"/);
  assert.match(patch, /serverName: "notes"/);
  assert.match(patch, /AI_KEY: "secret-value"/, 'a filled variable lands in the row env');

  const meta = JSON.parse(readFileSync(join(written.dir, 'market.meta.json'), 'utf8'));
  assert.equal(meta.registryName, 'vendor.example/notes');
  assert.equal(meta.registryVersion, '1.2.3');
  assert.equal(meta.kind, 'stdio');
  assert.deepEqual(meta.configKeys, ['AI_KEY']);

  assert.equal(market.listInstalled().some((item) => item.slug === slug), true);
  assert.equal(market.removeBundleDir(slug), true);
  assert.equal(market.listInstalled().some((item) => item.slug === slug), false);
});

test('an http plan writes url and headers instead of a command', () => {
  const server = market.normalize(entry('x/http', { remotes: [{ type: 'streamable-http', url: 'https://x.test/mcp', headers: [{ name: 'Authorization', isRequired: true, isSecret: true }] }] }));
  const plan = market.plansFor(server, market.detectRuntimes()).options[0];
  const patch = market.renderPatch({ rowId: 'mcp-x', serverName: 'x', plan, config: { Authorization: 'Bearer token' } });
  assert.match(patch, /transport: "streamable-http"/);
  assert.match(patch, /url: "https:\/\/x\.test\/mcp"/);
  assert.match(patch, /Authorization: "Bearer token"/);
  assert.doesNotMatch(patch, /command:/);
});
