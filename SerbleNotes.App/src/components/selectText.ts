import type { EditorView } from '@codemirror/view';
import { type CellText, selectInCell } from './cellText';

/**
 * Selecting text from the menu, because a long press cannot.
 *
 * Every platform's own text menu offers "Select" and "Select all", and on a touchscreen they are
 * the only way to select anything here: the gesture that would start a selection is the one this
 * app takes for its own context menu, so without these two there is no way to get a word onto the
 * clipboard with a finger. On a desktop they are a convenience; on a phone they are the feature.
 *
 * Two things can hold the text. The note is one. The other is a cell of a drawn table, which is its
 * own editable island - so "select all" there means the cell, not the note behind it. Selecting the
 * whole document from inside a cell would answer a question nobody asked, and what is usually
 * pressed after "select all" is "cut". `cellText.ts` is that half of it, and it is passed in rather
 * than looked up here so that one menu is built from one reading of where the text is.
 */

/** What a menu item needs: a way to do it, or null when there is nothing there to select. */
export type Selecting = (() => void) | null;

/** What counts as one word: what the caret runs over as a unit. */
const WORD = /[\p{L}\p{N}_]/u;

/** Everything - the whole note, or the whole of the cell being edited. */
export function selectAll(view: EditorView, cell: CellText | null): Selecting {
  if (cell) {
    return cell.text.length === 0 ? null : () => selectInCell(view, 0, cell.text.length);
  }

  if (view.state.doc.length === 0) {
    return null;
  }
  return () => {
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length }, userEvent: 'select' });
    view.focus();
  };
}

/** The word the caret is in or against, the way every platform's "Select" reads it. */
export function selectWord(view: EditorView, cell: CellText | null): Selecting {
  if (cell) {
    const word = wordAround(cell.text, cell.from);
    return word ? () => selectInCell(view, word.from, word.to) : null;
  }

  if (!view.state.wordAt(view.state.selection.main.head)) {
    return null;
  }
  return () => {
    // Read again rather than using what the menu was built from: opening the menu moves the cursor,
    // and a cursor leaving a table shown as markdown lays that table out, which moves everything
    // after it. The same rule every other command in this menu follows.
    const word = view.state.wordAt(view.state.selection.main.head);
    if (word) {
      view.dispatch({ selection: word, userEvent: 'select' });
      view.focus();
    }
  };
}

/** The run of word characters `at` sits in, or is touching. Null when it is touching none. */
function wordAround(text: string, at: number): { from: number; to: number } | null {
  let from = Math.max(0, Math.min(at, text.length));
  let to = from;

  while (from > 0 && WORD.test(text[from - 1]!)) {
    from--;
  }
  while (to < text.length && WORD.test(text[to]!)) {
    to++;
  }

  return from === to ? null : { from, to };
}
