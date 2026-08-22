import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HEADER_ROW,
  blankTable,
  cellAt,
  cellOf,
  cellText,
  displayWidth,
  escapeCell,
  isDelimiterRow,
  readTable,
  renderTable,
  splitRow,
  unescapeCell,
  withAlign,
  withCell,
  withColumn,
  withMovedColumn,
  withMovedRow,
  withRow,
  withoutColumn,
  withoutRow,
} from '../src/components/tableFormat.ts';

/**
 * Tests for the one part of the table support that can produce a wrong answer rather than no answer:
 * the layout.
 *
 * Everything else added with it is a button that either moves the cursor or does not, and you can
 * see which. This module rewrites the user's text. A bug in it does not fail - it saves a table with
 * a cell missing, or a row markdown no longer reads as part of the table, and the autosave writes
 * that over the real note a second later. Same shape of danger as the Rust core, same answer to it.
 *
 * Run with `npm test`. There is no test framework here: node's own runner and its type stripping, so
 * nothing was added to the client's dependencies to have these.
 *
 * The non-ASCII this exercises is written as escapes rather than as characters, because the rule
 * about ASCII is about the text this repo writes and these are the characters a *user* writes. The
 * Rust core's fixtures are exempted in the check script instead; one exception there is enough.
 */

/** Some text a user might reasonably put in a table, none of which is one column per character. */
const CJK = '\u4e2d\u6587';
const EMOJI = '\u{1f600}';
const FAMILY = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}';
const ACCENTED = 'e\u0301';

test('display width counts columns, not characters', () => {
  assert.equal(displayWidth(''), 0);
  assert.equal(displayWidth('abc'), 3);
  // A wide character is one character and takes two columns of a monospace grid.
  assert.equal(displayWidth(CJK), 4);
  // A combining accent takes none: an accented e written as two code points is still one column.
  assert.equal(displayWidth(ACCENTED), 1);
  assert.equal(displayWidth(EMOJI), 2);
  // An emoji built from joined code points is one thing two columns wide, not three things.
  assert.equal(displayWidth(FAMILY), 2);
});

test('a row splits on pipes that are not escaped', () => {
  assert.deepEqual(splitRow('| a | b |'), ['a', 'b']);
  assert.deepEqual(splitRow('|a|b|'), ['a', 'b']);
  // The outer pipes are optional in markdown, and a row without them is still a row.
  assert.deepEqual(splitRow('a | b'), ['a', 'b']);
  // A pipe in someone's prose is not a column boundary.
  assert.deepEqual(splitRow('| a \\| b | c |'), ['a \\| b', 'c']);
  // An empty cell is a cell.
  assert.deepEqual(splitRow('| a |  | c |'), ['a', '', 'c']);
});

test('the delimiter row is recognised in every form markdown allows', () => {
  assert.equal(isDelimiterRow('|---|---|'), true);
  assert.equal(isDelimiterRow('| :-- | --: | :-: |'), true);
  assert.equal(isDelimiterRow('|-|'), true);
  assert.equal(isDelimiterRow('| a | b |'), false);
  assert.equal(isDelimiterRow('| --- | x |'), false);
});

test('what is not a table is refused, not guessed at', () => {
  assert.equal(readTable(''), null);
  assert.equal(readTable('| a | b |'), null);
  assert.equal(readTable('just some prose\nand more of it'), null);
});

test('a ragged table is laid out to even columns', () => {
  const table = readTable('|a|b|\n|-|-:|\n|1|22222|\n|333|4|');
  assert.notEqual(table, null);
  assert.deepEqual(table!.header, ['a', 'b']);
  assert.deepEqual(table!.align, ['none', 'right']);

  assert.equal(
    renderTable(table!),
    ['| a   |     b |', '| --- | ----: |', '| 1   | 22222 |', '| 333 |     4 |'].join('\n'),
  );
});

test('laying out a table that is already laid out changes nothing', () => {
  // The property the whole feature rests on. The source is rewritten every time the cursor leaves a
  // table, so a layout that was not a fixed point would leave a note permanently unsaved.
  const once = renderTable(readTable('|a|b|\n|-|-:|\n|1|22222|')!);
  assert.equal(renderTable(readTable(once)!), once);
});

test('the text in a cell survives being laid out, whatever it is written in', () => {
  const source = `| ${CJK} | ${EMOJI} | ${ACCENTED} | a \\| b |\n| - | - | - | - |\n| x | y | z | w |`;
  const table = readTable(source)!;
  assert.deepEqual(table.header, [CJK, EMOJI, ACCENTED, 'a \\| b']);

  // And the columns line up, which is what measuring in columns rather than characters is for.
  const lines = renderTable(table).split('\n');
  assert.equal(displayWidth(lines[0]), displayWidth(lines[2]));
  assert.equal(displayWidth(lines[0]), displayWidth(lines[1]));
});

test('a body row with more cells than the header keeps all of them', () => {
  // Losing a cell would be losing the user's writing, quietly, to a tidy-up nobody asked for.
  const table = readTable('|a|\n|-|\n|1|2|')!;
  assert.deepEqual(table.header, ['a', '']);
  assert.deepEqual(table.rows[0], ['1', '2']);
  assert.deepEqual(readTable(renderTable(table))!.rows[0], ['1', '2']);
});

test('alignment is written into the delimiter row and into the padding', () => {
  const table = withAlign(readTable('|abc|\n|-|\n|x|')!, 0, 'center');
  assert.equal(renderTable(table), ['| abc |', '| :-: |', '|  x  |'].join('\n'));

  assert.equal(
    renderTable(withAlign(table, 0, 'right')),
    ['| abc |', '| --: |', '|   x |'].join('\n'),
  );
  assert.equal(
    renderTable(withAlign(table, 0, 'left')),
    ['| abc |', '| :-- |', '| x   |'].join('\n'),
  );
});

test('a column is never narrower than the delimiter it has to hold', () => {
  assert.equal(
    renderTable(readTable('|a|\n|-|\n|b|')!),
    ['| a   |', '| --- |', '| b   |'].join('\n'),
  );
});

test('rows and columns are added and removed', () => {
  const table = readTable('|a|b|\n|-|-|\n|1|2|')!;

  assert.equal(withRow(table, 0).rows.length, 2);
  assert.deepEqual(withRow(table, 0).rows[0], ['', '']);
  assert.deepEqual(withColumn(table, 1).header, ['a', '', 'b']);
  assert.deepEqual(withColumn(table, 1).rows[0], ['1', '', '2']);
  assert.deepEqual(withoutColumn(table, 0).header, ['b']);
  assert.equal(withoutRow(table, 0).rows.length, 0);

  // What cannot be represented is refused rather than produced: a table keeps a column.
  const single = readTable('|a|\n|-|\n|1|')!;
  assert.deepEqual(withoutColumn(single, 0).header, ['a']);
});

test('a new table is empty and even', () => {
  assert.equal(
    renderTable(blankTable(3, 2)),
    [
      '|     |     |     |',
      '| --- | --- | --- |',
      '|     |     |     |',
      '|     |     |     |',
    ].join('\n'),
  );
});

test('an indent is kept, so a table written inside a list stays inside it', () => {
  const table = readTable('  | a |\n  | - |\n  | 1 |')!;
  assert.equal(table.indent, '  ');
  assert.equal(renderTable(table), ['  | a   |', '  | --- |', '  | 1   |'].join('\n'));
});

test('the cursor is found in a cell and can be put back in the same one', () => {
  const line = '| abc | de |';
  assert.deepEqual(cellAt(line, 3), { column: 0, into: 1 });
  assert.deepEqual(cellAt(line, 9), { column: 1, into: 1 });
  assert.deepEqual(cellText(line, 1), { start: 8, length: 2 });

  // Padding is not part of the cell. A cursor parked in the spaces holding a column open would land
  // somewhere different every time the column was laid out again.
  assert.deepEqual(cellAt('| a     | b |', 5), { column: 0, into: 1 });
});

test('a cell is read and written by row and column', () => {
  const table = readTable('|a|b|\n|-|-|\n|1|2|\n|3|4|')!;

  assert.equal(cellOf(table, HEADER_ROW, 1), 'b');
  assert.equal(cellOf(table, 1, 0), '3');
  assert.equal(cellOf(table, 9, 0), null);
  assert.equal(cellOf(table, 0, 9), null);

  assert.equal(cellOf(withCell(table, HEADER_ROW, 0, 'x'), HEADER_ROW, 0), 'x');
  assert.equal(cellOf(withCell(table, 1, 1, 'x'), 1, 1), 'x');
  // A row or a column that is not there changes nothing, rather than growing the table sideways.
  assert.deepEqual(withCell(table, 5, 0, 'x'), table);
  assert.deepEqual(withCell(table, 0, 5, 'x'), table);
});

test('what somebody types in a cell survives the trip to markdown and back', () => {
  // A pipe would start another column, and a backslash would swallow whatever followed it.
  assert.equal(escapeCell('a | b'), 'a \\| b');
  assert.equal(unescapeCell('a \\| b'), 'a | b');
  assert.equal(unescapeCell(escapeCell('a \\| b')), 'a \\| b');

  // A cell cannot hold a line break at all, so a pasted paragraph becomes one line rather than being
  // refused: what was pasted is still there, and the person who pasted it can see what it did.
  assert.equal(escapeCell('one\ntwo'), 'one two');

  // Through a real table, which is the trip that actually happens.
  const typed = 'a | b \\ c';
  const table = withCell(readTable('|x|\n|-|\n|1|')!, 0, 0, escapeCell(typed));
  assert.equal(unescapeCell(cellOf(readTable(renderTable(table))!, 0, 0) ?? ''), typed);
});

test('rows and columns are reordered whole', () => {
  const table = readTable('|a|b|c|\n|-|:-:|-:|\n|1|2|3|\n|4|5|6|\n|7|8|9|')!;

  assert.deepEqual(withMovedRow(table, 0, 2).rows, [
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['1', '2', '3'],
  ]);
  assert.deepEqual(withMovedRow(table, 2, 0).rows[0], ['7', '8', '9']);

  // A column takes its heading and its alignment with it, or the table says something else after.
  const shifted = withMovedColumn(table, 2, 0);
  assert.deepEqual(shifted.header, ['c', 'a', 'b']);
  assert.deepEqual(shifted.align, ['right', 'none', 'center']);
  assert.deepEqual(shifted.rows[0], ['3', '1', '2']);

  // Somewhere there is nothing to move to leaves the table exactly as it was.
  assert.deepEqual(withMovedRow(table, 0, 9), table);
  assert.deepEqual(withMovedColumn(table, 9, 0), table);
  assert.deepEqual(withMovedRow(table, 1, 1), table);
});
