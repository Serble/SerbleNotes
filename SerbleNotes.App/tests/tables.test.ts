import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Language, defineLanguageFacet, ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { GFM, parser as baseParser } from '@lezer/markdown';
import { renderTable } from '../src/components/tableFormat.ts';
import { DELIMITER_ROW, HEADER_ROW, tableContextAt } from '../src/components/tables.ts';

/**
 * The half of the table commands that can be tested without a screen: finding the table the cursor
 * is in, and finding the cursor inside it.
 *
 * Everything the commands do is decided by that answer, so getting it wrong means adding a row to
 * the wrong table or deleting the wrong column - and there is no version of this where it can be
 * seen going wrong in review.
 *
 * The parser is built here rather than imported from `markdownLanguage.ts`: that module reaches on
 * to `codeLanguages.ts`, whose whole job is to import a language bundle per fenced block, and node
 * resolves those paths differently from the bundler. What tables are parsed by is `GFM`, and this is
 * the same `GFM` the editor is configured with - if that ever stops being true, so does this comment.
 */

const markdownLanguage = new Language(
  defineLanguageFacet({}),
  baseParser.configure([GFM]),
  [],
  'markdown',
);

/** A state with the document parsed, which `syntaxTree` will not do on its own for a fresh one. */
function stateOf(doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [markdownLanguage] });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

// Written out the way the editor writes it, so that laying it out again is a no-op - which is what
// the test below is for.
const DOC = ['intro', '', '| a   | b   |', '| --- | --- |', '| 1   | 2   |', '', 'after', ''].join(
  '\n',
);
const TABLE_START = DOC.indexOf('| a');

test('a table is found from anywhere inside it, and nowhere outside it', () => {
  const state = stateOf(DOC);

  const context = tableContextAt(state, TABLE_START + 3);
  assert.notEqual(context, null);
  assert.equal(context!.from, TABLE_START);
  assert.equal(
    state.doc.sliceString(context!.from, context!.to),
    ['| a   | b   |', '| --- | --- |', '| 1   | 2   |'].join('\n'),
  );

  assert.equal(tableContextAt(state, 2), null);
  assert.equal(tableContextAt(state, DOC.indexOf('after') + 2), null);
});

test('the three kinds of row are told apart', () => {
  const state = stateOf(DOC);

  assert.equal(tableContextAt(state, TABLE_START + 2)!.row, HEADER_ROW);
  assert.equal(tableContextAt(state, TABLE_START + 16)!.row, DELIMITER_ROW);
  assert.equal(tableContextAt(state, TABLE_START + 30)!.row, 0);
});

test('the cursor is placed in the right cell', () => {
  const state = stateOf(DOC);

  // '| a   | b   |' - offset 2 is the 'a', offset 8 is the 'b'.
  assert.equal(tableContextAt(state, TABLE_START + 2)!.column, 0);
  assert.equal(tableContextAt(state, TABLE_START + 8)!.column, 1);
  assert.equal(tableContextAt(state, TABLE_START + 2)!.into, 0);
  assert.equal(tableContextAt(state, TABLE_START + 3)!.into, 1);
});

test('the table read out of the document is the table that was written', () => {
  const state = stateOf(DOC);
  const context = tableContextAt(state, TABLE_START)!;

  assert.deepEqual(context.table.header, ['a', 'b']);
  assert.deepEqual(context.table.rows, [['1', '2']]);
  // Already even, so laying it out again is a no-op - which is what stops the editor rewriting a
  // note nobody edited.
  assert.equal(renderTable(context.table), state.doc.sliceString(context.from, context.to));
});

test('a ragged table is found and comes back laid out', () => {
  const doc = '|a|b|\n|-|-:|\n|1|22222|\n';
  const state = stateOf(doc);
  const context = tableContextAt(state, 1)!;

  assert.equal(context.from, 0);
  assert.equal(
    renderTable(context.table),
    ['| a   |     b |', '| --- | ----: |', '| 1   | 22222 |'].join('\n'),
  );
});

test('the end of the last row is still inside the table', () => {
  // A position on the very edge of a block resolves to a node outside it, which is why the lookup
  // tries both sides. Without that, the buttons vanished on the row you were typing in.
  const state = stateOf(DOC);
  const end = TABLE_START + '| a   | b   |\n| --- | --- |\n| 1   | 2   |'.length;
  assert.notEqual(tableContextAt(state, end), null);
});

test('an indented table keeps its indent in the range that is read', () => {
  const doc = '- item\n\n  | a | b |\n  | - | - |\n  | 1 | 2 |\n';
  const state = stateOf(doc);
  const context = tableContextAt(state, doc.indexOf('| a') + 2);

  assert.notEqual(context, null);
  // The range starts at the beginning of the line, not where the parser found content, so the
  // indent is part of what is read and part of what gets written back.
  assert.equal(context!.table.indent, '  ');
  assert.equal(renderTable(context!.table).startsWith('  |'), true);
});
