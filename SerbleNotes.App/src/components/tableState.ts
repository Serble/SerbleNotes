import { MapMode, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';

/**
 * The two things the editor has to remember about a table that are not in the note.
 *
 * **Which tables are being shown as text.** A table is drawn as a table; the button on it shows the
 * markdown instead. That is a view of the note, not a fact about it - nobody wants their choice of
 * how to look at a table synced to their phone - so it lives here, keyed by where the table starts
 * and carried through every edit so a table that moved down the document is still the same table.
 *
 * **Which cell is being edited.** The cells of a drawn table are their own editable islands, so the
 * editor's cursor is not in one of them and cannot say which. Everything that acts on "this table" -
 * the context menu, the commands behind it - asks here first and falls back to the cursor, which is
 * what makes one menu work in both views.
 */

export interface ActiveCell {
  /** Where the table starts, which is how every table in here is named. */
  from: number;
  row: number;
  column: number;
}

/** Turns the text view of one table on or off. `from` is in the coordinates of the new document. */
export const setTextMode = StateEffect.define<{ from: number; on: boolean }>();

/** Says which cell is being edited, or clears it when nothing is. */
export const setActiveCell = StateEffect.define<ActiveCell | null>();

const textMode = StateField.define<readonly number[]>({
  create: () => [],

  update(value, transaction) {
    let next = value;

    if (transaction.docChanged) {
      // A table that was edited out of existence takes its entry with it; one that merely moved
      // keeps it. `TrackDel` is what tells the two apart.
      const moved: number[] = [];
      for (const from of next) {
        const at = transaction.changes.mapPos(from, -1, MapMode.TrackDel);
        if (at !== null) {
          moved.push(at);
        }
      }
      next = moved;
    }

    for (const effect of transaction.effects) {
      if (effect.is(setTextMode)) {
        const without = next.filter((from) => from !== effect.value.from);
        next = effect.value.on ? [...without, effect.value.from] : without;
      }
    }

    return next;
  },
});

const activeCell = StateField.define<ActiveCell | null>({
  create: () => null,

  update(value, transaction) {
    let next = value;

    if (next && transaction.docChanged) {
      const from = transaction.changes.mapPos(next.from, -1, MapMode.TrackDel);
      next = from === null ? null : { ...next, from };
    }

    for (const effect of transaction.effects) {
      if (effect.is(setActiveCell)) {
        next = effect.value;
      }
    }

    return next;
  },
});

/** Whether the table starting here is being shown as markdown rather than drawn. */
export function isTextMode(state: EditorState, from: number): boolean {
  return state.field(textMode).includes(from);
}

/** Every table currently being shown as markdown. */
export function textModeTables(state: EditorState): readonly number[] {
  return state.field(textMode);
}

/** The cell being edited in a drawn table, if one is. */
export function activeCellOf(state: EditorState): ActiveCell | null {
  return state.field(activeCell);
}

export const tableState: Extension = [textMode, activeCell];

/* ------------------------------------------------------------------ where the caret goes next */

/**
 * The cell to put the caret in once the table it belongs to is next drawn.
 *
 * Anything that changes a table's *shape* - a row added, a column removed - replaces the widget's
 * DOM, so the focus cannot simply be left where it was. This is a module-level variable rather than
 * another field because it is read once, immediately, by the render that the change itself caused,
 * and would be stale a moment later. It lives here so that the commands and the widget can both
 * reach it without importing each other.
 */
let pending: ActiveCell | null = null;

/** Asks for the caret to land in this cell when its table is drawn. */
export function focusCellAfterRender(cell: ActiveCell): void {
  pending = cell;
}

/** The request, if it is for the table starting at `from`. Reading it takes it. */
export function takeFocusRequest(from: number): ActiveCell | null {
  if (!pending || pending.from !== from) {
    return null;
  }
  const cell = pending;
  pending = null;
  return cell;
}
