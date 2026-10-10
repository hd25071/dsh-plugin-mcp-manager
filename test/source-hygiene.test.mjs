// A regression guard for a bug class that has now cost two rounds.
//
// A scripted replacement once put a literal backslash-n where a line break was meant. Inside a
// string or a template literal that is a legitimate escape. In a comment it is not an escape at
// all — the rest of the line becomes comment text. That is how one assignment in the install
// route (`mcpbInfo = ...`) and one assertion in `mcpb-routes.test.mjs` silently disappeared: the
// install still returned 200, it just stopped writing its audit record.
//
// The rule enforced here is deliberately the narrow one. An escape after `//` on the same line is
// always text, so it is always a mistake. The wider rule — "an escape followed by indentation" —
// also matches a legitimate multi-line template literal, so it is not enforced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const BACKSLASH = String.fromCharCode(92);
const ESCAPES = ['n', 't', 'r'].map((letter) => BACKSLASH + letter);
const SKIP = new Set(['node_modules', '.git']);
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

function sourceFiles(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (EXTENSIONS.has(extname(entry))) found.push(full);
  }
  return found;
}

test('no backslash escape is buried in a comment, where it is text rather than an escape', () => {
  const offenders = [];
  for (const file of sourceFiles(root)) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const escape of ESCAPES) {
        let at = line.indexOf(escape);
        while (at >= 0) {
          const previous = at === 0 ? '' : line[at - 1];
          const comment = line.lastIndexOf('//', at);
          // An escaped backslash is a path, not an escape sequence; and a `//` inside a string
          // is not a comment, so quotes in between mean this match proves nothing.
          const isEscapedBackslash = previous === BACKSLASH;
          const quoted = comment >= 0 && /["'`]/.test(line.slice(comment, at));
          if (!isEscapedBackslash && comment >= 0 && !quoted) {
            offenders.push(`${file.slice(root.length)}:${index + 1}: ${line.trim().slice(0, 120)}`);
          }
          at = line.indexOf(escape, at + 1);
        }
      }
    });
  }
  assert.deepEqual(offenders, [], 'a backslash escape in a comment swallows every statement after it on that line');
});

// The same class of mistake one level up: a module the runtime imports but the manifest does not
// ship. `mcpb.js` and `local.js` were both missing from `files`, which surfaces only as
// ERR_MODULE_NOT_FOUND after a `files`-respecting install — long after the tests went green.
test('every module the runtime imports is listed in the package manifest', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const shipped = new Set(manifest.files);
  const missing = [];
  for (const file of manifest.files.filter((name) => name.endsWith('.js'))) {
    const source = readFileSync(join(root, file), 'utf8');
    for (const match of source.matchAll(/from '(\.[^']+)'/g)) {
      const target = match[1].replace(/^\.\//, '');
      if (!shipped.has(target)) missing.push(`${file} imports ${target}`);
    }
  }
  assert.deepEqual(missing, [], 'a shipped module imports a file the manifest does not ship');
});
