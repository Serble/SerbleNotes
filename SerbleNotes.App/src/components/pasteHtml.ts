import { EditorSelection, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { htmlToMarkdown } from './htmlToMarkdown';

/**
 * Pasting formatted text into a note, as the markdown it was.
 *
 * Every application worth copying out of puts two flavours on the clipboard: the words, and the
 * same thing as HTML. CodeMirror's own paste reads the first, which is why a masked link used to
 * arrive as its label with the address gone, a heading as a line of prose, and a table as a row of
 * words. This reads the second, and `htmlToMarkdown` says what it means.
 *
 * **It is an addition, never a replacement.** Where there is no HTML flavour, where it converts to
 * nothing, or where it converts to exactly the text that was already on the clipboard, this does
 * nothing at all and CodeMirror pastes as it always did - so the only pastes that behave
 * differently are the ones that were losing something. That is also what makes Ctrl-Shift-V work
 * with no code: the browser leaves the HTML flavour off the event when a plain paste is asked for,
 * and there is then nothing here to act on. The editor's own menu offers "Paste as text" for the
 * same job, because a menu item cannot be modified by holding a key.
 */
export const pasteHtml: Extension = EditorView.domEventHandlers({
  paste(event, view) {
    const data = event.clipboardData;
    if (!data) {
      return false;
    }

    const markdown = pasteMarkdown(view.state, data.getData('text/html'), data.getData('text/plain'));
    if (markdown === null) {
      return false;
    }

    view.dispatch(
      view.state.changeByRange((range) => ({
        changes: { from: range.from, to: range.to, insert: markdown },
        range: EditorSelection.cursor(range.from + markdown.length),
      })),
      { userEvent: 'input.paste', scrollIntoView: true },
    );
    return true;
  },
});

/**
 * What this paste should insert, or null to leave it to CodeMirror.
 *
 * Separated from the event so it can be tested: whether a paste is converted depends on where the
 * cursor is in the document, and that is a decision with two quiet ways to be wrong - converting
 * inside a code block, and failing to convert everywhere else.
 */
export function pasteMarkdown(state: EditorState, html: string, plain: string): string | null {
  if (!html.trim() || literalHere(state)) {
    return null;
  }

  const markdown = htmlToMarkdown(html);
  if (!markdown || markdown === plain.replace(/\r\n?/g, '\n').trim()) {
    return null;
  }
  return markdown;
}

/**
 * Node names that mean "the text here is itself", and the one that means "these lines have a shape".
 *
 * A fenced block, an indented one or a code span is a place where markdown means nothing, so
 * turning a pasted heading into a `#` there would be writing markup into a document that asked for
 * none - and a snippet copied off a documentation page would arrive with the page's formatting
 * baked into the code. A table's markdown is the other case: those lines *are* the table, and a
 * list dropped into the middle of them is neither a list nor a table afterwards. A table that is
 * drawn rather than shown as source never reaches here at all - its cells are their own editable
 * islands, and `tableWidget.ts` converts to inline markdown for them.
 */
const LITERAL = new Set(['FencedCode', 'CodeBlock', 'CodeText', 'InlineCode', 'Table', 'Comment', 'CommentBlock']);

function literalHere(state: EditorState): boolean {
  const tree = syntaxTree(state);

  for (const range of state.selection.ranges) {
    // Both sides, because a position on the edge of a block resolves outside it - the same thing
    // the copy button had to learn in `copyCode.ts`.
    for (const side of [-1, 1] as const) {
      for (let node = tree.resolveInner(range.from, side); node.parent; node = node.parent) {
        if (LITERAL.has(node.name)) {
          return true;
        }
      }
    }
  }
  return false;
}
