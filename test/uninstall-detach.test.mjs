// Leaving a profile, without taking anyone else's bundle with it.
//
// Detaching is this profile's business: it removes one profile's dependency and nothing else.
// Whether the bytes may go is a different question, answered by who else loads them — and this
// round does not delete them at all, so a profile leaving cannot damage a shared bundle.
//
// Two protections still matter here. A bundle the dsh installation itself provides is not a
// profile's to remove, and a profile whose own state cannot be established is not detached on
// trust.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'mcpm-detach-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const market = await import('../market.js');
const host = await import('../index.js');

const ENTRY = 'vendor.example/notes';
const PROFILES = join(home, '.dsh', 'profiles');
const slug = market.slugFor(ENTRY);
const pkg = market.BUNDLE_PREFIX + slug;
const rowId = market.rowIdForSlug(slug);
const bundleDir = () => market.bundleDir(slug);
const anchorPath = () => join(home, 'app', 'package.json');
const profileManifest = (name) => JSON.parse(readFileSync(join(PROFILES, name, 'package.json'), 'utf8'));

beforeEach(() => {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  market.resetCatalog();
});

const post = (payload) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
const call = async (routes, path, payload) => {
  const response = await routes.get(path).fetch(new Request('http://local' + path, post(payload)));
  return { status: response.status, body: await response.json() };
};

function fingerprint(root) {
  const out = {};
  const walk = (current) => {
    let names;
    try { names = readdirSync(current); } catch { return; }
    for (const name of names) {
      const full = join(current, name);
      const key = relative(root, full).split('\\').join('/');
      let info;
      try { info = lstatSync(full); } catch { out[key] = 'vanished'; continue; }
      if (info.isSymbolicLink()) out[key] = 'link:' + String(readlinkSync(full));
      else if (info.isDirectory()) { out[key] = 'dir'; walk(full); }
      else out[key] = 'file:' + readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return out;
}

/** A profile that declares the bundle, the way the real one does. */
function writeProfile(name, { declares = true } = {}) {
  const dir = join(PROFILES, name);
  mkdirSync(join(dir, 'node_modules', market.BUNDLE_PREFIX), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-' + name,
    dependencies: declares ? { [pkg]: '1.0.0' } : {},
    dsh: { profile: { bundles: declares ? [pkg] : [] } },
  }, null, 2), 'utf8');
  return dir;
}

/** The bundle on disk, as an install would have left it. */
function writeBundle() {
  mkdirSync(bundleDir(), { recursive: true });
  writeFileSync(join(bundleDir(), 'package.json'), JSON.stringify({ name: pkg, version: '1.0.0' }, null, 2), 'utf8');
  writeFileSync(join(bundleDir(), 'cordis.patch.yml'), '# patch\n', 'utf8');
  writeFileSync(join(bundleDir(), 'market.meta.json'), JSON.stringify({ slug, pkg, rowId, txid: 'tx-1' }, null, 2), 'utf8');
}

/** The dsh installation's own package.json: what the app provides. */
function writeAnchor(dependencies, raw = null) {
  mkdirSync(join(home, 'app'), { recursive: true });
  writeFileSync(anchorPath(), raw === null ? JSON.stringify({ name: 'dsh-app', dependencies }, null, 2) : raw, 'utf8');
}

/** A removal that behaves the way the official one does, including rewriting this profile. */
function removeFrom(name) {
  const path = join(PROFILES, name, 'package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  delete manifest.dependencies[pkg];
  manifest.dsh.profile.bundles = (manifest.dsh.profile.bundles || []).filter((item) => item !== pkg);
  writeFileSync(path, JSON.stringify(manifest, null, 2), 'utf8');
}

function makeCtx(options = {}) {
  const profile = options.profile || 'desktop';
  const routes = new Map();
  const ctx = {
    get(key) {
      if (key === 'connection') return { fetch: { register(spec) { routes.set(spec.path, spec); } } };
      if (key === 'profileContext') {
        return { name: profile, dir: join(PROFILES, profile), installAnchor: options.anchor === false ? undefined : anchorPath() };
      }
      if (key === 'pluginManager') {
        return {
          async removeBundle() {
            if (options.throws === true) throw new Error('the installer refused');
            if (options.removeResult !== undefined) {
              if (options.partial === true) {
                const path = join(PROFILES, profile, 'package.json');
                const manifest = JSON.parse(readFileSync(path, 'utf8'));
                manifest.dsh.profile.bundles = [];
                writeFileSync(path, JSON.stringify(manifest, null, 2), 'utf8');
              }
              return options.removeResult;
            }
            removeFrom(profile);
            return { application: 'applied' };
          },
          listBundles() { return [{ name: pkg, installed: true, enabled: true, removable: true, rows: [{ rowId, moduleName: host.MCP_MODULE }] }]; },
        };
      }
      if (key === 'configEditor') return { configuration() { return []; } };
      return undefined;
    },
  };
  host.apply(ctx);
  return routes;
}

const uninstall = (routes) => call(routes, host.MARKET_UNINSTALL_PATH, { slug });

test('[contract] a bundle the dsh installation provides is not removed by a profile', async () => {
  writeProfile('desktop');
  writeBundle();
  writeAnchor({ [pkg]: '1.0.0' });
  const routes = makeCtx();
  const before = fingerprint(join(bundleDir(), '..'));

  const refused = await uninstall(routes);

  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(String(refused.body.error.code).includes('not-removable'), true, JSON.stringify(refused.body.error));
  assert.equal(existsSync(bundleDir()), true, 'the bundle directory is untouched');
  assert.deepEqual(profileManifest('desktop').dsh.profile.bundles, [pkg], 'and the profile still declares it');
  assert.equal(fingerprint(join(bundleDir(), '..'))[slug].includes('dir'), true, before === undefined ? '' : '');
});

test('[contract] a bundle whose installation record cannot be read is left alone', async () => {
  writeProfile('desktop');
  writeBundle();
  writeAnchor({}, 'not json at all');
  const routes = makeCtx();

  const refused = await uninstall(routes);

  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(existsSync(bundleDir()), true, 'the physical bundle is kept');
  assert.deepEqual(profileManifest('desktop').dsh.profile.bundles, [pkg], 'and the profile still declares it');
});

test('[contract] a profile detaches its own dependency and keeps the physical bundle', async () => {
  writeProfile('desktop');
  writeBundle();
  writeAnchor({});
  const routes = makeCtx();

  const done = await uninstall(routes);

  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.value.detached, true);
  assert.equal(done.body.value.bundleKept, true, 'this round does not delete the bundle');
  assert.equal(done.body.value.deleted, false);
  assert.deepEqual(profileManifest('desktop').dsh.profile.bundles, [], 'the profile no longer loads it');
  assert.deepEqual(Object.keys(profileManifest('desktop').dependencies), [], 'and no longer depends on it');
  assert.equal(existsSync(bundleDir()), true, 'while the bundle itself is still there');
  assert.equal(readFileSync(join(bundleDir(), 'cordis.patch.yml'), 'utf8'), '# patch\n', 'byte for byte');
});

test('[contract] another profile that shares the bundle is not touched', async () => {
  writeProfile('desktop');
  writeProfile('laptop');
  writeBundle();
  writeAnchor({});
  const routes = makeCtx();
  const before = fingerprint(join(PROFILES, 'laptop'));

  const done = await uninstall(routes);

  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.value.bundleKept, true);
  assert.deepEqual(fingerprint(join(PROFILES, 'laptop')), before, 'the other profile is exactly as it was');
  assert.equal(existsSync(bundleDir()), true);
  assert.equal(done.body.value.others.length >= 1, true, 'and the answer says who else is still reading it');
});

test('[contract] a removal the installer did not carry out is not reported as done', async () => {
  const cases = [
    ['failed', { removeResult: { application: 'failed' } }],
    ['cancelled', { removeResult: { application: 'cancelled' } }],
    ['threw', { throws: true }],
    ['partial', { removeResult: { application: 'applied' }, partial: true }],
  ];
  for (const [what, options] of cases) {
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    writeProfile('desktop');
    writeBundle();
    writeAnchor({});
    const routes = makeCtx(options);

    const answer = await uninstall(routes);

    assert.notEqual(answer.status, 200, what + ': ' + JSON.stringify(answer.body));
    assert.equal(answer.body.value === undefined || answer.body.value.detached !== true, true, what);
    assert.equal(existsSync(bundleDir()), true, what + ': the bundle is still there');
  }
});

test('[contract] a profile whose own state cannot be established is not detached on trust', async () => {
  writeProfile('desktop');
  writeBundle();
  writeAnchor({});
  const routes = makeCtx({ anchor: false });
  const before = fingerprint(bundleDir());

  const answer = await uninstall(routes);

  assert.equal(answer.status, 409, JSON.stringify(answer.body));
  assert.equal(answer.body.error.code, 'uninstall-references-unknown');
  assert.equal(existsSync(bundleDir()), true, 'the physical directory is kept');
  assert.deepEqual(fingerprint(bundleDir()), before, 'byte for byte');
  assert.deepEqual(profileManifest('desktop').dsh.profile.bundles, [pkg], 'and the profile is untouched');
});

test('[contract] a refusal carries the manager\'s own reason instead of one word', async () => {
  writeProfile('desktop');
  writeBundle();
  writeAnchor({});
  // A bundle that is loaded cannot be unloaded without a restart, and the host says so in code:
  // the caller has to be told which of the possible refusals this was.
  const routes = makeCtx({ removeResult: { application: 'failed', error: { code: 'restart-required', diagnostic: 'the bundle is started' } } });

  const refused = await uninstall(routes);

  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, 'uninstall-needs-restart');
  assert.equal(refused.body.error.managerCode, 'restart-required', 'the manager\'s code survives');
  assert.equal(refused.body.error.diagnostic, 'the bundle is started');
  assert.equal(JSON.stringify(refused.body).includes('install-failed'), false, 'and nothing calls this an install');
  assert.equal(existsSync(bundleDir()), true, 'the bundle is untouched');
  assert.deepEqual(profileManifest('desktop').dsh.profile.bundles, [pkg], 'and so is the profile');
});
