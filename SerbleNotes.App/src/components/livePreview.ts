import { syntaxTree } from '@codemirror/language';
import { displayWidth } from './tableFormat';
import { isTextMode } from './tableState';
import { codeBlockWidth, codeWidthsChanged } from './codeWidths';
import { languageLabel } from './codeLanguages';
import type { EditorState, Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';

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

const quoteLine = Decoration.line({ class: 'cm-md-quote' });

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

/** Node types whose punctuation is hidden unless the cursor is on that line. */
const MARKUP = new Set([
  'HeaderMark',
  'EmphasisMark',
  'StrikethroughMark',
  'CodeMark',
  'LinkMark',
  'QuoteMark',
]);

/** Node types that get styled but keep their text. */
const STYLED: Record<string, Decoration> = {
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

  // Lines touched by a cursor or selection keep their markup visible. Hiding characters out from
  // under someone mid-edit is disorienting and makes the syntax impossible to correct.
  const activeLines = new Set<number>();
  for (const range of state.selection.ranges) {
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

        const headingMatch = /^ATXHeading(\d)$/.exec(name);
        if (headingMatch) {
          const line = state.doc.lineAt(node.from);
          decorations.push(headingLine[Number(headingMatch[1]) - 1].range(line.from));
          return;
        }

        if (name === 'Blockquote') {
          for (let position = node.from; position <= node.to; ) {
            const line = state.doc.lineAt(position);
            decorations.push(quoteLine.range(line.from));
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

        if (name === 'URL' || name === 'LinkLabel') {
          // The destination is machinery, not prose: hide it unless you are editing that line.
          if (!activeLines.has(state.doc.lineAt(node.from).number)) {
            decorations.push(hide.range(node.from, node.to));
          }
          return;
        }

        if (name === 'Link') {
          decorations.push(linkText.range(node.from, node.to));
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

  return Decoration.set(decorations, true);
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
        codeWidthsChanged(update)
      ) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
