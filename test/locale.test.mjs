// The panel speaks two languages, and this checks the two ways that can go wrong quietly.
//
// A missing entry does not crash: the Chinese string is shown instead, in English mode, and nobody
// notices until a person reading English sees a line of Chinese. And an entry for a string the code
// compares rather than shows would change behaviour the moment the language changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const start = source.indexOf('const EN = {');
assert.notEqual(start, -1, 'the client must carry a translation table');
const end = source.indexOf('\n};', start);
const table = new Function('return (' + source.slice(start + 'const EN = '.length, end + 2) + ')')();
const keys = Object.keys(table);
const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The table itself spells every key as `'key':` and would make every string look like one, so the
// questions below are asked of the file without it.
const body = source.slice(0, start) + source.slice(end + 3);
const literal = (text) => new RegExp("L\\(" + "'" + esc(text) + "'\\)").test(body);
const compared = (text) => new RegExp("(===|!==|case)\\s*'" + esc(text) + "'").test(body);
const asKey = (text) => new RegExp("(^|[{,])\\s*'" + esc(text) + "'\\s*:", 'm').test(body);

test('every entry is a Chinese string with an English translation', () => {
  assert.equal(keys.length > 100, true, 'a panel this size has more than a hundred strings: ' + keys.length);
  for (const key of keys) {
    assert.match(key, /[\u4e00-\u9fff]/, 'the key must be the Chinese string: ' + key);
    assert.doesNotMatch(table[key], /[\u4e00-\u9fff]/, 'the translation must not still be Chinese: ' + key + ' -> ' + table[key]);
    assert.notEqual(table[key].trim(), '', 'a translation must not be empty: ' + key);
  }
});

test('every shown string is translated, and nothing compared is', () => {
  for (const key of keys) {
    // Shown strings have to be reached by the wrapper; a string the code compares or uses as a key
    // must not be wrapped at all, or English mode would change what the code decides.
    if (compared(key) || asKey(key)) {
      assert.doesNotMatch(source, new RegExp("L\\(" + "'" + esc(key) + "'\\)"), 'a compared string must not be translated: ' + key);
    } else {
      assert.equal(literal(key), true, 'a table entry nobody shows is dead weight: ' + key);
    }
  }
});

test('the switch itself is wired to both languages', () => {
  assert.match(source, /setLocale\(localeNow\(\) === 'en' \? 'zh' : 'en'\)/, 'the button must flip the language');
  assert.match(source, /localStorage\.getItem\(MCPM_LOCALE_KEY\) === 'en'/, 'the choice must be read back');
  assert.match(source, /localStorage\.setItem\(MCPM_LOCALE_KEY/, 'and written down');
});
