/**
 * Reading the core's diff back into lines to draw.
 *
 * The diff itself is the core's and is tested there. What can be wrong here is the *reading* of it,
 * and it can be wrong quietly: a hunk read one line short drops the end of the change and shows a
 * save that did less than it did. Every case below goes through the real `make_diff`, because the
 * only format worth parsing is the one the app will actually be handed.
 */
import './support/core';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { changesBetween, parseDiff } from '../src/services/diff';

/** The kinds and texts of every line, flattened - what a reader would see, in order. */
function drawn(previous: string, current: string): string[] {
  return changesBetween(previous, current).hunks.flatMap((hunk) =>
    hunk.lines.map((line) => `${line.kind[0]} ${line.text}`),
  );
}

test('identical text is no change at all', () => {
  const diff = changesBetween('one\ntwo\n', 'one\ntwo\n');
  assert.deepEqual(diff.hunks, []);
  assert.equal(diff.added, 0);
  assert.equal(diff.removed, 0);
});

test('a changed line is one removed and one added, in place', () => {
  assert.deepEqual(drawn('one\ntwo\nthree\n', 'one\nTWO\nthree\n'), [
    'c one',
    'r two',
    'a TWO',
    'c three',
  ]);

  const diff = changesBetween('one\ntwo\nthree\n', 'one\nTWO\nthree\n');
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
});

test('lines are numbered on the side they belong to', () => {
  const [hunk] = changesBetween('one\ntwo\nthree\n', 'one\nTWO\nthree\n').hunks;

  assert.deepEqual(
    hunk.lines.map((line) => [line.kind, line.oldLine, line.newLine]),
    [
      ['context', 1, 1],
      ['remove', 2, null],
      ['add', null, 2],
      ['context', 3, 3],
    ],
  );
});

test('a blank unchanged line is context, not the end of the hunk', () => {
  // diffy formats a blank context line with no leading space at all. Read as an unknown prefix it
  // would end the hunk early and everything after it would silently vanish from the diff.
  assert.deepEqual(drawn('a\n\nb\n', 'a\n\nB\n'), ['c a', 'c ', 'r b', 'a B']);
});

test('a blank line that was added is still an added line', () => {
  assert.deepEqual(drawn('a\nb\n', 'a\n\nb\n'), ['c a', 'a ', 'c b']);
});

test('a line of the note that reads like a hunk header is content', () => {
  // A note about diffs is a note people write. Hunks are read by counting the lines the header
  // promises, so this is content rather than the start of another hunk.
  const lines = drawn('notes\n', 'notes\n@@ -1 +1 @@\n');
  assert.deepEqual(lines, ['c notes', 'a @@ -1 +1 @@']);
});

test('a line of the note that reads like a diff line is content', () => {
  assert.deepEqual(drawn('x\n', 'x\n- a bullet\n+ another\n'), [
    'c x',
    'a - a bullet',
    'a + another',
  ]);
});

test('text with no trailing newline is read whole', () => {
  // The core pads sides during a merge but an ordinary note is whatever was typed, so almost every
  // diff this app makes ends without a newline and carries diffy's marker for it.
  const diff = changesBetween('one\ntwo', 'one\nTWO');
  const last = diff.hunks[0].lines[diff.hunks[0].lines.length - 1];

  assert.deepEqual(drawn('one\ntwo', 'one\nTWO'), ['c one', 'r two', 'a TWO']);
  assert.equal(last.text, 'TWO');
  assert.equal(last.noNewline, true);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
});

test('a note that says it has no newline at the end is content', () => {
  const marker = '\\ No newline at end of file';
  assert.deepEqual(drawn('x\n', `x\n${marker}\n`), ['c x', `a ${marker}`]);
});

test('everything added, and everything removed', () => {
  assert.deepEqual(drawn('', 'one\ntwo\n'), ['a one', 'a two']);
  assert.deepEqual(drawn('one\ntwo\n', ''), ['r one', 'r two']);
});

test('two changes far apart are two hunks', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const edited = lines.replace('line 0', 'first').replace('line 39', 'last');
  const diff = changesBetween(lines, edited);

  assert.equal(diff.hunks.length, 2);
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 2);
  assert.ok(diff.hunks[0].newStart < diff.hunks[1].newStart);
});

test('the header binding a stored diff to its base is skipped', () => {
  // A stored payload is the unified diff with `serblenotes-diff-v1 <fingerprint>` in front of it,
  // and the history panel may one day be handed one directly.
  const patch = '@@ -1 +1 @@\n-a\n+b\n';
  assert.deepEqual(
    parseDiff(`serblenotes-diff-v1 abc123\n--- original\n+++ modified\n${patch}`).hunks,
    parseDiff(patch).hunks,
  );
});

test('a payload that is not a diff reads as nothing rather than as a change', () => {
  assert.deepEqual(parseDiff(''), { hunks: [], added: 0, removed: 0 });
  assert.deepEqual(parseDiff('this is not a diff at all\n'), {
    hunks: [],
    added: 0,
    removed: 0,
  });
});

test('a truncated hunk stops at what is there', () => {
  // The header promises three lines and two arrive. Reading past the end would be reading whatever
  // came next as though it were part of the change.
  const diff = parseDiff('@@ -1,3 +1,3 @@\n a\n-b\n');
  assert.equal(diff.hunks.length, 1);
  assert.equal(diff.hunks[0].lines.length, 2);
  assert.equal(diff.removed, 1);
});
