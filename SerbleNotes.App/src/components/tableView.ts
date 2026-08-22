import { syntaxTree } from '@codemirror/language';
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { readTable } from './tableFormat';
import { textModeTables } from './tableState';
import { TableWidget } from './tableWidget';

/**
 * Which tables are drawn, and which are left as markdown.
 *
 * Every table in the note is replaced by a `TableWidget` unless somebody has asked for its text with
 * the button on it. That is the whole rule - there is deliberately no "shown as text while the
 * cursor is in it", which is how the rest of the live preview works: a drawn table's cells are their
 * own editable islands, so the cursor is never inside one, and a rule that could only fire while
 * somebody was hand-typing a table would be a rule almost nobody would ever see fire.
 *
 * This has to be a **state field** rather than a view plugin. A decoration that changes the block
 * structure of the document - which replacing three lines with one element does - is not allowed to
 * come from a plugin, because the plugin only sees the viewport and the editor needs the heights of
 * everything to know what the viewport is.
 *
 * The cost of that is working over the whole document rather than the visible part of it. It is paid
 * only when something changed: an edit, somebody pressing the text button, or the parser reaching
 * further into a long note than it had before - which is the last of the three that is easy to
 * forget, and shows up as a table further down the note that never becomes one.
 */

function build(state: EditorState): DecorationSet {
  const raw = textModeTables(state);
  const decorations: Range<Decoration>[] = [];

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'Table') {
        return undefined;
      }

      // Whole lines: the parser's idea of where a table starts is past any indent, and a block
      // replacement has to cover the lines it replaces exactly.
      const first = state.doc.lineAt(node.from);
      const last = state.doc.lineAt(node.to);

      const table = raw.includes(first.from)
        ? null
        : readTable(state.doc.sliceString(first.from, last.to));

      if (table) {
        decorations.push(
          Decoration.replace({
            widget: new TableWidget(first.from, table),
            block: true,
          }).range(first.from, last.to),
        );
      }

      // Nothing inside a table needs decorating, drawn or not.
      return false;
    },
  });

  return Decoration.set(decorations, true);
}

const tableDecorations = StateField.define<DecorationSet>({
  create: (state) => build(state),

  update(value, transaction) {
    if (
      transaction.docChanged ||
      textModeTables(transaction.state) !== textModeTables(transaction.startState) ||
      // The parser advancing is a change to what tables exist, and it arrives in a transaction of
      // its own with nothing else in it.
      syntaxTree(transaction.state) !== syntaxTree(transaction.startState)
    ) {
      return build(transaction.state);
    }
    return value;
  },

  provide: (field) => EditorView.decorations.from(field),
});

export const tableView: Extension = [tableDecorations];
