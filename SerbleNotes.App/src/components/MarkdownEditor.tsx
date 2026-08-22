import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { markdownLanguage } from './markdownLanguage';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useEffect, useRef } from 'react';
import { codeWidths } from './codeWidths';
import { copyCode } from './copyCode';
import { livePreview } from './livePreview';

/**
 * Syntax colours inside fenced code blocks.
 *
 * Deliberately says nothing about the tags markdown itself emits - heading, strong, emphasis, link,
 * list, quote. Prose is styled by livePreview through its own classes, and colouring it from here as
 * well would mean two things fighting over the same text.
 */
const codeHighlighting = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.definitionKeyword, tags.operatorKeyword],
    color: '#c792ea',
  },
  { tag: [tags.self, tags.atom, tags.bool, tags.null], color: '#ff9cac' },
  { tag: [tags.string, tags.special(tags.string), tags.character], color: '#c3e88d' },
  { tag: [tags.regexp, tags.escape], color: '#f8c555' },
  { tag: [tags.number, tags.integer, tags.float], color: '#f78c6c' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.labelName], color: '#82aaff' },
  { tag: [tags.definition(tags.variableName), tags.definition(tags.propertyName)], color: '#82aaff' },
  { tag: [tags.propertyName, tags.attributeName], color: '#b2ccd6' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: '#ffcb6b' },
  { tag: [tags.attributeValue], color: '#c3e88d' },
  { tag: [tags.operator, tags.derefOperator, tags.compareOperator, tags.logicOperator], color: '#89ddff' },
  { tag: [tags.punctuation, tags.separator, tags.bracket, tags.paren, tags.brace, tags.squareBracket], color: '#8b98a5' },
  { tag: [tags.meta, tags.processingInstruction, tags.annotation], color: '#a0b6d0' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: '#697098', fontStyle: 'italic' },
  { tag: tags.docString, color: '#8fa88f', fontStyle: 'italic' },
  { tag: tags.inserted, color: '#5fbf6a' },
  { tag: tags.deleted, color: '#f2555a' },
  { tag: tags.changed, color: '#e3b341' },
  { tag: tags.invalid, color: '#f2555a', textDecoration: 'underline wavy' },
]);

const MONO = 'ui-monospace, Menlo, Consolas, monospace';

/**
 * How far the language chip and the copy button sit in from the top corners of a code block. They
 * are a pair on one line, so there is one value for both - see the chip's rule below.
 */
const CHIP_INSET_Y = '0.3rem';
const CHIP_INSET_X = '0.85rem';

const theme = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'transparent', height: '100%' },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: '1.7',
    padding: '0 0 40vh 0',
    overflow: 'auto',

    // The copy button is a child of the scroller rather than of the document - see copyCode.ts -
    // and this is what it is positioned against.
    position: 'relative',
  },
  // No width cap. The editor is as wide as the room it has been given - which is the room the user
  // decided on when they dragged the splitters or sized the window - and long lines wrap rather than
  // being held to a measure somebody picked.
  // `minWidth: 0` matters now that a code line can carry a fixed width: the content is a flex item,
  // and a flex item will not shrink below the widest thing inside it unless it is told it may. Without
  // this, a block wider than the pane made the whole editor scroll sideways instead of wrapping.
  '.cm-content': { padding: '0', caretColor: 'var(--accent)', minWidth: '0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-line': { padding: '0 2px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent)',
  },
  '.cm-activeLine': { backgroundColor: 'transparent' },

  // Headings keep the document's rhythm: the sizes step down, and the weight carries the emphasis.
  '.cm-md-heading': { fontWeight: '650', lineHeight: '1.35' },
  '.cm-md-h1': { fontSize: '1.7em' },
  '.cm-md-h2': { fontSize: '1.42em' },
  '.cm-md-h3': { fontSize: '1.22em' },
  '.cm-md-h4': { fontSize: '1.08em' },
  '.cm-md-h5': { fontSize: '1em' },
  '.cm-md-h6': { fontSize: '1em', color: 'var(--muted)' },

  '.cm-md-strong': { fontWeight: '700' },
  '.cm-md-emphasis': { fontStyle: 'italic' },
  '.cm-md-strike': { textDecoration: 'line-through', color: 'var(--muted)' },
  '.cm-md-link': { color: 'var(--accent)', textDecoration: 'underline' },

  '.cm-md-code': {
    fontFamily: MONO,
    fontSize: '0.9em',
    background: 'var(--surface-2)',
    borderRadius: '4px',
    padding: '0.1em 0.3em',
  },

  '.cm-md-quote': {
    borderLeft: '3px solid var(--border)',
    paddingLeft: '0.8rem',
    color: 'var(--muted)',
  },

  // A fenced block is drawn as one card, but it is made of ordinary lines - CodeMirror gives every
  // line its own element, so the card's sides are painted on each line and its corners on the two
  // ends. The fence lines themselves become the card's top and bottom padding once their backticks
  // are hidden, which is why they are left in place rather than collapsed away.
  '.cm-md-codeblock': {
    fontFamily: MONO,
    fontSize: '0.875em',
    lineHeight: '1.55',
    background: 'var(--surface)',
    borderLeft: '1px solid var(--border)',
    borderRight: '1px solid var(--border)',
    padding: '0 0.85rem',

    // The width itself is set per line by livePreview, from what codeWidths.ts measured. This is the
    // limit on it: a block wider than the pane stops at the pane and its lines wrap.
    maxWidth: '100%',
  },

  '.cm-md-code-open': {
    position: 'relative',
    borderTop: '1px solid var(--border)',
    borderTopLeftRadius: '8px',
    borderTopRightRadius: '8px',
    paddingTop: '0.45rem',
  },

  '.cm-md-code-close': {
    borderBottom: '1px solid var(--border)',
    borderBottomLeftRadius: '8px',
    borderBottomRightRadius: '8px',
    paddingBottom: '0.45rem',
  },

  // The language, in the corner. An ::after on the line rather than a widget in the document: a
  // widget would sit in the text flow, and the cursor could be put either side of something that is
  // not part of the note.
  //
  // The left corner, because the right one is where the copy button goes (copyCode.ts) and the two
  // would otherwise sit on top of each other - a chip is as wide as the language it names, so there
  // is no offset that would reliably keep them apart.
  //
  // The two of them sit on one line across the top of the block, so they have to be the same box:
  // the font, the padding and the line height below are the ones `.copy-code` sets in index.css, and
  // changing either without the other leaves them a couple of pixels out of step - which is exactly
  // the sort of thing nobody can name but everybody can see.
  '.cm-md-code-open[data-lang]::after': {
    content: 'attr(data-lang)',
    position: 'absolute',
    top: CHIP_INSET_Y,
    left: CHIP_INSET_X,
    fontFamily: 'var(--sans)',
    fontSize: '0.68rem',
    fontWeight: '500',
    lineHeight: '1.5',
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    color: 'var(--muted)',
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: '999px',
    padding: '0.16rem 0.5rem',
    pointerEvents: 'none',
    userSelect: 'none',
  },

  // The copy button is placed by copyCode.ts, which can only work in pixels: it measures where the
  // block starts. The inset stays here, in the same units as the chip's, so the pair cannot drift
  // apart when one of them is adjusted.
  '.cm-copy-code': { marginTop: CHIP_INSET_Y, marginRight: CHIP_INSET_X },

  // A finger needs more of the button than a pointer does, and the chip grows with it or the line
  // they share stops being a line. See the matching rule in index.css.
  '@media (pointer: coarse)': {
    '.cm-md-code-open[data-lang]::after': { padding: '0.3rem 0.7rem', fontSize: '0.75rem' },
  },

  // Where a block is measured (codeWidths.ts): an off-screen copy of it, laid out at its natural
  // width. It is built from the same classes as the real thing so it is measured in the real font,
  // and the two rules below put the badges back into the flow - in a real block the chip and the
  // button are positioned, so neither contributes anything to how wide the card has to be, and here
  // they must.
  '.cm-code-measure': {
    position: 'absolute',
    top: '-9999px',
    left: '0',
    width: 'max-content',
    visibility: 'hidden',
    pointerEvents: 'none',
  },
  '.cm-code-measure .cm-md-codeblock': { whiteSpace: 'pre', maxWidth: 'none' },
  '.cm-code-measure .cm-md-code-open[data-lang]::after': {
    position: 'static',
    display: 'inline-block',
  },
  '.cm-code-measure .copy-code': { position: 'static', marginLeft: '0.5rem' },
  '.cm-code-block-measure': { width: 'max-content' },
});

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
}

/**
 * The note editor. One CodeMirror view, no modes - see livePreview.ts for how the rendering works.
 *
 * Mount this with `key={noteId}` so switching notes builds a fresh editor: that resets the cursor
 * and, more importantly, the undo history, which must never let one note's undo stack reach into
 * another's text.
 */
export function MarkdownEditor({ value, onChange }: MarkdownEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  // The editor is created once, so its update listener would capture the first onChange forever.
  const latestOnChange = useRef(onChange);
  latestOnChange.current = onChange;

  useEffect(() => {
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdownLanguage,
        syntaxHighlighting(codeHighlighting),
        EditorView.lineWrapping,
        codeWidths,
        livePreview,
        copyCode,
        theme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            latestOnChange.current(update.state.doc.toString());
          }
        }),
      ],
    });

    const editor = new EditorView({ state, parent: host.current! });
    view.current = editor;
    editor.focus();

    return () => {
      editor.destroy();
      view.current = null;
    };
    // Deliberately once: `value` is pushed in by the effect below, not by rebuilding the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor) {
      return;
    }

    // Only for text that arrived from somewhere else - a sync merge, or a restore. Replacing the
    // document on every keystroke would fight the user for the cursor.
    const current = editor.state.doc.toString();
    if (current !== value) {
      editor.dispatch({
        changes: { from: 0, to: current.length, insert: value },
        selection: { anchor: Math.min(editor.state.selection.main.anchor, value.length) },
      });
    }
  }, [value]);

  return <div className="editor-surface" ref={host} />;
}
