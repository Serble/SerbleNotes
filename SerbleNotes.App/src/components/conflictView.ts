import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { conflictsIn, conflictsShownAsText, isConflictMarker } from './conflicts';
import { ConflictSourceBar, ConflictWidget } from './conflictWidget';

/**
 * Which conflicts are drawn, and which are left as their markers.
 *
 * The same shape as `tableView.ts`, and a **state field** for the same reason: replacing eight lines
 * with one card changes the block structure of the document, and a decoration that does that is not
 * allowed to come from a view plugin, because a plugin only sees the viewport and the editor needs
 * the heights of everything to know what the viewport is.
 *
 * There is deliberately no "shows its markers while the cursor is in it" rule, which is how the rest
 * of the live preview works. The card is not text with markup hidden - it is a choice between two
 * versions, and its own contents are not part of the document at all, so the cursor is never inside
 * one. The "Text" button is the way back, as it is for a table.
 */

function build(state: EditorState): DecorationSet {
  const raw = conflictsShownAsText(state);
  const decorations: Range<Decoration>[] = [];

  for (const conflict of conflictsIn(state)) {
    if (raw.includes(conflict.from)) {
      // Shown as written. `livePreview` leaves the region alone entirely (see `rawConflictRanges`),
      // so what is on screen is the text and nothing else; these classes only set it in monospace
      // and colour the markers so they read as markers.
      //
      // The bar above it carries the way back. Without it the source is a room with no door: the
      // "Text" button that got you here belongs to the card, and the card is what you just replaced.
      decorations.push(
        Decoration.widget({
          widget: new ConflictSourceBar(conflict.from),
          block: true,
          side: -1,
        }).range(conflict.from),
      );

      const last = state.doc.lineAt(conflict.to);
      for (let at = conflict.from; at <= last.from; ) {
        const line = state.doc.lineAt(at);
        decorations.push(
          Decoration.line({
            class: isConflictMarker(line.text)
              ? 'cm-conflict-raw cm-conflict-raw-marker'
              : 'cm-conflict-raw',
          }).range(line.from),
        );
        if (line.to >= last.to) {
          break;
        }
        at = line.to + 1;
      }
      continue;
    }

    decorations.push(
      Decoration.replace({
        widget: new ConflictWidget(conflict),
        block: true,
      }).range(conflict.from, conflict.to),
    );
  }

  return Decoration.set(decorations, true);
}

const conflictDecorations = StateField.define<DecorationSet>({
  create: (state) => build(state),

  update(value, transaction) {
    if (
      transaction.docChanged ||
      conflictsShownAsText(transaction.state) !== conflictsShownAsText(transaction.startState)
    ) {
      return build(transaction.state);
    }
    return value;
  },

  provide: (field) => EditorView.decorations.from(field),
});

export const conflictView: Extension = [conflictDecorations];
