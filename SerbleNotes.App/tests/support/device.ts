/**
 * One device: a `VaultStore`, plus the small amount of editor state the workspace keeps beside it.
 *
 * Everything here is the client that ships. The reconcile decision, the save, the draft and the
 * resync all come from `services/noteSync.ts`, and the store, the crypto and the diffing are the
 * real ones - only the network is `fakeServer.ts`. What this class adds is the two things a browser
 * provides and node does not: a note being open in an editor, and a network connection that can be
 * taken away.
 *
 * It used to transcribe `reconcile` and the autosave out of `VaultPage.tsx`, which meant these
 * tests checked a copy rather than the code. Both moved into `services/` when the bugs they
 * describe were fixed, which is what makes the suite worth running.
 */
import './storage';

import {
  commit,
  opened,
  reconcile,
  resync,
  typed,
  unsaved,
  type EditorState,
} from '../../src/services/noteSync';
import { VaultStore } from '../../src/services/store';
import type { SyncEvent, Vault } from '../../src/types';
import { setOffline } from './fakeServer';

export function newVault(id = 'vault-1'): Vault {
  return {
    id,
    name: 'Test vault',
    encrypted: true,
    wrappedKey: '',
    kdfSalt: null,
    kdfParams: null,
    cursor: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  } as unknown as Vault;
}

export class Device {
  readonly store: VaultStore;

  editor: EditorState = {
    text: '',
    baseline: null,
    mergeParent: null,
    conflicted: false,
    status: 'saved',
    error: null,
  };

  /** Which note the editor has open. */
  selected: string | null = null;

  private connected = true;

  constructor(vault: Vault, key: string, readonly name = 'device') {
    this.store = new VaultStore(vault, key);
  }

  /**
   * Whether this device can reach the server.
   *
   * The store has no notion of a device, so this is applied to the fake server around each call -
   * which models exactly what it says: for the duration of this device's request, the network is
   * down. Setting it back to true is a reconnection, and a reconnection is an event the app acts
   * on, so it does here too. In the browser that is the sync socket reopening and the `online`
   * event; both call `resync`, as this does.
   */
  get online(): boolean {
    return this.connected;
  }

  set online(value: boolean) {
    const returned = value && !this.connected;
    this.connected = value;
    if (returned) {
      this.pendingResync = this.resync();
    }
  }

  /** The reconnect that `online = true` started, so a test can await it. */
  private pendingResync: Promise<void> = Promise.resolve();

  settled(): Promise<void> {
    return this.pendingResync;
  }

  private async net<T>(work: () => Promise<T>): Promise<T> {
    setOffline(!this.connected);
    try {
      return await work();
    } finally {
      setOffline(false);
    }
  }

  // --- the store --------------------------------------------------------------------------------

  pull(): Promise<void> {
    return this.net(() => this.store.pull());
  }

  createNote(path: string, text: string) {
    return this.net(() => this.store.createNote(path, text));
  }

  ensureNote(noteId: string): Promise<void> {
    return this.net(() => this.store.ensureNote(noteId));
  }

  rename(noteId: string, path: string): Promise<void> {
    return this.net(() => this.store.renameNote(noteId, path));
  }

  deleteNote(noteId: string): Promise<void> {
    return this.net(() => this.store.deleteNote(noteId));
  }

  restore(noteId: string, versionId: string): Promise<void> {
    return this.net(() => this.store.restore(noteId, versionId));
  }

  head(noteId?: string): string | null {
    return this.store.headOf(noteId ?? this.selected!);
  }

  text(noteId?: string): string {
    return this.store.textOf(noteId ?? this.selected!);
  }

  // --- the editor -------------------------------------------------------------------------------

  /** `VaultPage.openNote`: the bytes first, then the text - never the other way round. */
  async open(noteId: string): Promise<void> {
    await this.ensureNote(noteId);
    this.selected = noteId;
    this.editor = opened(this.store, noteId);
  }

  /** Someone typed. The autosave has not run yet. */
  type(text: string): void {
    this.editor = typed(this.editor, text);
  }

  /** The autosave, with its debounce collapsed to "now". */
  async autosave(): Promise<void> {
    this.editor = await this.net(() => commit(this.store, this.selected!, this.editor));
  }

  /** The sync socket said the vault moved, and this device had to ask what changed. */
  async remoteChange(): Promise<void> {
    await this.pull();
    if (this.selected) {
      this.editor = await this.net(() => reconcile(this.store, this.selected!, this.editor));
    }
  }

  /**
   * A change arrived over the socket, rows and all - the live path.
   *
   * Mirrors `handleRemoteChange` in `VaultPage`: absorb, fall back to a pull when the cursors do
   * not join up, then reconcile. No `net` around `absorb`, because nothing about it is a request.
   */
  async pushed(event: SyncEvent): Promise<void> {
    const complete = await this.store.absorb(event);
    if (!complete) {
      await this.pull();
    }
    if (this.selected) {
      this.editor = await this.net(() => reconcile(this.store, this.selected!, this.editor));
    }
  }

  /** The network came back: catch up, merge, and send whatever was being held. */
  async resync(): Promise<void> {
    this.editor = await this.net(() => resync(this.store, this.selected, this.editor));
  }

  unsaved(): boolean {
    return unsaved(this.store, this.selected!, this.editor);
  }
}

/**
 * Whether `candidate` is `ancestor`, or descends from it, worked out from the note's history rather
 * than from the store's own index.
 *
 * `VaultStore.descendsFrom` answers the same question and is what the client uses. This is written
 * separately and from public data on purpose: a test that called the function under test to decide
 * whether the function under test was right would assert nothing at all.
 */
export function descendsFrom(
  store: VaultStore,
  noteId: string,
  candidate: string,
  ancestor: string,
): boolean {
  const byId = new Map(store.historyOf(noteId).map((version) => [version.id, version]));
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

    const version = byId.get(id);
    for (const parent of [version?.parentId, version?.mergeParentId]) {
      if (parent) {
        queue.push(parent);
      }
    }
  }

  return false;
}
