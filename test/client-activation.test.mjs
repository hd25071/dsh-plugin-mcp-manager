/**
 * Activation regression test for the browser half.
 *
 * Why this exists: a client bundle whose `apply()` throws does not merely
 * disable itself. The Web shell reports
 *
 *     Error: web boot: 1 entry did not activate
 *     dsh-plugin-mcp-manager: failed
 *
 * and **refuses to boot at all** — the crash log lands in
 * `%APPDATA%/@deepseek-ai/dsh-desktop/logs/crash-*-web-boot.log`, and DSH's only
 * way back is the "remove third-party plugins and restart" recovery, which
 * discards `dsh.profile.bundles` and the user's whole `cordis.patch.yml` layer.
 *
 * The defect this pins down: Cordis resolves a service only along the plugin's
 * injected ancestry, so a plain `ctx.foo` read for anything missing from
 * `inject` **throws** (`cannot get property "foo" without inject`) rather than
 * yielding undefined — a guard like `ctx.foo || null` therefore never runs.
 * Optional services are acquired with `ctx.inject(names, scope => …)`, which
 * activates the child scope only when every named service exists.
 *
 * The context below reproduces both rules, so this test fails loudly if either
 * regresses.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(HERE, '..', 'client.js');
const SOURCE = fs.readFileSync(BUNDLE, 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));

/**
 * Minimal React surface: the factory only *defines* components at load time.
 *
 * @returns the shim.
 */
function reactShim() {
  return {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect() {},
    useLayoutEffect() {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value })
  };
}

/**
 * Load the bundle and return its exports plus everything it did.
 *
 * @param options - test seams.
 * @param options.services - what the context provides.
 * @param options.registerThrows - make the tab-type registration throw.
 * @returns the captured state.
 */
function load(options = {}) {
  const calls = {
    slotInjections: [],
    slotRegistrations: [],
    effects: [],
    injectNames: [],
    scopes: [],
    tabTypes: []
  };
  let registered;

  const windowStub = {
    __ModuleLoader__: {
      load(record) {
        registered = record;
      }
    }
  };
  const documentStub = {
    head: { appendChild() {} },
    body: { appendChild() {}, removeChild() {} },
    createElement: () => ({ style: {}, dataset: {}, remove() {}, appendChild() {}, setAttribute() {} })
  };

  const run = new Function('window', 'document', 'navigator', 'fetch', 'console', SOURCE);
  run(windowStub, documentStub, { clipboard: { writeText: async () => {} } }, async () => new Response('{"ok":true,"value":{}}', { status: 200 }), {
    warn() {},
    error() {},
    log() {}
  });

  assert.ok(registered !== undefined, 'the bundle registers a module loader factory');
  const exports = registered.factory((specifier) => {
    assert.equal(specifier, 'react', `unexpected require: ${specifier}`);
    return reactShim();
  });

  const slots = {
    inject(name, callback) {
      calls.slotInjections.push(name);
      callback();
      return () => {};
    },
    register(definition, component) {
      calls.slotRegistrations.push({ name: definition.name, key: definition.key, component });
      return { definition };
    }
  };
  const effect = (fn) => {
    calls.effects.push(fn);
    const dispose = fn();
    return typeof dispose === 'function' ? dispose : () => {};
  };

  const services = {
    // The right dock, as shipped by dsh-client-ui-sidebar-browser.
    sidebarRight: { openTab: () => {}, openTabs: { getSnapshot: () => [] } },
    sidebarRightTabs: {
      register(definition) {
        calls.tabTypes.push(definition);
        if (options.registerThrows === true) throw new Error('tab type rejected');
        return () => {};
      }
    },
    ...(options.services ?? {})
  };
  // `null` means "this service is not mounted", which is how a caller removes one.
  for (const [name, value] of Object.entries(services)) {
    if (value === null) delete services[name];
  }

  const base = {
    effect,
    slots,
    /**
     * Cordis's `ctx.inject`: run the callback in a child scope once every named
     * service exists, and never otherwise.
     */
    inject(names, callback) {
      calls.injectNames.push(names);
      const missing = names.filter((name) => services[name] === undefined);
      if (missing.length > 0) return () => {};
      const scope = { effect, slots };
      for (const name of names) scope[name] = services[name];
      calls.scopes.push(scope);
      const dispose = callback(scope);
      return typeof dispose === 'function' ? dispose : () => {};
    }
  };

  // The decisive part: exactly Cordis's rule for a non-injected service.
  const ctx = new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || prop in target) return Reflect.get(target, prop, receiver);
      throw new Error(`cannot get property "${String(prop)}" without inject`);
    }
  });

  return { registered, exports, ctx, calls };
}

test('the factory id and export shape match the manifest', () => {
  const { registered, exports } = load();
  assert.equal(registered.id, MANIFEST.name, 'the factory id must equal the package name');
  assert.deepEqual(exports.inject, ['slots']);
  assert.equal(typeof exports.apply, 'function');
});

test('apply() survives a context that throws on any non-injected service read', () => {
  const { exports, ctx } = load();
  // A throw here is what produces "web boot: 1 entry did not activate".
  assert.doesNotThrow(() => exports.apply(ctx));
});

test('the manager page registers on the bundle key the Plugins page dispatches', () => {
  const { exports, ctx, calls } = load();
  exports.apply(ctx);
  const page = calls.slotRegistrations.find((entry) => entry.name === 'plugins.bundle.config');
  assert.ok(page !== undefined, 'the manager page is contributed');
  assert.equal(page.key, MANIFEST.name, 'keyed by the bundle package name');
  assert.equal(typeof page.component, 'function');
});

test('the right dock present: the tab type, the pane body and the title all register', () => {
  const { exports, ctx, calls } = load();
  exports.apply(ctx);

  assert.deepEqual(calls.injectNames, [['sidebarRight', 'sidebarRightTabs']]);
  assert.equal(calls.scopes.length, 1, 'the child scope activates');

  const [tabType] = calls.tabTypes;
  assert.ok(tabType !== undefined, 'a right-dock tab type is registered');
  assert.equal(tabType.id, MANIFEST.name);
  assert.equal(typeof tabType.kind, 'string');
  assert.equal(typeof tabType.title, 'function');
  assert.equal(tabType.keepMounted, true);

  const pane = calls.slotRegistrations.find((entry) => entry.name === 'sidebar.right.pane.tab');
  const title = calls.slotRegistrations.find((entry) => entry.name === 'sidebar.right.pane.tab.title');
  assert.ok(pane !== undefined, 'the pane body is registered');
  assert.ok(title !== undefined, 'the pane title is registered');
  // Both are keyed by the tab type's id, as the shipped browser tab does.
  assert.equal(pane.key, MANIFEST.name);
  assert.equal(title.key, MANIFEST.name);
});

test('the right dock absent: the bundle still activates and registers no tab', () => {
  const { exports, ctx, calls } = load({ services: { sidebarRight: null, sidebarRightTabs: null } });
  assert.doesNotThrow(() => exports.apply(ctx));
  assert.equal(calls.scopes.length, 0, 'the child scope never activates');
  assert.equal(calls.tabTypes.length, 0);
  // The manager page is unconditional.
  assert.ok(calls.slotRegistrations.some((entry) => entry.name === 'plugins.bundle.config'));
});

test('a tab type the shell refuses costs the tab, not the boot', () => {
  const { exports, ctx, calls } = load({ registerThrows: true });
  assert.doesNotThrow(() => exports.apply(ctx), 'an optional integration must not fail the boot');
  assert.equal(calls.tabTypes.length, 1, 'the attempt was made and contained');
  assert.ok(calls.slotRegistrations.some((entry) => entry.name === 'plugins.bundle.config'));
});

test('no bare service property is read outside an injected scope', () => {
  // A guard such as `ctx.sidebarRight || null` reads like a null check but
  // throws before it can run, so the bundle must never do it. Comments are
  // removed first, because the explanation of this rule names the pattern.
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const reads = [...code.matchAll(/\bctx\.([A-Za-z_$][A-Za-z0-9_$]*)/g)].map((match) => match[1]);
  const allowed = new Set(['get', 'effect', 'slots', 'inject', 'on', 'provide']);
  const offenders = [...new Set(reads)].filter((name) => !allowed.has(name));
  assert.deepEqual(offenders, [], `read these through ctx.inject/ctx.get instead: ${offenders.join(', ')}`);
});
