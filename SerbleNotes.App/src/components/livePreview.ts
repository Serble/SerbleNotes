import { syntaxTree } from '@codemirror/language';
import { touchesConflict } from './conflicts';
import { displayWidth } from './tableFormat';
import { isTextMode } from './tableState';
import { codeBlockWidth, codeWidthsChanged } from './codeWidths';
import { languageLabel } from './codeLanguages';
import { NoteHtmlWidget } from './htmlWidget';
import { isKnownTag, tagAttributes, VOID_TAGS } from './noteHtml';
import type { EditorState, Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';

/**
 * Live preview: one view, always editable, markdown rendered in place.
 *
 * There is no edit mode and no preview mode because the document only ever exists in one state. What
 * changes is how much of the markup you can see: the line your cursor is on shows its raw syntax so
 * you can edit it, and every other line hides the punctuation and shows the result. Put the cursor
 * on a heading and the '#' comes back; move away and it is a heading again.
 */

const hide = Decoration.replace({});

const headingLine = [1, 2, 3, 4, 5, 6].map((level) =>
  Decoration.line({ class: `cm-md-heading cm-md-h${level}` }),
);

/**
 * A line inside a quote, told how deep it is. The stylesheet draws that many bars and indents the
 * text past them, so two levels look like two levels - see `.cm-md-quote` in MarkdownEditor.tsx.
 */
function quoteLine(depth: number): Decoration {
  return Decoration.line({
    class: 'cm-md-quote',
    attributes: { style: `--quote-depth: ${depth}` },
  });
}

/**
 * A line with nothing on it, with its line break inside the selection.
 *
 * The browser paints a selection onto text, and there is none here - so dragging across a blank line
 * leaves a gap that reads as "this line was not selected", when in fact its line break was and will
 * be cut or copied with the rest. The style behind this class paints the width of a space, which is
 * what the blank line would have shown if the break had been one.
 */
const blankSelected = Decoration.line({ class: 'cm-md-blank-selected' });
const codeCloseLine = Decoration.line({ class: 'cm-md-code-close' });

/*
 * A table is painted the way a code block is: one card made of ordinary lines, because CodeMirror
 * gives every line its own element and there is no element for the block itself. The band runs the
 * width of the pane rather than shrinking to the table, which a code block does - a table's source
 * is laid out to a common width by tables.ts, but only once the cursor has left it, and a card that
 * shrank and grew around the row being typed would be worse than no card at all.
 *
 * The header row is the top edge and is emboldened there; the `|---|` row under it keeps its text
 * and is drawn faint, so it reads as the rule it is meant to be without anything being hidden from
 * somebody trying to correct it.
 */
/**
 * A line of a table shown as markdown, at the width of the whole table.
 *
 * The band hugs what is in it rather than running to the edge of the pane. It can, where a code
 * block's card could not (`codeWidths.ts` has to measure one off-screen): these lines are monospace
 * and `renderTable` has already padded every one of them to the same number of columns, so `ch` -
 * the width of one character in the font the line is drawn in - turns that count straight into a
 * width with nothing to measure. Every line of the table is given the widest one, so the sides stay
 * straight even while somebody is part-way through typing a row that is longer than the rest.
 *
 * Cached by width, because CodeMirror compares decorations by identity and a fresh object per line
 * would redraw the whole table on every keystroke.
 */
const tableLines = new Map<number, Decoration>();

function tableLine(columns: number): Decoration {
  const cached = tableLines.get(columns);
  if (cached) {
    return cached;
  }

  const decoration = Decoration.line({
    class: 'cm-md-table',
    // The padding and the borders are in the width because the line is a border box; the extra
    // couple of pixels are slack, since a width a hair too small wraps the last character onto a
    // line of its own.
    attributes: { style: `width:calc(${columns}ch + 1.7rem + 4px)` },
  });
  tableLines.set(columns, decoration);
  return decoration;
}
const tableOpenLine = Decoration.line({ class: 'cm-md-table-open' });
const tableRuleLine = Decoration.line({ class: 'cm-md-table-rule' });
const tableCloseLine = Decoration.line({ class: 'cm-md-table-close' });

/** The pipes, and the whole of the `|---|` row - markdown's own punctuation, kept but quietened. */
const tableMark = Decoration.mark({ class: 'cm-md-table-mark' });

/**
 * A line of a code block, at the width of the block it belongs to.
 *
 * The card shrinks to fit the block, and the card is made of these - so every line of one block
 * carries the same width, measured by `codeWidths.ts`. Until it has been measured the line has no
 * width of its own and fills the pane, which is also what happens when the block is wider than there
 * is room for: `max-width` takes over and the lines wrap.
 *
 * Decorations are cached by width because CodeMirror compares them by identity: a fresh object for
 * every line would redraw the whole block on every keystroke.
 */
const codeLines = new Map<number, Decoration>();

function codeLine(width: number | null): Decoration {
  const cached = codeLines.get(width ?? 0);
  if (cached) {
    return cached;
  }

  const decoration = Decoration.line({
    class: 'cm-md-codeblock',
    attributes: width === null ? undefined : { style: `width:${width}px` },
  });
  codeLines.set(width ?? 0, decoration);
  return decoration;
}

/**
 * The top edge of a code block. The language is carried as an attribute rather than drawn as a
 * widget so that CSS can put it in the corner of the block: a widget would sit in the text flow, and
 * the cursor could then be placed either side of something that is not part of the document.
 */
function codeOpenLine(label: string): Decoration {
  return Decoration.line({
    class: 'cm-md-code-open',
    attributes: label === '' ? undefined : { 'data-lang': label },
  });
}

const strong = Decoration.mark({ class: 'cm-md-strong' });
const emphasis = Decoration.mark({ class: 'cm-md-emphasis' });
const strikethrough = Decoration.mark({ class: 'cm-md-strike' });
const inlineCode = Decoration.mark({ class: 'cm-md-code' });
const linkText = Decoration.mark({ class: 'cm-md-link' });

/** A URL written on its own. It is the text as well as the destination, so it is never hidden. */
const bareUrl = Decoration.mark({ class: 'cm-md-link' });

/** An image, which this editor shows as its alt text rather than as a picture. */
const imageText = Decoration.mark({ class: 'cm-md-image' });

const superscript = Decoration.mark({ class: 'cm-md-sup' });
const subscript = Decoration.mark({ class: 'cm-md-sub' });

/**
 * The box on a task list item, and ticking it.
 *
 * Drawn rather than a real `<input>`: a checkbox in a document that is not a form has no business
 * being focusable or tabbable, and this way it is the same shape on every device. Clicking it
 * writes the other character into the note, because a task list you cannot tick is a list of things
 * you have to edit the markdown to finish.
 */
class TaskWidget extends WidgetType {
  constructor(private readonly done: boolean, private readonly at: number) {
    super();
  }

  eq(other: TaskWidget): boolean {
    return other.done === this.done && other.at === this.at;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('span');
    box.className = this.done ? 'cm-md-task cm-md-task-done' : 'cm-md-task';
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', String(this.done));

    box.addEventListener('mousedown', (event) => {
      // Before the editor treats it as a click into text, which would put the caret here and
      // rebuild this widget out from under the handler.
      event.preventDefault();
      view.dispatch({
        changes: { from: this.at, to: this.at + 1, insert: this.done ? ' ' : 'x' },
        userEvent: 'input.task',
      });
    });

    return box;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * The dot on a bullet point.
 *
 * Drawn rather than written: a bullet character would be one more glyph whose look depends on the
 * font the device happens to have, and this one is a shape this app controls - the same decision as
 * the separators in the vault list. The mark it replaces is still in the document, and comes back
 * the moment the cursor lands on that line.
 */
class BulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const dot = document.createElement('span');
    dot.className = 'cm-md-bullet';
    return dot;
  }

  eq(): boolean {
    return true;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

const bullet = Decoration.replace({ widget: new BulletWidget() });

/** An ordered list's number is what it says, so it is kept and only quietened. */
const listNumber = Decoration.mark({ class: 'cm-md-list-number' });

/**
 * The line of a list item, indented so that a line long enough to wrap lines up with the text above
 * it rather than with the bullet. The size is measured per line - it is where the item's text
 * starts, which depends on how deep the item is nested and how wide its marker is.
 */
function listLine(indent: number): Decoration {
  return Decoration.line({
    class: 'cm-md-list',
    attributes: { style: `padding-left: ${indent}ch; text-indent: -${indent}ch` },
  });
}

/**
 * A horizontal rule: the line it is written on, drawn as a rule.
 *
 * The characters are hidden like any other markup, and the line stays - an empty line with a rule
 * painted across it. Replacing the whole thing with a widget would take the line with it, and a
 * rule is a line of the document: you have to be able to put the cursor on it to delete it.
 */
const ruleLine = Decoration.line({ class: 'cm-md-hr' });

/** A line break where the note asked for one. */
class BreakWidget extends WidgetType {
  toDOM(): HTMLElement {
    const line = document.createElement('span');
    line.className = 'cm-md-break';
    line.appendChild(document.createElement('br'));
    return line;
  }

  eq(): boolean {
    return true;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

const lineBreak = Decoration.replace({ widget: new BreakWidget() });

/** `<br>`, `<br/>`, `<br />`, and the same again in capitals. */
const BREAK = /^<\s*br\s*\/?\s*>$/i;

/** An opening or closing tag, as far as this needs to understand one. */
const TAG = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)/;

/** Node types whose punctuation is hidden unless the cursor is on that line. */
const MARKUP = new Set([
  'HighlightMark',
  'SuperscriptMark',
  'SubscriptMark',
  'HeaderMark',
  'EmphasisMark',
  'StrikethroughMark',
  'CodeMark',
  'LinkMark',
  'QuoteMark',
]);

/** Node types that get styled but keep their text. */
const STYLED: Record<string, Decoration> = {
  Highlight: Decoration.mark({ class: 'cm-md-mark' }),
  StrongEmphasis: strong,
  Emphasis: emphasis,
  Strikethrough: strikethrough,
  InlineCode: inlineCode,
};

/**
 * Whether the line break at this position is inside a selection - which is the question a blank line
 * asks. A selection that stops exactly here has not taken the break with it, and the line below is
 * still a line of its own.
 */
function breakSelected(state: EditorState, at: number): boolean {
  return state.selection.ranges.some((range) => !range.empty && range.from <= at && range.to > at);
}

function build(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const { state } = view;

  /** Inline HTML, collected as it is walked past and paired up once the walk is done. */
  const tags: { from: number; to: number; text: string }[] = [];

  /** How many blockquotes each line is inside, by the position that line starts at. */
  const quoteDepth = new Map<number, number>();

  // Lines touched by a cursor or selection keep their markup visible. Hiding characters out from
  // under someone mid-edit is disorienting and makes the syntax impossible to correct.
  //
  // Only while the editor has focus, though. A cursor in an editor nobody is typing in is not
  // "where you are", it is where you were - and it defaults to the very start, so an unfocused note
  // would show the first line's markup for no reason anyone could see. That is plain on a phone,
  // where opening a note no longer focuses it.
  const activeLines = new Set<number>();
  for (const range of view.hasFocus ? state.selection.ranges : []) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let line = first; line <= last; line += 1) {
      activeLines.add(line);
    }
  }

  // Blank lines whose line break is selected. Walked line by line rather than taken from the syntax
  // tree, because a line with nothing on it is not a node - there is nothing there to be one.
  for (const { from, to } of view.visibleRanges) {
    for (let line = state.doc.lineAt(from); ; ) {
      if (line.length === 0 && breakSelected(state, line.from)) {
        decorations.push(blankSelected.range(line.from));
      }
      if (line.to >= to || line.number === state.doc.lines) {
        break;
      }
      line = state.doc.line(line.number + 1);
    }
  }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;

        // Anything that touches a conflict is not the markdown it looks like. Overlap, not
        // containment: the `=======` inside a conflict is a setext underline, and a setext heading
        // starts at the paragraph *above* the region and reaches into it - so the node to refuse is
        // one that began outside. See `touchesConflict`.
        if (touchesConflict(state, node.from, node.to)) {
          return false;
        }

        if (name === 'HTMLTag') {
          // Held back rather than handled here: a tag means nothing on its own, and the one that
          // closes it has not been walked past yet.
          tags.push({ from: node.from, to: node.to, text: state.doc.sliceString(node.from, node.to) });
          return;
        }

        // Both ways of writing a heading. `# H1` is one line; `H1` underlined with `===` is two,
        // and the underline is a HeaderMark that hides itself on the way out like every other mark.
        const headingMatch = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
        if (headingMatch) {
          const level = headingLine[Number(headingMatch[1]) - 1];
          for (let position = node.from; position <= node.to; ) {
            const line = state.doc.lineAt(position);
            decorations.push(level.range(line.from));
            position = line.to + 1;
          }
          return;
        }

        if (name === 'HorizontalRule') {
          const line = state.doc.lineAt(node.from);
          decorations.push(ruleLine.range(line.from));
          if (!activeLines.has(line.number)) {
            decorations.push(hide.range(node.from, node.to));
          }
          return;
        }

        if (name === 'TaskMarker') {
          // `[ ]` or `[x]`, with the state in the middle character - which is the one a tick swaps.
          if (activeLines.has(state.doc.lineAt(node.from).number)) {
            return;
          }

          const done = state.doc.sliceString(node.from + 1, node.to - 1).trim() !== '';
          decorations.push(
            Decoration.replace({ widget: new TaskWidget(done, node.from + 1) }).range(
              node.from,
              node.to,
            ),
          );
          return;
        }

        if (name === 'ListItem') {
          const line = state.doc.lineAt(node.from);
          const mark = node.node.firstChild;
          if (!mark || mark.name !== 'ListMark') {
            return;
          }

          // Where the item's own text begins, counted from the start of the line: the marker's
          // indent, the marker, and the space after it.
          const after = state.doc.sliceString(mark.to, Math.min(mark.to + 1, line.to)) === ' ' ? 1 : 0;
          decorations.push(listLine(mark.to - line.from + after).range(line.from));

          if (activeLines.has(line.number)) {
            return;
          }

          const marker = state.doc.sliceString(mark.from, mark.to);
          const task = node.node.getChild('Task') !== null;

          if (task) {
            // Its box is the marker. A dot as well would be saying the same thing twice.
            decorations.push(hide.range(mark.from, mark.to));
          } else if (marker === '-' || marker === '*' || marker === '+') {
            decorations.push(bullet.range(mark.from, mark.to));
          } else {
            // A number says which item this is, so it stays. Quietened, like every other mark.
            decorations.push(listNumber.range(mark.from, mark.to));
          }
          return;
        }

        if (name === 'Blockquote') {
          // Counted rather than marked: a quote inside a quote is a Blockquote inside a Blockquote,
          // so every line is walked past once per level it is inside. One class for all of them
          // drew one bar however deep the nesting went, which made a nested quote look like an
          // ordinary one that had lost its '>'.
          for (let position = node.from; position <= node.to; ) {
            const line = state.doc.lineAt(position);
            quoteDepth.set(line.from, (quoteDepth.get(line.from) ?? 0) + 1);
            position = line.to + 1;
          }
          return;
        }

        if (name === 'FencedCode' || name === 'CodeBlock') {
          const first = state.doc.lineAt(node.from);
          const last = state.doc.lineAt(node.to);

          // The fence's info string names the language. It is hidden along with the backticks below,
          // and reappears as the chip in the corner of the block.
          const info = node.node.getChild('CodeInfo');
          const label = info ? languageLabel(state.doc.sliceString(info.from, info.to)) : '';

          // One width for the whole block, so the card has straight sides.
          const width = codeBlockWidth(state, node.from);

          for (let position = node.from; position <= node.to; ) {
            const line = state.doc.lineAt(position);
            decorations.push(codeLine(width).range(line.from));

            if (line.number === first.number) {
              decorations.push(codeOpenLine(activeLines.has(line.number) ? '' : label).range(line.from));
            }
            if (line.number === last.number && last.number !== first.number) {
              decorations.push(codeCloseLine.range(line.from));
            }

            position = line.to + 1;
          }
          return;
        }

        if (name === 'Table') {
          const first = state.doc.lineAt(node.from);
          const last = state.doc.lineAt(node.to);

          // A table is normally drawn rather than shown as markdown (tableView.ts), and its lines
          // are then not on the screen at all. These are the styles for the markdown behind it,
          // which only somebody who asked for it ever sees.
          if (!isTextMode(state, first.from)) {
            return false;
          }

          // One width for the whole table, so the card has straight sides: the widest line decides.
          let columns = 0;
          for (let position = node.from; position <= node.to; ) {
            const line = state.doc.lineAt(position);
            columns = Math.max(columns, displayWidth(line.text));
            position = line.to + 1;
          }

          for (let position = node.from; position <= node.to; ) {
            const line = state.doc.lineAt(position);
            decorations.push(tableLine(columns).range(line.from));

            if (line.number === first.number) {
              decorations.push(tableOpenLine.range(line.from));
            }
            if (line.number === first.number + 1) {
              decorations.push(tableRuleLine.range(line.from));
            }
            if (line.number === last.number && last.number !== first.number) {
              decorations.push(tableCloseLine.range(line.from));
            }

            position = line.to + 1;
          }
          // No `false`: the pipes inside are TableDelimiter nodes, and they are styled below.
          return;
        }

        if (name === 'TableDelimiter') {
          decorations.push(tableMark.range(node.from, node.to));
          return;
        }

        if (name === 'CodeInfo') {
          // Machinery, like a link's destination: it says how to render the block, it is not part of
          // what the block says.
          if (!activeLines.has(state.doc.lineAt(node.from).number)) {
            decorations.push(hide.range(node.from, node.to));
          }
          return;
        }

        const styled = STYLED[name];
        if (styled) {
          decorations.push(styled.range(node.from, node.to));
          return;
        }

        if (name === 'Escape') {
          // `\*` is an asterisk, and the backslash is how you say so - machinery, like a '#'.
          if (!activeLines.has(state.doc.lineAt(node.from).number)) {
            decorations.push(hide.range(node.from, node.from + 1));
          }
          return;
        }

        if (name === 'URL' || name === 'LinkLabel' || name === 'LinkTitle') {
          // Only the *destination* of a link or an image is machinery. A URL written on its own is
          // the text - the parser gives it the same node name with nothing around it, and hiding
          // that made "(https://example.com)" render as "()" until the cursor reached the line.
          // `<http://x.com>` is the same: an Autolink's URL is what it says.
          const owner = node.node.parent?.name;
          if (name === 'URL' && owner !== 'Link' && owner !== 'Image') {
            decorations.push(bareUrl.range(node.from, node.to));
            return;
          }

          if (!activeLines.has(state.doc.lineAt(node.from).number)) {
            decorations.push(hide.range(node.from, node.to));
          }
          return;
        }

        if (name === 'Link') {
          // `[^1]` parses as a link with a label, and this editor does not do footnotes - hiding
          // the brackets left "here^1", which is neither what was written nor what was meant. A
          // reference that starts with '^' is left exactly as it is until footnotes exist.
          if (state.doc.sliceString(node.from, node.from + 2) === '[^') {
            return false;
          }

          decorations.push(linkText.range(node.from, node.to));
          return;
        }

        if (name === 'Image') {
          // The alt text, and nothing else: the picture itself is not drawn. A note's image is a
          // remote address, and fetching one would tell that host when the note was opened - and
          // would be refused by the app's own content policy anyway, which allows no remote images.
          // So it reads as what it is: a reference, marked as one.
          decorations.push(imageText.range(node.from, node.to));
          return;
        }

        if (name === 'Superscript') {
          decorations.push(superscript.range(node.from, node.to));
          return;
        }

        if (name === 'Subscript') {
          decorations.push(subscript.range(node.from, node.to));
          return;
        }

        if (MARKUP.has(name)) {
          if (activeLines.has(state.doc.lineAt(node.from).number)) {
            return;
          }

          // A heading's '#' is followed by a space that should go with it, or the text starts
          // indented by one column compared to every other line.
          let end = node.to;
          if (name === 'HeaderMark' || name === 'QuoteMark') {
            while (end < state.doc.length && state.doc.sliceString(end, end + 1) === ' ') {
              end += 1;
            }
          }

          if (end > node.from) {
            decorations.push(hide.range(node.from, end));
          }
        }
      },
    });
  }

  for (const [from, depth] of quoteDepth) {
    decorations.push(quoteLine(depth).range(from));
  }

  applyHtml(state, tags, activeLines, decorations);

  return Decoration.set(decorations, true);
}

/**
 * Turns the inline HTML in a note into what it says.
 *
 * The tag becomes the element. `<font color="red">warm</font>` puts a real `<font color="red">`
 * round the word, so the browser renders it exactly as it would on any page - which is what makes
 * this full HTML support rather than a handful of tags mapped onto markdown's own styles. What the
 * element may be and what its attributes may say is decided in one place, noteHtml.ts, for here, for
 * a table cell and for the rendered preview alike.
 *
 * Tags are matched like brackets: an opening tag waits until its own closing tag turns up, and one
 * that never does is left as the text it is. That is the honest outcome - `<b` with no `>` is not
 * bold, it is a note that says "<b", and hiding it would be this editor deciding what someone meant.
 *
 * The two halves follow the same rule as markdown's own punctuation: the styling always applies, and
 * the tags themselves are hidden only while the cursor is off their line, so they can be edited.
 */
function applyHtml(
  state: EditorState,
  tags: { from: number; to: number; text: string }[],
  activeLines: Set<number>,
  decorations: Range<Decoration>[],
): void {
  const inactive = (at: number) => !activeLines.has(state.doc.lineAt(at).number);
  const open: { name: string; from: number; to: number; raw: string }[] = [];

  for (const tag of tags) {
    const match = TAG.exec(tag.text);
    const name = match?.[2].toLowerCase();
    if (!match || !name || !isKnownTag(name)) {
      continue;
    }

    // A void element is the whole of itself: there is no closing tag to wait for and no text to put
    // between them, so it is drawn where it stands. `<br>` has a widget of its own because a line
    // break has to be a line break in the editor's own layout.
    if (VOID_TAGS.has(name)) {
      if (inactive(tag.from)) {
        decorations.push(
          BREAK.test(tag.text)
            ? lineBreak.range(tag.from, tag.to)
            : Decoration.replace({ widget: new NoteHtmlWidget(tag.text, true) }).range(tag.from, tag.to),
        );
      }
      continue;
    }

    if (match[1] !== '/') {
      open.push({ name, from: tag.from, to: tag.to, raw: tag.text });
      continue;
    }

    // The nearest unclosed tag of the same name. Searching from the top is what makes nesting work,
    // and what stops a stray `</b>` closing something that was never opened.
    const index = open.map((entry) => entry.name).lastIndexOf(name);
    if (index === -1) {
      continue;
    }

    const opener = open[index];
    open.splice(index, 1);

    if (opener.to < tag.from) {
      const attributes = tagAttributes(opener.raw, name);
      if (attributes) {
        decorations.push(Decoration.mark({ tagName: name, attributes }).range(opener.to, tag.from));
      }
    }
    if (inactive(opener.from)) {
      decorations.push(hide.range(opener.from, opener.to));
    }
    if (inactive(tag.from)) {
      decorations.push(hide.range(tag.from, tag.to));
    }
  }
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = build(view);
    }

    update(update: ViewUpdate) {
      // Selection changes matter as much as edits here: moving the cursor onto a line is what
      // reveals its markup. So does a code block being measured: that arrives as a state change of
      // its own, a moment after the edit that caused it, and it is what gives the block its width.
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.focusChanged ||
        codeWidthsChanged(update)
      ) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
