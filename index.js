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
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as market from './market.js';
import * as repair from './repair.js';
import * as tx from './tx.js';

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
export const MARKET_REPAIR_PATH = '/api/mcp-manager/market/repair';
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
  // The id is chosen by the caller and this plugin manages MCP rows only. The lookup is by id
  // alone, so without the module check the same request would rewrite any other plugin's
  // configuration — every other entry lookup in this file narrows on the module for that reason.
  const entry = (Array.isArray(entries) ? entries : []).find((candidate) => idOfEntry(candidate) === id && moduleOfEntry(candidate) === MCP_MODULE);
  if (entry === undefined) return failure('entry-not-found', 'no MCP row with id ' + id, 404);

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

  // `setPluginEnabled` acts on whatever row the caller names, so the row is resolved first and
  // refused unless it is an MCP row. Without this the same request could stop any other plugin.
  const editor = serviceOf(ctx, 'configEditor');
  if (editor === undefined || typeof editor.entries !== 'function') {
    return failure('service-unavailable', 'the configEditor service is not mounted, so the target row cannot be checked', 503);
  }
  const entries = editor.entries();
  const entry = (Array.isArray(entries) ? entries : []).find((candidate) => idOfEntry(candidate) === id && moduleOfEntry(candidate) === MCP_MODULE);
  if (entry === undefined) return failure('entry-not-found', 'no MCP row with id ' + id, 404);

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
 * The MCP rows this profile actually has loaded.
 *
 * `null` means the profile could not be read, which is not the same answer as "no rows": an
 * unreadable profile cannot prove a name is free, so the caller is told the identity is unverified
 * instead of being handed an empty list that looks like a clean slate.
 *
 * @param ctx - the plugin context.
 * @returns `[{id, serverName}]`, or `null` when `configEditor` cannot list rows.
 */
function profileMcpRows(ctx) {
  const editor = serviceOf(ctx, 'configEditor');
  if (editor === undefined || typeof editor.configuration !== 'function') return null;
  const rows = [];
  try {
    for (const item of editor.configuration() || []) {
      const entry = item && item.entry;
      if (moduleOfEntry(entry) !== MCP_MODULE) continue;
      const effective = { ...((item && item.inherited) || {}), ...((item && item.override) || {}) };
      rows.push({
        id: idOfEntry(entry),
        serverName: typeof effective.serverName === 'string' ? effective.serverName : '',
      });
    }
  } catch {
    /* a failing read proves as little as no read; the caller reports it as unverified */
    return null;
  }
  return rows;
}

/**
 * The names the rows other than `ownRowId` already hold.
 *
 * The exclusion is by row identity and never by name. Dropping every entry that happens to spell
 * the same name would also hide the day a genuinely different row holds it — which is the case
 * that has to be reported rather than named around.
 *
 * @param rows - the profile rows, or `null` when unreadable.
 * @param ownRowId - the row being installed, excluded from the collision check.
 * @returns the taken names.
 */
function takenServerNames(rows, ownRowId) {
  const names = [];
  for (const row of rows || []) {
    if (row.id === ownRowId) continue;
    if (row.serverName !== '') names.push(row.serverName);
  }
  return names;
}

/**
 * Resolve one catalog entry's row identity from both the disk and the profile.
 *
 * The install dialog and the install route both call this, so what the dialog promises is what the
 * write performs. The two sources are compared rather than assumed to agree:
 *
 * - the generated bundle on disk, which records what a past install *wrote*;
 * - the live profile rows, which show what DSH has actually *loaded*.
 *
 * A bundle with no matching row is reported as such. Treating the manifest's existence as proof of
 * installation is precisely how a half-finished install comes to look like a healthy one.
 *
 * @param ctx - the plugin context.
 * @param name - the registry entry name.
 * @returns `{slug, rowId, serverName, mode, state, conflict, detail, manifest}`.
 */
function identityFor(ctx, name) {
  const slug = market.slugFor(name);
  const manifest = market.manifestFor(slug);
  const rows = profileMcpRows(ctx);
  const expectedRowId = market.rowIdForSlug(slug);
  const recordedRowId = manifest !== null && typeof manifest.rowId === 'string' && manifest.rowId !== '' ? manifest.rowId : '';
  const recordedName = manifest !== null && typeof manifest.serverName === 'string' ? manifest.serverName.trim() : '';
  const rowId = recordedRowId === '' ? expectedRowId : recordedRowId;
  const own = rows === null ? null : rows.find((row) => row.id === rowId) || null;

  let state = 'fresh';
  if (rows === null) state = manifest === null ? 'fresh' : 'profile-unreadable';
  else if (own !== null) state = 'update';
  else if (manifest !== null) state = 'manifest-without-row';

  // The loaded row is the authority on its own name; the manifest is only a fallback for a profile
  // that cannot be read, and only when it records a name the client would accept.
  const current = state === 'update'
    ? { rowId, serverName: own.serverName }
    : state === 'profile-unreadable' && market.SERVER_NAME_PATTERN.test(recordedName)
      ? { rowId, serverName: recordedName }
      : null;

  const resolved = market.resolveIdentity({ name, slug, taken: takenServerNames(rows, rowId), current });
  const notes = [];
  if (state === 'manifest-without-row') {
    notes.push(`a bundle for "${name}" is on disk but no MCP row ${rowId} is loaded in this profile, so it is not installed`);
  }
  if (state === 'profile-unreadable') {
    notes.push('the configEditor service cannot list rows, so the bundle on disk could not be compared with the profile');
  }
  if (recordedRowId !== '' && recordedRowId !== expectedRowId) {
    notes.push(`the bundle records row id ${recordedRowId} where ${expectedRowId} was expected`);
  }
  if (state === 'update' && recordedName !== '' && recordedName !== own.serverName) {
    notes.push(`the loaded row is named "${own.serverName}" while the bundle records "${recordedName}"; the loaded row wins`);
  }
  return {
    slug,
    rowId: resolved.rowId,
    serverName: resolved.serverName,
    mode: resolved.mode,
    state,
    conflict: resolved.ok === true ? '' : resolved.reason,
    detail: notes.join('; '),
    manifest,
  };
}

/**
 * What can be said about the profile once the installer has answered.
 *
 * Deliberately small, and deliberately two questions: is this bundle a dependency of the profile
 * (`pluginManager.listBundles()`, the official reader), and is the row live in the running
 * configuration (`configEditor.configuration()`). It does **not** compare the effective
 * configuration, the render digest or the surrounding rows; that is P2-3B.
 *
 * `persisted` is not a weaker word for `live` — it is the honest state after a
 * `restart-required` outcome, where the profile has the change and the running process does not.
 *
 * @param ctx - the plugin context.
 * @param manager - the plugin manager service.
 * @param pkg - the bundle package name this install wrote.
 * @param rowId - the row it inserted.
 * @param serverName - the name that row loads under.
 * @returns `{state, verified, reason}` with `state` one of `live|persisted|not-applied|unavailable`.
 */
function postInstallVerification(ctx, manager, pkg, rowId, serverName, runtime = null) {
  const rows = profileMcpRows(ctx);
  let bundles = null;
  try {
    if (manager !== undefined && typeof manager.listBundles === 'function') {
      const listed = manager.listBundles();
      if (Array.isArray(listed)) bundles = listed;
    }
  } catch {
    bundles = null;
  }
  if (rows === null || bundles === null) {
    const missing = [];
    if (rows === null) missing.push('the configEditor service cannot list rows');
    if (bundles === null) missing.push('the pluginManager cannot list bundles');
    return {
      state: 'unavailable', verified: false,
      reason: `${missing.join(' and ')}, so the install could not be checked against the profile`,
    };
  }
  const bundle = bundles.find((item) => item !== null && typeof item === 'object' && item.name === pkg) || null;
  if (bundle === null || bundle.installed !== true) {
    return {
      state: 'not-applied', verified: false,
      reason: `the plugin manager reported success but the profile has no installed dependency "${pkg}"`,
    };
  }
  const live = rows.some((row) => row.id === rowId && row.serverName === serverName);
  if (live && runtime !== null && runtime.state === 'stale') {
    // The row exists, but it is still the one that was there before this install: the running
    // configuration has not picked the new version up, so calling it live would be a claim this
    // process cannot support.
    return {
      state: 'persisted', verified: false,
      reason: `the profile has "${pkg}", but row ${rowId} is still carrying its previous configuration in the running process`,
    };
  }
  if (live) return { state: 'live', verified: true, reason: '' };
  return {
    state: 'persisted', verified: false,
    reason: `"${pkg}" is installed in the profile, but row ${rowId} is not in the running configuration yet`,
  };
}

/** The sentence a refused install answers with: the installer's own words first. */
function installRefusalMessage(outcome) {
  const parts = [];
  if (outcome.errorCode !== '') parts.push(outcome.errorCode);
  if (outcome.diagnostic !== '') parts.push(outcome.diagnostic);
  if (outcome.failedAt !== '') parts.push('failed at ' + outcome.failedAt);
  if (outcome.reason !== '') parts.push(outcome.reason);
  return parts.length > 0 ? parts.join(' — ') : 'the install did not take effect';
}

/** The current profile as the DSH host describes it, or `null` when the host did not say. */
function currentProfileOf(ctx) {
  const profile = serviceOf(ctx, 'profileContext');
  if (profile === undefined || profile === null || typeof profile !== 'object') return null;
  const dir = typeof profile.dir === 'string' ? profile.dir : '';
  if (dir === '') return null;
  return { name: typeof profile.name === 'string' ? profile.name : '', dir };
}

/**
 * Whether this bundle may be changed in place, and who else would notice if it were.
 *
 * `MARKET_ROOT` is keyed by HOME, so a bundle written for one profile can be the bundle another
 * profile loads. An update and an uninstall both have to know who else uses it — and which of those
 * users is *this* profile, which only the host's `profileContext` can say. Without that identity a
 * single reference is not evidence that the reference is ours, so nothing is changed.
 *
 * @param ctx - the plugin context.
 * @param slug - the bundle slug.
 * @returns `{ok: true, references}` or `{ok: false, code, message, path, sharedWith}`.
 */
function sharedBundleRefusal(ctx, slug) {
  const dir = market.bundleDir(slug);
  const links = market.bundleReferences(slug, currentProfileOf(ctx));
  if (links.ok !== true) return { ok: false, code: links.code, message: links.reason, path: dir, sharedWith: [] };
  if (links.references.length === 0) return { ok: true, references: [] };
  const foreign = links.references.filter((reference) => reference.current !== true);
  if (links.ownership !== 'known') {
    const names = links.references.map((reference) => reference.profile).join(', ');
    return {
      ok: false,
      code: 'shared-bundle-unknown',
      message: `${dir} is referenced by ${links.references.length} profile(s) (${names}), and this process cannot tell which profile is asking, so nothing is changed`,
      path: dir,
      sharedWith: links.references,
    };
  }
  if (foreign.length > 0) {
    return {
      ok: false,
      code: 'shared-bundle',
      message: `${dir} is also used by ${foreign.map((reference) => reference.profile).join(', ')}, so changing it would change what another profile loads`,
      path: dir,
      sharedWith: foreign,
    };
  }
  return { ok: true, references: links.references };
}

/** The body of a refusal that names whoever is holding the slug. */
function lockRefusal(held) {
  return {
    code: held.code,
    message: held.reason,
    path: typeof held.path === 'string' ? held.path : '',
    ...(held.holder === undefined ? {} : { holder: held.holder, holderAlive: held.holderAlive === true }),
  };
}

/**
 * Run one market mutation under its slug's global lock.
 *
 * Every profile under this HOME links to the SAME physical bundle directory
 * (`MARKET_ROOT` is keyed by HOME, not by profile), and DSH's own `withFileLock` guards only the
 * profile's `package.json` — not the bundle files this plugin writes, and not a second profile. So
 * install, update and uninstall all take one slug lock here, before the handler runs, and give it
 * back on every way out.
 *
 * The body is read here to learn which slug the request names, and handed to the handler unchanged,
 * so the route still parses exactly what the caller sent.
 *
 * @param request - the incoming request.
 * @param ctx - the plugin context.
 * @param kind - `'install'` or `'uninstall'`, which decides the operation name.
 * @param slugOf - reads the slug out of the parsed body.
 * @param handler - the route being run.
 * @returns the handler's answer, or a refusal when the slug is already being worked on.
 */
async function lockedMarketRoute(request, ctx, kind, slugOf, handler) {
  let text;
  try {
    text = await request.text();
  } catch (error) {
    return failure('bad-request', `the body could not be read: ${String((error && error.message) || error)}`, 400);
  }
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const replay = () => handler(new Request(request.url, { method: request.method, headers: request.headers, body: text }), ctx);
  // Nothing addressable is named, so there is no slug to lock and nothing this wrapper can add: the
  // handler refuses on its own terms, without writing anything.
  const slug = body === null || typeof body !== 'object' ? '' : String(slugOf(body) || '');
  if (!market.SLUG_PATTERN.test(slug)) return replay();
  const op = kind === 'uninstall' ? 'uninstall' : market.manifestFor(slug) === null ? 'install' : 'update';
  const held = market.acquireOperationLock({ slug, op });
  if (held.ok !== true) return json({ ok: false, error: lockRefusal(held) }, 409);
  try {
    return await replay();
  } finally {
    market.releaseOperationLock(held);
  }
}

/** The identity block both the preview and the install answer with. */
function identityValue(identity) {
  return {
    rowId: identity.rowId,
    serverName: identity.serverName,
    mode: identity.mode,
    state: identity.state,
    conflict: identity.conflict,
    detail: identity.detail,
  };
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
  // "Running" alone hides the failure that started this: a row whose endpoint answers 401
  // connects, registers nothing, and looks healthy. Three states, and the UI says which.
  const toolState = toolNames === null
    ? 'unknown'
    : (toolCount === null || toolCount === 0 ? 'none' : 'ok');
  return { state, error, toolCount, toolState };
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
    // The provenance axis. The Client half has always sent it; this half simply never read
    // it, so the 自建 chip changed the chip state and nothing else.
    source: params.get('source') || 'all',
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
  // The same resolver the install route uses, so the name the dialog shows is the name that is
  // written. It is also where a conflict becomes visible before anything is clicked.
  const identity = identityFor(ctx, name);
  return json({
    ok: true,
    value: {
      server,
      options,
      blocked,
      installed: market.listInstalled().find((item) => item.registryName === name) || null,
      slug: identity.slug,
      serverName: identity.serverName,
      identity: identityValue(identity),
      runtimes,
      // The install dialog needs these without reaching into `server`: whether this entry
      // comes from the local file, which registry entry it covers, and whether its command
      // line was flagged.
      source: server.source === 'local' ? 'local' : 'registry',
      coversRegistry: server.coversRegistry === true,
      coversVersion: server.coversVersion || '',
      warning: server.warning === true,
      warningReasons: server.warningReasons || [],
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

  // One identity decision, shared with the preview route. A conflict is refused here rather than
  // named around: the name is what every `mcp__<serverName>__*` reference already points at.
  const identity = identityFor(ctx, name);
  if (identity.conflict !== '') return failure('identity-conflict', identity.conflict, 409);

  // This bundle directory is shared by every profile under this HOME, so an in-place update is only
  // this request's to make when no other profile loads the same content. A single reference is this
  // profile's own — it has the row — while anything more, or a reference set that cannot be read,
  // is refused rather than guessed at. The check runs inside the slug lock and before any write.
  const shared = sharedBundleRefusal(ctx, identity.slug);
  if (shared.ok !== true) {
    return json({ ok: false, error: { code: shared.code, message: shared.message, path: shared.path, sharedWith: shared.sharedWith } }, 409);
  }

  const slug = identity.slug;
  // What an earlier run left behind is reported, never adopted. Its owner cannot be proven from
  // here, and continuing would write over state somebody else may still need.
  const leftover = tx.residue(market.MARKET_ROOT, slug);
  if (leftover.present) {
    return json({
      ok: false,
      error: {
        code: 'residue-present',
        message: `an earlier transaction on ${slug} did not finish (${leftover.reason}); it is left exactly as it is for a person to look at`,
        residue: { journal: leftover.journal, staging: leftover.staging, backups: leftover.backups },
      },
    }, 409);
  }

  // A reinstall keeps whatever the row already carries: the user's secrets are in the
  // profile, not in this request, and regenerating the patch from scratch would drop them.
  const existing = identity.manifest;
  const previous = existing === null ? {} : currentRowConfig(ctx, identity.rowId);

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

  const serverName = identity.serverName;
  // What the bundle is written with. An mcpb plan replaces it below, once its manifest has
  // been read — `args` itself is a const, which an earlier attempt here learned the hard way.
  let installArgs = args;

  // ---------------------------------------------------------------------------------------------
  // From here on everything belongs to one transaction. It is staged in full, announced in a
  // journal before either rename, and only then published and applied — so a failure at any point
  // can either put the previous version back or say plainly that it could not.
  // ---------------------------------------------------------------------------------------------
  const txid = tx.newTxid();
  const paths = tx.txPaths(market.MARKET_ROOT, slug);
  const staged = tx.openStaging(market.MARKET_ROOT, slug, txid);
  if (staged.ok !== true) {
    return failure('staging-failed', `a staging directory could not be made: ${staged.reason}`, 500);
  }
  const backupPath = join(paths.backup, txid);
  const announce = (phase, intent) => tx.writeJournal(market.MARKET_ROOT, slug, {
    txid,
    slug,
    phase,
    intent,
    operation: identity.mode === 'update' ? 'update' : 'install',
    expected: { rowId: identity.rowId, serverName },
    staging: relativeOf(market.MARKET_ROOT, staged.dir),
    backup: relativeOf(market.MARKET_ROOT, backupPath),
    profile: currentProfileName(ctx),
  });
  /** Nothing has been published yet, so giving up only has to drop the staging directory. */
  const abandon = (response) => {
    tx.discardStaging(market.MARKET_ROOT, slug, txid);
    return response;
  };

  // An mcpb plan carries no command line: it lives in the package's manifest, which only exists
  // after the download. The download happens inside the staging directory, so the published bundle
  // is not touched before the whole next version is known to be complete.
  let mcpbInfo = null;
  if (plan.needsDownload === true && plan.registryType === 'mcpb') {
    // Wrapped because an exception here leaves the route with no body, and the UI then shows a
    // bare "HTTP 400" — the silent failure this whole round has been about, in a new place.
    try {
      const targetDir = join(staged.dir, 'mcpb');
      const fetched = await market.fetchMcpb(plan.identifier, targetDir);
      if (!fetched.ok) return abandon(failure('mcpb-download-failed', fetched.reason, 400));
      // The form cannot know these keys before the download — they live in the manifest, and the
      // plan offered for an mcpb entry declares no variables at all. So the request's values are
      // accepted here, against the keys the manifest actually declares, and only then is the
      // manifest mapped: a value that arrived is what makes `isRequired` go quiet.
      const declared = new Set(market.declaredConfigKeys(fetched.manifest));
      for (const [key, value] of Object.entries(body.config || {})) {
        if (!declared.has(key)) continue;
        if (typeof value !== 'string' || value === '') continue;
        config[key] = value;
      }
      // The command line has to name where the files will END UP, not where they are now: staging
      // is renamed into place before anything runs, so a path into the staging directory would be
      // a path into a directory that does not exist by the time the server starts.
      const mapped = market.planFromMcpb(fetched.manifest, join(market.bundleDir(slug), 'mcpb', 'extracted'), config, ctx);
      if (!mapped.ok) return abandon(failure('mcpb-manifest-rejected', mapped.reason, 400));
      // Refused rather than installed with blanks: a row whose required configuration is empty
      // starts, exposes nothing, and reports "0 tools" — the failure would look like the
      // package's fault. The declared fields travel back so the dialog can ask for them.
      const unfilled = mapped.variables
        .filter((variable) => variable.isRequired && (config[variable.name] === undefined || config[variable.name] === ''))
        .map((variable) => variable.name);
      if (unfilled.length > 0) {
        return abandon(json({
          ok: false,
          error: {
            code: 'mcpb-config-required',
            message: `这个包需要先填写配置才能安装：${unfilled.join('、')}`,
          },
          value: { identifier: plan.identifier, variables: mapped.variables },
        }, 400));
      }
      plan.command = mapped.command;
      plan.env = mapped.env;
      installArgs = mapped.args;
      // A count, not the listing: the manifest is an audit record, and the entry names are noise.
      mcpbInfo = { identifier: plan.identifier, bytes: fetched.bytes, entries: fetched.entries.length, entryPoint: mapped.entryPoint };
    } catch (error) {
      return abandon(failure('mcpb-install-crashed', `mcpb 安装过程出错：${String((error && error.message) || error)}`, 500));
    }
  }

  // The row's env / headers names are the two places a third-party entry gets to write YAML
  // *structure* rather than a value. They are checked here, before this install owns any file, so
  // a bad name cannot leave half a bundle behind — and it is refused, never quietly dropped.
  const keyBlock = market.configBlockFor(plan, config);
  const keyCheck = market.checkBlockKeys(keyBlock.kind, keyBlock.values);
  if (keyCheck.ok !== true) return abandon(failure(keyCheck.code, keyCheck.reason, 400));

  // What the profile holds before the installer runs. A change found afterwards has to be
  // attributable to this transaction before anything is undone; an unreadable profile is not an
  // unchanged one, and is treated as the more dangerous of the two.
  const profileBefore = profileFingerprint(ctx, manager);

  const stagedWrite = tx.writeStaged(market.MARKET_ROOT, slug, txid, (dir) => market.writeBundle({
    slug, rowId: identity.rowId, server, serverName, plan, args: installArgs, config, argumentValues, mcpbInfo, dir, txid,
  }));
  if (stagedWrite.ok !== true) {
    const reason = stagedWrite.reason;
    // A bundle path that is a link is not a failed write but a refused one: nothing may be written
    // through it, and nothing was.
    if (reason.includes('invalid-bundle-path')) return failure('invalid-bundle-path', reason, 409);
    return failure('staging-failed', `the bundle could not be staged: ${reason}`, 500);
  }
  // The installer is handed the published path, not the staging path: that is the directory the
  // profile's package manager links to, and the one every reader of the manifest will find.
  const written = { ...stagedWrite.result, dir: market.bundleDir(slug) };

  // A download just happened, which is long enough for another profile to start using this bundle.
  // So the answer is asked again, immediately before anything is published.
  const again = sharedBundleRefusal(ctx, slug);
  if (again.ok !== true) {
    return abandon(json({ ok: false, error: { code: again.code, message: again.message, path: again.path, sharedWith: again.sharedWith } }, 409));
  }

  const journaled = announce('JOURNALED', 'backup-and-publish');
  if (journaled.ok !== true) {
    return abandon(failure('journal-failed', `the transaction could not be recorded, so nothing was changed: ${journaled.reason}`, 500));
  }

  const published = tx.publish({
    root: market.MARKET_ROOT,
    slug,
    bundleDir: market.bundleDir(slug),
    txid,
    existed: existsSync(market.bundleDir(slug)),
    announce,
  });
  if (published.ok !== true) {
    const needsRestore = published.backedUp === true || published.published === true;
    const put = needsRestore
      ? tx.restore({
        root: market.MARKET_ROOT, slug, bundleDir: market.bundleDir(slug), txid, announce,
        owns: tx.publishedTxid(market.bundleDir(slug)) === txid,
      })
      : { ok: true, restored: false };
    if (put.ok !== true) {
      announce('NEEDS_ATTENTION', 'publish-failed-restore-failed');
      return installAttention('publish-failed', `${published.reason} — and the previous version could not be put back: ${put.reason}`, 500, {
        written, identity, txid, journal: paths.journal, backup: backupPath,
      });
    }
    tx.discardStaging(market.MARKET_ROOT, slug, txid);
    tx.clearJournal(market.MARKET_ROOT, slug);
    return installFailed('publish-failed', `the prepared version could not be published: ${published.reason}`, 500, {
      written, identity, txid, phase: 'ROLLED_BACK', restored: put.restored === true, backup: backupPath,
    });
  }

  announce('APPLYING', 'install');
  // The installer answers with a ChangeResult, and it RESOLVES even when the install failed —
  // `change()` folds every operation error into that result. So the promise settling is not the
  // news; `application` is, and it is read before anything is reported.
  let result;
  try {
    result = await manager.installBundle(written.dir, { activateNewBundles: true });
  } catch (error) {
    return settleFailure('install-failed', String((error && error.message) || error), 502, {
      ctx, manager, slug, txid, written, identity, result: null, announce, paths, backupPath, profileBefore,
    });
  }
  const outcome = market.installOutcome(result);
  if (outcome.ok !== true) {
    return settleFailure(outcome.code, installRefusalMessage(outcome), 502, {
      ctx, manager, slug, txid, written, identity, result, announce, paths, backupPath, profileBefore,
    });
  }
  // The installer's own answer, written down with the operation that received it, before anything is
  // verified: a later recovery reads what was answered instead of inferring a restart from a row
  // that is not there. Only the fixed set of words is stored — never a configured value.
  market.recordPublishedApplication(written.dir, {
    application: typeof result.application === 'string' ? result.application : '',
    txid,
    profile: profileNameOf(ctx),
    rowId: identity.rowId,
    at: new Date().toISOString(),
  });
  const runtime = runtimeVerdict(ctx, identity.rowId, previous);
  announce('VERIFYING', 'verify');
  const verification = postInstallVerification(ctx, manager, written.pkg, identity.rowId, serverName, runtime);
  if (verification.state === 'not-applied') {
    return settleFailure('install-not-applied', verification.reason, 500, {
      ctx, manager, slug, txid, written, identity, result, verification, announce, paths, backupPath, profileBefore,
    });
  }
  announce('DONE', 'done');
  // A finished transaction keeps nothing: the journal has served its purpose, the backup is no
  // longer needed, and the staging directory is already the published bundle.
  tx.discardBackup(market.MARKET_ROOT, slug, txid);
  tx.clearJournal(market.MARKET_ROOT, slug);
  return json({
    ok: true,
    value: {
      slug,
      pkg: written.pkg,
      dir: written.dir,
      rowId: identity.rowId,
      serverName,
      txid,
      phase: 'DONE',
      // No digest: the client has no use for one, and a digest is not a thing to hand around.
      // "reinstalled" means the profile really has this row. It used to mean only that files for
      // this slug were on disk, which an install that never took effect also leaves behind.
      reinstalled: identity.mode === 'update',
      keptConfigKeys: Object.keys(previous),
      identity: identityValue(identity),
      // How far this request actually got: `live`, `persisted` (the profile has it, the running
      // process does not — the honest reading of `restart-required`), or `unavailable`.
      verification,
      runtime,
      outcome: outcomeOf(verification, result),
      install: result === undefined ? null : result,
    },
  });
}

/** A path as the journal records it: relative to the market root, so it moves with the root. */
function relativeOf(root, full) {
  return full.startsWith(root) ? full.slice(root.length + 1).split('\\').join('/') : full;
}

/** The name of the profile asking, or an empty string when the host did not say. */
function currentProfileName(ctx) {
  const profile = currentProfileOf(ctx);
  return profile === null ? '' : profile.name;
}

/**
 * What the profile holds right now, in a form two moments can be compared in.
 *
 * `null` is not "nothing": it is "this cannot be read", which a compensation decision has to treat
 * as the more dangerous answer, not as an empty profile.
 */
function profileFingerprint(ctx, manager) {
  const rows = profileMcpRows(ctx);
  let bundles = null;
  try {
    if (manager !== undefined && typeof manager.listBundles === 'function') {
      const listed = manager.listBundles();
      if (Array.isArray(listed)) bundles = listed.map((item) => (item === null || typeof item !== 'object' ? '' : String(item.name)));
    }
  } catch {
    bundles = null;
  }
  if (rows === null || bundles === null) return null;
  return JSON.stringify({
    rows: rows.map((row) => [row.id, row.serverName]),
    bundles: bundles.slice().sort(),
  });
}

/** How the row this install wrote compares with the one the profile was already carrying. */
function runtimeVerdict(ctx, rowId, previousConfig) {
  const rows = profileMcpRows(ctx);
  if (rows === null) return { state: 'unknown', detail: 'the configEditor service cannot list rows' };
  const row = rows.find((candidate) => candidate.id === rowId) || null;
  if (row === null) return { state: 'absent', detail: 'the row is not in the running configuration' };
  const current = currentRowConfig(ctx, rowId);
  if (JSON.stringify(current) !== JSON.stringify(previousConfig)) {
    return { state: 'matches', detail: 'the running configuration carries a different row than it did before' };
  }
  return {
    state: 'stale',
    detail: 'the row in the running configuration is still the one that was there before this install',
  };
}

/** The verdict this request answers with once the persisted and running states are both known. */
function outcomeOf(verification, result) {
  const application = result !== null && result !== undefined && typeof result.application === 'string' ? result.application : '';
  if (verification.state === 'live') return 'applied';
  if (verification.state === 'persisted') return application === 'restart-required' ? 'restart-required' : 'persisted-not-live';
  // Nothing could be read, so nothing about this install can be confirmed — including the
  // installer's own claim, which is exactly what could not be checked.
  if (verification.state === 'unavailable') return 'unknown';
  return application === '' ? 'unknown' : application;
}

/**
 * The answer a failed install gives: what failed, and what the transaction did about it.
 *
 * A failure the transaction could undo is reported with the installer's own classification. One it
 * could not is reported as needing attention, and `needsAttention` is what tells a caller that the
 * journal and the backup on disk are the state to look at.
 */
function installFailed(code, message, status, { written, identity, txid, phase, restored, backup, result, verification }) {
  return json({
    ok: false,
    error: { code, message, txid, phase },
    value: {
      slug: written.slug,
      pkg: written.pkg,
      dir: written.dir,
      rowId: identity.rowId,
      serverName: identity.serverName,
      identity: identityValue(identity),
      ...(verification === undefined ? {} : { verification }),
      install: result === null || result === undefined ? null : result,
      txid,
      phase,
      rollback: {
        previousRestored: restored === true,
        backup: restored === true ? '' : backup,
        note: restored === true
          ? 'the previous version was put back and the transaction left nothing behind'
          : 'the new version was removed; there was no previous version to restore',
      },
    },
  }, status);
}

/** The answer a failure gives when the transaction could not get back to where it started. */
function installAttention(code, message, status, { written, identity, txid, journal, backup }) {
  return json({
    ok: false,
    error: { code: 'needs-attention', message, cause: code, txid, phase: 'NEEDS_ATTENTION', journal, backup, needsAttention: true },
    value: {
      slug: written.slug,
      pkg: written.pkg,
      dir: written.dir,
      rowId: identity.rowId,
      serverName: identity.serverName,
      identity: identityValue(identity),
      txid,
      phase: 'NEEDS_ATTENTION',
      rollback: {
        previousRestored: false,
        backup,
        journal,
        note: 'this transaction could not be completed or undone, so nothing else was touched: the journal and the backup are the state to inspect',
      },
    },
  }, status);
}

/**
 * Decide what to do after the installer failed, and do only that.
 *
 * The profile is compared with what it held before the installer ran. A change that this request
 * could not have made, or a profile that cannot be read at all, means the change cannot be
 * attributed — and an unattributable profile change is never undone by calling `removeBundle`,
 * because that call has its own effects. Everything is kept and named instead.
 */
function settleFailure(code, message, status, { ctx, manager, slug, txid, written, identity, result, verification, announce, paths, backupPath, profileBefore }) {
  const after = profileFingerprint(ctx, manager);
  const attributable = profileBefore !== null && after !== null && profileBefore === after;
  if (!attributable) {
    const why = profileBefore === null || after === null
      ? 'the profile state could not be read'
      : 'the profile changed while this install was running';
    announce('NEEDS_ATTENTION', profileBefore === null || after === null ? 'profile-unreadable' : 'profile-changed');
    return installAttention(code, `${message} — and ${why}, so the change cannot be attributed to this install and nothing was undone`, status, {
      written, identity, txid, journal: paths.journal, backup: backupPath,
    });
  }
  const put = tx.restore({
    root: market.MARKET_ROOT, slug, bundleDir: market.bundleDir(slug), txid, announce,
    owns: tx.publishedTxid(market.bundleDir(slug)) === txid,
  });
  if (put.ok !== true) {
    announce('NEEDS_ATTENTION', 'restore-failed');
    return installAttention(code, `${message} — and the previous version could not be put back: ${put.reason}`, status, {
      written, identity, txid, journal: paths.journal, backup: backupPath,
    });
  }
  tx.clearJournal(market.MARKET_ROOT, slug);
  return installFailed(code, message, status, {
    written, identity, txid, phase: 'ROLLED_BACK', restored: put.restored === true, backup: backupPath, result, verification,
  });
}

/**
 * Repair one leftover transaction, explicitly and only with evidence.
 *
 * The caller names an action; it does not name a state. Everything that decides whether the action
 * is allowed — the diagnosis, the ownership of each directory, whether the content still matches
 * what was rendered, what the profile says — is recomputed here (and again under the lock), and the
 * decision itself lives in \`repair.js\`. This route only validates the request, takes the lock,
 * re-reads, and converts the outcome into an answer.
 *
 * A dry run takes no lock and writes nothing, so it can be asked at any time. The commit is
 * required to agree with the plan it was given: if the state moved in between, it is refused rather
 * than applied to a situation nobody agreed to.
 *
 * @param request - the incoming request.
 * @param ctx - the plugin context.
 * @returns the repair envelope.
 */
async function marketRepairResponse(request, ctx) {
  const manager = serviceOf(ctx, 'pluginManager');
  let body;
  try {
    body = await request.json();
  } catch {
    return failure('bad-request', 'body must be JSON', 400);
  }
  const slug = typeof body.slug === 'string' ? body.slug : '';
  if (!market.SLUG_PATTERN.test(slug)) {
    return failure('bad-request', 'slug must be a slug this plugin produced, never a path', 400);
  }
  const action = typeof body.action === 'string' ? body.action : '';
  if (!repair.REPAIR_ACTIONS.includes(action)) {
    return failure('unknown-action', `"${action}" is not a repair action; expected one of ${repair.REPAIR_ACTIONS.join(', ')}`, 400);
  }
  const txid = typeof body.txid === 'string' ? body.txid : '';
  const expect = body.expect !== null && typeof body.expect === 'object' ? body.expect : null;
  const bundleDir = market.bundleDir(slug);
  const inputs = (selfTxid) => repairInputs(ctx, manager, slug, selfTxid === undefined ? '' : selfTxid);
  const planned = (evidence) => repair.planRepair({
    action, slug, txid, diagnosis: evidence.diagnosis, live: evidence.live, row: evidence.row,
    profile: evidence.profile, root: market.MARKET_ROOT, bundleDir,
  });

  if (body.dryRun === true) {
    const evidence = inputs();
    const plan = planned(evidence);
    return json({ ok: true, value: repairAnswer(plan, evidence, { dryRun: true, outcome: plan.outcome }) });
  }

  const held = market.acquireOperationLock({ slug, op: 'repair' });
  if (held.ok !== true) {
    // A repair is refused by a lock exactly like an install is, and the holder is named: holding a
    // lock and being dead are different answers, and the caller needs to see which one this is.
    return json({ ok: false, error: { code: 'lock-blocked', message: held.reason, lock: market.lockStateFor(slug) } }, 409);
  }
  try {
    const evidence = inputs(held.txid);
    if (expect !== null && (expect.state !== evidence.diagnosis.state || String(expect.phase || '') !== evidence.diagnosis.phase)) {
      return json({
        ok: false,
        error: {
          code: 'stale-transaction',
          message: `this slug is now ${evidence.diagnosis.state} (${evidence.diagnosis.phase === '' ? 'no phase' : evidence.diagnosis.phase}), which is not the ${expect.state} the plan was made against`,
          state: evidence.diagnosis.state,
          phase: evidence.diagnosis.phase,
        },
      }, 409);
    }
    const plan = planned(evidence);
    if (plan.allowed !== true) {
      return json({
        ok: false,
        error: { code: plan.code, message: plan.reasons.join('; '), reasons: plan.reasons, state: plan.state, phase: plan.phase },
        value: repairAnswer(plan, evidence, { dryRun: false, outcome: 'refused', verified: false, live: false }),
      }, 409);
    }
    const done = repair.executeRepair({
      action, root: market.MARKET_ROOT, slug, txid: plan.txid, plan, bundleDir,
      expected: { rowId: evidence.live.rowId || '', serverName: evidence.live.serverName || '' },
    });
    if (done.ok !== true) {
      return json({
        ok: false,
        error: { code: done.code, message: done.message, needsAttention: done.code === 'needs-attention', txid: plan.txid },
        value: repairAnswer(plan, evidence, { dryRun: false, outcome: done.outcome }),
      }, 500);
    }
    return json({
      ok: true,
      value: repairAnswer(plan, evidence, {
        dryRun: false,
        outcome: done.outcome,
        pendingRestart: done.pendingRestart === true,
        verified: done.verified === true,
        live: done.live === true,
        quarantineLeft: done.quarantineLeft === true,
        restartEvidence: done.restartEvidence,
      }),
    });
  } finally {
    market.releaseOperationLock(held);
  }
}

/** Everything the repair decision needs, read once, without writing anything. */
/** The profile this request is being served for, as the identity it is registered under. */
function profileNameOf(ctx) {
  const profile = serviceOf(ctx, 'profileContext');
  return profile !== null && profile !== undefined && typeof profile.name === 'string' ? profile.name : '';
}

function repairInputs(ctx, manager, slug, selfTxid = '') {
  const live = tx.readLiveBundle(market.bundleDir(slug));
  const diagnosis = tx.diagnoseSlug({
    root: market.MARKET_ROOT,
    slug,
    live,
    official: officialStateFor(ctx, manager, slug, market.manifestFor(slug)),
    lock: market.lockStateFor(slug, selfTxid),
    shared: sharedReferenceSummary(ctx, slug),
    dangling: market.danglingBundleLinks().filter((item) => item.slug === slug),
  });
  // Which row this transaction is about: the published manifest says it when it is there, and the
  // journal's own record says it when the published directory has been moved aside — a recovery
  // often runs precisely when there is no published manifest left to ask.
  const journal = tx.readJournal(market.MARKET_ROOT, slug);
  const recorded = journal.ok === true && journal.record !== null && typeof journal.record === 'object' ? journal.record.expected : null;
  const recordedRowId = recorded !== null && typeof recorded === 'object' ? String(recorded.rowId || '') : '';
  const rowId = live.manifestOk === true && live.rowId !== '' ? live.rowId : recordedRowId;
  return {
    live,
    diagnosis,
    profile: profileNameOf(ctx),
    row: rowId === '' ? { present: false, serverName: '', transport: '', command: '', args: [], env: null, headers: null, envKeys: [], values: null } : effectiveRowFor(ctx, rowId),
  };
}

/**
 * The whole row the running configuration carries for one id, as far as it can be compared.
 *
 * `currentRowConfig` deliberately returns only the values a user typed, because that is what a
 * reinstall has to preserve. Deciding whether an install took effect needs more than that: the name
 * the row loads under and the command it runs are part of the claim being checked.
 *
 * @param ctx - the plugin context.
 * @param rowId - the generated row's id.
 * @returns `{present, serverName, command, envKeys}`; `envKeys` is empty, not null, when the row
 *   exists and carries no configured values at all — an empty set is an answer, not a missing one.
 */
function effectiveRowFor(ctx, rowId) {
  const rows = profileMcpRows(ctx);
  if (!Array.isArray(rows) || rowId === '' || !rows.some((candidate) => candidate.id === rowId)) {
    return { present: false, serverName: '', transport: '', command: '', args: [], env: null, headers: null, envKeys: [], values: null };
  }
  const editor = serviceOf(ctx, 'configEditor');
  try {
    for (const item of (editor === undefined || typeof editor.configuration !== 'function' ? [] : editor.configuration()) || []) {
      const entry = item && item.entry;
      if (moduleOfEntry(entry) !== MCP_MODULE) continue;
      if (idOfEntry(entry) !== rowId) continue;
      const effective = { ...((item && item.inherited) || {}), ...((item && item.override) || {}) };
      const isHttp = effective.transport === 'streamable-http';
      const values = isHttp ? effective.headers : effective.env;
      const map = values !== null && typeof values === 'object' && !Array.isArray(values) ? { ...values } : null;
      return {
        present: true,
        serverName: typeof effective.serverName === 'string' ? effective.serverName : '',
        // The launch fields are normalised here, in one place, and never filled in from the manifest:
        // an absent transport or command has to stay absent so the comparison reports that it cannot
        // be made instead of inventing one.
        transport: typeof effective.transport === 'string' ? effective.transport : '',
        command: typeof effective.command === 'string' ? effective.command : '',
        args: Array.isArray(effective.args) ? effective.args.slice() : [],
        env: isHttp ? null : map,
        headers: isHttp ? map : null,
        envKeys: map === null ? [] : Object.keys(map),
        // The values themselves stay inside this process: they are compared against a digest the
        // manifest recorded, never written into a journal or repeated in an answer.
        values: map,
      };
    }
  } catch {
    return { present: false, serverName: '', transport: '', command: '', args: [], env: null, headers: null, envKeys: [], values: null };
  }
  return { present: false, serverName: '', transport: '', command: '', args: [], env: null, headers: null, envKeys: [], values: null };
}

/** The plan, the diagnosis behind it, and what the answer says was or would be changed. */
function repairAnswer(plan, evidence, extra) {
  return {
    dryRun: extra.dryRun === true,
    slug: plan.slug,
    action: plan.action,
    txid: plan.txid,
    state: evidence.diagnosis.state,
    phase: evidence.diagnosis.phase,
    risk: evidence.diagnosis.risk,
    allowed: plan.allowed === true,
    reasons: plan.reasons,
    changes: plan.changes,
    evidence: plan.evidence,
    // A dry run has an outcome it *would* have; saying "discarded" before anything was discarded
    // would be the answer claiming an effect it did not have.
    quarantineLeft: extra.quarantineLeft === true,
    restartEvidence: plan.restartEvidence === undefined ? [] : plan.restartEvidence,
    outcome: extra.dryRun === true
      ? (plan.outcome === 'refused' ? 'refused' : plan.outcome === 'already-completed' ? 'already-completed' : 'planned')
      : (extra.outcome === undefined ? plan.outcome : extra.outcome),
    pendingRestart: extra.pendingRestart === true,
    verified: extra.verified === true,
    live: extra.live === true,
    diagnosis: evidence.diagnosis,
  };
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
  // Detaching is this profile's business: it rewrites this profile's configuration and nothing
  // else, so another profile reading the same bytes is not a reason to refuse it. Whether the bytes
  // themselves may go is a different question, answered by who else loads them — and this round
  // does not delete them at all, so a profile leaving cannot damage a shared bundle.
  //
  // One thing does stop it: a bundle the dsh installation provides is not a profile's to remove.
  const profile = serviceOf(ctx, 'profileContext');
  const anchorPath = profile !== null && profile !== undefined && typeof profile.installAnchor === 'string' ? profile.installAnchor : '';
  const provided = market.installationProvides(manifest.pkg, anchorPath);
  if (provided.status === 'provides') {
    return json({ ok: false, error: { code: 'uninstall-not-removable', message: `${manifest.pkg} is provided by the dsh installation itself, so this profile cannot remove it`, path: provided.path } }, 409);
  }
  if (provided.status === 'unreadable') {
    return json({ ok: false, error: { code: 'uninstall-references-unknown', message: `what the dsh installation provides could not be read from ${provided.path}, so this bundle is not removed`, path: provided.path } }, 409);
  }
  // Which profile is asking has to be known before anything is called: without it a reference can
  // neither be attributed nor checked afterwards, and a detach that cannot be confirmed is not one
  // to perform. References that cannot be read are refused for the same reason — not because
  // someone else is using the bundle, but because this profile's own state would be unverifiable.
  const mine = currentProfileOf(ctx);
  const before = market.bundleReferences(slug, mine);
  if (before.ok !== true || before.ownership !== 'known') {
    const why = before.ok !== true ? before.reason : 'the host did not say which profile this is';
    return json({ ok: false, error: { code: 'uninstall-references-unknown', message: 'this profile\'s references could not be established (' + why + '), so the bundle is left as it is' } }, 409);
  }
  const others = before.references.filter((item) => item.current !== true);
  const declared = before.references.some((item) => item.current === true && item.declared === true);
  // DSH decides what may be removed from it, so ask it rather than infer: `removeBundle` refuses
  // anything whose `removable` is false, and `installed` is how it knows a dependency exists at all.
  let listed = null;
  if (typeof manager.listBundles === 'function') {
    try {
      const all = await manager.listBundles();
      listed = Array.isArray(all) ? all.find((item) => item !== null && typeof item === 'object' && item.name === manifest.pkg) || null : null;
    } catch {
      // A listing that cannot be read says nothing either way; the declaration below still counts.
      listed = null;
    }
  }
  // Nothing left to detach is not a failure. This is the state a half-finished removal leaves:
  // DSH dropped the dependency and then reported the change as failed, so the caller retries — and
  // the retry has to say "already done" rather than "not removable" for the rest of time.
  if (declared !== true && (listed === null || listed.installed !== true)) {
    // Nothing to detach — and the files are still there, so this is also the retry that cleans
    // them up once the profiles that were reading them are gone.
    const cleaned = market.retireBundle(slug, mine);
    const removedNow = cleaned.ok === true && cleaned.retired === true;
    return json({
      ok: true,
      value: {
        slug, pkg: manifest.pkg,
        detached: true, alreadyDetached: true,
        retired: removedNow,
        bundleKept: !removedNow, deleted: removedNow, pruned: cleaned.pruned || [],
        quarantineLeft: cleaned.quarantineLeft === true,
        retireReason: cleaned.ok === true ? '' : cleaned.code,
      retireDetail: cleaned.ok === true ? '' : String(cleaned.reason || ''),
        retireDetail: cleaned.ok === true ? '' : String(cleaned.reason || ''),
        inUse: false,
        others,
      },
    });
  }
  // It is still installed, but the installation does not allow removing it — that is a refusal,
  // and DSH has already told us which one it is.
  if (listed !== null && listed.installed === true && listed.removable !== true) {
    return json({ ok: false, error: { code: 'uninstall-not-removable', message: manifest.pkg + ' is not removable in this installation' } }, 409);
  }
  let removed;
  try {
    removed = await manager.removeBundle(manifest.pkg);
  } catch (error) {
    return failure('uninstall-failed', String((error && error.message) || error), 500);
  }
  // The promise settling is not the news. `change()` folds its own errors into the result, so the
  // answer is what `application` says — the same judgement the install path makes.
  const outcome = market.installOutcome(removed);
  if (outcome.ok !== true) {
    // The manager's own words are the only useful part of this refusal: it knows whether it
    // refused because the bundle is not removable, because pnpm failed, or because a bundle that
    // is currently running cannot be unloaded without a restart. Reporting one word — which said
    // 'install-…' on an uninstall — hid all three, and the real first attempt produced exactly
    // that: a 502 whose message told nobody what to do next.
    const detail = [outcome.errorCode, outcome.diagnostic, outcome.failedAt]
      .filter((part) => typeof part === 'string' && part !== '').join(' — ').slice(0, 400);
    const needsRestart = /restart|started|in-use|loaded/i.test(outcome.errorCode + ' ' + outcome.diagnostic);
    return json({
      ok: false,
      error: {
        code: needsRestart ? 'uninstall-needs-restart' : 'uninstall-not-applied',
        message: (needsRestart
          ? 'this bundle is still running, so the installer could not remove it; restart DSH and try again — '
          : 'the installer did not remove the bundle — ') + (detail === '' ? outcome.application : detail),
        application: outcome.application,
        managerCode: outcome.errorCode,
        diagnostic: outcome.diagnostic.slice(0, 300),
        failedAt: outcome.failedAt,
      },
    }, needsRestart ? 409 : 502);
  }
  // And the claim is checked rather than assumed: the profile has to have stopped declaring it.
  const after = market.bundleReferences(slug, mine);
  // A link left in node_modules is residue, not a dependency: what has to have gone is the
  // profile's own declaration. Counting the link here would refuse a detach that worked.
  const stillMine = after.ok === true ? after.references.filter((item) => item.current === true && item.declared === true) : [];
  if (stillMine.length > 0) {
    return failure('uninstall-not-confirmed', 'the profile still declares this bundle after the installer reported removing it', 500);
  }
  // Detached. Now the files: only the two conditions above make that safe, and both are checked
  // again here rather than assumed from the state we read before the installer ran.
  const cleaned = market.retireBundle(slug, mine);
  const removedNow = cleaned.ok === true && cleaned.retired === true;
  return json({
    ok: true,
    value: {
      slug, pkg: manifest.pkg,
      detached: true,
      retired: removedNow,
      bundleKept: !removedNow, deleted: removedNow, pruned: cleaned.pruned || [],
      quarantineLeft: cleaned.quarantineLeft === true,
      retireReason: cleaned.ok === true ? '' : cleaned.code,
      retireDetail: cleaned.ok === true ? '' : String(cleaned.reason || ''),
      alreadyDetached: false,
      inUse: false,
      // The bundle directory is left where it is: this round detaches and does not retire.
      application: removed !== null && removed !== undefined && typeof removed.application === 'string' ? removed.application : '',
      others,
      referencesUnknown: before.ok !== true,
    },
  });
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
  const manager = serviceOf(ctx, 'pluginManager');
  const items = manifests.map((manifest) => {
    const entry = state.servers.find((server) => server.name === manifest.registryName) || null;
    const live = stateOfRow(ctx, manifest, toolNames);
    // Two different facts share one list: the bundle file exists, and this profile still loads
    // it. After a detach the first stays true on purpose while the second becomes false, and a
    // list that shows only one of them keeps telling a person their uninstall did not work.
    const mine = market.bundleReferences(manifest.slug, currentProfileOf(ctx));
    const inUse = mine.ok !== true || mine.ownership !== 'known'
      ? 'unknown'
      : mine.references.some((item) => item.current === true && item.declared === true);
    // The manifest also carries the values a person typed into the argument slots, and a listing
    // is not a place to read them back out. Everything else is passed through unchanged.
    // A whitelist rather than a spread. A manifest gains fields as the format grows, and a listing
    // is not the place for whatever a future one adds: a digest of a low-entropy value is a guessing
    // oracle, and configured values must never appear here at all. Only what a person is shown is
    // carried over; recovery reads the rest from disk.
    // `args` and `url` are deliberately absent. An argument may be a credential typed into a slot,
    // and a url may carry one in its query — neither can be redacted by pattern, so neither is
    // handed out. What a person needs is the command and the names of the configured keys.
    const carried = ['registryName', 'registryVersion', 'registryTitle', 'installedAt', 'source', 'mcpb', 'slug', 'pkg', 'rowId', 'serverName', 'kind', 'registryType', 'transport', 'command', 'configKeys', 'txid'];
    const rest = {};
    for (const field of carried) if (manifest[field] !== undefined) rest[field] = manifest[field];
    return {
      ...rest,
      state: live.state,
      error: live.error,
      toolCount: live.toolCount,
      toolState: live.toolState,
      inUse,
      latestVersion: entry === null ? null : entry.version,
      // A local entry has no registry counterpart to be newer than, so the comparison is
    // skipped entirely: no update badge, and no 目录版本 vX（不同） line either.
    updateAvailable: manifest.source !== 'local' && entry !== null && entry.version !== '' && entry.version !== manifest.registryVersion,
    };
  });
  return json({
    ok: true,
    value: {
      items,
      count: items.length,
      toolListing: toolNames !== null,
      ...transactionReport(ctx, manager, manifests),
      // A release that failed leaves a lock behind; this is the one place a person can see that
      // without going to the filesystem. Nothing is cleaned up from a read path.
      ...(market.lockDiagnostics().length === 0 ? {} : { lockDiagnostics: market.lockDiagnostics() }),
    },
  });
}

/**
 * Every slug's transaction state, as a diagnosis the caller can act on by hand.
 *
 * Read-only by construction: each input below is a listing, a read or a signal probe, and the
 * classifier itself touches nothing. This used to be the moment residue healed — the read path
 * removed dangling links and wrote a report about it — which made opening the market a write and
 * made the market's own view of a broken state depend on having already fixed it.
 *
 * @param ctx - the plugin context.
 * @param manager - the plugin manager service, or undefined.
 * @param manifests - the installed manifests.
 * @returns \`{transactions, transactionSummary, danglingLinks}\`.
 */
function transactionReport(ctx, manager, manifests) {
  const dangling = market.danglingBundleLinks();
  const bySlug = new Map(manifests.map((manifest) => [manifest.slug, manifest]));
  const slugs = new Set([...bySlug.keys(), ...market.transactionSlugs(), ...dangling.map((item) => item.slug)]);
  const shared = new Map();
  const transactions = [...slugs].sort().map((slug) => {
    if (!shared.has(slug)) shared.set(slug, sharedReferenceSummary(ctx, slug));
    return tx.diagnoseSlug({
      root: market.MARKET_ROOT,
      slug,
      live: tx.readLiveBundle(market.bundleDir(slug)),
      official: officialStateFor(ctx, manager, slug, bySlug.get(slug) || null),
      lock: market.lockStateFor(slug),
      shared: shared.get(slug),
      dangling: dangling.filter((item) => item.slug === slug),
    });
  });
  const count = (risk) => transactions.filter((entry) => entry.risk === risk).length;
  return {
    transactions,
    transactionSummary: {
      total: transactions.length,
      safe: count('safe'),
      manual: count('manual'),
      stop: count('stop'),
    },
    danglingLinks: dangling,
  };
}

/** What the official services say about one slug, or that they could not be read. */
function officialStateFor(ctx, manager, slug, manifest) {
  const rows = profileMcpRows(ctx);
  let bundles = null;
  try {
    if (manager !== undefined && typeof manager.listBundles === 'function') {
      const listed = manager.listBundles();
      if (Array.isArray(listed)) bundles = listed;
    }
  } catch {
    bundles = null;
  }
  if (rows === null || bundles === null) {
    return { readable: false, reason: 'the profile cannot be read from here, so its state is unknown' };
  }
  const pkg = market.BUNDLE_PREFIX + slug;
  const rowId = manifest === null ? '' : String(manifest.rowId || '');
  const bundle = bundles.find((item) => item !== null && typeof item === 'object' && item.name === pkg) || null;
  // rowLive is what the running process has; rowPersisted is what the profile wrote down. A
  // recovery needs the second one to tell "not live yet" apart from "never installed".
  const persistedRows = bundle !== null && Array.isArray(bundle.rows) ? bundle.rows : [];
  return {
    readable: true,
    installed: bundle !== null && bundle.installed === true,
    rowLive: rowId === '' ? null : rows.some((row) => row.id === rowId),
    rowPersisted: rowId === '' ? null : persistedRows.some((row) => row !== null && typeof row === 'object' && row.rowId === rowId),
  };
}

/** Who else reads this bundle, or that the answer could not be established. */
function sharedReferenceSummary(ctx, slug) {
  const links = market.bundleReferences(slug, currentProfileOf(ctx));
  if (links.ok !== true) return { ok: false, reason: 'the other profiles could not be read, so they cannot be ruled out' };
  return {
    ok: true,
    others: links.references.filter((reference) => reference.current !== true).map((reference) => reference.profile),
    current: links.references.filter((reference) => reference.current === true).map((reference) => reference.profile).join(','),
  };
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
  // The two routes that change something take the slug lock the same way, so an install and an
  // uninstall of one entry can never be in flight together.
  register(MARKET_INSTALL_PATH, ['POST'], (request, context) =>
    lockedMarketRoute(request, context, 'install', (body) => (typeof body.name === 'string' ? market.slugFor(body.name) : ''), marketInstallResponse));
  register(MARKET_UNINSTALL_PATH, ['POST'], (request, context) =>
    lockedMarketRoute(request, context, 'uninstall', (body) => (typeof body.slug === 'string' ? body.slug : ''), marketUninstallResponse));
  // Repair takes its own lock, and a dry run must not take one at all.
  register(MARKET_REPAIR_PATH, ['POST'], (request, context) => marketRepairResponse(request, context));
}
