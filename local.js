/**
 * Local entries: a hand-written file describing how to install things this machine already
 * has, merged into the same catalog as the registry snapshot.
 *
 * The file is plain JSON on the user's disk, so anything on the machine can write it. The
 * validator therefore refuses the shapes that turn a typo or a tampered file into arbitrary
 * execution, and warns about the ones that merely look like they might:
 *
 * - `command` must be an absolute path. A bare `sh`, `cmd`, `python` is refused outright,
 *   because that is how `curl … | sh` style entries start.
 * - A shell or interpreter invoked with an inline-script flag (`-c`, `/c`, `-Command`) is
 *   allowed but flagged: the args then contain a program, not arguments to one.
 * - Shell metacharacters in `args` are flagged, never refused: a legitimate argument can
 *   contain `&` (a URL query string, say). The install dialog shows the raw argv so the
 *   person deciding can read it.
 *
 * Nothing here executes anything. It only decides what may become an MCP row.
 *
 * @module local
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** Bumped when the file's shape changes; an older file is ignored rather than half-read. */
export const LOCAL_CACHE_VERSION = 1;

/** Bare command names that are refused as `command`. */
const BARE_COMMANDS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish',
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'wsl',
  'python', 'python3', 'py', 'node', 'npx', 'npm', 'uvx', 'uv', 'deno', 'bun',
  'env', 'sudo', 'doas', 'xargs', 'eval', 'exec',
]);

/** Flags that make an interpreter run a script given on the command line. */
const INLINE_SCRIPT_FLAGS = new Set(['-c', '/c', '-command', '-encodedcommand', '--eval', '-e']);

/** Characters that would matter if the argv ever reached a shell. */
const SHELL_METACHARACTERS = /[|;&$()`<>]/;

/** Install kinds this build can turn into a row. */
const SUPPORTED_KINDS = new Set(['stdio', 'http']);

/** The wording used for a kind that is deliberately deferred. */
function unsupportedKindReason(kind) {
  return kind === 'sse'
    ? '暂不支持 sse 远程传输（二期）'
    : `暂不支持 ${String(kind)} 安装方式`;
}

const isText = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * Prefix one problem with the entry's position.
 *
 * A missing field reads as `第 2 条缺 command`; anything else as `第 2 条：<problem>`,
 * because the person reading it is hand-editing JSON and needs the line, not a sentence.
 *
 * @param at - the position label, e.g. `第 2 条`.
 * @param problem - the problem text.
 * @returns the message.
 */
function atEntry(at, problem) {
  return problem.startsWith('缺') ? `${at}${problem}` : `${at}：${problem}`;
}

/**
 * Validate one `env`/`headers` list.
 *
 * A `value` means the entry is already filled in; without one, `isRequired` decides whether
 * the install form has to ask. `value` together with `isSecret` is allowed, and the install
 * dialog carries the plaintext warning for it.
 *
 * @param list - the raw array.
 * @param where - a label for messages, e.g. `env`.
 * @returns `{items, problems}`.
 */
function readVariables(list, where) {
  const items = [];
  const problems = [];
  if (list === undefined || list === null) return { items, problems };
  if (!Array.isArray(list)) {
    problems.push(`${where} 必须是数组`);
    return { items, problems };
  }
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(`${where} 里有一项不是对象`);
      continue;
    }
    if (!isText(raw.name)) {
      problems.push(`${where} 里有一项缺 name`);
      continue;
    }
    const item = {
      name: String(raw.name),
      description: isText(raw.description) ? String(raw.description) : '',
      isRequired: raw.isRequired === true,
      isSecret: raw.isSecret === true,
      default: isText(raw.value) ? String(raw.value) : '',
    };
    // A declared value satisfies a required field, so the form will not ask again.
    if (item.default !== '') item.isRequired = false;
    items.push(item);
  }
  return { items, problems };
}

/**
 * Scan one stdio command line.
 *
 * @param command - the raw `command`.
 * @param args - the raw `args`.
 * @returns `{errors, warnings}`; errors refuse the entry, warnings travel with it.
 */
export function scanCommand(command, args) {
  const errors = [];
  const warnings = [];
  if (!isText(command)) {
    errors.push('缺 command');
    return { errors, warnings };
  }
  const text = String(command).trim();
  if (!isAbsolute(text)) {
    errors.push(`command 必须是绝对路径（收到 "${text}"）`);
  } else if (BARE_COMMANDS.has(text.toLowerCase())) {
    errors.push(`command 不能是裸命令名（收到 "${text}"）`);
  }
  const base = text.toLowerCase().replace(/\\/g, '/').split('/').pop() || '';
  if (BARE_COMMANDS.has(base)) {
    warnings.push(`command 指向 shell/解释器（${base}），请确认这是你要执行的程序`);
  }
  if (args !== undefined && args !== null) {
    if (!Array.isArray(args)) {
      errors.push('args 必须是数组');
    } else {
      for (const value of args) {
        if (typeof value !== 'string') {
          errors.push('args 里有一项不是字符串');
          break;
        }
      }
      const joined = args.filter((value) => typeof value === 'string');
      if (joined.some((value) => value.includes('\n'))) {
        warnings.push('args 里含换行');
      }
      const flagged = joined.filter((value) => SHELL_METACHARACTERS.test(value));
      if (flagged.length > 0) {
        warnings.push(`args 含 shell 元字符：${flagged.join(' ')}`);
      }
      const lower = joined.map((value) => value.toLowerCase());
      if (lower.some((value) => INLINE_SCRIPT_FLAGS.has(value))) {
        warnings.push('args 里有内联脚本标志（-c / /c / -Command 等）：这段参数本身就是程序');
      }
    }
  }
  return { errors, warnings };
}

/**
 * Validate and normalize the whole file.
 *
 * Every problem carries the entry's 1-based position, because the person reading it is
 * hand-editing JSON and needs to know which line to look at.
 *
 * @param document - the parsed file.
 * @returns `{entries, errors, warnings}` — normalized entries keep `source: 'local'`.
 */
export function validateLocalEntries(document) {
  const errors = [];
  const warnings = [];
  const entries = [];
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return { entries, errors: ['文件顶层必须是一个对象'], warnings };
  }
  if (document.cacheVersion !== LOCAL_CACHE_VERSION) {
    return {
      entries,
      errors: [`cacheVersion 必须是 ${LOCAL_CACHE_VERSION}（收到 ${JSON.stringify(document.cacheVersion)}）`],
      warnings,
    };
  }
  if (!Array.isArray(document.entries)) {
    return { entries, errors: ['entries 必须是数组'], warnings };
  }

  const seen = new Map();
  document.entries.forEach((raw, index) => {
    const at = `第 ${index + 1} 条`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${at}不是对象`);
      return;
    }
    const entryErrors = [];
    if (!isText(raw.name)) entryErrors.push(`${at}缺 name`);
    else if (seen.has(String(raw.name))) entryErrors.push(`${at}的 name 与第 ${seen.get(String(raw.name))} 条重复`);
    const install = raw.install;
    if (install === null || typeof install !== 'object' || Array.isArray(install)) {
      entryErrors.push(`${at}缺 install`);
    } else if (!isText(install.kind)) {
      entryErrors.push(`${at}缺 install.kind`);
    } else if (!SUPPORTED_KINDS.has(String(install.kind))) {
      entryErrors.push(`${at}的 install.kind ${unsupportedKindReason(String(install.kind))}`);
    }

    if (entryErrors.length > 0) {
      errors.push(...entryErrors);
      return;
    }

    const kind = String(install.kind);
    const entryWarnings = [];
    const normalized = {
      name: String(raw.name),
      title: isText(raw.title) ? String(raw.title) : String(raw.name),
      description: isText(raw.description) ? String(raw.description) : '',
      version: isText(raw.version) ? String(raw.version) : '',
      publishedAt: null,
      packages: [],
      remotes: [],
      source: 'local',
      warning: false,
      warningReasons: [],
      local: { kind },
    };

    if (kind === 'stdio') {
      const scan = scanCommand(install.command, install.args);
      if (scan.errors.length > 0) {
        errors.push(atEntry(at, scan.errors[0]));
        return;
      }
      const variables = readVariables(install.env, 'env');
      if (variables.problems.length > 0) {
        errors.push(atEntry(at, variables.problems[0]));
        return;
      }
      normalized.local = {
        kind,
        command: String(install.command).trim(),
        args: Array.isArray(install.args) ? install.args.map(String) : [],
        env: variables.items,
      };
      entryWarnings.push(...scan.warnings);
    } else {
      if (!isText(install.url)) {
        errors.push(`${at}缺 install.url`);
        return;
      }
      const url = String(install.url).trim();
      if (!/^https?:\/\//i.test(url)) {
        errors.push(`${at}的 install.url 必须是 http/https 地址（收到 "${url}"）`);
        return;
      }
      const variables = readVariables(install.headers, 'headers');
      if (variables.problems.length > 0) {
        errors.push(atEntry(at, variables.problems[0]));
        return;
      }
      normalized.local = { kind, url, headers: variables.items };
    }

    normalized.warning = entryWarnings.length > 0;
    normalized.warningReasons = entryWarnings;
    if (entryWarnings.length > 0) warnings.push(`${at}：${entryWarnings.join('；')}`);
    seen.set(normalized.name, index + 1);
    entries.push(normalized);
  });

  return { entries, errors, warnings };
}

/**
 * Read and normalize the local file, cached by `mtimeMs` + size.
 *
 * Editing the JSON takes effect on the next catalog read — no restart — and an unchanged
 * file is not re-validated on every search.
 *
 * @param path - the file to read.
 * @returns `{entries, errors, warnings, present, stamp}`.
 */
export function readLocalEntries(path) {
  if (!existsSync(path)) {
    return { entries: [], errors: [], warnings: [], present: false, stamp: '' };
  }
  let stamp = '';
  try {
    const info = statSync(path);
    // mtime alone can repeat within a filesystem's timestamp granularity; size closes most
    // of that gap, and both together are what the cache is keyed on.
    stamp = `${info.mtimeMs}:${info.size}`;
  } catch (error) {
    return { entries: [], errors: [`读取失败：${String((error && error.message) || error)}`], warnings: [], present: true, stamp: '' };
  }
  if (cache.stamp === stamp) return { ...cache.value, present: true, stamp };
  let document;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const value = { entries: [], errors: [`JSON 解析失败：${String((error && error.message) || error)}`], warnings: [] };
    cache.stamp = stamp;
    cache.value = value;
    return { ...value, present: true, stamp };
  }
  const value = validateLocalEntries(document);
  cache.stamp = stamp;
  cache.value = value;
  return { ...value, present: true, stamp };
}

/** The one-entry memo behind {@link readLocalEntries}. */
const cache = { stamp: '', value: { entries: [], errors: [], warnings: [] } };

/** Forget the memo (tests, and a deliberate reload). */
export function resetLocalCache() {
  cache.stamp = '';
  cache.value = { entries: [], errors: [], warnings: [] };
}

/** The default file location, beside the registry snapshot. */
export function localEntriesPath(cacheDir) {
  return join(cacheDir, 'local-entries.json');
}
