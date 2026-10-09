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
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/** The official registry endpoint that serves the catalog. */
export const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io/v0/servers';
/** Snapshot freshness window; past it the UI offers a refresh and keeps serving the cache. */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Where generated bundles and the snapshot live. */
export const MARKET_ROOT = join(homedir(), '.dsh', 'mcp-servers');
export const CACHE_PATH = join(MARKET_ROOT, 'market-cache.json');
/** Package-name prefix of a generated bundle. */
export const BUNDLE_PREFIX = '@dsh-mcp-market/';
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

/** Write a file atomically so a crash cannot leave a half-written snapshot. */
function writeAtomic(path, text) {
  ensureRoot();
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
      environmentVariables: (Array.isArray(pack.environmentVariables) ? pack.environmentVariables : [])
        .map((variable) => ({
          name: typeof variable.name === 'string' ? variable.name : '',
          description: typeof variable.description === 'string' ? variable.description : '',
          isRequired: variable.isRequired === true,
          isSecret: variable.isSecret === true,
          default: typeof variable.default === 'string' ? variable.default : '',
        }))
        .filter((variable) => variable.name !== ''),
      packageArguments: (Array.isArray(pack.packageArguments) ? pack.packageArguments : [])
        .map((argument) => ({ value: argument.value, type: argument.type || 'positional' }))
        .filter((argument) => typeof argument.value === 'string'),
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
async function fetchPage(cursor) {
  const url = new URL(REGISTRY_BASE);
  url.searchParams.set('limit', String(PAGE_LIMIT));
  if (cursor !== undefined) url.searchParams.set('cursor', cursor);
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`registry responded ${response.status} ${response.statusText}`);
  return response.json();
}

/** Live refresh bookkeeping, so the UI can show progress instead of hanging. */
const refresh = { running: false, startedAt: 0, pages: 0, rawEntries: 0, kept: 0, error: '', finishedAt: 0 };

/** The current refresh state. */
export function refreshState() {
  return { ...refresh };
}

/** The parsed snapshot held in memory, so searches never re-read 3 MB of JSON. */
let snapshot = null;

/**
 * Pull the whole registry into the cache.
 *
 * @returns the refresh summary.
 */
export async function refreshCatalog() {
  if (refresh.running) return refreshState();
  refresh.running = true;
  refresh.startedAt = Date.now();
  refresh.pages = 0;
  refresh.rawEntries = 0;
  refresh.kept = 0;
  refresh.error = '';
  try {
    const byName = new Map();
    let cursor;
    while (refresh.pages < MAX_PAGES) {
      const body = await fetchPage(cursor);
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
    const servers = [...byName.values()].sort((left, right) =>
      String(right.publishedAt || '').localeCompare(String(left.publishedAt || '')));
    const fetchedAt = new Date().toISOString();
    writeAtomic(CACHE_PATH, JSON.stringify({ fetchedAt, count: servers.length, servers }));
    snapshot = { fetchedAt, servers };
    refresh.finishedAt = Date.now();
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
 * The catalog as the UI needs it: the cache plus its freshness.
 *
 * @returns `{servers, fetchedAt, count, stale, ageMs, source}` where `source` is
 * `cache`, `none`, or `empty`.
 */
export function catalog() {
  if (snapshot === null && existsSync(CACHE_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
      if (Array.isArray(parsed.servers)) snapshot = { fetchedAt: parsed.fetchedAt || '', servers: parsed.servers };
    } catch {
      snapshot = null;
    }
  }
  if (snapshot === null) return { servers: [], fetchedAt: '', count: 0, stale: true, ageMs: null, source: 'none' };
  const ageMs = snapshot.fetchedAt === '' ? null : Date.now() - Date.parse(snapshot.fetchedAt);
  return {
    servers: snapshot.servers,
    fetchedAt: snapshot.fetchedAt,
    count: snapshot.servers.length,
    stale: ageMs === null || !Number.isFinite(ageMs) || ageMs > CACHE_TTL_MS,
    ageMs,
    source: snapshot.servers.length === 0 ? 'empty' : 'cache',
  };
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
 * @param options - `{kind, sort, limit, offset}`; `kind` is `all`, `local`, `remote`, or
 * `unsupported`.
 * @returns `{total, offset, limit, results}`.
 */
export function searchCatalog(query, options = {}) {
  const { servers } = catalog();
  const needle = String(query || '').trim().toLowerCase();
  const kind = options.kind || 'all';
  const sort = options.sort || 'relevance';
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.min(Math.floor(options.limit), 200) : 30;
  const offset = Number.isFinite(options.offset) && options.offset > 0 ? Math.floor(options.offset) : 0;

  const scored = [];
  for (const server of servers) {
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
  else scored.sort((left, right) => right.value - left.value || left.server.name.localeCompare(right.server.name));

  const page = scored.slice(offset, offset + limit).map((item) => summarize(item.server));
  return { total: scored.length, offset, limit, results: page };
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

  const nodePath = locate(platform === 'win32' ? ['node.exe', 'node'] : ['node'], nodeDirs);
  const npxShim = locate(platform === 'win32' ? ['npx.cmd', 'npx'] : ['npx'], nodeDirs);
  const npmCli = locate(platform === 'win32' ? ['npx-cli.js'] : [], []);
  const uvxPath = locate(platform === 'win32' ? ['uvx.exe', 'uvx'] : ['uvx'], pythonDirs);
  const dockerPath = locate(platform === 'win32' ? ['docker.exe', 'docker'] : ['docker'], nodeDirs);

  // npm's npx-cli.js sits next to the node install, not on PATH.
  let npxCliPath = npmCli;
  if (npxCliPath === '' && nodePath !== '') {
    const sibling = join(nodePath, '..', 'node_modules', 'npm', 'bin', 'npx-cli.js');
    if (existsSync(sibling)) npxCliPath = sibling;
  }
  if (npxCliPath === '' && npxShim !== '') {
    const sibling = join(npxShim, '..', 'node_modules', 'npm', 'bin', 'npx-cli.js');
    if (existsSync(sibling)) npxCliPath = sibling;
  }

  const npxUsable = nodePath !== '' && npxCliPath !== '';
  return {
    platform,
    node: { path: nodePath, available: nodePath !== '' },
    npx: {
      available: npxUsable || npxShim !== '',
      shim: npxShim,
      cli: npxCliPath,
      // The exact executable plus leading args a stdio row must use.
      command: npxUsable ? nodePath : npxShim,
      prefix: npxUsable ? [npxCliPath] : [],
      direct: npxUsable,
    },
    uvx: { available: uvxPath !== '', path: uvxPath },
    docker: { available: dockerPath !== '', path: dockerPath },
  };
}

/** The environment a generated stdio row should carry. */
function baseEnv(runtimes) {
  const env = {};
  const nodeDir = runtimes.node.available ? join(runtimes.node.path, '..') : '';
  const path = String(process.env.PATH || '');
  if (nodeDir !== '') env.PATH = path === '' ? nodeDir : `${nodeDir}${delimiter}${path}`;
  return env;
}

/** Positional arguments of a package, in order. */
function positionalArguments(pack) {
  return pack.packageArguments
    .filter((argument) => argument.type === 'positional' || argument.type === undefined)
    .map((argument) => argument.value);
}

/**
 * Every way this server can be installed on this machine, best first.
 *
 * @param server - a normalized server.
 * @param runtimes - the result of {@link detectRuntimes}.
 * @returns `{options, blocked}`: installable plans plus why the rest were skipped.
 */
export function plansFor(server, runtimes) {
  const options = [];
  const blocked = [];
  for (const pack of server.packages) {
    if (pack.registryType === 'npm') {
      if (!runtimes.npx.available) {
        blocked.push({ registryType: 'npm', identifier: pack.identifier, reason: '需要 Node.js（含 npm 的 npx）；未在 PATH 或常见安装位置找到' });
        continue;
      }
      options.push({
        kind: 'stdio',
        registryType: 'npm',
        label: `本地进程 · npx ${pack.identifier}`,
        transport: 'stdio',
        command: runtimes.npx.command,
        args: [...runtimes.npx.prefix, '-y', pack.identifier, ...positionalArguments(pack)],
        env: baseEnv(runtimes),
        variables: pack.environmentVariables,
        risk: '在你本机执行第三方命令',
      });
      continue;
    }
    if (pack.registryType === 'pypi') {
      if (!runtimes.uvx.available) {
        blocked.push({ registryType: 'pypi', identifier: pack.identifier, reason: '需要 uv（uvx）；未安装' });
        continue;
      }
      options.push({
        kind: 'stdio',
        registryType: 'pypi',
        label: `本地进程 · uvx ${pack.identifier}`,
        transport: 'stdio',
        command: runtimes.uvx.path,
        args: [pack.identifier, ...positionalArguments(pack)],
        env: baseEnv(runtimes),
        variables: pack.environmentVariables,
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
      blocked.push({ registryType: 'remote', identifier: remote.url, reason: `暂不支持 ${remote.type} 远程传输` });
      continue;
    }
    options.push({
      kind: 'http',
      registryType: 'remote',
      label: `远程连接 · ${remote.url}`,
      transport: 'streamable-http',
      url: remote.url,
      headers: {},
      variables: remote.headers,
      risk: '请求发往第三方服务器；密钥会作为请求头发送',
    });
  }
  // A local process is the more capable install, so it leads when both exist.
  options.sort((left, right) => (left.kind === right.kind ? 0 : left.kind === 'stdio' ? -1 : 1));
  return { options, blocked };
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
export function renderPatch({ rowId, serverName, plan, config }) {
  const lines = [
    '# Generated by dsh-plugin-mcp-manager from the official MCP registry.',
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
    for (const argument of plan.args) lines.push(`          - ${yamlString(argument)}`);
    if (plan.args.length === 0) lines.push('          []');
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
 * @returns `{slug, dir, pkg}`.
 */
export function writeBundle({ slug, server, serverName, plan, config }) {
  const dir = bundleDir(slug);
  ensureRoot();
  mkdirSync(dir, { recursive: true });
  const pkg = `${BUNDLE_PREFIX}${slug}`;
  const rowId = `mcp-${slug}`;
  writeFileSync(join(dir, 'package.json'), renderPackageJson(slug, server.version, `${server.title} — installed from the official MCP registry`), 'utf8');
  writeFileSync(join(dir, 'cordis.patch.yml'), renderPatch({ rowId, serverName, plan, config }), 'utf8');
  const envKeys = Object.keys(config);
  writeFileSync(join(dir, 'market.meta.json'), `${JSON.stringify({
    registryName: server.name,
    registryVersion: server.version,
    registryTitle: server.title,
    installedAt: new Date().toISOString(),
    source: 'registry',
    slug,
    pkg,
    rowId,
    serverName,
    kind: plan.kind,
    registryType: plan.registryType,
    transport: plan.transport,
    command: plan.kind === 'stdio' ? plan.command : null,
    args: plan.kind === 'stdio' ? plan.args : null,
    url: plan.kind === 'http' ? plan.url : null,
    configKeys: envKeys,
  }, null, 2)}\n`, 'utf8');
  return { slug, dir, pkg };
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
