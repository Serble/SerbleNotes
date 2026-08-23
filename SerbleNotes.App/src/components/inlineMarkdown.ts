import { marked } from 'marked';
import { drawsFaithfully, sanitiseHtml } from './noteHtml';

/**
 * One line of markdown, rendered to inert HTML.
 *
 * This exists for table cells, which are the one place in the editor where markdown has to become
 * markup rather than be decorated in place: a cell is a widget, not a run of text, so there are no
 * character offsets for the live preview to hang decorations off. Everything else in a note is
 * still styled by `livePreview`.
 *
 * **What a cell may say is what a note may say.** The policy is noteHtml.ts, the same one the editor
 * and the rendered preview use: tags, attributes, `style`, `<font>` - and no script, no event
 * handler and no remote fetch anywhere in it. `marked` is told to parse inline only, so a cell can
 * never introduce a block: a heading or a list inside one cell would be markup the table has nowhere
 * to put.
 *
 * A link in a cell is drawn as a link and opened the way the editor opens one - Ctrl-click, or the
 * long-press menu. A plain click puts the caret in it, because a cell is a thing you type in.
 */
export function renderInline(source: string): string {
  const html = marked.parseInline(source, { async: false });

  // Drawn only if drawing it would still say everything it says - see drawsFaithfully. What this
  // app will not render, a cell shows as the text it is.
  if (!drawsFaithfully(html)) {
    return escapeHtml(source);
  }

  return sanitiseHtml(html);
}

/**
 * Whether a string would render as anything other than itself.
 *
 * Cells that hold no markup are the common case, and they are left exactly as they are - which is
 * what keeps the caret where it was put when one is clicked into.
 */
export function hasMarkup(source: string): boolean {
  return renderInline(source) !== escapeHtml(source);
}

function escapeHtml(text: string): string {
  const holder = document.createElement('span');
  holder.textContent = text;
  return holder.innerHTML;
}
