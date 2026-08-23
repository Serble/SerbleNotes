import { syntaxTree } from '@codemirror/language';
import { EditorState, MapMode, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap, type PluginValue, type ViewUpdate } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import {
  DELIMITER_ROW,
  HEADER_ROW,
  type Align,
  type Table,
  blankTable,
  cellAt,
  cellText,
  columnCount,
  escapeCell,
  readTable,
  renderTable,
  withAlign,
  withCell,
  withColumn,
  withMovedColumn,
  withMovedRow,
  withRow,
  withoutColumn,
  withoutRow,
} from './tableFormat';
import {
  activeCellOf,
  focusCellAfterRender,
  isTextMode,
  setActiveCell,
  tableState,
} from './tableState';

/**
 * Tables in the editor: knowing which one the cursor is in, changing its shape, and keeping its
 * source laid out.
 *
 * Every command here goes the same way round - read the table out of the document, change the
 * *model* in `tableFormat.ts`, write the whole thing back rendered. Nothing edits a table's text in
 * place. That is what makes "add a column" one operation rather than one edit per line that has to
 * get the pipes right in each of them, and it is why adding a column and tidying the layout are the
 * same code path: the layout is simply what writing a table out means.
 *
 * A table is normally *drawn* rather than shown as markdown (see `tableWidget.ts`), which means the
 * editor's own cursor is almost never inside one. So "this table" is whichever cell of a drawn table
 * is being edited, and only failing that whatever the cursor is in - which is what `activeTable`
 * answers, and what makes one set of commands serve the drawn table and the markdown behind it.
 *
 * The source is re-laid-out when the cursor **leaves** a table shown as markdown. Padding that grew
 * and shrank under the cursor on every keystroke was unusable - the text you were reading moved
 * sideways while you wrote it - and a table that is tidy the moment you look away is tidy every time
 * anybody but its author sees it, which is what the layout is for. A drawn table needs none of that:
 * every edit to one writes the whole thing out laid out already.
 */

export { DELIMITER_ROW, HEADER_ROW };

export interface TableContext {
  /** The whole table, line-aligned: the start of its first line to the end of its last. */
  from: number;
  to: number;
  table: Table;
  /** Which row the cursor is on: a body row index, or HEADER_ROW / DELIMITER_ROW. */
  row: number;
  column: number;
  /** How far into that cell's text the cursor is, so it can be put back after a re-layout. */
  into: number;
}

function enclosingTable(state: EditorState, pos: number): SyntaxNode | null {
  // Both sides, for the same reason the copy button looks both ways: a position on the very edge of
  // a block - the newline ending its last row - resolves to a node outside it.
  for (const side of [1, -1] as const) {
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side);
    while (node) {
      if (node.name === 'Table') {
        return node;
      }
      node = node.parent;
    }
  }
  return null;
}

/** Everything about the table at `pos`, or null if there is not one there. */
export function tableContextAt(state: EditorState, pos: number): TableContext | null {
  const node = enclosingTable(state, pos);
  if (!node) {
    return null;
  }

  // The node begins where the parser found content, which is past any indent. Working in whole
  // lines instead keeps the indent in the text we read and in the text we write back.
  const first = state.doc.lineAt(node.from);
  const last = state.doc.lineAt(node.to);
  const table = readTable(state.doc.sliceString(first.from, last.to));
  if (!table) {
    return null;
  }

  const line = state.doc.lineAt(Math.max(first.from, Math.min(pos, last.to)));
  const index = line.number - first.number;
  const { column, into } = cellAt(line.text, Math.max(0, pos - line.from));

  return {
    from: first.from,
    to: last.to,
    table,
    row: index === 0 ? HEADER_ROW : index === 1 ? DELIMITER_ROW : index - 2,
    column,
    into,
  };
}

/** The table the cursor is in. */
export function tableAtCursor(view: EditorView): TableContext | null {
  return tableContextAt(view.state, view.state.selection.main.head);
}

/**
 * The table a command should act on: the cell being edited in a drawn table, and failing that the
 * one the cursor is in. A drawn table's cells are their own editable islands, so the editor's cursor
 * is not in one and cannot say which - `tableState.ts` remembers instead.
 */
export function activeTable(view: EditorView): TableContext | null {
  const active = activeCellOf(view.state);
  if (active) {
    const context = tableContextAt(view.state, active.from);
    if (context) {
      return { ...context, row: active.row, column: active.column, into: 0 };
    }
  }
  return tableAtCursor(view);
}

/**
 * Asks for the caret to land in a cell once the table is drawn again, which is what a command has to
 * do in place of moving the cursor when the table it changed is a widget rather than text. Skipped
 * for a table being shown as markdown, where the cursor is real and moving it is the right answer.
 */
function focusAfter(view: EditorView, from: number, row: number, column: number): void {
  if (!isTextMode(view.state, from)) {
    focusCellAfterRender({ from, row, column });
  }
}

function lineIndexOf(row: number): number {
  if (row === HEADER_ROW) {
    return 0;
  }
  if (row === DELIMITER_ROW) {
    return 1;
  }
  return row + 2;
}

/**
 * Where the cursor goes in a table that has just been written out: the same cell it was in, the same
 * distance into it. The offsets are worked out from the rendered text rather than from the model,
 * because the padding is part of where a cell's text starts.
 */
function positionOf(from: number, rendered: string, row: number, column: number, into: number): number {
  const lines = rendered.split('\n');
  const index = Math.max(0, Math.min(lineIndexOf(row), lines.length - 1));

  let offset = from;
  for (let at = 0; at < index; at += 1) {
    offset += lines[at].length + 1;
  }

  const { start, length } = cellText(lines[index], column);
  return offset + start + Math.min(into, length);
}

/**
 * Writes a changed table back over the one in the document, and puts the cursor in the cell named.
 *
 * The whole table is replaced every time. It is a handful of lines, the editor's own change tracking
 * makes that one undo step, and the alternative - patching individual cells - is where a table
 * editor grows the bugs that leave a row with the wrong number of pipes in it.
 */
function write(
  view: EditorView,
  range: { from: number; to: number },
  table: Table,
  cursor: { row: number; column: number; into: number },
): boolean {
  const rendered = renderTable(table);
  const current = view.state.doc.sliceString(range.from, range.to);

  // Where the cursor belongs afterwards - but only for a table being shown as markdown. A drawn
  // table's text is not on the screen, and putting the editor's cursor inside the range a widget has
  // replaced would be putting it somewhere nobody can see. The caret for a drawn table is asked for
  // through `focusCellAfterRender` instead.
  const moves = isTextMode(view.state, range.from);
  const column = Math.max(0, Math.min(cursor.column, columnCount(table) - 1));
  const row =
    cursor.row >= 0 ? Math.max(0, Math.min(cursor.row, table.rows.length - 1)) : cursor.row;
  const anchor = positionOf(range.from, rendered, row, column, cursor.into);

  if (rendered === current) {
    // Nothing to write, but the cursor may still have somewhere to be - Tab moving between cells of
    // a table that is already laid out is exactly this case.
    if (moves && (anchor !== view.state.selection.main.head || !view.state.selection.main.empty)) {
      view.dispatch({ selection: { anchor }, scrollIntoView: true });
    }
    return true;
  }

  view.dispatch({
    changes: { from: range.from, to: range.to, insert: rendered },
    selection: moves ? { anchor } : undefined,
    scrollIntoView: moves,
    userEvent: 'input.table',
  });
  return true;
}

/* ------------------------------------------------------------------ the commands */

/** How big a table you get when you ask for one: three columns, and two rows to put things in. */
const NEW_COLUMNS = 3;
const NEW_ROWS = 2;

/**
 * Puts a new table where the cursor is.
 *
 * A table has to start its own block, so it gets a blank line above it when there is text on the
 * line already, and one below it when the next line is not empty - without which markdown reads the
 * line after the table as another of its rows.
 */
export function insertTable(view: EditorView, columns = NEW_COLUMNS, rows = NEW_ROWS): boolean {
  const state = view.state;
  const line = state.doc.lineAt(state.selection.main.head);

  // An empty line is where the table goes; a line with writing on it keeps what it says and the
  // table starts under it.
  const blank = line.text.trim() === '';
  const at = blank ? line.from : line.to;
  const before = blank ? '' : '\n\n';

  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
  const after = next && next.text.trim() !== '' ? '\n' : '';

  const rendered = renderTable(blankTable(columns, rows));
  const insert = `${before}${rendered}${after}`;
  const start = at + before.length;

  // The cursor goes *after* the table, not into it. A new table is drawn rather than shown as
  // markdown, so where it needs the caret is the first header cell - which does not exist until the
  // widget is built, a moment from now.
  focusCellAfterRender({ from: start, row: HEADER_ROW, column: 0 });

  view.dispatch({
    changes: { from: at, to: blank ? line.to : at, insert },
    selection: { anchor: start + rendered.length },
    scrollIntoView: true,
    userEvent: 'input.table',
  });
  view.focus();
  return true;
}

/**
 * A row above or below the one the cursor is on. From the header or the delimiter row that means the
 * top of the body either way - there is nowhere above a header for a row to go.
 */
export function addRow(view: EditorView, where: 'above' | 'below'): boolean {
  const context = activeTable(view);
  if (!context) {
    return false;
  }

  const at = context.row < 0 ? 0 : where === 'above' ? context.row : context.row + 1;
  focusAfter(view, context.from, at, context.column);

  return write(view, context, withRow(context.table, at), {
    row: at,
    column: context.column,
    into: 0,
  });
}

/** A column either side of the one the cursor is in. */
export function addColumn(view: EditorView, where: 'left' | 'right'): boolean {
  const context = activeTable(view);
  if (!context) {
    return false;
  }

  const at = where === 'left' ? context.column : context.column + 1;
  focusAfter(view, context.from, context.row, at);

  return write(view, context, withColumn(context.table, at), {
    row: context.row,
    column: at,
    into: 0,
  });
}

/**
 * A row at the bottom of the table containing `pos`, wherever the cursor happens to be. `column` is
 * where the caret should land in it - Enter at the end of a table carries on down the column it was
 * already in, rather than jumping back to the first one.
 */
export function appendRow(view: EditorView, pos: number, column = 0): boolean {
  const context = tableContextAt(view.state, pos);
  if (!context) {
    return false;
  }

  const at = context.table.rows.length;
  focusAfter(view, context.from, at, column);
  return write(view, context, withRow(context.table, at), { row: at, column, into: 0 });
}

/** A column at the right-hand end of the table containing `pos`. */
export function appendColumn(view: EditorView, pos: number): boolean {
  const context = tableContextAt(view.state, pos);
  if (!context) {
    return false;
  }

  const at = columnCount(context.table);
  focusAfter(view, context.from, HEADER_ROW, at);
  return write(view, context, withColumn(context.table, at), {
    row: HEADER_ROW,
    column: at,
    into: 0,
  });
}

/**
 * Removes the row the cursor is on. The header is not one of them: a table without a header is not a
 * table, and there is a delete for the whole thing when that is what was meant.
 */
export function removeRow(view: EditorView): boolean {
  const context = activeTable(view);
  if (!context || context.row < 0) {
    return false;
  }

  const table = withoutRow(context.table, context.row);
  const at = Math.min(context.row, table.rows.length - 1);
  focusAfter(view, context.from, at, context.column);

  return write(view, context, table, { row: at, column: context.column, into: 0 });
}

/** Removes the column the cursor is in, unless it is the only one there is. */
export function removeColumn(view: EditorView): boolean {
  const context = activeTable(view);
  if (!context || columnCount(context.table) <= 1) {
    return false;
  }

  const at = Math.max(0, context.column - 1);
  focusAfter(view, context.from, context.row, at);

  return write(view, context, withoutColumn(context.table, context.column), {
    row: context.row,
    column: at,
    into: 0,
  });
}

/** Aligns the column the cursor is in - which changes how it is padded here as well as how it renders. */
export function alignColumn(view: EditorView, align: Align): boolean {
  const context = activeTable(view);
  if (!context) {
    return false;
  }

  return write(view, context, withAlign(context.table, context.column, align), context);
}

/**
 * Writes one cell, which is what a drawn table's cells do as they are typed in.
 *
 * The whole table is rendered again, as with every other change here, so the markdown behind a drawn
 * table is laid out at every keystroke rather than only when somebody looks at it. The selection is
 * deliberately left alone: the caret is in the cell's own editable element, not in the document, and
 * moving the document's cursor would take the note out from under it.
 */
export function setCell(
  view: EditorView,
  from: number,
  row: number,
  column: number,
  text: string,
): boolean {
  const context = tableContextAt(view.state, from);
  if (!context) {
    return false;
  }

  const rendered = renderTable(withCell(context.table, row, column, escapeCell(text)));
  if (rendered === view.state.doc.sliceString(context.from, context.to)) {
    return false;
  }

  view.dispatch({
    changes: { from: context.from, to: context.to, insert: rendered },
    userEvent: 'input.table',
  });
  return true;
}

/** Moves a body row of the table starting at `from` to another position. */
export function moveRow(view: EditorView, from: number, row: number, to: number): boolean {
  const context = tableContextAt(view.state, from);
  if (!context) {
    return false;
  }

  return write(view, context, withMovedRow(context.table, row, to), {
    row: to,
    column: 0,
    into: 0,
  });
}

/** Moves the column the cursor or the edited cell is in, one place either way. */
export function shiftColumn(view: EditorView, by: -1 | 1): boolean {
  const context = activeTable(view);
  if (!context) {
    return false;
  }

  const to = context.column + by;
  if (to < 0 || to >= columnCount(context.table)) {
    return false;
  }
  focusAfter(view, context.from, context.row, to);

  return write(view, context, withMovedColumn(context.table, context.column, to), {
    row: context.row,
    column: to,
    into: 0,
  });
}

/** Moves the row the cursor or the edited cell is on, one place either way. */
export function shiftRow(view: EditorView, by: -1 | 1): boolean {
  const context = activeTable(view);
  if (!context || context.row < 0) {
    return false;
  }

  const to = context.row + by;
  if (to < 0 || to >= context.table.rows.length) {
    return false;
  }
  focusAfter(view, context.from, to, context.column);

  return write(view, context, withMovedRow(context.table, context.row, to), {
    row: to,
    column: context.column,
    into: 0,
  });
}

/** Removes the whole table, and the blank line it needed. */
export function removeTable(view: EditorView): boolean {
  const context = activeTable(view);
  if (!context) {
    return false;
  }

  const doc = view.state.doc;
  let from = context.from;
  // The newline the last row ends with goes too, or the table leaves an empty line behind it.
  const to = Math.min(doc.length, context.to + 1);

  // A table has to have a blank line either side of it or markdown reads the text around it as more
  // rows. Only one of those two is still needed once the table is gone, so when there is one on both
  // sides the one above leaves with it - otherwise deleting a table doubles the gap in the note.
  const above = from > 0 ? doc.lineAt(from - 1) : null;
  const below = to < doc.length ? doc.lineAt(to) : null;
  if (above && below && above.text.trim() === '' && below.text.trim() === '') {
    from = above.from;
  }

  view.dispatch({
    changes: { from, to, insert: '' },
    selection: { anchor: from },
    userEvent: 'delete.table',
  });
  view.focus();
  return true;
}

/**
 * Tab and Shift-Tab between cells of a table being shown as markdown. A drawn table's cells answer
 * Tab themselves (`tableWidget.ts`); this is the same behaviour for the text behind them.
 *
 * The delimiter row is stepped over rather than landed on: it is the table's machinery, not one of
 * its cells, and it is rewritten from the alignment every time the table is written out anyway.
 */
function moveCell(view: EditorView, step: 1 | -1): boolean {
  const context = tableAtCursor(view);
  if (!context) {
    return false;
  }

  const last = columnCount(context.table) - 1;
  let { row, column } = context;
  let table = context.table;

  if (step === 1) {
    if (column < last) {
      column += 1;
    } else {
      column = 0;
      row = row < 0 ? 0 : row + 1;
      if (row >= table.rows.length) {
        table = withRow(table, table.rows.length);
        row = table.rows.length - 1;
      }
    }
  } else if (column > 0) {
    column -= 1;
  } else if (row === HEADER_ROW || row === DELIMITER_ROW) {
    // The first cell of the table, with nowhere further back to go. Answering false here hands Tab
    // back to the page, so there is always a way out of a table with the keyboard alone.
    return false;
  } else {
    column = last;
    row = row === 0 ? HEADER_ROW : row - 1;
  }

  return write(view, context, table, { row, column, into: 0 });
}

/* ------------------------------------------------------------------ laying it out again */

/**
 * Re-lays-out a table once the cursor is no longer in it.
 *
 * The range of the table the cursor was last in is carried forward through every edit, so that a
 * table that moved down the document because something was typed above it is still the same table.
 * When the cursor is somewhere else, that range is looked at again and written back laid out.
 */
class FormatOnLeave implements PluginValue {
  private inside: { from: number; to: number } | null = null;
  private pending = false;
  private destroyed = false;

  constructor(private readonly view: EditorView) {
    this.inside = rangeAtCursor(view.state);
  }

  update(update: ViewUpdate): void {
    // Focus counts as well as edits and cursor moves: coming back into the editor without touching
    // the cursor has to re-establish which table it is in, or leaving it a second time would find
    // nothing to lay out.
    if (!update.docChanged && !update.selectionSet && !update.focusChanged) {
      return;
    }

    let previous = this.inside;
    if (previous && update.docChanged) {
      const from = update.changes.mapPos(previous.from, -1, MapMode.TrackDel);
      const to = update.changes.mapPos(previous.to, 1, MapMode.TrackDel);
      previous = from === null || to === null ? null : { from, to };
    }

    const current = rangeAtCursor(update.state);
    this.inside = current;

    if (previous && (!current || current.from !== previous.from)) {
      this.format(previous.from);
    }
  }

  destroy(): void {
    this.destroyed = true;
  }

  /** Lays out the table the cursor has just left, whether by moving or by losing focus. */
  formatLeft(): void {
    const at = this.inside;
    this.inside = null;
    if (at) {
      this.format(at.from);
    }
  }

  /**
   * On a microtask, because a transaction cannot be dispatched from inside an update - the same
   * reason the code-block widths go out this way. Everything is worked out again there: by then the
   * table may have moved, or stopped being one.
   */
  private format(pos: number): void {
    if (this.pending) {
      return;
    }
    this.pending = true;

    void Promise.resolve().then(() => {
      this.pending = false;
      if (this.destroyed) {
        return;
      }

      const context = tableContextAt(this.view.state, pos);
      if (!context) {
        return;
      }

      const rendered = renderTable(context.table);
      if (rendered === this.view.state.doc.sliceString(context.from, context.to)) {
        return;
      }

      // No selection of our own: the cursor is not in this table any more, and CodeMirror maps it
      // through the change on its own.
      this.view.dispatch({
        changes: { from: context.from, to: context.to, insert: rendered },
        userEvent: 'input.table.format',
      });
    });
  }
}

function rangeAtCursor(state: EditorState): { from: number; to: number } | null {
  const context = tableContextAt(state, state.selection.main.head);
  return context ? { from: context.from, to: context.to } : null;
}

const formatOnLeave = ViewPlugin.fromClass(FormatOnLeave, {
  eventHandlers: {
    // Clicking away, switching notes, closing the tab: the table is left just as surely as it is by
    // an arrow key, and this is the last chance to lay it out before the autosave takes a copy.
    blur() {
      this.formatLeft();
    },
  },
});

/**
 * Forgets which cell was last pointed at, the moment something else is pointed at.
 *
 * `activeCell` is how a table says which one a command is about, because a right-click does not
 * focus a cell in every browser. Left to itself it is sticky: after touching a table once, a
 * right-click anywhere in the note - a paragraph, another table, empty space - still found that
 * cell, and the menu offered "Delete row" for a table nobody was pointing at.
 */
const forgetCellElsewhere = EditorView.domEventHandlers({
  pointerdown(event, view) {
    const target = event.target;
    const inTable = target instanceof Element && target.closest('.cm-table') !== null;

    if (!inTable && activeCellOf(view.state) !== null) {
      view.dispatch({ effects: setActiveCell.of(null) });
    }

    // Never handled here: this only watches, and everything else still happens.
    return false;
  },
});

/**
 * Keeps the blank line under a table blank.
 *
 * A GFM table runs on until a blank line, so that blank line is the only thing separating it from
 * whatever comes next. Type a single character on it and the table swallows it *and* every
 * non-blank line after it: a note with two paragraphs under a table loses both into the table on
 * the first keystroke. That is markdown behaving correctly and is never what the person typing
 * meant - they aimed at the gap under a table, which is where you write the next paragraph.
 *
 * So text typed or pasted onto that line is pushed one line down, and the blank line stays. What is
 * inserted is the same text either way; only where it lands changes.
 */
const keepTableClosed = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || (!tr.isUserEvent('input') && !tr.isUserEvent('paste'))) {
    return tr;
  }

  const state = tr.startState;
  let push: { at: number; text: string } | undefined;
  let changes = 0;

  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    changes += 1;
    if (changes > 1 || fromA !== toA || inserted.length === 0) {
      return;
    }

    const line = state.doc.lineAt(fromA);
    if (line.length !== 0 || line.number === 1) {
      return;
    }

    // The line above has to be the end of a table, and non-blank - two blank lines in a row means
    // the table was already closed by the first one.
    const above = state.doc.line(line.number - 1);
    if (above.length === 0 || !inTable(syntaxTree(state).resolveInner(above.to, -1))) {
      return;
    }

    push = { at: fromA, text: inserted.toString() };
  });

  const pushed: { at: number; text: string } | undefined = push;
  if (!pushed || changes !== 1) {
    return tr;
  }

  const { at, text } = pushed;
  return {
    changes: { from: at, insert: `\n${text}` },
    selection: { anchor: at + 1 + text.length },
    scrollIntoView: true,
    userEvent: tr.isUserEvent('paste') ? 'input.paste' : 'input.type',
  };
});

/**
 * Somewhere to write when a table is the last thing in the note.
 *
 * A GFM table runs on until a blank line, so the line after its last row *is* another row. When the
 * table ends the note there is no line after it at all, and clicking the empty space below the
 * editor puts the caret at the end of the last row - where typing quietly grows the table instead
 * of starting a paragraph under it.
 *
 * So a click below everything makes the line it needs. The document is only changed because
 * somebody pointed at the empty space and meant "I want to write here": nothing is inserted when a
 * note is merely opened, which would otherwise put a version in the history of every note that
 * happens to end with a table.
 */
const roomBelowTable = EditorView.domEventHandlers({
  mousedown(event, view) {
    const { doc } = view.state;
    const end = doc.length;

    // Below the last line, rather than in it. `coordsAtPos` is null when the end is not drawn,
    // which is a scrolled-away document and not a click under the last line.
    const bottom = view.coordsAtPos(end)?.bottom;
    if (bottom === undefined || event.clientY <= bottom) {
      return false;
    }

    const last = doc.lineAt(end);
    if (last.length === 0) {
      // There is already a blank line to land on.
      return false;
    }

    const node = syntaxTree(view.state).resolveInner(end, -1);
    if (!inTable(node)) {
      return false;
    }

    view.dispatch({
      changes: { from: end, insert: '\n\n' },
      selection: { anchor: end + 2 },
      userEvent: 'input',
      scrollIntoView: true,
    });
    return true;
  },
});

/** Whether a position is inside a table, at any depth. */
function inTable(node: SyntaxNode | null): boolean {
  for (let current = node; current; current = current.parent) {
    if (current.name === 'Table') {
      return true;
    }
  }
  return false;
}

export const tables: Extension = [
  tableState,
  formatOnLeave,
  forgetCellElsewhere,
  roomBelowTable,
  keepTableClosed,
  keymap.of([
    // Only when there is a table to move around in. Returning false the rest of the time leaves Tab
    // doing what it does everywhere else on the page, which is how somebody using the keyboard gets
    // back out of the editor.
    { key: 'Tab', run: (view) => moveCell(view, 1) },
    { key: 'Shift-Tab', run: (view) => moveCell(view, -1) },
  ]),
];
