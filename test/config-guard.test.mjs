// The config write must not reach a row this plugin does not own.
//
// The id is chosen by the caller, and `configEditor.edit` rewrites whatever entry it is handed.
// A lookup keyed on the id alone therefore lets any plugin's configuration be rewritten through
// this plugin's route. The module check is the boundary, and it is asserted here by watching the
// editor rather than by reading the status code alone: a 404 that still called `edit` would be
// the same defect wearing a different number.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'mcpm-config-guard-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const host = await import('../index.js');

const MCP_ROW = { options: { id: 'mcp-vendor-notes', name: '@deepseek-ai/dsh-mcp-client' } };
const OTHER_ROW = { options: { id: 'other-plugin', name: 'dsh-plugin-other' } };

/** A profile mounting the two services this route needs, with the writes recorded. */
function makeCtx({ rows = [OTHER_ROW, MCP_ROW], editor = true } = {}) {
  const routes = new Map();
  const calls = { edit: [] };
  const ctx = {
    get(key) {
      if (key === 'connection') return { fetch: { register(spec) { routes.set(spec.path, spec); } } };
      if (key === 'configEditor' && editor) {
        return {
          entries() { return rows; },
          async edit(entry, change) { calls.edit.push({ entry, change }); return { applied: true }; },
        };
      }
      return undefined;
    },
  };
  host.apply(ctx);
  return { routes, calls };
}

const post = (payload) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
const call = async (routes, payload) => {
  const response = await routes.get(host.CONFIG_PATH).fetch(new Request('http://local' + host.CONFIG_PATH, post(payload)));
  return { status: response.status, body: await response.json() };
};

beforeEach(() => {
  rmSync(join(home, '.dsh'), { recursive: true, force: true });
});

test('a config write to another plugin\'s row is refused, and the editor is never asked', async () => {
  const { routes, calls } = makeCtx();
  const refused = await call(routes, { id: 'other-plugin', config: { command: 'anything' } });
  assert.equal(refused.status, 404);
  assert.equal(refused.body.error.code, 'entry-not-found');
  assert.equal(calls.edit.length, 0, 'the editor must not be handed a row this plugin does not own');
});

test('a reset aimed at another plugin\'s row is refused the same way', async () => {
  const { routes, calls } = makeCtx();
  // `reset` needs no config object, so it is a second way into the same write.
  const refused = await call(routes, { id: 'other-plugin', reset: true });
  assert.equal(refused.status, 404);
  assert.equal(calls.edit.length, 0);
});

test('another plugin\'s row is refused even when no MCP row exists at all', async () => {
  const { routes, calls } = makeCtx({ rows: [OTHER_ROW] });
  const refused = await call(routes, { id: 'other-plugin', config: { command: 'anything' } });
  assert.equal(refused.status, 404);
  assert.equal(calls.edit.length, 0, 'an empty MCP inventory is not permission to write elsewhere');
});

test('an MCP row is still written through the editor', async () => {
  const { routes, calls } = makeCtx();
  const written = await call(routes, { id: 'mcp-vendor-notes', config: { url: 'https://new' } });
  assert.equal(written.status, 200);
  assert.equal(calls.edit.length, 1);
  assert.equal(calls.edit[0].entry, MCP_ROW, 'the row handed to the editor is the MCP one');
  // The composed override is what gets persisted, so the write is proven and not merely counted.
  assert.deepEqual(calls.edit[0].change({ url: 'https://old' }, { url: 'https://inherited' }), { url: 'https://new' });
});

test('with no config editor the route still answers 503 rather than throwing', async () => {
  const { routes, calls } = makeCtx({ editor: false });
  const refused = await call(routes, { id: 'mcp-vendor-notes', config: { url: 'https://new' } });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error.code, 'service-unavailable');
  assert.equal(calls.edit.length, 0);
});
