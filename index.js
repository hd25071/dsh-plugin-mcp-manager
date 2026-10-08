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
      fetch: async (request) => {
        const response = await handler(request, ctx);
        if (request.method === 'GET') return response;
        await response.body?.cancel();
        return new Response(null, { status: response.status, headers: response.headers });
      },
    });
  };

  register(SERVERS_PATH, ['GET', 'HEAD'], async (_request, context) => serversResponse(context));
  register(HEALTH_PATH, ['GET', 'HEAD'], async (_request, context) => healthResponse(context));
  register(CONFIG_PATH, ['POST'], async (request, context) => configResponse(request, context));
  register(ENABLED_PATH, ['POST'], async (request, context) => enabledResponse(request, context));
}
