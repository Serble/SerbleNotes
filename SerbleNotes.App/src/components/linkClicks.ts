import { syntaxTree } from '@codemirror/language';
import { EditorView, ViewPlugin, type PluginValue } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { isNative } from '../services/platform';

/**
 * A link in a note, followed by clicking it.
 *
 * A plain click is for editing - this is an editor, and text under the pointer is text you are
 * about to change. Ctrl-click (Cmd on a Mac) opens it, which is what a link in an editor does
 * everywhere else. On a touchscreen there is no modifier to hold, so the long-press menu offers
 * "Open link" for the link under the finger.
 *
 * **Only http and https.** A note is a document from anywhere - imported, synced, written by
 * someone else - and `javascript:` in a link is a script this app would be running on its own
 * origin. `file:` would hand the shell a path. Neither is refused with a warning: they are simply
 * not links, so the click places the caret and the text is left saying what it says.
 */
export const linkClicks = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) {
      return false;
    }

    const target = event.target;
    if (!(target instanceof Element)) {
      return false;
    }

    const mark = target.closest('.cm-md-link');
    if (!mark) {
      return false;
    }

    const at = view.posAtDOM(mark);

    const url = destinationAt(view, at);
    if (url === null) {
      return false;
    }

    event.preventDefault();
    void openLink(url);
    return true;
  },
});

/**
 * The address a link points at: a written link's destination, or the URL itself when the URL is the
 * text. Anything that is not http or https is not a link as far as this is concerned.
 */
export function destinationAt(view: EditorView, at: number): string | null {
  const tree = syntaxTree(view.state);

  for (let node = tree.resolveInner(at, 1); node; node = node.parent!) {
    if (node.name === 'URL') {
      return safe(view.state.doc.sliceString(node.from, node.to));
    }

    if (node.name === 'Link') {
      const url = node.getChild('URL');
      return url ? safe(view.state.doc.sliceString(url.from, url.to)) : null;
    }

    if (!node.parent) {
      return null;
    }
  }

  return null;
}

function safe(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The system browser, not a webview this app controls. On the desktop and on Android that is the
 * opener plugin, whose capability scope is what actually decides - see capabilities/default.json.
 */
export async function openLink(raw: string): Promise<void> {
  // Every caller's addresses are checked here as well as wherever they came from. The cell handler
  // hands over an `href` a note wrote, and one guard in the place that does the opening is worth
  // more than three in the places that ask for it.
  const url = safe(raw);
  if (url === null) {
    return;
  }

  if (!isNative()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }

  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}

/** On the editor while Ctrl or Cmd is down, so the stylesheet can say what a link would do. */
const MODIFIER_HELD = 'cm-modifier-held';

/**
 * Makes a link look clickable while the key that would open it is held.
 *
 * Ctrl-click is not something a note can advertise, so the affordance has to be the pointer: hold
 * the key and every link in the note turns into a hand, which is what an editor with Ctrl-click
 * links does everywhere else. Let go and it is text again, because that is what a plain click does
 * to it.
 *
 * The listeners are on the window rather than on the editor. Reading a note is the case this exists
 * for, and reading does not require focus - the key would otherwise have to be pressed *into* the
 * editor before the note under the pointer would admit its links are links.
 */
class LinkPointer implements PluginValue {
  constructor(private readonly view: EditorView) {
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('keyup', this.onKey, true);
    // Held down, then away to another window: the key comes back up somewhere this never hears
    // about, and a hand cursor would be left promising something that no longer works.
    window.addEventListener('blur', this.release);
  }

  private onKey = (event: KeyboardEvent) => {
    this.set(event.ctrlKey || event.metaKey);
  };

  private release = () => this.set(false);

  private set(held: boolean): void {
    this.view.dom.classList.toggle(MODIFIER_HELD, held);
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('keyup', this.onKey, true);
    window.removeEventListener('blur', this.release);
  }
}

export const linkPointer: Extension = ViewPlugin.fromClass(LinkPointer);

/**
 * The link a pointer went down on inside a table cell, kept until the next one.
 *
 * Pressing on a cell focuses it, and a focused cell shows its markdown rather than what that
 * markdown draws - so by the time a menu opens over a link in a cell, the link is not in the page
 * any more. There is nothing left to ask, so the answer is taken while it is still there: on
 * pointerdown, before the swap, which is the last moment the anchor exists.
 *
 * A press with no link under it clears this, so what is remembered is only ever the last thing
 * pointed at.
 */
let pointed: string | null = null;

export function rememberPointedLink(target: EventTarget | null): void {
  const anchor = target instanceof Element ? target.closest('a[href]') : null;
  pointed = anchor?.getAttribute('href') ?? null;
}

/** What was pointed at, if it is still what a link would be. */
export function pointedLink(): string | null {
  return pointed === null ? null : safe(pointed);
}
