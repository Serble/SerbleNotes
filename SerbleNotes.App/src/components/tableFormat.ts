/**
 * Markdown tables, as text.
 *
 * Everything here works on strings and knows nothing about CodeMirror, which is what lets the same
 * functions lay a table out, add a row to it, and work out which cell the cursor is in.
 *
 * The reason it exists at all is that a note is stored as markdown and read back as markdown. A
 * table whose source is `|a|b|` and `|c|dddddddd|` renders correctly and is unreadable in any plain
 * text editor, in a diff, in an exported archive, and on the FUSE mount when there is one. So the
 * columns are padded to a common width and the delimiter row is drawn to match: the table then says
 * the same thing rendered or not, which is the only version of "it works" this project accepts.
 *
 * Padding is measured in display columns rather than characters, because the editor draws a table in
 * a monospace font and a CJK character or an emoji takes two of those columns while counting as one
 * character - or as several, for an emoji built out of joined code points. Getting that wrong is not
 * a rounding error: it is a table whose sides do not line up for anybody writing in a language this
 * app was not tested in.
 */

export type Align = 'none' | 'left' | 'center' | 'right';

/**
 * The header row, and the `|---|` row under it, addressed as row numbers so that one type covers
 * every row a table has. Body rows are 0 upwards.
 */
export const HEADER_ROW = -1;
export const DELIMITER_ROW = -2;

export interface Table {
  /** The first line's leading whitespace, given back to every line when it is written out. */
  indent: string;
  header: string[];
  align: Align[];
  rows: string[][];
}

/** The narrowest a column can be: `:-:` is three characters and has to fit. */
const MIN_WIDTH = 3;

/* ------------------------------------------------------------------ how wide a cell looks */

/**
 * Code points that take no width of their own: combining marks, variation selectors, joiners and
 * the other invisible formatting characters. `\p{Cf}` covers the zero-width joiner an emoji family
 * is built with, and `\p{M}` the accent that turns `e` into an e-acute without taking a column.
 */
const ZERO_WIDTH = /^[\p{M}\p{Cf}]$/u;

/**
 * Code points drawn two columns wide in a monospace font: the East Asian Wide and Fullwidth blocks,
 * plus the emoji planes. There is no Unicode property escape for East Asian Width in a JavaScript
 * regex, so it is a table; it is the same one every terminal ships.
 */
const WIDE: [number, number][] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

function codePointWidth(code: number): number {
  for (const [from, to] of WIDE) {
    if (code >= from && code <= to) {
      return 2;
    }
    if (code < from) {
      break;
    }
  }
  return 1;
}

/**
 * Graphemes, so that an emoji written as several joined code points is one thing that is two columns
 * wide rather than several things that are each two columns wide. `Intl.Segmenter` is in every
 * engine this app runs in; the fallback is only there so a missing one degrades to slightly wrong
 * padding instead of a crash.
 */
const graphemes =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

function split(text: string): string[] {
  if (graphemes) {
    return [...graphemes.segment(text)].map((piece) => piece.segment);
  }
  return [...text];
}

/** How many monospace columns a string takes up. */
export function displayWidth(text: string): number {
  let width = 0;

  for (const grapheme of split(text)) {
    let cell = 0;
    for (const character of grapheme) {
      if (ZERO_WIDTH.test(character)) {
        continue;
      }
      // The widest code point in the cluster decides it: a base letter with an accent on it is one
      // column, and a flag built from two regional indicators is two rather than four.
      cell = Math.max(cell, codePointWidth(character.codePointAt(0) ?? 0));
    }
    width += cell;
  }

  return width;
}

/** Spaces enough to bring `text` out to `width` columns. Never negative, so a long cell just runs on. */
function padding(text: string, width: number): number {
  return Math.max(0, width - displayWidth(text));
}

/* ------------------------------------------------------------------ reading a table */

/**
 * Where each cell of a row sits in the line, as offsets into the line itself.
 *
 * The whole of the cell is included - the spaces markdown will trim off as well as the text - so
 * this can be used both to read the cells out and to work out where the cursor is inside one.
 *
 * A `|` preceded by a backslash is a pipe in someone's prose, not a column boundary, which is the
 * only escape markdown tables have.
 */
export function cellRanges(line: string): { from: number; to: number }[] {
  const bounds: number[] = [];

  for (let at = 0; at < line.length; at += 1) {
    if (line[at] === '\\') {
      at += 1;
      continue;
    }
    if (line[at] === '|') {
      bounds.push(at);
    }
  }

  if (bounds.length === 0) {
    return [{ from: 0, to: line.length }];
  }

  const ranges: { from: number; to: number }[] = [];
  let from = 0;
  for (const bound of bounds) {
    ranges.push({ from, to: bound });
    from = bound + 1;
  }
  ranges.push({ from, to: line.length });

  // A row normally opens and closes with a pipe, which leaves an empty piece at each end that is
  // not a cell. Only drop one that is genuinely empty: `a | b` is two cells with no outer pipes.
  if (ranges.length > 1 && line.slice(ranges[0].from, ranges[0].to).trim() === '') {
    ranges.shift();
  }
  const last = ranges[ranges.length - 1];
  if (ranges.length > 1 && line.slice(last.from, last.to).trim() === '') {
    ranges.pop();
  }

  return ranges;
}

/** The cells of one row, trimmed. */
export function splitRow(line: string): string[] {
  return cellRanges(line).map((range) => line.slice(range.from, range.to).trim());
}

const DELIMITER_CELL = /^:?-+:?$/;

function alignOf(cell: string): Align {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) {
    return 'center';
  }
  if (left) {
    return 'left';
  }
  if (right) {
    return 'right';
  }
  return 'none';
}

/** Whether a line is the `|---|:--:|` row that turns the line above it into a table header. */
export function isDelimiterRow(line: string): boolean {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => DELIMITER_CELL.test(cell));
}

function widen(row: string[], columns: number): string[] {
  const padded = row.slice(0, columns);
  while (padded.length < columns) {
    padded.push('');
  }
  return padded;
}

/**
 * Reads a table out of its own source. Returns null for anything that is not one, so a caller can
 * hand it whatever the parser called a table without checking first.
 */
export function readTable(source: string): Table | null {
  const lines = source.split('\n');
  if (lines.length < 2 || !isDelimiterRow(lines[1])) {
    return null;
  }

  const header = splitRow(lines[0]);
  const delimiters = splitRow(lines[1]);

  // The header decides how many columns there are, but a body row with more cells in it would lose
  // text if we went by that alone - and losing text is the one thing this must never do.
  const columns = Math.max(
    1,
    header.length,
    ...lines.slice(2).map((line) => splitRow(line).length),
  );

  return {
    indent: /^[ \t]*/.exec(lines[0])?.[0] ?? '',
    header: widen(header, columns),
    align: widen(delimiters, columns).map(alignOf),
    rows: lines.slice(2).map((line) => widen(splitRow(line), columns)),
  };
}

/* ------------------------------------------------------------------ writing it back out */

function delimiterCell(align: Align, width: number): string {
  const inner = Math.max(MIN_WIDTH, width);
  switch (align) {
    case 'left':
      return `:${'-'.repeat(inner - 1)}`;
    case 'right':
      return `${'-'.repeat(inner - 1)}:`;
    case 'center':
      return `:${'-'.repeat(inner - 2)}:`;
    default:
      return '-'.repeat(inner);
  }
}

/**
 * A cell laid out in its column. The text sits where the column's alignment says it will render, so
 * a column of right-aligned numbers reads as one in the source too.
 */
function cell(text: string, width: number, align: Align): string {
  const spare = padding(text, width);
  if (align === 'right') {
    return ' '.repeat(spare) + text;
  }
  if (align === 'center') {
    const left = Math.floor(spare / 2);
    return ' '.repeat(left) + text + ' '.repeat(spare - left);
  }
  return text + ' '.repeat(spare);
}

/** The width of each column: whatever its widest cell needs, and never less than the delimiter. */
export function columnWidths(table: Table): number[] {
  return table.header.map((head, column) =>
    Math.max(
      MIN_WIDTH,
      displayWidth(head),
      ...table.rows.map((row) => displayWidth(row[column] ?? '')),
    ),
  );
}

/** The table as markdown: padded columns, aligned text, one line per row. */
export function renderTable(table: Table): string {
  const widths = columnWidths(table);
  const line = (cells: string[]) =>
    `${table.indent}| ${cells.map((text, column) => cell(text, widths[column], table.align[column])).join(' | ')} |`;

  return [
    line(table.header),
    `${table.indent}| ${table.align.map((align, column) => delimiterCell(align, widths[column])).join(' | ')} |`,
    ...table.rows.map(line),
  ].join('\n');
}

/* ------------------------------------------------------------------ changing its shape */

export function columnCount(table: Table): number {
  return table.header.length;
}

/** A blank table of the given size, with one header row above `rows` empty body rows. */
export function blankTable(columns: number, rows: number, indent = ''): Table {
  const width = Math.max(1, columns);
  return {
    indent,
    header: Array.from({ length: width }, () => ''),
    align: Array.from({ length: width }, () => 'none' as Align),
    rows: Array.from({ length: Math.max(0, rows) }, () => Array.from({ length: width }, () => '')),
  };
}

/** A copy with a blank body row inserted at `index`, which may be one past the end. */
export function withRow(table: Table, index: number): Table {
  const at = Math.max(0, Math.min(index, table.rows.length));
  const rows = table.rows.slice();
  rows.splice(at, 0, Array.from({ length: columnCount(table) }, () => ''));
  return { ...table, rows };
}

/**
 * A copy without body row `index`. The header is not a body row and cannot be removed this way -
 * a table without one is not a table, and deleting the whole thing is a different action with a
 * different name.
 */
export function withoutRow(table: Table, index: number): Table {
  if (index < 0 || index >= table.rows.length) {
    return table;
  }
  const rows = table.rows.slice();
  rows.splice(index, 1);
  return { ...table, rows };
}

/** A copy with a blank column inserted at `index`, which may be one past the last column. */
export function withColumn(table: Table, index: number): Table {
  const at = Math.max(0, Math.min(index, columnCount(table)));
  const insert = <T,>(list: T[], value: T) => {
    const copy = list.slice();
    copy.splice(at, 0, value);
    return copy;
  };

  return {
    ...table,
    header: insert(table.header, ''),
    align: insert(table.align, 'none'),
    rows: table.rows.map((row) => insert(row, '')),
  };
}

/** A copy without column `index`. The last column is kept: a table with no columns has no source. */
export function withoutColumn(table: Table, index: number): Table {
  if (index < 0 || index >= columnCount(table) || columnCount(table) === 1) {
    return table;
  }
  const remove = <T,>(list: T[]) => list.filter((_, at) => at !== index);

  return {
    ...table,
    header: remove(table.header),
    align: remove(table.align),
    rows: table.rows.map(remove),
  };
}

/** A copy with column `index` aligned differently. */
export function withAlign(table: Table, index: number, align: Align): Table {
  if (index < 0 || index >= columnCount(table)) {
    return table;
  }
  return { ...table, align: table.align.map((current, at) => (at === index ? align : current)) };
}

/** The text of one cell, or null for a row that is not there. */
export function cellOf(table: Table, row: number, column: number): string | null {
  if (column < 0 || column >= columnCount(table)) {
    return null;
  }
  if (row === HEADER_ROW) {
    return table.header[column];
  }
  if (row < 0 || row >= table.rows.length) {
    return null;
  }
  return table.rows[row][column];
}

/** A copy with one cell holding different text. The delimiter row is written from the alignment. */
export function withCell(table: Table, row: number, column: number, text: string): Table {
  if (column < 0 || column >= columnCount(table)) {
    return table;
  }
  if (row === HEADER_ROW) {
    return { ...table, header: table.header.map((cell, at) => (at === column ? text : cell)) };
  }
  if (row < 0 || row >= table.rows.length) {
    return table;
  }
  return {
    ...table,
    rows: table.rows.map((cells, at) =>
      at === row ? cells.map((cell, column2) => (column2 === column ? text : cell)) : cells,
    ),
  };
}

function moved<T>(list: T[], from: number, to: number): T[] {
  const copy = list.slice();
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

/** A copy with body row `from` moved to index `to`. The header is not a body row and does not move. */
export function withMovedRow(table: Table, from: number, to: number): Table {
  const last = table.rows.length - 1;
  if (from < 0 || from > last || to < 0 || to > last || from === to) {
    return table;
  }
  return { ...table, rows: moved(table.rows, from, to) };
}

/** A copy with column `from` moved to index `to` - the header cell, the alignment and every row. */
export function withMovedColumn(table: Table, from: number, to: number): Table {
  const last = columnCount(table) - 1;
  if (from < 0 || from > last || to < 0 || to > last || from === to) {
    return table;
  }
  return {
    ...table,
    header: moved(table.header, from, to),
    align: moved(table.align, from, to),
    rows: table.rows.map((row) => moved(row, from, to)),
  };
}

/* ------------------------------------------------------------------ cells as text, and as prose */

/**
 * A cell's text as it is stored, from the text somebody typed into it.
 *
 * A `|` in a cell is the one thing markdown tables escape, because an unescaped one would start
 * another column - and a backslash has to be escaped too, or `a\` before a pipe would swallow it.
 * Line breaks cannot be represented in a table cell at all, so a pasted paragraph becomes one line
 * rather than being refused: what somebody pasted is still there, and they can see what it did.
 */
export function escapeCell(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/([|\\])/g, '\\$1');
}

/** The inverse: what a cell says, for showing it to somebody rather than storing it. */
export function unescapeCell(text: string): string {
  return text.replace(/\\([|\\])/g, '$1');
}

/* ------------------------------------------------------------------ where the cursor is */

/**
 * Where a cell's text begins in a line and how long it is - between them, everywhere in that cell
 * the cursor can be. The padding around the text is not part of it: a cursor sitting in the spaces
 * that hold a column open would land somewhere different every time the column was re-laid-out.
 */
export function cellText(line: string, column: number): { start: number; length: number } {
  const ranges = cellRanges(line);
  const range = ranges[Math.max(0, Math.min(column, ranges.length - 1))];
  const raw = line.slice(range.from, range.to);
  return { start: range.from + (raw.length - raw.trimStart().length), length: raw.trim().length };
}

/** Which cell a position in a row's line falls in, and how far into that cell's text it is. */
export function cellAt(line: string, offset: number): { column: number; into: number } {
  const ranges = cellRanges(line);

  for (let column = 0; column < ranges.length; column += 1) {
    if (offset <= ranges[column].to || column === ranges.length - 1) {
      const { start, length } = cellText(line, column);
      return { column, into: Math.max(0, Math.min(offset - start, length)) };
    }
  }

  return { column: 0, into: 0 };
}
