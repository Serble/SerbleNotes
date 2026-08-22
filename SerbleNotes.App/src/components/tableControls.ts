import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from '@codemirror/view';
import { tableIcon } from './domIcons';
import { setTextMode, textModeTables } from './tableState';
import { tableContextAt } from './tables';

/**
 * The way back from the markdown of a table to the table itself.
 *
 * A drawn table carries its own controls inside the widget, where they can sit against its edges
 * (`tableWidget.ts`). A table being shown as markdown is just lines of text, so its one control has
 * to float over it - a DOM element in the scroller rather than a widget decoration, for the reason
 * the copy button on a code block is one (see copyCode.ts), and positioned the same way.
 *
 * It goes at the **bottom right of the band**, which is where the button that sent you here was: the
 * "Text" button in a drawn table's footer and this one are the same control in its two states, and a
 * control that moved across the screen when it was pressed would be two controls. Not the top right,
 * where a code block's copy button goes - a code block's opening fence line is empty once its
 * backticks are hidden, and a table's first line is its header row with writing on it.
 *
 * Only one button, and only over a table someone asked to see as text. Everything else about such a
 * table - rows, columns, alignment - is in the context menu, because at that point they are editing
 * markdown and the markdown is what they asked to see.
 */

interface Placement {
  top: number;
  right: number;
}

class TextModeButton implements PluginValue {
  private readonly button: HTMLButtonElement;
  /** The table the button currently belongs to, or null when it is not showing. */
  private table: number | null = null;
  private at: Placement | null = null;

  constructor(private readonly view: EditorView) {
    this.button = document.createElement('button');
    this.button.className = 'cm-table-back cm-table-mode';
    this.button.type = 'button';
    this.button.title = 'Draw this table again';
    this.button.setAttribute('aria-label', 'Draw this table again');
    this.button.hidden = true;

    const caption = document.createElement('span');
    caption.className = 'cm-table-mode-text';
    caption.textContent = 'Table';
    this.button.append(tableIcon(), caption);

    // Taking focus would move the cursor out of the note, and mousedown is where that happens.
    this.button.addEventListener('mousedown', (event) => event.preventDefault());
    this.button.addEventListener('click', () => {
      if (this.table !== null) {
        view.dispatch({ effects: setTextMode.of({ from: this.table, on: false }) });
      }
    });

    view.scrollDOM.appendChild(this.button);
    this.show();
  }

  update(update: ViewUpdate): void {
    if (
      update.docChanged ||
      update.selectionSet ||
      update.geometryChanged ||
      update.viewportChanged ||
      textModeTables(update.state) !== textModeTables(update.startState)
    ) {
      this.show();
    }
  }

  destroy(): void {
    this.button.remove();
  }

  private show(): void {
    const view = this.view;
    const length = view.state.doc.length;

    // The first one on screen. Not "the one the cursor is in": pressing the text button does not
    // put the cursor anywhere in particular, and a button that only appears once you have clicked
    // into the markdown would be a button nobody finds on the way back.
    const from = textModeTables(view.state)
      .filter((start) => start <= length && start >= view.viewport.from && start <= view.viewport.to)
      .sort((a, b) => a - b)[0];

    if (from === undefined) {
      this.hide();
      return;
    }

    // Where the band ends, which is where the button goes. A table nobody can parse any more has no
    // table to be drawn as, so it gets no button rather than one that would do nothing.
    const context = tableContextAt(view.state, from);
    if (!context) {
      this.hide();
      return;
    }

    this.table = from;
    this.place(from, context.to);
  }

  /**
   * Where the button goes, measured in CodeMirror's own read phase - calling `lineBlockAt` from
   * inside an update throws, and a plugin that throws is removed outright.
   */
  private place(from: number, to: number): void {
    this.view.requestMeasure<Placement | null>({
      read: (view) => {
        if (to < view.viewport.from || from > view.viewport.to) {
          return null;
        }

        const scroller = view.scrollDOM.getBoundingClientRect();
        const content = view.contentDOM.getBoundingClientRect();
        const last = view.state.doc.lineAt(to);
        const line = view.lineBlockAt(last.from);

        // The *band's* right edge, not the pane's. The band is only as wide as the table needs
        // (see the note on `tableLine` in livePreview.ts), so the content box would put this button
        // out in the margin next to nothing.
        const dom = view.domAtPos(last.from).node;
        const element = dom.nodeType === 3 ? dom.parentElement : (dom as HTMLElement);
        const band = element?.closest('.cm-line')?.getBoundingClientRect() ?? content;

        return {
          top: content.top - scroller.top + view.scrollDOM.scrollTop + line.bottom,
          // From the padding box rather than the border box, which is what keeps the button off the
          // scrollbar on the platforms that reserve room for one.
          right: scroller.left + view.scrollDOM.clientWidth - band.right,
        };
      },

      write: (at) => {
        if (this.table !== from) {
          return;
        }
        if (!at) {
          this.button.hidden = true;
          return;
        }

        if (!this.at || at.top !== this.at.top || at.right !== this.at.right) {
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
    this.table = null;
    this.at = null;
  }
}

export const tableControls = ViewPlugin.fromClass(TextModeButton);
