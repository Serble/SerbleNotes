import {
  archivePath,
  fileName,
  makeDiff,
  normalisePath,
  open,
  parentPath,
  replay,
  reparent,
  seal,
} from '../core';
import type { Note, NoteVersion, SyncEvent, Vault } from '../types';
import { api, type NewVersion } from './api';
import { randomId } from './ids';
import { readVault, writeChanges } from './vaultCache';

/** A node in the folder tree the sidebar draws. Folders are derived from names, never stored. */
export interface TreeNode {
  /** Full path of this node. */
  path: string;
  /** Just this node's own name. */
  name: string;
  /** Set for notes, absent for folders. */
  noteId?: string;
  children: TreeNode[];
}

/** How many diffs to allow before writing a full snapshot, so replaying history stays cheap. */
const SNAPSHOT_EVERY = 10;

/** How many note bodies to fetch at once when something genuinely needs all of them. */
const ENSURE_CONCURRENCY = 6;

/**
 * How many version ids to name in one request.
 *
 * A chain is `SNAPSHOT_EVERY` long in the ordinary case, so this is never reached by opening a note.
 * It is here because the ids travel in the URL, and a history that somehow has no snapshot for a
 * long way back would otherwise build a request too long to send. The server refuses more than 200.
 */
const IDS_PER_REQUEST = 40;

const EMPTY_FOLDER_KEY = 'serblenotes.emptyFolders.';

/**
 * Where an edit the server has not accepted is kept, so closing the app does not destroy it.
 *
 * Saving is otherwise write-through - only a version the server acknowledged reaches `vaultCache` -
 * which meant an edit made on a train lived in React state and nowhere else. That is the one place
 * this app could lose something with no copy anywhere, so it is the one place worth a device-local
 * store of its own.
 *
 * **What is written is sealed with the vault key, exactly like everything else.** A draft is note
 * content; the rule that the device cache holds ciphertext and never plaintext does not stop
 * applying because the note has not been saved yet.
 *
 * localStorage rather than IndexedDB: a draft is one small value per open note that has to be
 * readable synchronously while the editor is being set up, which is what the empty-folder list next
 * to it needs too. The cost is the quota - a draft of a very large note can fail to write, and does
 * so silently, leaving the app exactly where it was before any of this existed.
 */
const DRAFT_KEY = 'serblenotes.draft.';

function draftKey(vaultId: string, noteId: string): string {
  return `${DRAFT_KEY}${vaultId}.${noteId}`;
}

/**
 * Folders are read out of note names, so a folder with nothing in it has nothing to be read out of.
 * Rather than give the server folder records - the second structure this design exists to avoid, and
 * the one that can drift out of step with the first - a folder you have just made is remembered here
 * on this device until something is filed into it. It draws in the tree, notes can be dropped onto
 * it, and it is forgotten once a note gives it a real existence. If it is still empty when this
 * browser's storage is cleared it is gone, and nothing is lost with it: an empty folder holds no
 * data, and the same is true of `mkdir` on a filesystem that has not been written to yet.
 */
function loadEmptyFolders(vaultId: string): Set<string> {
  try {
    const raw = localStorage.getItem(EMPTY_FOLDER_KEY + vaultId);
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set<string>();
  }
}

function saveEmptyFolders(vaultId: string, folders: Set<string>): void {
  try {
    localStorage.setItem(EMPTY_FOLDER_KEY + vaultId, JSON.stringify([...folders]));
  } catch {
    // Private browsing, or storage full. The folder still works for this session.
  }
}

/**
 * The ciphertext of a version, or a refusal.
 *
 * A version whose body has not been downloaded is not an empty one, and the difference matters more
 * here than anywhere else in the client: text is what the next autosave diffs against, so treating
 * "not here yet" as "" would write a diff that deletes the note and store it as the truth. Callers
 * reach this only by skipping `ensureNote`, which is a bug - so it throws rather than guessing.
 */
function bodyOf(version: NoteVersion): string {
  if (version.payload == null) {
    throw new Error('This note is still downloading. Give it a moment and try again.');
  }
  return version.payload;
}

/**
 * The client-side model of one vault: its notes, their version DAG, and the decryption that turns
 * the server's opaque blobs into text. This is local-first - every read below is answered from
 * memory, and the network only ever adds to it.
 */
export class VaultStore {
  private notes = new Map<string, Note>();
  private versions = new Map<string, NoteVersion>();
  private materialised = new Map<string, string>();
  private emptyFolders: Set<string>;
  cursor = 0;

  /**
   * Decrypted paths, kept against the sealed name they came from so a rename invalidates its own
   * entry. `tree()` asks for every note's path and the workspace re-renders on every keystroke, so
   * without this the vault's names are decrypted a few hundred times a second while someone types.
   */
  private paths = new Map<string, { sealed: string; path: string }>();

  /** Bumped by anything that changes what the tree would draw, so the tree can be reused. */
  private revision = 0;
  private treeCache: { revision: number; nodes: TreeNode[] } | null = null;

  /** Version ids by note, so a note's own versions are not a scan of the whole vault. */
  private versionsByNote = new Map<string, Set<string>>();

  /**
   * In-flight body fetches, keyed by the version whose ciphertext they will bring - so two things
   * wanting the same version wait on one request rather than asking twice. A whole-note fallback is
   * keyed by `note:<id>` in the same map, because it is the same promise to anybody waiting.
   */
  private bodyRequests = new Map<string, Promise<void>>();

  /** Told when something arrives in the background, so the UI can redraw. Set by the workspace. */
  onChanged: (() => void) | null = null;

  constructor(public vault: Vault, private readonly key: string) {
    this.emptyFolders = loadEmptyFolders(vault.id);
  }

  /**
   * Loads what this device already had, and says whether there was anything.
   *
   * The cache holds ciphertext and a cursor written in the same transaction, so it is either a
   * consistent point in the vault's history or absent. Absent costs a pull from zero, which is what
   * every open used to do. A warm store draws immediately and the pull that follows is a delta.
   */
  async hydrate(): Promise<boolean> {
    if (this.notes.size > 0) {
      // Already open in this session - its memory is newer than anything on disk.
      return true;
    }

    const cached = await readVault(this.vault.id);
    if (!cached || cached.notes.length === 0) {
      return false;
    }

    for (const note of cached.notes) {
      this.notes.set(note.id, note);
    }
    for (const version of cached.versions) {
      this.mergeVersion(version);
    }
    this.cursor = cached.cursor;
    this.bump();

    return true;
  }

  /**
   * Pulls everything that changed since our cursor, metadata only.
   *
   * Payloads are the overwhelming majority of a vault's bytes and none of them are needed to draw
   * the tree, so they are left on the server until a note is read - see `ensureNote`. On the vault
   * this was measured against that is 160 KB instead of 6.5 MB, and about 100 ms instead of 1.6 s.
   */
  async pull(): Promise<void> {
    const changes = await api.changes(this.vault.id, this.cursor, false);

    for (const version of changes.versions) {
      this.mergeVersion(version);
    }
    for (const note of changes.notes) {
      this.putNote(note);
    }

    const moved = changes.cursor > this.cursor;
    this.cursor = Math.max(this.cursor, changes.cursor);

    if (changes.notes.length === 0 && changes.versions.length === 0 && !moved) {
      return;
    }

    // The cursor goes in with the rows it accounts for, never on its own.
    await writeChanges(this.vault.id, {
      notes: changes.notes,
      versions: changes.versions.map((version) => this.versions.get(version.id) ?? version),
      cursor: this.cursor,
    });
  }

  /**
   * Takes rows that arrived over the sync socket instead of being asked for.
   *
   * Returns whether this device is now certainly up to date. That is the whole subtlety here, and
   * it is the cursor rule again from the other side: the cursor may only move to a point where
   * *everything* below it has been seen. A pushed event proves one write happened, not that no
   * other write was missed while the socket was away.
   *
   * The proof is contiguity. Every write reserves exactly one cursor value (`IVaultRepo.NextCursor`)
   * and events go to every device, so an unbroken stream arrives with each cursor one higher than
   * the last. If this event follows ours by exactly one, nothing can have happened in between and
   * the cursor is safe to advance. Any other gap means something was missed, and the caller pulls.
   *
   * The rows are kept either way - they are real, and `mergeVersion` never lets a metadata-only row
   * displace ciphertext we already have. Keeping them just means the pull that follows is answered
   * from memory.
   */
  async absorb(event: SyncEvent): Promise<boolean> {
    const contiguous = event.cursor === this.cursor + 1;

    for (const version of event.versions) {
      this.mergeVersion(version);
    }
    for (const note of event.notes) {
      this.putNote(note);
    }

    if (contiguous) {
      this.cursor = event.cursor;
    }

    await writeChanges(this.vault.id, {
      notes: event.notes,
      versions: event.versions.map((version) => this.versions.get(version.id) ?? version),
      // As everywhere else: the cursor goes in only with rows that account for it.
      ...(contiguous ? { cursor: this.cursor } : {}),
    });

    return contiguous;
  }

  /**
   * Stores a version without ever losing ciphertext we already hold.
   *
   * A metadata pull describes versions with `payload: null`. If one of those overwrote a version
   * whose body had already been fetched, the note would silently become unreadable until it was
   * downloaded again - so the payload we have always wins over the absence of one.
   */
  private mergeVersion(version: NoteVersion): void {
    let byNote = this.versionsByNote.get(version.noteId);
    if (!byNote) {
      byNote = new Set<string>();
      this.versionsByNote.set(version.noteId, byNote);
    }
    byNote.add(version.id);

    const existing = this.versions.get(version.id);
    if (existing?.payload != null && version.payload == null) {
      this.versions.set(version.id, { ...version, payload: existing.payload });
      return;
    }

    this.versions.set(version.id, version);
  }

  private putNote(note: Note): void {
    this.notes.set(note.id, note);
    this.bump();
  }

  /** Invalidates everything derived from the notes: the tree, and any path read from a stale name. */
  private bump(): void {
    this.revision += 1;
  }

  /**
   * The versions whose ciphertext is needed to rebuild one version: itself, then back along the
   * parent chain to the nearest snapshot.
   *
   * This is the same walk `materialise` does, and that is the point of it - asking for exactly what
   * that walk will read means never downloading a byte it will not. It is answerable from metadata
   * alone, which this device already has for every version in the vault: opening a vault pulls every
   * parent pointer and snapshot flag with no payloads attached.
   *
   * Null means the walk could not be finished - a parent whose metadata never arrived, or a history
   * with no snapshot at the bottom. The caller falls back to fetching the note whole rather than
   * guessing at a shorter answer, because a chain read one version short rebuilds the wrong document.
   */
  private chainFrom(versionId: string): string[] | null {
    const chain: string[] = [];
    let current = this.versions.get(versionId);

    while (current && !current.isSnapshot) {
      chain.push(current.id);
      current = current.parentId ? this.versions.get(current.parentId) : undefined;
    }

    if (!current) {
      return null;
    }

    chain.push(current.id);
    return chain;
  }

  /**
   * Makes sure these versions can be rebuilt on this device, downloading only what is missing.
   *
   * Everything that turns a version into text goes through here first. `materialise` refuses to work
   * from a version it does not hold rather than inventing one, so the guarantee this provides is what
   * keeps that refusal from being seen: an editor that opened an empty document over a note that
   * exists would be overwritten by the next autosave.
   *
   * Nulls are accepted and ignored, because most callers are passing a head or a parent that may not
   * exist and would otherwise all write the same check.
   */
  async ensureVersions(versionIds: (string | null | undefined)[]): Promise<void> {
    const wanted = new Set<string>();
    const wholeNotes = new Set<string>();

    for (const versionId of versionIds) {
      if (!versionId) {
        continue;
      }

      const version = this.versions.get(versionId);
      if (!version) {
        // Not a version this device has ever heard of. Nothing can be fetched for it and nothing
        // should be guessed; `materialise` says so plainly if anybody goes on to ask for it.
        continue;
      }

      const chain = this.chainFrom(versionId);
      if (chain === null) {
        wholeNotes.add(version.noteId);
        continue;
      }

      for (const id of chain) {
        if (this.versions.get(id)?.payload == null) {
          wanted.add(id);
        }
      }
    }

    const work: Promise<void>[] = [];

    for (const noteId of wholeNotes) {
      work.push(this.fetch(`note:${noteId}`, () => api.noteVersions(noteId)));
    }

    // Anything already being fetched is waited on rather than asked for again, so two panels opening
    // the same version make one request. Grouped by note, because a request names one note's ids and
    // a caller may well have asked about versions of several.
    const outstanding = new Map<string, string[]>();
    for (const id of wanted) {
      const inFlight = this.bodyRequests.get(id);
      if (inFlight) {
        work.push(inFlight);
        continue;
      }

      const noteId = this.versions.get(id)!.noteId;
      const forNote = outstanding.get(noteId) ?? [];
      forNote.push(id);
      outstanding.set(noteId, forNote);
    }

    for (const [noteId, ids] of outstanding) {
      for (let at = 0; at < ids.length; at += IDS_PER_REQUEST) {
        work.push(this.fetchBatch(noteId, ids.slice(at, at + IDS_PER_REQUEST)));
      }
    }

    await Promise.all(work);
  }

  /** One request for a batch of a note's versions, registered against every id it will bring. */
  private async fetchBatch(noteId: string, ids: string[]): Promise<void> {
    const request = (async () => {
      const versions = await api.noteVersionsByIds(noteId, ids);
      for (const version of versions) {
        this.mergeVersion(version);
      }

      // No cursor: these rows are already accounted for by the metadata pull that named them, and
      // moving the cursor for a body fetch would claim to have seen changes this device has not.
      await writeChanges(this.vault.id, { versions });
    })();

    for (const id of ids) {
      this.bodyRequests.set(id, request);
    }

    try {
      await request;
    } finally {
      for (const id of ids) {
        this.bodyRequests.delete(id);
      }
    }
  }

  /** Makes sure a note's current text can be rebuilt. */
  ensureNote(noteId: string): Promise<void> {
    return this.ensureVersions([this.headOf(noteId)]);
  }

  /** Runs one body fetch under a key, keeping it in `bodyRequests` for anyone else who wants it. */
  private async fetch(key: string, get: () => Promise<NoteVersion[]>): Promise<void> {
    const existing = this.bodyRequests.get(key);
    if (existing) {
      return existing;
    }

    const request = (async () => {
      const versions = await get();
      for (const version of versions) {
        this.mergeVersion(version);
      }

      // No cursor: these rows are already accounted for by the metadata pull that named them, and
      // moving the cursor for a body fetch would claim to have seen changes this device has not.
      await writeChanges(this.vault.id, { versions });
    })();

    this.bodyRequests.set(key, request);

    try {
      await request;
    } finally {
      this.bodyRequests.delete(key);
    }
  }

  /** Whether a version can be rebuilt from what this device holds, without asking the network. */
  hasChain(versionId: string | null): boolean {
    if (!versionId) {
      return true;
    }

    const chain = this.chainFrom(versionId);
    return chain !== null && chain.every((id) => this.versions.get(id)?.payload != null);
  }

  /**
   * Every note's body, for the one operation that genuinely needs all of them: writing an archive.
   * Reports progress because on a large vault this is the download that opening one no longer is.
   */
  async ensureAll(onProgress?: (done: number, total: number) => void): Promise<void> {
    const notes = this.listNotes();
    let started = 0;
    let done = 0;

    // A few at a time rather than one after another: these are hundreds of independent requests and
    // doing them in single file spends the whole time waiting for round trips. Bounded because the
    // point is to use the connection, not to open two hundred sockets at once.
    const worker = async () => {
      for (;;) {
        const index = started;
        started += 1;
        if (index >= notes.length) {
          return;
        }

        await this.ensureNote(notes[index].id);
        done += 1;
        onProgress?.(done, notes.length);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(ENSURE_CONCURRENCY, notes.length) }, () => worker()),
    );
  }

  listNotes(): Note[] {
    return [...this.notes.values()].filter((note) => !note.deleted);
  }

  getNote(noteId: string): Note | undefined {
    return this.notes.get(noteId);
  }

  headOf(noteId: string): string | null {
    return this.notes.get(noteId)?.headVersionId ?? null;
  }

  /** Version history for a note, newest first. */
  historyOf(noteId: string): NoteVersion[] {
    return [...this.versions.values()]
      .filter((version) => version.noteId === noteId)
      .sort((a, b) => b.cursor - a.cursor);
  }

  labelOf(version: NoteVersion): string | null {
    return version.label ? open(this.key, version.label) : null;
  }

  /**
   * Reconstructs the document at a version: walk back to the nearest snapshot, then replay the
   * diffs forward. Results are memoised because the editor asks for the head constantly.
   */
  materialise(versionId: string): string {
    const cached = this.materialised.get(versionId);
    if (cached !== undefined) {
      return cached;
    }

    const diffs: string[] = [];
    let current = this.versions.get(versionId);
    if (!current) {
      throw new Error('That version has not been downloaded yet.');
    }

    while (current && !current.isSnapshot) {
      diffs.push(bodyOf(current));
      current = current.parentId ? this.versions.get(current.parentId) : undefined;
    }

    if (!current) {
      throw new Error('This history is missing a snapshot and cannot be rebuilt.');
    }

    const snapshot = open(this.key, bodyOf(current));
    diffs.reverse();
    const text = replay(snapshot, diffs.map((diff) => open(this.key, diff)));

    this.materialised.set(versionId, text);
    return text;
  }

  textOf(noteId: string): string {
    const head = this.headOf(noteId);
    return head ? this.materialise(head) : '';
  }

  /** A note's full path, decrypted. */
  pathOf(noteId: string): string {
    const note = this.notes.get(noteId);
    if (!note) {
      return 'Untitled';
    }

    // Keyed on the sealed name rather than on a revision counter: a rename replaces that string, so
    // an entry can never outlive the name it was decrypted from.
    const cached = this.paths.get(noteId);
    if (cached && cached.sealed === note.name) {
      return cached.path;
    }

    // Every note has a name, so a name that will not open is a damaged one - which is a thing to say
    // plainly. Reading a title out of the body instead, as this used to, meant drawing the tree
    // could download notes nobody had asked to read.
    let path: string;
    try {
      path = open(this.key, note.name);
    } catch {
      path = 'Unreadable name';
    }
    this.paths.set(noteId, { sealed: note.name, path });
    return path;
  }

  /** The note's own name without its folders - what the sidebar and the title bar show. */
  titleOf(noteId: string): string {
    return fileName(this.pathOf(noteId));
  }

  /** The folder a note is filed in, or '' for the top level. */
  folderOf(noteId: string): string {
    return parentPath(this.pathOf(noteId));
  }

  /**
   * Builds the folder tree out of the note names. Folders sort before notes and both sort by name,
   * so the sidebar reads like a directory listing - which is exactly what it will be once the
   * filesystem mounts the same vault.
   */
  tree(): TreeNode[] {
    if (this.treeCache && this.treeCache.revision === this.revision) {
      return this.treeCache.nodes;
    }

    const root: TreeNode = { path: '', name: '', children: [] };

    /** Walks down to a folder, bringing each level into being the first time it is asked for. */
    const folderAt = (folderPath: string): TreeNode => {
      if (folderPath === '') {
        return root;
      }

      const segments = folderPath.split('/');
      let current = root;
      for (let index = 0; index < segments.length; index += 1) {
        const path = segments.slice(0, index + 1).join('/');
        let folder = current.children.find(
          (child) => child.path === path && child.noteId === undefined,
        );
        if (!folder) {
          folder = { path, name: segments[index], children: [] };
          current.children.push(folder);
        }
        current = folder;
      }
      return current;
    };

    for (const note of this.listNotes()) {
      const path = this.pathOf(note.id);
      folderAt(parentPath(path)).children.push({
        path,
        name: fileName(path),
        noteId: note.id,
        children: [],
      });
    }

    // Folders nothing has been filed into yet have no name to be read out of, so they come from
    // this device's own list. See loadEmptyFolders.
    for (const path of this.emptyFolders) {
      folderAt(path);
    }

    const sort = (nodes: TreeNode[]): TreeNode[] => {
      nodes.sort((a, b) => {
        const aIsFolder = a.noteId === undefined;
        const bIsFolder = b.noteId === undefined;
        if (aIsFolder !== bIsFolder) {
          return aIsFolder ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
      for (const node of nodes) {
        sort(node.children);
      }
      return nodes;
    };

    const nodes = sort(root.children);
    this.treeCache = { revision: this.revision, nodes };
    return nodes;
  }

  /** Every folder path in the vault, so the UI can offer them and show empty ones. */
  folders(): string[] {
    const found = new Set<string>();

    for (const note of this.listNotes()) {
      const segments = this.pathOf(note.id).split('/');
      for (let index = 0; index < segments.length - 1; index += 1) {
        found.add(segments.slice(0, index + 1).join('/'));
      }
    }

    for (const path of this.emptyFolders) {
      const segments = path.split('/');
      for (let index = 0; index < segments.length; index += 1) {
        found.add(segments.slice(0, index + 1).join('/'));
      }
    }

    return [...found].sort();
  }

  /**
   * Whether `candidate` is `ancestor`, or descends from it.
   *
   * This is the question that decides whether a new head can simply be adopted. A version that
   * descends from the one the editor is holding contains it - taking it loses nothing. A version
   * that does not is a *sibling*: both devices built on the same parent, and the two edits exist
   * only on their own branches. Adopting one of those silently drops the other, which is the shape
   * of every "it overwrote my edit" report there has ever been about this app.
   *
   * Both parents are followed, so a merge counts as descending from both of the branches it joined
   * and a merged note stops being seen as forked.
   */
  descendsFrom(candidate: string, ancestor: string): boolean {
    const seen = new Set<string>();
    const queue = [candidate];

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (id === ancestor) {
        return true;
      }
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);

      const version = this.versions.get(id);
      if (!version) {
        continue;
      }
      if (version.parentId) {
        queue.push(version.parentId);
      }
      if (version.mergeParentId) {
        queue.push(version.mergeParentId);
      }
    }

    return false;
  }

  /**
   * Walks both ancestries to find where two branches diverged. That version is the base for the
   * three-way merge when two devices edited the same note.
   */
  commonAncestor(a: string, b: string): string | null {
    const seen = new Set<string>();

    const walk = (start: string, visit: (id: string) => boolean): string | null => {
      const queue = [start];
      while (queue.length > 0) {
        const id = queue.shift()!;
        if (visit(id)) {
          return id;
        }
        const version = this.versions.get(id);
        if (!version) {
          continue;
        }
        if (version.parentId) {
          queue.push(version.parentId);
        }
        if (version.mergeParentId) {
          queue.push(version.mergeParentId);
        }
      }
      return null;
    };

    walk(a, (id) => {
      seen.add(id);
      return false;
    });

    return walk(b, (id) => seen.has(id));
  }

  private countSinceSnapshot(versionId: string | null): number {
    let count = 0;
    let current = versionId ? this.versions.get(versionId) : undefined;

    while (current && !current.isSnapshot) {
      count += 1;
      current = current.parentId ? this.versions.get(current.parentId) : undefined;
    }

    return count;
  }

  /** Builds the encrypted version body: a diff most of the time, a full snapshot periodically. */
  private buildVersion(
    parentId: string | null,
    previousText: string,
    text: string,
    options: { forceSnapshot?: boolean; isNamed?: boolean; label?: string; mergeParentId?: string | null } = {},
  ): NewVersion {
    const isSnapshot =
      options.forceSnapshot === true ||
      parentId === null ||
      this.countSinceSnapshot(parentId) >= SNAPSHOT_EVERY;

    const body = isSnapshot ? text : makeDiff(previousText, text);

    return {
      id: randomId(),
      parentId,
      mergeParentId: options.mergeParentId ?? null,
      isSnapshot,
      isNamed: options.isNamed ?? false,
      payload: seal(this.key, body),
      label: options.label ? seal(this.key, options.label) : null,
    };
  }

  private record(version: NoteVersion, text: string): void {
    this.mergeVersion(version);
    this.materialised.set(version.id, text);

    const note = this.notes.get(version.noteId);
    const updated = note
      ? { ...note, headVersionId: version.id, updatedAt: version.createdAt }
      : null;
    if (updated) {
      this.putNote(updated);
    }

    // The cursor deliberately does not move here. This version's own cursor says where *it* landed,
    // not that this device has seen everything below it: another device can hold a lower cursor
    // that we have not pulled. In memory that only cost a re-pull, but the cursor is written to
    // disk now, and one that runs ahead of the rows would make the next delta skip those versions
    // for good. Only `pull` knows it has seen everything up to a point, so only `pull` moves it.
    void writeChanges(this.vault.id, {
      versions: [version],
      notes: updated ? [updated] : [],
    });
  }

  /** Creates a note at a path. The path is sealed before it leaves the device, like the body. */
  async createNote(path: string, text: string): Promise<Note> {
    const note = await this.postNote(path, text);
    // The create response describes the note; re-pulling is how we learn the stored version row.
    await this.pull();

    return note;
  }

  /** The create itself, without the pull. Import does hundreds of these and pulls once at the end. */
  private async postNote(path: string, text: string): Promise<Note> {
    const id = randomId();
    const initialVersion = this.buildVersion(null, '', text, { forceSnapshot: true });
    const name = seal(this.key, normalisePath(path));

    const note = await api.createNote(this.vault.id, { id, name, initialVersion });
    this.notes.set(note.id, note);
    this.materialised.set(initialVersion.id, text);

    return note;
  }

  /** Saves an edit as a new version. Returns null when nothing actually changed. */
  async saveNote(
    noteId: string,
    text: string,
    options: { isNamed?: boolean; label?: string; mergeParentId?: string | null } = {},
  ): Promise<NoteVersion | null> {
    // A note deleted on another device is still a row here, with a head and a readable history, so
    // every part of a save works perfectly and the text lands somewhere nothing can ever show it
    // again: the tree is built from `listNotes`, which filters tombstones out. The user is told
    // their note was saved, and it is gone. Refusing is the only honest answer: this product warns
    // rather than forbids, and the one exception is an accident the user cannot perceive, which is
    // exactly what this is.
    if (this.notes.get(noteId)?.deleted) {
      throw new Error(
        'This note was deleted on another device, so there is nowhere to save to. Copy anything ' +
          'you need out of the editor before closing it.',
      );
    }

    // Before anything is diffed: the base has to be the note's real text, not a version this
    // device happens to be missing. `materialise` would refuse, but refusing mid-save is worse than
    // waiting a moment for the bytes.
    await this.ensureNote(noteId);

    const head = this.headOf(noteId);
    const previousText = head ? this.materialise(head) : '';

    if (text === previousText && !options.isNamed) {
      return null;
    }

    const body = this.buildVersion(head, previousText, text, {
      isNamed: options.isNamed,
      label: options.label,
      mergeParentId: options.mergeParentId,
      // A named restore point is a place someone will come back to, so store it whole rather than as
      // a diff that depends on the rest of the chain surviving.
      forceSnapshot: options.isNamed,
    });

    const version = await api.createVersion(noteId, body);
    this.record(version, text);
    return version;
  }

  // --- unsent edits --------------------------------------------------------------------------

  /**
   * Remembers text the server has not taken yet. Sealed, because it is note content.
   *
   * Called when a save fails rather than on every keystroke: a draft is insurance against the app
   * closing while something is unsent, and writing one per keystroke would seal and stringify the
   * whole note on a 1.2 second timer for the overwhelmingly common case where the save works.
   */
  keepDraft(noteId: string, text: string): void {
    try {
      localStorage.setItem(draftKey(this.vault.id, noteId), seal(this.key, text));
    } catch {
      // Over quota, or storage disabled. Nothing else depends on this having worked, and the app
      // is then no worse off than before drafts existed.
    }
  }

  /** The unsent edit for a note, if this device is holding one. */
  draftOf(noteId: string): string | null {
    try {
      const sealed = localStorage.getItem(draftKey(this.vault.id, noteId));
      return sealed ? open(this.key, sealed) : null;
    } catch {
      // A draft sealed under a different key, or corrupt. It cannot be shown, and throwing here
      // would stop the note opening at all.
      return null;
    }
  }

  dropDraft(noteId: string): void {
    try {
      localStorage.removeItem(draftKey(this.vault.id, noteId));
    } catch {
      // See `keepDraft`.
    }
  }

  /** Every note on this device with an edit the server has not taken. Drives the retry. */
  notesWithDrafts(): string[] {
    const prefix = `${DRAFT_KEY}${this.vault.id}.`;
    try {
      return Object.keys(localStorage)
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length));
    } catch {
      return [];
    }
  }

  /** Restoring writes the old text forward as a new version - history is never rewritten. */
  async restore(noteId: string, versionId: string): Promise<void> {
    // The version being restored and the head the save will diff against - two chains, which may
    // share nothing at all when the restore reaches a long way back.
    await this.ensureVersions([versionId, this.headOf(noteId)]);

    const text = this.materialise(versionId);
    await this.saveNote(noteId, text, { label: undefined });
  }

  // --- names, folders and moves -------------------------------------------------------------
  // Every operation below is a rename underneath, because a note's folder is only the front of its
  // name. None of them creates or destroys a folder record, because there are none to create.

  /** Notes filed in a folder, or anywhere below it. */
  notesUnder(folderPath: string): Note[] {
    return this.listNotes().filter((note) => {
      const parent = parentPath(this.pathOf(note.id));
      return parent === folderPath || parent.startsWith(`${folderPath}/`);
    });
  }

  /** What already lives at a path, if anything. */
  private occupant(path: string, ignoreNoteId?: string): 'note' | 'folder' | null {
    if (this.emptyFolders.has(path)) {
      return 'folder';
    }

    for (const note of this.listNotes()) {
      if (note.id === ignoreNoteId) {
        continue;
      }
      const existing = this.pathOf(note.id);
      if (existing === path) {
        return 'note';
      }
      if (existing.startsWith(`${path}/`)) {
        return 'folder';
      }
    }

    return null;
  }

  /**
   * Two things cannot share a path: the tree could not draw them apart, and a filesystem could not
   * hold them at all. This is the same class of refusal as `normalise_path` rejecting '..' - not a
   * judgement about what the user should want, but about what can be represented.
   */
  private refuseIfTaken(path: string, ignoreNoteId?: string): void {
    const taken = this.occupant(path, ignoreNoteId);
    if (taken !== null) {
      const where = parentPath(path);
      throw new Error(
        `A ${taken} called "${fileName(path)}" is already ${where ? `in "${where}"` : 'at the top level'}.`,
      );
    }
  }

  /**
   * Puts a name inside a folder. The name is tidied on its own before being joined, which is the
   * whole point: normalising "Work/   " as one string quietly collapses to "Work", so a note
   * renamed to nothing would take its own folder's name and jump up a level. Tidying "   " by
   * itself is refused instead, which is what an empty name deserves.
   */
  private join(folder: string, name: string): string {
    const leaf = normalisePath(name);
    return folder === '' ? leaf : `${folder}/${leaf}`;
  }

  private persistFolders(): void {
    this.bump();
    saveEmptyFolders(this.vault.id, this.emptyFolders);
  }

  /**
   * A folder that has just lost its last note is kept, rather than blinking out of the tree the
   * moment something is dragged out of it. A file manager does not delete a directory because you
   * moved a file out of it, and neither does this.
   */
  private keepIfNowEmpty(folderPath: string): void {
    if (folderPath === '' || this.notesUnder(folderPath).length > 0) {
      return;
    }
    this.emptyFolders.add(folderPath);
    this.persistFolders();
  }

  /** Drops local entries for folders that notes now give a real existence to. */
  private pruneFolders(): void {
    let changed = false;
    for (const path of [...this.emptyFolders]) {
      if (this.notesUnder(path).length > 0) {
        this.emptyFolders.delete(path);
        changed = true;
      }
    }
    if (changed) {
      this.persistFolders();
    }
  }

  /** Makes a folder that has nothing in it yet. Local to this device until a note lands in it. */
  createFolder(parentFolder: string, name: string): string {
    const path = this.join(parentFolder, name);
    this.refuseIfTaken(path);
    this.emptyFolders.add(path);
    this.persistFolders();
    return path;
  }

  /**
   * Renames or moves a note. Moving is just renaming: put a different folder in front of the name
   * and it lives somewhere else, with no folder records to keep in step.
   */
  async renameNote(noteId: string, path: string): Promise<void> {
    const tidied = normalisePath(path);
    const previousParent = parentPath(this.pathOf(noteId));

    const note = await api.renameNote(noteId, seal(this.key, tidied));
    this.putNote(note);
    // As in `record`: our own write does not tell us where everyone else's writes are.
    void writeChanges(this.vault.id, { notes: [note] });

    this.keepIfNowEmpty(previousParent);
    this.pruneFolders();
  }

  /** Changes a note's own name and leaves it where it is. */
  async renameNoteTo(noteId: string, name: string): Promise<void> {
    const next = this.join(parentPath(this.pathOf(noteId)), name);
    this.refuseIfTaken(next, noteId);
    await this.renameNote(noteId, next);
  }

  /** Files a note into a different folder, keeping its own name. '' is the top level. */
  async moveNote(noteId: string, targetFolder: string): Promise<void> {
    const path = this.pathOf(noteId);
    const from = parentPath(path);
    if (from === targetFolder) {
      return;
    }

    const next = reparent(path, from, targetFolder);
    this.refuseIfTaken(next, noteId);
    await this.renameNote(noteId, next);
  }

  /** Renames a folder by moving every note underneath it. */
  async renameFolder(oldPath: string, newPath: string): Promise<void> {
    const tidiedNew = newPath.trim() === '' ? '' : normalisePath(newPath);

    for (const note of this.notesUnder(oldPath)) {
      await this.renameNote(note.id, reparent(this.pathOf(note.id), oldPath, tidiedNew));
    }

    // Folders under here that only exist on this device move with it - otherwise renaming a folder
    // would quietly drop the empty ones inside it.
    for (const path of [...this.emptyFolders]) {
      if (path !== oldPath && !path.startsWith(`${oldPath}/`)) {
        continue;
      }
      this.emptyFolders.delete(path);

      const tail = path.slice(oldPath.length).replace(/^\//, '');
      const moved = tidiedNew === '' ? tail : tail === '' ? tidiedNew : `${tidiedNew}/${tail}`;
      if (moved !== '') {
        this.emptyFolders.add(moved);
      }
    }

    this.keepIfNowEmpty(parentPath(oldPath));
    this.persistFolders();
    this.pruneFolders();
  }

  /** Changes a folder's own name and leaves it where it is. */
  async renameFolderTo(folderPath: string, name: string): Promise<void> {
    const next = this.join(parentPath(folderPath), name);
    if (next === folderPath) {
      return;
    }
    this.refuseIfTaken(next);
    await this.renameFolder(folderPath, next);
  }

  /** Moves a folder and everything under it into another folder. '' is the top level. */
  async moveFolder(folderPath: string, targetFolder: string): Promise<void> {
    if (targetFolder === folderPath || targetFolder.startsWith(`${folderPath}/`)) {
      throw new Error('A folder cannot be moved inside itself.');
    }

    const from = parentPath(folderPath);
    if (from === targetFolder) {
      return;
    }

    const next = reparent(folderPath, from, targetFolder);
    this.refuseIfTaken(next);
    await this.renameFolder(folderPath, next);
  }

  async deleteNote(noteId: string): Promise<void> {
    const folder = parentPath(this.pathOf(noteId));
    await api.deleteNote(noteId);
    const note = this.notes.get(noteId);
    if (note) {
      const tombstone = { ...note, deleted: true };
      this.putNote(tombstone);
      void writeChanges(this.vault.id, { notes: [tombstone] });
    }
    this.keepIfNowEmpty(folder);
  }

  /** Deletes a folder and every note in it, at any depth. */
  async deleteFolder(folderPath: string): Promise<void> {
    for (const note of this.notesUnder(folderPath)) {
      await this.deleteNote(note.id);
    }

    for (const path of [...this.emptyFolders]) {
      if (path === folderPath || path.startsWith(`${folderPath}/`)) {
        this.emptyFolders.delete(path);
      }
    }
    this.persistFolders();
  }

  // --- archives -------------------------------------------------------------------------------
  // A vault is a folder of markdown files with real folders in it. That is what export writes, what
  // import reads, and what the filesystem will mount; services/archive.ts turns it into a zip and
  // knows nothing about any of the below.

  /** What is already at a path, so import can say what will clash before it writes anything. */
  occupantOf(path: string): 'note' | 'folder' | null {
    return this.occupant(path);
  }

  /**
   * Every note as it stands now, decrypted. This is the whole of what an archive can hold.
   *
   * A note that cannot be read comes back in `unreadable` rather than stopping the export or, worse,
   * going into the archive as whatever could be salvaged: one broken history must not cost the user
   * the other two hundred notes, and a file full of an error message is not the note it claims to be.
   */
  async exportEntries(onProgress?: (done: number, total: number) => void): Promise<{
    notes: { name: string; text: string }[];
    unreadable: { name: string; reason: string }[];
  }> {
    // The one operation that needs every note. Opening a vault no longer downloads them, so this is
    // where the download happens, with progress - it is the slowest thing the client does.
    await this.ensureAll(onProgress);

    const notes: { name: string; text: string }[] = [];
    const unreadable: { name: string; reason: string }[] = [];
    const used = new Set<string>();

    for (const note of this.listNotes()) {
      const name = this.pathOf(note.id);

      // Two notes cannot share a path, so this only happens when neither name would decrypt and
      // both came back as the same stand-in. Writing both would put one on top of the other.
      if (used.has(name)) {
        unreadable.push({ name, reason: 'Another note is already filed here.' });
        continue;
      }

      try {
        // Both questions at once: can this name be a file at all, and can the note be decrypted.
        archivePath(name);
        notes.push({ name, text: this.textOf(note.id) });
        used.add(name);
      } catch (e) {
        unreadable.push({ name, reason: e instanceof Error ? e.message : String(e) });
      }
    }

    notes.sort((a, b) => a.name.localeCompare(b.name));
    unreadable.sort((a, b) => a.name.localeCompare(b.name));

    return { notes, unreadable };
  }

  /** Folders with nothing in them. They exist only on this device, so an archive is where they go. */
  emptyFolderPaths(): string[] {
    return [...this.emptyFolders].sort();
  }

  /**
   * Writes notes from an archive into the vault.
   *
   * Nothing is overwritten and nothing is merged: a name that is already taken is left alone and
   * reported, because the archive cannot say whether the note in it is a newer version of the one
   * here or a different note that happens to share a name, and guessing wrong destroys the one the
   * user did not choose. Everything else goes in, so one clash does not cost them the other 200.
   */
  async importNotes(
    notes: { name: string; text: string }[],
    folders: string[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ created: number; folders: number; failed: { name: string; reason: string }[] }> {
    const failed: { name: string; reason: string }[] = [];
    let created = 0;

    for (const [index, note] of notes.entries()) {
      try {
        const path = normalisePath(note.name);
        this.refuseIfTaken(path);
        await this.postNote(path, note.text);
        created += 1;
      } catch (e) {
        failed.push({ name: note.name, reason: e instanceof Error ? e.message : String(e) });
      }
      onProgress?.(index + 1, notes.length);
    }

    // Folders come after the notes: one that turned out to hold an imported note is a real folder
    // now and does not belong on this device's list of empty ones.
    let madeFolders = 0;
    for (const folder of folders) {
      try {
        const path = normalisePath(folder);
        if (this.notesUnder(path).length === 0 && this.occupant(path) === null) {
          this.emptyFolders.add(path);
          madeFolders += 1;
        }
      } catch (e) {
        failed.push({ name: folder, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    // A folder this device was only remembering because it was empty has a note in it now.
    this.pruneFolders();
    this.persistFolders();

    if (created > 0) {
      // One pull for the whole import: every note above was created without one.
      await this.pull();
    }

    return { created, folders: madeFolders, failed };
  }
}
