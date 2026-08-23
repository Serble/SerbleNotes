import { syntaxTree } from '@codemirror/language';
import { keymap, type EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

/**
 * Enter, in a list.
 *
 * A list is the one piece of markdown where the next line is nearly always more of the same, so
 * Enter writes the next item's marker rather than leaving someone to type it again at the right
 * indent. Enter on an item with nothing in it means the opposite - the list is finished - so it
 * clears the marker instead of writing another one, which is how every editor that does this
 * behaves and is the only way out that does not involve deleting what was just inserted.
 *
 * The marker is read off the line with a regular expression rather than out of the syntax tree.
 * The tree says "this is a ListItem", which is the easy half; what is needed here is the exact text
 * that starts the line - its indent, its marker, and the spacing after it - so that the next line
 * is written the way this one was rather than the way this app would have written it.
 */
const MARKER = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\](?:\s+|$))?/;

function continueList(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty) {
    return false;
  }

  const line = state.doc.lineAt(range.head);
  const match = MARKER.exec(line.text);
  if (!match) {
    return false;
  }

  const [prefix, indent, marker, space, task] = match;

  // The parser has the final say on whether this is a list: a line inside a fenced code block can
  // start with "- " and mean nothing of the sort.
  //
  // Asked at the marker rather than at the end of the line. An item with nothing in it ends where
  // its marker does, so looking forward from the end of one lands past it, in the list rather than
  // in the item - and "- " with the cursor after it is exactly the case that has to be recognised,
  // because it is the one that means "this list is finished".
  const node = syntaxTree(state).resolveInner(line.from + indent.length, 1);
  if (!inList(node)) {
    return false;
  }

  // The caret in the middle of the marker is not somebody adding an item; leave Enter alone.
  if (range.head < line.from + prefix.length) {
    return false;
  }

  if (line.text.slice(prefix.length).trim() === '') {
    // An item with nothing in it: the list ends here rather than growing by one more empty item.
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: '' },
      selection: { anchor: line.from },
      userEvent: 'input',
    });
    return true;
  }

  const insert = `\n${indent}${next(marker)}${space}${task ? task.replace(/[xX]/, ' ') : ''}`;
  view.dispatch({
    changes: { from: range.head, to: range.head, insert },
    selection: { anchor: range.head + insert.length },
    userEvent: 'input',
    scrollIntoView: true,
  });
  return true;
}

/** The next item's marker: a bullet repeats, a number counts on. */
function next(marker: string): string {
  const number = /^(\d+)([.)])$/.exec(marker);
  return number ? `${Number(number[1]) + 1}${number[2]}` : marker;
}

function inList(node: { name: string; parent: unknown } | null): boolean {
  for (let current = node; current; current = current.parent as typeof current) {
    if (current.name === 'ListItem') {
      return true;
    }
  }
  return false;
}

/** Bound ahead of the default Enter, which would otherwise just break the line. */
export const listKeys: Extension = keymap.of([{ key: 'Enter', run: continueList }]);
