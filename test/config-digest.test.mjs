// The configuration summary: what it has to tell apart, and what it must stay blind to.
//
// Two kinds of case live here, and they are labelled differently on purpose:
//
//   [v1-behaviour]  the digest that is already shipped, measured. These pin what version 1 can and
//                   cannot distinguish. They pass on the current tree — that is the point: they are
//                   the evidence that version 2 is needed, not a fix.
//   [contract]      the version 2 summary, which does not exist yet. These fail until it does. A
//                   failure caused by a function that is not there is a missing capability, not a
//                   regression, and it is not claimed as one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'mcpm-digest-'));
process.env.HOME = process.env.USERPROFILE;
const tx = await import('../tx.js');

const NUL = String.fromCharCode(0);
const summary = (input) => tx.configSummaryOf(input);
const digestOf = (input) => summary(input).digest;
const stdio = (values, extra = {}) => ({ transport: 'stdio', command: 'node', args: ['server.js'], env: values, headers: null, ...extra });

// --- what version 1 cannot do, measured on the code that is shipped ------------------------------

test('[v1-behaviour] the same values collide across the two namespaces', () => {
  const values = { API_KEY: 'x' };
  assert.equal(tx.configDigestOf(values), tx.configDigestOf({ API_KEY: 'x' }),
    'version 1 hashes the values alone, so it cannot see which namespace they came from');
});

test('[v1-behaviour] a missing value and the text that names it collide', () => {
  assert.equal(tx.configDigestOf({ A: undefined }), tx.configDigestOf({ A: 'undefined' }),
    'version 1 stringifies, so absence and the word for it are one input');
});

test('[v1-behaviour] nothing about how the server starts can even reach version 1', () => {
  // Structural, not incidental: the function takes one argument, the values. There is no parameter
  // through which a transport, a command or an argument could arrive.
  assert.equal(tx.configDigestOf.length, 1);
  assert.equal(tx.configDigestOf({ A: 'x' }).length, 64);
});

test('[v1-behaviour] version 1 keeps working, because callers still use it', () => {
  assert.equal(typeof tx.configDigestOf, 'function');
  assert.equal(tx.configDigestOf({ B: 'y', A: 'x' }), tx.configDigestOf({ A: 'x', B: 'y' }), 'key order was never significant');
  assert.equal(tx.configDigestOf({}), tx.configDigestOf({}));
});

// --- what version 2 has to do -------------------------------------------------------------------

test('[contract] the version is part of the summary', () => {
  const one = summary(stdio({ API_KEY: 'x' }));
  assert.equal(one.version, tx.CONFIG_DIGEST_VERSION);
  assert.equal(tx.CONFIG_DIGEST_VERSION, 2);
  assert.equal(one.namespace, 'env');
  assert.equal(one.digest.length, 64);
});

test('[contract] the two namespaces cannot be exchanged', () => {
  assert.notEqual(digestOf({ transport: 'stdio', command: 'node', args: [], env: { a: 'x' }, headers: null }),
    digestOf({ transport: 'stdio', command: 'node', args: [], env: null, headers: { a: 'x' } }));
  assert.equal(summary({ env: null, headers: { a: 'x' } }).namespace, 'headers');
  assert.equal(summary({ env: { a: 'x' }, headers: null }).namespace, 'env');
});

test('[contract] the transport, the command and the arguments all change the summary', () => {
  const base = stdio({ API_KEY: 'x' });
  assert.notEqual(digestOf(base), digestOf({ ...base, transport: 'streamable-http', env: null, headers: { api_key: 'x' } }), 'transport');
  assert.notEqual(digestOf(base), digestOf({ ...base, command: 'nodejs' }), 'command');
  assert.notEqual(digestOf(base), digestOf({ ...base, args: ['other.js'] }), 'argument content');
  assert.notEqual(digestOf(base), digestOf({ ...base, args: ['a.js', 'b.js'] }), 'argument count');
  assert.notEqual(digestOf({ ...base, args: ['a.js', 'b.js'] }), digestOf({ ...base, args: ['b.js', 'a.js'] }), 'argument order');
});

test('[contract] header names are folded, environment names are not', () => {
  assert.equal(digestOf({ transport: 'streamable-http', env: null, headers: { Authorization: 'Bearer x' } }),
    digestOf({ transport: 'streamable-http', env: null, headers: { authorization: 'Bearer x' } }),
    'HTTP field names are case-insensitive');
  assert.notEqual(digestOf(stdio({ API_KEY: 'x' })), digestOf(stdio({ api_key: 'x' })),
    'environment variable names are case-sensitive and are kept as written');
  assert.deepEqual(summary({ transport: 'streamable-http', env: null, headers: { Authorization: 'x' } }).configuredKeys, ['authorization']);
});

test('[contract] absence, null, the empty string and other types are all distinct', () => {
  const of = (value) => digestOf(stdio({ A: value }));
  assert.notEqual(of(undefined), of('undefined'), 'absence is not the text that names it');
  assert.notEqual(of(undefined), of(null), 'absence is not an explicit null');
  assert.notEqual(of(undefined), of(''), 'absence is not an empty value');
  assert.notEqual(of(null), of(''), 'null is not an empty value');
  assert.notEqual(of('1'), of(1), 'a string and a number are not the same configuration');
  assert.notEqual(of(true), of('true'), 'a boolean and its spelling are not the same configuration');
  assert.equal(of(undefined), of(undefined), 'and the same input is always the same digest');
});

test('[contract] a value cannot be read as a boundary', () => {
  // Concatenation would merge these two: the first value contains what looks like the next pair.
  const merged = 'x' + NUL + 'B' + NUL + 'y';
  assert.notEqual(digestOf(stdio({ A: 'x', B: 'y' })), digestOf(stdio({ A: merged })),
    'length framing means a value that contains a separator is still one value');
  assert.notEqual(digestOf(stdio({ A: 'x' })), digestOf(stdio({ A: 'x' + NUL })), 'even a trailing NUL is significant');
  assert.notEqual(digestOf(stdio({ A: 'x' })), digestOf(stdio({ ['A' + NUL]: 'x' })), 'a key containing a separator is still one key');
});

test('[contract] the same configuration always gives the same summary', () => {
  const one = stdio({ API_KEY: 'x', OTHER: 'y' }, { args: ['a.js', '--flag'] });
  const two = stdio({ OTHER: 'y', API_KEY: 'x' }, { args: ['a.js', '--flag'] });
  assert.equal(summary(one).digest, summary(two).digest, 'key order in the input is not significant');
  assert.equal(summary(one).digest, summary(one).digest);
  assert.deepEqual(summary(one).configuredKeys, ['API_KEY', 'OTHER']);
});

test('[contract] where the bundle is stored is not part of the configuration', () => {
  const root = mkdtempSync(join(tmpdir(), 'mcpm-move-'));
  const published = join(root, 'bundle');
  const backup = join(root, 'backup');
  mkdirSync(published, { recursive: true });
  const argv = [join(published, 'server.js')];
  const spec = { transport: 'stdio', command: 'node', args: argv, env: { API_KEY: 'x' }, headers: null };
  const written = summary(spec);

  const manifest = JSON.stringify({ name: 'x', version: '1.0.0' }, null, 2);
  const patch = '# patch\n';
  writeFileSync(join(published, 'package.json'), manifest, 'utf8');
  writeFileSync(join(published, 'cordis.patch.yml'), patch, 'utf8');
  writeFileSync(join(published, 'market.meta.json'), JSON.stringify({
    slug: 'x', pkg: 'dsh-mcp-x', txid: 'tx-1', rowId: 'mcp-x',
    renderDigest: tx.digestOf({ 'package.json': manifest, 'cordis.patch.yml': patch }),
    configDigest: written.digest, configDigestVersion: written.version, configNamespace: written.namespace,
  }, null, 2), 'utf8');

  assert.equal(tx.verifyBundleContent(published).matches, true, 'the published directory verifies');
  mkdirSync(dirname(backup), { recursive: true });
  renameSync(published, backup);
  assert.equal(tx.verifyBundleContent(backup).matches, true, 'and it still verifies after the move');
  assert.equal(JSON.parse(readFileSync(join(backup, 'market.meta.json'), 'utf8')).configDigest, written.digest,
    'the recorded summary is the one that was rendered, because a move rewrites nothing');
  assert.equal(digestOf(spec), written.digest, 'and the same inputs still give the same digest');
  rmSync(root, { recursive: true, force: true });
});
