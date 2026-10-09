/**
 * Host half of dsh-plugin-mcp-manager.
 *
 * MCP servers are ordinary profile rows whose module is `@deepseek-ai/dsh-mcp-client`.
 * This half exposes exactly four Fetch routes over the services the profile already
 * mounts, and the Client half calls them with a document-relative `fetch()`:
 *
 *   GET  /api/mcp-manager/servers   inventory (id, module, disabled, inherited, override)
 *   POST /api/mcp-manager/config    write one row's config through the config editor
 *   POST /api/mcp-manager/enabled   enable/disable one row
 *   GET  /api/mcp-manager/health    which services this profile actually mounts
 *
 * Two rules shape the code:
 *
 * - **No Harness imports.** A third-party bundle is resolved by Node from its own
 *   real path, so `import '@deepseek-ai/...'` fails with `ERR_MODULE_NOT_FOUND` and
 *   lands the row in the plugin page's error state. Services are read with
 *   `ctx.get(key)` instead.
 * - **A sibling fiber's service is not reachable by property access** ("cannot get
 *   property ... without inject"), and `configEditor` / `pluginManager` are siblings.
 *   `ctx.get` is the documented reader for that case and answers `undefined` rather
 *   than throwing, so every route degrades to a diagnosable status.
 *
 * @module dsh-plugin-mcp-manager
 */
import * as market from './market.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-manager';

/** The exact Fetch routes require the connection service. */
export const inject = ['connection'];

/** The MCP client module every managed row resolves to. */
export const MCP_MODULE = '@deepseek-ai/dsh-mcp-client';

export const SERVERS_PATH = '/api/mcp-manager/servers';
export const CONFIG_PATH = '/api/mcp-manager/config';
export const ENABLED_PATH = '/api/mcp-manager/enabled';
export const HEALTH_PATH = '/api/mcp-manager/health';
export const SESSIONS_PATH = '/api/mcp-manager/sessions';
export const CALLS_PATH = '/api/mcp-manager/calls';
export const MARKET_PATH = '/api/mcp-manager/market';
export const MARKET_REFRESH_PATH = '/api/mcp-manager/market/refresh';
export const MARKET_SEARCH_PATH = '/api/mcp-manager/market/search';
export const MARKET_DETAIL_PATH = '/api/mcp-manager/market/detail';
export const MARKET_INSTALL_PATH = '/api/mcp-manager/market/install';
export const MARKET_UNINSTALL_PATH = '/api/mcp-manager/market/uninstall';
export const MARKET_INSTALLED_PATH = '/api/mcp-manager/market/installed';

/** Tool names an MCP server contributes are prefixed this way. */
const MCP_TOOL_PREFIX = 'mcp__';

/** Default number of calls one response carries. */
const DEFAULT_CALL_LIMIT = 200;

/**
 * Build one JSON response.
 *
 * @param body - the serializable payload.
 * @param status - HTTP status code.
 * @returns the response, uncacheable because profile state is live.
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * Build the shared business-failure body.
 *
 * @param code - routable failure code.
 * @param message - developer-facing description.
 * @param status - HTTP status code.
 * @returns the response.
 */
function failure(code, message, status) {
  return json({ ok: false, error: { code, message } }, status);
}

/**
 * Read one service without the `inject` requirement.
 *
 * @param ctx - the plugin context.
 * @param key - the service name.
 * @returns the service value, or `undefined`.
 */
function serviceOf(ctx, key) {
  try {
    if (typeof ctx.get === 'function') {
      const value = ctx.get(key);
      if (value !== undefined && value !== null) return value;
    }
  } catch {
    /* fall through to the property reader */
  }
  try {
    const value = Reflect.get(ctx, key);
    return value === null ? undefined : value;
  } catch {
    return undefined;
  }
}

/** The module specifier a loader entry resolves to, if the shape exposes one. */
function moduleOfEntry(entry) {
  const options = entry && entry.options;
  if (!options || typeof options !== 'object') return '';
  for (const key of ['name', 'module', 'specifier']) {
    const value = options[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

function idOfEntry(entry) {
  const options = entry && entry.options;
  return options && typeof options.id === 'string' ? options.id : '';
}

function disabledOfEntry(entry) {
  const options = entry && entry.options;
  if (options && typeof options.disabled === 'boolean') return options.disabled;
  return undefined;
}

/**
 * Collect MCP rows from the plugin manager, keyed by every id a later join may use.
 *
 * A row's owning bundle and its `rowId` are what a per-row config page needs
 * (`plugins.row.config` is keyed `<bundle>#<rowId>`), so they are carried alongside
 * the config editor's composed values.
 *
 * @param manager - the plugin manager service.
 * @returns a map from entry id / row id to the row's origin.
 */
function managerRows(manager) {
  const byId = new Map();
  if (manager === undefined || typeof manager.listBundles !== 'function') return byId;
  const bundles = manager.listBundles();
  for (const bundle of Array.isArray(bundles) ? bundles : []) {
    const bundleName = (bundle && (bundle.name || bundle.package || bundle.pkg)) || '';
    const rows = bundle && Array.isArray(bundle.rows) ? bundle.rows : [];
    for (const row of rows) {
      const module = (row && (row.moduleName || row.module)) || '';
      if (module !== MCP_MODULE) continue;
      const rowId = (row && (row.rowId || row.entryId || row.id)) || '';
      const entryId = (row && (row.entryId || row.rowId || row.id)) || '';
      const origin = {
        bundle: bundleName,
        rowId,
        entryId,
        module: MCP_MODULE,
        enabled: row && typeof row.enabled === 'boolean' ? row.enabled : undefined,
      };
      if (entryId) byId.set(entryId, origin);
      if (rowId && !byId.has(rowId)) byId.set(rowId, origin);
    }
  }
  return byId;
}

/**
 * Answer the inventory route.
 *
 * `configEditor.configuration()` is the primary source because it carries the
 * *composed* config (inherited layer plus this profile's override) alongside the
 * Loader entry a later write needs. `pluginManager.listBundles()` is joined in for
 * the owning bundle and `rowId`; when the config editor is absent the listings still
 * identify MCP rows, only read-only.
 *
 * @param ctx - the plugin context.
 * @returns the inventory envelope.
 */
function serversResponse(ctx) {
  const editor = serviceOf(ctx, 'configEditor');
  const manager = serviceOf(ctx, 'pluginManager');
  const rows = [];
  let source = '';
  let origin = new Map();
  let managerError = '';

  try {
    origin = managerRows(manager);
  } catch (error) {
    managerError = String((error && error.message) || error);
  }

  if (editor !== undefined && typeof editor.configuration === 'function') {
    let configuration;
    try {
      configuration = editor.configuration();
    } catch (error) {
      return failure('config-editor-failed', String((error && error.message) || error), 500);
    }
    source = 'configEditor';
    for (const item of Array.isArray(configuration) ? configuration : []) {
      const entry = item && item.entry;
      if (moduleOfEntry(entry) !== MCP_MODULE) continue;
      const id = idOfEntry(entry);
      const meta = origin.get(id) || {};
      const inherited = (item && item.inherited) || {};
      const override = (item && item.override) || {};
      rows.push({
        id,
        rowId: meta.rowId || id,
        bundle: meta.bundle || '',
        module: MCP_MODULE,
        disabled: disabledOfEntry(entry),
        inherited,
        override,
        effective: { ...inherited, ...override },
        editable: true,
      });
    }
  } else if (origin.size > 0) {
    source = 'pluginManager';
    for (const [id, meta] of origin) {
      if (id !== meta.entryId) continue;
      rows.push({
        id,
        rowId: meta.rowId,
        bundle: meta.bundle,
        module: MCP_MODULE,
        disabled: typeof meta.enabled === 'boolean' ? !meta.enabled : undefined,
        inherited: {},
        override: {},
        effective: {},
        editable: false,
      });
    }
  } else if (managerError !== '') {
    return failure('plugin-manager-failed', managerError, 500);
  } else {
    return failure('service-unavailable',
      'neither configEditor nor pluginManager is mounted in this profile', 503);
  }

  return json({
    ok: true,
    value: {
      source,
      module: MCP_MODULE,
      rows,
      capabilities: {
        read: source === 'configEditor',
        write: editor !== undefined && typeof editor.edit === 'function',
        toggle: manager !== undefined && typeof manager.setPluginEnabled === 'function',
        rowPages: rows.every((row) => row.bundle !== '' && row.rowId !== ''),
      },
    },
  });
}

/**
 * Answer a config write.
 *
 * The editor's `change` argument is a *function* `(current, inherited) => next`, and
 * a next value deep-equal to `inherited` removes the profile override instead of
 * pinning it — which is exactly what "reset to default" means here.
 *
 * @param request - the incoming request.
 * @param ctx - the plugin context.
 * @returns the write envelope.
 */
async function configResponse(request, ctx) {
  const editor = serviceOf(ctx, 'configEditor');
  if (editor === undefined || typeof editor.edit !== 'function') {
    return failure('service-unavailable', 'the configEditor service is not mounted in this profile', 503);
  }
  let body;
  try {
    body = await request.json();
  } catch (error) {
    return failure('bad-request', 'body must be JSON', 400);
  }
  const id = body && typeof body.id === 'string' ? body.id : '';
  if (id === '') return failure('bad-request', 'id is required', 400);
  const reset = body && body.reset === true;
  const config = body && body.config && typeof body.config === 'object' ? body.config : null;
  if (!reset && config === null) return failure('bad-request', 'config object or reset:true is required', 400);

  const entries = typeof editor.entries === 'function' ? editor.entries() : [];
  const entry = (Array.isArray(entries) ? entries : []).find((candidate) => idOfEntry(candidate) === id);
  if (entry === undefined) return failure('entry-not-found', 'no addressable entry with id ' + id, 404);

  try {
    const applied = await editor.edit(entry, (current, inherited) =>
      reset ? { ...inherited } : { ...current, ...config });
    return json({ ok: true, value: { id, applied: applied === undefined ? null : applied } });
  } catch (error) {
    return failure('write-failed', String((error && error.message) || error), 500);
  }
}

/**
 * Answer an enable/disable request.
 *
 * @param request - the incoming request.
 * @param ctx - the plugin context.
 * @returns the toggle envelope.
 */
async function enabledResponse(request, ctx) {
  const manager = serviceOf(ctx, 'pluginManager');
  if (manager === undefined || typeof manager.setPluginEnabled !== 'function') {
    return failure('service-unavailable', 'the pluginManager service is not mounted in this profile', 503);
  }
  let body;
  try {
    body = await request.json();
  } catch (error) {
    return failure('bad-request', 'body must be JSON', 400);
  }
  const id = body && typeof body.id === 'string' ? body.id : '';
  const enabled = body && typeof body.enabled === 'boolean' ? body.enabled : null;
  if (id === '' || enabled === null) return failure('bad-request', 'id and boolean enabled are required', 400);
  try {
    const result = await manager.setPluginEnabled(id, enabled);
    return json({ ok: true, value: { id, enabled, result: result === undefined ? null : result } });
  } catch (error) {
    return failure('toggle-failed', String((error && error.message) || error), 500);
  }
}

/**
 * Answer the diagnostics route.
 *
 * @param ctx - the plugin context.
 * @returns which of the services this plugin needs are mounted.
 */
function healthResponse(ctx) {
  const editor = serviceOf(ctx, 'configEditor');
  const manager = serviceOf(ctx, 'pluginManager');
  const query = serviceOf(ctx, 'sessionQuery');
  return json({
    ok: true,
    value: {
      services: {
        connection: serviceOf(ctx, 'connection') !== undefined,
        configEditor: editor !== undefined,
        pluginManager: manager !== undefined,
        sessionQuery: query !== undefined,
      },
      methods: {
        configEditorEntries: typeof editor?.entries === 'function',
        configEditorConfiguration: typeof editor?.configuration === 'function',
        configEditorEdit: typeof editor?.edit === 'function',
        pluginManagerSetPluginEnabled: typeof manager?.setPluginEnabled === 'function',
      },
    },
  });
}

/** The MCP server a wire tool name belongs to: `mcp__<server>__<tool>`. */
function serverOfTool(name) {
  const parts = String(name).split('__');
  return parts.length >= 3 ? parts[1] : '';
}

/** A bounded, display-ready rendering of an arbitrary recorded value. */
function summarize(value, limit = 400) {
  if (value === undefined || value === null) return '';
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (typeof text !== 'string') return '';
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

/** Serialized size of a recorded payload, in bytes. */
function sizeOf(value) {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return typeof text === 'string' ? text.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Answer the session list route.
 *
 * `listSessions()` is deliberately lightweight — it does not replay a log — so the
 * sidebar page can offer a picker without paying for history.
 *
 * @param ctx - the plugin context.
 * @returns the session envelope.
 */
function sessionsResponse(ctx) {
  const query = serviceOf(ctx, 'sessionQuery');
  if (query === undefined || typeof query.listSessions !== 'function') {
    return failure('service-unavailable', 'the sessionQuery service is not mounted in this profile', 503);
  }
  let sessions;
  try {
    sessions = query.listSessions();
  } catch (error) {
    return failure('list-failed', String((error && error.message) || error), 500);
  }
  const list = Array.isArray(sessions) ? sessions : [];
  const mapped = [];
  for (const session of list) {
    if (session === null || typeof session !== 'object') continue;
    const id = session.id || session.sessionId || session.key || '';
    if (typeof id !== 'string' || id === '') continue;
    mapped.push({
      id,
      title: session.title || session.name || session.summary || '',
      live: session.live === true,
      persisted: session.persisted === true,
      updatedAt: session.updatedAt || session.lastEventAt || session.mtime || null,
    });
  }
  return json({ ok: true, value: { sessions: mapped } });
}

/**
 * Fold one session's log into MCP call records.
 *
 * Pairing and duration follow the framework's own accounting (`dsh-session-stats`):
 * a `tool/call` opens a call under `data.callId`, its `tool/result` closes it, the
 * call id of a result lives at `data.message.source.callId`, and the duration is the
 * difference of the two event `time` stamps. A call whose result never landed is
 * dropped, exactly as the framework drops leftovers at `turn/end`.
 *
 * @param events - the replayed event log.
 * @returns closed MCP call records, in log order.
 */
function foldCalls(events) {
  const open = new Map();
  const calls = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== 'object') continue;
    const data = event.data || {};
    if (event.type === 'tool/call') {
      const name = typeof data.name === 'string' ? data.name : '';
      if (!name.startsWith(MCP_TOOL_PREFIX)) continue;
      const callId = typeof data.callId === 'string' ? data.callId : '';
      open.set(callId, {
        callId,
        tool: name,
        server: serverOfTool(name),
        at: typeof event.time === 'number' ? event.time : null,
        args: summarize(data.arguments),
        durationMs: null,
        resultBytes: null,
        ok: null,
        error: '',
      });
      continue;
    }
    if (event.type === 'tool/result') {
      const source = data.message && data.message.source;
      const callId = (source && source.callId) || '';
      const record = open.get(callId);
      if (record === undefined) continue;
      open.delete(callId);
      const at = typeof event.time === 'number' ? event.time : null;
      record.durationMs = record.at !== null && at !== null ? Math.max(0, at - record.at) : null;
      const message = data.message === undefined ? data : data.message;
      record.resultBytes = sizeOf(message);
      record.ok = !(data.message && (data.message.isError === true || data.message.error !== undefined));
      record.error = record.ok ? '' : summarize(data.message && data.message.error, 200);
      calls.push(record);
    }
  }
  return calls;
}

/**
 * Answer the call-log route.
 *
 * @param request - the incoming request.
 * @param ctx - the plugin context.
 * @returns the call envelope.
 */
async function callsResponse(request, ctx) {
  const query = serviceOf(ctx, 'sessionQuery');
  if (query === undefined || typeof query.readSession !== 'function') {
    return failure('service-unavailable', 'the sessionQuery service is not mounted in this profile', 503);
  }
  const params = new URL(request.url).searchParams;
  let sessionId = params.get('sessionId') || '';
  if (sessionId === '' && typeof query.listSessions === 'function') {
    try {
      const list = query.listSessions();
      const first = Array.isArray(list) ? list[0] : undefined;
      sessionId = (first && (first.id || first.sessionId || first.key)) || '';
    } catch {
      /* fall through to the bad-request answer */
    }
  }
  if (sessionId === '') return failure('bad-request', 'no session available to read', 400);

  let loaded;
  try {
    loaded = await query.readSession(sessionId);
  } catch (error) {
    return failure('session-unreadable', String((error && error.message) || error), 500);
  }

  const server = params.get('server') || '';
  const rawLimit = Number(params.get('limit'));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : DEFAULT_CALL_LIMIT;
  let calls = foldCalls(loaded && loaded.events);
  if (server !== '') calls = calls.filter((call) => call.server === server);
  const total = calls.length;
  calls.reverse();
  return json({ ok: true, value: { sessionId, total, calls: calls.slice(0, limit) } });
}

/** Cordis fiber states, as the loader reports them. */
const FIBER_STATES = { 0: 'pending', 1: 'loading', 2: 'active', 3: 'failed' };

/**
 * Every `serverName` already loaded in this profile.
 *
 * `dsh-mcp-client` throws when two instances claim one `serverName`, so a generated row
 * must be named around the existing ones rather than colliding with them.
 *
 * @param ctx - the plugin context.
 * @returns the taken names, or an empty list when the editor is absent.
 */
function takenServerNames(ctx) {
  const editor = serviceOf(ctx, 'configEditor');
  const names = [];
  try {
    if (editor === undefined || typeof editor.configuration !== 'function') return names;
    for (const item of editor.configuration() || []) {
      const entry = item && item.entry;
      if (moduleOfEntry(entry) !== MCP_MODULE) continue;
      const effective = { ...((item && item.inherited) || {}), ...((item && item.override) || {}) };
      if (typeof effective.serverName === 'string' && effective.serverName !== '') names.push(effective.serverName);
    }
  } catch {
    /* a missing editor costs collision avoidance, never the route */
  }
  return names;
}

/**
 * The configuration one generated row currently carries.
 *
 * A reinstall regenerates the whole patch, so without reading the live row first the
 * values a user typed last time (API keys especially) would vanish. Values are read from
 * the composed config and never sent to the browser.
 *
 * @param ctx - the plugin context.
 * @param rowId - the generated row's id.
 * @returns the row's `env` or `headers`, or an empty object.
 */
function currentRowConfig(ctx, rowId) {
  const editor = serviceOf(ctx, 'configEditor');
  try {
    if (editor === undefined || typeof editor.configuration !== 'function') return {};
    for (const item of editor.configuration() || []) {
      const entry = item && item.entry;
      if (moduleOfEntry(entry) !== MCP_MODULE) continue;
      if (idOfEntry(entry) !== rowId) continue;
      const effective = { ...((item && item.inherited) || {}), ...((item && item.override) || {}) };
      const values = effective.transport === 'streamable-http' ? effective.headers : effective.env;
      return values !== null && typeof values === 'object' ? { ...values } : {};
    }
  } catch {
    /* losing the merge only costs retyping a value */
  }
  return {};
}

/** The error a failed fiber carries, however this Cordis build spells it. */
function errorTextOf(fiber) {  for (const key of ['error', 'reason', 'cause']) {
    try {
      const value = Reflect.get(fiber, key);
      if (value === undefined || value === null) continue;
      const text = typeof value === 'string' ? value : String((value && value.message) || value);
      if (text !== '') return text;
    } catch {
      /* keep looking */
    }
  }
  return '';
}

/**
 * Read a collection of tool names out of the tools service, if this build exposes one.
 *
 * `dsh-tools` documents only `register` / `restrict` / `guard`, so there is no supported
 * listing. This probes a few plausible accessors defensively and answers `null` when none
 * of them yields a collection — the UI then says the count is unknown instead of lying.
 *
 * @param ctx - the plugin context.
 * @returns tool names, or `null`.
 */
function toolNamesOf(ctx) {
  const tools = serviceOf(ctx, 'tools');
  if (tools === undefined || tools === null) return null;
  const normalize = (value) => {
    if (value === undefined || value === null) return null;
    if (value instanceof Map) return [...value.keys()].map(String);
    if (Array.isArray(value)) {
      const names = value.map((item) => (typeof item === 'string' ? item : (item && (item.name || item.id)) || '')).filter((item) => item !== '');
      return names.length === 0 && value.length > 0 ? null : names;
    }
    if (typeof value === 'object') return Object.keys(value);
    return null;
  };
  // `schemas` is the documented enumeration on the tools service
  // (`dsh-tool-cordis/lib/types/api-catalog.js`, key `tools`):
  // `schemas(scope?: ScopeKey): ToolSchema[]`. The other names are older guesses kept as
  // fallbacks; without `schemas` the installed card silently showed no tool count even
  // though the MCP client had registered four tools.
  for (const key of ['schemas', 'list', 'all', 'definitions', 'registry', 'entries', 'snapshot', 'names', 'tools']) {
    try {
      const value = Reflect.get(tools, key);
      if (typeof value === 'function') {
        const produced = normalize(value.call(tools));
        if (produced !== null) return produced;
        continue;
      }
      const produced = normalize(value);
      if (produced !== null) return produced;
    } catch {
      /* keep probing */
    }
  }
  return null;
}

/** One installed row's live state, plus the tool count when the build allows reading it. */
function stateOfRow(ctx, manifest, toolNames) {
  const loader = serviceOf(ctx, 'loader');
  let state = 'unknown';
  let error = '';
  try {
    if (loader === undefined || typeof loader.entries !== 'function') state = 'no-loader';
    else {
      const entry = [...loader.entries()].find((item) => item && item.options && item.options.id === manifest.rowId);
      if (entry === undefined) state = 'absent';
      else if (entry.fiber === undefined || entry.fiber === null) state = 'not-loaded';
      else {
        state = FIBER_STATES[entry.fiber.state] || `state-${String(entry.fiber.state)}`;
        error = errorTextOf(entry.fiber);
      }
    }
  } catch (caught) {
    error = String((caught && caught.message) || caught);
  }
  let toolCount = null;
  if (toolNames !== null && typeof manifest.serverName === 'string' && manifest.serverName !== '') {
    const prefix = `mcp__${manifest.serverName}__`;
    toolCount = toolNames.filter((name) => name.startsWith(prefix)).length;
  }
  return { state, error, toolCount };
}

/**
 * Answer the catalog status route.
 *
 * @returns freshness, refresh progress, the machine's runtimes, and the cache path.
 */
function marketStatusResponse() {
  const state = market.catalog();
  return json({
    ok: true,
    value: {
      fetchedAt: state.fetchedAt,
      count: state.count,
      stale: state.stale,
      ageMs: state.ageMs,
      source: state.source,
      refreshing: market.refreshState(),
      runtimes: market.detectRuntimes(),
      cachePath: market.cachePath(),
      installed: market.listInstalled().length,
    },
  });
}

/**
 * Start a snapshot refresh. The pull takes seconds (incremental) or minutes (full), so it
 * runs detached and the UI polls the status route; the previous snapshot keeps answering
 * searches meanwhile.
 *
 * The body selects the mode: `incremental` (the default, asks the registry only for what
 * changed since the last pull and merges) or `full` (re-reads everything and replaces).
 *
 * @param request - the incoming request.
 * @returns the refresh state at the moment the request was accepted.
 */
async function marketRefreshResponse(request) {
  let mode = 'incremental';
  try {
    const body = await request.json();
    if (body !== null && typeof body === 'object' && body.mode === 'full') mode = 'full';
  } catch {
    // No body at all is the incremental case, which is the default.
  }
  if (!market.refreshState().running) void market.refreshCatalog({ mode });
  return json({ ok: true, value: { refreshing: market.refreshState() } });
}

/**
 * Search the cached snapshot locally — never the network.
 *
 * @param request - the incoming request.
 * @returns the page of results plus catalog freshness.
 */
function marketSearchResponse(request) {
  const params = new URL(request.url).searchParams;
  const runtimes = market.detectRuntimes();
  const installed = new Map(market.listInstalled().map((item) => [item.registryName, item]));
  const found = market.searchCatalog(params.get('q') || '', {
    kind: params.get('kind') || 'all',
    sort: params.get('sort') || 'relevance',
    limit: Number(params.get('limit')),
    offset: Number(params.get('offset')),
    // Every card carries its own state, so the whole grid renders from one request.
    decorate: (server) => market.cardStateFor(server, runtimes, installed),
  });
  const state = market.catalog();
  return json({
    ok: true,
    value: { ...found, catalogCount: state.count, fetchedAt: state.fetchedAt, stale: state.stale },
  });
}

/**
 * One catalog entry with every way this machine could install it.
 *
 * @param request - the incoming request.
 * @param ctx - the plugin context.
 * @returns the detail envelope the install dialog renders.
 */
function marketDetailResponse(request, ctx) {
  const name = new URL(request.url).searchParams.get('name') || '';
  const server = market.findServer(name);
  if (server === null) return failure('not-found', `the catalog has no server named "${name}"`, 404);
  const runtimes = market.detectRuntimes();
  const { options, blocked } = market.plansFor(server, runtimes);
  return json({
    ok: true,
    value: {
      server,
      options,
      blocked,
      installed: market.listInstalled().find((item) => item.registryName === name) || null,
      slug: market.slugFor(name),
      serverName: market.serverNameFor(name, takenServerNames(ctx)),
      runtimes,
    },
  });
}

/**
 * Install one catalog entry: write its bundle, then hand it to the official installer.
 *
 * The generated bundle is a real package, so `pluginManager.installBundle` performs the
 * sanctioned profile change (dependency + bundle selection + link) rather than this
 * plugin editing profile configuration behind the manager's back.
 *
 * @param request - the incoming request.
 * @param ctx - the plugin context.
 * @returns the install envelope.
 */
async function marketInstallResponse(request, ctx) {
  const manager = serviceOf(ctx, 'pluginManager');
  if (manager === undefined || typeof manager.installBundle !== 'function') {
    return failure('service-unavailable', 'the pluginManager service is not mounted in this profile', 503);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return failure('bad-request', 'body must be JSON', 400);
  }
  const name = typeof body.name === 'string' ? body.name : '';
  const server = market.findServer(name);
  if (server === null) return failure('not-found', `the catalog has no server named "${name}"`, 404);

  const runtimes = market.detectRuntimes();
  const { options } = market.plansFor(server, runtimes);
  const index = Number.isInteger(body.optionIndex) ? body.optionIndex : 0;
  const plan = options[index];
  if (plan === undefined) {
    return failure('no-install-option', 'this machine has no runtime for any package this server publishes', 409);
  }

  // A reinstall keeps whatever the row already carries: the user's secrets are in the
  // profile, not in this request, and regenerating the patch from scratch would drop them.
  const slug = market.slugFor(name);
  const existing = market.manifestFor(slug);
  const previous = existing === null ? {} : currentRowConfig(ctx, existing.rowId);

  // Only declared variables are written, and only when they carry a value.
  const allowed = new Set(plan.variables.map((variable) => variable.name));
  const config = { ...previous };
  for (const [key, value] of Object.entries(body.config || {})) {
    if (!allowed.has(key)) continue;
    if (typeof value !== 'string' || value === '') continue;
    config[key] = value;
  }
  const missing = plan.variables
    .filter((variable) => variable.isRequired && (config[variable.name] === undefined || config[variable.name] === ''))
    .map((variable) => variable.name);
  if (missing.length > 0) return failure('missing-config', `required configuration is empty: ${missing.join(', ')}`, 400);

  // Argument slots are filled the same way, and a required one left empty is refused
  // before anything is written.
  const provided = body.arguments !== null && typeof body.arguments === 'object' ? body.arguments : {};
  const argumentValues = { ...(existing === null ? {} : existing.argumentValues || {}) };
  for (const [key, value] of Object.entries(provided)) {
    if (typeof value !== 'string' || value === '') continue;
    argumentValues[key] = value;
  }
  const { args, missing: missingArguments } = market.resolveArgv(plan, argumentValues);
  if (missingArguments.length > 0) {
    return failure('missing-arguments', `required arguments are empty: ${missingArguments.join(', ')}`, 400);
  }

  const serverName = market.serverNameFor(name, takenServerNames(ctx));
  let written;
  try {
    written = market.writeBundle({ slug, server, serverName, plan, args, config, argumentValues });
  } catch (error) {
    return failure('write-failed', String((error && error.message) || error), 500);
  }
  try {
    const result = await manager.installBundle(written.dir, { activateNewBundles: true });
    return json({
      ok: true,
      value: {
        slug,
        pkg: written.pkg,
        dir: written.dir,
        serverName,
        reinstalled: existing !== null,
        keptConfigKeys: Object.keys(previous),
        install: result === undefined ? null : result,
      },
    });
  } catch (error) {
    return failure('install-failed', String((error && error.message) || error), 500);
  }
}

/**
 * Remove one generated bundle: the official removal first, the directory only after it.
 *
 * A failed removal keeps the directory so the profile and the market still agree on what
 * exists; deleting first would leave a dependency pointing at nothing.
 *
 * @param request - the incoming request.
 * @param ctx - the plugin context.
 * @returns the uninstall envelope.
 */
async function marketUninstallResponse(request, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return failure('bad-request', 'body must be JSON', 400);
  }
  const slug = typeof body.slug === 'string' ? body.slug : '';
  const manifest = market.manifestFor(slug);
  if (manifest === null) return failure('not-found', `no installed market bundle with slug "${slug}"`, 404);

  const manager = serviceOf(ctx, 'pluginManager');
  if (manager === undefined || typeof manager.removeBundle !== 'function') {
    return failure('service-unavailable', 'the pluginManager service is not mounted in this profile', 503);
  }
  let removed;
  try {
    removed = await manager.removeBundle(manifest.pkg);
  } catch (error) {
    return failure('uninstall-failed', String((error && error.message) || error), 500);
  }
  const deleted = market.removeBundleDir(slug);
  return json({ ok: true, value: { slug, pkg: manifest.pkg, removed: removed === undefined ? null : removed, deleted } });
}

/**
 * The installed list: the generated manifests joined with each row's live state.
 *
 * @param ctx - the plugin context.
 * @returns the installed envelope, including whether the registry has a newer version.
 */
function marketInstalledResponse(ctx) {
  const manifests = market.listInstalled();
  const state = market.catalog();
  const toolNames = toolNamesOf(ctx);
  const items = manifests.map((manifest) => {
    const entry = state.servers.find((server) => server.name === manifest.registryName) || null;
    const live = stateOfRow(ctx, manifest, toolNames);
    return {
      ...manifest,
      state: live.state,
      error: live.error,
      toolCount: live.toolCount,
      latestVersion: entry === null ? null : entry.version,
      updateAvailable: entry !== null && entry.version !== '' && entry.version !== manifest.registryVersion,
    };
  });
  return json({ ok: true, value: { items, count: items.length, toolListing: toolNames !== null } });
}

/**
 * Register the Fetch routes.
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  const connection = serviceOf(ctx, 'connection');
  if (connection === undefined || !connection.fetch || typeof connection.fetch.register !== 'function') return;

  const register = (path, methods, handler) => {
    connection.fetch.register({
      path,
      methods,
      requestBody: 'buffered',
      // The response is returned untouched for every method. Cancelling the body of a
      // non-GET answer looks tidy but silently empties it, and the browser half then sees
      // "HTTP 200" with no JSON — which is exactly how saving a config used to fail.
      // `requestBody` governs the request only; nothing requires a drained response.
      fetch: async (request) => handler(request, ctx),
    });
  };

  register(SERVERS_PATH, ['GET', 'HEAD'], async (_request, context) => serversResponse(context));
  register(HEALTH_PATH, ['GET', 'HEAD'], async (_request, context) => healthResponse(context));
  register(SESSIONS_PATH, ['GET', 'HEAD'], async (_request, context) => sessionsResponse(context));
  register(CALLS_PATH, ['GET', 'HEAD'], async (request, context) => callsResponse(request, context));
  register(CONFIG_PATH, ['POST'], async (request, context) => configResponse(request, context));
  register(ENABLED_PATH, ['POST'], async (request, context) => enabledResponse(request, context));
  register(MARKET_PATH, ['GET', 'HEAD'], async () => marketStatusResponse());
  register(MARKET_SEARCH_PATH, ['GET', 'HEAD'], async (request) => marketSearchResponse(request));
  register(MARKET_DETAIL_PATH, ['GET', 'HEAD'], async (request, context) => marketDetailResponse(request, context));
  register(MARKET_INSTALLED_PATH, ['GET', 'HEAD'], async (_request, context) => marketInstalledResponse(context));
  register(MARKET_REFRESH_PATH, ['POST'], (request) => marketRefreshResponse(request));
  register(MARKET_INSTALL_PATH, ['POST'], async (request, context) => marketInstallResponse(request, context));
  register(MARKET_UNINSTALL_PATH, ['POST'], async (request, context) => marketUninstallResponse(request, context));
}
