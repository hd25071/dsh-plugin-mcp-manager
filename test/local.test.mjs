// Local entries: the hand-written file, its validation, and how it merges with the registry.
//
// HOME is redirected before the modules load, so nothing here reads or writes the real
// `~/.dsh` — the same isolation the other host suites use.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'mcpm-local-test-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const market = await import('file:///D:/dshtools/dsh-plugin-mcp-manager/market.js');
const local = await import('file:///D:/dshtools/dsh-plugin-mcp-manager/local.js');
const host = await import('file:///D:/dshtools/dsh-plugin-mcp-manager/index.js');

const LOCAL_PATH = local.localEntriesPath(market.CACHE_DIR);

/** A registry snapshot with one entry the local file can cover. */
function seedRegistry() {
  mkdirSync(market.CACHE_DIR, { recursive: true });
  writeFileSync(market.CACHE_PATH, JSON.stringify({
    cacheVersion: market.CACHE_VERSION,
    fetchedAt: new Date().toISOString(),
    count: 1,
    servers: [{
      name: 'vendor.example/notes', title: 'Vendor Notes', description: 'registry one', version: '1.2.3',
      publishedAt: '2026-01-01T00:00:00Z', remotes: [],
      packages: [{
        registryType: 'npm', identifier: '@example/notes-mcp', version: '1.2.3', transport: 'stdio',
        environmentVariables: [{ name: 'EXISTING_KEY', description: 'kept across reinstall', isRequired: true, isSecret: true, default: '' }],
        packageArguments: [],
      }],
    }],
  }));
}

/** Write the local file and forget the memo, so the next read sees it. */
function seedLocal(entries, extra = {}) {
  mkdirSync(market.CACHE_DIR, { recursive: true });
  writeFileSync(LOCAL_PATH, JSON.stringify({ cacheVersion: local.LOCAL_CACHE_VERSION, entries, ...extra }));
  local.resetLocalCache();
  market.resetCatalog();
}

const stdioEntry = (name, overrides = {}) => ({
  name,
  title: '示例服务',
  description: 'server.py mcp',
  install: {
    kind: 'stdio',
    command: 'C:\\Windows\\py.exe',
    args: ['D:\\tools\\demo\\server.py', 'mcp'],
    env: [{ name: 'PYTHONUTF8', value: '1' }, { name: 'DEMO_API_KEY', description: 'Key', isRequired: true, isSecret: true }],
    ...overrides,
  },
});

beforeEach(() => {
  rmSync(join(home, '.dsh'), { recursive: true, force: true });
  local.resetLocalCache();
  market.resetCatalog();
});

test('a valid stdio entry and a valid http entry normalize', () => {
  const result = local.validateLocalEntries({
    cacheVersion: 1,
    entries: [
      stdioEntry('vendor.example/kb'),
      { name: 'vendor.example/hub', title: '示例', install: { kind: 'http', url: 'http://10.0.0.1:8080/mcp', headers: [{ name: 'X-Token', isRequired: true, isSecret: true }] } },
    ],
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.entries.length, 2);

  const stdio = result.entries[0];
  assert.equal(stdio.source, 'local');
  assert.equal(stdio.local.kind, 'stdio');
  assert.equal(stdio.local.command, 'C:\\Windows\\py.exe');
  assert.deepEqual(stdio.local.args, ['D:\\tools\\demo\\server.py', 'mcp']);
  // A declared value answers the field, so the form will not ask for it again.
  assert.deepEqual(stdio.local.env[0], { name: 'PYTHONUTF8', description: '', isRequired: false, isSecret: false, default: '1' });
  assert.equal(stdio.local.env[1].isRequired, true);

  const http = result.entries[1];
  assert.equal(http.local.kind, 'http');
  assert.equal(http.local.url, 'http://10.0.0.1:8080/mcp');
  assert.equal(http.local.headers[0].isRequired, true);
});

test('a missing command names the entry and the field', () => {
  const result = local.validateLocalEntries({
    cacheVersion: 1,
    entries: [stdioEntry('vendor.example/kb'), { name: 'vendor.example/broken', install: { kind: 'stdio', args: [] } }],
  });
  assert.deepEqual(result.errors, ['第 2 条缺 command']);
  assert.equal(result.entries.length, 1, 'the good entry still loads');
});

test('a command that is not an absolute path is refused', () => {
  for (const command of ['sh', 'bash', 'cmd', 'powershell', 'python', './run.sh']) {
    const result = local.validateLocalEntries({
      cacheVersion: 1,
      entries: [stdioEntry('vendor.example/x', { command })],
    });
    assert.equal(result.entries.length, 0, command + ' must be refused');
    assert.match(result.errors[0], /第 1 条：command 必须是绝对路径/);
  }
});

test('shell metacharacters in args warn but do not refuse', () => {
  const result = local.validateLocalEntries({
    cacheVersion: 1,
    entries: [
      stdioEntry('vendor.example/meta', { args: ['-m', 'srv', '--url', 'https://x.test/a?b=1&c=2'] }),
      stdioEntry('vendor.example/script', { command: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-Command', 'Get-Date; echo hi'] }),
    ],
  });
  assert.deepEqual(result.errors, [], 'both entries stay installable');
  assert.equal(result.entries.length, 2);

  const meta = result.entries[0];
  assert.equal(meta.warning, true);
  assert.match(meta.warningReasons.join(' '), /shell 元字符/);

  const script = result.entries[1];
  assert.equal(script.warning, true);
  assert.match(script.warningReasons.join(' '), /内联脚本标志/);
  assert.equal(result.warnings.length, 2, 'each warning is reported for the person editing the file');
});

test('the local file covers a registry entry of the same name', () => {
  seedRegistry();
  seedLocal([stdioEntry('vendor.example/notes')]);
  const catalog = market.catalog();
  assert.equal(catalog.count, 1, 'one name, one entry');
  const entry = catalog.servers[0];
  assert.equal(entry.source, 'local', 'the local entry wins');
  assert.equal(entry.coversRegistry, true);
  assert.equal(entry.coversVersion, '1.2.3', 'and it names the version it replaced');
  assert.equal(catalog.local.count, 1);
  assert.deepEqual(catalog.local.errors, []);
});

test('installing a local entry over an installed registry version replaces it', async () => {
  seedRegistry();
  seedLocal([stdioEntry('vendor.example/notes')]);
  const routes = new Map();
  const calls = { install: [], remove: [] };
  // The editor reports the row the registry install left behind, with the value the user
  // typed last time — that is what a covering reinstall has to carry forward.
  const ctx = {
    get(key) {
      if (key === 'connection') return { fetch: { register(spec) { routes.set(spec.path, spec); } } };
      if (key === 'pluginManager') {
        return {
          async installBundle(spec, options) { calls.install.push({ spec, options }); return { exitCode: 0 }; },
          async removeBundle(name) { calls.remove.push(name); return { exitCode: 0 }; },
        };
      }
      if (key === 'configEditor') {
        return {
          configuration() {
            return [{
              entry: { options: { id: 'mcp-' + market.slugFor('vendor.example/notes'), name: '@deepseek-ai/dsh-mcp-client' } },
              inherited: {},
              override: { transport: 'stdio', serverName: 'notes', command: 'node', args: [], env: { EXISTING_KEY: 'kept' } },
            }];
          },
        };
      }
      return undefined;
    },
  };
  host.apply(ctx);
  const post = (payload) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const call = async (path, url, init) => {
    const response = await routes.get(path).fetch(new Request('http://local' + url, init));
    return { status: response.status, body: await response.json() };
  };

  // The slug is derived from the name alone, so a local entry of the same name lands on the
  // same bundle directory as the registry row it replaces — that is the overwrite path.
  const slug = market.slugFor('vendor.example/notes');
  mkdirSync(market.bundleDir(slug), { recursive: true });
  writeFileSync(join(market.bundleDir(slug), 'market.meta.json'), JSON.stringify({
    registryName: 'vendor.example/notes', registryVersion: '1.2.3', slug, pkg: market.BUNDLE_PREFIX + slug,
    rowId: 'mcp-' + slug, source: 'registry',
  }));

  const detail = await call(host.MARKET_DETAIL_PATH, host.MARKET_DETAIL_PATH + '?name=' + encodeURIComponent('vendor.example/notes'));
  assert.equal(detail.body.value.options[0].registryType, 'local');
  assert.equal(detail.body.value.coversRegistry, true, 'the dialog can say what is being covered');

  const installed = await call(host.MARKET_INSTALL_PATH, host.MARKET_INSTALL_PATH, post({
    name: 'vendor.example/notes', optionIndex: 0,
    config: { DEMO_API_KEY: 'k', EXISTING_KEY: 'kept' },
  }));
  assert.equal(installed.status, 200);
  assert.equal(installed.body.value.slug, slug, 'the same bundle, replaced');

  const manifest = JSON.parse(readFileSync(join(market.bundleDir(slug), 'market.meta.json'), 'utf8'));
  assert.equal(manifest.source, 'local');
  assert.deepEqual(manifest.configKeys.sort(), ['DEMO_API_KEY', 'EXISTING_KEY'], 'the earlier configuration is merged, not dropped');

  const patch = readFileSync(join(market.bundleDir(slug), 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /command: "C:\\\\Windows\\\\py\.exe"/, 'the local command line reaches the row');
  assert.match(patch, /from a local entry in local-entries\.json/);
  assert.match(patch, /PYTHONUTF8: "1"/, 'a value declared in the file is written without asking');
  assert.match(patch, /EXISTING_KEY: "kept"/);
});

test('a local entry never claims a version update', () => {
  seedRegistry();
  seedLocal([{ ...stdioEntry('vendor.example/notes'), version: '9.9.9' }]);
  const installed = new Map([['vendor.example/notes', { slug: 'vendor-example-notes-abc123', registryVersion: '1.2.3', source: 'registry' }]]);
  const card = market.cardStateFor(market.findServer('vendor.example/notes'), market.detectRuntimes(), installed);
  assert.equal(card.updateAvailable, false, 'there is no registry version to be newer than');
  assert.equal(card.source, 'local');
  assert.equal(card.coversRegistry, true);
});

test('the installed list skips the version comparison for a local row', async () => {
  seedRegistry();
  seedLocal([{ ...stdioEntry('vendor.example/notes'), version: '9.9.9' }]);
  const slug = market.slugFor('vendor.example/notes');
  mkdirSync(market.bundleDir(slug), { recursive: true });
  writeFileSync(join(market.bundleDir(slug), 'market.meta.json'), JSON.stringify({
    registryName: 'vendor.example/notes', registryTitle: 'Vendor Notes', registryVersion: '1.2.3',
    slug, pkg: market.BUNDLE_PREFIX + slug, serverName: 'notes', kind: 'stdio', source: 'local', configKeys: [], installedAt: new Date().toISOString(),
  }));

  const routes = new Map();
  const ctx = { get(key) { return key === 'connection' ? { fetch: { register(spec) { routes.set(spec.path, spec); } } } : undefined; } };
  host.apply(ctx);
  const response = await routes.get(host.MARKET_INSTALLED_PATH).fetch(new Request('http://local' + host.MARKET_INSTALLED_PATH));
  const body = await response.json();
  const item = body.value.items[0];
  assert.equal(item.updateAvailable, false, 'no update badge and no 目录版本 vX（不同）line');
  assert.equal(item.source, 'local');
});

test('editing the file takes effect on the next catalog read', () => {
  seedRegistry();
  seedLocal([stdioEntry('vendor.example/one')]);
  assert.equal(market.catalog().servers.filter((server) => server.source === 'local').length, 1);

  seedLocal([stdioEntry('vendor.example/one'), stdioEntry('vendor.example/two')]);
  const after = market.catalog();
  assert.equal(after.servers.filter((server) => server.source === 'local').length, 2, 'no restart needed');
  assert.equal(after.local.count, 2);
});

test('an unchanged file is not re-validated', () => {
  seedRegistry();
  seedLocal([stdioEntry('vendor.example/one')]);
  const first = local.readLocalEntries(LOCAL_PATH);
  const second = local.readLocalEntries(LOCAL_PATH);
  assert.equal(first.stamp, second.stamp);
  assert.equal(first.entries, second.entries, 'the same normalized array is handed back, not a copy');

  // Touching the content changes the stamp, so the memo is dropped.
  seedLocal([stdioEntry('vendor.example/one'), stdioEntry('vendor.example/two')]);
  const third = local.readLocalEntries(LOCAL_PATH);
  assert.notEqual(third.stamp, first.stamp);
  assert.equal(third.entries.length, 2);
});

test('uninstalling a local entry takes the same path as a registry one', async () => {
  seedRegistry();
  seedLocal([stdioEntry('vendor.example/notes')]);
  const slug = market.slugFor('vendor.example/notes');
  mkdirSync(market.bundleDir(slug), { recursive: true });
  writeFileSync(join(market.bundleDir(slug), 'market.meta.json'), JSON.stringify({
    registryName: 'vendor.example/notes', registryVersion: '1.2.3', slug, pkg: market.BUNDLE_PREFIX + slug, serverName: 'notes', source: 'local',
  }));

  const routes = new Map();
  const calls = { remove: [] };
  const ctx = {
    get(key) {
      if (key === 'connection') return { fetch: { register(spec) { routes.set(spec.path, spec); } } };
      if (key === 'pluginManager') return { async removeBundle(name) { calls.remove.push(name); return { exitCode: 0 }; } };
      return undefined;
    },
  };
  host.apply(ctx);
  const response = await routes.get(host.MARKET_UNINSTALL_PATH).fetch(new Request('http://local' + host.MARKET_UNINSTALL_PATH, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(calls.remove, ['@dsh-mcp-market/' + slug], 'removeBundle first');
  assert.equal(existsSync(market.bundleDir(slug)), false, 'then the directory goes');
  assert.equal(market.listInstalled().length, 0, 'and the manifest forgets it');
});

test('the 自建 filter shows only local entries', () => {
  seedRegistry();
  seedLocal([stdioEntry('vendor.example/one')]);
  const own = market.searchCatalog('', { source: 'local', limit: 10 });
  assert.equal(own.total, 1);
  assert.equal(own.results[0].source, 'local');

  const everything = market.searchCatalog('', { limit: 10 });
  assert.equal(everything.total, 2, 'the registry entry is still there');
  assert.equal(everything.results.filter((card) => card.source === 'local').length, 1);
});

test('a card carries the 自建 badge state', () => {
  seedRegistry();
  seedLocal([stdioEntry('vendor.example/one')]);
  const card = market.cardStateFor(market.findServer('vendor.example/one'), market.detectRuntimes(), new Map());
  assert.equal(card.source, 'local');
  assert.equal(card.registryType, 'local');
  assert.equal(card.installable, true);
  const registryCard = market.cardStateFor(market.findServer('vendor.example/notes'), market.detectRuntimes(), new Map());
  assert.equal(registryCard.source, 'registry');
});
