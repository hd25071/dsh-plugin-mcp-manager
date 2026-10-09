// mcpb: probing, downloading and extracting, and turning a manifest into a command line.
//
// The download is exercised with real archives built by the system tar and a stubbed fetch, so
// extraction, the manifest read and the zip-slip check all run for real.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mcpb = await import('file:///D:/dshtools/dsh-plugin-mcp-manager/mcpb.js');

const work = mkdtempSync(join(tmpdir(), 'mcpb-test-'));
const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const locate = (name) => (name === 'node' ? 'C:\\Program Files\\nodejs\\node.exe' : (name === 'uv' ? 'C:\\uv\\uv.exe' : ''));
const runtimes = { uvx: { available: true } };
const opts = { locate, runtimes, nodeVersion: '24.21.0', uvVersion: '0.12.24' };

/** Build a real .mcpb (a zip) from a manifest and a file list. */
function buildPackage(name, manifest, files = { 'server/index.js': 'console.log(1);' }) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  if (manifest !== null) writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  const zip = join(work, `${name}.mcpb`);
  execFileSync(tar, ['-a', '-c', '-f', zip, '-C', dir, '.'], { stdio: 'ignore' });
  return readFileSync(zip);
}

/** A fetch that answers with fixed bytes, or a status. */
const fakeFetch = (bytes, status = 200) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

const nodeManifest = {
  manifest_version: 0.3,
  name: 'demo', version: '1.0.0',
  server: {
    type: 'node', entry_point: 'server/index.js',
    mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'], env: { SITE: '${user_config.api_base}' } },
  },
  user_config: { api_base: { type: 'string', description: 'where to read', required: false, default: '' } },
  compatibility: { platforms: ['darwin', 'win32', 'linux'], runtimes: { node: '>=20.0.0' } },
};

after(() => rmSync(work, { recursive: true, force: true }));

test('probeMcpb refuses an identifier that is not an https URL', () => {
  assert.equal(mcpb.probeMcpb({ identifier: 'C:\\local\\a.mcpb' }).ok, false);
  assert.equal(mcpb.probeMcpb({ identifier: 'ftp://x/a.mcpb' }).ok, false);
  assert.equal(mcpb.probeMcpb({}).ok, false);
  assert.equal(mcpb.probeMcpb({ identifier: 'https://x.test/a.mcpb', version: '1.0.0' }).ok, true);
});

test('the archive check refuses parent, absolute and drive-letter entries', () => {
  const unsafe = mcpb.unsafeArchiveEntries(['manifest.json', './server/index.js', '../evil.sh', '/abs.sh', 'C:\\x.sh', 'a/../../b']);
  assert.deepEqual(unsafe, ['../evil.sh', '/abs.sh', 'C:\\x.sh', 'a/../../b']);
  assert.deepEqual(mcpb.unsafeArchiveEntries(['manifest.json', 'server/index.js']), []);
});

test('downloadAndExtract reads the manifest of a real package', async () => {
  const bytes = buildPackage('good', nodeManifest);
  const target = join(work, 'out-good');
  const result = await mcpb.downloadAndExtract('https://x.test/good.mcpb', target, { fetchImpl: fakeFetch(bytes) });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.manifest.name, 'demo');
  assert.equal(result.entries.length > 0, true);
  assert.equal(existsSync(join(result.extractedDir, 'manifest.json')), true);
});

test('downloadAndExtract reports a failed download with its status', async () => {
  const result = await mcpb.downloadAndExtract('https://x.test/missing.mcpb', join(work, 'out-404'), {
    fetchImpl: fakeFetch(Buffer.from(''), 404),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /HTTP 404/);
});

test('downloadAndExtract refuses a package with no manifest', async () => {
  const bytes = buildPackage('nomanifest', null, { 'server/index.js': 'x' });
  const result = await mcpb.downloadAndExtract('https://x.test/n.mcpb', join(work, 'out-nm'), { fetchImpl: fakeFetch(bytes) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /manifest\.json/);
});

test('manifestToPlan refuses a manifest older than 0.2', () => {
  const result = mcpb.manifestToPlan({ ...nodeManifest, manifest_version: 0.1 }, 'X', {}, opts);
  assert.equal(result.ok, false);
  assert.match(result.reason, /manifest_version/);
});

test('manifestToPlan refuses a server type it cannot run', () => {
  const python = mcpb.manifestToPlan({ ...nodeManifest, server: { ...nodeManifest.server, type: 'python' } }, 'X', {}, opts);
  assert.equal(python.ok, false);
  assert.match(python.reason, /python mcpb 的依赖安装暂不支持/);
  const other = mcpb.manifestToPlan({ ...nodeManifest, server: { ...nodeManifest.server, type: 'ruby' } }, 'X', {}, opts);
  assert.equal(other.ok, false);
  assert.match(other.reason, /不支持的 mcpb 类型/);
});

test('manifestToPlan refuses a package that does not support Windows', () => {
  const result = mcpb.manifestToPlan({ ...nodeManifest, compatibility: { platforms: ['darwin'] } }, 'X', {}, opts);
  assert.equal(result.ok, false);
  assert.match(result.reason, /不支持 Windows/);
});

test('manifestToPlan refuses a Node version this machine does not have', () => {
  const result = mcpb.manifestToPlan(
    { ...nodeManifest, compatibility: { platforms: ['win32'], runtimes: { node: '>=99.0.0' } } }, 'X', {}, opts);
  assert.equal(result.ok, false);
  assert.match(result.reason, /需要 Node >=99\.0\.0/);
});

test('manifestToPlan refuses a uv package when uv is missing', () => {
  const uvManifest = {
    manifest_version: 0.4,
    server: { type: 'uv', mcp_config: { command: 'uv', args: ['run', '--directory', '${__dirname}', 'python', '-m', 'x'] } },
    compatibility: { platforms: ['win32'], runtimes: { python: '>=3.11' } },
  };
  const missing = mcpb.manifestToPlan(uvManifest, 'X', {}, { locate, runtimes: { uvx: { available: false } }, nodeVersion: '24' });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /没有找到 uv/);
  const present = mcpb.manifestToPlan(uvManifest, 'X', {}, opts);
  assert.equal(present.ok, true, present.reason);
});

test('manifestToPlan substitutes ${__dirname} with a platform separator', () => {
  const result = mcpb.manifestToPlan(nodeManifest, 'C:\\bundle\\extracted', {}, opts);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.args[0].startsWith('C:\\bundle\\extracted'), true);
  assert.equal(result.args[0].includes('/server'), false, 'no mixed separator right after the placeholder');
});

test('manifestToPlan substitutes ${/} with the platform separator', () => {
  const manifest = {
    manifest_version: 0.3,
    server: { type: 'node', mcp_config: { command: 'node', args: ['x'], env: { LOG: '${user_config.dir}${/}audit.jsonl' } } },
    user_config: { dir: { required: true } },
    compatibility: { platforms: ['win32'] },
  };
  const result = mcpb.manifestToPlan(manifest, 'X', { dir: 'D:\\ws' }, opts);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.env.LOG, `D:\\ws${process.platform === 'win32' ? '\\' : '/'}audit.jsonl`);
});

test('manifestToPlan substitutes ${user_config.x}, and blanks an unfilled optional field', () => {
  const filled = mcpb.manifestToPlan(nodeManifest, 'X', { api_base: 'https://site.test' }, opts);
  assert.equal(filled.env.SITE, 'https://site.test');
  const blank = mcpb.manifestToPlan(nodeManifest, 'X', {}, opts);
  assert.equal(blank.env.SITE, '', 'blank means blank, not the literal placeholder');
});

test('manifestToPlan turns a placeholder command into a required absolute path', () => {
  const manifest = {
    manifest_version: 0.3,
    server: { type: 'binary', mcp_config: { command: '${user_config.bin}', args: ['mcp'], env: {} } },
    user_config: { bin: { required: true } },
    compatibility: { platforms: ['win32'] },
  };
  const missing = mcpb.manifestToPlan(manifest, 'X', {}, opts);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /需要先填写 bin/);
  const relative = mcpb.manifestToPlan(manifest, 'X', { bin: 'covdbg.exe' }, opts);
  assert.equal(relative.ok, false);
  assert.match(relative.reason, /必须是绝对路径/);
  const absolute = mcpb.manifestToPlan(manifest, 'X', { bin: 'D:\\tools\\covdbg.exe' }, opts);
  assert.equal(absolute.ok, true, absolute.reason);
  assert.equal(absolute.command, 'D:\\tools\\covdbg.exe');
  assert.equal(absolute.warnings.length > 0, true, 'and it says the path is the user\'s to trust');
});

test('manifestToPlan maps user_config onto the form schema', () => {
  const manifest = {
    manifest_version: 0.3,
    server: { type: 'node', mcp_config: { command: 'node', args: ['x'], env: { TOKEN: '${user_config.token}' } } },
    user_config: { token: { description: 'api token', required: true, sensitive: true, default: '' } },
    compatibility: { platforms: ['win32'] },
  };
  const result = mcpb.manifestToPlan(manifest, 'X', {}, opts);
  assert.deepEqual(result.variables, [{ name: 'token', description: 'api token', isRequired: true, isSecret: true, default: '' }]);
});

test('manifestToPlan refuses a command that cannot be located', () => {
  const manifest = {
    manifest_version: 0.3,
    server: { type: 'node', mcp_config: { command: 'definitely-not-here', args: [], env: {} } },
    compatibility: { platforms: ['win32'] },
  };
  const result = mcpb.manifestToPlan(manifest, 'X', {}, opts);
  assert.equal(result.ok, false);
  assert.match(result.reason, /找不到可执行程序/);
});
