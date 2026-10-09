/**
 * The MCP market: registry snapshot, local search, and the bundles an install writes.
 *
 * Three platform facts shape this file, each verified against the shipped DSH build:
 *
 * 1. The registry is pulled as ONE full snapshot and searched locally. A full pull is
 *    ~200 pages / ~20k entries / ~100 s, so it runs as a background task and lands in a
 *    single JSON cache; searches never touch the network.
 * 2. `@deepseek-ai/dsh-mcp-client` validates its config with a discriminated union:
 *    `transport: 'stdio'` needs `command`/`args`/`env`, `transport: 'streamable-http'`
 *    needs `url`/`headers`, and `serverName` must match `^[A-Za-z0-9_-]{1,32}$` and be
 *    unique across instances.
 * 3. The MCP SDK spawns stdio servers with `shell: false`, so on Windows a `.cmd` shim
 *    (`npx`) can never be the command. npm packages therefore run as
 *    `<node.exe> <npm>/bin/npx-cli.js …`, which needs neither a shell nor PATH.
 *
 * Nothing here imports `@deepseek-ai/*`: a third-party bundle resolves those from its own
 * real path and fails with ERR_MODULE_NOT_FOUND. Node builtins only.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import * as local from './local.js';
import { delimiter, join } from 'node:path';

/** The official registry endpoint that serves the catalog. */
export const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io/v0/servers';
/** Snapshot freshness window; past it the UI offers a refresh and keeps serving the cache. */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Cache format version. The registry schema is still moving, so a cache written by an
 * older app is discarded rather than misread.
 */
export const CACHE_VERSION = 1;
/**
 * A pull that yields fewer entries than this is treated as a failed pull: the registry
 * serves thousands, so a short answer means an outage or a changed API, and overwriting a
 * good snapshot with it would blank the market page.
 */
export const MIN_SNAPSHOT_ENTRIES = 1000;
/**
 * Generated bundles live here. The snapshot deliberately does NOT: this directory is the
 * natural candidate for `hmr.root` (so generated patches hot-apply), and rewriting a
 * multi-megabyte cache inside a watched directory would fire HMR on every refresh.
 */
export const MARKET_ROOT = join(homedir(), '.dsh', 'mcp-servers');
/** The snapshot's own directory, outside anything HMR may watch. */
export const CACHE_DIR = join(homedir(), '.dsh', 'mcp-market');
export const CACHE_PATH = join(CACHE_DIR, 'market-cache.json');
/** Package-name prefix of a generated bundle. */
export const BUNDLE_PREFIX = '@dsh-mcp-market/';

/** The package scope those bundles live under, for the profile's 
ode_modules layout. */
export const BUNDLE_SCOPE = '@dsh-mcp-market';
/** Row-id prefix of a generated row, kept distinct from hand-written rows. */
export const ROW_PREFIX = 'mcp-';
/** The registry's per-version metadata block. */
const OFFICIAL_META = 'io.modelcontextprotocol.registry/official';
const PAGE_LIMIT = 100;
const MAX_PAGES = 400;
const FETCH_TIMEOUT_MS = 30000;
/** Package types this version can turn into a row. */
const RUNNABLE_TYPES = ['npm', 'pypi'];

/** mkdir -p the market root. */
function ensureRoot() {
  mkdirSync(MARKET_ROOT, { recursive: true });
}

/** mkdir -p the snapshot directory. */
function ensureCacheDir() {
  mkdirSync(CACHE_DIR, { recursive: true });
}

/** Write a file atomically so a crash cannot leave a half-written snapshot. */
function writeAtomic(path, text) {
  ensureCacheDir();
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, text, 'utf8');
  renameSync(temporary, path);
}

/** The registry's own metadata block for one entry. */
function metaOf(entry) {
  return (entry && entry._meta && entry._meta[OFFICIAL_META]) || {};
}

/**
 * Normalize one registry entry, or drop it.
 *
 * Dropped: anything not `active`, and every version that is not `isLatest` — the registry
 * carries one entry per published version, so without that filter the catalog shows the
 * same server many times over.
 *
 * @param entry - one element of `servers`.
 * @returns the normalized server, or `null` when the entry is filtered out.
 */
export function normalize(entry) {
  const server = (entry && entry.server) || entry || {};
  const meta = metaOf(entry);
  if (meta.status !== undefined && meta.status !== 'active') return null;
  if (meta.isLatest === false) return null;
  const name = typeof server.name === 'string' ? server.name : '';
  if (name === '') return null;
  const packages = (Array.isArray(server.packages) ? server.packages : [])
    .map((pack) => ({
      registryType: typeof pack.registryType === 'string' ? pack.registryType : '',
      identifier: typeof pack.identifier === 'string' ? pack.identifier : '',
      version: typeof pack.version === 'string' ? pack.version : '',
      transport: (pack.transport && pack.transport.type) || 'stdio',
      /** A private index this package must be fetched from, when the entry names one. */
      registryBaseUrl: typeof pack.registryBaseUrl === 'string' ? pack.registryBaseUrl : '',
      /** The runner the publisher had in mind (`npx`, `uvx`, `docker`), advisory only. */
      runtimeHint: typeof pack.runtimeHint === 'string' ? pack.runtimeHint : '',
      environmentVariables: (Array.isArray(pack.environmentVariables) ? pack.environmentVariables : [])
        .map((variable) => ({
          name: typeof variable.name === 'string' ? variable.name : '',
          description: typeof variable.description === 'string' ? variable.description : '',
          isRequired: variable.isRequired === true,
          isSecret: variable.isSecret === true,
          default: typeof variable.default === 'string' ? variable.default : '',
        }))
        .filter((variable) => variable.name !== ''),
      /** Arguments for the runner itself, e.g. npx's `-y` or `--package`. */
      runtimeArguments: (Array.isArray(pack.runtimeArguments) ? pack.runtimeArguments : [])
        .map((argument) => ({ value: typeof argument.value === 'string' ? argument.value : '' }))
        .filter((argument) => argument.value !== ''),
      /**
       * Arguments for the server. A `named` entry without a value is a flag whose value the
       * user must supply (`--out <dir>`), which becomes a form field rather than being lost.
       */
      packageArguments: (Array.isArray(pack.packageArguments) ? pack.packageArguments : [])
        .map((argument) => ({
          type: typeof argument.type === 'string' ? argument.type : 'positional',
          name: typeof argument.name === 'string' ? argument.name : '',
          value: typeof argument.value === 'string' ? argument.value : '',
          description: typeof argument.description === 'string' ? argument.description : '',
          isRequired: argument.isRequired === true,
          format: typeof argument.format === 'string' ? argument.format : '',
        }))
        .filter((argument) => argument.value !== '' || argument.name !== ''),
    }))
    .filter((pack) => pack.identifier !== '');
  const remotes = (Array.isArray(server.remotes) ? server.remotes : [])
    .map((remote) => ({
      type: typeof remote.type === 'string' ? remote.type : '',
      url: typeof remote.url === 'string' ? remote.url : '',
      headers: (Array.isArray(remote.headers) ? remote.headers : [])
        .map((header) => ({
          name: typeof header.name === 'string' ? header.name : '',
          description: typeof header.description === 'string' ? header.description : '',
          isRequired: header.isRequired === true,
          isSecret: header.isSecret === true,
          default: typeof header.value === 'string' ? header.value : '',
        }))
        .filter((header) => header.name !== ''),
    }))
    .filter((remote) => remote.url !== '');
  return {
    name,
    title: typeof server.title === 'string' && server.title !== '' ? server.title : name,
    description: typeof server.description === 'string' ? server.description : '',
    version: typeof server.version === 'string' ? server.version : '',
    publishedAt: typeof meta.publishedAt === 'string' ? meta.publishedAt : null,
    packages,
    remotes,
  };
}

/** One page of the registry. */
async function fetchPage(cursor, updatedSince) {
  const url = new URL(REGISTRY_BASE);
  url.searchParams.set('limit', String(PAGE_LIMIT));
  if (cursor !== undefined) url.searchParams.set('cursor', cursor);
  // Verified against the live registry: `updated_since` really does filter, and the answer
  // comes back ordered by the update time (asking for today returns entries published
  // today; asking for 2020 returns the earliest). Unknown parameters are simply ignored,
  // which is why this was checked by comparing first entries rather than status codes.
  if (updatedSince !== undefined) url.searchParams.set('updated_since', updatedSince);
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`registry responded ${response.status} ${response.statusText}`);
  return response.json();
}

/**
 * How far before the last successful pull an incremental cursor starts.
 *
 * Entries updated while a pull is in flight can sit behind the page already read, and the
 * registry's clock is not ours. Re-reading ten minutes of changes is cheap; missing one
 * update until the next refresh is not.
 */
const CURSOR_MARGIN_MS = 10 * 60 * 1000;

/** Live refresh bookkeeping, so the UI can show progress instead of hanging. */
const refresh = { running: false, mode: '', startedAt: 0, pages: 0, rawEntries: 0, kept: 0, error: '', finishedAt: 0 };

/** The current refresh state. */
export function refreshState() {
  return { ...refresh };
}

/** The parsed snapshot held in memory, so searches never re-read 3 MB of JSON. */
let snapshot = null;

/**
 * Merge freshly pulled entries into the snapshot on disk.
 *
 * Incremental refresh must never drop an entry: everything already known stays, and the
 * pulled entries replace or add by name.
 *
 * @param servers - the normalized entries just pulled.
 * @returns the number of entries in the merged snapshot.
 */
function mergeIntoCache(servers) {
  const current = catalog();
  const byName = new Map(current.servers.map((server) => [server.name, server]));
  for (const server of servers) byName.set(server.name, server);
  const merged = [...byName.values()].sort((left, right) =>
    String(right.publishedAt || '').localeCompare(String(left.publishedAt || '')));
  const fetchedAt = new Date().toISOString();
  writeAtomic(CACHE_PATH, JSON.stringify({ cacheVersion: CACHE_VERSION, fetchedAt, count: merged.length, servers: merged }));
  snapshot = { fetchedAt, servers: merged };
  return merged.length;
}

/**
 * Pull the registry into the cache.
 *
 * Two modes, because the two questions are different:
 *
 * - `incremental` (the default, what the refresh button does): ask only for what changed
 *   since the last pull and merge. Seconds, not minutes, and the answer to "is there
 *   anything new".
 * - `full`: re-read everything and replace the snapshot. Minutes for a large catalog, and
 *   the answer to "is my snapshot still correct".
 *
 * @param options - `{mode}`; anything but `full` means incremental.
 * @returns the refresh summary.
 */
export async function refreshCatalog(options) {
  if (refresh.running) return refreshState();
  let mode = options !== undefined && options !== null && options.mode === 'full' ? 'full' : 'incremental';
  refresh.running = true;
  refresh.startedAt = Date.now();
  refresh.pages = 0;
  refresh.rawEntries = 0;
  refresh.kept = 0;
  refresh.error = '';
  try {
    const current = catalog();
    let updatedSince;
    if (mode === 'incremental') {
      // Nothing to be incremental against: the first pull has to be a full one.
      if (current.servers.length === 0 || current.fetchedAt === '') mode = 'full';
      else updatedSince = new Date(Math.max(0, Date.parse(current.fetchedAt) - CURSOR_MARGIN_MS)).toISOString();
    }
    refresh.mode = mode;
    const byName = new Map();
    let cursor;
    while (refresh.pages < MAX_PAGES) {
      const body = await fetchPage(cursor, updatedSince);
      const list = Array.isArray(body.servers) ? body.servers : [];
      refresh.pages += 1;
      refresh.rawEntries += list.length;
      for (const entry of list) {
        const server = normalize(entry);
        if (server !== null && !byName.has(server.name)) byName.set(server.name, server);
      }
      refresh.kept = byName.size;
      cursor = body.metadata && body.metadata.nextCursor;
      if (cursor === undefined || cursor === null || cursor === '') break;
    }
    const servers = [...byName.values()];
    if (mode === 'incremental') {
      // An empty answer is a real answer here: nothing changed since the last pull.
      refresh.kept = mergeIntoCache(servers);
      refresh.finishedAt = Date.now();
      return refreshState();
    }
    commitFull(servers);
    return refreshState();
  } catch (error) {
    refresh.error = String((error && error.message) || error);
    refresh.finishedAt = Date.now();
    return refreshState();
  } finally {
    refresh.running = false;
  }
}

/**
 * Replace the snapshot with a complete pull.
 *
 * A short answer means an outage or a changed API, not an empty registry: keep the
 * previous snapshot and say so, instead of overwriting good data with nothing.
 *
 * @param servers - the normalized entries just pulled.
 */
function commitFull(servers) {
  const sorted = [...servers].sort((left, right) =>
    String(right.publishedAt || '').localeCompare(String(left.publishedAt || '')));
  if (sorted.length < MIN_SNAPSHOT_ENTRIES) {
    refresh.error = `the registry returned only ${sorted.length} usable entries (expected at least ${MIN_SNAPSHOT_ENTRIES}); kept the previous snapshot`;
    refresh.finishedAt = Date.now();
    return;
  }
  const fetchedAt = new Date().toISOString();
  writeAtomic(CACHE_PATH, JSON.stringify({ cacheVersion: CACHE_VERSION, fetchedAt, count: sorted.length, servers: sorted }));
  snapshot = { fetchedAt, servers: sorted };
  refresh.kept = sorted.length;
  refresh.finishedAt = Date.now();
}

/**
 * The catalog as the UI needs it: the cache plus its freshness.
 *
 * @returns `{servers, fetchedAt, count, stale, ageMs, source}` where `source` is
 * `cache`, `none`, or `empty`.
 */
export function catalog() {
  if (snapshot === null && existsSync(CACHE_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
      // A cache from an older format is ignored, never half-read.
      if (parsed.cacheVersion === CACHE_VERSION && Array.isArray(parsed.servers)) {
        snapshot = { fetchedAt: parsed.fetchedAt || '', servers: parsed.servers };
      }
    } catch {
      snapshot = null;
    }
  }
  if (snapshot === null) {
    const localOnly = mergeLocal([], null);
    return {
      servers: localOnly.servers,
      fetchedAt: '',
      count: localOnly.servers.length,
      stale: true,
      ageMs: null,
      source: localOnly.servers.length === 0 ? 'none' : 'empty',
      local: localOnly.report,
    };
  }
  const ageMs = snapshot.fetchedAt === '' ? null : Date.now() - Date.parse(snapshot.fetchedAt);
  const merged = mergeLocal(snapshot.servers, snapshot);
  return {
    servers: merged.servers,
    fetchedAt: snapshot.fetchedAt,
    count: merged.servers.length,
    stale: ageMs === null || !Number.isFinite(ageMs) || ageMs > CACHE_TTL_MS,
    ageMs,
    source: merged.servers.length === 0 ? 'empty' : 'cache',
    local: merged.report,
  };
}

/**
 * Merge the local file over the registry snapshot.
 *
 * Same `name` means the local entry wins — that is what an overlay is for — and the
 * surviving entry carries `coversRegistry` with the version it replaces, so the install
 * dialog can name what is being covered. Nothing else about the snapshot changes, and a
 * local file that fails validation contributes nothing but its errors.
 *
 * @param servers - the registry entries.
 * @param snapshotValue - the snapshot they came from, or `null` when there is none.
 * @returns `{servers, report}`.
 */
function mergeLocal(servers, snapshotValue) {
  const read = local.readLocalEntries(local.localEntriesPath(CACHE_DIR));
  const report = {
    present: read.present,
    count: read.entries.length,
    errors: read.errors,
    warnings: read.warnings,
    stamp: read.stamp,
  };
  if (read.entries.length === 0) return { servers, report };

  const byName = new Map(servers.map((server) => [server.name, server]));
  for (const entry of read.entries) {
    const shadowed = byName.get(entry.name);
    byName.set(entry.name, shadowed === undefined
      ? entry
      : { ...entry, coversRegistry: true, coversVersion: shadowed.version || '' });
  }
  return { servers: [...byName.values()], report };
}

/**
 * Drop the in-memory snapshot so the next read comes from disk.
 *
 * The catalog is parsed once per process; tests (and any future "reload from disk" action)
 * need a way to make the file authoritative again.
 */
export function resetCatalog() {
  snapshot = null;
  refresh.running = false;
  refresh.error = '';
}

/** Score one server against a lower-cased query; `0` means no match. */
function score(server, needle) {
  if (needle === '') return 1;
  const name = server.name.toLowerCase();
  const title = server.title.toLowerCase();
  const description = server.description.toLowerCase();
  if (name === needle || title === needle) return 100;
  if (name.startsWith(needle)) return 80;
  if (title.startsWith(needle)) return 70;
  if (name.includes(needle)) return 60;
  if (title.includes(needle)) return 50;
  if (description.includes(needle)) return 30;
  const tokens = needle.split(/\s+/).filter((token) => token !== '');
  if (tokens.length > 1 && tokens.every((token) => name.includes(token) || title.includes(token) || description.includes(token))) return 20;
  return 0;
}

/**
 * Search the cached snapshot locally.
 *
 * @param query - free text; empty lists everything.
 * @param options - `{kind, sort, limit, offset, decorate}`; `kind` is `all`, `local`,
 * `remote`, or `unsupported`. `decorate(server)` may add fields to each result — the route
 * uses it to attach the card state, so a card never needs a second request.
 * @returns `{total, offset, limit, results}`.
 */
export function searchCatalog(query, options = {}) {
  const { servers } = catalog();
  const needle = String(query || '').trim().toLowerCase();
  const kind = options.kind || 'all';
  // source is a different axis from kind: kind is the install form (a local process or a
  // remote endpoint), source is where the entry came from (the registry or the local file).
  const source = options.source === 'local' ? 'local' : 'all';
  const sort = options.sort || 'relevance';
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.min(Math.floor(options.limit), 200) : 30;
  const offset = Number.isFinite(options.offset) && options.offset > 0 ? Math.floor(options.offset) : 0;
  const decorate = typeof options.decorate === 'function' ? options.decorate : null;

  const scored = [];
  for (const server of servers) {
    if (source === 'local' && server.source !== 'local') continue;
    const shape = shapeOf(server);
    if (kind === 'local' && !shape.hasLocal) continue;
    if (kind === 'remote' && !shape.hasRemote) continue;
    if (kind === 'unsupported' && shape.hasLocal) continue;
    const value = score(server, needle);
    if (value === 0) continue;
    scored.push({ server, value });
  }
  if (sort === 'newest') scored.sort((left, right) => String(right.server.publishedAt || '').localeCompare(String(left.server.publishedAt || '')));
  else if (sort === 'name') scored.sort((left, right) => left.server.name.localeCompare(right.server.name));
  else scored.sort((left, right) => {
    // In the default order the user's own entries come first — the catalog is for browsing,
    // but what you wrote yourself should not be on page 231. The other sorts leave them to
    // compete on their own attributes, which is what 最新上架 and 名称 mean.
    const own = (server) => (server.source === 'local' ? 0 : 1);
    return own(left.server) - own(right.server)
      || right.value - left.value
      || left.server.name.localeCompare(right.server.name);
  });

  const page = scored.slice(offset, offset + limit).map((item) => {
    const summary = summarize(item.server);
    return decorate === null ? summary : { ...summary, ...decorate(item.server, summary) };
  });
  return { total: scored.length, offset, limit, results: page };
}

/**
 * The card state machine's inputs for one server.
 *
 * Computed on the host so the card flow needs no per-card request: whether this machine
 * can install it at all (and why not), whether it needs secrets before it can run, and
 * whether it is already installed (plus whether the registry has moved on).
 *
 * @param server - a normalized server.
 * @param runtimes - the result of {@link detectRuntimes}.
 * @param installed - installed manifests keyed by registry name.
 * @returns `{installable, unsupportedReason, planKind, registryType, needsConfig, installedSlug, installedVersion, updateAvailable}`.
 */
export function cardStateFor(server, runtimes, installed = new Map()) {
  const { options, blocked } = plansFor(server, runtimes);
  const plan = options[0];
  const manifest = installed.get(server.name) || null;
  // A variable only needs the form when there is no value to use: a declared `value` in the
  // local file — or a registry default — is already the answer, secret or not. Without this
  // an entry whose secrets are all filled in still claimed 需密钥 and still showed a form.
  const needsConfig = plan === undefined
    ? false
    : (plan.variables || []).some((variable) => variable.default === '' && (variable.isRequired || variable.isSecret))
      || (plan.slots || []).some((slot) => slot.isRequired);
  return {
    installable: plan !== undefined,
    unsupportedReason: plan === undefined ? ((blocked[0] && blocked[0].reason) || '没有可用的安装方式') : '',
    planKind: plan === undefined ? '' : plan.kind,
    registryType: plan === undefined ? '' : plan.registryType,
    needsConfig,
    installedSlug: manifest === null ? '' : manifest.slug,
    installedVersion: manifest === null ? '' : manifest.registryVersion,
    // A local entry has no registry version to compare against, so it never claims an
    // update is available — the version badge and the 更新 state both stay off.
    updateAvailable: server.source === 'local'
      ? false
      : manifest !== null && server.version !== '' && server.version !== manifest.registryVersion,
    source: server.source === 'local' ? 'local' : 'registry',
    coversRegistry: server.coversRegistry === true,
    coversVersion: server.coversVersion || '',
    warning: server.warning === true,
    warningReasons: server.warningReasons || [],
  };
}

/** What one server offers, in the terms the UI filters by. */
function shapeOf(server) {
  const types = new Set(server.packages.map((pack) => pack.registryType));
  return {
    types: [...types],
    hasLocal: server.packages.some((pack) => RUNNABLE_TYPES.includes(pack.registryType)),
    hasRemote: server.remotes.length > 0,
  };
}

/** The list-row projection of a server. */
function summarize(server) {
  const shape = shapeOf(server);
  return {
    name: server.name,
    title: server.title,
    description: server.description,
    version: server.version,
    publishedAt: server.publishedAt,
    types: shape.types,
    hasLocal: shape.hasLocal,
    hasRemote: shape.hasRemote,
    kinds: server.remotes.map((remote) => remote.type).filter((type, index, all) => all.indexOf(type) === index),
    source: server.source === 'local' ? 'local' : 'registry',
  };
}

/** One entry of the catalog by exact registry name. */
export function findServer(name) {
  const { servers } = catalog();
  return servers.find((server) => server.name === name) || null;
}

/** Look up a program on PATH plus a few well-known install locations. */
function locate(names, directories) {
  const pathEntries = String(process.env.PATH || '').split(delimiter).filter((entry) => entry !== '');
  const roots = [...pathEntries, ...directories];
  for (const root of roots) {
    for (const name of names) {
      const candidate = join(root, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return '';
}

/** Every location a program occupies, PATH first and without duplicates. */
function locateAll(names, directories) {
  const pathEntries = String(process.env.PATH || '').split(delimiter).filter((entry) => entry !== '');
  const found = [];
  for (const root of [...pathEntries, ...directories]) {
    for (const name of names) {
      const candidate = join(root, name);
      if (existsSync(candidate) && !found.includes(candidate)) found.push(candidate);
    }
  }
  return found;
}

/** npm's own npx CLI beside one Node install — a Node without it cannot run npx packages. */
function npxCliBeside(nodePath) {
  if (nodePath === '') return '';
  const sibling = join(nodePath, '..', 'node_modules', 'npm', 'bin', 'npx-cli.js');
  return existsSync(sibling) ? sibling : '';
}

/**
 * Whether a candidate is the Electron shell rather than Node.
 *
 * Inside DSH `process.execPath` is `electron.exe`; spawning it without
 * `ELECTRON_RUN_AS_NODE=1` opens a window instead of running the script, so it is never a
 * valid `command` for an MCP row. It is also not a Node install, so it is skipped here
 * rather than "fixed" with an environment variable.
 */
function looksLikeElectron(candidate) {
  const base = String(candidate).split(/[\\/]/).pop() || '';
  return /electron/i.test(base);
}

/**
 * Detect the runtimes an install can use.
 *
 * Windows matters most here: `npx` is a `.cmd` shim that the MCP SDK cannot spawn, so the
 * usable form is the Node executable plus npm's own `npx-cli.js`. DSH's bundled runtime
 * ships `node.exe` alone (no npm), so the system Node install is the real candidate.
 *
 * @returns `{platform, node, npx, uvx, docker}` with absolute paths where found.
 */
export function detectRuntimes() {
  const platform = process.platform;
  const home = homedir();
  const nodeDirs = platform === 'win32'
    ? ['C:\\Program Files\\nodejs', 'C:\\Program Files (x86)\\nodejs', join(process.env.APPDATA || home, 'npm'), join(process.env.LOCALAPPDATA || home, 'Programs', 'nodejs')]
    : ['/usr/local/bin', '/usr/bin', '/opt/homebrew/bin', join(home, '.local', 'bin'), join(home, '.nvm', 'current', 'bin')];
  const pythonDirs = platform === 'win32'
    ? [join(home, '.local', 'bin'), join(process.env.LOCALAPPDATA || home, 'Programs', 'Python', 'Scripts'), join(process.env.USERPROFILE || home, '.cargo', 'bin')]
    : ['/usr/local/bin', '/usr/bin', join(home, '.local', 'bin'), join(home, '.cargo', 'bin')];

  const nodeNames = platform === 'win32' ? ['node.exe', 'node'] : ['node'];
  const candidates = locateAll(nodeNames, nodeDirs).filter((candidate) => !looksLikeElectron(candidate));
  // Pick the first Node that actually ships npm's npx CLI: DSH's bundled runtime has
  // `node.exe` alone, and a row built on that Node would fail the moment npx is needed.
  let nodePath = '';
  let npxCliPath = '';
  for (const candidate of candidates) {
    const cli = npxCliBeside(candidate);
    if (cli === '') continue;
    nodePath = candidate;
    npxCliPath = cli;
    break;
  }
  const nodeWithoutNpm = nodePath === '' && candidates.length > 0 ? candidates[0] : '';
  const npxShim = locate(platform === 'win32' ? ['npx.cmd', 'npx'] : ['npx'], nodeDirs);
  if (npxCliPath === '') npxCliPath = npxCliBeside(npxShim);
  const uvxPath = locate(platform === 'win32' ? ['uvx.exe', 'uvx'] : ['uvx'], pythonDirs);
  const dockerPath = locate(platform === 'win32' ? ['docker.exe', 'docker'] : ['docker'], nodeDirs);

  // A `.cmd` shim can never be the command: the MCP SDK spawns with `shell: false`.
  const npxUsable = nodePath !== '' && npxCliPath !== '';
  return {
    platform,
    node: { path: nodePath, available: nodePath !== '', withoutNpm: nodeWithoutNpm },
    npx: {
      available: npxUsable,
      shim: npxShim,
      cli: npxCliPath,
      // The exact executable plus leading args a stdio row must use.
      command: npxUsable ? nodePath : '',
      prefix: npxUsable ? [npxCliPath] : [],
      direct: npxUsable,
    },
    uvx: { available: uvxPath !== '', path: uvxPath },
    docker: { available: dockerPath !== '', path: dockerPath },
  };
}

/**
 * The environment a generated stdio row should carry.
 *
 * The MCP client hands stdio children a scrubbed copy of the parent environment that
 * *keeps* `PATH`, so the runner is already reachable in the common case. Only when the
 * Node this machine picked lives outside that inherited `PATH` is its directory added —
 * and then only that one directory, never a copy of the whole parent `PATH`, which would
 * bake one machine's layout into the profile.
 */
function baseEnv(runtimes) {
  const env = {};
  const nodeDir = runtimes.node.available ? join(runtimes.node.path, '..') : '';
  const path = String(process.env.PATH || '').toLowerCase();
  if (nodeDir !== '' && !path.includes(nodeDir.toLowerCase())) env.PATH = nodeDir;
  return env;
}

/**
 * The argv of one package, as literals plus the slots a user has to fill.
 *
 * The registry publishes two argument layers and both matter: `runtimeArguments` belong to
 * the runner (`npx -y`, `npx --package`), `packageArguments` belong to the server. A *named*
 * package argument with no value is a slot — dropping it would start a server that needs
 * `--out <dir>` with the flag missing, and a missing `-y` would leave npx waiting on a
 * prompt with no TTY attached.
 *
 * @param pack - one normalized package.
 * @param runtime - `npm` or `pypi`.
 * @param prefix - leading argv entries that launch the runner (`node.exe`, `npx-cli.js`).
 * @returns `{argv, slots}` where `argv` entries are `{kind:'literal',value}` or
 * `{kind:'slot',name,...}`.
 */
function argvFor(pack, runtime, prefix) {
  const argv = prefix.map((value) => ({ kind: 'literal', value }));
  // Defensive reads: a hand-edited or older cache may predate these fields entirely.
  const runtimeArguments = (pack.runtimeArguments || []).map((argument) => argument.value);
  for (const value of runtimeArguments) argv.push({ kind: 'literal', value });
  if (runtime === 'npm' && !runtimeArguments.some((value) => value === '-y' || value === '--yes')) {
    argv.push({ kind: 'literal', value: '-y' });
  }
  if ((pack.registryBaseUrl || '') !== '') {
    // npm and uv spell a custom index differently; both must precede the package.
    argv.push({ kind: 'literal', value: runtime === 'npm' ? `--registry=${pack.registryBaseUrl}` : '--index-url' });
    if (runtime !== 'npm') argv.push({ kind: 'literal', value: pack.registryBaseUrl });
  }
  argv.push({ kind: 'literal', value: pack.identifier });
  for (const argument of pack.packageArguments || []) {
    if (argument.type === 'named') {
      if (argument.name === '') continue;
      if (argument.value !== '') {
        argv.push({ kind: 'literal', value: argument.name });
        argv.push({ kind: 'literal', value: argument.value });
      } else {
        argv.push({
          kind: 'slot',
          name: argument.name,
          description: argument.description,
          isRequired: argument.isRequired,
          format: argument.format,
        });
      }
      continue;
    }
    if (argument.value !== '') argv.push({ kind: 'literal', value: argument.value });
  }
  return argv;
}

/**
 * Every way this server can be installed on this machine, best first.
 *
 * @param server - a normalized server.
 * @param runtimes - the result of {@link detectRuntimes}.
 * @returns `{options, blocked}`: installable plans plus why the rest were skipped.
 */
/**
 * The single install plan of a local entry.
 *
 * The command line is taken verbatim from the file: this is the one place where the market
 * turns a hand-written string into a row, which is why `local.js` refuses a relative or bare
 * `command` and flags inline scripts before anything gets here.
 *
 * @param server - a normalized local entry.
 * @returns `{options, blocked}` in the shape {@link plansFor} returns.
 */
function localPlans(server) {
  const entry = server.local;
  const warning = server.warning === true ? server.warningReasons.join('；') : '';
  // A variable with a `value` in the file is already answered, so it goes straight into the
  // row; the install form only asks for the ones left empty.
  const fixed = {};
  for (const variable of entry.env || []) if (variable.default !== '') fixed[variable.name] = variable.default;
  const fixedHeaders = {};
  for (const header of entry.headers || []) if (header.default !== '') fixedHeaders[header.name] = header.default;

  if (entry.kind === 'http') {
    return {
      options: [{
        kind: 'http',
        registryType: 'local',
        label: `远程连接（自建）· ${entry.url}`,
        transport: 'streamable-http',
        url: entry.url,
        argv: [],
        slots: [],
        headers: fixedHeaders,
        variables: entry.headers || [],
        risk: '自建条目：请求发往该地址；密钥会作为请求头发送',
        warning,
      }],
      blocked: [],
    };
  }
  return {
    options: [{
      kind: 'stdio',
      registryType: 'local',
      label: `本地进程（自建）· ${entry.command}`,
      transport: 'stdio',
      command: entry.command,
      argv: (entry.args || []).map((value) => ({ kind: 'literal', value })),
      slots: [],
      env: fixed,
      variables: entry.env || [],
      risk: '自建条目：在你本机执行这条命令',
      warning,
    }],
    blocked: [],
  };
}

export function plansFor(server, runtimes) {
  const options = [];
  const blocked = [];
  // A local entry carries its own command line, so it skips the package-to-command mapping
  // entirely: there is no registry package to interpret, only what the file says.
  if (server.source === 'local' && server.local !== undefined) return localPlans(server);
  // An entry can declare nothing at all — no package and no remote. That is upstream data,
  // not a machine limitation, and it must still say so instead of failing silently.
  if (server.packages.length === 0 && server.remotes.length === 0) {
    return {
      options,
      blocked: [{ registryType: '', identifier: '', reason: '该注册表条目没有声明任何安装方式（既无 package 也无 remote）' }],
    };
  }
  for (const pack of server.packages) {
    if (pack.registryType === 'npm') {
      if (!runtimes.npx.available) {
        const found = runtimes.node.withoutNpm === '' ? '没有找到 Node.js' : `只找到 ${runtimes.node.withoutNpm}（不带 npm）`;
        blocked.push({ registryType: 'npm', identifier: pack.identifier, reason: `需要带 npm 的 Node.js：${found}` });
        continue;
      }
      const argv = argvFor(pack, 'npm', [...runtimes.npx.prefix]);
      options.push({
        kind: 'stdio',
        registryType: 'npm',
        label: `本地进程 · npx ${pack.identifier}`,
        transport: 'stdio',
        command: runtimes.npx.command,
        argv,
        slots: argv.filter((entry) => entry.kind === 'slot'),
        env: baseEnv(runtimes),
        variables: pack.environmentVariables || [],
        runtimeHint: pack.runtimeHint,
        risk: '在你本机执行第三方命令',
      });
      continue;
    }
    if (pack.registryType === 'pypi') {
      if (!runtimes.uvx.available) {
        blocked.push({ registryType: 'pypi', identifier: pack.identifier, reason: '需要 uv（uvx）；未安装' });
        continue;
      }
      const argv = argvFor(pack, 'pypi', []);
      options.push({
        kind: 'stdio',
        registryType: 'pypi',
        label: `本地进程 · uvx ${pack.identifier}`,
        transport: 'stdio',
        command: runtimes.uvx.path,
        argv,
        slots: argv.filter((entry) => entry.kind === 'slot'),
        env: baseEnv(runtimes),
        variables: pack.environmentVariables || [],
        runtimeHint: pack.runtimeHint,
        risk: '在你本机执行第三方命令',
      });
      continue;
    }
    blocked.push({
      registryType: pack.registryType,
      identifier: pack.identifier,
      reason: pack.registryType === 'oci' ? '容器方式（oci）二期支持' : `暂不支持 ${pack.registryType} 包`,
    });
  }
  for (const remote of server.remotes) {
    if (remote.type !== 'streamable-http') {
      // Never mint a row for an endpoint this build cannot speak to: it would install
      // cleanly and then fail on every connection.
      blocked.push({ registryType: 'remote', identifier: remote.url, reason: `暂不支持 ${remote.type} 远程传输（二期）` });
      continue;
    }
    options.push({
      kind: 'http',
      registryType: 'remote',
      label: `远程连接 · ${remote.url}`,
      transport: 'streamable-http',
      url: remote.url,
      argv: [],
      slots: [],
      headers: {},
      variables: remote.headers || [],
      risk: '请求发往第三方服务器；密钥会作为请求头发送',
    });
  }
  // A local process is the more capable install, so it leads when both exist.
  options.sort((left, right) => (left.kind === right.kind ? 0 : left.kind === 'stdio' ? -1 : 1));
  return { options, blocked };
}

/**
 * Render one plan's argv, filling slots from user input.
 *
 * @param plan - a plan from {@link plansFor}.
 * @param values - slot name to value.
 * @returns `{args, missing}`: the argv strings, and the required slots left empty.
 */
export function resolveArgv(plan, values = {}) {
  const args = [];
  const missing = [];
  for (const entry of plan.argv || []) {
    if (entry.kind === 'literal') {
      args.push(entry.value);
      continue;
    }
    const value = values[entry.name];
    if (typeof value !== 'string' || value === '') {
      if (entry.isRequired) missing.push(entry.name);
      continue;
    }
    args.push(entry.name, value);
  }
  return { args, missing };
}

/** A filesystem- and package-name-safe slug that stays unique per registry name. */
export function slugFor(name) {
  const cleaned = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'server';
  const digest = createHash('sha1').update(name).digest('hex').slice(0, 6);
  return `${cleaned}-${digest}`;
}

/** A readable `serverName` derived from the registry name. */
export function serverNameFor(name, taken = []) {
  const parts = String(name).split('/').filter((part) => part !== '');
  let base = parts.length > 0 ? parts[parts.length - 1] : 'mcp';
  if (parts.length > 1 && /^(mcp|server|sse|http|mcp-server)$/i.test(base)) base = parts[parts.length - 2];
  base = base.replace(/^@/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  if (base === '') base = 'mcp';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base.slice(0, 28)}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base.slice(0, 26)}-${createHash('sha1').update(name).digest('hex').slice(0, 4)}`;
}

/** A YAML double-quoted scalar; JSON string escaping is valid YAML. */
function yamlString(value) {
  return JSON.stringify(String(value));
}

/** Render the generated bundle's patch: one `dsh-mcp-client` row. */
export function renderPatch({ rowId, serverName, plan, args, config, source }) {
  const lines = [
    source === 'local'
      ? '# Generated by dsh-plugin-mcp-manager from a local entry in local-entries.json.'
      : '# Generated by dsh-plugin-mcp-manager from the official MCP registry.',
    '# Edit the row through the plugin UI; a manual edit here is overwritten on reinstall.',
    '- insert:',
    `    - id: ${rowId}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    `        serverName: ${yamlString(serverName)}`,
    `        transport: ${yamlString(plan.transport)}`,
  ];
  if (plan.transport === 'stdio') {
    lines.push(`        command: ${yamlString(plan.command)}`);
    lines.push('        args:');
    for (const argument of args || []) lines.push(`          - ${yamlString(argument)}`);
    if ((args || []).length === 0) lines.push('          []');
    const env = { ...plan.env, ...config };
    const keys = Object.keys(env);
    lines.push('        env:');
    if (keys.length === 0) lines.push('          {}');
    for (const key of keys) lines.push(`          ${key}: ${yamlString(env[key])}`);
  } else {
    lines.push(`        url: ${yamlString(plan.url)}`);
    const headers = { ...plan.headers, ...config };
    const keys = Object.keys(headers);
    lines.push('        headers:');
    if (keys.length === 0) lines.push('          {}');
    for (const key of keys) lines.push(`          ${key}: ${yamlString(headers[key])}`);
  }
  lines.push('        toolCallTimeoutMs: 60000');
  lines.push('        failOnStartupError: false');
  lines.push('        reconnect:');
  lines.push('          enabled: true');
  lines.push('          initialDelayMs: 500');
  lines.push('          maxDelayMs: 30000');
  lines.push('          maxAttempts: 10');
  return `${lines.join('\n')}\n`;
}

/** Render the generated bundle's manifest. */
export function renderPackageJson(slug, version, description) {
  return `${JSON.stringify({
    name: `${BUNDLE_PREFIX}${slug}`,
    version: /^\d+\.\d+\.\d+/.test(version) ? version : '0.0.0',
    private: true,
    description: description.slice(0, 200),
    license: 'MIT',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2)}\n`;
}

/**
 * Remove the package-manager links a removed bundle leaves behind.
 *
 * `pluginManager.removeBundle` drops the dependency and the bundle directory, but the
 * junction pnpm created under the profile's `node_modules` stays and points at nothing.
 * Only links whose target is already gone are touched, so a bundle still installed in some
 * other profile keeps its link.
 *
 * @param slug - the bundle slug that was removed.
 * @returns the paths that were pruned.
 */
export function pruneBundleLinks(slug) {
  const removed = [];
  const profiles = join(homedir(), '.dsh', 'profiles');
  let names = [];
  try {
    names = readdirSync(profiles);
  } catch {
    return removed;
  }
  for (const name of names) {
    const link = join(profiles, name, 'node_modules', BUNDLE_SCOPE, slug);
    let info;
    try {
      info = lstatSync(link);
    } catch {
      continue;
    }
    if (!info.isSymbolicLink()) continue;
    // Two independent reasons to call it residue, because the filesystem's view of a link
    // whose target was deleted a millisecond ago is not something to bet on: the target is
    // gone, or the bundle is no longer installed at all.
    if (existsSync(link) && manifestFor(slug) !== null) continue;
    try {
      rmSync(link, { recursive: true, force: true });
      removed.push(link);
    } catch {
      /* the next uninstall tries again */
    }
  }
  return removed;
}
/** The directory of one generated bundle. */
export function bundleDir(slug) {
  return join(MARKET_ROOT, slug);
}

/** Every installed market bundle, newest first. */
export function listInstalled() {
  ensureRoot();
  const entries = [];
  let names = [];
  try {
    names = readdirSync(MARKET_ROOT, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name);
  } catch {
    return entries;
  }
  for (const slug of names) {
    const file = join(MARKET_ROOT, slug, 'market.meta.json');
    if (!existsSync(file)) continue;
    try {
      const meta = JSON.parse(readFileSync(file, 'utf8'));
      entries.push({ ...meta, slug, dir: bundleDir(slug) });
    } catch {
      entries.push({ slug, dir: bundleDir(slug), broken: true });
    }
  }
  return entries.sort((left, right) => String(right.installedAt || '').localeCompare(String(left.installedAt || '')));
}

/** One installed manifest by slug. */
export function manifestFor(slug) {
  return listInstalled().find((entry) => entry.slug === slug) || null;
}

/**
 * Write (or rewrite) one generated bundle.
 *
 * @param options - `{slug, server, serverName, plan, args, config, argumentKeys}`.
 * @returns `{slug, dir, pkg, rowId}`.
 */
export function writeBundle({ slug, server, serverName, plan, args, config, argumentValues }) {
  const dir = bundleDir(slug);
  ensureRoot();
  mkdirSync(dir, { recursive: true });
  const pkg = `${BUNDLE_PREFIX}${slug}`;
  const rowId = `${ROW_PREFIX}${slug}`;
  const origin = server.source === 'local' ? 'a local entry' : 'the official MCP registry';
  writeFileSync(join(dir, 'package.json'), renderPackageJson(slug, server.version, `${server.title} — installed from ${origin}`), 'utf8');
  writeFileSync(join(dir, 'cordis.patch.yml'), renderPatch({ rowId, serverName, plan, args, config, source: server.source }), 'utf8');
  const envKeys = Object.keys(config);
  writeFileSync(join(dir, 'market.meta.json'), `${JSON.stringify({
    registryName: server.name,
    registryVersion: server.version,
    registryTitle: server.title,
    installedAt: new Date().toISOString(),
    source: server.source === 'local' ? 'local' : 'registry',
    slug,
    pkg,
    rowId,
    serverName,
    kind: plan.kind,
    registryType: plan.registryType,
    transport: plan.transport,
    command: plan.kind === 'stdio' ? plan.command : null,
    args: plan.kind === 'stdio' ? args || [] : null,
    argumentValues: argumentValues || {},
    url: plan.kind === 'http' ? plan.url : null,
    configKeys: envKeys,
  }, null, 2)}\n`, 'utf8');
  return { slug, dir, pkg, rowId };
}

/** Delete one generated bundle directory. */
export function removeBundleDir(slug) {
  const dir = bundleDir(slug);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** The snapshot path, exposed for diagnostics. */
export function cachePath() {
  return CACHE_PATH;
}
