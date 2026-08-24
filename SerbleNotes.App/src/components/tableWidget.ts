import { EditorView, WidgetType } from '@codemirror/view';
import { gripIcon, plusIcon, textIcon } from './domIcons';
import { type ActiveCell, setActiveCell, setTextMode, takeFocusRequest } from './tableState';
import {
  HEADER_ROW,
  type Align,
  type Table,
  cellOf,
  columnCount,
  renderTable,
  unescapeCell,
} from './tableFormat';
import { hasMarkup, renderInline } from './inlineMarkdown';
import { openLink, rememberPointedLink } from './linkClicks';
import { appendColumn, appendRow, moveRow, setCell } from './tables';

/**
 * A table, drawn as a table.
 *
 * This is a block replace decoration: the markdown source is taken out of the flow and a real
 * `<table>` is put in its place, with every cell its own small editable island. The alternative -
 * styling the source until it looks table-ish - is what this replaced, and it could never do the two
 * things that make a table a table rather than a paragraph with pipes in it: a column as wide as
 * what is in it, and a cell you can point at.
 *
 * Four things about the arrangement are not preference:
 *
 * - **The cells are `contenteditable` islands, not part of the editor's document.** CodeMirror's
 *   cursor is never inside a drawn table. That is what lets a cell answer for its own Enter and Tab,
 *   and it is why `tableState.ts` has to remember which cell is being edited - nothing else can say.
 * - **What is typed is written back to the note, debounced.** Not on blur alone: the autosave runs
 *   on its own clock, and a note closed mid-cell would lose what was in it. Not on every keystroke
 *   either, because every write re-renders the whole table.
 * - **`updateDOM` patches rather than rebuilds** whenever the table's shape is unchanged, and skips
 *   the cell that has focus. Rebuilding would take the caret out of the cell being typed in on every
 *   keystroke, which is the whole game. It is also why the handlers below never capture the table's
 *   position: they read it off the DOM, so a table that slid down the note because something was
 *   typed above it keeps working without being drawn again.
 * - **Reordering is pointer events, not HTML5 drag and drop**, which does not exist on a touchscreen.
 *   A table only reorderable with a mouse is one that half the people using this app cannot reorder.
 */

/**
 * How long after the last keystroke a cell is written into the note. Long enough that a word is one
 * write, short enough to be well inside the 1.2s autosave that follows it.
 */
const COMMIT_MS = 300;

/** Where the table holding this element starts, read off the DOM so that it is never out of date. */
function tableFrom(node: HTMLElement): number {
  return Number(node.closest<HTMLElement>('.cm-table')?.dataset.from ?? '0');
}

/**
 * How tall each drawn table turned out to be, so that `estimatedHeight` can answer honestly.
 *
 * This is not a nicety. Every keystroke in a cell rewrites the whole table, and rewriting the text a
 * block widget stands in for throws away the height the editor had measured for it - so the widget's
 * *estimate* is what the height map uses until the next measure pass. The default estimate is "no
 * idea", which the editor reads as one line: a ten-row table collapses to a line in the height map,
 * the document suddenly gets several hundred pixels shorter, the scroll position is adjusted to suit,
 * and then it all comes back. That is the view snapping about while somebody types, and it is worse
 * the taller the table and the further down the note it is.
 *
 * A `ResizeObserver` is what fills this in, because it reports the real height - including cells that
 * wrapped - without a layout read on the path CodeMirror is already measuring in.
 */
const measuredHeights = new Map<number, number>();
const observers = new WeakMap<HTMLElement, ResizeObserver>();

/**
 * What to say before it has ever been measured: a row apiece plus the bar underneath. Rough, and
 * still far closer than the one line the editor would otherwise assume.
 */
const ROW_GUESS = 34;

function watchHeight(root: HTMLElement): void {
  if (typeof ResizeObserver !== 'function') {
    return;
  }

  const observer = new ResizeObserver((entries) => {
    // The border box, not `contentRect`. What is being estimated is the space the editor will
    // measure with `getBoundingClientRect`, and the widget's own padding is part of that - see the
    // note on `.cm-table` in index.css for why that padding is padding and not a margin.
    const entry = entries[0];
    const height = entry?.borderBoxSize?.[0]?.blockSize ?? (entry?.target as HTMLElement)?.offsetHeight;
    if (height) {
      measuredHeights.set(tableFrom(root), Math.round(height));
    }
  });
  observer.observe(root);
  observers.set(root, observer);
}

function alignClass(align: Align): string {
  return align === 'none' ? '' : `cm-td-${align}`;
}

function cellIn(root: ParentNode, row: number, column: number): HTMLElement | null {
  return root.querySelector<HTMLElement>(`.cm-td[data-row="${row}"][data-column="${column}"]`);
}

/**
 * The element of a cell named by `tableState`, found rather than remembered.
 *
 * Anything that acts on a cell from outside the widget - the menu's selection commands - is run
 * after the cell has lost focus to whatever was pressed, and a cell that loses focus is drawn again
 * from its markdown. So the element is looked up when it is wanted, by the same three numbers that
 * name the cell everywhere else, and a table that was redrawn in between is no obstacle.
 */
export function cellElement(view: EditorView, cell: ActiveCell): HTMLElement | null {
  const root = view.dom.querySelector<HTMLElement>(`.cm-table[data-from="${cell.from}"]`);
  return root ? cellIn(root, cell.row, cell.column) : null;
}

export class TableWidget extends WidgetType {
  /** The table's own source, which is what "has this changed" means for a widget. */
  private readonly key: string;

  constructor(
    readonly from: number,
    readonly table: Table,
  ) {
    super();
    this.key = renderTable(table);
  }

  eq(other: TableWidget): boolean {
    return this.from === other.from && this.key === other.key;
  }

  /**
   * How tall this is, as far as anybody knows - the last measurement of this table, or a guess from
   * how many rows it has. See `measuredHeights` above for why answering "no idea" is not an option.
   */
  get estimatedHeight(): number {
    return measuredHeights.get(this.from) ?? (this.table.rows.length + 1) * ROW_GUESS + ROW_GUESS;
  }

  /**
   * Everything that happens inside the widget is the widget's own. CodeMirror is told to keep out of
   * all of it: the cells are editable in their own right, and letting the editor treat a keystroke in
   * a cell as input to the document would write it twice.
   *
   * This is also why the context menu is opened from a React handler on the editor's container rather
   * than through `EditorView.domEventHandlers` - CodeMirror does not deliver events it has been told
   * to ignore, and a right-click on a cell is exactly such an event.
   */
  ignoreEvent(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('div');
    root.className = 'cm-table';
    root.dataset.from = String(this.from);
    // The wrapper is not editable; each cell opts back in. Without this the browser treats the whole
    // widget as part of the document it is embedded in.
    root.contentEditable = 'false';

    const frame = document.createElement('div');
    frame.className = 'cm-table-frame';

    const scroll = document.createElement('div');
    scroll.className = 'cm-table-scroll';
    scroll.appendChild(this.buildTable(view));

    const addColumn = control('cm-table-plus cm-plus-col', 'Add a column', (element) =>
      appendColumn(view, tableFrom(element)),
    );
    addColumn.appendChild(plusIcon());
    frame.append(scroll, addColumn);

    const foot = document.createElement('div');
    foot.className = 'cm-table-foot';

    const addRow = control('cm-table-plus cm-plus-row', 'Add a row', (element) =>
      appendRow(view, tableFrom(element)),
    );
    addRow.appendChild(plusIcon());

    const mode = control('cm-table-mode', 'Show this table as markdown', (element) => {
      const at = tableFrom(element);
      // The cursor goes to the start of the markdown that appears, so that whoever asked to see it
      // can start editing it without hunting for somewhere to click.
      view.dispatch({ effects: setTextMode.of({ from: at, on: true }), selection: { anchor: at } });
      view.focus();
    });
    mode.append(textIcon(), caption('Text'));

    foot.append(addRow, mode);
    root.append(frame, foot);

    watchHeight(root);
    this.focusPending(root);
    return root;
  }

  /** Stops watching a table's height when its DOM goes, so the observer does not outlive it. */
  destroy(dom: HTMLElement): void {
    observers.get(dom)?.disconnect();
    observers.delete(dom);
  }

  /**
   * Brings an already-drawn table up to date without replacing it, which is what keeps the caret in
   * the cell being typed in. Only when the shape is the same: a row or a column arriving changes what
   * elements there are, and false here asks CodeMirror to draw the whole thing again.
   */
  updateDOM(dom: HTMLElement): boolean {
    const cells = dom.querySelectorAll<HTMLElement>('.cm-td');
    const columns = columnCount(this.table);
    if (cells.length !== columns * (this.table.rows.length + 1)) {
      return false;
    }

    // The table may have slid down the note since it was drawn. Its measured height moves with it,
    // or the next edit would be estimating from nothing again - and a `ResizeObserver` says nothing
    // about a table that moved without changing size.
    const was = Number(dom.dataset.from);
    if (was !== this.from) {
      const height = measuredHeights.get(was);
      measuredHeights.delete(was);
      if (height) {
        measuredHeights.set(this.from, height);
      }
    }
    dom.dataset.from = String(this.from);

    for (const cell of cells) {
      const row = Number(cell.dataset.row);
      const column = Number(cell.dataset.column);
      const text = unescapeCell(cellOf(this.table, row, column) ?? '');

      // Never the cell being typed in: replacing its text would put the caret at the end of it on
      // every keystroke, and this runs on the very change that cell just made. The comparison is
      // against the markdown the cell was drawn from, because what is on screen is what it renders
      // to - and those are different strings whenever the cell holds any markup at all.
      // Two reasons to redraw: the markdown changed, or the cell is showing markdown it is not
      // being edited in. The second is the invariant this rests on - a cell nobody is typing in
      // shows what its markdown draws - and checking it here means a cell can never be left
      // stranded in source by something that swapped it and then lost focus another way.
      const stranded =
        cell.dataset.rendered !== 'true' && hasMarkup(text) && cell.textContent === text;
      if (cell !== document.activeElement && (cell.dataset.source !== text || stranded)) {
        showRendered(cell, text);
      }

      // Only when it actually differs. This runs on every keystroke, and writing a class that is
      // already there still costs a style recalculation.
      const className = `cm-td ${alignClass(this.table.align[column] ?? 'none')}`.trim();
      if (cell.className !== className) {
        cell.className = className;
      }
    }

    this.focusPending(dom);
    return true;
  }

  /** Puts the caret where whatever changed the table's shape asked for it to go. */
  private focusPending(root: HTMLElement): void {
    const request = takeFocusRequest(this.from);
    if (!request) {
      return;
    }

    const cell = cellIn(root, request.row, request.column);
    if (cell) {
      // After the frame this DOM is attached in: focusing an element that is not in the page yet
      // does nothing at all.
      requestAnimationFrame(() => focusCell(cell));
    }
  }

  private buildTable(view: EditorView): HTMLTableElement {
    const table = document.createElement('table');
    const columns = columnCount(this.table);

    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (let column = 0; column < columns; column += 1) {
      headRow.appendChild(this.buildCell(view, HEADER_ROW, column, true));
    }
    head.appendChild(headRow);

    const body = document.createElement('tbody');
    this.table.rows.forEach((_, row) => {
      const tr = document.createElement('tr');
      for (let column = 0; column < columns; column += 1) {
        const holder = this.buildCell(view, row, column, false);
        if (column === 0) {
          holder.appendChild(this.buildGrip(view, row));
        }
        tr.appendChild(holder);
      }
      body.appendChild(tr);
    });

    table.append(head, body);
    return table;
  }


  private buildCell(view: EditorView, row: number, column: number, header: boolean): HTMLElement {
    const holder = document.createElement(header ? 'th' : 'td');

    const cell = document.createElement('div');
    cell.className = `cm-td ${alignClass(this.table.align[column] ?? 'none')}`.trim();
    // `plaintext-only` is what stops a paste bringing markup into the note. What is read back is
    // `textContent` either way, so a browser without it loses nothing - the paste is just tidier.
    cell.contentEditable = 'plaintext-only';
    cell.dataset.row = String(row);
    cell.dataset.column = String(column);
    showRendered(cell, unescapeCell(cellOf(this.table, row, column) ?? ''));

    let timer = 0;
    const commit = () => {
      window.clearTimeout(timer);
      setCell(view, tableFrom(cell), row, column, cell.textContent ?? '');
    };

    cell.addEventListener('input', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(commit, COMMIT_MS);
    });

    // Before the caret is placed, so it is placed in the markdown rather than in what was drawn
    // from it. Focus covers the ways in that are not a pointer - Tab, and the caret being sent here
    // after a row or column was added.
    cell.addEventListener('pointerdown', (event) => {
      // Before the swap: focusing this cell replaces what is drawn with the markdown it came from,
      // and a link that was under the pointer stops existing. The menu asks for it afterwards.
      rememberPointedLink(event.target);

      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (anchor && (event.ctrlKey || event.metaKey)) {
        // Pressing with the modifier down means open, not edit - so the cell is left as it is
        // rather than swapped for its markdown, and the click that would have followed never
        // arrives to find the link gone.
        event.preventDefault();
        void openLink(anchor.getAttribute('href') ?? '');

        // Some browsers focus the cell anyway, and a focused cell shows its markdown. Hand the
        // focus back rather than trying to stop it: leaving a cell focused while it displays what
        // its markdown *draws* would mean the next keystroke committing that drawing as the text -
        // "Example" replacing "[Example](https://example.com)". Then put the cell back the way it
        // was: opening a link is not an edit, and nothing about the cell should have changed.
        window.setTimeout(() => {
          cell.blur();
          showRendered(cell, cell.dataset.source ?? cell.textContent ?? '');
        }, 0);
        return;
      }

      showSource(cell);
    });

    // A link in a cell. The rules are the editor's own: a plain click is for editing, Ctrl or Cmd
    // opens - and on a touchscreen the long-press menu does, since there is no modifier to hold.
    // The click is always stopped, whatever it was: an anchor left to itself would navigate the
    // webview away from the app, which on Android is a window with no way back to the note.
    cell.addEventListener('click', (event) => {
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!anchor) {
        return;
      }

      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        void openLink(anchor.getAttribute('href') ?? '');
      }
    });

    cell.addEventListener('blur', () => {
      // The source is what is in the cell right now; the commit is what puts it in the document.
      const source = cell.textContent ?? '';
      commit();
      showRendered(cell, source);
    });
    const claim = () => {
      showSource(cell);
      view.dispatch({ effects: setActiveCell.of({ from: tableFrom(cell), row, column }) });
    };
    // Focus is the usual way, but a right-click does not focus a cell in every browser and the menu
    // has to know which cell it is about - so being pointed at counts too.
    cell.addEventListener('focus', claim);
    cell.addEventListener('pointerdown', claim);
    cell.addEventListener('contextmenu', claim);
    cell.addEventListener('keydown', (event) => this.onKey(event, view, cell, commit, row, column));

    // The editable box is a child of the cell rather than the cell itself, so that the drag handle
    // has somewhere to sit that is not inside the text. Anything clicked in the cell but outside that
    // box - the hairline of the border, a sliver the layout left over - still means "edit this cell",
    // because from where the user is sitting the cell is what they clicked.
    holder.addEventListener('click', (event) => {
      if (event.target === holder) {
        focusCell(cell);
      }
    });

    holder.appendChild(cell);
    return holder;
  }

  /**
   * The keys a cell answers for itself.
   *
   * Enter does not put a line break in a cell, because a table cell cannot hold one - it goes to the
   * cell below, adding a row at the bottom when there is none. Tab crosses the row and wraps. Escape
   * hands the editor back its own cursor, so a table is never somewhere the keyboard gets stuck, and
   * neither is the first cell: Shift-Tab out of it does the same.
   */
  private onKey(
    event: KeyboardEvent,
    view: EditorView,
    cell: HTMLElement,
    commit: () => void,
    row: number,
    column: number,
  ): void {
    const last = columnCount(this.table) - 1;

    const leave = () => {
      commit();
      // The editor's cursor is put at the table before focus goes back to it. It could be anywhere -
      // wherever it was when somebody clicked into a cell, possibly pages away - and focusing the
      // editor scrolls to it, which would throw the note somewhere else entirely.
      view.dispatch({
        selection: { anchor: tableFrom(cell) },
        effects: setActiveCell.of(null),
      });
      view.focus();
    };

    if (event.key === 'Escape') {
      event.preventDefault();
      leave();
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
      this.go(view, cell, row === HEADER_ROW ? 0 : row + 1, column);
      return;
    }

    // The arrows move between cells only from the edge of what is in one, so they still walk through
    // a cell's own text first. "Once you are at the end of it" is the rule for all four: right and
    // down from the end, left and up from the start - which is also how you get to the end or the
    // start in the first place.
    if (event.key.startsWith('Arrow')) {
      const at = caretOffset(cell);
      if (at === null) {
        return;
      }

      // Left and right hand over only from the ends, so they still walk through the cell's own text.
      const atStart = at === 0;
      const atEnd = at === (cell.textContent ?? '').length;

      if (event.key === 'ArrowRight' && atEnd) {
        event.preventDefault();
        commit();
        if (column < last) {
          this.go(view, cell, row, column + 1);
        } else if (row === HEADER_ROW || row < this.table.rows.length - 1) {
          // Wraps to the start of the next row, but never off the end of the table: Tab is what
          // adds a row, and an arrow that grew it would do so on the way past.
          this.go(view, cell, row === HEADER_ROW ? 0 : row + 1, 0);
        }
        return;
      }

      if (event.key === 'ArrowLeft' && atStart) {
        event.preventDefault();
        commit();
        if (column > 0) {
          this.go(view, cell, row, column - 1);
        } else if (row > 0) {
          this.go(view, cell, row - 1, last);
        } else if (row === 0) {
          this.go(view, cell, HEADER_ROW, last);
        }
        return;
      }

      // Up and down always move a row, without waiting for the caret to reach an end. A cell holds
      // one line - Enter goes to the cell below rather than breaking the line - so there is no line
      // above or below to move to inside one, and leaving it to the browser meant an arrow
      // sometimes wandered into whichever cell happened to be next in the DOM.
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        commit();
        // Never past the last row: Enter is what adds one, and an arrow that grew the table would
        // do it by accident on the way past.
        if (row === HEADER_ROW || row < this.table.rows.length - 1) {
          this.go(view, cell, row === HEADER_ROW ? 0 : row + 1, column);
        }
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (row !== HEADER_ROW) {
          commit();
          this.go(view, cell, row === 0 ? HEADER_ROW : row - 1, column);
        }
        return;
      }

      return;
    }

    if (event.key !== 'Tab') {
      return;
    }
    event.preventDefault();

    if (!event.shiftKey) {
      commit();
      if (column < last) {
        this.go(view, cell, row, column + 1);
      } else {
        this.go(view, cell, row === HEADER_ROW ? 0 : row + 1, 0);
      }
      return;
    }

    if (column > 0) {
      commit();
      this.go(view, cell, row, column - 1);
    } else if (row === HEADER_ROW) {
      leave();
    } else {
      commit();
      this.go(view, cell, row === 0 ? HEADER_ROW : row - 1, last);
    }
  }

  /** Moves the caret to another cell of this table, adding the row first when there is not one. */
  private go(view: EditorView, from: HTMLElement, row: number, column: number): void {
    const root = from.closest<HTMLElement>('.cm-table');
    const target = root && cellIn(root, row, column);
    if (target) {
      focusCell(target);
      return;
    }

    // Off the bottom, which is a new row rather than nowhere to go.
    if (row >= 0) {
      appendRow(view, tableFrom(from), column);
    }
  }

  /**
   * The handle a row is dragged by. `setPointerCapture` keeps the drag alive once the finger leaves
   * the handle; `touch-action: none` in the stylesheet is what stops the page scrolling underneath
   * it instead.
   */
  private buildGrip(view: EditorView, row: number): HTMLElement {
    const grip = document.createElement('button');
    grip.className = 'cm-row-grip';
    grip.type = 'button';
    grip.title = 'Drag to move this row';
    grip.setAttribute('aria-label', 'Drag to move this row');
    grip.contentEditable = 'false';
    grip.appendChild(gripIcon());

    let dragging = false;
    let target = row;

    const bodyRows = () => [...(grip.closest('tbody')?.children ?? [])] as HTMLElement[];

    const mark = (rows: HTMLElement[]) => {
      rows.forEach((element, index) => {
        element.classList.toggle('cm-row-dragging', index === row);
        element.classList.toggle('cm-row-over', index === target && target !== row);
      });
    };

    const clear = (rows: HTMLElement[]) =>
      rows.forEach((element) => element.classList.remove('cm-row-dragging', 'cm-row-over'));

    grip.addEventListener('pointerdown', (event) => {
      // The default here is what would start a text selection, so it has to go - which means the
      // cell being typed in will not blur on its own, and blurring is what writes it into the note.
      event.preventDefault();
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }

      dragging = true;
      target = row;
      grip.setPointerCapture(event.pointerId);
      mark(bodyRows());
    });

    grip.addEventListener('pointermove', (event) => {
      if (!dragging) {
        return;
      }
      const rows = bodyRows();

      // The gap the row would drop into: how many row middles the pointer is past. Turning that gap
      // into a row index has to allow for the dragged row itself being taken out of the list first.
      let gap = 0;
      for (let index = 0; index < rows.length; index += 1) {
        const box = rows[index].getBoundingClientRect();
        if (event.clientY > box.top + box.height / 2) {
          gap = index + 1;
        }
      }
      target = Math.max(0, Math.min(gap > row ? gap - 1 : gap, rows.length - 1));
      mark(rows);
    });

    const finish = () => {
      if (!dragging) {
        return;
      }
      dragging = false;
      clear(bodyRows());
      if (target !== row) {
        moveRow(view, tableFrom(grip), row, target);
      }
    };

    grip.addEventListener('pointerup', finish);
    grip.addEventListener('pointercancel', finish);
    return grip;
  }
}

/* ------------------------------------------------------------------ small DOM helpers */

function control(
  className: string,
  label: string,
  run: (element: HTMLButtonElement) => void,
): HTMLButtonElement {
  const element = document.createElement('button');
  element.className = className;
  element.type = 'button';
  element.title = label;
  element.setAttribute('aria-label', label);
  element.contentEditable = 'false';
  // Deliberately no `preventDefault` on mousedown, unlike every other floating control in the
  // editor. Taking focus is what makes the cell being typed in blur, and blurring is what writes it
  // into the note - so a button pressed a moment after typing acts on the text that was just typed.
  // Nothing is lost by the focus move: the buttons that change a table's shape say where the caret
  // should go afterwards.
  element.addEventListener('click', () => run(element));
  return element;
}

function caption(text: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'cm-table-mode-text';
  span.textContent = text;
  return span;
}

/** Focus a cell with the caret at the end of it, which is where somebody arriving in one expects it. */
function focusCell(cell: HTMLElement): void {
  cell.focus();

  const selection = window.getSelection();
  if (!selection) {
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(cell);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * A cell as it reads: its markdown rendered, and `<br>` an actual line break.
 *
 * A table is a widget rather than a run of text, so the live preview has no character offsets to
 * decorate inside one - this is the equivalent for cells, and it follows the same rule as every
 * other line in the editor: what you are not editing is shown as it reads, and what you are
 * editing is shown as it is written. `showSource` is the other half.
 *
 * The source is kept on the element because the rendered text is not something the source can be
 * recovered from - "code" says nothing about the backticks it came from.
 */
function showRendered(cell: HTMLElement, source: string): void {
  cell.dataset.source = source;

  if (!hasMarkup(source)) {
    // The common case, and worth keeping separate: a cell with no markup in it is never rewritten,
    // so clicking into one leaves the caret exactly where it was put.
    if (cell.textContent !== source) {
      cell.textContent = source;
    }
    delete cell.dataset.rendered;
    return;
  }

  cell.innerHTML = renderInline(source);
  cell.dataset.rendered = 'true';
}

/**
 * Puts the markdown back, so what is typed into is what the document holds.
 *
 * Called on pointerdown as well as focus, which is what makes the caret land where it was aimed:
 * the swap happens before the browser places it, so it is placed in the text that will be edited
 * rather than in rendered output that is about to be replaced.
 */
function showSource(cell: HTMLElement): void {
  if (cell.dataset.rendered !== 'true') {
    return;
  }

  cell.textContent = cell.dataset.source ?? cell.textContent ?? '';
  delete cell.dataset.rendered;
}

/**
 * Where the caret is in a cell, counted in characters, or null if it is not in this one.
 *
 * A cell is being edited as its markdown when this is asked - `showSource` swapped it back before
 * the caret was placed - so the offsets are offsets into what the document holds.
 */
function caretOffset(cell: HTMLElement): number | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (!cell.contains(range.startContainer)) {
    return null;
  }

  const upTo = range.cloneRange();
  upTo.selectNodeContents(cell);
  upTo.setEnd(range.startContainer, range.startOffset);
  return upTo.toString().length;
}
