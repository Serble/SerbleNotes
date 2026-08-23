import { syntaxTree } from '@codemirror/language';
import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type PluginValue,
  type ViewUpdate,
} from '@codemirror/view';
import { NoteCssWidget, NoteHtmlWidget } from './htmlWidget';
import {
  cssIn,
  drawsFaithfully,
  isKnownTag,
  isOnlyStyle,
  scopeCss,
  tagAttributes,
  tagsIn,
  VOID_TAGS,
  type TagToken,
} from './noteHtml';

/**
 * HTML written as blocks in a note: what is drawn, what is hidden, and what the note's own CSS is
 * allowed to reach.
 *
 * A block of HTML is replaced by what it renders to, and the source comes back when the cursor is in
 * it. Like the table widget - and for the same reason - this is a **state field** rather than a view
 * plugin: replacing four lines with one element changes the block structure of the document, and a
 * plugin only sees the viewport, which the editor cannot work out until it knows the heights of
 * everything.
 *
 * Inline HTML - a tag in the middle of a sentence - is not here. It stays a run of characters with a
 * real element wrapped round it by `livePreview`, because that is what lets the text inside it still
 * be typed in.
 *
 * ### Markdown inside HTML
 *
 * The case that makes this more than "render the block":
 *
 * ```
 * <div class="warning">
 *
 * Some **markdown**.
 *
 * </div>
 * ```
 *
 * A blank line ends an HTML block, so CommonMark sees three things here: an open tag, a paragraph,
 * and a close tag. Rendering each on its own would give an empty div, some markdown, and nothing -
 * which is why this pattern is written everywhere and works almost nowhere.
 *
 * So an HTML block that is nothing but tags is treated as a **boundary**. An opening tag with no
 * closing tag waits for the block that closes it; the two are then hidden, and what the tag was
 * setting - its `style`, its `class`, its `align` - is put on every line between them. The markdown
 * in the middle is still markdown, still editable, and is now inside the thing that was wrapped
 * round it. A tag that is never closed is left as the text it is, exactly as an unclosed inline tag
 * is.
 *
 * What that does *not* do is give the wrapper the element's own default box: a `<blockquote>` used
 * this way indents nothing by itself. It carries the styling that was asked for, which is what the
 * tag was written for, and a note wanting the rest can say so in its CSS.
 */

/* ------------------------------------------------------------------------------------- focus */

const setFocused = StateEffect.define<boolean>();

/**
 * Whether the editor has focus, as a piece of state.
 *
 * The live preview only reveals markup while somebody is actually typing - a cursor in an editor
 * nobody is in is where you *were*, and it starts at position 0. A view plugin can ask the view; a
 * state field cannot, so the answer is put into the state when it changes. Without this, a note that
 * begins with an HTML block would open showing its source, for no reason a reader could see.
 */
const focused = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setFocused)) {
        value = effect.value;
      }
    }
    return value;
  },
});

const trackFocus = EditorView.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing));

/* ------------------------------------------------------------------------------- decorations */

/** An opening tag that is waiting for the block that closes it. */
interface Wrapper {
  name: string;
  /** The lines the opening tag was on, hidden only once it turns out to be a wrapper. */
  block: { from: number; to: number };
  /** The first line inside it. */
  firstLine: number;
  style: string;
  className: string;
}

/** The block-level styling an opening tag asks for, as a `style` attribute's worth of text. */
function styleOf(token: TagToken): { style: string; className: string } {
  const attributes = tagAttributes(token.raw, token.name);
  if (!attributes) {
    return { style: '', className: '' };
  }

  const parts: string[] = [];
  if (token.name === 'center') {
    parts.push('text-align: center');
  }
  if (attributes.align) {
    parts.push(`text-align: ${attributes.align}`);
  }
  if (attributes.style) {
    parts.push(attributes.style);
  }

  return { style: parts.join('; '), className: attributes.class ?? '' };
}

/** Whether a run of HTML is tags and nothing else, which is what makes it a boundary. */
function onlyTags(text: string, tokens: TagToken[]): boolean {
  let bare = text;
  for (let at = tokens.length - 1; at >= 0; at -= 1) {
    bare = bare.slice(0, tokens[at].from) + bare.slice(tokens[at].to);
  }
  return bare.trim() === '';
}

function build(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const hasFocus = state.field(focused);

  /** Openings still looking for their close, innermost last. */
  const open: Wrapper[] = [];
  /** Boundary blocks that turned out to be one, by where they start, so none is hidden twice. */
  const hidden = new Map<number, { from: number; to: number }>();

  const touched = (from: number, to: number) =>
    hasFocus && state.selection.ranges.some((range) => range.from <= to && range.to >= from);

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'HTMLBlock') {
        return undefined;
      }

      // Whole lines: a block replacement has to cover exactly the lines it replaces, and the
      // parser's idea of where a block starts is past any indent.
      const first = state.doc.lineAt(node.from);
      const last = state.doc.lineAt(node.to);
      const block = { from: first.from, to: last.to };
      const text = state.doc.sliceString(block.from, block.to);
      const tokens = tagsIn(text);

      // The note's own stylesheet, which is applied to the whole note by NoteStyles below rather
      // than drawn where it sits. Asked first because `<style>` is deliberately not a tag this app
      // renders - it is the one piece of HTML that means something somewhere else.
      if (isOnlyStyle(text)) {
        if (!touched(block.from, block.to)) {
          decorations.push(
            Decoration.replace({ widget: new NoteCssWidget(), block: true }).range(block.from, block.to),
          );
        }
        return false;
      }

      // A block holding a tag this app does not draw is left exactly as written - including the one
      // that matters, `<script>`. Hiding it would be this editor deciding a note says less than it
      // says, and it is the same rule an unclosed inline tag follows.
      if (!tokens.every((token) => isKnownTag(token.name))) {
        return false;
      }

      // Which tags this block leaves outstanding, in both directions. A void tag closes nothing and
      // is never left open, so it takes no part in any of this.
      const opens: TagToken[] = [];
      const closes: TagToken[] = [];
      for (const token of tokens) {
        if (VOID_TAGS.has(token.name)) {
          continue;
        }
        if (!token.closing) {
          opens.push(token);
          continue;
        }
        const index = opens.map((entry) => entry.name).lastIndexOf(token.name);
        if (index === -1) {
          closes.push(token);
        } else {
          opens.splice(index, 1);
        }
      }

      if (opens.length === 0 && closes.length === 0) {
        // Self-contained: it says everything it needs to say, so it is drawn.
        if (drawsFaithfully(text) && !touched(block.from, block.to)) {
          decorations.push(
            Decoration.replace({ widget: new NoteHtmlWidget(text), block: true }).range(block.from, block.to),
          );
        }
        return false;
      }

      // Anything else is a boundary - but only if it is tags and nothing else. `<div>and some text`
      // has words in it that hiding the block would take with it, so it is left as written.
      if (!onlyTags(text, tokens)) {
        return false;
      }

      for (const token of closes) {
        const index = open.map((entry) => entry.name).lastIndexOf(token.name);
        if (index === -1) {
          continue;
        }
        const wrapper = open[index];
        open.splice(index, 1);

        hidden.set(wrapper.block.from, wrapper.block);
        hidden.set(block.from, block);

        if (wrapper.style === '' && wrapper.className === '') {
          continue;
        }

        const attributes: Record<string, string> = {};
        if (wrapper.style !== '') {
          attributes.style = wrapper.style;
        }
        const line = Decoration.line({
          class: wrapper.className === '' ? 'cm-note-wrap' : `cm-note-wrap ${wrapper.className}`,
          attributes,
        });

        for (let number = wrapper.firstLine; number < first.number; number += 1) {
          decorations.push(line.range(state.doc.line(number).from));
        }
      }

      for (const token of opens) {
        open.push({ name: token.name, block, firstLine: last.number + 1, ...styleOf(token) });
      }

      return false;
    },
  });

  for (const block of hidden.values()) {
    if (!touched(block.from, block.to)) {
      decorations.push(Decoration.replace({ block: true }).range(block.from, block.to));
    }
  }

  return Decoration.set(decorations, true);
}

const htmlDecorations = StateField.define<DecorationSet>({
  create: (state) => build(state),

  update(value, transaction) {
    if (
      transaction.docChanged ||
      transaction.selection ||
      transaction.state.field(focused) !== transaction.startState.field(focused) ||
      // The parser reaching further into a long note is a change to what blocks exist, and it
      // arrives in a transaction of its own with nothing else in it.
      syntaxTree(transaction.state) !== syntaxTree(transaction.startState)
    ) {
      return build(transaction.state);
    }
    return value;
  },

  provide: (field) => EditorView.decorations.from(field),
});

/* ------------------------------------------------------------------------------ the note's CSS */

/** Every `<style>` block in the note, in the order they were written. */
function noteCss(state: EditorState): string {
  let css = '';

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'HTMLBlock') {
        return undefined;
      }
      css += cssIn(state.doc.sliceString(node.from, node.to));
      return false;
    },
  });

  return css;
}

let scopes = 0;

/**
 * The note's own stylesheet, kept applied while it is being written.
 *
 * It is one element outside the document holding every `<style>` block in the note, rather than each
 * block styling from where it sits. That is what lets a rule at the bottom of a note reach a
 * paragraph at the top, and what keeps the CSS working while somebody is editing it - a stylesheet
 * that only applied when the cursor was elsewhere would be impossible to write.
 *
 * Every rule is scoped to this editor's own content before it is applied. A note styles itself; it
 * does not style the app it is being read in. Two notes open at once - the editor and the history
 * panel's preview - get a scope each, so neither reaches the other.
 */
class NoteStyles implements PluginValue {
  private readonly element = document.createElement('style');
  private readonly scope: string;
  private applied: string | null = null;

  constructor(private readonly view: EditorView) {
    scopes += 1;
    const id = `note-${scopes}`;
    this.scope = `[data-note-css="${id}"]`;
    view.contentDOM.dataset.noteCss = id;
    view.dom.appendChild(this.element);
    this.write(view.state);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) {
      this.write(update.state);
    }
  }

  private write(state: EditorState): void {
    const css = noteCss(state);
    if (css === this.applied) {
      return;
    }
    this.applied = css;
    this.element.textContent = css.trim() === '' ? '' : scopeCss(css, this.scope);
  }

  destroy(): void {
    this.element.remove();
    delete this.view.contentDOM.dataset.noteCss;
  }
}

export const htmlView: Extension = [
  focused,
  trackFocus,
  htmlDecorations,
  ViewPlugin.fromClass(NoteStyles),
];
