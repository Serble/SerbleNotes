import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
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
import { VersionDiff } from "../components/VersionDiff";
import { MoveDialog } from "../components/MoveDialog";
import { NoteDetails } from "../components/NoteDetails";
import { NotePathBar } from "../components/NotePathBar";
import { NoteTree, useCollapsedFolders } from "../components/NoteTree";
import { PromptModal } from "../components/PromptModal";
import { Splitter } from "../components/Splitter";
import { parentPath } from "../core";
import { absolute, relative } from "../services/dates";
import {
  DEFAULT_LAYOUT,
  loadLayout,
  saveLayout,
  type Layout,
} from "../services/layout";
import {
  commit,
  opened,
  reconcile,
  resync,
  typed,
  unsaved,
  type EditorAccess,
  type EditorState,
} from "../services/noteSync";
import {
  lastNoteIn,
  rememberNote,
  rememberVersionDiff,
  showVersionDiff,
} from "../services/settings";
import { SyncSocket } from "../services/sync";
import type { VaultStore } from "../services/store";
import { storeFor } from "../services/stores";
import { keyFor, unlock } from "../services/vaultKeys";
import { storageWarning } from "../services/secrets";
import type { NoteVersion, PresenceEntry, SyncEvent, Vault } from "../types";

const AUTOSAVE_MS = 1200;

/** No note open. */
const EMPTY_EDITOR: EditorState = {
  text: "",
  baseline: null,
  mergeParent: null,
  conflicted: false,
  status: "saved",
  error: null,
};

/** What the indicator in the app bar says, per state. */
const SAVE_LABEL: Record<EditorState["status"], string> = {
  saved: "Saved",
  saving: "Saving",
  // Not "Saving": there are unsent changes and nothing is being sent. The edit is kept on this
  // device and goes up when the connection comes back, which is worth saying rather than implying.
  offline: "Offline",
  error: "Not saved",
};

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
  // Kept for the session rather than built per visit, so coming back to a vault is a delta pull
  // instead of downloading it again. See services/stores.ts. Through useMemo because it is a lookup
  // with a side effect - it refreshes the store's copy of the vault row - and not a render's work.
  const store = useMemo(() => storeFor(vault, vaultKey), [vault, vaultKey]);

  // The store is a mutable model rather than React state; this is how the UI is told it moved.
  const [, refresh] = useReducer((count: number) => count + 1, 0);

  // Shared between the tree, which draws the folders, and the button above it that shuts them all.
  const collapse = useCollapsedFolders(vault.id);

  const [loading, setLoading] = useState(true);

  /** The note whose history is being fetched, so the editor can say so instead of showing nothing. */
  const [opening, setOpening] = useState<string | null>(null);

  /** Which open request is the current one, so a slow note cannot land on top of a later choice. */
  const openRequest = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  /**
   * Everything about the note being edited: its text, the version that text came from, whether a
   * merge left conflict markers in it, and whether the server has it. One object rather than five
   * pieces of state because they only ever change together - a reconcile that moved the text
   * without the baseline, or a save that cleared the indicator without recording what it wrote,
   * would be a note quietly detached from its own history.
   */
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const { text, conflicted } = editor;

  const [showHistory, setShowHistory] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [previewVersion, setPreviewVersion] = useState<NoteVersion | null>(
    null,
  );

  /**
   * A version's ciphertext is not on the device until something asks for it.
   *
   * Opening a vault brings every version's metadata and none of its bodies, and opening a note
   * brings only the chain that rebuilds its current text - so a version picked out of the history is
   * usually a row this device cannot yet read. It and the version before it are fetched here,
   * because the diff is against that parent.
   *
   * `fetched` exists to re-run the memo below once they arrive; it is deliberately not a dependency
   * of this effect, which would then re-run itself forever.
   */
  const [preview, setPreview] = useState({ loading: false, fetched: 0 });

  useEffect(() => {
    if (!previewVersion) {
      return;
    }

    // Already here - no flash of "loading" for a version this device can rebuild on its own.
    if (store.hasChain(previewVersion.id) && store.hasChain(previewVersion.parentId)) {
      return;
    }

    let cancelled = false;
    setPreview((current) => ({ ...current, loading: true }));

    void store
      .ensureVersions([previewVersion.id, previewVersion.parentId])
      // Whatever could not be fetched is reported where it is read: `materialise` says which version
      // is missing and why. This only keeps a failed fetch from being an unhandled rejection.
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setPreview((current) => ({ loading: false, fetched: current.fetched + 1 }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [previewVersion, store]);

  /**
   * Whether an older version is read as the change it made or as the whole note. Remembered on the
   * device rather than reset per note: it is how this person reads a history, not a fact about one.
   */
  const [asDiff, setAsDiff] = useState(showVersionDiff);
  const chooseDiff = useCallback((diff: boolean) => {
    setAsDiff(diff);
    rememberVersionDiff(diff);
  }, []);

  /**
   * The version being read and the one before it, which is what the diff is against.
   *
   * A version with no parent is the first, and diffing against nothing shows the note as it arrived
   * - which is what that save did. A parent that cannot be rebuilt is null rather than an empty
   * string: an empty base would draw the whole note as newly added, which is a plausible, wrong
   * answer, and this file has a rule about those.
   */
  const previewTexts = useMemo(() => {
    if (!previewVersion) {
      return null;
    }

    let previous: string | null = null;
    try {
      previous = previewVersion.parentId
        ? store.materialise(previewVersion.parentId)
        : "";
    } catch {
      previous = null;
    }

    return { current: safeMaterialise(store, previewVersion.id), previous };
  }, [previewVersion, store, preview.fetched]);
  const [filter, setFilter] = useState("");
  const filterInput = useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);

  /**
   * Which of this account's other devices are in this vault, and what they have open.
   *
   * Vaults are single-owner, so this is never another person - it is this user, somewhere else.
   * Anything shown from it has to be worded that way; "someone is editing this" would be inventing
   * a second person out of a phone left open on the sofa.
   */
  const [presence, setPresence] = useState<PresenceEntry[]>([]);
  const socketRef = useRef<SyncSocket | null>(null);

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
  const editorRef = useRef(editor);
  selectedRef.current = selected;
  editorRef.current = editor;

  /** Applies a new editor state from outside the render cycle, keeping the ref in step with it. */
  const applyEditor = useCallback((next: EditorState) => {
    editorRef.current = next;
    setEditor(next);
  }, []);

  /**
   * The editor, as `services/noteSync.ts` reads and writes it.
   *
   * The pair rather than a value handed in and a value applied afterwards: those functions each
   * spend a round trip at the server, and the person is still typing across it. See `EditorAccess`
   * there for what that costs when it is got wrong, and `tests/typing.test.ts` for the shape of it.
   */
  const editorAccess = useMemo<EditorAccess>(
    () => ({ read: () => editorRef.current, write: applyEditor }),
    [applyEditor],
  );

  /**
   * Someone typed.
   *
   * Through `applyEditor` rather than `setEditor`, so the ref moves with the keystroke rather than
   * with the render that follows it: everything in `services/noteSync.ts` reads the editor back
   * when its request returns, and a ref one render behind is a ref one keystroke behind.
   */
  const setText = useCallback(
    (next: string) => applyEditor(typed(editorRef.current, next)),
    [applyEditor],
  );

  /**
   * Opens a note, downloading its history first if this device does not have it.
   *
   * Opening a vault no longer brings the notes themselves with it, so this is where the bytes for
   * one note are fetched - instantly when they are already cached, which is the common case. The
   * text is only read after `ensureNote` resolves: reading it earlier would mean showing an empty
   * document over a note that exists, and the autosave would then write that emptiness down.
   */
  const openNote = useCallback(
    async (noteId: string) => {
      // Two notes opened in quick succession must not have their text land out of order. Only the
      // most recent request is allowed to set state.
      const request = openRequest.current + 1;
      openRequest.current = request;

      setOpening(noteId);
      setPreviewVersion(null);
      // Picking a note is the point of the drawer, so it gets out of the way once you have.
      setNavOpen(false);

      try {
        await store.ensureNote(noteId);
        if (openRequest.current !== request) {
          return;
        }

        setSelected(noteId);
        rememberNote(vault.id, noteId);
        applyEditor(opened(store, noteId));
      } catch (e: unknown) {
        if (openRequest.current === request) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (openRequest.current === request) {
          setOpening(null);
        }
      }
    },
    [store, vault.id, applyEditor],
  );

  /**
   * Brings the editor into line with the store after new versions arrive - from another device, or
   * from the pull that follows opening a cached vault. Both are the same question: the note under
   * the editor moved, and what is on screen may or may not have moved with it.
   *
   * What that question is answered *with* is `services/noteSync.ts`, which is where the fork
   * detection and the three-way merge live and where they can be tested.
   */
  const reconcileNote = useCallback(async () => {
    const noteId = selectedRef.current;
    if (!noteId) {
      return;
    }

    await reconcile(store, noteId, editorAccess);
  }, [store, editorAccess]);

  useEffect(() => {
    store.onChanged = refresh;
    return () => {
      store.onChanged = null;
    };
  }, [store]);

  useEffect(() => {
    let live = true;

    /**
     * Where this device left off, as long as that note still exists - it can have been deleted on
     * another device since, and an id that no longer names anything opens nothing at all.
     */
    const reopenLast = async () => {
      const notes = store.listNotes();
      const remembered = lastNoteIn(vault.id);
      const reopen = notes.find((note) => note.id === remembered) ?? notes[0];
      if (reopen) {
        await openNote(reopen.id);
      }
    };

    /**
     * Two stages, because the first one is usually instant and the second one is a network call.
     * A vault this device has seen before draws from its own copy immediately; the pull that
     * follows is a delta, and anything it brings is reconciled the same way a live edit from
     * another device is. A vault it has not seen waits for the pull, which is metadata only.
     */
    void (async () => {
      try {
        const warm = await store.hydrate();
        if (!live) {
          return;
        }

        if (warm) {
          setLoading(false);
          refresh();
          await reopenLast();
        }

        await store.pull();
        if (!live) {
          return;
        }

        refresh();
        if (warm) {
          await reconcileNote();
        } else {
          setLoading(false);
          await reopenLast();
        }
      } catch (e: unknown) {
        if (live) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    })();

    return () => {
      live = false;
    };
  }, [store, openNote, reconcileNote, vault.id]);

  /**
   * Another device changed this vault.
   *
   * The rows travel with the notification, so the ordinary case needs no request at all: absorb
   * them, redraw, and merge into the editor. `absorb` says whether it is certain nothing was missed
   * - if the cursors do not join up, something happened while this socket was away and only a pull
   * can say what.
   */
  const handleRemoteChange = useCallback(
    async (event: SyncEvent) => {
      try {
        const complete = await store.absorb(event);
        if (!complete) {
          await store.pull();
        }
        refresh();
        await reconcileNote();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [store, reconcileNote],
  );

  /**
   * This device can reach the server again. Pull what it missed, merge it with whatever is in the
   * editor, and send anything that could not be sent while it was gone - in that order.
   *
   * The order is the point. Saving first would parent the new version on a head this device only
   * believes is current, which is a fork; pulling first is what lets the same edit become a child
   * of what actually happened. See `resync` in `services/noteSync.ts`.
   */
  const handleReconnect = useCallback(async () => {
    try {
      await resync(store, selectedRef.current, editorAccess);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [store, editorAccess]);

  useEffect(() => {
    const socket = new SyncSocket({
      onChange: (event) => {
        if (event.vaultId === vault.id) {
          void handleRemoteChange(event);
        }
      },
      onPresence: setPresence,
      onReopen: () => void handleReconnect(),
    });
    socket.connect();
    socketRef.current = socket;

    // The socket is the better signal - it knows the server answered, not merely that the OS
    // thinks there is a network - but it can take its backoff to notice, and `online` fires the
    // moment a laptop lid opens. Both end in `resync`, which does nothing when there is nothing to
    // catch up on.
    const online = () => void handleReconnect();
    window.addEventListener("online", online);

    return () => {
      socket.close();
      socketRef.current = null;
      window.removeEventListener("online", online);
    };
  }, [vault.id, handleRemoteChange, handleReconnect]);

  // Tell the account's other devices what this one is looking at. The socket remembers it and says
  // it again after a reconnect, so this only has to fire when the answer changes.
  useEffect(() => {
    socketRef.current?.watch(vault.id, selected);
  }, [vault.id, selected]);

  // Autosave. Every pause in typing that actually changed something becomes a version.
  useEffect(() => {
    if (!selected || !unsaved(store, selected, editorRef.current)) {
      return;
    }

    const timer = window.setTimeout(() => {
      void (async () => {
        // The editor is read by `commit` itself, at the moment the timer fires and again when the
        // server answers - what is written is never a state from before the request went out.
        await commit(store, selected, editorAccess);
        refresh();
      })();
    }, AUTOSAVE_MS);

    return () => window.clearTimeout(timer);
    // `editor.text` rather than `editor`: a save that only changed the indicator must not restart
    // the timer, or a note that failed to save would re-attempt on a loop of its own making. It is
    // also what re-arms the timer for a keystroke made while the last save was in flight, which
    // `commit` leaves as unsent rather than swallowing.
  }, [editor.text, selected, store, editorAccess]);

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
      await openNote(note.id);
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
        applyEditor(EMPTY_EDITOR);
      }
    });

  const removeFolder = (path: string) =>
    attempt(async () => {
      const inside = store.notesUnder(path).map((note) => note.id);
      await store.deleteFolder(path);
      if (selected !== null && inside.includes(selected)) {
        setSelected(null);
        applyEditor(EMPTY_EDITOR);
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
      applyEditor({
        ...editorRef.current,
        baseline: store.headOf(selected),
        mergeParent: null,
        status: "saved",
        error: null,
      });
    });

  const restore = async (version: NoteVersion) => {
    if (!selected) {
      return;
    }
    try {
      await store.restore(selected, version.id);
      applyEditor(opened(store, selected));
      setPreviewVersion(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /**
   * Whether another of this account's devices has *this* note open.
   *
   * Deliberately not "how many": one other device and three are the same fact to someone deciding
   * whether their next sentence is going to meet somebody else's. A count would be a number nobody
   * acts on, taking room on a bar that is short of it.
   */
  const openElsewhere =
    selected !== null && presence.some((entry) => entry.noteId === selected);

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
            className={`save-state ${editor.status}`}
            aria-live="polite"
            title={editor.status === "error" ? (editor.error ?? undefined) : undefined}
          >
            <span className="save-dot" aria-hidden="true" />
            {SAVE_LABEL[editor.status]}
          </span>
        </div>
      </header>

      {/* A refused save says its piece here as well as in the indicator, because the indicator has
          room for two words. Being offline does not: it is temporary, the edit is safely on the
          device, and a banner for it would be there for the whole of a train journey. */}
      {(error ?? (editor.status === "error" ? editor.error : null)) && (
        <p className="error banner">
          {error ?? editor.error}
        </p>
      )}
      {conflicted && (
        <p className="warning banner">
          This note was edited in two places at once. Where the versions clashed
          you will find both of them below - keep the one you want, or edit them
          together by hand. Either way the result saves normally.
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
                ref={filterInput}
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && filter !== "") {
                    // Escape empties the field rather than reaching whatever else
                    // is listening for it; the field is what has focus.
                    event.stopPropagation();
                    setFilter("");
                  }
                }}
                placeholder="Filter"
                aria-label="Filter notes"
                spellCheck={false}
              />

              {/* Only there when there is something to clear - a permanent X on an
                  empty field is a control that does nothing. Clearing puts the caret
                  back in the field, because the next thing anyone does is type. */}
              {filter !== "" && (
                <button
                  className="icon"
                  title="Clear filter"
                  aria-label="Clear filter"
                  onClick={() => {
                    setFilter("");
                    filterInput.current?.focus();
                  }}
                >
                  <CloseIcon size={14} />
                </button>
              )}
            </div>

            {loading && <p className="muted small">Loading...</p>}

            <NoteTree
              collapse={collapse}
              nodes={tree}
              selectedId={selected}
              filter={filter}
              onClearFilter={() => setFilter("")}
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
          ) : opening !== null ? (
            /* Its history is being fetched. Instant when this device already has it, which is the
               usual case - so this shows up on a note being read here for the first time. */
            <div className="empty">
              <h2>Opening {store.titleOf(opening)}...</h2>
              <p className="muted">Fetching this note and decrypting it on your device.</p>
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
                  {/* One control in two states, like the table's Text/Table button: a version is
                      either the change it made or the note it left behind, and both readings are
                      worth having. */}
                  <div
                    className="segmented"
                    role="group"
                    aria-label="How to read this version"
                  >
                    <button
                      className={asDiff ? "ghost on" : "ghost"}
                      aria-pressed={asDiff}
                      onClick={() => chooseDiff(true)}
                    >
                      Changes
                    </button>
                    <button
                      className={asDiff ? "ghost" : "ghost on"}
                      aria-pressed={!asDiff}
                      onClick={() => chooseDiff(false)}
                    >
                      Whole note
                    </button>
                  </div>
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
                {preview.loading ? (
                  <p className="muted small">Downloading this version...</p>
                ) : !asDiff || !previewTexts ? (
                  <MarkdownPreview
                    text={safeMaterialise(store, previewVersion.id)}
                  />
                ) : previewTexts.previous === null ? (
                  <>
                    <p className="muted small">
                      The version before this one cannot be rebuilt, so there is
                      nothing to compare against. This is the whole note.
                    </p>
                    <MarkdownPreview text={previewTexts.current} />
                  </>
                ) : (
                  <>
                    {previewVersion.mergeParentId && (
                      <p className="muted small">
                        This save merged two versions. The changes are shown
                        against the one this device already had.
                      </p>
                    )}
                    <VersionDiff
                      previous={previewTexts.previous}
                      current={previewTexts.current}
                    />
                  </>
                )}
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
                    {openElsewhere && (
                      <span
                        className="presence"
                        title="This note is open on another of your devices. Edits from it arrive here as they are saved, and are merged into what you are writing."
                      >
                        <span className="presence-dot" aria-hidden="true" />
                        <span className="wide-only">Open elsewhere</span>
                      </span>
                    )}
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
