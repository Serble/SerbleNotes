import type { EditorView } from '@codemirror/view';
import { SEPARATOR, type MenuEntry } from './ContextMenu';
import {
  AlignCentreIcon,
  AlignLeftIcon,
  AlignRightIcon,
  ColumnIcon,
  CopyIcon,
  CutIcon,
  MoveDownIcon,
  MoveLeftIcon,
  MoveRightIcon,
  MoveUpIcon,
  PasteIcon,
  RowIcon,
  TableIcon,
  TextIcon,
  TrashIcon,
} from './Icons';
import { copyText, readText } from '../services/clipboard';
import { columnCount } from './tableFormat';
import { isTextMode, setTextMode } from './tableState';
import {
  activeTable,
  addColumn,
  addRow,
  alignColumn,
  insertTable,
  removeColumn,
  removeRow,
  removeTable,
  shiftColumn,
  shiftRow,
} from './tables';

/**
 * What the editor's own context menu offers.
 *
 * Two groups. The first is the three things a context menu anywhere offers, which the app has to
 * provide itself because a note in a web view has no menu of its own on every platform - and because
 * the clipboard is somewhere the note's plaintext goes, so it is worth this app being the thing that
 * puts it there rather than something it cannot see.
 *
 * The second is the table under the cursor, and it is only there when there is one. A table is the
 * one piece of markdown whose shape cannot sensibly be typed - adding a column means editing every
 * row - so it is the one that needs commands rather than syntax.
 *
 * `notify` is how a refusal is reported. Nothing here fails silently: a clipboard the browser will
 * not let this app read is a fact about the browser, and saying so is more use than a menu item
 * that appears to work and does not.
 */
export function editorMenu(view: EditorView, notify: (message: string) => void): MenuEntry[] {
  const range = view.state.selection.main;
  const context = activeTable(view);

  // Every command reads the selection again when it runs rather than using the one captured here.
  // Opening the menu can itself move the cursor out of a table, and a table the cursor leaves is
  // laid out again - so by the time an item is clicked the offsets this was built from may name
  // different text. What was captured is only ever used to decide what the menu says.
  const selection = () => view.state.selection.main;

  const cut = async () => {
    const at = selection();
    // Copy first and delete only if it worked. A cut that could not reach the clipboard and deleted
    // the text anyway is the one outcome here that loses something the user cannot get back.
    if (!(await copyText(view.state.sliceDoc(at.from, at.to)))) {
      notify('Could not put that on the clipboard, so nothing was cut. Try Ctrl-X instead.');
      return;
    }
    view.dispatch({ changes: { from: at.from, to: at.to, insert: '' }, userEvent: 'delete.cut' });
    view.focus();
  };

  const copy = async () => {
    const at = selection();
    if (!(await copyText(view.state.sliceDoc(at.from, at.to)))) {
      notify('Could not put that on the clipboard. Try Ctrl-C instead.');
    }
    view.focus();
  };

  const paste = async () => {
    const text = await readText();
    if (text === null) {
      notify('This browser will not let the app read the clipboard. Ctrl-V still works.');
      return;
    }
    const at = selection();
    view.dispatch({
      changes: { from: at.from, to: at.to, insert: text },
      selection: { anchor: at.from + text.length },
      userEvent: 'input.paste',
    });
    view.focus();
  };

  const editing: MenuEntry[] = [
    {
      label: 'Cut',
      icon: <CutIcon />,
      disabled: range.empty,
      hint: range.empty ? 'Select some text first' : undefined,
      run: () => void cut(),
    },
    {
      label: 'Copy',
      icon: <CopyIcon />,
      disabled: range.empty,
      hint: range.empty ? 'Select some text first' : undefined,
      run: () => void copy(),
    },
    { label: 'Paste', icon: <PasteIcon />, run: () => void paste() },
  ];

  if (!context) {
    return [
      ...editing,
      SEPARATOR,
      { label: 'Insert table', icon: <TableIcon />, run: () => insertTable(view) },
    ];
  }

  const columns = columnCount(context.table);
  const rows = context.table.rows.length;
  const alignment = context.table.align[context.column] ?? 'none';
  const onHeader = context.row < 0;
  const asText = isTextMode(view.state, context.from);

  const align = (
    label: string,
    icon: React.ReactNode,
    which: 'left' | 'center' | 'right',
  ): MenuEntry => ({
    label,
    icon,
    selected: alignment === which,
    run: () => alignColumn(view, which),
  });

  return [
    ...editing,
    SEPARATOR,
    {
      label: asText ? 'Show as a table' : 'Show as text',
      icon: asText ? <TableIcon /> : <TextIcon />,
      run: () => {
        view.dispatch({ effects: setTextMode.of({ from: context.from, on: !asText }) });
        view.focus();
      },
    },
    SEPARATOR,
    { label: 'Row above', icon: <RowIcon />, run: () => addRow(view, 'above') },
    { label: 'Row below', icon: <RowIcon />, run: () => addRow(view, 'below') },
    { label: 'Column left', icon: <ColumnIcon />, run: () => addColumn(view, 'left') },
    { label: 'Column right', icon: <ColumnIcon />, run: () => addColumn(view, 'right') },
    SEPARATOR,
    {
      label: 'Move row up',
      icon: <MoveUpIcon />,
      disabled: onHeader || context.row === 0,
      hint: onHeader ? 'The header row stays where it is' : undefined,
      run: () => shiftRow(view, -1),
    },
    {
      label: 'Move row down',
      icon: <MoveDownIcon />,
      disabled: onHeader || context.row >= rows - 1,
      hint: onHeader ? 'The header row stays where it is' : undefined,
      run: () => shiftRow(view, 1),
    },
    {
      label: 'Move column left',
      icon: <MoveLeftIcon />,
      disabled: context.column === 0,
      run: () => shiftColumn(view, -1),
    },
    {
      label: 'Move column right',
      icon: <MoveRightIcon />,
      disabled: context.column >= columns - 1,
      run: () => shiftColumn(view, 1),
    },
    SEPARATOR,
    align('Align left', <AlignLeftIcon />, 'left'),
    align('Align centre', <AlignCentreIcon />, 'center'),
    align('Align right', <AlignRightIcon />, 'right'),
    SEPARATOR,
    {
      label: 'Delete row',
      icon: <TrashIcon />,
      danger: true,
      disabled: onHeader,
      hint: onHeader ? 'A table keeps its header row' : undefined,
      run: () => removeRow(view),
    },
    {
      label: 'Delete column',
      icon: <TrashIcon />,
      danger: true,
      disabled: columns <= 1,
      hint: columns <= 1 ? 'A table keeps its last column' : undefined,
      run: () => removeColumn(view),
    },
    { label: 'Delete table', icon: <TrashIcon />, danger: true, run: () => removeTable(view) },
  ];
}
