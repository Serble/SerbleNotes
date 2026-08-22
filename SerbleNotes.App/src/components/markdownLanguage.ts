import {
  Language,
  LanguageDescription,
  ParseContext,
  defineLanguageFacet,
} from '@codemirror/language';
import { GFM, parseCode, parser as baseParser } from '@lezer/markdown';
import { codeLanguages } from './codeLanguages';

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

const parser = baseParser.configure([GFM, parseCode({ codeParser })]);

export const markdownLanguage = new Language(markdownFacet, parser, [], 'markdown');
