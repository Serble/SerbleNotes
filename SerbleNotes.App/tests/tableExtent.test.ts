import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Marked, Tokenizer } from 'marked';
import { looksLikeRow, startsTable, tableExtent } from '../src/components/tableFormat.ts';
import { markdownLanguage } from '../src/components/markdownLanguage.ts';

/**
 * Where a table stops.
 *
 * GFM says a table runs to the first blank line or the start of another block, so a sentence typed
 * directly under one is a row of it - the whole sentence in the first column. Nobody means that, and
 * here it is worse than a rendering oddity: the table is drawn and editable, so the next keystroke
 * in any cell writes the whole thing back laid out and the sentence comes out as markdown with pipes
 * round it. Text that was a paragraph a moment ago cannot quietly become part of a table.
 *
 * Two renderers have to agree about it - the editor's own parser and marked, which draws a version
 * in the history panel - so both are exercised here against the same documents. A note that read as
 * two different things depending on where it was opened would be its own bug.
 */

/** The top-level blocks the editor's parser finds, as `Name:"source"`. */
function blocks(doc: string): string[] {
  const cursor = markdownLanguage.parser.parse(doc).cursor();
  const found: string[] = [];

  if (cursor.firstChild()) {
    do {
      found.push(`${cursor.name}:${JSON.stringify(doc.slice(cursor.from, cursor.to))}`);
    } while (cursor.nextSibling());
  }

  return found;
}

/** marked, configured exactly as `MarkdownPreview` configures it. */
const preview = new Marked({ breaks: true, gfm: true }).use({
  tokenizer: {
    table(src) {
      const extent = tableExtent(src);
      return extent > 0 && extent < src.length
        ? Tokenizer.prototype.table.call(this, src.slice(0, extent))
        : false;
    },
  },
});

/** How many rows the rendered table has in its body, so the two renderers can be compared. */
function bodyRows(doc: string): number {
  return ((preview.parse(doc) as string).match(/<tr>/g) ?? []).length - 1;
}

test('a line with no unescaped pipe in it is not a row', () => {
  assert.equal(looksLikeRow('| a | b |'), true);
  assert.equal(looksLikeRow('a | b'), true);
  assert.equal(looksLikeRow('|'), true);
  assert.equal(looksLikeRow('hello there'), false);
  assert.equal(looksLikeRow(''), false);
  // The escape markdown tables have is the one thing that makes a pipe not a boundary.
  assert.equal(looksLikeRow('has a \\| in it'), false);
});

test('a table opens on a header and a delimiter row that agree on their columns', () => {
  assert.equal(startsTable('| a | b |', '| - | - |'), true);
  assert.equal(startsTable('a | b', '- | -'), true);
  // A count mismatch is not a table, which is the rule GFM starts one by.
  assert.equal(startsTable('| a | b |', '| - |'), false);
  // `---` under a line of prose is a setext heading, and reading it as a one-column table would
  // turn every underlined title in a note into one.
  assert.equal(startsTable('Heading', '---'), false);
  assert.equal(startsTable('| a |', '---'), false);
});

test('a table stops at the first line that is not a row', () => {
  const doc = '| a | b |\n| - | - |\n| 1 | 2 |\nhello\n';

  assert.deepEqual(blocks(doc), [
    'Table:"| a | b |\\n| - | - |\\n| 1 | 2 |"',
    'Paragraph:"hello"',
  ]);
  assert.equal(bodyRows(doc), 1);
});

test('a short row is still a row, and is kept', () => {
  const doc = '| a | b |\n| - | - |\n| 1 |\n| 2 | 3 |\n';

  assert.deepEqual(blocks(doc), ['Table:"| a | b |\\n| - | - |\\n| 1 |\\n| 2 | 3 |"']);
  assert.equal(bodyRows(doc), 2);
});

test('what the table lets go is parsed as whatever it is', () => {
  const heading = '| a |\n| - |\n| 1 |\n# Title\n';
  assert.deepEqual(blocks(heading), ['Table:"| a |\\n| - |\\n| 1 |"', 'ATXHeading1:"# Title"']);
  assert.match(preview.parse(heading) as string, /<h1>Title<\/h1>/);

  // A second table under the prose is a second table, not more rows of the first.
  const twice = '| a |\n| - |\n| 1 |\nlast\n| a |\n| - |\n| 9 |\n';
  assert.deepEqual(blocks(twice), [
    'Table:"| a |\\n| - |\\n| 1 |"',
    'Paragraph:"last"',
    'Table:"| a |\\n| - |\\n| 9 |"',
  ]);
  assert.equal(((preview.parse(twice) as string).match(/<table>/g) ?? []).length, 2);
});

test('it holds inside a quote and inside a list, where the block has a prefix on every line', () => {
  const quoted = '> | a | b |\n> | - | - |\n> | 1 | 2 |\n> after\n';
  assert.deepEqual(blocks(quoted), [
    'Blockquote:"> | a | b |\\n> | - | - |\\n> | 1 | 2 |\\n> after"',
  ]);
  assert.equal(bodyRows(quoted), 1);
  assert.match(preview.parse(quoted) as string, /<p>after<\/p>[\s\S]*<\/blockquote>/);

  const listed = '- | a | b |\n  | - | - |\n  | 1 | 2 |\n  text\n';
  assert.equal(bodyRows(listed), 1);
});

test('a table that reaches the end of the note is left alone', () => {
  const doc = '| a | b |\n| - | - |\n| 1 | 2 |\n';

  assert.equal(tableExtent(doc), doc.length);
  assert.deepEqual(blocks(doc), ['Table:"| a | b |\\n| - | - |\\n| 1 | 2 |"']);
  assert.equal(bodyRows(doc), 1);
});

test('pipes inside a fenced block are code, not a table', () => {
  const doc = '```\n| a | b |\n| - | - |\nnot a table\n```\n';

  assert.deepEqual(blocks(doc), ['FencedCode:"```\\n| a | b |\\n| - | - |\\nnot a table\\n```"']);
  assert.doesNotMatch(preview.parse(doc) as string, /<table>/);
});

test('nothing that was not a table becomes one, or is cut in half', () => {
  // The delimiter row does not match the header, so none of this is a table - and it must stay one
  // paragraph rather than being split where a table would have ended.
  const ragged = '| a | b |\n| - |\nhello\n';
  assert.equal(tableExtent(ragged), 0);
  assert.deepEqual(blocks(ragged), ['Paragraph:"| a | b |\\n| - |\\nhello"']);

  const setext = 'Heading\n---\ntext\n';
  assert.deepEqual(blocks(setext), ['SetextHeading2:"Heading\\n---"', 'Paragraph:"text"']);
});
