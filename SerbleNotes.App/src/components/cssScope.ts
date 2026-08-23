/**
 * A note's CSS, rewritten so it can only reach that note.
 *
 * This is the one part of drawing a note that can be quietly wrong rather than visibly broken: a
 * selector that comes out of here unprefixed still works, and what it styles is the app the note is
 * being read in - and nothing on the screen would say so. So the half of it that is string work is
 * kept as plain functions with no DOM in them, which is what lets the tests drive it. See
 * tests/cssScope.test.ts.
 */

/**
 * An `@import`, which is the one thing in a stylesheet that fetches from somewhere else.
 *
 * Taken out before the CSS is parsed rather than skipped after, because parsing is what would start
 * the request. Same reasoning as an image: a note is not allowed to tell a third party when it was
 * read. A font or a background carrying its own bytes still works.
 */
const IMPORT_RULE = /@import\b[^;{]*(;|\{[^}]*\})/gi;

/**
 * A note's CSS, rewritten so it can only reach that note.
 *
 * The rules are read with the browser's own parser rather than with a regular expression - a
 * stylesheet is not a thing to match patterns against, and the parser has already decided what every
 * selector and declaration means. Each rule's selectors are then prefixed with the scope, so
 * `p { color: red }` in a note becomes "paragraphs in this note", never paragraphs in the app around
 * it. `html`, `body` and `:root` are taken to mean the note itself, because that is what somebody
 * writing them means.
 *
 * What is not a style rule, a media query, a supports block, a keyframe or a font face is dropped -
 * an at-rule this app does not understand is not worth guessing at.
 */
export function scopeCss(css: string, scope: string): string {
  const rules = parse(css.replace(IMPORT_RULE, ''));
  return rules ? rulesToText(rules, scope) : '';
}

/**
 * A stylesheet, parsed but attached to nothing.
 *
 * A constructed sheet is the one kind that cannot be in force anywhere: it applies only to a
 * document that has adopted it, and this one is adopted by nothing. `replaceSync` also drops
 * `@import` rules itself, by specification, which is a second answer to the question the strip above
 * asks - a note is not allowed to tell a third party when it was read.
 *
 * The fallback is for an engine old enough not to have that, and does the same job the long way: a
 * style element in a document with no browsing context, which parses and is applied to nothing.
 */
function parse(css: string): CSSRuleList | null {
  if (typeof CSSStyleSheet === 'function') {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      return sheet.cssRules;
    } catch {
      // Older engines throw on the constructor rather than not having it.
    }
  }

  const holder = document.implementation.createHTMLDocument('note-css').createElement('style');
  holder.textContent = css;
  holder.ownerDocument.head.appendChild(holder);
  return holder.sheet?.cssRules ?? null;
}

function rulesToText(rules: CSSRuleList, scope: string): string {
  let text = '';

  for (const rule of rules) {
    if (rule instanceof CSSStyleRule) {
      text += `${prefixSelectorList(rule.selectorText, scope)}{${declarations(rule.style)}}\n`;
    } else if (rule instanceof CSSMediaRule) {
      text += `@media ${rule.conditionText}{\n${rulesToText(rule.cssRules, scope)}}\n`;
    } else if (rule instanceof CSSSupportsRule) {
      text += `@supports ${rule.conditionText}{\n${rulesToText(rule.cssRules, scope)}}\n`;
    } else if (rule instanceof CSSKeyframesRule || rule instanceof CSSFontFaceRule) {
      // Neither has selectors to scope: one is named and referred to by name, the other names a
      // font. Both are left as they were written.
      text += `${rule.cssText}\n`;
    }
  }

  return text;
}

/** A rule's declarations, with the one that would escape the note taken back inside it. */
function declarations(style: CSSStyleDeclaration): string {
  const text = style.cssText;
  return style.position === 'fixed' ? text.replace(/position:\s*fixed/gi, 'position: absolute') : text;
}

/** Prefixes every selector in a comma-separated list. */
export function prefixSelectorList(list: string, scope: string): string {
  return splitSelectors(list)
    .map((selector) => prefixSelector(selector, scope))
    .join(', ');
}

/** The document itself, however it was named. All three mean "this note" once scoped. */
const ROOT = /^(:root|html|body)\b/i;

export function prefixSelector(selector: string, scope: string): string {
  const trimmed = selector.trim();
  if (trimmed === '') {
    return scope;
  }

  const root = ROOT.exec(trimmed);
  if (root) {
    // `body.dark` has to stay one compound selector, so what follows the name is kept attached.
    return `${scope}${trimmed.slice(root[0].length)}`;
  }

  return `${scope} ${trimmed}`;
}

/**
 * A selector list split on its own commas - the ones between selectors, not the ones inside
 * `:is(a, b)`, `[title="a,b"]` or `:nth-child(2n, 1)`.
 */
export function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;

  for (let at = 0; at < list.length; at += 1) {
    const character = list[at];

    if (quote) {
      if (character === '\\') {
        at += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '(' || character === '[') {
      depth += 1;
    } else if (character === ')' || character === ']') {
      depth = Math.max(0, depth - 1);
    } else if (character === ',' && depth === 0) {
      out.push(list.slice(start, at));
      start = at + 1;
    }
  }

  out.push(list.slice(start));
  return out.filter((selector) => selector.trim() !== '');
}

