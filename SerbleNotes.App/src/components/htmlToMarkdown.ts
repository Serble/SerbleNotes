import { escapeCell, renderTable, type Align, type Table } from './tableFormat';

/**
 * What HTML on the clipboard means as markdown, decided once for everywhere a paste can land.
 *
 * Copying a masked link out of a web page, a Word document or a Google Doc and pasting it into a
 * note used to drop the link: the editor read only the clipboard's `text/plain` flavour, and the
 * `text/html` flavour sitting beside it - which is where every one of those applications puts the
 * formatting - was never looked at. This file reads it, and turns it into the markdown dialect this
 * app actually speaks, so a heading arrives as a heading, a list as a list, a table as a table, and
 * a link as `[text](url)`.
 *
 * Three rules shape the whole of it:
 *
 * - **The output is text, not markup.** Nothing here emits HTML it was handed; every tag becomes a
 *   markdown construct or contributes only its words. That is what keeps this off the security
 *   boundary entirely - what lands in the note is a string in a text document, and what a note may
 *   *draw* is still decided in one place, by `noteHtml.ts`, when it is drawn. The handful of tags
 *   written out as tags (`<u>`, and nothing else) are constructed here from a fixed name, never
 *   copied through.
 * - **Formatting is read from inline styles as well as from tags**, because that is the only way
 *   Google Docs works at all: Docs marks bold as `<span style="font-weight:700">`, not `<strong>`,
 *   and wraps the whole fragment in `<b style="font-weight:normal">`. A converter that trusted tag
 *   names would render every Docs paste entirely bold and lose every emphasis in it.
 * - **What cannot be represented is kept as its words, never dropped.** An unknown tag contributes
 *   its text; a link this app would not open contributes its label. The one exception is markup
 *   that is not content at all - a stylesheet, a script, a `<select>`'s list of options - which is
 *   dropped whole, because pasting it as prose would be worse than pasting nothing.
 */

/* ------------------------------------------------------------------------- the shape of a node */

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/**
 * Elements whose contents are not part of the document a person thought they were copying.
 *
 * `style` and `script` are the obvious ones - Word puts kilobytes of CSS on the clipboard with every
 * copy, and pasting it as prose is how a two-line quote becomes two hundred lines. The form controls
 * are here for a quieter reason: a `<select>` carries every option it has ever offered, and only one
 * of them was on the screen.
 */
const DROPPED = new Set([
  'script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'base',
  'iframe', 'object', 'embed', 'applet', 'canvas', 'svg', 'math',
  'select', 'optgroup', 'option', 'textarea', 'input',
  'video', 'audio', 'source', 'track', 'param', 'colgroup', 'col',
]);

/** Elements that stand on their own line. Everything else is part of a run of text. */
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'caption', 'center', 'dd', 'details', 'div', 'dl',
  'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody',
  'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

const BLOCK_SELECTOR = [...BLOCK].join(',');

interface Ctx {
  /** Inside a link: it may not hold another, and its underline is decoration rather than markup. */
  link: boolean;
  /** Inside `<pre>`: whitespace is text, and nothing is escaped. */
  pre: boolean;
  /** Somewhere only inline markup can be written - a table cell, a heading. */
  inlineOnly: boolean;
}

const BASE: Ctx = { link: false, pre: false, inlineOnly: false };

/** A finished block, and whether the one before it should sit tight against it (a nested list). */
interface Block {
  text: string;
  list: boolean;
}

function tagOf(node: Node): string {
  return (node as Element).tagName?.toLowerCase() ?? '';
}

/* --------------------------------------------------------------------------- inline styles */

/**
 * The declarations in an element's `style` attribute, read from the attribute rather than through
 * the CSSOM.
 *
 * `element.style` would be the obvious way and is the wrong one here: what a browser's CSSOM keeps
 * for a shorthand like `text-decoration` differs between engines and between a browser and the DOM
 * this is tested under, so the same paste would convert differently depending on where it landed.
 * The attribute is the same string everywhere. Splitting it on `;` and the first `:` is enough for
 * the six properties below - none of them takes a value that can contain either.
 */
function styleOf(element: Element): Map<string, string> {
  const out = new Map<string, string>();
  const raw = element.getAttribute('style');
  if (!raw) {
    return out;
  }

  for (const declaration of raw.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon > 0) {
      out.set(declaration.slice(0, colon).trim().toLowerCase(), declaration.slice(colon + 1).trim().toLowerCase());
    }
  }
  return out;
}

/**
 * Whether an element is bold, italic and so on: the inline style decides when it says anything at
 * all, and the tag decides otherwise.
 *
 * That order is the whole reason this works on a Google Doc. Docs wraps its fragment in
 * `<b style="font-weight:normal">` - a `<b>` that is explicitly not bold - and then marks the words
 * that really are bold as `<span style="font-weight:700">`. Reading the tag first bolds the entire
 * paste and finds no emphasis anywhere in it.
 */
function isBold(element: Element, style: Map<string, string>): boolean {
  const weight = style.get('font-weight');
  if (weight) {
    return weight === 'bold' || weight === 'bolder' || Number.parseInt(weight, 10) >= 600;
  }
  const tag = tagOf(element);
  return tag === 'b' || tag === 'strong';
}

function isItalic(element: Element, style: Map<string, string>): boolean {
  const font = style.get('font-style');
  if (font) {
    return font === 'italic' || font.startsWith('oblique');
  }
  const tag = tagOf(element);
  return tag === 'i' || tag === 'em';
}

/** `text-decoration` is read as a shorthand, because that is how every one of these writes it. */
function decoration(style: Map<string, string>): string {
  return `${style.get('text-decoration') ?? ''} ${style.get('text-decoration-line') ?? ''}`;
}

function isStruckThrough(element: Element, style: Map<string, string>): boolean {
  const line = decoration(style);
  if (line.trim()) {
    return line.includes('line-through');
  }
  const tag = tagOf(element);
  return tag === 's' || tag === 'strike' || tag === 'del';
}

function isUnderlined(element: Element, style: Map<string, string>): boolean {
  const line = decoration(style);
  if (line.trim()) {
    return line.includes('underline');
  }
  const tag = tagOf(element);
  return tag === 'u' || tag === 'ins';
}

/**
 * A highlight, which is a background colour that is actually a colour.
 *
 * Google Docs writes `background-color:transparent` on every span it emits, so "has a background"
 * is not the question - "has one that would be visible" is. White is excluded for the same reason:
 * a word processor sets it on ordinary text as often as a highlighter does.
 */
const NO_COLOUR = new Set(['transparent', 'inherit', 'initial', 'unset', 'none', '#fff', '#ffffff', 'white', 'rgb(255, 255, 255)', 'rgb(255,255,255)']);

function isHighlighted(element: Element, style: Map<string, string>): boolean {
  const colour = style.get('background-color') ?? style.get('background');
  if (colour) {
    return !NO_COLOUR.has(colour);
  }
  return tagOf(element) === 'mark';
}

function isSubscript(element: Element, style: Map<string, string>): boolean {
  const align = style.get('vertical-align');
  if (align === 'sub') {
    return true;
  }
  return tagOf(element) === 'sub';
}

function isSuperscript(element: Element, style: Map<string, string>): boolean {
  const align = style.get('vertical-align');
  if (align === 'super') {
    return true;
  }
  return tagOf(element) === 'sup';
}

/**
 * Word writes a list as ordinary paragraphs, and hides the bullet or number it drew in a span
 * marked `mso-list: Ignore`. That span is the marker, not the text, so it never becomes words -
 * `wordList` reads it to decide what kind of item this is and this drops it everywhere else.
 */
function isWordMarker(style: Map<string, string>): boolean {
  return (style.get('mso-list') ?? '') === 'ignore';
}

/* ------------------------------------------------------------------------------- text and escapes */

/**
 * HTML whitespace, collapsed the way a browser lays it out - and a non-breaking space with it.
 *
 * The nbsp is not pedantry: Word and Docs use them for ordinary gaps between words, and a note is
 * source text somebody reads and edits by hand. A character that looks exactly like a space, is not
 * one, and cannot be seen is the worst thing to leave in a document; what the user saw was a space,
 * so a space is what they get.
 *
 * `white-space: pre-wrap` in the source is deliberately ignored. Google Docs sets it on every span
 * it writes while its markup is also broken across lines for readability, so honouring it would
 * turn the line breaks in Docs' own file into line breaks in the note. Only a real `<pre>` keeps
 * its whitespace.
 */
function collapse(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/[\t\r\n ]+/g, ' ');
}

/** Everything on one line, for the places that can only hold one: a heading, a table cell. */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ');
}

/**
 * Copied words, made safe to write into a note.
 *
 * Everything that opens markup in this app's dialect is escaped, so a sentence that happens to
 * contain an asterisk arrives as a sentence rather than as half of an emphasis. Two of them are
 * narrowed rather than escaped outright, because the alternative is source text nobody wants to
 * read:
 *
 * - **`_` only at a word boundary.** `snake_case_name` is not emphasis in CommonMark and escaping
 *   every underscore in it produces `snake\_case\_name`, which is what the person editing the note
 *   then has to look at on the cursor's line.
 * - **`=` only in a run of two or more**, which is what `==highlight==` needs. `a = b` is left as
 *   it is.
 *
 * `|` is not escaped. It only means anything inside a table, and cells are escaped by `escapeCell`
 * on the way into one.
 */
function escapeText(text: string): string {
  return text
    .replace(/([\\`*[\]<~^])/g, '\\$1')
    .replace(/_/g, (_match, at: number, whole: string) => {
      const before = whole[at - 1] ?? '';
      const after = whole[at + 1] ?? '';
      return /\w/.test(before) && /\w/.test(after) ? '_' : '\\_';
    })
    .replace(/={2,}/g, (run) => run.replace(/=/g, '\\='));
}

/**
 * The characters that mean something only at the start of a line, escaped once the line exists.
 *
 * This cannot be done in `escapeText`, because whether a character starts a line is not known until
 * the inline text has been assembled and broken by `<br>`. `*` is already escaped by then, so a
 * bullet written with one is covered.
 */
function escapeLineStart(line: string): string {
  return line
    .replace(/^(\s*)(#{1,6})(\s|$)/, '$1\\$2$3')
    .replace(/^(\s*)([>+-])(\s|$)/, '$1\\$2$3')
    .replace(/^(\s*)(\d{1,9})([.)])(\s)/, '$1$2\\$3$4')
    .replace(/^(\s*)([-=])(\2+)$/, '$1\\$2$3');
}

/** A run of copied text as a paragraph: every line of it safe to be a line of a note. */
function paragraph(text: string): string {
  return text.split('\n').map(escapeLineStart).join('\n');
}

/**
 * Puts a delimiter round some text without putting it round the whitespace at the ends.
 *
 * `** bold **` is not bold in CommonMark - a delimiter has to be next to the word it applies to -
 * and a run of copied text very often has its spaces inside the span rather than outside it.
 */
function wrap(text: string, open: string, close: string = open): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  if (!match || !match[2]) {
    return text;
  }
  return `${match[1]}${open}${match[2]}${close}${match[3]}`;
}

/** The longest run of `character` in `text`, so a fence or a code span can be longer than it. */
function longestRun(text: string, character: string): number {
  let longest = 0;
  let run = 0;
  for (const found of text) {
    run = found === character ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

/** Every line but the first, indented - what puts a block underneath a list marker. */
function indentRest(text: string, pad: string): string {
  return text
    .split('\n')
    .map((line, index) => (index === 0 || line === '' ? line : pad + line))
    .join('\n');
}

/* ------------------------------------------------------------------------------------ addresses */

/**
 * The schemes a copied link keeps.
 *
 * `http` and `https` are what this app opens (`linkClicks.ts` decides that, and refuses everything
 * else). `mailto` is kept anyway: it is not clickable here, but an address is the whole content of
 * such a link and dropping it to leave the person's name behind loses the only part worth pasting.
 * Everything else - `javascript:`, `file:`, `data:`, and a relative path with nothing to resolve it
 * against - is not a link, and the text it was written on is pasted as text.
 */
const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * The address a redirector was standing in for.
 *
 * Google Docs rewrites every link it copies as `google.com/url?q=...`, and Outlook rewrites them as
 * a Safe Links address. Neither is what the person copied - they are that application's own
 * tracking, and pasting one into a note stores a URL that expires, identifies the sender, and says
 * nothing about where it goes. The loop has a bound because the two nest: a link mailed through
 * Outlook and then copied out of a Doc arrives wrapped twice.
 */
function unwrapRedirect(url: URL): URL {
  let current = url;

  for (let depth = 0; depth < 3; depth++) {
    const host = current.hostname.toLowerCase();
    const inner =
      /(^|\.)google\.[a-z][a-z.]*$/.test(host) && current.pathname === '/url'
        ? current.searchParams.get('q') ?? current.searchParams.get('url')
        : /(^|\.)safelinks\.protection\.outlook\.com$/.test(host)
          ? current.searchParams.get('url')
          : null;

    if (inner === null) {
      return current;
    }

    let next: URL;
    try {
      next = new URL(inner);
    } catch {
      return current;
    }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      return current;
    }
    current = next;
  }

  return current;
}

/** An `href` or `src` as an address this app will write down, or null if it is not one. */
function destination(raw: string | null): string | null {
  if (!raw?.trim()) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    // Relative, and there is nothing to resolve it against: the clipboard carries a fragment, not
    // the page it came from. A link that cannot be followed is not written as one.
    return null;
  }

  const target = unwrapRedirect(url);
  return LINK_SCHEMES.has(target.protocol) ? target.href : null;
}

/**
 * An address as it is written inside `(...)`.
 *
 * A destination containing a bracket or a space has to go in angle brackets or the link ends at the
 * first `)`. `new URL` has already dealt with spaces; brackets it leaves alone, and a URL with a
 * bracket in it is common enough (Wikipedia writes them) to be worth getting right.
 */
function inBrackets(url: string): string {
  if (!/[()\s<>]/.test(url)) {
    return url;
  }
  return `<${url.replace(/</g, '%3C').replace(/>/g, '%3E')}>`;
}

/* -------------------------------------------------------------------------------------- inline */

function inlineOf(nodes: Iterable<Node>, ctx: Ctx): string {
  let out = '';
  for (const node of nodes) {
    out += inlineNode(node, ctx);
  }
  return out;
}

function inlineNode(node: Node, ctx: Ctx): string {
  if (node.nodeType === TEXT_NODE) {
    const raw = node.nodeValue ?? '';
    return ctx.pre ? raw : escapeText(collapse(raw));
  }
  if (node.nodeType !== ELEMENT_NODE) {
    return '';
  }

  const element = node as Element;
  const tag = tagOf(element);
  if (DROPPED.has(tag)) {
    return '';
  }

  const style = styleOf(element);
  if (isWordMarker(style)) {
    return '';
  }

  if (tag === 'br') {
    return '\n';
  }
  if (tag === 'wbr') {
    return '';
  }
  if (tag === 'img') {
    return image(element);
  }
  if (tag === 'a') {
    return anchor(element, ctx);
  }
  if (tag === 'code' && !ctx.pre) {
    return codeSpan(element);
  }

  const inner = inlineOf(element.childNodes, ctx);
  if (!inner.trim()) {
    // Whitespace only, and it is still whitespace: a `<span> </span>` between two words is the gap
    // between them.
    return inner;
  }

  let text = inner;
  if (isSubscript(element, style)) {
    text = wrap(text, '~');
  }
  if (isSuperscript(element, style)) {
    text = wrap(text, '^');
  }
  if (isStruckThrough(element, style)) {
    text = wrap(text, '~~');
  }
  if (isHighlighted(element, style)) {
    text = wrap(text, '==');
  }
  // Markdown has no underline, and this app draws the HTML one. Not inside a link, where the
  // underline is how the link was drawn rather than something somebody asked for - every word
  // processor underlines them, and `<u>` round every pasted link is noise nobody wrote.
  if (isUnderlined(element, style) && !ctx.link) {
    text = wrap(text, '<u>', '</u>');
  }
  if (isItalic(element, style)) {
    text = wrap(text, '*');
  }
  if (isBold(element, style)) {
    text = wrap(text, '**');
  }

  // Only reachable where a block has been asked to be inline - a table cell holding a paragraph.
  // Its words join the run with a space rather than starting a line that cannot exist here.
  return BLOCK.has(tag) ? `${text} ` : text;
}

/**
 * A link, as `[text](url)` - the whole point of this file.
 *
 * Three shapes come out of it. A link whose text is already its address is written bare, because
 * `[https://x](https://x)` is nobody's intention and the parser autolinks it anyway. A link this
 * app would not open contributes its label, so the words survive even though the address does not.
 * Everything else is the masked link that was copied.
 */
function anchor(element: Element, ctx: Ctx): string {
  const inner = inlineOf(element.childNodes, { ...ctx, link: true });
  const label = oneLine(inner).trim();
  const url = destination(element.getAttribute('href'));

  // A link inside a link cannot be written down, and the inner one is the one that was nested by
  // accident. Its words are kept.
  if (url === null || ctx.link) {
    return inner;
  }
  if (!label) {
    // No text at all - an image link whose picture was dropped, or a bookmark anchor. The address
    // is the only thing left worth having.
    return url;
  }
  if (collapse(element.textContent ?? '').trim() === url) {
    return url;
  }

  return `[${label}](${inBrackets(url)})`;
}

/**
 * A picture, as `![alt](url)`.
 *
 * Only an address this app could show. A `data:` image is refused rather than written: a screenshot
 * pasted out of a word processor arrives as several megabytes of base64, and a note is a document
 * somebody edits by hand. What is left is the alt text, which is what this app draws for a remote
 * image anyway (see `noteHtml.ts`), so nothing is lost that was ever going to be seen.
 */
function image(element: Element): string {
  const alt = collapse(element.getAttribute('alt') ?? '').trim();
  const src = destination(element.getAttribute('src'));

  if (src === null || !src.startsWith('http')) {
    return alt ? escapeText(alt) : '';
  }
  return `![${escapeText(alt)}](${inBrackets(src)})`;
}

/** Inline code, in enough backticks to hold whatever is in it. */
function codeSpan(element: Element): string {
  const raw = collapse(element.textContent ?? '');
  if (!raw.trim()) {
    return '';
  }

  const ticks = '`'.repeat(longestRun(raw, '`') + 1);
  // A span that starts or ends with a backtick needs a space inside the fence, which the parser
  // then strips back off.
  const pad = raw.startsWith('`') || raw.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${raw}${pad}${ticks}`;
}

/* --------------------------------------------------------------------------------------- blocks */

/**
 * Whether an element that is not itself a block has one inside it.
 *
 * This is what makes a Google Doc convert at all. Docs wraps its whole fragment in a single `<b>`,
 * which is an inline tag holding every paragraph in the copied selection - so a walker that decided
 * "not a block, therefore a run of text" would flatten the entire document into one line. Such an
 * element is transparent instead: its children are laid out as blocks, and whatever it was setting
 * is lost. That loss is the right way round here, because the thing Docs is setting on it is
 * `font-weight: normal`.
 */
function holdsBlock(element: Element): boolean {
  return element.querySelector(BLOCK_SELECTOR) !== null;
}

function blocksOf(parent: Node, ctx: Ctx): Block[] {
  const out: Block[] = [];
  let run: Node[] = [];

  const flush = () => {
    const text = inlineOf(run, ctx).trim();
    run = [];
    if (text) {
      out.push({ text: paragraph(text), list: false });
    }
  };

  const children = [...parent.childNodes];
  for (let index = 0; index < children.length; index++) {
    const child = children[index];

    if (child.nodeType !== ELEMENT_NODE) {
      run.push(child);
      continue;
    }

    const element = child as Element;
    const tag = tagOf(element);
    if (DROPPED.has(tag)) {
      continue;
    }

    // Word writes a list as a run of ordinary paragraphs. They have to be taken together or each
    // one becomes a paragraph of its own with a stray bullet in front of it.
    if (isWordListItem(element)) {
      flush();
      let end = index + 1;
      while (end < children.length && children[end].nodeType === ELEMENT_NODE && isWordListItem(children[end] as Element)) {
        end++;
      }
      out.push({ text: wordList(children.slice(index, end) as Element[], ctx), list: true });
      index = end - 1;
      continue;
    }

    if (!BLOCK.has(tag) && !holdsBlock(element)) {
      run.push(child);
      continue;
    }

    flush();
    out.push(...blockOf(element, ctx));
  }

  flush();
  return out.filter((block) => block.text !== '');
}

function blockOf(element: Element, ctx: Ctx): Block[] {
  const tag = tagOf(element);
  const loose = (text: string): Block[] => (text ? [{ text, list: false }] : []);

  switch (tag) {
    case 'p':
    case 'dd': {
      const text = inlineOf(element.childNodes, ctx).trim();
      return loose(text ? paragraph(text) : '');
    }
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const text = oneLine(inlineOf(element.childNodes, { ...ctx, inlineOnly: true })).trim();
      return loose(text ? `${'#'.repeat(Number(tag[1]))} ${text}` : '');
    }
    case 'dt': {
      const text = oneLine(inlineOf(element.childNodes, { ...ctx, inlineOnly: true })).trim();
      return loose(text ? wrap(text, '**') : '');
    }
    case 'hr':
      return loose('---');
    case 'blockquote':
      return loose(quote(join(blocksOf(element, ctx))));
    case 'pre':
      return loose(fenced(element));
    case 'ul':
    case 'ol':
      return [{ text: list(element, ctx), list: true }].filter((block) => block.text !== '');
    case 'table':
      return tableBlocks(element, ctx);
    default:
      // Every other container - a `div`, a `section`, a stray `li`, the `<b>` a Google Doc wraps
      // everything in - is transparent, and the blocks inside it are the blocks.
      return blocksOf(element, ctx);
  }
}

/** Blocks as one document, a blank line between each. */
function join(blocks: Block[]): string {
  return blocks.map((block) => block.text).join('\n\n');
}

/**
 * The same, inside a list item, where a nested list sits tight against the line it hangs off.
 *
 * Only here. Joining every list tightly to whatever came before it was the first version of this,
 * and it put a list directly under the heading above it - which happens to parse, and is not what
 * anybody writes. A sublist is the one case where the blank line is wrong, because the item above
 * it is what it belongs to.
 */
function joinItem(blocks: Block[]): string {
  return blocks.reduce(
    (text, block, index) => (index === 0 ? block.text : `${text}${block.list ? '\n' : '\n\n'}${block.text}`),
    '',
  );
}

/** Every line prefixed with a quote marker, at whatever depth the quotes were nested. */
function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

/**
 * A fenced code block, with the language written after the fence when the markup names one.
 *
 * `textContent` rather than a walk: a `<pre>` is text by definition, and the syntax highlighting
 * every code viewer puts inside one is spans that are not part of the code.
 */
function fenced(element: Element): string {
  const text = (element.textContent ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const fence = '`'.repeat(Math.max(3, longestRun(text, '`') + 1));
  return `${fence}${languageOf(element)}\n${text}\n${fence}`;
}

/** The language a code block was highlighted as, written by every convention worth knowing. */
const LANGUAGE_CLASS = /(?:^|\s)(?:language|lang|highlight-source|brush:?)[-\s]([a-z0-9+#]+)/i;

function languageOf(element: Element): string {
  for (const candidate of [element, element.querySelector('code')]) {
    const found = LANGUAGE_CLASS.exec(candidate?.getAttribute('class') ?? '');
    if (found) {
      return found[1].toLowerCase();
    }
  }
  return '';
}

/* ---------------------------------------------------------------------------------------- lists */

function list(element: Element, ctx: Ctx): string {
  const ordered = tagOf(element) === 'ol';
  const start = Number.parseInt(element.getAttribute('start') ?? '1', 10);
  const first = Number.isFinite(start) ? start : 1;
  const items = [...element.children].filter((child) => tagOf(child) === 'li');

  const lines = items.map((item, index) => {
    const marker = ordered ? `${first + index}. ` : '- ';
    const body = joinItem(blocksOf(item, ctx)).trim();
    return `${marker}${taskBox(item)}${indentRest(body, ' '.repeat(marker.length))}`;
  });

  return lines.filter((line) => line.trim() !== '-' && line.trim() !== '').join('\n');
}

/**
 * A tickable box, when the item carries the checkbox every editor writes one with.
 *
 * The `<input>` itself is dropped like every other form control, so this is the only thing that
 * looks at it - which is why it is read here rather than being left to contribute a stray character
 * to the item's text.
 */
function taskBox(item: Element): string {
  const box = item.querySelector('input[type="checkbox" i]');
  if (!box) {
    return '';
  }
  return box.hasAttribute('checked') || (box as HTMLInputElement).checked ? '[x] ' : '[ ] ';
}

/** A paragraph Word wrote as part of a list. */
function isWordListItem(element: Element): boolean {
  return tagOf(element) === 'p' && /mso-list\s*:/i.test(element.getAttribute('style') ?? '');
}

/**
 * Word's lists, which are not lists.
 *
 * A list copied out of Word is a run of `<p style="mso-list:l0 level2 lfo1">`, each one holding the
 * bullet or number it drew inside a span marked `mso-list: Ignore`. The nesting is in `level`, the
 * kind of list is whatever that span says, and neither is anywhere a walker looking for `<ul>` will
 * ever find them. Left alone, a five-item list pastes as five paragraphs each beginning with a
 * stray bullet character.
 */
function wordList(items: Element[], ctx: Ctx): string {
  return items
    .map((item) => {
      const style = item.getAttribute('style') ?? '';
      const level = Math.max(1, Number.parseInt(/level(\d+)/i.exec(style)?.[1] ?? '1', 10) || 1);
      const marker = item.querySelector('[style*="mso-list" i]');
      const number = /^\(?(\d+)[.)]?$/.exec((marker?.textContent ?? '').trim());
      const bullet = number ? `${number[1]}. ` : '- ';
      const body = oneLine(inlineOf(item.childNodes, ctx)).trim();
      return body ? `${'  '.repeat(level - 1)}${bullet}${body}` : '';
    })
    .filter((line) => line !== '')
    .join('\n');
}

/* --------------------------------------------------------------------------------------- tables */

/**
 * A copied table, laid out by the same `renderTable` every table in this app is written with.
 *
 * That reuse is the point rather than a convenience: a pasted table is padded to its columns and
 * aligned exactly like one typed here, so it reads as a table in the source, in an export and on a
 * future filesystem mount - and the drawn table the editor puts on the screen is the same object
 * either way. A converter of its own would produce `| a | b |` and the difference would be visible
 * on the line below.
 *
 * Two things a markdown table cannot do, handled rather than refused. It has no way to say "no
 * header", so a table whose first row is ordinary cells gives that row up to be one - which is what
 * every reader of such a table assumes anyway. And a merged cell has no notation at all, so a
 * `colspan` becomes its text followed by the empty cells it was covering, which keeps every row the
 * same width instead of producing a table that cannot be parsed.
 */
function tableBlocks(element: Element, ctx: Ctx): Block[] {
  const out: Block[] = [];

  // This table's caption, not one belonging to a table inside it - the same reason `rowsOf` exists.
  const caption = [...element.children].find((child) => tagOf(child) === 'caption');
  if (caption) {
    const text = oneLine(inlineOf(caption.childNodes, { ...ctx, inlineOnly: true })).trim();
    if (text) {
      out.push({ text: paragraph(text), list: false });
    }
  }

  const rows: { cells: string[]; heading: boolean; align: Align[] }[] = [];
  for (const row of rowsOf(element)) {
    const cells: string[] = [];
    const align: Align[] = [];
    let heading = true;

    for (const cell of [...row.children]) {
      const tag = tagOf(cell);
      if (tag !== 'td' && tag !== 'th') {
        continue;
      }
      heading = heading && tag === 'th';

      const text = oneLine(inlineOf(cell.childNodes, { ...ctx, inlineOnly: true })).trim();
      const span = Math.max(1, Number.parseInt(cell.getAttribute('colspan') ?? '1', 10) || 1);
      cells.push(escapeCell(text));
      align.push(alignOf(cell));
      for (let extra = 1; extra < span; extra++) {
        cells.push('');
        align.push('none');
      }
    }

    if (cells.length) {
      rows.push({ cells, heading, align });
    }
  }

  if (!rows.length) {
    return out;
  }

  const width = Math.max(...rows.map((row) => row.cells.length));
  const pad = (cells: string[]) => Array.from({ length: width }, (_, column) => cells[column] ?? '');

  const head = rows[0];
  const table: Table = {
    indent: '',
    header: pad(head.cells),
    align: Array.from({ length: width }, (_, column) => head.align[column] ?? 'none'),
    rows: rows.slice(1).map((row) => pad(row.cells)),
  };

  out.push({ text: renderTable(table), list: false });
  return out;
}

/**
 * The rows of this table and not of a table inside it. `querySelectorAll` would reach into a nested
 * one and interleave its rows with these, which is a table that never existed.
 */
function rowsOf(element: Element): Element[] {
  const out: Element[] = [];
  for (const child of [...element.children]) {
    const tag = tagOf(child);
    if (tag === 'tr') {
      out.push(child);
    } else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
      out.push(...[...child.children].filter((row) => tagOf(row) === 'tr'));
    }
  }
  return out;
}

function alignOf(cell: Element): Align {
  const value = (styleOf(cell).get('text-align') ?? cell.getAttribute('align') ?? '').toLowerCase();
  return value === 'left' || value === 'center' || value === 'right' ? value : 'none';
}

/* ----------------------------------------------------------------------------------- the doors */

/** A parsed clipboard fragment, or null where there is no parser or nothing to parse. */
function parse(html: string): Element | null {
  try {
    return new DOMParser().parseFromString(html, 'text/html').body;
  } catch {
    return null;
  }
}

/** Three or more blank lines between blocks is nobody's document. */
function tidy(text: string): string {
  return text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Clipboard HTML as markdown - headings, lists, quotes, code, tables and links.
 *
 * The empty string means "there was nothing here worth pasting", and the caller should let the
 * plain-text flavour through rather than replacing it with nothing.
 */
export function htmlToMarkdown(html: string): string {
  const body = parse(html);
  return body ? tidy(join(blocksOf(body, BASE))) : '';
}

/**
 * The same, for somewhere that can only hold one line of inline markdown: a table cell.
 *
 * Blocks are not refused, they are flattened - a pasted paragraph becomes one line, which is the
 * rule a cell already follows for plain text (`escapeCell`). Emphasis, code and links survive,
 * because those are exactly the markup a cell can draw.
 */
export function inlineHtmlToMarkdown(html: string): string {
  const body = parse(html);
  if (!body) {
    return '';
  }
  return oneLine(inlineOf(body.childNodes, { ...BASE, inlineOnly: true })).replace(/\s+/g, ' ').trim();
}
