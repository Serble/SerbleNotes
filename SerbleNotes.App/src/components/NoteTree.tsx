import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  MoveIcon,
  NoteIcon,
  PlusIcon,
  RenameIcon,
  TrashIcon,
} from './Icons';
import { ContextMenu, type MenuItem, type MenuState } from './ContextMenu';
import type { TreeNode } from '../services/store';

export interface TreeActions {
  onOpen: (noteId: string) => void;
  onRenameNote: (noteId: string, name: string) => void;
  onRenameFolder: (path: string, name: string) => void;
  onMoveNote: (noteId: string, targetFolder: string) => void;
  onMoveFolder: (path: string, targetFolder: string) => void;
  /** Opens the destination picker, for when dragging is awkward or the target is far away. */
  onPickFolderForNote: (noteId: string) => void;
  onPickFolderForFolder: (path: string) => void;
  onDeleteNote: (noteId: string) => void;
  onDeleteFolder: (path: string) => void;
  onNewNote: (folder: string) => void;
  onNewFolder: (parent: string) => void;
}

interface NoteTreeProps extends TreeActions {
  collapse: FolderCollapse;
  nodes: TreeNode[];
  selectedId: string | null;
  filter: string;
  /** A path to put straight into rename mode - how a just-created folder gets named. */
  renameTarget: string | null;
  onRenameTargetHandled: () => void;
  /** Drops the filter, because a folder clicked in the results is a place to go rather than a hit. */
  onClearFilter: () => void;
}

/**
 * The vault as a folder tree, with the sharp end of a file manager: drag to move, right-click for
 * everything else, rename in place.
 *
 * No folder is stored anywhere. Every one of these is read out of the '/' in note names, which is
 * the same rule the FUSE filesystem will use when it mounts the vault, so dragging a note into a
 * folder here and moving the file there are the same operation on the same data.
 */

/**
 * What is currently being dragged. This is deliberately not React state: dragover fires constantly
 * and cannot read dataTransfer (the browser only exposes the payload on drop), so the drag needs a
 * value that any handler can read synchronously without re-rendering the tree on every pixel.
 */
type DragItem =
  | { kind: 'note'; id: string; path: string; name: string }
  | { kind: 'folder'; path: string; name: string };

let dragItem: DragItem | null = null;

/**
 * Which folders are *shut*, not which are open. A folder's only identity is its path, so renaming
 * or moving one loses whatever was remembered about it - and the failure has to be the harmless
 * direction. Remembering the open ones means a renamed folder slams shut, taking the note you just
 * dropped in out of sight; remembering the shut ones means it opens, which is what you wanted
 * anyway after making, renaming or filing something into it.
 */
const COLLAPSED_KEY = 'serblenotes.collapsed.';

function loadCollapsed(vaultId: string): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY + vaultId);
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set<string>();
  }
}

/** Which folders are shut, and the four things anything is allowed to do about it. */
export interface FolderCollapse {
  isShut: (path: string) => boolean;
  toggle: (path: string) => void;
  /** Opens a folder something has just been put into, so it is not dropped out of sight. */
  reveal: (path: string) => void;
  shutAll: (paths: string[]) => void;
  openAll: () => void;
  /** True when every folder in the vault is shut, which is what makes one button mean two things. */
  allShut: (paths: string[]) => boolean;
}

/**
 * The tree draws the folders and the toolbar above it has the button that shuts them all, so the
 * state cannot live in either one. It lives here, and both are handed the same object.
 */
export function useCollapsedFolders(vaultId: string): FolderCollapse {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(vaultId));

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY + vaultId, JSON.stringify([...collapsed]));
    } catch {
      // Not being able to remember which folders were shut is not worth an error.
    }
  }, [collapsed, vaultId]);

  return useMemo(
    () => ({
      isShut: (path) => collapsed.has(path),

      toggle: (path) =>
        setCollapsed((current) => {
          const next = new Set(current);
          if (!next.delete(path)) {
            next.add(path);
          }
          return next;
        }),

      reveal: (path) =>
        setCollapsed((current) => {
          if (!current.has(path)) {
            return current;
          }
          const next = new Set(current);
          next.delete(path);
          return next;
        }),

      // Only the paths that exist are remembered. Shutting everything by writing down every folder
      // there is would otherwise leave the list holding folders that were deleted years ago.
      shutAll: (paths) => setCollapsed(new Set(paths)),
      openAll: () => setCollapsed(new Set()),

      allShut: (paths) => paths.length > 0 && paths.every((path) => collapsed.has(path)),
    }),
    [collapsed],
  );
}

/**
 * How long a folder jumped to from the filter stays marked. Long enough to find with the eye,
 * short enough that it is gone before it can be mistaken for the selection.
 */
const FLASH_MS = 1600;

/** Every folder above this one, outermost first - the ones that have to be open to see it. */
function ancestorsOf(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

/** Keeps only the folders whose name, or a note inside them, matches what was typed. */
function filterTree(nodes: TreeNode[], needle: string): TreeNode[] {
  const lower = needle.toLowerCase();

  const walk = (list: TreeNode[]): TreeNode[] =>
    list.flatMap<TreeNode>((node) => {
      if (node.noteId !== undefined) {
        return node.name.toLowerCase().includes(lower) ? [node] : [];
      }

      const children = walk(node.children);
      if (children.length > 0 || node.name.toLowerCase().includes(lower)) {
        return [{ ...node, children }];
      }
      return [];
    });

  return walk(nodes);
}

export function NoteTree(props: NoteTreeProps) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // '' is the top level, which is a real drop target; null means nothing is being hovered.
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // The folder just jumped to from the filter, marked until the eye has had a chance to find it.
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number>();

  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  // A folder that was just created arrives already in rename mode, so it can be named by typing
  // rather than by hunting for a rename command.
  const { renameTarget, onRenameTargetHandled } = props;
  useEffect(() => {
    if (renameTarget === null) {
      return;
    }
    setRenaming(renameTarget);
    onRenameTargetHandled();
  }, [renameTarget, onRenameTargetHandled]);

  const filtering = props.filter.trim().length > 0;
  const nodes = useMemo(
    () => (filtering ? filterTree(props.nodes, props.filter.trim()) : props.nodes),
    [props.nodes, props.filter, filtering],
  );

  const { toggle, reveal } = props.collapse;
  const { onClearFilter } = props;

  /**
   * A folder clicked in a filtered tree is a destination, not a twisty. The rows around it are only
   * the ones that matched, so opening it there shows a folder with most of its contents missing and
   * leaves the person no nearer to where the folder actually is. The filter is dropped instead,
   * every folder above it opened, and the row itself focused and marked - without that last part
   * the tree it lands in is the whole vault again and the folder is somewhere in it.
   */
  const goTo = (path: string) => {
    onClearFilter();
    for (const ancestor of ancestorsOf(path)) {
      reveal(ancestor);
    }
    reveal(path);

    setFlash(path);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), FLASH_MS);
  };

  const drop = (targetFolder: string) => {
    const item = dragItem;
    dragItem = null;
    setDropTarget(null);
    if (!item) {
      return;
    }

    // Show where it went, rather than swallowing it into a shut folder.
    if (targetFolder !== '') {
      reveal(targetFolder);
    }

    if (item.kind === 'note') {
      props.onMoveNote(item.id, targetFolder);
    } else if (item.path !== targetFolder) {
      props.onMoveFolder(item.path, targetFolder);
    }
  };

  const folderMenu = (node: TreeNode): MenuItem[] => [
    { label: 'New note here', icon: <PlusIcon />, run: () => props.onNewNote(node.path) },
    { label: 'New folder here', icon: <FolderPlusIcon />, run: () => props.onNewFolder(node.path) },
    { label: 'Rename', icon: <RenameIcon />, run: () => setRenaming(node.path) },
    { label: 'Move to...', icon: <MoveIcon />, run: () => props.onPickFolderForFolder(node.path) },
    {
      label: 'Delete folder',
      icon: <TrashIcon />,
      danger: true,
      run: () => props.onDeleteFolder(node.path),
    },
  ];

  const noteMenu = (node: TreeNode, noteId: string): MenuItem[] => [
    { label: 'Open', icon: <NoteIcon />, run: () => props.onOpen(noteId) },
    { label: 'Rename', icon: <RenameIcon />, run: () => setRenaming(node.path) },
    { label: 'Move to...', icon: <MoveIcon />, run: () => props.onPickFolderForNote(noteId) },
    {
      label: 'Delete note',
      icon: <TrashIcon />,
      danger: true,
      run: () => props.onDeleteNote(noteId),
    },
  ];

  const rootMenu = (): MenuItem[] => [
    { label: 'New note', icon: <PlusIcon />, run: () => props.onNewNote('') },
    { label: 'New folder', icon: <FolderPlusIcon />, run: () => props.onNewFolder('') },
  ];

  const openMenu = (event: React.MouseEvent, items: MenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  const rows = (list: TreeNode[], depth: number, parent: string): React.ReactNode =>
    list.map((node) => {
      const isNote = node.noteId !== undefined;
      const open = filtering || !props.collapse.isShut(node.path);
      const indent = { paddingLeft: `${depth * 0.8 + 0.35}rem` };

      if (renaming === node.path) {
        return (
          <RenameRow
            key={node.path}
            name={node.name}
            depth={depth}
            isNote={isNote}
            open={open}
            onCancel={() => setRenaming(null)}
            onCommit={(name) => {
              setRenaming(null);
              // An empty name is not a rename, it is a mis-hit Enter. Nothing to save.
              if (name !== '' && name !== node.name) {
                if (isNote) {
                  props.onRenameNote(node.noteId!, name);
                } else {
                  props.onRenameFolder(node.path, name);
                }
              }
            }}
          />
        );
      }

      if (isNote) {
        const noteId = node.noteId!;
        return (
          <div
            key={node.path}
            className={noteId === props.selectedId ? 'tree-row selected' : 'tree-row'}
            style={indent}
            draggable
            onDragStart={(event) => {
              dragItem = { kind: 'note', id: noteId, path: node.path, name: node.name };
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', node.name);
            }}
            onDragEnd={() => {
              dragItem = null;
              setDropTarget(null);
            }}
            onDragOver={(event) => {
              if (!dragItem) {
                return;
              }
              // Dropping onto a note means dropping into the folder it is sitting in, which is how
              // every file manager behaves. Without this the drop would fall through to the root.
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = 'move';
              setDropTarget(parent);
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              drop(parent);
            }}
            onContextMenu={(event) => openMenu(event, noteMenu(node, noteId))}
          >
            <button
              className="tree-open"
              onClick={() => props.onOpen(noteId)}
              onDoubleClick={() => setRenaming(node.path)}
            >
              <span className="tree-twist" />
              <NoteIcon />
              <span className="tree-name">{node.name}</span>
            </button>
            <button
              className="icon danger"
              title="Delete note"
              onClick={() => props.onDeleteNote(noteId)}
            >
              <TrashIcon />
            </button>
          </div>
        );
      }

      return (
        <div key={node.path}>
          <FolderRow
            node={node}
            depth={depth}
            open={open}
            highlighted={dropTarget === node.path}
            flash={flash === node.path}
            onToggle={() => (filtering ? goTo(node.path) : toggle(node.path))}
            onRename={() => setRenaming(node.path)}
            onNewNote={() => props.onNewNote(node.path)}
            onContextMenu={(event) => openMenu(event, folderMenu(node))}
            onDragEnter={() => {
              if (dragItem) {
                setDropTarget(node.path);
              }
            }}
            onHoverWhileDragging={() => reveal(node.path)}
            onDrop={() => drop(node.path)}
            onDragStart={() => {
              dragItem = { kind: 'folder', path: node.path, name: node.name };
            }}
            onDragEnd={() => {
              dragItem = null;
              setDropTarget(null);
            }}
          />
          {open && node.children.length > 0 && rows(node.children, depth + 1, node.path)}
          {open && node.children.length === 0 && (
            <p className="tree-empty" style={{ paddingLeft: `${(depth + 1) * 0.8 + 1.6}rem` }}>
              Empty
            </p>
          )}
        </div>
      );
    });

  return (
    <>
      <div
        className={dropTarget === '' ? 'tree drop-root' : 'tree'}
        onContextMenu={(event) => openMenu(event, rootMenu())}
        onDragOver={(event) => {
          if (!dragItem) {
            return;
          }
          // Anything not claimed by a folder row lands at the top level.
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDropTarget('');
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) {
            setDropTarget(null);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          drop('');
        }}
      >
        {rows(nodes, 0, '')}
        {nodes.length === 0 && (
          <p className="muted small">{filtering ? 'Nothing matches.' : 'This vault is empty.'}</p>
        )}
      </div>

      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </>
  );
}

interface FolderRowProps {
  node: TreeNode;
  depth: number;
  open: boolean;
  highlighted: boolean;
  /** Just jumped to from the filter: take the caret and say which row it was. */
  flash: boolean;
  onToggle: () => void;
  onRename: () => void;
  onNewNote: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
  onDragEnter: () => void;
  onHoverWhileDragging: () => void;
  onDrop: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

function FolderRow(props: FolderRowProps) {
  const hoverTimer = useRef<number>();
  const open = useRef<HTMLButtonElement>(null);

  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  // Focus rather than a scroll alone: it is the row's own control, so it comes with a focus ring,
  // it is where the keyboard now is, and a folder found by filtering can be opened by pressing
  // Enter. The scroll is asked for separately so it moves as little as it can.
  const { flash } = props;
  useEffect(() => {
    if (!flash) {
      return;
    }
    open.current?.focus({ preventScroll: true });
    open.current?.scrollIntoView({ block: 'nearest' });
  }, [flash]);

  const className = ['tree-row', 'folder', props.highlighted ? 'drop-into' : '', flash ? 'flash' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={className}
      style={{ paddingLeft: `${props.depth * 0.8 + 0.35}rem` }}
      draggable
      onDragStart={(event) => {
        props.onDragStart();
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', props.node.name);
      }}
      onDragEnd={props.onDragEnd}
      onDragOver={(event) => {
        if (!dragItem) {
          return;
        }
        // Claiming the event here is what stops the drop falling through to the top level.
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        props.onDragEnter();

        // Hovering over a closed folder for a moment opens it, so a note can be dragged several
        // levels down in one go instead of being dropped and picked up again.
        if (!props.open && hoverTimer.current === undefined) {
          hoverTimer.current = window.setTimeout(() => {
            hoverTimer.current = undefined;
            props.onHoverWhileDragging();
          }, 600);
        }
      }}
      onDragLeave={() => {
        window.clearTimeout(hoverTimer.current);
        hoverTimer.current = undefined;
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        window.clearTimeout(hoverTimer.current);
        hoverTimer.current = undefined;
        props.onDrop();
      }}
      onContextMenu={props.onContextMenu}
    >
      <button
        ref={open}
        className="tree-open"
        onClick={props.onToggle}
        onDoubleClick={props.onRename}
      >
        <span className="tree-twist">
          {props.open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </span>
        {props.open ? <FolderOpenIcon /> : <FolderIcon />}
        <span className="tree-name">{props.node.name}</span>
      </button>
      <button className="icon" title="New note in this folder" onClick={props.onNewNote}>
        <PlusIcon />
      </button>
      <button className="icon" title="Rename folder" onClick={props.onRename}>
        <RenameIcon />
      </button>
    </div>
  );
}

function RenameRow({
  name,
  depth,
  isNote,
  open,
  onCommit,
  onCancel,
}: {
  name: string;
  depth: number;
  isNote: boolean;
  open: boolean;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(name);

  return (
    <div className="tree-row renaming" style={{ paddingLeft: `${depth * 0.8 + 0.35}rem` }}>
      <span className="tree-twist" />
      {isNote ? <NoteIcon /> : open ? <FolderOpenIcon /> : <FolderIcon />}
      <input
        className="tree-rename"
        value={draft}
        autoFocus
        spellCheck={false}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => onCommit(draft.trim())}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
          if (event.key === 'Escape') {
            // Put the name back first so the blur that follows commits nothing.
            setDraft(name);
            onCancel();
          }
        }}
      />
    </div>
  );
}
