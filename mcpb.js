/**
 * mcpb packages: the registry's single-file distribution format.
 *
 * A `.mcpb` is a zip holding a `manifest.json` that describes how to run the server, so
 * nothing about the command line is knowable from the registry entry — the survey of ten real
 * packages settled that: 115 of 124 entries carry no `runtimeHint` at all, and the ones that
 * do carry a hint that says less than the manifest does. Everything here therefore runs at
 * install time, after the download, and `probeMcpb` is deliberately the only function the card
 * rendering path may call.
 *
 * Three placeholder forms appear in real manifests, not two:
 *   `${__dirname}`        the extraction directory
 *   `${/}`                the platform's path separator
 *   `${user_config.<key>}` a value the install form collects
 * The third also appears in `command`, which turns that command into a user-supplied absolute
 * path rather than something `locate()` could resolve.
 *
 * @module mcpb
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join, sep } from 'node:path';

/** Server types this build can run. `uv` is python, but `uv run` resolves its own deps. */
export const SUPPORTED_TYPES = new Set(['node', 'binary', 'uv']);

/** The oldest manifest this build understands. */
export const MIN_MANIFEST_VERSION = 0.2;

/** Refusals a package can earn before anything is downloaded. */
const URL_PATTERN = /^https:\/\/[^\s]+$/i;

/**
 * Check an mcpb package entry without touching the network.
 *
 * Called while cards render, so it must stay cheap and side-effect free.
 *
 * @param pkg - one `packages[]` entry whose `registryType` is `mcpb`.
 * @returns `{ok: true, kind, label, identifier, version}` or `{ok: false, reason}`.
 */
export function probeMcpb(pkg) {
  const identifier = typeof pkg?.identifier === 'string' ? pkg.identifier.trim() : '';
  if (identifier === '') return { ok: false, reason: 'mcpb 条目没有下载地址（identifier 为空）' };
  if (!URL_PATTERN.test(identifier)) {
    return { ok: false, reason: `mcpb 的 identifier 不是 https 下载地址（收到 "${identifier.slice(0, 60)}"）` };
  }
  return {
    ok: true,
    kind: 'mcpb',
    label: 'mcpb 包',
    identifier,
    version: typeof pkg.version === 'string' ? pkg.version : '',
  };
}

/** Archive entries that would escape the extraction directory. */
export function unsafeArchiveEntries(entries) {
  return entries.filter((row) => {
    const name = String(row).trim();
    if (name === '') return false;
    if (name.includes('..')) return true;
    if (name.startsWith('/') || name.startsWith('\\')) return true;
    if (/^[a-zA-Z]:/.test(name)) return true;
    return false;
  });
}

/** The system tar. Windows ships bsdtar, which reads zip; nothing else needs installing. */
function tarPath() {
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
}

/**
 * Download one `.mcpb` and extract it, refusing anything that would write outside the target.
 *
 * @param identifier - the https URL from the registry entry.
 * @param targetDir - the directory this install owns (inside the generated bundle).
 * @param options - `{fetchImpl, timeoutMs, maxBytes}`.
 * @returns `{ok: true, manifest, extractedDir, bytes, entries}` or `{ok: false, reason}`.
 */
export async function downloadAndExtract(identifier, targetDir, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120000;
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : 64 * 1024 * 1024;
  const file = join(targetDir, 'package.mcpb');
  const extractedDir = join(targetDir, 'extracted');
  try {
    mkdirSync(targetDir, { recursive: true });
  } catch (error) {
    return { ok: false, reason: `无法创建目录 ${targetDir}：${String((error && error.message) || error)}` };
  }
  let bytes = 0;
  try {
    const response = await fetchImpl(identifier, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, reason: `下载失败：HTTP ${response.status}` };
    const buffer = Buffer.from(await response.arrayBuffer());
    bytes = buffer.length;
    if (bytes === 0) return { ok: false, reason: '下载失败：响应为空' };
    if (bytes > maxBytes) return { ok: false, reason: `包过大（${bytes} 字节，上限 ${maxBytes}）` };
    writeFileSync(file, buffer);
  } catch (error) {
    return { ok: false, reason: `下载失败：${String((error && error.message) || error).slice(0, 120)}` };
  }

  let entries = [];
  try {
    entries = execFileSync(tarPath(), ['-tf', file], { encoding: 'utf8', timeout: timeoutMs })
      .split('\n').map((row) => row.trim()).filter((row) => row !== '');
  } catch (error) {
    return { ok: false, reason: `无法读取包内容：${String((error && error.message) || error).slice(0, 120)}` };
  }
  const unsafe = unsafeArchiveEntries(entries);
  if (unsafe.length > 0) {
    return { ok: false, reason: `包内含越界路径，已拒绝解压：${unsafe.slice(0, 3).join('、')}` };
  }
  try {
    mkdirSync(extractedDir, { recursive: true });
    execFileSync(tarPath(), ['-xf', file, '-C', extractedDir], { stdio: 'ignore', timeout: timeoutMs });
  } catch (error) {
    return { ok: false, reason: `解压失败：${String((error && error.message) || error).slice(0, 120)}` };
  }

  const manifestPath = join(extractedDir, 'manifest.json');
  if (!existsSync(manifestPath)) return { ok: false, reason: '包里没有 manifest.json（不在根目录）' };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return { ok: false, reason: `manifest.json 不是合法 JSON：${String((error && error.message) || error).slice(0, 100)}` };
  }
  return { ok: true, manifest, extractedDir, bytes, entries };
}

/** Compare `x.y.z` versions. Missing parts count as zero. */
function compareVersions(left, right) {
  const parse = (value) => String(value).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Whether a version satisfies the constraints manifests actually use (`>=x.y.z`, `^x.y.z`).
 *
 * An unrecognised constraint is reported as satisfied with a warning: refusing a package over
 * a constraint form this build does not parse would be worse than letting the runtime decide.
 *
 * @param version - the version present on this machine.
 * @param range - the constraint from the manifest.
 * @returns `{ok, warning}`.
 */
export function satisfiesVersion(version, range) {
  const text = String(range || '').trim();
  if (text === '') return { ok: true, warning: '' };
  const match = /^(>=|>|<=|<|\^|~)?\s*v?(\d+(?:\.\d+)*)$/.exec(text);
  if (match === null) return { ok: true, warning: `无法解析版本约束 "${text}"，交由运行时判断` };
  const operator = match[1] || '>=';
  const wanted = match[2];
  const found = String(version || '').replace(/^v/, '');
  if (found === '') return { ok: false, reason: `本机没有可用的 ${wanted} 版本可比较` };
  const diff = compareVersions(found, wanted);
  if (operator === '>=') return { ok: diff >= 0, warning: '' };
  if (operator === '>') return { ok: diff > 0, warning: '' };
  if (operator === '<=') return { ok: diff <= 0, warning: '' };
  if (operator === '<') return { ok: diff < 0, warning: '' };
  // `^` and `~` both mean "same major" for the shapes seen in the registry.
  const sameMajor = compareVersions(found.split('.')[0], wanted.split('.')[0]) === 0;
  return { ok: sameMajor && diff >= 0, warning: '' };
}

/** Replace the three placeholder forms a manifest may use. */
function substitute(text, values, extractedDir) {
  return String(text)
    // A manifest writes `${__dirname}/server/index.js`, so the separator right after the
    // placeholder is the manifest's, not this platform's: substituting the directory alone
    // left `C:\…\extracted/server/index.js` behind.
    .replace(/\$\{__dirname\}([\\/])?/g, (_whole, following) => extractedDir + (following === undefined ? '' : sep))
    .replace(/\$\{\/\}/g, sep)
    // An optional field left blank means blank, not the literal `${user_config.x}`: the
    // manifests describe exactly that ("leave blank for the live site").
    .replace(/\$\{user_config\.([^}]+)\}/g, (_whole, key) => {
      const value = values[key];
      return value === undefined || value === null ? '' : String(value);
    });
}

/** Every `${user_config.<key>}` a string mentions. */
function referencedKeys(text) {
  const keys = [];
  for (const match of String(text).matchAll(/\$\{user_config\.([^}]+)\}/g)) keys.push(match[1]);
  return keys;
}

/**
 * Turn a manifest into the row's command line.
 *
 * @param manifest - the parsed `manifest.json`.
 * @param extractedDir - the absolute extraction directory.
 * @param userConfig - values collected by the install form.
 * @param options - `{runtimes, locate, nodeVersion, uvVersion}` — injected so this module stays
 *   free of the market's own runtime detection.
 * @returns `{ok: true, command, args, env, variables, warnings}` or `{ok: false, reason}`.
 */
export function manifestToPlan(manifest, extractedDir, userConfig = {}, options = {}) {
  const warnings = [];
  if (manifest === null || typeof manifest !== 'object') return { ok: false, reason: 'manifest 不是一个对象' };
  const version = Number(manifest.manifest_version);
  if (!Number.isFinite(version) || version < MIN_MANIFEST_VERSION) {
    return { ok: false, reason: `manifest_version ${JSON.stringify(manifest.manifest_version)} 过旧（需要 ≥ ${MIN_MANIFEST_VERSION}）` };
  }
  if (version > 0.4) warnings.push(`manifest_version ${version} 比本 build 认识的更新，可能有未支持的字段`);

  const server = manifest.server;
  if (server === null || typeof server !== 'object') return { ok: false, reason: 'manifest 缺少 server 段' };
  const type = String(server.type || '');
  if (!SUPPORTED_TYPES.has(type)) {
    return {
      ok: false,
      reason: type === 'python'
        ? 'python mcpb 的依赖安装暂不支持（可用 uv 类型的包）'
        : `不支持的 mcpb 类型 "${type}"（本 build 支持 node / binary / uv）`,
    };
  }

  const platforms = Array.isArray(manifest.compatibility?.platforms) ? manifest.compatibility.platforms : [];
  if (platforms.length > 0 && !platforms.includes('win32')) {
    return { ok: false, reason: `该包不支持 Windows（声明支持：${platforms.join('、')}）` };
  }

  const config = server.mcp_config;
  if (config === null || typeof config !== 'object') return { ok: false, reason: 'manifest 缺少 server.mcp_config 段' };
  const rawCommand = String(config.command || '');
  if (rawCommand === '') return { ok: false, reason: 'mcp_config 缺少 command' };

  // The form has to ask for anything the manifest references and does not itself define.
  const declared = manifest.user_config && typeof manifest.user_config === 'object' ? manifest.user_config : {};
  const referenced = [
    ...referencedKeys(rawCommand),
    ...(Array.isArray(config.args) ? config.args.flatMap((value) => referencedKeys(value)) : []),
    ...(config.env && typeof config.env === 'object' ? Object.values(config.env).flatMap((value) => referencedKeys(value)) : []),
  ];
  const variables = [];
  for (const key of [...new Set([...Object.keys(declared), ...referenced])]) {
    const spec = declared[key] && typeof declared[key] === 'object' ? declared[key] : {};
    const hasValue = userConfig[key] !== undefined && userConfig[key] !== null && String(userConfig[key]) !== '';
    variables.push({
      name: key,
      description: typeof spec.description === 'string' ? spec.description : '',
      isRequired: spec.required === true && !hasValue,
      isSecret: spec.sensitive === true,
      default: typeof spec.default === 'string' ? spec.default : '',
    });
  }

  // Runtime constraints, checked against what this machine actually has.
  const runtimes = manifest.compatibility?.runtimes || {};
  const nodeVersion = options.nodeVersion || '';
  const uvVersion = options.uvVersion || '';
  if (runtimes.node !== undefined) {
    const verdict = satisfiesVersion(nodeVersion, runtimes.node);
    if (!verdict.ok) return { ok: false, reason: `需要 Node ${runtimes.node}，本机 ${nodeVersion || '未知'}` };
    if (verdict.warning) warnings.push(verdict.warning);
  }
  if (runtimes.python !== undefined && type === 'uv') {
    // `uv run` fetches the interpreter it needs, so the local one only has to exist.
    if (!options.runtimes?.uvx?.available) {
      return { ok: false, reason: `需要 uv（声明 python ${runtimes.python}），本机没有找到 uv` };
    }

  }

  // The command itself: either a placeholder the user fills, or a program to locate.
  const commandKeys = referencedKeys(rawCommand);
  let command = '';
  if (commandKeys.length > 0) {
    command = substitute(rawCommand, userConfig, extractedDir);
    if (commandKeys.some((key) => userConfig[key] === undefined)) {
      return { ok: false, reason: `command 需要先填写 ${commandKeys.join('、')}` };
    }
    if (!isAbsolute(command)) {
      return { ok: false, reason: `command 必须是绝对路径（收到 "${command}"）` };
    }
    warnings.push('这条命令由 user_config 提供，请确认它指向你信任的程序');
  } else {
    const locate = typeof options.locate === 'function' ? options.locate : null;
    const resolved = locate === null ? '' : locate(rawCommand);
    if (resolved === '') {
      return { ok: false, reason: `找不到可执行程序 "${rawCommand}"（需要它在 PATH 或已知安装位置）` };
    }
    command = resolved;
  }

  const args = (Array.isArray(config.args) ? config.args : []).map((value) => substitute(value, userConfig, extractedDir));
  const env = {};
  if (config.env && typeof config.env === 'object') {
    for (const [key, value] of Object.entries(config.env)) env[key] = substitute(value, userConfig, extractedDir);
  }
  return { ok: true, command, args, env, variables, warnings, entryPoint: String(server.entry_point || '') };
}

/** Whether an extraction directory looks complete. Used by the uninstall diagnostics. */
export function extractedLooksComplete(dir) {
  try {
    return existsSync(join(dir, 'manifest.json')) && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}
