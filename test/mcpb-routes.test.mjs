// mcpb through the install route.
//
// These are the cases that catch what unit tests cannot: a missing import, an assignment to a
// const, a helper that is never called. Both bugs found in the running app were of that shape,
// and each one cost a restart and a click to discover.
//
// The download is a real zip built by tar; only `fetch` is stubbed, and it is stubbed globally
// so the production path is the one under test.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'mcpm-mcpb-routes-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const market = await import('file:///D:/dshtools/dsh-plugin-mcp-manager/market.js');
const host = await import('file:///D:/dshtools/dsh-plugin-mcp-manager/index.js');

const work = mkdtempSync(join(tmpdir(), 'mcpm-mcpb-zips-'));
const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const realFetch = globalThis.fetch;

/** A real .mcpb: a zip with a manifest and a server file. */
function buildPackage(name, manifest) {
  const dir = join(work, name);
  mkdirSync(join(dir, 'server'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, 'server', 'index.js'), 'console.log("mcpb");');
  const zip = join(work, `${name}.mcpb`);
  execFileSync(tar, ['-a', '-c', '-f', zip, '-C', dir, '.'], { stdio: 'ignore' });
  return readFileSync(zip);
}

const manifest = {
  manifest_version: 0.3,
  name: 'demo-mcpb',
  version: '1.0.0',
  server: {
    type: 'node',
    entry_point: 'server/index.js',
    mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'], env: { NOTE: 'from-mcpb' } },
  },
  compatibility: { platforms: ['win32'], runtimes: { node: '>=18.0.0' } },
};

/** One registry entry whose only package is that mcpb. */
function seedRegistry(identifier) {
  mkdirSync(market.CACHE_DIR, { recursive: true });
  writeFileSync(market.CACHE_PATH, JSON.stringify({
    cacheVersion: market.CACHE_VERSION,
    fetchedAt: new Date().toISOString(),
    count: 1,
    servers: [{
      name: 'vendor.example/packed', title: 'Packed', description: 'an mcpb package', version: '1.0.0',
      publishedAt: '2026-01-01T00:00:00Z', remotes: [],
      packages: [{ registryType: 'mcpb', identifier, version: '1.0.0', transport: 'stdio' }],
    }],
  }));
  market.resetCatalog();
}

function makeCtx() {
  const routes = new Map();
  const calls = { install: [] };
  const ctx = {
    get(key) {
      if (key === 'connection') return { fetch: { register(spec) { routes.set(spec.path, spec); } } };
      if (key === 'pluginManager') {
        return { async installBundle(dir, options) { calls.install.push({ dir, options }); return { exitCode: 0 }; } };
      }
      return undefined;
    },
  };
  host.apply(ctx);
  return { routes, calls };
}

const post = (payload) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
const call = async (routes, path, init) => {
  const response = await routes.get(path).fetch(new Request('http://local' + path, init));
  return { status: response.status, body: await response.json() };
};

beforeEach(() => {
  rmSync(join(home, '.dsh'), { recursive: true, force: true });
  globalThis.fetch = realFetch;
});
after(() => {
  globalThis.fetch = realFetch;
  rmSync(work, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

// This case was skipped for one round, with the reason written down: `meta.mcpb.identifier` was
// not the seeded URL. The assertion was right and the product was wrong — the assignment that
// fills `mcpbInfo` had a stray backslash-n in front of it and had become part of a comment, so
// the audit record was never written at all. The skip hid a product bug, not a strict test.
test('installing an mcpb entry downloads, extracts, and writes the manifest command line', async () => {
  const bytes = buildPackage('packed', manifest);
  seedRegistry('https://packages.test/packed.mcpb');
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });

  const { routes, calls } = makeCtx();
  const installed = await call(routes, host.MARKET_INSTALL_PATH, post({ name: 'vendor.example/packed', optionIndex: 0 }));
  assert.equal(installed.status, 200, JSON.stringify(installed.body));

  const slug = installed.body.value.slug;
  const dir = market.bundleDir(slug);
  // The package landed inside the bundle, so uninstalling the bundle removes it too.
  assert.equal(existsSync(join(dir, 'mcpb', 'package.mcpb')), true);
  assert.equal(existsSync(join(dir, 'mcpb', 'extracted', 'manifest.json')), true);

  const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
  const extracted = join(dir, 'mcpb', 'extracted');
  assert.match(patch, /command: ".*node\.exe"/, 'the command is the located node, not the bare name');
  assert.equal(patch.includes('server/index.js'), true);
  // YAML escapes the separators, so compare against the escaped form of the real path instead
  // of a hand-counted number of backslashes.
  const escaped = extracted.replaceAll('\\', '\\\\');
  assert.equal(patch.includes(escaped), true, `the args point into ${extracted}`);
  assert.match(patch, /NOTE: "from-mcpb"/);

  const meta = JSON.parse(readFileSync(join(dir, 'market.meta.json'), 'utf8'));
  assert.equal(meta.mcpb.identifier, 'https://packages.test/packed.mcpb');
  assert.equal(meta.mcpb.bytes > 0, true, JSON.stringify(meta.mcpb));
  assert.equal(Number.isInteger(meta.mcpb.entries) && meta.mcpb.entries > 0, true, 'entries is a count, not the listing');
  assert.equal(meta.mcpb.entryPoint, 'server/index.js');
  assert.deepEqual(calls.install.map((item) => item.dir), [dir], 'the bundle is handed to the installer');
});

test('a failed download returns 400 with the reason, not a bare status', async () => {
  seedRegistry('https://packages.test/missing.mcpb');
  globalThis.fetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });

  const { routes } = makeCtx();
  const result = await call(routes, host.MARKET_INSTALL_PATH, post({ name: 'vendor.example/packed', optionIndex: 0 }));
  assert.equal(result.status, 400);
  assert.equal(result.body.ok, false);
  assert.match(result.body.error.message, /HTTP 404/, 'the UI shows why, not "HTTP 400"');
  assert.equal(market.listInstalled().length, 0, 'and nothing was written');
});

test('a package the manifest rules refuse returns 400 with that reason', async () => {
  // Same download, a manifest this build will not run: darwin-only.
  const bytes = buildPackage('darwin-only', { ...manifest, compatibility: { platforms: ['darwin'] } });
  seedRegistry('https://packages.test/darwin.mcpb');
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });

  const { routes } = makeCtx();
  const result = await call(routes, host.MARKET_INSTALL_PATH, post({ name: 'vendor.example/packed', optionIndex: 0 }));
  assert.equal(result.status, 400);
  assert.match(result.body.error.message, /不支持 Windows/);
  assert.equal(market.listInstalled().length, 0);
});
