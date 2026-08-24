import type { EditorView } from '@codemirror/view';
import { type ActiveCell, activeCellOf } from './tableState';
import { cellElement } from './tableWidget';
import { setCell } from './tables';

/**
 * The text of the cell being edited, for the things outside the widget that act on it.
 *
 * A drawn table's cells are their own editable islands and the editor's cursor is never inside one
 * (see `tableWidget.ts`), so every command written in terms of the document's selection - cut, copy,
 * paste, select - is about the wrong text while a cell is being edited. It would act on wherever the
 * cursor happened to be left, which is not somewhere the user can see, and for paste that means text
 * arriving pages away from where it was asked for.
 *
 * **All of it is read when the menu is built, not when an item is pressed.** Pressing a menu item
 * takes the focus; a cell that loses focus commits what is in it and goes back to drawing its
 * markdown rather than showing it, and the DOM selection inside it is gone. The offsets survive
 * that, because the commit writes the same text back, so the offsets are what is kept - and the
 * element, which does not survive, is looked up again by the three numbers that name the cell.
 */

export interface CellText {
  /** The cell, as `tableState` names it. */
  cell: ActiveCell;
  /** What it said when the menu was built. */
  text: string;
  /** What was selected in it then, as offsets into that text. Equal when nothing was. */
  from: number;
  to: number;
}

/**
 * The cell being edited and what was selected in it, or null when the text in hand is the note's.
 *
 * `tableState` remembers which cell was last edited and is not told when the cursor goes back to
 * the note - nothing about a cell losing focus says where the focus went, and the table commands
 * want the last cell either way. That is no good here: acting on a cell somebody left ten minutes
 * ago would paste into it rather than where the cursor is. So the cell has to hold the caret *now*,
 * which is asked of the page rather than of the editor - a focused cell is precisely the case where
 * the editor does not have the focus. Being pointed at counts, because a right-click does not focus
 * a cell in every browser, and that is the one thing this is asked immediately after.
 */
export function editedCell(view: EditorView): CellText | null {
  const cell = activeCellOf(view.state);
  const element = cell && cellElement(view, cell);
  if (!cell || !element) {
    return null;
  }

  const selection = window.getSelection();
  const holds = (node: Node | null | undefined) => node != null && element.contains(node);
  if (!holds(document.activeElement) && !holds(selection?.anchorNode)) {
    return null;
  }

  return { cell, text: element.textContent ?? '', ...selectionIn(element) };
}

/**
 * Puts a selection across part of the cell being edited.
 *
 * Focusing comes first and is not incidental: a focused cell shows its markdown rather than what
 * that markdown draws, and these offsets are into the markdown. The swap happens inside the cell's
 * own focus handler, so it has already happened when the range is built - and the cell is then a
 * single text node, because that is what setting `textContent` leaves behind.
 */
export function selectInCell(view: EditorView, from: number, to: number): void {
  const cell = activeCellOf(view.state);
  const element = cell && cellElement(view, cell);
  if (!element) {
    return;
  }

  element.focus();

  const text = element.firstChild;
  const selection = window.getSelection();
  if (!(text instanceof Text) || !selection) {
    return;
  }

  const range = document.createRange();
  range.setStart(text, Math.min(from, text.length));
  range.setEnd(text, Math.min(to, text.length));
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Replaces what was selected in the cell, as an ordinary edit to the note.
 *
 * `setCell` writes the whole table back laid out, like every other change to one, so nothing here
 * has to know about pipes or escaping - and a paste carrying line breaks becomes one line rather
 * than being refused, because that is what a cell can hold. The caret is then put where the
 * replacement ends, which is where somebody who just pasted expects to carry on typing.
 */
export function replaceInCell(view: EditorView, target: CellText, insert: string): void {
  // The live one rather than the captured one: it is mapped through anything that has changed the
  // document since the menu was built, and it names the same cell.
  const cell = activeCellOf(view.state) ?? target.cell;
  const text = target.text.slice(0, target.from) + insert + target.text.slice(target.to);

  setCell(view, cell.from, cell.row, cell.column, text);

  const caret = target.from + insert.length;
  selectInCell(view, caret, caret);
}

function selectionIn(cell: HTMLElement): { from: number; to: number } {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return { from: 0, to: 0 };
  }

  const at = selection.getRangeAt(0);
  if (!cell.contains(at.startContainer) || !cell.contains(at.endContainer)) {
    return { from: 0, to: 0 };
  }

  return {
    from: offsetIn(cell, at.startContainer, at.startOffset),
    to: offsetIn(cell, at.endContainer, at.endOffset),
  };
}

/** How far into the cell's text a DOM position is: the length of everything before it. */
function offsetIn(cell: HTMLElement, node: Node, offset: number): number {
  const before = document.createRange();
  before.selectNodeContents(cell);
  before.setEnd(node, offset);
  return before.toString().length;
}
