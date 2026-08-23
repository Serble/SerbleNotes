/**
 * The vault as this device last saw it, kept in IndexedDB so opening it again is a delta rather
 * than a download.
 *
 * What is stored is exactly what the server sent: sealed note names and ciphertext payloads. **No
 * plaintext is ever written here.** A cache of decrypted notes would undo the thing the whole
 * design exists for - the vault key would still be needed to read the server's copy, and not to
 * read this one. Everything below is the same bytes the server holds, which is why keeping them is
 * no weaker than the sync that fetched them.
 *
 * Two rules make it safe to trust on the next open:
 *
 * - **The cursor moves in the same transaction as the rows it describes.** IndexedDB transactions
 *   are atomic, so a write that fails half way leaves the old cursor with the old rows. A cursor
 *   ahead of its rows would be unrecoverable: the next delta pull would skip the versions in
 *   between and the note would be missing history nobody would think to ask for again.
 * - **Every failure is survivable.** Private windows, a webview with storage disabled, a browser
 *   over quota: all of them throw, and all of them end up here as "no cache", which costs a full
 *   download and nothing else. Nothing in the app waits on this succeeding.
 */

import type { Note, NoteVersion } from '../types';

const DB_NAME = 'serblenotes';
const DB_VERSION = 1;
const NOTES = 'notes';
const VERSIONS = 'versions';
const VAULTS = 'vaults';

export interface CachedVault {
  cursor: number;
  notes: Note[];
  versions: NoteVersion[];
}

/** What one write puts in: rows, and the cursor they bring the vault up to. */
export interface CacheWrite {
  notes?: Note[];
  versions?: NoteVersion[];
  /** Left out by a body fetch, which adds ciphertext to versions already accounted for. */
  cursor?: number;
}

let database: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (database) {
    return database;
  }

  database = new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(NOTES)) {
          db.createObjectStore(NOTES, { keyPath: 'id' }).createIndex('vaultId', 'vaultId');
        }
        if (!db.objectStoreNames.contains(VERSIONS)) {
          db.createObjectStore(VERSIONS, { keyPath: 'id' }).createIndex('vaultId', 'vaultId');
        }
        if (!db.objectStoreNames.contains(VAULTS)) {
          db.createObjectStore(VAULTS, { keyPath: 'vaultId' });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

  return database;
}

function promise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Everything this device holds for a vault, or null if it holds nothing it can trust. */
export async function readVault(vaultId: string): Promise<CachedVault | null> {
  try {
    const db = await open();
    if (!db) {
      return null;
    }

    const tx = db.transaction([NOTES, VERSIONS, VAULTS], 'readonly');
    const [notes, versions, meta] = await Promise.all([
      promise(tx.objectStore(NOTES).index('vaultId').getAll(vaultId)),
      promise(tx.objectStore(VERSIONS).index('vaultId').getAll(vaultId)),
      promise(tx.objectStore(VAULTS).get(vaultId)),
    ]);

    const cursor = (meta as { cursor?: unknown } | undefined)?.cursor;
    if (typeof cursor !== 'number' || !Number.isFinite(cursor) || cursor < 0) {
      // No cursor, or one that is not a number: the rows cannot be placed in the sync order, so
      // they are not usable as a starting point. Pull the vault from the beginning instead.
      return null;
    }

    return { cursor, notes: notes as Note[], versions: versions as NoteVersion[] };
  } catch {
    return null;
  }
}

/**
 * Adds rows, and moves the cursor if one is given, in a single transaction.
 *
 * Resolves either way: a device that cannot store this still has everything in memory, and the
 * only cost of the write failing is that the next open downloads again.
 */
export async function writeChanges(vaultId: string, change: CacheWrite): Promise<void> {
  try {
    const db = await open();
    if (!db) {
      return;
    }

    const tx = db.transaction([NOTES, VERSIONS, VAULTS], 'readwrite');
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });

    for (const note of change.notes ?? []) {
      tx.objectStore(NOTES).put(note);
    }
    for (const version of change.versions ?? []) {
      tx.objectStore(VERSIONS).put(version);
    }
    if (change.cursor !== undefined) {
      tx.objectStore(VAULTS).put({ vaultId, cursor: change.cursor });
    }

    await done;
  } catch {
    // Out of quota, storage disabled, or the transaction was aborted. The cursor and the rows fail
    // together, so what is stored still describes one consistent point in the vault's history.
  }
}

/** Forgets a vault entirely - used when it is deleted, so its ciphertext does not outlive it. */
export async function dropVault(vaultId: string): Promise<void> {
  try {
    const db = await open();
    if (!db) {
      return;
    }

    const tx = db.transaction([NOTES, VERSIONS, VAULTS], 'readwrite');
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });

    for (const store of [NOTES, VERSIONS] as const) {
      const keys = await promise(tx.objectStore(store).index('vaultId').getAllKeys(vaultId));
      for (const key of keys) {
        tx.objectStore(store).delete(key);
      }
    }
    tx.objectStore(VAULTS).delete(vaultId);

    await done;
  } catch {
    // Nothing to do: the rows are unreadable without the vault key, which is forgotten with it.
  }
}
