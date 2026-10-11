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
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import * as local from './local.js';
import * as mcpb from './mcpb.js';
import * as tx from './tx.js';
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
/** The `serverName` shape `dsh-mcp-client` accepts; a name outside it never loads. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/** A portable environment-variable name: letters, digits and underscores, not starting with a digit. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** RFC 9110 field-name is a token, so `-`, `.` and `!#$%&'*+^_`|~` are legal and must not be refused. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Longest key either block may carry; well past anything a real server declares. */
const MAX_KEY_LENGTH = 128;
/** A key safe to write bare in YAML: letters, digits, `_`, `-` and `.`, not starting with a digit or dash. */
const PLAIN_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
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
 * The project's home, when the entry names one.
 *
 * The raw entry carries `repository: {url, source}` — 35 of 100 sampled entries on 2026-10-10
 * had one. It matters because a repository URL is the only identity that survives a change of
 * source: a display name and a package identifier mean different things in the official
 * registry, in a community list and in a hosted directory, while a repo URL means the same
 * thing in all three. This is what cross-source dedup will key on, so it is kept now even
 * though nothing reads it yet.
 *
 * @param server - the entry's `server` block, or a whole entry already in this shape.
 * @returns the URL, or `null` when the entry names none.
 */
function repositoryOf(server) {
  const raw = server.repository;
  if (typeof raw === 'string') return raw === '' ? null : raw;
  if (raw !== null && typeof raw === 'object' && typeof raw.url === 'string' && raw.url !== '') return raw.url;
  return null;
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
    repository: repositoryOf(server),
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
    if (pack.registryType === 'mcpb') {
      // Nothing about the command line is knowable here: it lives in the package's manifest,
      // which only exists after the download. The plan therefore marks itself as needing one,
      // and the install route finishes the job.
      const probe = mcpb.probeMcpb(pack);
      if (!probe.ok) {
        blocked.push({ registryType: 'mcpb', identifier: pack.identifier, reason: probe.reason });
        continue;
      }
      options.push({
        kind: 'stdio',
        registryType: 'mcpb',
        label: `mcpb 包 · 安装时下载解压`,
        transport: 'stdio',
        needsDownload: true,
        identifier: probe.identifier,
        packageVersion: probe.version,
        command: '',
        argv: [],
        slots: [],
        env: {},
        variables: [],
        risk: '将下载并解压外部包到本地执行',
      });
      continue;
    }
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

/**
 * The one slug lock every market mutation takes.
 *
 * Two facts make this necessary, and neither is covered by DSH's own `withFileLock`:
 *
 * 1. `MARKET_ROOT` is keyed by HOME, not by profile, so every profile under this HOME links to the
 *    SAME physical bundle directory. A second profile's content is decided by this directory.
 * 2. DSH locks `<profile>/package.json` around its own profile change. Everything this plugin
 *    writes — the bundle files, the mcpb payload — is outside that lock, and so is a second request
 *    arriving in the same process.
 *
 * So the lock is taken here for install, update, uninstall and repair alike. It is deliberately
 * timid about other people's files: a lock it cannot read is refused rather than removed, a holder
 * it cannot identify is never taken over, and only a lock whose `txid` matches this transaction's
 * is ever unlinked.
 */

/** The shape `slugFor` produces, and the only shape a bundle or lock path may be built from. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** Bumped when the lock record's shape changes. */
const LOCK_SCHEMA = 1;
/** Slugs this process is operating on right now, so two requests cannot race before either locks. */
const inFlightSlugs = new Map();
/** The last few lock problems, so a release that failed cannot pass unnoticed. */
const lockProblems = [];
const LOCK_PROBLEM_LIMIT = 20;

/** The lock file one slug uses, for readers that want to report its path. */
export function lockPathFor(slug) {
  return join(MARKET_ROOT, '.locks', `${slug}.lock`);
}

/** What went wrong releasing locks, newest last. Read-only; nothing here is a transaction log. */
export function lockDiagnostics() {
  return lockProblems.slice();
}

function noteLockProblem(entry) {
  lockProblems.push(entry);
  if (lockProblems.length > LOCK_PROBLEM_LIMIT) lockProblems.splice(0, lockProblems.length - LOCK_PROBLEM_LIMIT);
}

/** Whether a pid is still running. Only ever used to describe a holder, never to decide a lock's fate. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and is not ours to signal, which is still alive.
    return error.code === 'EPERM';
  }
}

function messageOf(error) {
  return String((error && error.message) || error);
}

/**
 * Read one lock file, and say whether it is a lock at all.
 *
 * An unreadable or incomplete lock answers `ok: false`: its holder cannot be identified, and a file
 * whose owner is unknown is never removed and never written over.
 */
function describeLock(path) {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      return { ok: false, reason: `${path} is a link, so whatever it points at is not trusted as a lock` };
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: false, reason: `${path} disappeared while it was being read` };
    return { ok: false, reason: `${path} could not be inspected (${error.code})` };
  }
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { ok: false, reason: `${path} could not be read (${error.code}), so its holder is unknown` };
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return { ok: false, reason: `${path} does not hold readable JSON, so its holder is unknown` };
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)
    || typeof record.pid !== 'number' || typeof record.txid !== 'string' || record.txid === '') {
    return { ok: false, reason: `${path} is not a complete lock record, so its holder is unknown` };
  }
  return { ok: true, record, alive: pidAlive(record.pid) };
}

/**
 * Take the slug's file lock, exclusively.
 *
 * @param options - `{slug, op, profile, txid}`.
 * @returns `{ok: true, path, txid, record}`, or `{ok: false, code, reason, path, holder?, holderAlive?}`.
 */
export function acquireSlugLock({ slug, op, profile = '', txid = '' }) {
  const name = String(slug === undefined || slug === null ? '' : slug);
  if (!SLUG_PATTERN.test(name)) {
    return { ok: false, code: 'install-locked', path: '', reason: `"${name.slice(0, 40)}" is not a slug, so no lock path may be built from it` };
  }
  const dir = join(MARKET_ROOT, '.locks');
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    return { ok: false, code: 'install-locked', path: dir, reason: `the lock directory could not be created: ${messageOf(error)}` };
  }
  // A junction or symlink where the lock directory belongs would send every lock file somewhere
  // else, so the directory has to be a plain directory before anything is created inside it.
  try {
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      return { ok: false, code: 'install-locked', path: dir, reason: `${dir} is not a plain directory, so locks would not land inside the market root` };
    }
  } catch (error) {
    return { ok: false, code: 'install-locked', path: dir, reason: `${dir} could not be inspected: ${messageOf(error)}` };
  }
  const path = join(dir, `${name}.lock`);
  const record = {
    schema: LOCK_SCHEMA, slug: name, op,
    txid: txid === '' ? randomUUID() : txid,
    pid: process.pid, profile, at: new Date().toISOString(),
  };
  let handle;
  try {
    handle = openSync(path, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') {
      return { ok: false, code: 'install-locked', path, reason: `the lock could not be created: ${messageOf(error)}` };
    }
    const existing = describeLock(path);
    if (existing.ok !== true) return { ok: false, code: 'install-locked', path, reason: existing.reason };
    return {
      ok: false, code: 'install-in-progress', path,
      holder: existing.record, holderAlive: existing.alive,
      reason: `"${existing.record.op}" is already running on ${name} (pid ${existing.record.pid}, since ${existing.record.at})`,
    };
  }
  try {
    writeFileSync(handle, JSON.stringify(record, null, 2), 'utf8');
  } catch (error) {
    try { closeSync(handle); } catch { /* the descriptor goes away with the file */ }
    // This descriptor was created here with `wx`, so this file is unambiguously ours to remove.
    try { unlinkSync(path); } catch { /* leaving a file we own beats deleting one we are unsure of */ }
    return { ok: false, code: 'install-locked', path, reason: `the lock could not be written: ${messageOf(error)}` };
  }
  try { closeSync(handle); } catch { /* the record is on disk; the descriptor is not part of the contract */ }
  return { ok: true, path, txid: record.txid, record };
}

/**
 * Remove one lock, but only when it still belongs to this transaction.
 *
 * @param options - `{path, txid}`.
 * @returns `{ok: true, path}` or `{ok: false, path, reason, holder?}`.
 */
export function releaseSlugLock({ path, txid }) {
  if (typeof path !== 'string' || path === '' || typeof txid !== 'string' || txid === '') {
    return { ok: false, path: typeof path === 'string' ? path : '', reason: 'no lock was identified, so none may be removed' };
  }
  const existing = describeLock(path);
  if (existing.ok !== true) return { ok: false, path, reason: existing.reason };
  if (existing.record.txid !== txid) {
    return { ok: false, path, holder: existing.record, reason: `the lock belongs to ${existing.record.txid}, not ${txid}` };
  }
  try {
    unlinkSync(path);
  } catch (error) {
    return { ok: false, path, reason: `the lock could not be removed: ${messageOf(error)}` };
  }
  return { ok: true, path };
}

/**
 * Take the slug for one operation: in this process first, then in the filesystem.
 *
 * The in-process check is not redundant. Two requests in one process reach for the same slug before
 * either has created a lock file, and the second must be refused rather than spend the first one's
 * lock as a collision.
 *
 * @param options - `{slug, op, profile}`.
 * @returns the same shape as {@link acquireSlugLock}, with `ok: false` when the slug is busy.
 */
export function acquireOperationLock({ slug, op, profile = '' }) {
  const name = String(slug === undefined || slug === null ? '' : slug);
  if (!SLUG_PATTERN.test(name)) {
    return { ok: false, code: 'install-locked', path: '', reason: `"${name.slice(0, 40)}" is not a slug, so no lock path may be built from it` };
  }
  const running = inFlightSlugs.get(name);
  if (running !== undefined) {
    return {
      ok: false, code: 'install-in-progress', path: lockPathFor(name),
      holder: { ...running }, holderAlive: true,
      reason: `this process is already running "${running.op}" on ${name}`,
    };
  }
  const held = acquireSlugLock({ slug: name, op, profile });
  if (held.ok !== true) return held;
  inFlightSlugs.set(name, { op, txid: held.txid, pid: process.pid, at: held.record.at, profile });
  return held;
}

/**
 * Give the slug back.
 *
 * The in-process entry is always cleared, even when the file cannot be removed: leaving it set would
 * wedge the slug for the rest of the process's life. A file that could not be removed is recorded
 * instead of swallowed, and never removed on a guess.
 *
 * @param lock - what {@link acquireOperationLock} returned.
 * @returns `{ok, path?, reason?}`.
 */
export function releaseOperationLock(lock) {
  if (lock === null || typeof lock !== 'object' || typeof lock.path !== 'string' || typeof lock.txid !== 'string') {
    return { ok: false, reason: 'no lock was held' };
  }
  const slug = lock.record !== undefined && typeof lock.record.slug === 'string' ? lock.record.slug : '';
  const running = inFlightSlugs.get(slug);
  if (running !== undefined && running.txid === lock.txid) inFlightSlugs.delete(slug);
  const released = releaseSlugLock({ path: lock.path, txid: lock.txid });
  if (released.ok !== true) {
    noteLockProblem({ at: new Date().toISOString(), slug, op: lock.record === undefined ? '' : lock.record.op, txid: lock.txid, path: lock.path, reason: released.reason });
  }
  return released;
}

/** Whether one profile's manifest lists this package, the way DSH itself decides that it loads it. */
function profileDeclares(dir, pkg) {
  const file = join(dir, 'package.json');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    // A directory with no manifest of its own declares nothing; anything else means the profile
    // cannot be read, and an unreadable profile is not an empty one.
    if (error.code === 'ENOENT') return { ok: true, value: false };
    return { ok: false, reason: `${file} could not be read (${error.code}), so what it references is unknown` };
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return { ok: false, reason: `${file} is not readable JSON, so what it references is unknown` };
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, reason: `${file} is not a profile manifest` };
  }
  const selected = manifest.dsh !== null && typeof manifest.dsh === 'object' && manifest.dsh.profile !== null
    && typeof manifest.dsh.profile === 'object' && Array.isArray(manifest.dsh.profile.bundles)
    ? manifest.dsh.profile.bundles
    : [];
  const dependencies = manifest.dependencies !== null && typeof manifest.dependencies === 'object'
    ? Object.keys(manifest.dependencies)
    : [];
  return { ok: true, value: selected.includes(pkg) || dependencies.includes(pkg) };
}

/** Whether one profile's own node_modules has a link that lands on this bundle directory. */
function profileLinksTo(dir, slug, target) {
  const link = join(dir, 'node_modules', BUNDLE_SCOPE, slug);
  let info;
  try {
    info = lstatSync(link);
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, value: false };
    return { ok: false, reason: `${link} could not be inspected (${error.code})` };
  }
  if (!info.isSymbolicLink()) return { ok: true, value: false };
  let resolved;
  try {
    resolved = realpathSync(link);
  } catch (error) {
    // A link whose target is gone resolves to nothing, so it is residue rather than a reference.
    if (error.code === 'ENOENT') return { ok: true, value: false };
    return { ok: false, reason: `the link ${link} could not be resolved (${error.code})` };
  }
  return { ok: true, value: target !== '' && resolved === target };
}

/**
 * Every profile that uses this slug's bundle, and which of them is the one asking.
 *
 * Two kinds of evidence, because they answer slightly different questions:
 *
 * - **declared**: the profile's own manifest lists the package in \`dsh.profile.bundles\` or in its
 *   dependencies — the same composition the official reader uses, which is what decides that DSH
 *   loads the bundle at all;
 * - **linked**: the profile's node_modules has a link that really lands on this directory, so that
 *   profile is reading these bytes whatever its manifest says.
 *
 * Targets are compared as real paths, because two different strings can name one directory and one
 * string can name two. A reference is attributed to the current profile only when \`ours\` says which
 * profile this is: a reference count of one is not evidence that the reference is ours, so when the
 * identity is missing the answer says \`ownership: 'unknown'\` and the caller refuses instead of
 * subtracting one on faith.
 *
 * @param slug - the bundle slug.
 * @param ours - the current profile \`{name, dir}\`, or null when the host did not say.
 * @returns \`{ok: true, references, ownership}\` or \`{ok: false, code, reason}\`.
 */
/**
 * What the dsh installation itself provides, read from its own package.json.
 *
 * The real `listBundles` treats a bundle named in the install anchor's dependencies as one the
 * installation supplies rather than one a profile installed: it counts it as present, and it is
 * not removable. Reading it here is what keeps a profile from removing a bundle that belongs to
 * the installation, and an anchor that cannot be read is reported rather than assumed empty — an
 * assumption would turn "unknown" into "nothing to protect".
 *
 * @returns `{status: 'provides'|'absent'|'unreadable', path}`.
 */
export function installationProvides(pkg, anchorPath) {
  const path = typeof anchorPath === 'string' ? anchorPath : '';
  if (path === '') return { status: 'unreadable', path };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { status: 'unreadable', path };
  }
  if (manifest === null || typeof manifest !== 'object') return { status: 'unreadable', path };
  const dependencies = manifest.dependencies !== null && typeof manifest.dependencies === 'object' ? manifest.dependencies : {};
  return { status: Object.hasOwn(dependencies, pkg) ? 'provides' : 'absent', path };
}

export function bundleReferences(slug, ours = null) {
  const name = String(slug === undefined || slug === null ? '' : slug);
  if (!SLUG_PATTERN.test(name)) {
    return { ok: false, code: 'shared-bundle-unknown', reason: `"${name.slice(0, 40)}" is not a slug, so its references cannot be resolved` };
  }
  let target = '';
  try {
    target = realpathSync(bundleDir(name));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return { ok: false, code: 'shared-bundle-unknown', reason: `${bundleDir(name)} could not be resolved (${error.code}), so what other profiles point at is unknown` };
    }
  }
  let oursDir = '';
  if (ours !== null && ours !== undefined && typeof ours.dir === 'string' && ours.dir !== '') {
    try {
      oursDir = realpathSync(ours.dir);
    } catch (error) {
      return { ok: false, code: 'shared-bundle-unknown', reason: `the current profile directory ${ours.dir} could not be resolved (${error.code}), so references cannot be attributed` };
    }
  }
  const ownership = oursDir === '' ? 'unknown' : 'known';
  const profiles = join(homedir(), '.dsh', 'profiles');
  let names;
  try {
    names = readdirSync(profiles);
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, references: [], ownership };
    return { ok: false, code: 'shared-bundle-unknown', reason: `the profile directory ${profiles} could not be listed (${error.code}), so other references cannot be ruled out` };
  }
  const references = [];
  for (const profile of names) {
    const dir = join(profiles, profile);
    let info;
    try {
      info = lstatSync(dir);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      return { ok: false, code: 'shared-bundle-unknown', reason: `${dir} could not be inspected (${error.code})` };
    }
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    const declared = profileDeclares(dir, `${BUNDLE_PREFIX}${name}`);
    if (declared.ok !== true) return { ok: false, code: 'shared-bundle-unknown', reason: declared.reason };
    const linked = profileLinksTo(dir, name, target);
    if (linked.ok !== true) return { ok: false, code: 'shared-bundle-unknown', reason: linked.reason };
    if (declared.value !== true && linked.value !== true) continue;
    let current = false;
    if (oursDir !== '') {
      try {
        current = realpathSync(dir) === oursDir;
      } catch (error) {
        return { ok: false, code: 'shared-bundle-unknown', reason: `${dir} could not be resolved (${error.code}), so its ownership is unknown` };
      }
    }
    references.push({ profile, dir, declared: declared.value, linked: linked.value, current });
  }
  return { ok: true, references, ownership };
}

/**
 * Why a bundle directory must not be written to, or `''` when it may.
 *
 * `<MARKET_ROOT>/<slug>` is about to receive this plugin's files. A link placed there would send
 * every one of them outside the market root, so the path is inspected before it is written through.
 */
export function bundlePathProblem(slug) {
  const dir = bundleDir(slug);
  try {
    const info = lstatSync(dir);
    if (info.isSymbolicLink()) return `the bundle path ${dir} is a link, so writing through it would leave the market root`;
    if (!info.isDirectory()) return `the bundle path ${dir} is not a directory`;
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    return `the bundle path ${dir} could not be inspected (${error.code})`;
  }
  return '';
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

/** The row id one entry's generated bundle owns. Derived from the slug, so it is stable. */
export function rowIdForSlug(slug) {
  return `${ROW_PREFIX}${slug}`;
}

/**
 * Decide the identity one install writes: the row id, and the `serverName` it loads under.
 *
 * `serverName` is not decoration — the model calls this server's tools `mcp__<serverName>__<tool>`,
 * so the name is a contract with everything already written against the row. It therefore may not
 * move on its own:
 *
 * - A **new** row takes the readable name derived from the registry entry, deduplicated against the
 *   names the other rows already hold.
 * - An **existing** row keeps the id and the `serverName` it already has. That is the whole fix:
 *   feeding the row's own name back in as a *taken* name is what renamed `notes` to `notes-2`
 *   on reinstall, and back again on the next one.
 * - If the name it must keep is now held by **another** row, this reports a conflict. Renaming would
 *   silently break every `mcp__<name>__*` reference, and writing a duplicate would give the client
 *   two rows claiming one name — so neither is done on the caller's behalf.
 *
 * @param options - `{name, slug, taken, current}`. `taken` must already exclude this row; `current`
 *   is `{rowId, serverName}` when the row exists, and `null` for a first install.
 * @returns `{ok, mode, rowId, serverName}`, or `{ok: false, reason}` when the identity cannot be kept.
 */
export function resolveIdentity({ name, slug, taken = [], current = null }) {
  const rowId = current !== null && typeof current.rowId === 'string' && current.rowId !== ''
    ? current.rowId
    : rowIdForSlug(slug);
  if (current === null) {
    return { ok: true, mode: 'fresh', rowId, serverName: serverNameFor(name, taken) };
  }
  const serverName = typeof current.serverName === 'string' ? current.serverName.trim() : '';
  if (serverName === '') {
    return { ok: false, mode: 'update', rowId, serverName, reason: `the installed row ${rowId} carries no serverName to reuse, so it cannot be updated without renaming it` };
  }
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    return { ok: false, mode: 'update', rowId, serverName, reason: `the installed row's serverName "${serverName}" is outside the name the MCP client accepts` };
  }
  if (taken.includes(serverName)) {
    return { ok: false, mode: 'update', rowId, serverName, reason: `serverName "${serverName}" is now held by another MCP row; renaming this one would break every mcp__${serverName}__* reference, so the update is refused` };
  }
  return { ok: true, mode: 'update', rowId, serverName };
}

/** The rules one `env` or `headers` block's key names have to satisfy, and why. */
const KEY_RULES = {
  env: {
    pattern: ENV_NAME_PATTERN,
    shape: 'a portable environment-variable name (letters, digits and underscores, not starting with a digit)',
    // Windows environment blocks are matched case-insensitively, so two names that differ only in
    // case are one variable there.
    caseInsensitive: true,
  },
  headers: {
    pattern: HEADER_NAME_PATTERN,
    shape: 'an HTTP field-name token (RFC 9110)',
    // Header names have always been case-insensitive; `Authorization` and `authorization` are one.
    caseInsensitive: true,
  },
};

/**
 * The `env` (stdio) or `headers` (http) block one row will be written with, and what that block is
 * called.
 *
 * `renderPatch` and the pre-write check both read this, so the keys that are checked are the keys
 * that are written — the merge that decides them exists once, in one place.
 *
 * @param plan - the install plan.
 * @param config - the values collected for this install.
 * @returns `{kind, values, keys}`.
 */
export function configBlockFor(plan, config = {}) {
  if (plan.transport === 'stdio') {
    // An mcpb package's env is already derived from its manifest, and the values the form collected
    // are that package's own `user_config` inputs — a different namespace. Merging them here would
    // write every input a second time under its raw key name.
    const values = plan.registryType === 'mcpb' ? { ...plan.env } : { ...plan.env, ...(config || {}) };
    return { kind: 'env', values, keys: Object.keys(values) };
  }
  const values = { ...plan.headers, ...(config || {}) };
  return { kind: 'headers', values, keys: Object.keys(values) };
}

/** A key rendered safe to quote back in a message: control characters shown as escapes, not as themselves. */
function printableKey(key) {
  return String(key)
    .replace(/[\u0000-\u001f\u007f]/g, (character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'))
    .slice(0, 80);
}

/**
 * Check the key names of one `env` / `headers` block before anything is written.
 *
 * A *value* goes through JSON escaping, which is also valid YAML, so a value can never change the
 * shape of the document. A *key* is the left-hand side of the mapping: a newline in one adds an
 * entry that was never declared, a colon or a leading dash moves one, an empty one is not a key at
 * all, and a null byte makes the whole file unparseable. These keys come from third-party data —
 * the registry's declared variables and headers, a local entry file, an mcpb package's manifest —
 * so the shape of the profile's configuration must not be theirs to decide.
 *
 * Nothing is dropped. A single bad key refuses the whole write, so what is stored is never a
 * quietly edited version of what was asked for.
 *
 * @param kind - `'env'` or `'headers'`.
 * @param values - the block that is about to be written.
 * @returns `{ok: true}` or `{ok: false, code, reason}`.
 */
export function checkBlockKeys(kind, values) {
  const rule = KEY_RULES[kind];
  if (rule === undefined) {
    return { ok: false, code: 'invalid-config-key', reason: `unknown key block "${kind}"` };
  }
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    const received = values === null ? 'null' : Array.isArray(values) ? 'an array' : typeof values;
    return { ok: false, code: 'invalid-config-key', reason: `the ${kind} block must be an object, received ${received}` };
  }
  const seen = new Map();
  for (const key of Object.keys(values)) {
    if (typeof key !== 'string' || key === '') {
      return { ok: false, code: 'invalid-config-key', reason: `the ${kind} block carries an empty key, which is not a mapping key at all` };
    }
    if (key.length > MAX_KEY_LENGTH) {
      return { ok: false, code: 'invalid-config-key', reason: `${kind} name is ${key.length} characters long, over the ${MAX_KEY_LENGTH} limit` };
    }
    if (!rule.pattern.test(key)) {
      return { ok: false, code: 'invalid-config-key', reason: `"${printableKey(key)}" is not ${rule.shape}, so it cannot be written as a ${kind} key` };
    }
    const folded = key.toLowerCase();
    if (rule.caseInsensitive && seen.has(folded)) {
      return { ok: false, code: 'invalid-config-key', reason: `${kind} keys "${printableKey(seen.get(folded))}" and "${printableKey(key)}" are the same name, because ${kind === 'headers' ? 'header names' : 'environment names on Windows'} are matched case-insensitively` };
    }
    seen.set(folded, key);
  }
  return { ok: true };
}

/** The error a refused key raises, so a caller that skipped the check still cannot write one. */
function keyRefusal(check) {
  const error = new Error(`invalid-config-key: ${check.reason}`);
  error.code = 'invalid-config-key';
  return error;
}

/**
 * A YAML mapping key.
 *
 * A name that is checked and plain-safe is written bare, which is what every patch written so far
 * looks like and is why this does not churn the generated files. Anything else is quoted — JSON
 * string escaping is valid YAML — so a key is never emitted as structure, whatever reaches here.
 */
function yamlKey(key) {
  return PLAIN_KEY_PATTERN.test(key) ? key : yamlString(key);
}

/** The `application` values the plugin manager's declared ChangeResult contract allows. */
export const APPLICATION_STATES = ['applied', 'restart-required', 'overridden', 'failed', 'cancelled'];

/**
 * Read what the plugin manager said about one change.
 *
 * `change()` catches every operation failure into the result and resolves, so a rejected promise is
 * not how an install fails — `application: 'failed'` is. Awaiting the promise and reading nothing
 * else is exactly how a failed install came to answer `{ok: true}`.
 *
 * Two values are success, and only two. `overridden` is not an install outcome at all, a value
 * outside the contract means this build does not know what happened, and anything that is not a
 * change result proves nothing — none of those may be reported as a success.
 *
 * @param result - whatever `installBundle` resolved with.
 * @returns `{ok: true, application, ...}` or `{ok: false, code, reason, application, ...}`.
 */
export function installOutcome(result) {
  const shape = result === null ? 'null' : Array.isArray(result) ? 'an array' : typeof result;
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return {
      ok: false, code: 'install-result-unverified', application: '', errorCode: '', diagnostic: '', failedAt: '',
      reason: `the plugin manager resolved with ${shape}, which is not a change result`,
    };
  }
  const error = result.error !== null && typeof result.error === 'object' ? result.error : {};
  const detail = {
    application: typeof result.application === 'string' ? result.application : '',
    errorCode: typeof error.code === 'string' ? error.code : '',
    diagnostic: typeof error.diagnostic === 'string' ? error.diagnostic : '',
    failedAt: typeof result.failedAt === 'string' ? result.failedAt : '',
  };
  if (detail.application === 'applied' || detail.application === 'restart-required') {
    return { ok: true, ...detail, reason: '' };
  }
  if (detail.application === 'failed') {
    return { ok: false, code: 'install-failed', ...detail, reason: 'the plugin manager reported the install as failed' };
  }
  if (detail.application === 'cancelled') {
    return { ok: false, code: 'install-cancelled', ...detail, reason: 'the plugin manager reported the install as cancelled' };
  }
  if (detail.application === 'overridden') {
    return { ok: false, code: 'install-overridden', ...detail, reason: 'the plugin manager reported the change as overridden, which is not an install outcome' };
  }
  if (detail.application === '') {
    return { ok: false, code: 'install-result-unverified', ...detail, reason: 'the result carries no application field, so what happened could not be read' };
  }
  return {
    ok: false, code: 'install-result-unknown', ...detail,
    reason: `"${detail.application}" is not one of the application values this build knows (${APPLICATION_STATES.join(', ')})`,
  };
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
  // The keys are YAML structure, so they are decided in one place, checked, and only then written.
  // A bad one refuses the whole render instead of being skipped: a configuration that quietly drops
  // a field is harder to notice than an install that refuses to happen.
  const block = configBlockFor(plan, config);
  const keyCheck = checkBlockKeys(block.kind, block.values);
  if (keyCheck.ok !== true) throw keyRefusal(keyCheck);

  if (plan.transport === 'stdio') {
    lines.push(`        command: ${yamlString(plan.command)}`);
    lines.push('        args:');
    for (const argument of args || []) lines.push(`          - ${yamlString(argument)}`);
    if ((args || []).length === 0) lines.push('          []');
    lines.push('        env:');
    if (block.keys.length === 0) lines.push('          {}');
    for (const key of block.keys) lines.push(`          ${yamlKey(key)}: ${yamlString(block.values[key])}`);
  } else {
    lines.push(`        url: ${yamlString(plan.url)}`);
    lines.push('        headers:');
    if (block.keys.length === 0) lines.push('          {}');
    for (const key of block.keys) lines.push(`          ${yamlKey(key)}: ${yamlString(block.values[key])}`);
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
/**
 * Remove every market link whose target no longer exists, across all profiles.
 *
 * The uninstall-time prune is the fast path, but it runs at the one moment when the filesystem
 * and the package manager are both mid-flight, and a residue that survives it used to stay
 * forever. This runs on the read path instead — opening the market is enough — so a leftover
 * from any past install or uninstall heals itself, and nothing depends on that moment's timing.
 *
 * @returns the paths that were pruned.
 */
export function pruneAllBundleLinks() {
  const removed = [];
  // Every branch below used to swallow its failure, and a host process has nowhere to print
  // to, so "found nothing" and "could not look" were indistinguishable from the outside. The
  // report is what the host actually saw, written where a person can read it.
  const report = {
    at: new Date().toISOString(),
    home: homedir(),
    profilesDir: '',
    profileNames: [],
    scopes: [],
    seen: [],
    removed: [],
    errors: [],
  };
  const profiles = join(homedir(), '.dsh', 'profiles');
  report.profilesDir = profiles;
  let names = [];
  try {
    names = readdirSync(profiles);
    report.profileNames = names;
  } catch (error) {
    report.errors.push(`readdir ${profiles}: ${String((error && error.code) || error)}`);
    writePruneReport(report);
    return removed;
  }
  for (const name of names) {
    const scope = join(profiles, name, 'node_modules', BUNDLE_SCOPE);
    let entries = [];
    try {
      entries = readdirSync(scope);
      report.scopes.push(`${scope} → ${entries.length}`);
    } catch (error) {
      report.errors.push(`readdir ${scope}: ${String((error && error.code) || error)}`);
      continue;
    }
    for (const slug of entries) {
      const link = join(scope, slug);
      let info;
      try {
        info = lstatSync(link);
      } catch (error) {
        report.errors.push(`lstat ${slug}: ${String((error && error.code) || error)}`);
        continue;
      }
      const live = existsSync(link);
      report.seen.push({ slug, symbolic: info.isSymbolicLink(), directory: info.isDirectory(), live });
      if (!info.isSymbolicLink()) continue;
      // Only a link with nothing behind it: a bundle still installed keeps its link.
      if (live) continue;
      const outcome = removeLink(link);
      if (outcome.ok) {
        removed.push(link);
        report.removed.push({ path: link, via: outcome.via });
      } else {
        report.errors.push(`unlink ${slug}: still present after ${outcome.tries} attempts (${outcome.error})`);
      }
    }
  }
  writePruneReport(report);
  return removed;
}

/**
 * Remove one link, and then check that it is gone.
 *
 * `rmSync(link, {recursive: true, force: true})` reported success in the host process and left
 * the link exactly where it was — no throw, no removal — while the same call from a shell
 * removed it every time. The call is therefore not evidence; the effect is. Each attempt is
 * followed by a look at the filesystem, and the report says which one worked, or that none did.
 *
 * @param link - the reparse point to remove.
 * @returns `{ok, via, tries, error}`.
 */
function removeLink(link) {
  // Order matters: `unlinkSync` is the one the host actually honours. `rmSync(recursive,
  // force)` reported success there and removed nothing, and it is kept last because a real
  // directory (should one ever appear here) is the only thing it handles better.
  const attempts = [
    () => unlinkSync(link),
    () => rmdirSync(link),
    () => rmSync(link, { recursive: true, force: true }),
  ];
  let error = '';
  for (let index = 0; index < attempts.length; index += 1) {
    try {
      attempts[index]();
    } catch (caught) {
      error = String((caught && caught.code) || caught);
    }
    // A junction whose target is missing makes `existsSync` false either way, so the check is
    // on the link itself, not on what it points at.
    let present = true;
    try {
      lstatSync(link);
    } catch {
      present = false;
    }
    if (!present) return { ok: true, via: index, tries: index + 1, error };
  }
  return { ok: false, via: -1, tries: attempts.length, error };
}

/** Write the last prune's findings where a person can read them. Never throws. */
function writePruneReport(report) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(join(CACHE_DIR, 'prune-report.json'), JSON.stringify(report, null, 2), 'utf8');
  } catch {
    /* diagnostics must never break the read path */
  }
}

/**
 * Download an mcpb package into a bundle directory and read its manifest.
 *
 * Kept here rather than in the route so the runtime facts the manifest is checked against —
 * which programs exist, which versions — come from the same detection the cards use.
 *
 * @param identifier - the https URL.
 * @param targetDir - the `mcpb/` directory inside the generated bundle.
 * @returns the mcpb module's result, unchanged.
 */
export async function fetchMcpb(identifier, targetDir) {
  return mcpb.downloadAndExtract(identifier, targetDir);
}

/**
 * Every `user_config` key a manifest declares.
 *
 * Re-exported because the install route needs it before it can map the manifest: the keys the
 * form is allowed to send for an mcpb entry come from the package, not from the plan.
 *
 * @param manifest - the parsed `manifest.json`.
 * @returns the declared key names.
 */
export function declaredConfigKeys(manifest) {
  return mcpb.declaredConfigKeys(manifest);
}

/**
 * Turn a package manifest into the row's command line, using this machine's runtimes.
 *
 * @param manifest - the parsed manifest.
 * @param extractedDir - where it was extracted.
 * @param config - the values the install form collected.
 * @param ctx - the plugin context, for nothing but consistency with the other helpers.
 * @returns `{ok, command, args, env, variables, warnings}` or `{ok: false, reason}`.
 */
export function planFromMcpb(manifest, extractedDir, config, ctx) {
  const runtimes = detectRuntimes();
  return mcpb.manifestToPlan(manifest, extractedDir, config || {}, {
    runtimes,
    locate: (name) => locate([name, `${name}.exe`, `${name}.cmd`], runtimeDirsFor(name, runtimes)),
    nodeVersion: process.versions.node,
    uvVersion: uvVersionOf(runtimes),
  });
}

/** Where a program of this kind would live, for the mcpb resolver. */
function runtimeDirsFor(name, runtimes) {
  const home = homedir();
  if (name === 'node') return [join(String(runtimes.npx.command || ''), '..')];
  if (name === 'uv' || name === 'uvx') return [join(home, '.local', 'bin'), join(process.env.LOCALAPPDATA || home, 'Programs', 'Python', 'Scripts')];
  return [join(home, '.local', 'bin'), 'C:\\Program Files', 'C:\\Program Files (x86)'];
}

/** The uv version, asked once per call: `uv --version` prints `uv 0.12.24 (…)`. */
function uvVersionOf(runtimes) {
  const uvx = runtimes?.uvx?.path || '';
  if (uvx === '') return '';
  try {
    const out = execFileSync(uvx, ['--version'], { encoding: 'utf8', timeout: 5000 });
    const match = /(\d+\.\d+\.\d+)/.exec(String(out));
    return match === null ? '' : match[1];
  } catch {
    return '';
  }
}
/** The directory of one generated bundle. */
export function bundleDir(slug) {
  return join(MARKET_ROOT, slug);
}

/**
 * Every installed market bundle, newest first.
 *
 * Read-only: an empty market root is an empty listing, not a reason to create one. Creating it here
 * made every read of the listing a write, and a reader that writes cannot be asked what the state
 * was before it looked.
 */
export function listInstalled() {
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
 * @param options - `{slug, rowId, server, serverName, plan, args, config, argumentValues, mcpbInfo}`.
 *   `rowId` is the identity `resolveIdentity` settled on; omitting it derives the default, which is
 *   what every row written by this plugin has always been.
 * @returns `{slug, dir, pkg, rowId}`.
 */
export function writeBundle({ slug, rowId = '', server, serverName, plan, args, config, argumentValues, mcpbInfo, dir = '', txid = '' }) {
  // Checked before anything is created: a link placed at <MARKET_ROOT>/<slug> would take every file
  // written below it out of the market root. A staging directory is inside the market root too, so
  // the same rule is applied to whichever path this call was handed.
  const target = dir === '' ? bundleDir(slug) : dir;
  const unsafe = target === bundleDir(slug) ? bundlePathProblem(slug) : stagingPathProblem(slug, target);
  if (unsafe !== '') {
    const error = new Error(`invalid-bundle-path: ${unsafe}`);
    error.code = 'invalid-bundle-path';
    throw error;
  }
  ensureRoot();
  mkdirSync(target, { recursive: true });
  const pkg = `${BUNDLE_PREFIX}${slug}`;
  const identity = rowId === '' ? rowIdForSlug(slug) : rowId;
  const origin = server.source === 'local' ? 'a local entry' : 'the official MCP registry';
  const manifestJson = renderPackageJson(slug, server.version, `${server.title} — installed from ${origin}`);
  const patchYaml = renderPatch({ rowId: identity, serverName, plan, args, config, source: server.source });
  // Names and a hash: what the previous version was can be checked later without keeping a copy of
  // it, and a digest of a rendered bundle is not a place a secret can hide — it is one-way.
  const renderDigest = tx.digestOf({ 'package.json': manifestJson, 'cordis.patch.yml': patchYaml });
  writeFileSync(join(target, 'package.json'), manifestJson, 'utf8');
  writeFileSync(join(target, 'cordis.patch.yml'), patchYaml, 'utf8');
  const envKeys = Object.keys(config);
  // The values are digested, never recorded: the digest is what lets a recovery prove the running
  // configuration is the one this transaction rendered.
  const envValues = {};
  for (const key of envKeys) envValues[key] = config[key];
  // The same rendered configuration, summarised the version 2 way: what actually went into the
  // patch, not the registry's plan data, and never re-derived from wherever the bundle sits now.
  const summary = tx.configSummaryOf({
    transport: plan.transport,
    command: plan.kind === 'stdio' ? plan.command : null,
    args: plan.kind === 'stdio' ? args || [] : [],
    env: plan.transport === 'streamable-http' ? null : config || {},
    headers: plan.transport === 'streamable-http' ? config || {} : null,
  });
  const scanned = tx.digestDirectory(target, { exclude: ['market.meta.json'] });
  const wholeDigest = scanned.ok === true ? scanned.digest : '';
  writeFileSync(join(target, 'market.meta.json'), `${JSON.stringify({
    registryName: server.name,
    registryVersion: server.version,
    registryTitle: server.title,
    installedAt: new Date().toISOString(),
    source: server.source === 'local' ? 'local' : 'registry',
    mcpb: mcpbInfo === undefined ? null : mcpbInfo,
    slug,
    pkg,
    rowId: identity,
    serverName,
    kind: plan.kind,
    registryType: plan.registryType,
    transport: plan.transport,
    command: plan.kind === 'stdio' ? plan.command : null,
    args: plan.kind === 'stdio' ? args || [] : null,
    argumentValues: argumentValues || {},
    url: plan.kind === 'http' ? plan.url : null,
    configKeys: envKeys,
    // Which transaction wrote this version, and what it rendered. Both are optional for a reader:
    // a manifest written before these fields existed simply has neither.
    txid: txid === '' ? null : txid,
    renderDigest,
    // A digest of the whole directory, so a payload the renderer did not write down is still
    // covered, and a digest of the configured values, so a recovery can check them without
    // keeping a copy of them.
    contentDigest: wholeDigest === '' ? null : wholeDigest,
    configDigest: tx.configDigestOf(envValues),
    // A second, versioned summary beside the first. The older field keeps its meaning exactly; a
    // reader that does not know this one still reads that one, and a reader that finds this one
    // damaged treats it as no evidence rather than as agreement.
    configDigestV2: summary.digest,
    configDigestVersion: summary.version,
    configNamespace: summary.namespace,
  }, null, 2)}\n`, 'utf8');
  return { slug, dir: target, pkg, rowId: identity, txid, renderDigest };
}

/**
 * Write down the answer the installer gave, with the operation that received it.
 *
 * The answer is evidence, and evidence has to name what it is about: a restart requirement recorded
 * without a transaction, a profile and a version would be indistinguishable from one left behind by
 * an earlier installation — and would authorise a claim about a configuration nobody observed. The
 * value is one of a fixed set of words, and nothing configured is written here.
 */
export function recordPublishedApplication(dir, evidence) {
  const path = join(dir, 'market.meta.json');
  let meta;
  try {
    meta = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { ok: false, reason: 'the manifest could not be read (' + String((error && error.code) || error) + ')' };
  }
  if (meta === null || typeof meta !== 'object') return { ok: false, reason: 'the manifest is not an object' };
  meta.published = {
    application: typeof evidence.application === 'string' ? evidence.application : '',
    txid: typeof evidence.txid === 'string' ? evidence.txid : '',
    profile: typeof evidence.profile === 'string' ? evidence.profile : '',
    rowId: typeof evidence.rowId === 'string' ? evidence.rowId : '',
    at: typeof evidence.at === 'string' ? evidence.at : '',
  };
  try {
    writeFileSync(path, JSON.stringify(meta, null, 2), 'utf8');
  } catch (error) {
    return { ok: false, reason: 'the manifest could not be written (' + String((error && error.code) || error) + ')' };
  }
  return { ok: true, published: meta.published };
}

/**
 * Why a staging directory must not be written to, or '' when it may.
 *
 * Staging lives under the market root like everything else, so a link placed where the directory
 * belongs would send a whole bundle somewhere else — and it would be published from there.
 */
export function stagingPathProblem(slug, dir) {
  try {
    const info = lstatSync(dir);
    if (info.isSymbolicLink()) return `the staging path ${dir} is a link, so writing through it would leave the market root`;
    if (!info.isDirectory()) return `the staging path ${dir} is not a directory`;
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    return `the staging path ${dir} could not be inspected (${error.code})`;
  }
  return '';
}

/** Delete one generated bundle directory. */
/**
 * Take a bundle's files away, once nothing can be reading them.
 *
 * Detaching removes a dependency; this removes the bytes. It runs only when both can be shown:
 * no other profile references the directory, and its content is still exactly what the transaction
 * that wrote it recorded. Anything else leaves the files where they are — a directory that cannot
 * be proven to be ours is not one to delete, and a directory someone else reads is not either.
 *
 * The move comes first and the deletion second, so a failure at any point leaves the bundle either
 * where it was or in quarantine — never half-removed.
 *
 * @returns `{ok: true, retired, pruned, quarantineLeft}` or `{ok: false, code, reason}`.
 */
export function retireBundle(slug, ours = null) {
  const name = String(slug === undefined || slug === null ? '' : slug);
  if (!SLUG_PATTERN.test(name)) {
    return { ok: false, code: 'retire-unknown', reason: `${name.slice(0, 40)} is not a slug, so its files are not touched` };
  }
  const references = bundleReferences(name, ours);
  if (references.ok !== true || references.ownership !== 'known') {
    return { ok: false, code: 'retire-references-unknown', reason: references.ok === true ? 'the host did not say which profile this is' : references.reason };
  }
  const others = references.references.filter((item) => item.current !== true);
  if (others.length > 0) {
    return { ok: false, code: 'retire-shared', reason: 'another profile is still reading these files', others };
  }
  const dir = bundleDir(name);
  let info;
  try {
    info = lstatSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, retired: false, code: '', pruned: [], quarantineLeft: false };
    return { ok: false, code: 'retire-inspect-failed', reason: `the bundle directory could not be inspected (${String(error.code)})` };
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    return { ok: false, code: 'retire-not-a-directory', reason: 'the bundle path is not a directory this plugin wrote' };
  }
  const content = tx.verifyBundleContent(dir);
  if (content.ok !== true) {
    return { ok: false, code: 'retire-content-unreadable', reason: content.reason || 'the content could not be read' };
  }
  // A bundle installed before digests existed has nothing to compare against, and the manifest
  // naming the directory is still this plugin's own record of what it put there — refusing those
  // would mean the earliest installs could never be cleaned up. A recorded digest that no longer
  // matches is the different case: that content changed after it was written, and it stays.
  if (content.verifiable === true && content.matches !== true) {
    return { ok: false, code: 'retire-content-changed', reason: 'the content changed since it was installed, so it is not deleted' };
  }
  const quarantineRoot = join(MARKET_ROOT, '.tx', name, 'quarantine');
  const quarantine = join(quarantineRoot, 'retire-' + Date.now().toString(36));
  try {
    mkdirSync(quarantineRoot, { recursive: true });
    renameSync(dir, quarantine);
  } catch (error) {
    return { ok: false, code: 'retire-move-failed', reason: `the bundle could not be moved aside (${String((error && error.code) || error)})` };
  }
  const pruned = pruneBundleLinks(name);
  let quarantineLeft = false;
  try {
    rmSync(quarantine, { recursive: true, force: true });
  } catch {
    quarantineLeft = true;
  }
  if (existsSync(quarantine)) quarantineLeft = true;
  return { ok: true, retired: true, code: '', pruned, quarantineLeft, contentVerified: content.verifiable === true && content.matches === true };
}

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

/**
 * What the slug lock looks like right now. Read-only: a listing, a read and a signal probe.
 *
 * Naming the holder is the whole point. "Locked" and "locked by a process that no longer exists"
 * lead to different decisions, and nothing here decides: a dead holder is reported as dead and the
 * lock is left exactly where it is.
 */
export function lockStateFor(slug, selfTxid = '') {
  const name = String(slug === undefined || slug === null ? '' : slug);
  if (!SLUG_PATTERN.test(name)) {
    return { state: 'unreadable', reason: 'the slug is not a slug, so no lock path may be built from it', alive: false, txid: '', op: '', path: '' };
  }
  const reported = '.locks/' + name + '.lock';
  const path = lockPathFor(name);
  try {
    lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'free', reason: 'no lock is present', alive: false, txid: '', op: '', path: reported };
    return { state: 'unreadable', reason: reported + ' could not be inspected (' + error.code + ')', alive: false, txid: '', op: '', path: reported };
  }
  const running = inFlightSlugs.get(name);
  if (running !== undefined) {
    // The caller may be the operation holding it: a route that takes the lock and then re-reads the
    // state would otherwise be told it is blocked by itself.
    if (selfTxid !== '' && running.txid === selfTxid) {
      return { state: 'self', reason: 'this request holds the lock', alive: true, txid: running.txid, op: running.op, path: reported };
    }
    return { state: 'held', reason: 'this process is running "' + running.op + '" on this slug', alive: true, txid: running.txid, op: running.op, path: reported };
  }
  const existing = describeLock(path);
  if (existing.ok !== true) {
    return { state: 'unreadable', reason: existing.reason, alive: false, txid: '', op: '', path: reported };
  }
  if (selfTxid !== '' && existing.record.txid === selfTxid) {
    return { state: 'self', reason: 'this request holds the lock', alive: true, txid: existing.record.txid, op: String(existing.record.op), path: reported };
  }
  return {
    state: 'held',
    reason: '"' + String(existing.record.op) + '" holds this slug',
    alive: existing.alive,
    txid: typeof existing.record.txid === 'string' ? existing.record.txid : '',
    op: typeof existing.record.op === 'string' ? existing.record.op : '',
    path: reported,
  };
}

/**
 * Every slug that has transaction state on disk, whether or not a bundle is installed for it.
 *
 * Read-only. A slug whose published directory is gone still has to be reported, and it is exactly
 * the one a listing driven by installed bundles would never mention.
 */
export function transactionSlugs() {
  let names;
  try {
    names = readdirSync(join(MARKET_ROOT, '.tx'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort()) {
    let info;
    try {
      info = lstatSync(join(MARKET_ROOT, '.tx', name));
    } catch {
      continue;
    }
    if (info.isDirectory() && !info.isSymbolicLink()) out.push(name);
  }
  return out;
}

/**
 * Profile links that point at nothing. Read-only, and deliberately so.
 *
 * This used to run on the read path and remove what it found, which made opening the market a
 * write. Finding is the part that belongs here; removing belongs to a request that says it is
 * changing something.
 */
export function danglingBundleLinks() {
  const out = [];
  const profiles = join(homedir(), '.dsh', 'profiles');
  let names;
  try {
    names = readdirSync(profiles);
  } catch {
    return out;
  }
  for (const profile of names.sort()) {
    const scope = join(profiles, profile, 'node_modules', BUNDLE_SCOPE);
    let entries;
    try {
      entries = readdirSync(scope);
    } catch {
      continue;
    }
    for (const name of entries.sort()) {
      const link = join(scope, name);
      let info;
      try {
        info = lstatSync(link);
      } catch {
        continue;
      }
      if (!info.isSymbolicLink()) continue;
      // \`existsSync\` follows the link, so this is the question "is there anything behind it".
      if (existsSync(link)) continue;
      out.push({ profile, slug: name, scope: '.dsh/profiles/' + profile + '/node_modules/' + BUNDLE_SCOPE + '/' + name });
    }
  }
  return out;
}
