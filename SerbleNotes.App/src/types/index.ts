/** Mirrors SerbleNotes.Backend. Every `payload`/`label` here is ciphertext until the core opens it. */

export interface Vault {
  id: string;
  name: string;
  ownerId: string;
  encrypted: boolean;
  wrappedKey: string;
  kdfSalt: string | null;
  kdfParams: string | null;
  cursor: number;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
}

export interface Note {
  id: string;
  vaultId: string;
  /** Sealed name including folder path. Null on notes written before names existed. */
  name: string | null;
  headVersionId: string | null;
  cursor: number;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
}

export interface NoteVersion {
  id: string;
  noteId: string;
  vaultId: string;
  parentId: string | null;
  mergeParentId: string | null;
  isSnapshot: boolean;
  isNamed: boolean;
  /**
   * Ciphertext, or null when only this version's metadata has been downloaded. Opening a vault asks
   * for metadata alone - see VaultStore.ensureNote - so a version arrives without its body and
   * gains one when the note is read. Anything that turns bytes back into text must treat null as
   * "not here yet" and never as empty.
   */
  payload: string | null;
  label: string | null;
  deviceId: string | null;
  size: number;
  cursor: number;
  createdAt: string;
}

export interface ChangesResponse {
  vaultId: string;
  cursor: number;
  notes: Note[];
  versions: NoteVersion[];
}

export interface SyncEvent {
  vaultId: string;
  cursor: number;
  originDeviceId: string | null;
}

export interface NotesUser {
  id: string;
  username: string;
  isBanned: boolean;
  isAdmin: boolean;
  createdAt: string;
}

/** Argon2id settings, stored on the vault as JSON so they can be raised later. */
export interface StoredKdfParams {
  memoryKib: number;
  iterations: number;
  parallelism: number;
}
