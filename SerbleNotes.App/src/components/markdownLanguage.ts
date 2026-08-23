import {
  Language,
  LanguageDescription,
  ParseContext,
  defineLanguageFacet,
} from '@codemirror/language';
import {
  Autolink,
  Strikethrough,
  Subscript,
  Superscript,
  Table,
  parseCode,
  parser as baseParser,
  type BlockContext,
  type LeafBlock,
  type LeafBlockParser,
  type MarkdownConfig,
} from '@lezer/markdown';
import { tags } from '@lezer/highlight';
import { codeLanguages } from './codeLanguages';
import { looksLikeRow, startsTable } from './tableFormat';

/**
 * The markdown parser the editor runs on, assembled here rather than taken from
 * `@codemirror/lang-markdown`.
 *
 * That package statically depends on `@codemirror/lang-html` so it can parse HTML embedded in
 * markdown, and lang-html in turn pulls in the full JavaScript and CSS parsers. None of that is
 * reachable by tree-shaking, and it accounted for roughly two thirds of the bundle - for a feature
 * (syntax-highlighted `<script>` tags inside a note) nobody asked for. This keeps the markdown
 * parsing, including GitHub extensions, and leaves the rest out.
 *
 * `parseCode` is what gives fenced blocks their own language. It asks the callback below for a
 * parser to run over the block's contents, and the answer is nested into the same syntax tree, so
 * the ordinary highlighter colours it with no further arrangement.
 */
/**
 * `==highlighted==`, from markdownguide.org's extended syntax.
 *
 * Written the way `@lezer/markdown` writes its own Strikethrough - a delimiter pair, resolved into
 * one node - because it is the same shape of thing and there is no reason for it to look different.
 * The style it gets is the one `<mark>` already has, so a note can say it either way.
 */
const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' };

const Highlight: MarkdownConfig = {
  defineNodes: [{ name: 'Highlight' }, { name: 'HighlightMark' }],
  parseInline: [
    {
      name: 'Highlight',
      parse(cx, next, pos) {
        // Two '=' and no more: '===' under a line of text is a heading, and this must not eat it.
        if (next !== 61 /* '=' */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) {
          return -1;
        }

        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const spaceBefore = /\s|^$/.test(before);
        const spaceAfter = /\s|^$/.test(after);

        // Opens when something follows it, closes when something precedes it - the rule every
        // paired delimiter in markdown follows, so "a == b" stays two equals signs in a sentence.
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, !spaceAfter, !spaceBefore);
      },
      after: 'Emphasis',
    },
  ],
};

/**
 * Task lists, with one character's difference from the GFM extension this replaces.
 *
 * That extension asks for `/^\[[ xX]\][ \t]/` - a checkbox *followed by a space*. `- [ ]` on its
 * own is therefore not a task list item, it is a list item whose text is "[ ]", and `- [x]` is a
 * list item containing a link. Which is exactly what somebody typing one sees: they write the empty
 * box first, because the box is the thing they came for and the words have not been decided yet,
 * and they get a bullet and two brackets. The trailing space that would have fixed it is invisible
 * and nobody types it on purpose.
 *
 * So the space may also be the end of the line. Everything else is upstream's, including the leaf
 * parser, which is reproduced here only because it is not exported. `- [x]text` with no space at all
 * is still not a task, as upstream has it - there the brackets really might be something else.
 */
class TaskParser implements LeafBlockParser {
  nextLine(): boolean {
    return false;
  }

  finish(cx: BlockContext, leaf: LeafBlock): boolean {
    cx.addLeafElement(
      leaf,
      cx.elt('Task', leaf.start, leaf.start + leaf.content.length, [
        cx.elt('TaskMarker', leaf.start, leaf.start + 3),
        ...cx.parser.parseInline(leaf.content.slice(3), leaf.start + 3),
      ]),
    );
    return true;
  }
}

const Tasks: MarkdownConfig = {
  defineNodes: [
    { name: 'Task', block: true, style: tags.list },
    { name: 'TaskMarker', style: tags.atom },
  ],
  parseBlock: [
    {
      name: 'TaskList',
      leaf: (cx, leaf) =>
        /^\[[ xX]\](?:[ \t]|$)/.test(leaf.content) && cx.parentType().name === 'ListItem'
          ? new TaskParser()
          : null,
      after: 'SetextHeading',
    },
  ],
};

/**
 * A table stops at the last line that is written as a row.
 *
 * GFM says a table runs until a blank line or the start of another block, so a sentence typed under
 * one with no gap in between is a row of that table - the whole sentence squeezed into the first
 * column, and every column of the row after it empty. The spec is the spec, but nobody typing under
 * a table means that, and here it is worse than a rendering oddity: the table is *drawn*, so the
 * next keystroke in any cell writes the whole thing back laid out, and the sentence is left as a
 * row of markdown with pipes round it. Text that was a paragraph a moment ago cannot quietly become
 * part of a table.
 *
 * So a line with no unescaped pipe in it ends the table instead. `endLeaf` is how the parser is
 * told: it is asked before the block's own parsers see the line, and answering yes finishes the
 * paragraph where it stands - the table covers exactly the rows above, and the line goes on to be
 * parsed as whatever it is. Nothing is dropped either way; the only question is which block the
 * line belongs to.
 *
 * The check is ordered so that the common case is one scan of the line being offered: a line that
 * is a row cannot end anything, and only when it is not one is there any point asking whether the
 * block above it is a table.
 */
const TableRows: MarkdownConfig = {
  parseBlock: [
    {
      name: 'TableRows',
      endLeaf(_, line, leaf) {
        if (looksLikeRow(line.text.slice(line.basePos))) {
          return false;
        }

        // The first two lines of the block, without splitting the whole of it on every line: this
        // runs for every line of every paragraph in the note.
        const firstBreak = leaf.content.indexOf('\n');
        if (firstBreak < 0) {
          return false;
        }
        const secondBreak = leaf.content.indexOf('\n', firstBreak + 1);

        return startsTable(
          leaf.content.slice(0, firstBreak),
          leaf.content.slice(firstBreak + 1, secondBreak < 0 ? leaf.content.length : secondBreak),
        );
      },
      after: 'Table',
    },
  ],
};

const markdownFacet = defineLanguageFacet({
  commentTokens: { block: { open: '<!--', close: '-->' } },
});

/**
 * Picks the parser for a fence's info string. Every language loads on demand, so most of the time
 * there is no parser to hand back yet: `getSkippingParser` leaves the block as plain text and asks
 * CodeMirror to parse it again once the import lands, which is what makes a block light up a moment
 * after it is first typed.
 */
function codeParser(info: string) {
  const word = info.trim().split(/\s+/)[0];
  if (word === '') {
    return null;
  }

  const found = LanguageDescription.matchLanguageName(codeLanguages, word, true);
  if (!found) {
    return null;
  }
  if (found.support) {
    return found.support.language.parser;
  }
  return ParseContext.getSkippingParser(found.load());
}

// GFM taken apart rather than used whole: it is Table, TaskList, Strikethrough and Autolink, with
// the task lists here relaxed as above and `TableRows` deciding where a table stops. Superscript and
// Subscript are the `x^2^` and `H~2~O` of markdownguide.org's extended syntax, and ship with the
// same package - the styles they get are the ones `<sup>` and `<sub>` already use, so a note can
// write either.
const parser = baseParser.configure([
  Table,
  TableRows,
  Tasks,
  Strikethrough,
  Autolink,
  Superscript,
  Subscript,
  Highlight,
  parseCode({ codeParser }),
]);

export const markdownLanguage = new Language(markdownFacet, parser, [], 'markdown');
