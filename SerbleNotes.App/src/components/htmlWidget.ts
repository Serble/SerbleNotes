import { WidgetType } from '@codemirror/view';
import { renderNoteHtml } from './noteHtml';

/**
 * A run of HTML in a note, drawn as what it says.
 *
 * The same rule as everything else in the live preview - what is written is what is shown, and the
 * markup comes back when the cursor is on it - applied to a whole block rather than to a span of
 * characters. It has to be a widget because there is nothing else it could be: `<table>` written as
 * HTML is a table, and no amount of decorating the characters `<`, `t`, `a` will make a row out of
 * them.
 */
export class NoteHtmlWidget extends WidgetType {
  constructor(readonly html: string, readonly inline = false) {
    super();
  }

  eq(other: NoteHtmlWidget): boolean {
    return other.html === this.html && other.inline === this.inline;
  }

  toDOM(): HTMLElement {
    const host = document.createElement(this.inline ? 'span' : 'div');
    host.className = this.inline ? 'cm-note-html cm-note-html-inline' : 'cm-note-html';
    // The editor's document is contenteditable and this is not part of it. Without this the caret
    // can be put inside a rendered table, where there is no text for it to be in.
    host.contentEditable = 'false';
    host.appendChild(renderNoteHtml(this.html));
    return host;
  }

  /**
   * Everything in here is the widget's own. A click on a link inside it is handled by the listener
   * `renderNoteHtml` attached, and a selection dragged across a rendered table is the browser's,
   * not a range in a document that does not have one here.
   */
  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * A note's CSS, which is not drawn where it was written.
 *
 * A `<style>` block styles the whole note, so rendering it in place would be showing a rule at the
 * bottom of a note that is affecting a paragraph at the top. It collapses to a chip instead, which
 * is small, says what it is, and puts the caret back in the stylesheet when it is clicked - the same
 * way the raw markup comes back everywhere else.
 */
export class NoteCssWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const chip = document.createElement('div');
    chip.className = 'cm-note-css';
    chip.contentEditable = 'false';
    chip.textContent = 'CSS';
    chip.title = 'Styles for this note. Click to edit them.';
    return chip;
  }

  /** A click has to reach the editor, or there is no way back to the text. */
  ignoreEvent(): boolean {
    return false;
  }
}
