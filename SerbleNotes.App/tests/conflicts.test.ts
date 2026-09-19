/**
 * Reading merge conflicts out of a note, and resolving one.
 *
 * This belongs in the small set of client code that can be *wrong* rather than visibly broken. It
 * rewrites the user's text, and its bugs are the quiet kind: a region parsed one line short takes a
 * line of somebody's prose away with the markers, and a region drawn over an unclosed marker
 * swallows the rest of the note. The widget that draws them is DOM and is not tested here: jsdom
 * goes no further than `tests/support/dom.ts`, and a widget proved against a second-hand DOM is not
 * proved against a browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  documentAfterResolving,
  findConflicts,
  isConflictMarker,
  resolvedText,
} from '../src/components/conflicts.ts';

const OURS = '<<<<<<< ours';
const ORIGINAL = '||||||| original';
const SPLIT = '=======';
const THEIRS = '>>>>>>> theirs';

function conflict(ours: string[], original: string[] | null, theirs: string[]): string {
  return [
    OURS,
    ...ours,
    ...(original === null ? [] : [ORIGINAL, ...original]),
    SPLIT,
    ...theirs,
    THEIRS,
  ].join('\n');
}

// --- finding them ---------------------------------------------------------------------------------

test('a conflict is found with both sides', () => {
  const [found] = findConflicts(conflict(['mine'], ['base'], ['yours']));

  assert.equal(found.ours, 'mine\n');
  assert.equal(found.original, 'base\n');
  assert.equal(found.theirs, 'yours\n');
});

test('the region covers the markers exactly and nothing around them', () => {
  const text = `before\n${conflict(['mine'], null, ['yours'])}\nafter\n`;
  const [found] = findConflicts(text);

  assert.equal(text.slice(0, found.from), 'before\n');
  assert.equal(text.slice(found.to), '\nafter\n');
  assert.equal(text.slice(found.from, found.to), conflict(['mine'], null, ['yours']));
});

test('a merge with no original section still parses', () => {
  const [found] = findConflicts(conflict(['mine'], null, ['yours']));

  assert.equal(found.original, null);
  assert.equal(found.ours, 'mine\n');
  assert.equal(found.theirs, 'yours\n');
});

test('multi-line sides keep every line', () => {
  const [found] = findConflicts(conflict(['one', 'two'], ['base'], ['three', 'four', 'five']));

  assert.equal(found.ours, 'one\ntwo\n');
  assert.equal(found.theirs, 'three\nfour\nfive\n');
});

test('a side that deleted the passage is empty, not a blank line', () => {
  const [found] = findConflicts(conflict([], ['base'], ['yours']));

  assert.equal(found.ours, '', 'empty means this version deleted it');
  assert.notEqual(found.ours, '\n', 'which is not the same as leaving a blank line');
});

test('a side that left a blank line keeps it', () => {
  const [found] = findConflicts(conflict([''], ['base'], ['yours']));

  assert.equal(found.ours, '\n');
});

test('two conflicts in one note are both found, in order', () => {
  const text = `${conflict(['a'], null, ['b'])}\nmiddle\n${conflict(['c'], null, ['d'])}`;
  const found = findConflicts(text);

  assert.equal(found.length, 2);
  assert.equal(found[0].ours, 'a\n');
  assert.equal(found[1].ours, 'c\n');
  assert.ok(found[0].to < found[1].from);
});

// --- conflicts written before the core stopped welding markers on -----------------------------------

/**
 * The shape every note merged by the old core has in it.
 *
 * `diffy` wrote each marker straight after the section before it, so a side whose last line had no
 * trailing newline came out as `aaaaaaa||||||| original`. A parser that only looks at the start of a
 * line reads that as a region which never closes and draws nothing - so the notes that most need
 * the conflict shown as a choice were the ones that got no card at all.
 */
const WELDED = [
  '<<<<<<< ours',
  'aaaaaaa||||||| original',
  '=======',
  'bbbbbbb>>>>>>> theirs',
].join('\n');

test('a conflict with welded markers is still found', () => {
  const found = findConflicts(WELDED);

  assert.equal(found.length, 1);
  assert.equal(found[0].ours, 'aaaaaaa\n');
  assert.equal(found[0].theirs, 'bbbbbbb\n');
});

test('a welded original section is read as the original, not as part of ours', () => {
  const found = findConflicts(
    ['<<<<<<< ours', 'mine||||||| original', 'base=======', 'yours>>>>>>> theirs'].join('\n'),
  );

  assert.equal(found[0].ours, 'mine\n');
  assert.equal(found[0].original, 'base\n');
  assert.equal(found[0].theirs, 'yours\n');
});

test('a welded conflict covers its whole region, closing line included', () => {
  const text = `hello there\n\n${WELDED}\n`;
  const [found] = findConflicts(text);

  assert.equal(text.slice(found.from, found.to), WELDED);
  assert.equal(text.slice(0, found.from), 'hello there\n\n');
});

test('resolving a welded conflict leaves clean text behind', () => {
  const text = `hello there\n\n${WELDED}\n`;
  const [found] = findConflicts(text);

  assert.equal(documentAfterResolving(text, found, 'ours'), 'hello there\n\naaaaaaa\n');
  assert.equal(documentAfterResolving(text, found, 'theirs'), 'hello there\n\nbbbbbbb\n');
  assert.equal(documentAfterResolving(text, found, 'both'), 'hello there\n\naaaaaaa\nbbbbbbb\n');
});

test('a welded conflict is gone once resolved', () => {
  const text = `hello there\n\n${WELDED}\n`;
  const [found] = findConflicts(text);

  for (const choice of ['ours', 'theirs', 'both'] as const) {
    assert.equal(findConflicts(documentAfterResolving(text, found, choice)).length, 0);
  }
});

test('a marker inside prose outside a conflict is left alone', () => {
  // The leniency is only ever applied between an opener and its closer. Out here these are words.
  assert.deepEqual(findConflicts('a line that says ||||||| in passing\n'), []);
  assert.deepEqual(findConflicts('and one that says >>>>>>> too\n'), []);
});

test('a half-welded conflict - some markers on their own lines, some not - still parses', () => {
  const found = findConflicts(
    ['<<<<<<< ours', 'mine', '=======', 'yours>>>>>>> theirs'].join('\n'),
  );

  assert.equal(found.length, 1);
  assert.equal(found[0].ours, 'mine\n');
  assert.equal(found[0].theirs, 'yours\n');
});

// --- what is not a conflict -----------------------------------------------------------------------

test('an unclosed conflict is not one', () => {
  // Half-typed and half-deleted markers are ordinary while somebody resolves one by hand, and
  // drawing a widget over an unclosed region would swallow the rest of the note.
  const found = findConflicts(`${OURS}\nmine\n${SPLIT}\nyours\nand the rest of the note\n`);

  assert.deepEqual(found, []);
});

test('a second opener abandons the first rather than nesting', () => {
  const found = findConflicts(`${OURS}\nmine\n${OURS}\nagain\n${SPLIT}\nyours\n${THEIRS}\n`);

  assert.equal(found.length, 1, 'only the one that actually closed');
  assert.equal(found[0].ours, 'again\n');
});

test('markers that are not at the start of a line are just text', () => {
  const found = findConflicts('a line that mentions <<<<<<< ours in passing\n');

  assert.deepEqual(found, []);
});

test('a note with no markers has no conflicts', () => {
  assert.deepEqual(findConflicts('# A heading\n\nSome prose.\n'), []);
});

test('a line of equals signs on its own is not a conflict by itself', () => {
  // It is a setext heading underline, which is exactly why a conflict renders so badly as text.
  assert.deepEqual(findConflicts('Title\n=======\n'), []);
});

test('isConflictMarker recognises each marker and nothing else', () => {
  assert.ok(isConflictMarker(OURS));
  assert.ok(isConflictMarker(ORIGINAL));
  assert.ok(isConflictMarker(SPLIT));
  assert.ok(isConflictMarker(THEIRS));
  assert.ok(!isConflictMarker('ordinary prose'));
  assert.ok(!isConflictMarker('== not enough =='));
});

// --- what a conflict does to the markdown around it ------------------------------------------------

/**
 * The reason `livePreview` refuses any node that *overlaps* a conflict rather than one that starts
 * inside it.
 *
 * A conflict's `=======` is a setext heading underline as far as the markdown parser is concerned,
 * and a setext underline applies to the paragraph *before* it. With no blank line between, that
 * paragraph starts outside the conflict - so the heading node begins above the region and reaches
 * into it, and every line from there down rendered at title size. Containment was never the right
 * test; this is the case that proves it.
 */
test('a conflict butted up against a paragraph still has its own bounds', () => {
  const text = ['aaaaaaa', 'bbbbbbb', OURS, 'mine', SPLIT, 'yours', THEIRS].join('\n');
  const [found] = findConflicts(text);

  assert.equal(text.slice(0, found.from), 'aaaaaaa\nbbbbbbb\n', 'the prose above is not part of it');
  assert.equal(found.ours, 'mine\n');
  assert.equal(found.theirs, 'yours\n');
});

test('resolving a conflict butted up against a paragraph leaves the paragraph alone', () => {
  const text = ['aaaaaaa', 'bbbbbbb', OURS, 'mine', SPLIT, 'yours', THEIRS].join('\n');
  const [found] = findConflicts(text);

  assert.equal(documentAfterResolving(text, found, 'ours'), 'aaaaaaa\nbbbbbbb\nmine');
});

// --- resolving ------------------------------------------------------------------------------------

test('each choice yields exactly that side', () => {
  const [found] = findConflicts(conflict(['mine'], ['base'], ['yours']));

  assert.equal(resolvedText(found, 'ours'), 'mine\n');
  assert.equal(resolvedText(found, 'theirs'), 'yours\n');
  assert.equal(resolvedText(found, 'original'), 'base\n');
});

test('keeping both puts this device first, then the other', () => {
  const [found] = findConflicts(conflict(['mine'], ['base'], ['yours']));

  assert.equal(resolvedText(found, 'both'), 'mine\nyours\n');
});

test('keeping both from multi-line sides joins them without losing a line', () => {
  const [found] = findConflicts(conflict(['one', 'two'], null, ['three']));

  assert.equal(resolvedText(found, 'both'), 'one\ntwo\nthree\n');
});

test('keeping neither, when there was no original, empties the region', () => {
  const [found] = findConflicts(conflict(['mine'], null, ['yours']));

  assert.equal(resolvedText(found, 'original'), '');
});

test('resolving leaves no marker behind, whichever side is chosen', () => {
  const text = `before\n${conflict(['mine'], ['base'], ['yours'])}\nafter\n`;
  const [found] = findConflicts(text);

  for (const choice of ['ours', 'theirs', 'both', 'original'] as const) {
    const resolved = documentAfterResolving(text, found, choice);

    assert.equal(findConflicts(resolved).length, 0, `${choice} left a conflict behind`);
    for (const marker of ['<<<<<<<', '|||||||', '=======', '>>>>>>>']) {
      assert.ok(!resolved.includes(marker), `${choice} left ${marker} behind`);
    }
  }
});

test('resolving keeps the text around the conflict untouched', () => {
  const text = `before\n${conflict(['mine'], null, ['yours'])}\nafter\n`;
  const [found] = findConflicts(text);

  assert.equal(documentAfterResolving(text, found, 'ours'), 'before\nmine\nafter\n');
});

test('resolving does not leave a blank line where the markers were', () => {
  // Found on a phone: the region stops at the end of the `>>>>>>>` line and the document's own
  // newline follows it, so a replacement that kept its trailing newline inserted two.
  const text = `before\n${conflict(['mine'], null, ['yours'])}\nafter\n`;
  const [found] = findConflicts(text);

  for (const choice of ['ours', 'theirs', 'both'] as const) {
    const resolved = documentAfterResolving(text, found, choice);
    assert.ok(!resolved.includes('\n\n'), `${choice} left a blank line: ${JSON.stringify(resolved)}`);
  }
});

test('a multi-line side comes back with its lines and no extra break', () => {
  const text = `before\n${conflict(['one', 'two'], null, ['yours'])}\nafter\n`;
  const [found] = findConflicts(text);

  assert.equal(documentAfterResolving(text, found, 'ours'), 'before\none\ntwo\nafter\n');
});

test('choosing a side that deleted the passage deletes it, rather than leaving a blank line', () => {
  const text = `before\n${conflict([], null, ['yours'])}\nafter\n`;
  const [found] = findConflicts(text);

  assert.equal(documentAfterResolving(text, found, 'ours'), 'before\nafter\n');
});

test('resolving a conflict that ends the document leaves no trailing blank line', () => {
  const text = `before\n${conflict(['mine'], null, ['yours'])}`;
  const [found] = findConflicts(text);

  assert.equal(documentAfterResolving(text, found, 'ours'), 'before\nmine');
});

test('resolving the first of two conflicts leaves the second alone', () => {
  const text = `${conflict(['a'], null, ['b'])}\nmiddle\n${conflict(['c'], null, ['d'])}`;
  const [first] = findConflicts(text);
  const resolved = documentAfterResolving(text, first, 'ours');

  const remaining = findConflicts(resolved);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].ours, 'c\n');
  assert.equal(resolved, `a\nmiddle\n${conflict(['c'], null, ['d'])}`);
});
