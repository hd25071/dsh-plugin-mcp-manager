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
function entry(name, { status = 'active', latest = true, packages = [], remotes = [], publishedAt = '2026-01-01T00:00:00Z' } = {}) {
  return {
    server: { name, title: name, description: 'desc of ' + name, version: '1.2.3', packages, remotes },
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
    fetchedAt: new Date().toISOString(),
    count: 3,
    servers: [
      market.normalize(entry('alpha/filesystem', { packages: [npmPackage('fs-mcp')] })),
      market.normalize(entry('beta/other', { remotes: [{ type: 'streamable-http', url: 'https://x.test/mcp' }] })),
      market.normalize(entry('gamma/notes', { remotes: [{ type: 'streamable-http', url: 'https://y.test/mcp' }] })),
    ],
  };
  cache.servers[2].description = 'a filesystem helper over http';
  mkdirSync(market.MARKET_ROOT, { recursive: true });
  writeFileSync(market.CACHE_PATH, JSON.stringify(cache));

  const all = market.searchCatalog('filesystem', {});
  assert.equal(all.total, 2);
  assert.equal(all.results[0].name, 'alpha/filesystem', 'a name match must outrank a description match');

  assert.equal(market.searchCatalog('', { kind: 'local' }).total, 1);
  assert.equal(market.searchCatalog('', { kind: 'remote' }).total, 2);
  assert.equal(market.searchCatalog('nothing-matches-this', {}).total, 0);
});

test('plans: npm needs Node, pypi needs uv, remote-only becomes http, oci is deferred', () => {
  const server = market.normalize(entry('x/multi', {
    packages: [
      { registryType: 'oci', identifier: 'ghcr.io/x/y', transport: { type: 'stdio' } },
      npmPackage('x-mcp'),
      { registryType: 'pypi', identifier: 'x-mcp', transport: { type: 'stdio' } },
    ],
  }));
  const withNode = market.plansFor(server, { platform: 'win32', node: { path: 'C:\\node\\node.exe', available: true }, npx: { available: true, command: 'C:\\node\\node.exe', prefix: ['C:\\npm\\npx-cli.js'] }, uvx: { available: false }, docker: { available: true } });
  assert.equal(withNode.options.length, 1, 'only the npm package is runnable here');
  assert.equal(withNode.options[0].kind, 'stdio');
  assert.equal(withNode.options[0].command, 'C:\\node\\node.exe');
  assert.deepEqual(withNode.options[0].args.slice(0, 2), ['C:\\npm\\npx-cli.js', '-y']);
  assert.equal(withNode.blocked.some((item) => item.registryType === 'pypi'), true);
  assert.equal(withNode.blocked.some((item) => item.registryType === 'oci'), true);

  const withUv = market.plansFor(server, { platform: 'linux', node: { path: '', available: false }, npx: { available: false }, uvx: { available: true, path: '/usr/bin/uvx' }, docker: { available: false } });
  assert.equal(withUv.options.length, 1);
  assert.equal(withUv.options[0].command, '/usr/bin/uvx');

  const remoteOnly = market.normalize(entry('x/http', { remotes: [{ type: 'streamable-http', url: 'https://x.test/mcp' }] }));
  const remotePlan = market.plansFor(remoteOnly, { platform: 'win32', node: { path: '', available: false }, npx: { available: false }, uvx: { available: false }, docker: { available: false } });
  assert.equal(remotePlan.options.length, 1);
  assert.equal(remotePlan.options[0].kind, 'http');
  assert.equal(remotePlan.options[0].transport, 'streamable-http');
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
