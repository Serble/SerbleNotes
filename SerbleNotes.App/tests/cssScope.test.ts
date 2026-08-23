import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prefixSelector, prefixSelectorList, splitSelectors } from '../src/components/cssScope';

/**
 * A note may carry its own CSS, and it may only reach that note. Everything here is about the one
 * failure that would not look like a failure: a selector that comes out unprefixed still works, and
 * what it styles is the app.
 */

const S = '[data-note-css="n1"]';

test('an ordinary selector is confined to the note', () => {
  assert.equal(prefixSelector('p', S), `${S} p`);
  assert.equal(prefixSelector('  .warning strong  ', S), `${S} .warning strong`);
  assert.equal(prefixSelector('*', S), `${S} *`);
});

test('the document means the note', () => {
  assert.equal(prefixSelector(':root', S), S);
  assert.equal(prefixSelector('html', S), S);
  assert.equal(prefixSelector('body', S), S);
  // What follows the name is part of the same compound selector and has to stay attached to it.
  assert.equal(prefixSelector('body.dark', S), `${S}.dark`);
  assert.equal(prefixSelector('body > p', S), `${S} > p`);
});

test('a name that merely starts with one of those is not one of those', () => {
  assert.equal(prefixSelector('bodycopy', S), `${S} bodycopy`);
  assert.equal(prefixSelector('.body', S), `${S} .body`);
});

test('every selector in a list is prefixed, not just the first', () => {
  assert.equal(prefixSelectorList('h1, h2 , h3', S), `${S} h1, ${S} h2, ${S} h3`);
});

test('commas that are not between selectors do not split one', () => {
  assert.deepEqual(splitSelectors(':is(a, b) p'), [':is(a, b) p']);
  assert.deepEqual(splitSelectors('[title="a,b"]'), ['[title="a,b"]']);
  assert.deepEqual(splitSelectors(":nth-child(2n, 1), p"), [':nth-child(2n, 1)', ' p']);
  assert.deepEqual(splitSelectors("[data-x='a\\',b']"), ["[data-x='a\\',b']"]);
});

test('an empty selector cannot escape by being nothing', () => {
  assert.deepEqual(splitSelectors('p, , span'), ['p', ' span']);
  assert.equal(prefixSelector('   ', S), S);
});
