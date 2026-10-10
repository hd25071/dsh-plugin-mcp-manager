// YAML keys are structure, not values.
//
// A value goes through JSON escaping, which is also valid YAML, so a value can never change the
// shape of the document. A key was interpolated bare, and a key is the left-hand side of the
// mapping — a newline, a colon or a stray dash in one can add an entry that was never declared,
// move one, or break the document outright. The keys here come from third-party data: the
// registry's `environmentVariables[].name` and `remotes[].headers[].name`, a local entry file, or
// an mcpb package's manifest.
//
// Every generated patch in this file is read back with a real YAML parser, so "the configuration
// is what was asked for" is answered by the YAML document, not by a regular expression over the
// text that produced it.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

const home = mkdtempSync(join(tmpdir(), 'mcpm-keys-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const host = await import('../index.js');
const market = await import('../market.js');

beforeEach(() => {
  rmSync(market.MARKET_ROOT, { recursive: true, force: true });
  rmSync(market.CACHE_DIR, { recursive: true, force: true });
  market.resetCatalog();
});

/** Keys whose meaning stops being "one entry" once they land in a YAML mapping. */
const HOSTILE_ENV_KEYS = {
  'has a newline that indents a sibling entry in': 'EVIL\n          INJECTED',
  'closes the key and opens another': 'A": "b',
  'is empty': '',
  'starts with a digit': '1LEADING',
  'contains a space': 'HAS SPACE',
  'contains a control character': 'CTRL\u0001X',
  'contains a dash prefix': '- EVIL',
  'contains a yaml comment marker': 'A # B',
};
const HOSTILE_HEADER_KEYS = {
  'has a newline that indents a sibling entry in': 'X-Evil\n  INJECTED',
  'contains a space': 'X Evil',
  'contains a colon': 'X:Evil',
};

const seedCache = ({ envNames = ['EXAMPLE_API_KEY'], headerNames = [] } = {}) => {
  mkdirSync(dirname(market.CACHE_PATH), { recursive: true });
  const variable = (name) => ({ name, description: '', isRequired: false, isSecret: false, default: '' });
  writeFileSync(market.CACHE_PATH, JSON.stringify({
    cacheVersion: market.CACHE_VERSION,
    fetchedAt: new Date().toISOString(),
    count: 2,
    servers: [
      {
        name: 'vendor.example/env', title: 'Env Server', description: 'a stdio entry', version: '1.0.0',
        publishedAt: '2026-01-01T00:00:00Z', remotes: [],
        packages: [{
          registryType: 'npm', identifier: '@example/env', version: '1.0.0', transport: 'stdio',
          environmentVariables: envNames.map(variable), packageArguments: [],
        }],
      },
      {
        name: 'vendor.example/http', title: 'Http Server', description: 'a remote entry', version: '1.0.0',
        publishedAt: '2026-01-01T00:00:00Z', packages: [],
        remotes: [{ type: 'streamable-http', url: 'https://vendor.example/mcp', headers: headerNames.map(variable) }],
      },
    ],
  }));
  market.resetCatalog();
};

/** A context that records what reaches the installer and writes nothing itself. */
function makeCtx() {
  const routes = new Map();
  const calls = [];
  const ctx = {
    get(key) {
      if (key === 'connection') return { fetch: { register(spec) { routes.set(spec.path, spec); } } };
      if (key === 'pluginManager') return { async installBundle(dir) { calls.push(dir); return { application: 'applied' }; } };
      return undefined;
    },
  };
  host.apply(ctx);
  return { routes, calls };
}

const post = (payload) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
const install = async (routes, payload) => {
  const response = await routes.get(host.MARKET_INSTALL_PATH).fetch(new Request('http://local' + host.MARKET_INSTALL_PATH, post(payload)));
  return { status: response.status, body: await response.json() };
};

/** One plan, computed the same way the route computes it. */
function planFor(name, index = 0) {
  const { options } = market.plansFor(market.findServer(name), market.detectRuntimes());
  return options[index];
}

/** The single row a generated patch declares, as the YAML parser reads it. */
function parsedRow(dir) {
  const doc = yaml.load(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'));
  assert.equal(Array.isArray(doc), true, 'a patch is a YAML sequence');
  assert.equal(Array.isArray(doc[0].insert), true, 'whose first entry inserts rows');
  return doc[0].insert[0];
}

/** Nothing of this bundle may exist after a refused install. */
function assertNothingWritten(slug) {
  const dir = market.bundleDir(slug);
  for (const file of ['cordis.patch.yml', 'market.meta.json', 'package.json']) {
    assert.equal(existsSync(join(dir, file)), false, file + ' must not be written for a refused install');
  }
}

test('a stdio install parses back to exactly the environment it was given', () => {
  seedCache({ envNames: ['EXAMPLE_API_KEY', 'SECOND_KEY'] });
  const { routes, calls } = makeCtx();
  return install(routes, { name: 'vendor.example/env', optionIndex: 0, config: { EXAMPLE_API_KEY: 'abc123', SECOND_KEY: 'two' } })
    .then((installed) => {
      assert.equal(installed.status, 200);
      assert.equal(calls.length, 1);
      const row = parsedRow(calls[0]);
      assert.equal(row.config.serverName, 'env');
      assert.equal(row.config.transport, 'stdio');
      assert.equal(row.config.env.EXAMPLE_API_KEY, 'abc123');
      assert.equal(row.config.env.SECOND_KEY, 'two');
      // The plan's own entries plus the two declared ones — nothing else, and nothing missing.
      const expected = [...Object.keys(planFor('vendor.example/env').env), 'EXAMPLE_API_KEY', 'SECOND_KEY'].sort();
      assert.deepEqual(Object.keys(row.config.env).sort(), expected);
    });
});

test('an http install parses back to exactly the headers it was given', async () => {
  seedCache({ headerNames: ['Authorization'] });
  const { routes, calls } = makeCtx();
  const installed = await install(routes, { name: 'vendor.example/http', optionIndex: 0, config: { Authorization: 'Bearer t' } });
  assert.equal(installed.status, 200);
  const row = parsedRow(calls[0]);
  assert.equal(row.config.transport, 'streamable-http');
  assert.equal(row.config.url, 'https://vendor.example/mcp');
  assert.equal(row.config.headers.Authorization, 'Bearer t');
  const expected = [...Object.keys(planFor('vendor.example/http').headers), 'Authorization'].sort();
  assert.deepEqual(Object.keys(row.config.headers).sort(), expected);
});

for (const [label, key] of Object.entries(HOSTILE_ENV_KEYS)) {
  test(`an env key that ${label} is refused, and nothing is written`, async () => {
    seedCache({ envNames: [key] });
    const { routes, calls } = makeCtx();
    const refused = await install(routes, { name: 'vendor.example/env', optionIndex: 0, config: { [key]: 'v' } });
    assert.equal(refused.status, 400, JSON.stringify(key) + ' must not be installed');
    assert.equal(refused.body.error.code, 'invalid-config-key');
    assert.equal(calls.length, 0, 'a refused install must not reach the installer');
    assertNothingWritten(market.slugFor('vendor.example/env'));
    // The refusal is quoted back safely, so a control character cannot wreck the response either.
    assert.equal(String(refused.body.error.message).includes('\n'), false);
  });
}

for (const [label, key] of Object.entries(HOSTILE_HEADER_KEYS)) {
  test(`a header name that ${label} is refused, and nothing is written`, async () => {
    seedCache({ headerNames: [key] });
    const { routes, calls } = makeCtx();
    const refused = await install(routes, { name: 'vendor.example/http', optionIndex: 0, config: { [key]: 'v' } });
    assert.equal(refused.status, 400, JSON.stringify(key) + ' must not be installed');
    assert.equal(refused.body.error.code, 'invalid-config-key');
    assert.equal(calls.length, 0);
    assertNothingWritten(market.slugFor('vendor.example/http'));
  });
}

test('two header names that differ only in case are refused', async () => {
  seedCache({ headerNames: ['Authorization', 'authorization'] });
  const { routes, calls } = makeCtx();
  const refused = await install(routes, { name: 'vendor.example/http', optionIndex: 0, config: { Authorization: 'a', authorization: 'b' } });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, 'invalid-config-key');
  assert.match(refused.body.error.message, /case-insensitive/i);
  assert.equal(calls.length, 0);
});

test('legal names are accepted, including the header characters that are easy to over-reject', () => {
  assert.equal(market.checkBlockKeys('env', { EXAMPLE_API_KEY: 'v', _private: 'v', A1: 'v' }).ok, true);
  // RFC 9110 field-name is a token: hyphens, dots, and `!#$%&'*+.^_`|~` are all legal.
  // RFC 9110 field-name is a token: hyphens, dots, and `!#$%&'*+.^_`|~` are all legal. Refusing
  // any of them would break real headers, which is the failure mode worse than the one being fixed.
  for (const name of ['X-Api-Key', 'If-None-Match', 'X.Custom.Header', "X-Weird!#$%&'*+^_`|~", 'ETag', 'X#Evil']) {
    assert.equal(market.checkBlockKeys('headers', { [name]: 'v' }).ok, true, name + ' must be accepted');
  }
  // ...and those names still reach the file as keys, quoted rather than bare where they must be.
  const rendered = market.renderPatch({ rowId: 'mcp-x', serverName: 'x', plan: { transport: 'streamable-http', url: 'https://x.example/mcp', headers: {} }, args: [], config: { 'X#Evil': 'v' } });
  const parsed = yaml.load(rendered)[0].insert[0].config;
  assert.deepEqual(parsed.headers, { 'X#Evil': 'v' }, 'a legal but unusual header name must survive the round trip');
});

test('an empty or non-object block is refused rather than spread into index keys', () => {
  for (const block of [null, undefined, 'KEY=v', ['KEY'], 7]) {
    const refused = market.checkBlockKeys('env', block);
    assert.equal(refused.ok, false, JSON.stringify(block) + ' must not be treated as a key block');
    assert.equal(refused.code, 'invalid-config-key');
  }
});

test('renderPatch refuses a key it would otherwise have to write bare', () => {
  seedCache();
  const plan = planFor('vendor.example/env');
  const args = [];
  for (const key of Object.keys(HOSTILE_ENV_KEYS)) {
    assert.throws(
      () => market.renderPatch({ rowId: 'mcp-x', serverName: 'x', plan, args, config: { [key]: 'v' } }),
      /invalid-config-key/,
      JSON.stringify(key) + ' must not be rendered into a patch',
    );
  }
});

test('the block a patch writes is the block the check reads', () => {
  seedCache({ headerNames: ['Authorization'] });
  const plan = planFor('vendor.example/env');
  const block = market.configBlockFor(plan, { EXAMPLE_API_KEY: 'v' });
  assert.equal(block.kind, 'env');
  assert.equal(block.values.EXAMPLE_API_KEY, 'v');
  assert.equal(planFor('vendor.example/http').transport, 'streamable-http');
  const remote = market.configBlockFor(planFor('vendor.example/http'), { Authorization: 'v' });
  assert.equal(remote.kind, 'headers');
  assert.equal(remote.values.Authorization, 'v');
});
