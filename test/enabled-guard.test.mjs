// The toggle must not reach a row this plugin does not own.
//
// `setPluginEnabled` acts on whatever id it is given, so without a scope check this route can
// stop any plugin in the profile. Two things are asserted for every refusal: the status, and the
// manager never being called. The second is the one that matters — a refusal that still stopped
// the plugin is the defect, not the fix.
//
// The scope check needs the row list, which only `configEditor` has. When that service is absent
// the target cannot be proven to be an MCP row, so the route has to fail closed instead of acting
// on an unchecked id.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'mcpm-enabled-guard-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const host = await import('../index.js');

const MCP_ROW = { options: { id: 'mcp-vendor-notes', name: '@deepseek-ai/dsh-mcp-client' } };
const OTHER_ROW = { options: { id: 'other-plugin', name: 'dsh-plugin-other' } };

/** A profile mounting the two services this route needs, with the toggles recorded. */
function makeCtx({ rows = [OTHER_ROW, MCP_ROW], editor = 'with-entries' } = {}) {
  const routes = new Map();
  const calls = { toggle: [] };
  const ctx = {
    get(key) {
      if (key === 'connection') return { fetch: { register(spec) { routes.set(spec.path, spec); } } };
      if (key === 'pluginManager') {
        return { async setPluginEnabled(id, enabled) { calls.toggle.push({ id, enabled }); return { ok: true }; } };
      }
      if (key === 'configEditor') {
        if (editor === false) return undefined;
        if (editor === 'no-entries') return { async edit() { return null; } };
        return { entries() { return rows; } };
      }
      return undefined;
    },
  };
  host.apply(ctx);
  return { routes, calls };
}

const post = (payload) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
const call = async (routes, payload) => {
  const response = await routes.get(host.ENABLED_PATH).fetch(new Request('http://local' + host.ENABLED_PATH, post(payload)));
  return { status: response.status, body: await response.json() };
};

beforeEach(() => {
  rmSync(join(home, '.dsh'), { recursive: true, force: true });
});

test('disabling another plugin through this route is refused, and the manager is never asked', async () => {
  const { routes, calls } = makeCtx();
  const refused = await call(routes, { id: 'other-plugin', enabled: false });
  assert.equal(refused.status, 404);
  assert.equal(refused.body.error.code, 'entry-not-found');
  assert.equal(calls.toggle.length, 0, 'no plugin outside this one\'s rows may be toggled');
});

test('another plugin\'s row is refused even when no MCP row exists at all', async () => {
  const { routes, calls } = makeCtx({ rows: [OTHER_ROW] });
  const refused = await call(routes, { id: 'other-plugin', enabled: false });
  assert.equal(refused.status, 404);
  assert.equal(calls.toggle.length, 0);
});

test('without the config editor the toggle is refused instead of acting on an unchecked id', async () => {
  const { routes, calls } = makeCtx({ editor: false });
  const refused = await call(routes, { id: 'mcp-vendor-notes', enabled: false });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error.code, 'service-unavailable');
  assert.equal(calls.toggle.length, 0, 'an unverifiable target must not be toggled');
});

test('an editor without a row listing is refused the same way', async () => {
  const { routes, calls } = makeCtx({ editor: 'no-entries' });
  const refused = await call(routes, { id: 'mcp-vendor-notes', enabled: false });
  assert.equal(refused.status, 503);
  assert.equal(calls.toggle.length, 0);
});

test('an MCP row is still toggled', async () => {
  const { routes, calls } = makeCtx();
  const toggled = await call(routes, { id: 'mcp-vendor-notes', enabled: false });
  assert.equal(toggled.status, 200);
  assert.deepEqual(calls.toggle, [{ id: 'mcp-vendor-notes', enabled: false }]);
  assert.equal(toggled.body.value.enabled, false);
});

test('with no plugin manager the route still answers 503', async () => {
  const routes = new Map();
  host.apply({ get(key) { return key === 'connection' ? { fetch: { register(spec) { routes.set(spec.path, spec); } } } : undefined; } });
  const refused = await call(routes, { id: 'mcp-vendor-notes', enabled: false });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error.code, 'service-unavailable');
});
