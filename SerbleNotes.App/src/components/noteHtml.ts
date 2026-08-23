import DOMPurify from 'dompurify';

export { scopeCss } from './cssScope';

/**
 * What HTML in a note means, decided once for everywhere it can appear.
 *
 * A note may be written in HTML as well as markdown, and the HTML is *rendered* - not a short list
 * of inline tags mapped onto markdown's own styles, but tags, attributes, `style` on any of them,
 * `<style>` blocks, and `<font>`. Three places draw a note and all three come through here: the
 * editor's live preview (inline tags and HTML blocks), a table cell, and the rendered preview in the
 * history panel. One policy, so a note cannot look like two different documents depending on where
 * it is being read.
 *
 * **Nothing a note says ever runs.** There is no script, no event handler, no `iframe`, no form
 * control and no remote fetch. That is not a style rule, it is the boundary: a note is a document
 * that arrived from somewhere - imported from an archive, synced from another device, written by
 * somebody else - and this app decrypts it on the user's own origin, holding their vault key. Markup
 * from a note is inert, and anything on the page that acts was put there by this app.
 *
 * What that costs, stated rather than hidden: no `<script>`, no `<iframe>`/`<embed>`/`<object>`, no
 * `<form>`/`<input>`/`<button>`, no `<svg>`, and no `<audio>`/`<video>`. The first three are the
 * boundary itself. Form controls are refused for a quieter reason - a note that draws a password box
 * inside an app that has just asked for a vault password is a convincing thing to be shown, and no
 * note needs one. SVG and media are not refused on principle; they are simply not built yet, and a
 * tag that is not understood is shown as the text it is rather than swallowed.
 */

/** Everything a note may draw. Anything not here is left as the text it is. */
export const ALLOWED_TAGS = [
  // Structure.
  'div', 'span', 'p', 'br', 'wbr', 'hr', 'pre', 'blockquote',
  'section', 'article', 'aside', 'header', 'footer', 'nav', 'main',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'figure', 'figcaption', 'details', 'summary',
  // Text.
  'a', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins', 'mark', 'small', 'big',
  'sub', 'sup', 'code', 'kbd', 'samp', 'var', 'abbr', 'cite', 'q', 'dfn', 'time',
  'ruby', 'rt', 'rp', 'bdi', 'bdo',
  // Old, and still rendered by every browser there is. Someone reaching for `<font color=red>` in a
  // note is not writing a web page to a standard, they are colouring a line - and refusing it would
  // teach them nothing except that this editor is fussier than the one they used last.
  'font', 'center', 'img',
];

/**
 * Attributes a note may set. `style` and `class` are the two that make this "CSS support" rather
 * than "some tags": one styles an element where it stands, the other lets a `<style>` block reach
 * it. Presentational attributes are here for the same reason `<font>` is - `align="center"` is what
 * people actually write.
 *
 * There is no `on*` anything, and there cannot be: the list is exhaustive, so an event handler is
 * not refused by a rule that could be got round, it is simply not a name that appears here.
 */
export const ALLOWED_ATTR = [
  'style', 'class', 'id', 'title', 'lang', 'dir',
  'href', 'src', 'alt', 'width', 'height',
  'align', 'valign', 'color', 'face', 'size', 'bgcolor', 'border', 'cellpadding', 'cellspacing',
  'colspan', 'rowspan', 'span', 'start', 'reversed', 'type', 'value',
  'datetime', 'cite', 'open', 'hidden',
];

/**
 * Tags that are refused by name as well as by omission.
 *
 * `style` is here because a note's CSS is not rendered where it was written - it is collected,
 * scoped to the note and applied to the whole of it, which is the only way a rule written at the
 * bottom can reach a paragraph at the top. Leaving the element in as well would apply it twice, and
 * the second time unscoped.
 */
const FORBID_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'template'];

const CONFIG = { ALLOWED_TAGS, ALLOWED_ATTR, FORBID_TAGS, ALLOW_DATA_ATTR: false } as const;

/** Void elements, which have no closing tag and so can never be a pair. */
export const VOID_TAGS = new Set(['br', 'wbr', 'hr', 'img', 'col']);

/** Whether this app will draw a tag by this name at all. */
export function isKnownTag(name: string): boolean {
  return ALLOWED_TAGS.includes(name);
}

/* --------------------------------------------------------------------------- rendering markup */

/**
 * A note's HTML with everything this app will not let it do taken out of it: sanitised, and then
 * tamed - no fixed positioning, no `target`, and no picture that would have to be fetched.
 *
 * Links are *not* wired up here. Where a link is clickable and what a click on one does differs
 * between the editor, a table cell and the rendered preview, and each says so itself.
 */
export function sanitiseFragment(html: string): DocumentFragment {
  const fragment = DOMPurify.sanitize(html, {
    ...CONFIG,
    RETURN_DOM_FRAGMENT: true,
  }) as unknown as DocumentFragment;

  for (const element of fragment.querySelectorAll<HTMLElement>('*')) {
    tameElement(element);
  }
  for (const image of [...fragment.querySelectorAll('img')]) {
    replaceRemoteImage(image);
  }
  return fragment;
}

/** The same, as markup, for the one caller that has an `innerHTML` to fill rather than a parent. */
export function sanitiseHtml(html: string): string {
  const holder = document.createElement('div');
  holder.appendChild(sanitiseFragment(html));
  return holder.innerHTML;
}

/**
 * A note's HTML, ready to put on the page, with its links wired to open in a browser rather than
 * navigating this app out from under itself.
 */
export function renderNoteHtml(html: string): DocumentFragment {
  const fragment = sanitiseFragment(html);
  bindLinks(fragment);
  return fragment;
}

/**
 * An image that would have to be fetched is shown as its alt text instead.
 *
 * Asking a host for a picture tells it when this note was opened and from where, which is precisely
 * what a vault the server cannot read exists to avoid - and the native clients' content policy
 * refuses the request anyway, so the honest outcome is the reference, not a broken picture. An image
 * that carries its own bytes (`data:`) is drawn: it is already in the note.
 */
function replaceRemoteImage(image: HTMLImageElement): void {
  if (image.getAttribute('src')?.trim().toLowerCase().startsWith('data:')) {
    return;
  }

  const text = document.createElement('span');
  text.className = 'cm-md-image';
  text.textContent = image.getAttribute('alt') || image.getAttribute('src') || 'image';
  image.replaceWith(text);
}

/**
 * The two things an element may not do, applied wherever one is drawn.
 *
 * A note styles itself, not the app around it. `position: fixed` is measured against the window
 * rather than against anything in the note, so it is the one declaration that can put a note's
 * markup over the vault list, the app bar or a password box - and a note is a region of a page, not
 * the page. It becomes `absolute`, which is the same layout inside the note and stays inside it.
 *
 * The rest is `target`: an anchor that opens itself in this window would navigate the app away, and
 * links are opened by `bindLinks` below instead.
 */
function tameElement(element: HTMLElement): void {
  if (element.style.position === 'fixed') {
    element.style.position = 'absolute';
  }
  element.removeAttribute('target');
}

/**
 * Every link in a note's own markup, opened the way every other link in a note is opened: the system
 * browser, http and https only, decided by `openLink`.
 *
 * A real anchor inside the app would otherwise replace the app with the page it points at - there is
 * no back button in a webview - and inside the editor it would do that from a click that was meant
 * to put the caret somewhere.
 */
export function bindLinks(root: ParentNode): void {
  for (const anchor of root.querySelectorAll('a[href]')) {
    anchor.addEventListener('click', (event) => {
      event.preventDefault();
      // Fetched at the click rather than imported at the top, because this file is what decides
      // what a note may say and linkClicks.ts is one of the things that draws one. Nothing shared
      // should have to load an editor extension to be read.
      void import('./linkClicks').then(({ openLink }) => openLink(anchor.getAttribute('href') ?? ''));
    });
  }
}

/**
 * Whether drawing this markup would still say everything it says.
 *
 * Two questions, and both have to be yes before a note's markup is drawn rather than shown as the
 * text it is.
 *
 * 1. Is every element in it one this app draws? An editor that silently swallowed `<script>` would
 *    be lying about what the note says, and one that ran it would be worse.
 * 2. Did sanitising keep all of the text? `<script>alert(1)</script>` is text inside an element that
 *    goes, and a `<td>` written with no table round it is dropped by the HTML parser before this app
 *    sees it. Either way what a reader would be shown is a gap where their words were.
 *
 * Losing an *attribute* is not losing text: an `onclick` that will never run is markup this app
 * removes, the way markdown's own punctuation stops being shown. Nor is gaining any - a picture that
 * would have to be fetched becomes its own alt text, which says more rather than less.
 *
 * `template` is inert: nothing inside one loads, runs or is fetched, which is what makes it safe to
 * look at markup that has not been through the sanitiser yet.
 */
export function drawsFaithfully(html: string): boolean {
  const holder = document.createElement('template');
  holder.innerHTML = html;

  for (const element of holder.content.querySelectorAll('*')) {
    if (!isKnownTag(element.tagName.toLowerCase())) {
      return false;
    }
  }

  return textOf(sanitiseHtml(html)).includes(holder.content.textContent ?? '');
}

/** The text a fragment would show, measured the same inert way. */
function textOf(html: string): string {
  const holder = document.createElement('template');
  holder.innerHTML = html;
  return holder.content.textContent ?? '';
}

/**
 * The attributes an opening tag sets, as this app will let them stand - or null if it is not a tag
 * this app draws.
 *
 * This is the editor's inline path: a `<font color="red">...</font>` in the middle of a paragraph
 * becomes a real `<font color="red">` wrapped round the text by a mark decoration, so the browser
 * renders it exactly as it would anywhere else. The tag is put through the same sanitiser as
 * everything else by being made into a scrap of a document and read back - one policy, no second
 * list of what an attribute may be.
 */
export function tagAttributes(raw: string, name: string): Record<string, string> | null {
  if (!isKnownTag(name)) {
    return null;
  }

  const holder = sanitiseFragment(`${raw}</${name}>`);
  const element = holder.firstElementChild;
  if (!(element instanceof HTMLElement) || element.tagName.toLowerCase() !== name) {
    return null;
  }

  const attributes: Record<string, string> = {};
  for (const { name: key, value } of element.attributes) {
    attributes[key] = value;
  }
  return attributes;
}

/* ------------------------------------------------------------------------------ style blocks */

/** A `<style>` element written anywhere in a note, and what is inside it. */
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;

/** The CSS in a run of HTML. The markup itself is left alone; nothing here draws. */
export function cssIn(html: string): string {
  let css = '';
  for (const match of html.matchAll(STYLE_BLOCK)) {
    css += `${match[1]}\n`;
  }
  return css;
}

/** Whether a run of HTML is nothing but a style block. */
export function isOnlyStyle(html: string): boolean {
  return html.replace(STYLE_BLOCK, '').trim() === '';
}

/* ------------------------------------------------------------------------------- reading tags */

export interface TagToken {
  /** Where it is, relative to the start of the text it was found in. */
  from: number;
  to: number;
  raw: string;
  name: string;
  closing: boolean;
}

const TAG_TEXT = /<\/?[a-zA-Z][^>]*>/g;

/** Every tag in a run of text, in the order they appear. Comments and stray `<` are not tags. */
export function tagsIn(text: string): TagToken[] {
  const tokens: TagToken[] = [];

  for (const match of text.matchAll(TAG_TEXT)) {
    const raw = match[0];
    const name = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(raw);
    if (!name) {
      continue;
    }
    tokens.push({
      from: match.index,
      to: match.index + raw.length,
      raw,
      name: name[2].toLowerCase(),
      closing: name[1] === '/',
    });
  }

  return tokens;
}
