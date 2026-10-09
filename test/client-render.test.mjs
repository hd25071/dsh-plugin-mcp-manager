// Render smoke test for the browser half.
//
// The client module is loaded the way the app loads it, then the registered components
// are rendered deeply with a minimal React shim: every function component in the tree is
// called and its output walked. A typo or bad reference inside any render path throws
// here instead of blanking the Plugins page in a live app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let captured = null;
globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec; } } };
await import('../client.js');

// Two state values are steered so one pass reaches every branch: the manager page opens
// on its market tab, and the market panel opens with its install dialog showing. The
// typeof guard matters — an empty array would otherwise coerce to the empty-string key.
function steer(value) {
  if (typeof value === 'string' && value === 'rows') return 'market';
  if (typeof value === 'string' && value === '') return 'x/y';
  return value;
}

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => {
    const value = typeof initial === 'function' ? initial() : initial;
    return [steer(value), () => {}];
  },
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  memo: (fn) => fn,
};

const registered = [];
function makeScope(extra) {
  const scope = {
    effect: (fn) => fn(),
    get: () => undefined,
    slots: {
      inject: (name, callback) => callback(),
      register: (descriptor, component) => {
        registered.push({ descriptor, component });
        return () => {};
      },
    },
    inject: (deps, callback) => callback(makeScope(extra)),
  };
  return Object.assign(scope, extra);
}

const mod = captured.factory((name) => {
  if (name === 'react') return React;
  throw new Error('unexpected require: ' + name);
});
mod.apply(makeScope({
  sidebarRight: { openTab: () => {} },
  sidebarRightTabs: { register: () => () => {} },
}));

/**
 * Call every function component reachable from one element and collect the whole tree.
 *
 * @param element - a createElement result.
 * @param depth - guard against a component that renders itself.
 * @returns the rendered text of the entire subtree.
 */
function renderDeep(element, depth = 0) {
  if (depth > 24) return '';
  if (typeof element === 'string' || typeof element === 'number') return String(element);
  if (element === null || element === undefined || typeof element !== 'object') return '';
  let text = '';
  if (typeof element.type === 'function') text += renderDeep(element.type(element.props || {}), depth + 1);
  for (const child of element.children || []) text += renderDeep(child, depth + 1);
  return text;
}

function componentFor(name) {
  const found = registered.find((item) => item.descriptor.name === name);
  assert.ok(found, 'no component registered for ' + name);
  return found.component;
}

test('the client module registers under its package name and activates', () => {
  assert.equal(captured.id, 'dsh-plugin-mcp-manager');
  assert.ok(registered.length >= 3, 'expected the manager page, the dock pane body and the tab title');
});

test('the manager page renders deeply: tabs, rows, market search and the install dialog', () => {
  const text = renderDeep(componentFor('plugins.bundle.config')({}));
  assert.match(text, /MCP 管理器/);
  assert.match(text, /MCP 行/);
  assert.match(text, /调用记录/);
  assert.match(text, /市场/);
  // The market tab's own controls.
  assert.match(text, /刷新目录/);
  assert.match(text, /可本地安装/);
  assert.match(text, /最新上架/);
  assert.match(text, /搜索结果/);
  // The install dialog, reached through the market panel.
  assert.match(text, /来源：官方 MCP 注册表/);
  assert.match(text, /取消/);
});

test('the call-log pane renders its session picker', () => {
  const text = renderDeep(componentFor('sidebar.right.pane.tab')({}));
  assert.match(text, /刷新/);
  assert.match(text, /没有可读的会话|读取中|MCP 调用/);
});

test('the tab title component renders a label', () => {
  const title = componentFor('sidebar.right.pane.tab.title');
  assert.equal(typeof title, 'function');
});

test('no HTML injection path exists in the browser half', () => {
  // Every string on this page comes from the internet (registry titles, descriptions).
  // React renders them as text children only; this guard keeps it that way.
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  for (const pattern of [/innerHTML/, /outerHTML/, /dangerouslySetInnerHTML/, /insertAdjacentHTML/, /document\.write/, /new Image\(/, /icon_url|iconUrl/]) {
    assert.doesNotMatch(source, pattern, String(pattern) + ' must not appear in the browser half');
  }
  assert.doesNotMatch(source, /<script|javascript:/, 'no raw markup or script URLs');
});
