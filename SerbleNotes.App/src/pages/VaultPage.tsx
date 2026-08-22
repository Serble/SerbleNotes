import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  BackIcon,
  CloseIcon,
  CollapseAllIcon,
  ExpandAllIcon,
  ExportIcon,
  FolderPlusIcon,
  HistoryIcon,
  ImportIcon,
  InfoIcon,
  LockIcon,
  MenuIcon,
  PlusIcon,
  SearchIcon,
} from "../components/Icons";
import { ConfirmModal } from "../components/ConfirmModal";
import { ExportDialog } from "../components/ExportDialog";
import { ImportDialog } from "../components/ImportDialog";
import { HistoryPanel } from "../components/HistoryPanel";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { MarkdownPreview } from "../components/MarkdownPreview";
import { MoveDialog } from "../components/MoveDialog";
import { NoteDetails } from "../components/NoteDetails";
import { NotePathBar } from "../components/NotePathBar";
import { NoteTree, useCollapsedFolders } from "../components/NoteTree";
import { PromptModal } from "../components/PromptModal";
import { Splitter } from "../components/Splitter";
import { merge, parentPath } from "../core";
import { absolute, relative } from "../services/dates";
import {
  DEFAULT_LAYOUT,
  loadLayout,
  saveLayout,
  type Layout,
} from "../services/layout";
import { lastNoteIn, rememberNote } from "../services/settings";
import { SyncSocket } from "../services/sync";
import { VaultStore } from "../services/store";
import { keyFor, unlock } from "../services/vaultKeys";
import { storageWarning } from "../services/secrets";
import type { NoteVersion, Vault } from "../types";

const AUTOSAVE_MS = 1200;

/**
 * The width below which the tree and the panels cover the editor instead of sitting beside it.
 *
 * This number is also in index.css, and the two have to agree: the stylesheet decides what the
 * columns look like, and this decides what the button that opens them does. There is no way to ask
 * the stylesheet, so the comment is the link.
 */
const NARROW = "(max-width: 860px)";

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);

  useEffect(() => {
    const query = window.matchMedia(NARROW);
    const update = () => setNarrow(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return narrow;
}

/** Everything the workspace can stop and ask about. One at a time, so one piece of state holds it. */
type Dialog =
  | { kind: "delete-note"; noteId: string; name: string }
  | { kind: "delete-folder"; path: string; notes: string[] }
  | { kind: "move-note"; noteId: string }
  | { kind: "move-folder"; path: string }
  | { kind: "name-point" }
  | { kind: "export" }
  | { kind: "import" };

export function VaultPage({
  vault,
  onBack,
}: {
  vault: Vault;
  onBack: () => void;
}) {
  const [vaultKey, setVaultKey] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  // Asking the device whether it already has this vault's key is a round trip to the OS keychain in
  // the native clients, so it cannot be answered while rendering.
  useEffect(() => {
    let live = true;
    keyFor(vault)
      .then((key) => {
        if (live) {
          setVaultKey(key);
        }
      })
      .finally(() => {
        if (live) {
          setChecking(false);
        }
      });

    return () => {
      live = false;
    };
  }, [vault]);

  if (checking) {
    return (
      <div className="centred">
        <p className="muted">Opening {vault.name}...</p>
      </div>
    );
  }

  if (!vaultKey) {
    return (
      <UnlockScreen vault={vault} onBack={onBack} onUnlocked={setVaultKey} />
    );
  }

  return <Workspace vault={vault} vaultKey={vaultKey} onBack={onBack} />;
}

function UnlockScreen({
  vault,
  onBack,
  onUnlocked,
}: {
  vault: Vault;
  onBack: () => void;
  onUnlocked: (key: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    // Deriving the key is deliberately slow, so let the browser paint the busy state first.
    window.setTimeout(() => {
      unlock(vault, password)
        .then(onUnlocked)
        .catch((e: unknown) =>
          setError(e instanceof Error ? e.message : String(e)),
        )
        .finally(() => setBusy(false));
    }, 0);
  };

  // Only promise what this device can actually do. If the keychain would not answer, the password
  // will be needed again next time, and saying otherwise would be a lie the user finds out later.
  const cannotRemember = storageWarning();

  return (
    <div className="centred">
      <form className="card hero" onSubmit={submit}>
        <span className="hero-mark">
          <LockIcon size={20} />
        </span>
        <div>
          <h1>{vault.name}</h1>
          <p className="muted small">
            {cannotRemember === null
              ? "Encrypted. Enter its password to unlock it on this device - you will not be asked again here."
              : "Encrypted. Enter its password to unlock it."}
          </p>
        </div>

        {cannotRemember !== null && (
          <p className="warning small notice">
            This device will not remember the key, so you will be asked again
            next time. {cannotRemember}
          </p>
        )}

        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Vault password"
          autoComplete="current-password"
          autoFocus
        />
        {error && <p className="error">{error}</p>}
        <div className="row end">
          <button type="button" className="ghost" onClick={onBack}>
            Back
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Unlocking..." : "Unlock"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Workspace({
  vault,
  vaultKey,
  onBack,
}: {
  vault: Vault;
  vaultKey: string;
  onBack: () => void;
}) {
  const storeRef = useRef<VaultStore>();
  if (!storeRef.current) {
    storeRef.current = new VaultStore(vault, vaultKey);
  }
  const store = storeRef.current;

  // The store is a mutable model rather than React state; this is how the UI is told it moved.
  const [, refresh] = useReducer((count: number) => count + 1, 0);

  // Shared between the tree, which draws the folders, and the button above it that shuts them all.
  const collapse = useCollapsedFolders(vault.id);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [baseline, setBaseline] = useState<string | null>(null);
  const [pendingMergeParent, setPendingMergeParent] = useState<string | null>(
    null,
  );
  const [conflicted, setConflicted] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [previewVersion, setPreviewVersion] = useState<NoteVersion | null>(
    null,
  );
  const [filter, setFilter] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);

  // On a narrow screen the file tree and the side panels cover the editor rather than sitting
  // beside it, so whether they are showing is state rather than a media query alone.
  const [navOpen, setNavOpen] = useState(false);
  const narrow = useNarrow();

  // Column widths and whether the tree is collapsed, remembered on this device.
  const [layout, setLayout] = useState<Layout>(loadLayout);
  const adjust = (change: Partial<Layout>) =>
    setLayout((current) => {
      const next = { ...current, ...change };
      saveLayout(next);
      return next;
    });

  // The sync callback lives outside React's render cycle, so it reads current values from refs.
  const selectedRef = useRef(selected);
  const textRef = useRef(text);
  const baselineRef = useRef(baseline);
  selectedRef.current = selected;
  textRef.current = text;
  baselineRef.current = baseline;

  const openNote = useCallback(
    (noteId: string) => {
      setSelected(noteId);
      rememberNote(vault.id, noteId);
      setBaseline(store.headOf(noteId));
      setText(store.textOf(noteId));
      setConflicted(false);
      setDirty(false);
      setPreviewVersion(null);

      // Picking a note is the point of the drawer, so it gets out of the way once you have.
      setNavOpen(false);
    },
    [store, vault.id],
  );

  useEffect(() => {
    store
      .pull()
      .then(() => {
        const notes = store.listNotes();

        // Where this device left off, as long as that note still exists - it can have been deleted
        // on another device since, and an id that no longer names anything opens nothing at all.
        const remembered = lastNoteIn(vault.id);
        const reopen = notes.find((note) => note.id === remembered) ?? notes[0];

        if (reopen) {
          openNote(reopen.id);
        }
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setLoading(false));
  }, [store, openNote, vault.id]);

  /** Someone else changed this vault. Pull, then reconcile with whatever is in the editor. */
  const handleRemoteChange = useCallback(async () => {
    try {
      await store.pull();
      refresh();

      const noteId = selectedRef.current;
      if (!noteId) {
        return;
      }

      const remoteHead = store.headOf(noteId);
      const base = baselineRef.current;
      if (!remoteHead || remoteHead === base) {
        return;
      }

      const remoteText = store.materialise(remoteHead);
      const localText = textRef.current;
      const baseText = base ? store.materialise(base) : "";

      if (localText === baseText) {
        // Nothing unsaved locally, so the remote version simply becomes what we are editing.
        setText(remoteText);
        setBaseline(remoteHead);
        return;
      }

      // Both sides moved. Merge against where they diverged, and remember the branch we merged from
      // so the version we write next records both parents.
      const ancestorId = base ? store.commonAncestor(base, remoteHead) : null;
      const ancestorText = ancestorId
        ? store.materialise(ancestorId)
        : baseText;
      const merged = merge(ancestorText, localText, remoteText);

      setText(merged.text);
      setConflicted(merged.conflicted);
      setPendingMergeParent(base);
      setBaseline(remoteHead);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [store]);

  useEffect(() => {
    const socket = new SyncSocket((event) => {
      if (event.vaultId === vault.id) {
        void handleRemoteChange();
      }
    });
    socket.connect();
    return () => socket.close();
  }, [vault.id, handleRemoteChange]);

  // Autosave. Every pause in typing that actually changed something becomes a version.
  useEffect(() => {
    if (!selected) {
      return;
    }

    let currentText: string;
    try {
      currentText = store.textOf(selected);
    } catch {
      return;
    }

    if (text === currentText) {
      setDirty(false);
      return;
    }

    setDirty(true);
    const timer = window.setTimeout(() => {
      store
        .saveNote(selected, text, { mergeParentId: pendingMergeParent })
        .then(() => {
          setPendingMergeParent(null);
          setBaseline(store.headOf(selected));
          setDirty(false);
          refresh();
        })
        .catch((e: unknown) =>
          setError(e instanceof Error ? e.message : String(e)),
        );
    }, AUTOSAVE_MS);

    return () => window.clearTimeout(timer);
  }, [text, selected, store, pendingMergeParent]);

  /**
   * Runs a change against the store and shows anything it refuses. Moves and renames are the one
   * place the model can say no - two things cannot share a path - and that has to be visible.
   */
  const attempt = async (
    work: () => void | Promise<void>,
  ): Promise<boolean> => {
    setError(null);
    try {
      await work();
      refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      refresh();
      return false;
    }
  };

  /** A name nothing in that folder is using, so a new note or folder never lands on an existing one. */
  const unusedLeaf = (folder: string, base: string): string => {
    const taken = new Set([
      ...store.listNotes().map((note) => store.pathOf(note.id)),
      ...store.folders(),
    ]);
    const at = (name: string) => (folder === "" ? name : `${folder}/${name}`);

    if (!taken.has(at(base))) {
      return base;
    }
    for (let suffix = 2; ; suffix += 1) {
      const candidate = `${base} ${suffix}`;
      if (!taken.has(at(candidate))) {
        return candidate;
      }
    }
  };

  const newNote = (folder: string) =>
    attempt(async () => {
      const leaf = unusedLeaf(folder, "Untitled");
      const note = await store.createNote(
        folder === "" ? leaf : `${folder}/${leaf}`,
        "",
      );
      openNote(note.id);
    });

  const newFolder = (parent: string) =>
    attempt(() => {
      setRenameTarget(
        store.createFolder(parent, unusedLeaf(parent, "New folder")),
      );
    });

  const removeNote = (noteId: string) =>
    attempt(async () => {
      await store.deleteNote(noteId);
      if (selected === noteId) {
        setSelected(null);
        setText("");
      }
    });

  const removeFolder = (path: string) =>
    attempt(async () => {
      const inside = store.notesUnder(path).map((note) => note.id);
      await store.deleteFolder(path);
      if (selected !== null && inside.includes(selected)) {
        setSelected(null);
        setText("");
      }
    });

  // The tree clears this once it has put the new folder into rename mode; a stable identity keeps
  // that from re-running on every render.
  const clearRenameTarget = useCallback(() => setRenameTarget(null), []);

  const namePoint = (label: string) =>
    attempt(async () => {
      if (!selected || label.trim() === "") {
        return;
      }
      await store.saveNote(selected, text, {
        isNamed: true,
        label: label.trim(),
      });
      setBaseline(store.headOf(selected));
    });

  const restore = async (version: NoteVersion) => {
    if (!selected) {
      return;
    }
    try {
      await store.restore(selected, version.id);
      setText(store.textOf(selected));
      setBaseline(store.headOf(selected));
      setPreviewVersion(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const tree = store.tree();
  const folderPaths = store.folders();
  const everythingShut = collapse.allShut(folderPaths);
  const history = selected ? store.historyOf(selected) : [];
  const note = selected ? store.getNote(selected) : undefined;

  // Both panels describe the open note, so there is nothing for the rail to hold without one.
  const railOpen = selected !== null && (showDetails || showHistory);

  return (
    <div
      className="workspace"
      data-nav={navOpen ? "open" : "shut"}
      data-rail={railOpen ? "open" : "shut"}
      data-tree={layout.treeShut ? "shut" : "open"}
      // The stylesheet already lays the columns out from these two, so a drag only has to change
      // the numbers - no element is measured, and nothing re-renders but this attribute.
      style={
        {
          "--sidebar": `${layout.sidebar}px`,
          "--rail": `${layout.rail}px`,
          "--details": layout.details === null ? "auto" : `${layout.details}px`,
        } as React.CSSProperties
      }
    >
      <header className="app-bar">
        <div className="app-bar-left">
          <button
            className="icon nav-toggle"
            onClick={() => {
              // One button, two layouts. Wide, the tree is a column that collapses and stays
              // collapsed; narrow, it is a drawer that comes and goes.
              if (!narrow) {
                adjust({ treeShut: !layout.treeShut });
                return;
              }

              // Opening one drawer has to shut the other, or they stack on top of each other.
              const opening = !navOpen;
              setNavOpen(opening);
              if (opening) {
                setShowDetails(false);
                setShowHistory(false);
              }
            }}
            aria-label={
              (narrow ? navOpen : !layout.treeShut)
                ? "Hide notes"
                : "Show notes"
            }
            aria-expanded={narrow ? navOpen : !layout.treeShut}
          >
            <MenuIcon />
          </button>
          <button className="ghost" onClick={onBack}>
            <BackIcon />
            <span className="wide-only">Vaults</span>
          </button>
          <h1 title={vault.name}>{vault.name}</h1>
          {!vault.encrypted && (
            <span
              className="badge open"
              title="The server can read everything in this vault."
            >
              Not encrypted
            </span>
          )}
        </div>

        <div className="app-bar-right">
          <button
            className="ghost"
            onClick={() => setDialog({ kind: "import" })}
            title="Import a zip of markdown files into this vault"
          >
            <ImportIcon />
            <span className="wide-only">Import</span>
          </button>
          <button
            className="ghost"
            onClick={() => setDialog({ kind: "export" })}
            title="Save this vault as a zip of markdown files"
          >
            <ExportIcon />
            <span className="wide-only">Export</span>
          </button>

          <span
            className={dirty ? "save-state saving" : "save-state"}
            aria-live="polite"
          >
            <span className="save-dot" aria-hidden="true" />
            {dirty ? "Saving" : "Saved"}
          </span>
        </div>
      </header>

      {error && <p className="error banner">{error}</p>}
      {conflicted && (
        <p className="warning banner">
          This note was edited on another device at the same time. The parts
          that clashed are marked with <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code>{" "}
          below - edit them and the markers away, and the result saves normally.
        </p>
      )}

      <div className="columns">
        {/* The padding lives on the inner box so the column itself can be dragged down to nothing:
            padding on a border-box element is a floor it can never shrink below. */}
        <nav className="sidebar" aria-label="Notes">
          <div className="sidebar-inner">
            <div className="sidebar-head">
              <h2>Notes</h2>
              <button
                className="icon narrow-only"
                onClick={() => setNavOpen(false)}
                aria-label="Hide notes"
              >
                <CloseIcon />
              </button>
            </div>

            <div className="notes-tools">
              <button className="ghost small" onClick={() => void newNote("")}>
                <PlusIcon /> Note
              </button>
              <button
                className="ghost small"
                onClick={() => void newFolder("")}
              >
                <FolderPlusIcon /> Folder
              </button>

              {/* One button, two meanings, like the tree toggle in the app bar: it shuts everything
                  unless everything is already shut, which is the only moment "expand" is the thing
                  anyone wants. With no folders at all there is nothing for it to do, so it is not
                  there. */}
              {folderPaths.length > 0 && (
                <button
                  className="ghost small icon"
                  onClick={() =>
                    everythingShut
                      ? collapse.openAll()
                      : collapse.shutAll(folderPaths)
                  }
                  title={
                    everythingShut ? "Expand all folders" : "Collapse all folders"
                  }
                  aria-label={
                    everythingShut ? "Expand all folders" : "Collapse all folders"
                  }
                >
                  {everythingShut ? <ExpandAllIcon /> : <CollapseAllIcon />}
                </button>
              )}
            </div>

            <div className="notes-filter">
              <SearchIcon />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter"
                aria-label="Filter notes"
                spellCheck={false}
              />
            </div>

            {loading && <p className="muted small">Loading...</p>}

            <NoteTree
              collapse={collapse}
              nodes={tree}
              selectedId={selected}
              filter={filter}
              renameTarget={renameTarget}
              onRenameTargetHandled={clearRenameTarget}
              onOpen={openNote}
              onRenameNote={(noteId, name) =>
                void attempt(() => store.renameNoteTo(noteId, name))
              }
              onRenameFolder={(path, name) =>
                void attempt(() => store.renameFolderTo(path, name))
              }
              onMoveNote={(noteId, folder) =>
                void attempt(() => store.moveNote(noteId, folder))
              }
              onMoveFolder={(path, folder) =>
                void attempt(() => store.moveFolder(path, folder))
              }
              onDeleteNote={(noteId) =>
                setDialog({
                  kind: "delete-note",
                  noteId,
                  name: store.titleOf(noteId),
                })
              }
              onDeleteFolder={(path) =>
                setDialog({
                  kind: "delete-folder",
                  path,
                  notes: store
                    .notesUnder(path)
                    .map((note) => store.titleOf(note.id)),
                })
              }
              onPickFolderForNote={(noteId) =>
                setDialog({ kind: "move-note", noteId })
              }
              onPickFolderForFolder={(path) =>
                setDialog({ kind: "move-folder", path })
              }
              onNewNote={(folder) => void newNote(folder)}
              onNewFolder={(parent) => void newFolder(parent)}
            />
          </div>
        </nav>

        {!layout.treeShut && (
          <Splitter
            className="splitter-left"
            axis="x"
            resizes="previous"
            label="Resize the notes panel"
            onChange={(sidebar) => adjust({ sidebar })}
            onReset={() => adjust({ sidebar: DEFAULT_LAYOUT.sidebar })}
          />
        )}

        <main className="editor">
          {/* Until the pull lands there is no tree and no note, which is not the same thing as an
              empty vault - saying "Nothing open" here and then opening a note a moment later reads
              as the app changing its mind. */}
          {loading ? (
            <div className="empty">
              <h2>Loading notes...</h2>
              <p className="muted">Decrypting this vault on your device.</p>
            </div>
          ) : previewVersion ? (
            <div className="version-view">
              <div className="version-bar">
                <div className="version-bar-text">
                  <span className="version-bar-title">An older version</span>
                  <span
                    className="muted small"
                    title={absolute(previewVersion.createdAt)}
                  >
                    Saved {relative(previewVersion.createdAt)}
                  </span>
                </div>
                <div className="row">
                  <button
                    className="ghost"
                    onClick={() => setPreviewVersion(null)}
                  >
                    Close
                  </button>
                  <button
                    className="primary"
                    onClick={() => restore(previewVersion)}
                  >
                    Restore
                  </button>
                </div>
              </div>
              <div className="version-body">
                <MarkdownPreview
                  text={safeMaterialise(store, previewVersion.id)}
                />
              </div>
            </div>
          ) : selected ? (
            <>
              <NotePathBar
                folder={store.folderOf(selected)}
                title={store.titleOf(selected)}
                onRename={(title) =>
                  attempt(() => store.renameNoteTo(selected, title))
                }
                onPickFolder={() =>
                  setDialog({ kind: "move-note", noteId: selected })
                }
                actions={
                  <>
                    <button
                      className={showDetails ? "ghost on" : "ghost"}
                      aria-pressed={showDetails}
                      onClick={() => setShowDetails((open) => !open)}
                    >
                      <InfoIcon />
                      <span className="wide-only">Details</span>
                    </button>
                    <button
                      className={showHistory ? "ghost on" : "ghost"}
                      aria-pressed={showHistory}
                      onClick={() => setShowHistory((open) => !open)}
                    >
                      <HistoryIcon />
                      <span className="wide-only">History</span>
                    </button>
                  </>
                }
              />
              {/* Keyed by note so each note gets its own undo history. */}
              <MarkdownEditor
                key={selected}
                value={text}
                onChange={setText}
                onNotice={setError}
              />
            </>
          ) : (
            <div className="empty">
              <h2>Nothing open</h2>
              <p className="muted">
                Pick a note from the list, or start a new one.
              </p>
              <button className="primary" onClick={() => void newNote("")}>
                <PlusIcon />
                New note
              </button>
            </div>
          )}
        </main>

        {railOpen && (
          <Splitter
            className="splitter-right"
            axis="x"
            resizes="next"
            label="Resize the panels"
            onChange={(rail) => adjust({ rail })}
            onReset={() => adjust({ rail: DEFAULT_LAYOUT.rail })}
          />
        )}

        <aside className="rail" aria-label="Note panels">
          <div className="rail-inner">
            {showDetails && note && (
              <NoteDetails
                note={note}
                folder={store.folderOf(note.id)}
                versions={history}
                text={text}
                // Left at its natural height until someone drags it, which is why the panel only
                // takes a fixed size once there is one to take.
                className={layout.details === null ? undefined : "panel-pinned"}
                onPickFolder={() =>
                  setDialog({ kind: "move-note", noteId: note.id })
                }
                onClose={() => setShowDetails(false)}
              />
            )}

            {showDetails && note && showHistory && selected && (
              <Splitter
                axis="y"
                resizes="previous"
                label="Resize the details panel"
                onChange={(details) => adjust({ details })}
                onReset={() => adjust({ details: null })}
              />
            )}

            {showHistory && selected && (
              <HistoryPanel
                versions={history}
                labelOf={(version) => store.labelOf(version)}
                headId={store.headOf(selected)}
                previewingId={previewVersion?.id ?? null}
                onPreview={setPreviewVersion}
                onRestore={restore}
                onNamePoint={() => setDialog({ kind: "name-point" })}
                onClose={() => setShowHistory(false)}
              />
            )}
          </div>
        </aside>

        {/* Only ever visible on a narrow screen, where the drawers sit over the editor. */}
        <button
          className="scrim"
          aria-label="Close"
          tabIndex={-1}
          onClick={() => {
            setNavOpen(false);
            setShowDetails(false);
            setShowHistory(false);
          }}
        />
      </div>

      {dialog?.kind === "delete-note" && (
        <ConfirmModal
          title="Delete note"
          confirmLabel="Delete note"
          danger
          body={
            <p>
              <strong>{dialog.name}</strong> and its whole version history go
              with it.{" "}
              {vault.encrypted
                ? "Nobody else has a copy - the server only ever held it encrypted."
                : "This cannot be undone."}
            </p>
          }
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            void removeNote(dialog.noteId);
          }}
        />
      )}

      {dialog?.kind === "delete-folder" && (
        <ConfirmModal
          title="Delete folder"
          confirmLabel={
            dialog.notes.length === 0
              ? "Delete folder"
              : `Delete ${dialog.notes.length} ${dialog.notes.length === 1 ? "note" : "notes"}`
          }
          danger
          body={
            dialog.notes.length === 0 ? (
              <p>
                <strong>{dialog.path}</strong> is empty, so nothing is lost.
              </p>
            ) : (
              <>
                <p>
                  Deleting <strong>{dialog.path}</strong> deletes everything
                  filed in it, with all of its history:
                </p>
                <ul className="modal-list">
                  {dialog.notes.slice(0, 8).map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                  {dialog.notes.length > 8 && (
                    <li className="muted">
                      and {dialog.notes.length - 8} more
                    </li>
                  )}
                </ul>
              </>
            )
          }
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            void removeFolder(dialog.path);
          }}
        />
      )}

      {dialog?.kind === "move-note" && (
        <MoveDialog
          title="Move note"
          folders={store.folders()}
          current={store.folderOf(dialog.noteId)}
          onCancel={() => setDialog(null)}
          onPick={(folder) => {
            setDialog(null);
            void attempt(() => store.moveNote(dialog.noteId, folder));
          }}
        />
      )}

      {dialog?.kind === "move-folder" && (
        <MoveDialog
          title="Move folder"
          folders={store.folders()}
          current={parentPath(dialog.path)}
          isBlocked={(folder) =>
            folder === dialog.path || folder.startsWith(`${dialog.path}/`)
          }
          onCancel={() => setDialog(null)}
          onPick={(folder) => {
            setDialog(null);
            void attempt(() => store.moveFolder(dialog.path, folder));
          }}
        />
      )}

      {dialog?.kind === "export" && (
        <ExportDialog store={store} onClose={() => setDialog(null)} />
      )}

      {dialog?.kind === "import" && (
        <ImportDialog
          store={store}
          onClose={() => setDialog(null)}
          // The tree is drawn from the store, which the import wrote straight into, so this is all
          // it takes to make the new notes appear.
          onImported={refresh}
        />
      )}

      {dialog?.kind === "name-point" && (
        <PromptModal
          title="Name this restore point"
          label="Name"
          description="A named point is stored whole rather than as a diff, so it stays reachable however the history around it is pruned."
          placeholder="Before the rewrite"
          confirmLabel="Save point"
          onCancel={() => setDialog(null)}
          onSubmit={(label) => {
            setDialog(null);
            void namePoint(label);
          }}
        />
      )}
    </div>
  );
}

function safeMaterialise(store: VaultStore, versionId: string): string {
  try {
    return store.materialise(versionId);
  } catch (e) {
    return `_${e instanceof Error ? e.message : String(e)}_`;
  }
}
