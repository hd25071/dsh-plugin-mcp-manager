// What the installer actually said, versus what this route used to answer.
//
// `pluginManager.change()` catches every operation failure, folds it into the result and RESOLVES
// (dsh-plugin-manager lib/types/index.js:814-836). So a rejected promise is not how an install
// fails — `application: 'failed'` is. This route only ever awaited the promise, so every failed
// install answered HTTP 200 {ok: true} and left a bundle on disk that the market then listed as
// installed. These cases pin the classification instead: only the two values the declared
// ChangeResult contract means as success may be reported as success, and a failure may not touch
// anything on disk.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'mcpm-result-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const host = await import('../index.js');
const market = await import('../market.js');

beforeEach(() => {
  rmSync(market.MARKET_ROOT, { recursive: true, force: true });
  rmSync(market.CACHE_DIR, { recursive: true, force: true });
  market.resetCatalog();
});

const ENTRY = 'vendor.example/notes';

function seedCache() {
  mkdirSync(dirname(market.CACHE_PATH), { recursive: true });
  writeFileSync(market.CACHE_PATH, JSON.stringify({
    cacheVersion: market.CACHE_VERSION,
    fetchedAt: new Date().toISOString(),
    count: 1,
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

/**
 * A profile whose manager answers the way the real one does.
 *
 * `result` is what `installBundle` resolves with. `verified` controls the two reads a
 * post-install check needs: the live rows (configEditor) and the persisted bundles (listBundles).
 */
function makeCtx(options = {}) {
  const { throws = false, rows = 'live', bundles = 'installed' } = options;
  // `Object.hasOwn`, not a default parameter: one of the cases below is an explicit `undefined`,
  // and a default would quietly replace exactly the value under test.
  const result = Object.hasOwn(options, 'result') ? options.result : { application: 'applied' };
  const routes = new Map();
  const calls = { install: [], remove: [] };
  const rowId = market.rowIdForSlug(market.slugFor(ENTRY));
  const serverName = 'notes';
  const ctx = {
    get(key) {
      if (key === 'connection') return { fetch: { register(spec) { routes.set(spec.path, spec); } } };
      if (key === 'pluginManager') {
        const manager = {
          async installBundle(dir, options) {
            calls.install.push({ dir, options });
            if (throws) throw new Error('the installer exploded');
            return result;
          },
          async removeBundle(name) { calls.remove.push(name); return { exitCode: 0 }; },
        };
        if (bundles !== 'unavailable') {
          manager.listBundles = () => (bundles === 'installed'
            ? [{ name: market.BUNDLE_PREFIX + market.slugFor(ENTRY), installed: true, enabled: true, removable: true, rows: [{ rowId, moduleName: host.MCP_MODULE }] }]
            : [{ name: market.BUNDLE_PREFIX + market.slugFor(ENTRY), installed: false, enabled: false, removable: false, rows: [] }]);
        }
        return manager;
      }
      if (key === 'configEditor') {
        if (rows === 'unavailable') return undefined;
        return {
          configuration() {
            if (rows === 'throws') throw new Error('the profile could not be read');
            if (rows === 'empty') return [];
            return [{
              entry: { options: { id: rowId, name: host.MCP_MODULE } },
              inherited: {}, override: { transport: 'stdio', serverName },
            }];
          },
        };
      }
      return undefined;
    },
  };
  host.apply(ctx);
  return { routes, calls, rowId };
}

const post = (payload) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
const install = async (routes, payload = { name: ENTRY, optionIndex: 0, config: {} }) => {
  const response = await routes.get(host.MARKET_INSTALL_PATH).fetch(new Request('http://local' + host.MARKET_INSTALL_PATH, post(payload)));
  return { status: response.status, body: await response.json() };
};

/**
 * What a refused install leaves behind: nothing of its own.
 *
 * P2-3A identified the orphan; P2-3B puts it back. The install is staged and journalled, so a
 * failure it can undo is undone — the published directory goes, and the market stops listing a
 * bundle no successful install backs. What must NOT happen is deleting something it cannot prove
 * is its own; the attention paths cover exactly that case instead.
 */
function assertRolledBack(dir) {
  assert.equal(existsSync(dir), false, 'the failed install leaves no bundle behind');
  assert.equal(existsSync(market.bundleDir(market.slugFor(ENTRY))), false);
  assert.deepEqual(market.listInstalled(), [], 'and the market does not list it as installed');
}

// --- the values the contract means as failure ------------------------------------------------

test('application failed resolves normally and must not be reported as success', async () => {
  seedCache();
  const { routes, calls } = makeCtx({ result: { application: 'failed', error: { code: 'operation-error', diagnostic: 'pnpm exited 1' }, failedAt: 'registry' } });
  const refused = await install(routes);
  assert.notEqual(refused.body.ok, true, 'a failed install must never answer ok: true');
  assert.equal(refused.status, 502);
  assert.equal(refused.body.error.code, 'install-failed');
  assert.match(refused.body.error.message, /pnpm exited 1/, 'the installer diagnostic reaches the caller');
  assert.match(refused.body.error.message, /operation-error/);
  assert.equal(refused.body.value.install.application, 'failed');
  assert.equal(refused.body.value.phase, 'ROLLED_BACK', 'a failure the transaction could undo says so');
  assert.equal(refused.body.value.rollback.previousRestored, false, 'a first install has no previous version');
  assertRolledBack(calls.install[0].dir);
});

test('application cancelled is refused', async () => {
  seedCache();
  const { routes, calls } = makeCtx({ result: { application: 'cancelled' } });
  const refused = await install(routes);
  assert.notEqual(refused.body.ok, true);
  assert.equal(refused.status, 502);
  assert.equal(refused.body.error.code, 'install-cancelled');
  assert.equal(refused.body.value.phase, 'ROLLED_BACK');
  assertRolledBack(calls.install[0].dir);
});

test('application overridden is not a success for an install', async () => {
  seedCache();
  const { routes, calls } = makeCtx({ result: { application: 'overridden' } });
  const refused = await install(routes);
  assert.notEqual(refused.body.ok, true);
  assert.equal(refused.status, 502);
  assert.equal(refused.body.error.code, 'install-overridden');
  assertRolledBack(calls.install[0].dir);
});

test('an application value outside the contract is refused rather than assumed good', async () => {
  seedCache();
  const { routes, calls } = makeCtx({ result: { application: 'teleported' } });
  const refused = await install(routes);
  assert.notEqual(refused.body.ok, true);
  assert.equal(refused.status, 502);
  assert.equal(refused.body.error.code, 'install-result-unknown');
  assert.match(refused.body.error.message, /teleported/);
  assertRolledBack(calls.install[0].dir);
});

test('a result that is not a ChangeResult at all is refused', async () => {
  for (const result of [{ exitCode: 0 }, {}, null, undefined, 'ok', 7]) {
    seedCache();
    const { routes, calls } = makeCtx({ result });
    const refused = await install(routes);
    assert.notEqual(refused.body.ok, true, JSON.stringify(result) + ' must not be read as success');
    assert.equal(refused.body.error.code, 'install-result-unverified', JSON.stringify(result));
    assertRolledBack(calls.install[0].dir);
  }
});

test('an installer that really throws is still a failure', async () => {
  seedCache();
  const { routes, calls } = makeCtx({ throws: true });
  const refused = await install(routes);
  assert.notEqual(refused.body.ok, true);
  assert.equal(refused.status, 502);
  assert.equal(refused.body.error.code, 'install-failed');
  assert.match(refused.body.error.message, /exploded/);
  assertRolledBack(calls.install[0].dir);
});

// --- no destructive cleanup exists on any failure path ----------------------------------------

test('a refused install never uninstalls anything, and takes its own bundle with it', async () => {
  seedCache();
  const { routes, calls } = makeCtx({ result: { application: 'failed', error: { code: 'operation-error', diagnostic: 'nope' } } });
  await install(routes);
  assert.deepEqual(calls.remove, [], 'no uninstall is attempted without proof that it is safe');
  // The rollback removes the directory it published because the manifest in it carries this
  // transaction's id — proof of ownership, not a guess — and it never calls removeBundle.
  assertRolledBack(calls.install[0].dir);
});

// --- the values the contract means as success --------------------------------------------------

test('application applied is a success, and reports what was verified', async () => {
  seedCache();
  const { routes } = makeCtx({ result: { application: 'applied' } });
  const installed = await install(routes);
  assert.equal(installed.status, 200);
  assert.equal(installed.body.ok, true);
  assert.equal(installed.body.value.install.application, 'applied');
  // This fixture's installer never changes the row, so the row in the running configuration is
  // still the one that was there before. Reporting that as live was the over-claim P2-3B fixes:
  // the change is persisted, and the process has not picked it up.
  assert.equal(installed.body.value.runtime.state, 'stale');
  assert.equal(installed.body.value.verification.state, 'persisted');
  assert.equal(installed.body.value.verification.verified, false);
  assert.equal(installed.body.value.outcome, 'persisted-not-live');
});

test('an install whose profile cannot be read is not called live either', async () => {
  seedCache();
  const { routes } = makeCtx({ result: { application: 'applied' }, rows: 'unavailable' });
  const installed = await install(routes);
  assert.equal(installed.status, 200);
  assert.equal(installed.body.value.runtime.state, 'unknown', 'an unreadable profile is not a matching one');
  assert.notEqual(installed.body.value.outcome, 'applied');
});

test('application restart-required is a success, and is not confused with live', async () => {
  seedCache();
  // No HMR: the change is persisted but the running configuration will not show it until reload.
  const { routes } = makeCtx({ result: { application: 'restart-required' }, rows: 'empty' });
  const installed = await install(routes);
  assert.equal(installed.status, 200);
  assert.equal(installed.body.ok, true);
  assert.equal(installed.body.value.verification.state, 'persisted',
    'persisted is not the same claim as live, and must not be reported as one');
});

test('a claim of success the profile contradicts is refused', async () => {
  seedCache();
  const { routes, calls } = makeCtx({ result: { application: 'applied' }, bundles: 'absent' });
  const refused = await install(routes);
  assert.notEqual(refused.body.ok, true, 'the persisted profile does not have it, so nothing succeeded');
  assert.equal(refused.status, 500);
  assert.equal(refused.body.error.code, 'install-not-applied');
  assert.equal(refused.body.value.phase, 'ROLLED_BACK');
  assertRolledBack(calls.install[0].dir);
});

// --- when the profile cannot be read, nothing may be claimed -----------------------------------

test('with no config editor the install is not claimed as verified', async () => {
  seedCache();
  const { routes } = makeCtx({ result: { application: 'applied' }, rows: 'unavailable' });
  const installed = await install(routes);
  assert.equal(installed.status, 200);
  assert.equal(installed.body.ok, true);
  assert.equal(installed.body.value.verification.state, 'unavailable');
  assert.equal(installed.body.value.verification.verified, false, 'an unreadable profile proves nothing');
  assert.match(installed.body.value.verification.reason, /configEditor|profile/i);
});

test('when the bundle listing cannot be read, the install is not claimed as verified', async () => {
  seedCache();
  const { routes } = makeCtx({ result: { application: 'applied' }, bundles: 'unavailable' });
  const installed = await install(routes);
  assert.equal(installed.body.ok, true);
  assert.equal(installed.body.value.verification.state, 'unavailable');
  assert.equal(installed.body.value.verification.verified, false);
});

test('a profile read that throws degrades to unverified instead of fabricating a verdict', async () => {
  seedCache();
  const { routes } = makeCtx({ result: { application: 'applied' }, rows: 'throws' });
  const installed = await install(routes);
  assert.equal(installed.body.ok, true);
  assert.equal(installed.body.value.verification.state, 'unavailable');
  assert.equal(installed.body.value.verification.verified, false);
});

// --- the classifier itself ---------------------------------------------------------------------

test('installOutcome reads only the two success values as success', () => {
  for (const application of ['applied', 'restart-required']) {
    const outcome = market.installOutcome({ application });
    assert.equal(outcome.ok, true, application + ' is a success value');
    assert.equal(outcome.application, application);
  }
  for (const application of ['failed', 'cancelled', 'overridden', 'teleported', '']) {
    const outcome = market.installOutcome({ application });
    assert.equal(outcome.ok, false, application + ' must not be success');
    assert.notEqual(outcome.code, '');
  }
  for (const result of [undefined, null, 0, 'x', [], {}]) {
    assert.equal(market.installOutcome(result).ok, false, JSON.stringify(result) + ' must not be success');
  }
  assert.equal(market.installOutcome({ application: 'failed', error: { code: 'incompatible-version', diagnostic: 'peer mismatch' } }).diagnostic, 'peer mismatch');
});
