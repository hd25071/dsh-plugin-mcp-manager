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
  // The harness's setState is a no-op, so a state that only shows up after a click has to
  // start that way: `false` here is the full-re-pull confirmation.
  if (value === false) return true;
  // Both the status line and the install dialog start from `null`, so one fixture carries
  // both shapes: the status fields the header reads and the detail fields the dialog reads.
  // Reaching both in one pass is what caught a missing helper the preview exposed.
  if (value === null) {
    return {
      fetchedAt: new Date().toISOString(),
      count: 7287,
      stale: false,
      ageMs: 3600000,
      source: 'cache',
      refreshing: { running: false, pages: 0, rawEntries: 0, kept: 0, error: '', finishedAt: 0 },
      runtimes: { platform: 'win32', node: { path: 'C:\\node\\node.exe', available: true, withoutNpm: '' }, npx: { available: true, cli: 'C:\\npm\\npx-cli.js' }, uvx: { available: false }, docker: { available: true } },
      cachePath: 'C:\\cache.json',
      installed: 0,
      server: { name: 'vendor.example/notes', title: 'Vendor Notes', description: 'a local one', version: '1.0.0', packages: [], remotes: [] },
      options: [{
        kind: 'stdio', registryType: 'npm', label: '本地进程 · npx @example/notes-mcp', transport: 'stdio',
        command: 'C:\\node\\node.exe',
        argv: [{ kind: 'literal', value: 'C:\\npm\\npx-cli.js' }, { kind: 'literal', value: '-y' }, { kind: 'literal', value: '@example/notes-mcp' }, { kind: 'slot', name: '--out', description: '', isRequired: false, format: '' }],
        slots: [{ name: '--out', description: '', isRequired: false, format: '' }],
        env: {}, variables: [{ name: 'EXAMPLE_API_KEY', description: 'key', isRequired: true, isSecret: true, default: '' }],
        risk: '在你本机执行第三方命令',
      }],
      blocked: [{ registryType: 'oci', identifier: 'ghcr.io/x', reason: '容器方式（oci）二期支持' }],
      slug: 'vendor-example-notes-000000',
      pkg: '@dsh-mcp-market/vendor-example-notes-000000',
      dir: 'C:/market/vendor-example-notes-000000',
      serverName: 'notes',
    };
  }
  // The search result state, so the grid renders real cards in every state.
  if (value !== null && typeof value === 'object' && Array.isArray(value.results) && value.results.length === 0) {
    return {
      total: 5,
      offset: 0,
      results: [
        { name: 'vendor.example/notes', title: 'Vendor Notes', description: 'a local one', version: '1.0.0', types: ['npm'], hasRemote: false, kinds: [], registryType: 'npm', installable: true, needsConfig: false, installedSlug: '', updateAvailable: false },
        { name: 'vendor.example/keyed', title: 'Vendor Keyed', description: 'needs a key', version: '2.0.0', types: ['npm'], hasRemote: false, kinds: [], registryType: 'npm', installable: true, needsConfig: true, installedSlug: '', updateAvailable: false },
        { name: 'vendor.example/installed', title: 'Vendor Installed', description: 'already here', version: '1.4.0', types: ['npm'], hasRemote: false, kinds: [], registryType: 'npm', installable: true, needsConfig: false, installedSlug: 'vendor-example-installed-000000', updateAvailable: false },
        // Four chips — kind, two transports and a version — so the +N fold is exercised.
        { name: 'vendor.example/multi', title: 'Vendor Multi', description: 'remote with two transports', version: '3.1.4', types: [], hasRemote: true, kinds: ['streamable-http', 'sse'], registryType: 'remote', installable: true, needsConfig: false, installedSlug: '', updateAvailable: false },
        { name: 'vendor.example/legacy-sse', title: 'Vendor SSE', description: 'sse only', version: '1.0.0', types: [], hasRemote: true, kinds: ['sse'], registryType: 'remote', installable: false, unsupportedReason: '暂不支持 sse 远程传输（二期）', installedSlug: '', updateAvailable: false },
      ],
    };
  }
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
const navigationCalls = [];
function makeScope(extra) {
  const scope = {
    effect: (fn) => fn(),
    // The plugin page's published navigation, so the installed-card jump can be observed.
    get: (key) => (key === 'pluginNavigation' ? { openBundle: (pkg) => navigationCalls.push(pkg) } : undefined),
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
  if (Array.isArray(element)) return element.map((child) => renderDeep(child, depth + 1)).join('');
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
  assert.ok(registered.length >= 4, 'expected the manager page, the dock pane body and title, and the market page');
});

test('the market registers as its own nav entry above the third-party panels', () => {
  const entry = registered.find((item) => item.descriptor.name === 'sidebar.panellist');
  assert.ok(entry, 'the market must register a sidebar.panellist entry');
  assert.equal(entry.descriptor.id, 'mcp-market');
  assert.equal(entry.descriptor.order, 5, 'the host Plugins entry is 0 and the third-party panels are 30');
  assert.equal(typeof entry.descriptor.label, 'function');
  assert.equal(entry.descriptor.label(), 'MCP 市场');

  const page = registered.find((item) => item.descriptor.name === 'main');
  assert.ok(page, 'the market must register a main panel');
  assert.equal(page.descriptor.key, entry.descriptor.id, 'the nav id and the main key must be the same value');
});

test('the manager page keeps its rows and points at the market instead of embedding it', () => {
  const text = renderDeep(componentFor('plugins.bundle.config')({}));
  assert.match(text, /MCP 管理器/);
  assert.match(text, /调用记录/);
  assert.match(text, /MCP 市场/, 'the manager must tell the user where the market lives');
  assert.doesNotMatch(text, /刷新目录/, 'the market must not be embedded in the manager any more');
});

test('the market page renders the toolbar, the grid and the pager', () => {
  const text = renderDeep(componentFor('main')({}));
  assert.match(text, /全部/);
  assert.match(text, /本地/);
  assert.match(text, /远程/);
  assert.match(text, /最新上架/);
  assert.match(text, /刷新目录/);
  assert.match(text, /搜索结果（5）/);
  assert.match(text, /上一页/);
  assert.match(text, /下一页/);
  assert.match(text, /每页 60/, 'pagination size must be visible');
  // The three card states the state machine has to express.
  assert.match(text, /安装 · 需密钥/, 'a card that needs secrets says so before the click');
  assert.match(text, /不可用/, 'an unsupported entry is visibly unavailable');
  assert.match(text, /Vendor Notes/);
});

test('the market markup is class-based: semantic classes and data-state, never inline style', () => {
  const styles = [];
  const classes = new Set();
  const states = new Set();
  const walk = (element, depth = 0) => {
    if (depth > 24 || element === null || element === undefined || typeof element !== 'object') return;
    if (Array.isArray(element)) { for (const child of element) walk(child, depth + 1); return; }
    const props = element.props || {};
    if (props.style !== undefined) styles.push(String(element.type));
    if (typeof props.className === 'string') for (const name of props.className.split(/\s+/)) if (name) classes.add(name);
    if (props['data-state'] !== undefined) states.add(String(props['data-state']));
    if (typeof element.type === 'function') walk(element.type(props), depth + 1);
    for (const child of element.children || []) walk(child, depth + 1);
  };
  walk(componentFor('main')({}));

  assert.deepEqual(styles, [], 'the visual spec replaces the class table, so no component may carry an inline style');
  for (const name of ['mcpm-page', 'mcpm-toolbar', 'mcpm-grid', 'mcpm-card', 'mcpm-btn', 'mcpm-pager']) {
    assert.equal(classes.has(name), true, 'missing semantic class: ' + name);
  }
  assert.equal(states.size > 0, true, 'button states must be expressed through data-state');
  for (const state of states) {
    assert.equal(['idle', 'needs-config', 'installed', 'update', 'unavailable', 'busy'].includes(state), true, 'unexpected data-state: ' + state);
  }
});

test('every card carries a letter avatar from a fixed hue set', () => {
  const hues = new Set();
  const letters = [];
  const walk = (element, depth = 0) => {
    if (depth > 24 || element === null || element === undefined || typeof element !== 'object') return;
    if (Array.isArray(element)) { for (const child of element) walk(child, depth + 1); return; }
    const props = element.props || {};
    if (typeof props.className === 'string') {
      for (const name of props.className.split(/\s+/)) {
        const match = /^mcpm-avatar--h(\d+)$/.exec(name);
        if (match) {
          hues.add(Number(match[1]));
          letters.push((element.children || []).filter((child) => typeof child === 'string').join(''));
        }
      }
    }
    if (typeof element.type === 'function') walk(element.type(props), depth + 1);
    for (const child of element.children || []) walk(child, depth + 1);
  };
  walk(componentFor('main')({}));

  assert.equal(hues.size > 1, true, 'a wall of one hue gives no sense of which card is which');
  for (const hue of hues) assert.equal(hue >= 0 && hue <= 11, true, 'hue must come from the 12 preset classes');
  assert.equal(letters.every((letter) => letter.length === 1), true, 'each avatar shows exactly one letter: ' + JSON.stringify(letters));
  // The class table has to define every hue the markup can ask for.
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  for (let hue = 0; hue < 12; hue += 1) {
    assert.equal(source.includes('.mcpm-avatar--h' + hue + ' '), true, 'the class table must define hue ' + hue);
  }
});

test('an installed card jumps to the row through the published navigation', () => {
  const page = componentFor('main')({});
  let clicked = false;
  const walk = (element, depth = 0) => {
    if (clicked || depth > 24 || element === null || element === undefined || typeof element !== 'object') return;
    if (Array.isArray(element)) { for (const child of element) walk(child, depth + 1); return; }
    const props = element.props || {};
    if (element.type === 'button' && props['data-state'] === 'installed' && typeof props.onClick === 'function') {
      props.onClick();
      clicked = true;
      return;
    }
    if (typeof element.type === 'function') walk(element.type(props), depth + 1);
    for (const child of element.children || []) walk(child, depth + 1);
  };
  walk(page);

  assert.equal(clicked, true, 'an installed card must render a clickable installed-state button');
  assert.deepEqual(navigationCalls, ['@dsh-mcp-market/vendor-example-installed-000000'],
    'the click must open that bundle in the plugin page, not just print a hint');
});

test('the result title says what is actually listed', () => {
  // The steered pass carries a query, so the title must say 搜索结果 and the real count.
  const text = renderDeep(componentFor('main')({}));
  assert.match(text, /搜索结果（5）/, 'with a query the title says 搜索结果');
  // The other branch is wording only; the steered pass cannot carry an empty query and an
  // open dialog at once, so it is asserted at the source.
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  assert.match(source, /query\.trim\(\) === '' \? '全部服务器' : '搜索结果'/,
    'with no query the list is everything, and the title must say so');
});
test('badges are capped at three with a +N chip, and the long transport name is shortened', () => {
  const text = renderDeep(componentFor('main')({}));
  assert.match(text, /\+1/, 'a fourth chip folds into +N');
  assert.match(text, /http/, 'streamable-http is shortened');
  assert.doesNotMatch(text, /streamable-http/, 'the long transport name must not reach the grid');
  assert.match(text, /已安装 ✓/, 'the button carries the installed state');
  assert.doesNotMatch(text, /已装(?!)/, 'the redundant 已装 chip is gone; the button already says it');
});

test('the avatar and the name share one head block', () => {
  const heads = [];
  const walk = (element, depth = 0) => {
    if (depth > 24 || element === null || element === undefined || typeof element !== 'object') return;
    if (Array.isArray(element)) { for (const child of element) walk(child, depth + 1); return; }
    const props = element.props || {};
    if (props.className === 'mcpm-card__head') {
      const kinds = (element.children || []).map((child) => (child && child.props && child.props.className) || '');
      heads.push(kinds.join('|'));
    }
    if (typeof element.type === 'function') walk(element.type(props), depth + 1);
    for (const child of element.children || []) walk(child, depth + 1);
  };
  walk(componentFor('main')({}));

  assert.equal(heads.length > 0, true, 'cards must group the avatar and the name');
  for (const head of heads) {
    assert.match(head, /mcpm-avatar--h\d+/, 'the head holds the avatar');
    assert.match(head, /mcpm-card__name/, 'the head holds the name');
  }
});

test('colours come from the host tokens, with no theme logic of our own', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  // The host pairs a fill with its foreground and owns the light/dark switch. A local
  // colour alias that re-inverts under a media query is how a button ends up white on
  // white, so the class table must not carry one.
  assert.doesNotMatch(source, /prefers-color-scheme/, 'no self-managed theme switch');
  assert.match(source, /background: var\(--dsw-alias-button-primary-fill/,
    'the primary button takes its fill from the host');
  assert.match(source, /color: var\(--dsw-alias-label-primary-foreground/,
    'and its text from the foreground the host paired with that fill');
  assert.match(source, /var\(--dsw-alias-state-success-primary/, 'success comes from the host palette');
  assert.match(source, /var\(--dsw-alias-state-warn-primary/, 'warnings come from the host palette');
  for (const alias of ['--mcpm-accent', '--mcpm-success', '--mcpm-warning', '--mcpm-danger']) {
    assert.equal(source.includes(alias), false, 'no local colour alias: ' + alias);
  }
});

test('the card is dense and the progress line is not grey', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  assert.match(source, /gap: 6px; padding: 12px;/,
    'a catalog of thousands is read by scanning, so the card stays dense');
  assert.match(source, /\.mcpm-statusline--progress \{ font-weight: 600; color: var\(--dsw-alias-state-warn-primary/,
    'the second line answers "can I install right now?" and must read like a warning');

  const text = renderDeep(componentFor('main')({}));
  assert.match(text, /重新拉取全部 \d+ 条，约需 2 分钟/, 'and it says what it costs before doing it');
  assert.match(text, /确认/, 'and it waits for a confirmation');
  assert.match(source, /'全量重拉'/, 'the secondary action that starts it exists');
});

test('the search request carries the query and the paging', () => {
  // The first screen loads with an empty query, so a broken query path stays invisible
  // until someone actually searches. This locks the contract: whatever the box holds has
  // to reach the request, along with the paging.
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ ok: true, value: { total: 0, results: [], offset: 0, limit: 60 } }) };
  };
  let clicked = false;
  try {
    const page = componentFor('main')({});
    const walk = (element, depth = 0) => {
      if (clicked || depth > 24 || element === null || element === undefined || typeof element !== 'object') return;
      if (Array.isArray(element)) { for (const child of element) walk(child, depth + 1); return; }
      const props = element.props || {};
      // The steered pass puts `x/y` in the box, so the search button must send exactly that.
      if (element.type === 'button' && typeof props.onClick === 'function' && props.className === 'mcpm-btn mcpm-btn--search') {
        props.onClick();
        clicked = true;
        return;
      }
      if (typeof element.type === 'function') walk(element.type(props), depth + 1);
      for (const child of element.children || []) walk(child, depth + 1);
    };
    walk(page);
    assert.equal(clicked, true, 'the market must render a search button');
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(urls.length > 0, true, 'pressing search must issue a request');
  const sent = urls[urls.length - 1];
  assert.match(sent, /q=x%2Fy/, 'the query must reach the request: ' + sent);
  assert.match(sent, /limit=60/, 'the page size must reach the request');
  assert.match(sent, /offset=0/, 'the offset must reach the request');
});

test('the class table defines every state hook the components use', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  for (const selector of ['.mcpm-card', '.mcpm-grid', '.mcpm-btn--primary', '.mcpm-badge', '.mcpm-pager', '[data-state=']) {
    assert.equal(source.includes(selector), true, 'the class table must style ' + selector);
  }
  assert.match(source, /const MARKET_CSS = `/, 'the class table must stay one replaceable block');
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
