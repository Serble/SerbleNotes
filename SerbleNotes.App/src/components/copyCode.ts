import { syntaxTree } from '@codemirror/language';
import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { copyText } from '../services/clipboard';

/**
 * A copy button for the code block you are looking at.
 *
 * It is one button that moves, not one per block, and it is **not** a widget decoration - for the
 * same reason the language chip is a CSS pseudo-element (see MarkdownEditor.tsx): a widget sits in
 * the text flow, and the cursor can then be put either side of something that is not in the note.
 * This button lives in the scroller instead, outside the document entirely, positioned over the
 * block it belongs to. Being a child of the scroller is what makes it scroll with the text without
 * a single scroll handler.
 *
 * It follows two things at once, which is what makes it work without a pointer: the block under the
 * mouse, and failing that the block the cursor is in. On a phone there is no hover, so tapping into
 * a block is what puts the button on it.
 */

/** Long enough to be read, short enough that it is gone before you look again. */
const CONFIRM_MS = 1400;

function enclosingCodeBlock(state: EditorState, pos: number): SyntaxNode | null {
  // Both sides, because a position can sit exactly on the edge of the block: the newline at the end
  // of a closing fence is *after* the node, so looking only forwards from it lands outside the block
  // the pointer is plainly over. Found by hovering the last line of one.
  for (const side of [1, -1] as const) {
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side);

    while (node) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
        return node;
      }
      node = node.parent;
    }
  }

  return null;
}

/**
 * What the block actually says, without its fences, its info string or - for an indented block - the
 * indent that made it one. The parser has already worked all of that out: `CodeText` is exactly the
 * content, and an indented block has one per line.
 */
function contentsOf(state: EditorState, block: SyntaxNode): string {
  let text = '';

  for (let child = block.firstChild; child; child = child.nextSibling) {
    if (child.name === 'CodeText') {
      text += state.doc.sliceString(child.from, child.to);
    }
  }

  return text;
}

/** Whether there is anything to copy, without building the string to find out. */
function hasContents(block: SyntaxNode): boolean {
  for (let child = block.firstChild; child; child = child.nextSibling) {
    if (child.name === 'CodeText' && child.to > child.from) {
      return true;
    }
  }
  return false;
}

class CopyCodeButton implements PluginValue {
  private readonly button: HTMLButtonElement;
  /** Start of the block the button currently belongs to, or null when it is not showing. */
  private block: number | null = null;
  /** Set while the pointer is over a block, which wins over wherever the cursor happens to be. */
  private hovered: number | null = null;
  private confirming = 0;
  /** The last position written to the DOM, so typing in a block does not rewrite it every keystroke. */
  private at = { top: -1, right: -1 };

  constructor(private readonly view: EditorView) {
    this.button = document.createElement('button');
    // Two classes: one the editor's own handlers recognise it by, one that gives it the same look as
    // the button the rendered preview puts on a block (`.copy-code` in index.css).
    this.button.className = 'cm-copy-code copy-code';
    this.button.type = 'button';
    this.button.textContent = 'Copy';
    this.button.hidden = true;

    // Taking focus would move the cursor out of the note, and mousedown is where that happens.
    this.button.addEventListener('mousedown', (event) => event.preventDefault());
    this.button.addEventListener('click', () => void this.copy());

    // Leaving the button back into the text is not leaving the block: the mousemove that follows
    // says where the pointer actually is, and hiding first would make the button flicker.
    this.button.addEventListener('mouseleave', (event) => {
      const to = event.relatedTarget;
      if (to instanceof Element && view.contentDOM.contains(to)) {
        return;
      }
      this.pointerOver(null);
    });

    view.scrollDOM.appendChild(this.button);

    this.show();
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.geometryChanged || update.viewportChanged) {
      this.show();
    }
  }

  destroy(): void {
    window.clearTimeout(this.confirming);
    this.button.remove();
  }

  /** Called by the DOM handlers below when the pointer moves over, or off, a block. */
  pointerOver(pos: number | null): void {
    const block = pos === null ? null : enclosingCodeBlock(this.view.state, pos)?.from ?? null;
    if (block === this.hovered) {
      return;
    }
    this.hovered = block;
    this.show();
  }

  private show(): void {
    const state = this.view.state;

    // The pointer wins while it is over a block; otherwise the button belongs to whatever block the
    // cursor is in, which is the only way it can be reached on a touchscreen.
    const from =
      this.hovered ?? enclosingCodeBlock(state, state.selection.main.head)?.from ?? null;

    if (from === null) {
      this.hide();
      return;
    }

    const block = enclosingCodeBlock(state, from + 1);
    // An empty block has nothing to copy, so it gets no button rather than one that does nothing.
    if (!block || !hasContents(block)) {
      this.hide();
      return;
    }

    if (this.block !== block.from) {
      this.block = block.from;
      this.reset();
    }
    this.place(block.from);
  }

  /**
   * Puts the button over the block. Where it goes has to be *measured*, and CodeMirror only allows
   * that in the read half of its own measure cycle - calling `coordsAtPos` from an update throws,
   * and a plugin that throws is removed, which is how this button managed to never appear at all.
   */
  private place(pos: number): void {
    this.view.requestMeasure<{ top: number; right: number } | null>({
      read: (view) => {
        if (pos < view.viewport.from || pos > view.viewport.to) {
          // Scrolled out of what is rendered - there is nothing measured to sit on.
          return null;
        }

        const scroller = view.scrollDOM.getBoundingClientRect();
        const content = view.contentDOM.getBoundingClientRect();

        // The *line's* box, not the text's. `coordsAtPos` answers where the characters are, which is
        // below the block's top padding, and the language chip in the other corner is placed from
        // the top of the line - so measuring the text put the two of them a padding apart. The inset
        // itself is a margin in the editor theme, next to the chip's, so they cannot drift.
        const line = view.lineBlockAt(pos);
        const top = content.top - scroller.top + view.scrollDOM.scrollTop + line.top;

        // The card no longer reaches the edge of the pane - it is only as wide as the block needs
        // (codeWidths.ts) - so the button belongs to the *line's* right edge, not the content's.
        const dom = view.domAtPos(pos).node;
        const element = dom.nodeType === 3 ? dom.parentElement : (dom as HTMLElement);
        const card = element?.closest('.cm-line')?.getBoundingClientRect() ?? content;

        // `right` is measured from the scroller's padding box, which is inside the scrollbar, while
        // the rectangle is the border box, which is outside it. Going through clientWidth is what
        // keeps the button off the scrollbar on the platforms that reserve room for one.
        const edge = scroller.left + view.scrollDOM.clientWidth;

        return {
          // Positioned inside the scroller, so it moves with the text: an absolutely positioned
          // child of a scrolling box scrolls with its content, and no scroll handler is needed.
          //
          // Not rounded: a line does not start on a whole pixel, and rounding this one put the
          // button half a pixel off the chip it sits level with. The same layout measures the same
          // way twice, so the comparison below still catches the writes worth skipping.
          top,
          right: edge - card.right,
        };
      },

      write: (at) => {
        // The block may have stopped being the one this button is for while the measure was queued.
        if (this.block !== pos) {
          return;
        }
        if (!at) {
          this.button.hidden = true;
          return;
        }

        // Only write when it actually moved. This runs on every keystroke inside a block, and a
        // style write that changes nothing still costs a layout.
        if (at.top !== this.at.top || at.right !== this.at.right) {
          this.at = at;
          this.button.style.top = `${at.top}px`;
          this.button.style.right = `${at.right}px`;
        }

        this.button.hidden = false;
      },
    });
  }

  private hide(): void {
    if (this.button.hidden) {
      return;
    }
    this.button.hidden = true;
    this.block = null;
    this.reset();
  }

  private reset(): void {
    window.clearTimeout(this.confirming);
    this.button.textContent = 'Copy';
    this.button.classList.remove('done', 'failed');
  }

  private async copy(): Promise<void> {
    if (this.block === null) {
      return;
    }

    const block = enclosingCodeBlock(this.view.state, this.block + 1);
    if (!block) {
      return;
    }

    // Read at the moment of the click rather than when the button appeared, so what lands on the
    // clipboard is what the block says now.
    const copied = await copyText(contentsOf(this.view.state, block));

    window.clearTimeout(this.confirming);
    this.button.textContent = copied ? 'Copied' : 'Cannot copy';
    this.button.classList.toggle('done', copied);
    this.button.classList.toggle('failed', !copied);
    this.confirming = window.setTimeout(() => this.reset(), CONFIRM_MS);
  }
}

export const copyCode = ViewPlugin.fromClass(CopyCodeButton, {
  eventHandlers: {
    mousemove(event: MouseEvent, view: EditorView) {
      // The button is a child of the scroller, so the pointer being on it is not the pointer leaving
      // the block underneath.
      if ((event.target as HTMLElement).closest('.cm-copy-code')) {
        return;
      }

      // `posAtCoords` answers null in the margins rather than snapping to the nearest line, which is
      // what keeps the button from appearing when the pointer is merely near a block.
      this.pointerOver(view.posAtCoords({ x: event.clientX, y: event.clientY }));
    },

    mouseleave(event: MouseEvent) {
      // The button sits in the scroller, so moving onto it leaves the text - which is not the same
      // as leaving the block, and hiding here would take the button away before it could be clicked.
      const to = event.relatedTarget;
      if (to instanceof Element && to.closest('.cm-copy-code')) {
        return;
      }
      this.pointerOver(null);
    },
  },
});
