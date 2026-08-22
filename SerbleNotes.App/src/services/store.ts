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
import type { Note, NoteVersion, Vault } from '../types';
import { api, type NewVersion } from './api';
import { randomId } from './ids';

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

const EMPTY_FOLDER_KEY = 'serblenotes.emptyFolders.';

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

  constructor(readonly vault: Vault, private readonly key: string) {
    this.emptyFolders = loadEmptyFolders(vault.id);
  }

  /** Pulls everything that changed since our cursor. Also the initial load, with a cursor of 0. */
  async pull(): Promise<void> {
    const changes = await api.changes(this.vault.id, this.cursor);

    for (const version of changes.versions) {
      this.versions.set(version.id, version);
    }
    for (const note of changes.notes) {
      this.notes.set(note.id, note);
    }

    this.cursor = Math.max(this.cursor, changes.cursor);
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
      diffs.push(current.payload);
      current = current.parentId ? this.versions.get(current.parentId) : undefined;
    }

    if (!current) {
      throw new Error('This history is missing a snapshot and cannot be rebuilt.');
    }

    const snapshot = open(this.key, current.payload);
    diffs.reverse();
    const text = replay(snapshot, diffs.map((diff) => open(this.key, diff)));

    this.materialised.set(versionId, text);
    return text;
  }

  textOf(noteId: string): string {
    const head = this.headOf(noteId);
    return head ? this.materialise(head) : '';
  }

  /**
   * A note's full path, decrypted. Notes written before names existed fall back to their first line,
   * which is what used to stand in for a title.
   */
  pathOf(noteId: string): string {
    const note = this.notes.get(noteId);
    if (!note) {
      return 'Untitled';
    }

    if (note.name) {
      try {
        return open(this.key, note.name);
      } catch {
        return 'Unreadable name';
      }
    }

    return this.derivedTitle(noteId);
  }

  /** The note's own name without its folders - what the sidebar and the title bar show. */
  titleOf(noteId: string): string {
    return fileName(this.pathOf(noteId));
  }

  /** The folder a note is filed in, or '' for the top level. */
  folderOf(noteId: string): string {
    return parentPath(this.pathOf(noteId));
  }

  private derivedTitle(noteId: string): string {
    let text: string;
    try {
      text = this.textOf(noteId);
    } catch {
      return 'Unreadable note';
    }

    const firstLine = text.split('\n').find((line) => line.trim().length > 0);
    if (!firstLine) {
      return 'Untitled';
    }
    return firstLine.replace(/^#+\s*/, '').slice(0, 80);
  }

  /**
   * Builds the folder tree out of the note names. Folders sort before notes and both sort by name,
   * so the sidebar reads like a directory listing - which is exactly what it will be once the
   * filesystem mounts the same vault.
   */
  tree(): TreeNode[] {
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

    return sort(root.children);
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
    this.versions.set(version.id, version);
    this.materialised.set(version.id, text);

    const note = this.notes.get(version.noteId);
    if (note) {
      this.notes.set(note.id, { ...note, headVersionId: version.id, updatedAt: version.createdAt });
    }

    this.cursor = Math.max(this.cursor, version.cursor);
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

  /** Restoring writes the old text forward as a new version - history is never rewritten. */
  async restore(noteId: string, versionId: string): Promise<void> {
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
    this.notes.set(note.id, note);
    this.cursor = Math.max(this.cursor, note.cursor);

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
      this.notes.set(noteId, { ...note, deleted: true });
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
  exportEntries(): {
    notes: { name: string; text: string }[];
    unreadable: { name: string; reason: string }[];
  } {
    const notes: { name: string; text: string }[] = [];
    const unreadable: { name: string; reason: string }[] = [];
    const used = new Set<string>();

    for (const note of this.listNotes()) {
      const name = this.pathOf(note.id);

      // Two notes cannot share a path, so this only happens when a name would not decrypt and
      // `pathOf` fell back to standing in for it. Writing both would put one on top of the other.
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
