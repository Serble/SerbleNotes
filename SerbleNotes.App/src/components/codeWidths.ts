import { syntaxTree } from '@codemirror/language';
import { MapMode, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from '@codemirror/view';
import { languageLabel } from './codeLanguages';

/**
 * How wide each code block's card is.
 *
 * A block shrinks to fit what it holds. CodeMirror gives every line its own element and draws the
 * card across them, so no line can know how wide the block is - "as wide as the widest line" is not
 * something CSS can express between siblings. So it is measured: a copy of the block is laid out
 * off-screen at its natural width, and the answer is put in this field, which `livePreview` reads and
 * turns into a width on every line of that block.
 *
 * What is measured is the whole block, badges included. The language chip and the copy button share
 * the row above the code, so a two-character block still has to be wide enough to show them or its
 * own furniture would hang off the edge - which is the one thing "shrink to fit" cannot mean.
 */

/** The measured block, kept with the text it was measured from so a stale answer is recognisable. */
export interface BlockWidth {
  text: string;
  label: string;
  /** Border-box width in pixels, before the pane's own limit is applied by `max-width`. */
  width: number;
}

const setWidths = StateEffect.define<Map<number, BlockWidth>>();

const widths = StateField.define<Map<number, BlockWidth>>({
  create: () => new Map(),

  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setWidths)) {
        return effect.value;
      }
    }

    if (!transaction.docChanged) {
      return value;
    }

    // An edit moves blocks around without changing what most of them say, so the widths come with
    // them. The ones that are now wrong are corrected by the next measurement, a frame later.
    const moved = new Map<number, BlockWidth>();
    for (const [from, entry] of value) {
      const mapped = transaction.changes.mapPos(from, 1, MapMode.TrackDel);
      if (mapped !== null) {
        moved.set(mapped, entry);
      }
    }
    return moved;
  },
});

/** Whether an update brought new measurements with it, which the decorations have to be rebuilt for. */
export function codeWidthsChanged(update: ViewUpdate): boolean {
  return update.startState.field(widths, false) !== update.state.field(widths, false);
}

/** The width to give the lines of the block starting here, if it has been measured. */
export function codeBlockWidth(state: EditorState, from: number): number | null {
  return state.field(widths, false)?.get(from)?.width ?? null;
}

interface Block {
  from: number;
  text: string;
  label: string;
}

/** Every code block in view, with the text whose widest line decides how wide the card is. */
function blocksIn(view: EditorView): Block[] {
  const found: Block[] = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'FencedCode' && node.name !== 'CodeBlock') {
          return;
        }

        const info = node.node.getChild('CodeInfo');
        found.push({
          from: node.from,
          // The whole block, fences and all: when the cursor is on the opening fence its backticks
          // come back, and that line has to fit too.
          text: view.state.doc.sliceString(node.from, node.to),
          label: info ? languageLabel(view.state.doc.sliceString(info.from, info.to)) : '',
        });
      },
    });
  }

  return found;
}

function sameWidths(a: Map<number, BlockWidth>, b: Map<number, BlockWidth>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [from, entry] of a) {
    const other = b.get(from);
    if (!other || other.width !== entry.width || other.text !== entry.text) {
      return false;
    }
  }
  return true;
}

class MeasureCodeWidths implements PluginValue {
  /** The off-screen copy everything is measured in. One element, reused for every block. */
  private readonly host: HTMLElement;
  /** Measured widths by block text, so typing in one block does not re-measure the others. */
  private readonly cache = new Map<string, number>();
  private publishing = false;
  private destroyed = false;

  constructor(private readonly view: EditorView) {
    this.host = document.createElement('div');
    this.host.className = 'cm-code-measure';
    this.host.setAttribute('aria-hidden', 'true');
    view.scrollDOM.appendChild(this.host);

    this.sync();
  }

  update(_update: ViewUpdate): void {
    // On every update, because a block can arrive from an edit, from scrolling, or from the parser
    // reaching a part of the document it had not got to yet - and the last of those is not announced
    // in any way this could test for. Nothing is measured or dispatched unless something changed.
    this.sync();
  }

  destroy(): void {
    this.destroyed = true;
    this.host.remove();
  }

  private sync(): void {
    const unmeasured = blocksIn(this.view).filter((block) => !this.cache.has(key(block)));

    if (unmeasured.length === 0) {
      this.schedule();
      return;
    }

    this.view.requestMeasure({
      read: () => {
        this.measure(unmeasured);
        return null;
      },
      write: () => this.schedule(),
    });
  }

  /**
   * Puts the widths into the state, on a microtask.
   *
   * Not directly: a transaction cannot be dispatched while an update is in progress, and both the
   * update that noticed the block and the measure pass that sized it are inside one. A microtask
   * runs as soon as that finishes and before the frame is painted, so the block is never seen at the
   * wrong width. Everything is worked out again there, because by then it may have moved.
   */
  private schedule(): void {
    if (this.publishing) {
      return;
    }
    this.publishing = true;

    void Promise.resolve().then(() => {
      this.publishing = false;
      if (!this.destroyed) {
        this.publish(blocksIn(this.view));
      }
    });
  }

  /**
   * Lays every unmeasured block out off-screen at once and reads the results in one go. Writing to
   * the DOM and reading it back costs a synchronous layout, so it happens for one batch rather than
   * once per block, and only for text that has not been measured before.
   */
  private measure(blocks: Block[]): void {
    this.host.replaceChildren(
      ...blocks.map((block) => {
        const copy = document.createElement('div');
        copy.className = 'cm-code-block-measure';

        // The badge row, built out of the real thing: the chip is the `::after` of an open line and
        // the button is a `.copy-code`, and the stylesheet puts both of them back into the flow in
        // here so their widths count. Neither is positioned in a real block, so neither would
        // otherwise contribute anything to how wide the card has to be.
        const badges = document.createElement('div');
        badges.className = 'cm-md-codeblock cm-md-code-open';
        if (block.label !== '') {
          badges.setAttribute('data-lang', block.label);
        }
        const button = document.createElement('span');
        button.className = 'copy-code';
        // The longest thing the button ever says, so the card does not resize when it says it.
        button.textContent = 'Cannot copy';
        badges.appendChild(button);

        const code = document.createElement('div');
        code.className = 'cm-md-codeblock';
        code.textContent = block.text;

        copy.append(badges, code);
        return copy;
      }),
    );

    const measured = [...this.host.children];
    blocks.forEach((block, index) => {
      // Rounded up: a fraction of a pixel short is a wrapped line, and the error is invisible.
      this.cache.set(key(block), Math.ceil(measured[index].getBoundingClientRect().width));
    });

    this.host.replaceChildren();
  }

  private publish(blocks: Block[]): void {
    const next = new Map<number, BlockWidth>();
    for (const block of blocks) {
      const width = this.cache.get(key(block));
      if (width !== undefined) {
        next.set(block.from, { text: block.text, label: block.label, width });
      }
    }

    if (sameWidths(next, this.view.state.field(widths))) {
      return;
    }
    this.view.dispatch({ effects: setWidths.of(next) });
  }
}

function key(block: Block): string {
  return `${block.label} ${block.text}`;
}

export const codeWidths: Extension = [widths, ViewPlugin.fromClass(MeasureCodeWidths)];
