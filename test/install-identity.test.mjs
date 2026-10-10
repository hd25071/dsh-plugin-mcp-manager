// MCP identity stability: one entry, one row, one serverName — for as long as it is installed.
//
// Every case here drives the real routes. The fake profile is not a stub that returns whatever a
// test wants: `installBundle` reads the patch the install just generated and puts THAT row live,
// exactly as DSH would. So the second install in a sequence really does see the first one's row,
// which is the only way the drift this file is about can appear at all.
//
// The identity a call produced is read back out of the generated `cordis.patch.yml` — the file
// DSH loads — rather than trusted from the response, and every assertion names the value it
// expects instead of the status code alone.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'mcpm-identity-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const host = await import('../index.js');
const market = await import('../market.js');

beforeEach(() => {
  rmSync(market.MARKET_ROOT, { recursive: true, force: true });
  rmSync(market.CACHE_DIR, { recursive: true, force: true });
  market.resetCatalog();
});

/** Two entries whose last path segment is the same, so their default names collide. */
function seedCache() {
  mkdirSync(dirname(market.CACHE_PATH), { recursive: true });
  const pkg = (identifier) => [{
    registryType: 'npm', identifier, version: '1.0.0', transport: 'stdio',
    environmentVariables: [{ name: 'EXAMPLE_API_KEY', description: 'key', isRequired: false, isSecret: true, default: '' }],
    packageArguments: [{ type: 'named', name: '--out', value: '', description: 'output root', isRequired: false, format: 'filepath' }],
  }];
  writeFileSync(market.CACHE_PATH, JSON.stringify({
    cacheVersion: market.CACHE_VERSION,
    fetchedAt: new Date().toISOString(),
    count: 3,
    servers: [
      { name: 'vendor.example/notes', title: 'Vendor Notes', description: 'first', version: '1.0.0', publishedAt: '2026-01-01T00:00:00Z', remotes: [], packages: pkg('@example/notes') },
      { name: 'other.example/notes', title: 'Other Notes', description: 'same last segment', version: '1.0.0', publishedAt: '2026-01-01T00:00:00Z', remotes: [], packages: pkg('@example/other-notes') },
      { name: 'vendor.example/mcp', title: 'Vendor HTTP', description: 'remote', version: '1.0.0', publishedAt: '2026-01-01T00:00:00Z', packages: [], remotes: [{ type: 'streamable-http', url: 'https://vendor.example/mcp', headers: [{ name: 'Authorization', isRequired: false, isSecret: true }] }] },
    ],
  }));
}

/** The identity the generated patch declares — the file DSH itself loads. */
function patchIdentity(dir) {
  const text = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
  const id = /^\s*- id: (.+)$/m.exec(text);
  const serverName = /^\s{8}serverName: (".*")$/m.exec(text);
  const transport = /^\s{8}transport: (".*")$/m.exec(text);
  assert.notEqual(id, null, 'the generated patch must declare a row id');
  assert.notEqual(serverName, null, 'the generated patch must declare a serverName');
  const block = (key) => {
    const found = new RegExp('^        ' + key + ':\\n((?:          .*\\n)*)', 'm').exec(text);
    const out = {};
    if (found === null) return out;
    for (const line of found[1].split('\n')) {
      const pair = /^          ([^:]+): (.*)$/.exec(line);
      if (pair !== null) out[pair[1].trim()] = JSON.parse(pair[2]);
    }
    return out;
  };
  return {
    rowId: id[1].trim(),
    serverName: JSON.parse(serverName[1]),
    transport: transport === null ? '' : JSON.parse(transport[1]),
    env: block('env'),
    headers: block('headers'),
    text,
  };
}

/**
 * A profile whose rows are the bundles already installed.
 *
 * `installBundle` puts the row the patch declares into the profile, so a later install in the
 * same test meets it — the sequence that used to drift.
 */
function makeCtx() {
  const routes = new Map();
  const calls = { install: [] };
  const rows = [];
  const asItem = (row) => ({
    entry: { options: { id: row.id, name: host.MCP_MODULE } },
    inherited: {},
    override: { transport: row.transport, serverName: row.serverName, env: row.env, headers: row.headers },
  });
  const ctx = {
    get(key) {
      if (key === 'connection') return { fetch: { register(spec) { routes.set(spec.path, spec); } } };
      if (key === 'pluginManager') {
        return {
          async installBundle(dir) {
            // Snapshotted here, not read later: every install of one entry rewrites the same
            // directory, so `calls.install[i]` would otherwise only ever show the last write.
            const written = patchIdentity(dir);
            calls.install.push({ dir, written, patch: written.text });
            const row = { id: written.rowId, serverName: written.serverName, transport: written.transport, env: written.env, headers: written.headers };
            const at = rows.findIndex((candidate) => candidate.id === row.id);
            if (at >= 0) rows[at] = row; else rows.push(row);
            return { exitCode: 0 };
          },
        };
      }
      if (key === 'configEditor') {
        return { configuration() { return rows.map(asItem); } };
      }
      return undefined;
    },
  };
  host.apply(ctx);
  return { routes, calls, rows };
}

async function call(routes, path, url, init) {
  const response = await routes.get(path).fetch(new Request('http://local' + url, init));
  return { status: response.status, body: await response.json() };
}
const post = (payload) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
const install = (routes, payload) => call(routes, host.MARKET_INSTALL_PATH, host.MARKET_INSTALL_PATH, post(payload));
const detail = (routes, name) => call(routes, host.MARKET_DETAIL_PATH, host.MARKET_DETAIL_PATH + '?name=' + encodeURIComponent(name));

test('the first install names the row after the entry, and the patch carries that name', async () => {
  seedCache();
  const { routes, calls, rows } = makeCtx();
  const installed = await install(routes, { name: 'vendor.example/notes', optionIndex: 0, config: { EXAMPLE_API_KEY: 'abc123' } });
  assert.equal(installed.status, 200);
  assert.equal(calls.install.length, 1);

  const written = calls.install[0].written;
  assert.equal(written.serverName, 'notes');
  assert.equal(written.rowId, market.ROW_PREFIX + market.slugFor('vendor.example/notes'));
  assert.deepEqual(written.env, { EXAMPLE_API_KEY: 'abc123' });
  assert.equal(installed.body.value.serverName, 'notes');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].serverName, 'notes');
});

test('reinstalling the same entry keeps its serverName', async () => {
  seedCache();
  const { routes, calls } = makeCtx();
  await install(routes, { name: 'vendor.example/notes', optionIndex: 0, config: { EXAMPLE_API_KEY: 'abc123' } });
  const again = await install(routes, { name: 'vendor.example/notes', optionIndex: 0, config: {} });

  assert.equal(again.status, 200);
  assert.equal(calls.install.length, 2, 'an update runs through the installer again');
  const first = calls.install[0].written;
  const second = calls.install[1].written;
  assert.equal(second.serverName, first.serverName, 'the second install must not rename the row');
  assert.equal(second.rowId, first.rowId, 'the row id must not move either');
  assert.equal(second.serverName, 'notes');
});

test('installing the same entry three times still does not drift', async () => {
  seedCache();
  const { routes, calls } = makeCtx();
  for (let round = 0; round < 3; round += 1) {
    const result = await install(routes, { name: 'vendor.example/notes', optionIndex: 0, config: {} });
    assert.equal(result.status, 200, 'install ' + (round + 1) + ' must succeed');
  }
  const names = calls.install.map((callRecord) => callRecord.written.serverName);
  assert.deepEqual(names, ['notes', 'notes', 'notes']);
});

test('an update whose name another row holds is refused instead of being renamed', async () => {
  seedCache();
  const { routes, calls, rows } = makeCtx();
  await install(routes, { name: 'vendor.example/notes', optionIndex: 0, config: {} });
  // Someone else claims the name our row is using. Reusing it would collide; renaming would
  // silently break every `mcp__notes__*` reference, so neither is allowed.
  rows.push({ id: 'mcp-somebody-else', serverName: 'notes', transport: 'stdio', env: {}, headers: {} });

  const refused = await install(routes, { name: 'vendor.example/notes', optionIndex: 0, config: {} });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'identity-conflict');
  assert.match(refused.body.error.message, /notes/);
  assert.equal(calls.install.length, 1, 'a conflicting update must not reach the installer');
});

test('an entry that wants a taken name gets a unique one, and keeps it afterwards', async () => {
  seedCache();
  const { routes, calls } = makeCtx();
  await install(routes, { name: 'vendor.example/notes', optionIndex: 0, config: {} });

  const other = await install(routes, { name: 'other.example/notes', optionIndex: 0, config: {} });
  assert.equal(other.status, 200);
  const second = calls.install[1].written;
  assert.equal(second.serverName, 'notes-2', 'a different entry must not reuse the taken name');
  assert.notEqual(second.rowId, calls.install[0].written.rowId, 'and it is a different row');

  await install(routes, { name: 'other.example/notes', optionIndex: 0, config: {} });
  assert.equal(calls.install[2].written.serverName, 'notes-2', 'its own name is not a collision with itself');
});

test('the install dialog and the install agree on the identity', async () => {
  seedCache();
  const { routes, calls } = makeCtx();
  const before = await detail(routes, 'vendor.example/notes');
  assert.equal(before.body.value.identity.mode, 'fresh');
  assert.equal(before.body.value.identity.serverName, before.body.value.serverName);

  const installed = await install(routes, { name: 'vendor.example/notes', optionIndex: 0, config: {} });
  const written = calls.install[0].written;
  assert.equal(written.serverName, before.body.value.identity.serverName, 'the preview must name the row the install actually writes');
  assert.equal(written.rowId, before.body.value.identity.rowId);

  const after = await detail(routes, 'vendor.example/notes');
  assert.equal(after.body.value.identity.mode, 'update', 'once installed, the dialog plans an update');
  assert.equal(after.body.value.identity.serverName, written.serverName);
  assert.equal(after.body.value.identity.rowId, written.rowId);
  assert.equal(installed.body.value.identity.rowId, written.rowId);
});

test('an update keeps the secrets and the arguments the row already carries', async () => {
  seedCache();
  const { routes, calls } = makeCtx();
  await install(routes, { name: 'vendor.example/notes', optionIndex: 0, config: { EXAMPLE_API_KEY: 'first-secret' }, arguments: { '--out': '/tmp/out' } });
  const again = await install(routes, { name: 'vendor.example/notes', optionIndex: 0, config: {} });

  assert.equal(again.status, 200);
  const kept = calls.install[1].written;
  assert.deepEqual(kept.env, { EXAMPLE_API_KEY: 'first-secret' }, 'a reinstall must not wipe the stored secret');
  assert.match(kept.text, /- "\/tmp\/out"/, 'the argument value the row already carries must survive too');
  assert.deepEqual(again.body.value.keptConfigKeys, ['EXAMPLE_API_KEY']);
});

test('an http row keeps its header values across an update', async () => {
  seedCache();
  const { routes, calls } = makeCtx();
  await install(routes, { name: 'vendor.example/mcp', optionIndex: 0, config: { Authorization: 'Bearer first' } });
  await install(routes, { name: 'vendor.example/mcp', optionIndex: 0, config: {} });

  const kept = calls.install[1].written;
  assert.equal(kept.serverName, 'vendor-example');
  assert.deepEqual(kept.headers, { Authorization: 'Bearer first' });
});

test('a bundle on disk with no live row is reported, not counted as installed', async () => {
  seedCache();
  const { routes, calls } = makeCtx();
  // What a past install left behind when the profile change did not take effect: files on disk,
  // no row in the profile. The manifest alone is not evidence that anything is installed.
  const slug = market.slugFor('vendor.example/notes');
  mkdirSync(market.bundleDir(slug), { recursive: true });
  writeFileSync(join(market.bundleDir(slug), 'market.meta.json'), JSON.stringify({
    registryName: 'vendor.example/notes', registryVersion: '0.9.0', slug, pkg: market.BUNDLE_PREFIX + slug,
    rowId: market.ROW_PREFIX + slug, serverName: 'notes', kind: 'stdio', source: 'registry', configKeys: [], argumentValues: {},
  }));

  const preview = await detail(routes, 'vendor.example/notes');
  assert.equal(preview.body.value.identity.state, 'manifest-without-row');
  assert.match(preview.body.value.identity.detail, /no MCP row/i);

  const installed = await install(routes, { name: 'vendor.example/notes', optionIndex: 0, config: {} });
  assert.equal(installed.status, 200);
  assert.equal(installed.body.value.identity.state, 'manifest-without-row', 'the response must say what it found');
  assert.notEqual(installed.body.value.reinstalled, true, 'a row that is not in the profile is not a reinstall');
  assert.equal(calls.install[0].written.serverName, 'notes');
});
// --- the resolver on its own terms ----------------------------------------------------------
//
// The route suite above is the regression evidence: it fails on the implementation that drifted.
// These pin the contract the extraction exists for, so no route has to re-derive naming rules by
// hand — `taken` excludes the row being updated, and an update that cannot keep its name is refused
// rather than renamed.

test('resolveIdentity names a fresh row, and never repeats a taken name', () => {
  assert.deepEqual(market.resolveIdentity({ name: 'vendor.example/notes', slug: 's' }),
    { ok: true, mode: 'fresh', rowId: 'mcp-s', serverName: 'notes' });
  assert.equal(market.resolveIdentity({ name: 'vendor.example/notes', slug: 's', taken: ['notes'] }).serverName, 'notes-2');
  const taken = ['notes', 'notes-2', 'notes-3'];
  const chosen = market.resolveIdentity({ name: 'vendor.example/notes', slug: 's', taken }).serverName;
  assert.equal(taken.includes(chosen), false, 'a fresh row may not take a name that is already held');
});

test('resolveIdentity keeps the id and the name an existing row already has', () => {
  const resolved = market.resolveIdentity({
    name: 'vendor.example/notes', slug: 's', taken: ['other'], current: { rowId: 'mcp-s', serverName: 'notes' },
  });
  assert.deepEqual(resolved, { ok: true, mode: 'update', rowId: 'mcp-s', serverName: 'notes' });
});

test('resolveIdentity refuses to rename a row whose name another row took', () => {
  const refused = market.resolveIdentity({
    name: 'vendor.example/notes', slug: 's', taken: ['notes'], current: { rowId: 'mcp-s', serverName: 'notes' },
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.mode, 'update');
  assert.equal(refused.serverName, 'notes', 'the identity it refused to move is still reported');
  assert.match(refused.reason, /another MCP row/);
  assert.doesNotMatch(refused.reason, /notes-2/, 'a replacement name is never proposed');
});

test('resolveIdentity refuses an identity it cannot reuse as it stands', () => {
  for (const serverName of ['', '   ', 'has space', 'x'.repeat(33)]) {
    const refused = market.resolveIdentity({ name: 'vendor.example/notes', slug: 's', current: { rowId: 'mcp-s', serverName } });
    assert.equal(refused.ok, false, JSON.stringify(serverName) + ' is not a reusable identity');
    assert.notEqual(refused.reason, '');
  }
});
