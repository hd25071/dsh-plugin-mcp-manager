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
 * The specific defect this pins down: Cordis resolves a service only along the
 * plugin's injected ancestry, so a plain `ctx.foo` read for anything missing
 * from `inject` **throws** (`cannot get property "foo" without inject`) rather
 * than yielding undefined — and a guard like `ctx.foo || null` therefore never
 * runs. Optional services must be read with `ctx.get(name)`.
 *
 * The context below reproduces that rule, so this test fails loudly if a bare
 * service property read ever comes back.
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
 * Load the bundle and return its exports plus what it registered.
 *
 * @param options - test seams.
 * @param options.services - what `ctx.get` resolves.
 * @returns the captured state.
 */
function load(options = {}) {
  const calls = { injections: [], registrations: [], effects: [] };
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
  const navigatorStub = { clipboard: { writeText: async () => {} } };

  const run = new Function('window', 'document', 'navigator', 'fetch', 'console', SOURCE);
  run(windowStub, documentStub, navigatorStub, async () => new Response('{"ok":true,"value":{}}', { status: 200 }), {
    warn() {},
    error() {},
    log() {}
  });

  assert.ok(registered !== undefined, 'the bundle registers a module loader factory');
  const exports = registered.factory((specifier) => {
    assert.equal(specifier, 'react', `unexpected require: ${specifier}`);
    return reactShim();
  });

  const services = options.services ?? {};
  const base = {
    get(name) {
      return services[name];
    },
    effect(fn) {
      calls.effects.push(fn);
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    slots: {
      inject(name, callback) {
        calls.injections.push(name);
        callback();
        return () => {};
      },
      register(definition, component) {
        calls.registrations.push({ name: definition.name, key: definition.key, component });
        return { definition };
      }
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
  const { exports, ctx } = load({ services: { sidebarRight: { openTab() {} } } });
  // A throw here is what produces "web boot: 1 entry did not activate".
  assert.doesNotThrow(() => exports.apply(ctx));
});

test('the right-dock service is absent: the bundle still activates', () => {
  const { exports, ctx, calls } = load({ services: {} });
  assert.doesNotThrow(() => exports.apply(ctx));
  // The call-log tab is optional, so nothing is registered for it.
  assert.equal(calls.effects.length, 0);
  assert.ok(calls.injections.includes('plugins.bundle.config'));
  assert.ok(calls.injections.includes('sidebar.right.pane.tab'));
});

test('a right-dock service that throws on register is contained', () => {
  const { exports, ctx } = load({
    services: {
      sidebarRight: { openTab() {} },
      sidebarRightTabs: {
        register() {
          throw new Error('right dock is not mounted');
        }
      }
    }
  });
  assert.doesNotThrow(() => exports.apply(ctx), 'an optional integration must not fail the boot');
});

test('the manager page registers on the bundle key the Plugins page dispatches', () => {
  const { exports, ctx, calls } = load({ services: {} });
  exports.apply(ctx);
  const page = calls.registrations.find((entry) => entry.name === 'plugins.bundle.config');
  assert.ok(page !== undefined, 'the manager page is contributed');
  assert.equal(page.key, MANIFEST.name, 'keyed by the bundle package name');
  assert.equal(typeof page.component, 'function');
});

test('no bare service property is read outside ctx.get', () => {
  // A guard such as `ctx.sidebarRight || null` reads like a null check but
  // throws before it can run, so the bundle must never do it. Comments are
  // removed first, because the explanation of this rule names the pattern.
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const reads = [...code.matchAll(/\bctx\.([A-Za-z_$][A-Za-z0-9_$]*)/g)].map((match) => match[1]);
  const allowed = new Set(['get', 'effect', 'slots', 'inject', 'on', 'provide']);
  const offenders = [...new Set(reads)].filter((name) => !allowed.has(name));
  assert.deepEqual(offenders, [], `read these with ctx.get(name) instead: ${offenders.join(', ')}`);
});
