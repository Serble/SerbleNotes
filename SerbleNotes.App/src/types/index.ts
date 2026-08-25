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
  /** Sealed name including folder path. */
  name: string;
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

/**
 * What the server tells a client before it has a session - today just the Serble application id the
 * sign-in URL is built from. See the backend's ConfigController.
 */
export interface ClientConfig {
  /** OAuth `client_id` for this deployment. Empty when the server has not been configured with one. */
  serbleAppId: string;
}

export interface ChangesResponse {
  vaultId: string;
  cursor: number;
  notes: Note[];
  versions: NoteVersion[];
}

/** One of this account's devices, and the note it has open. */
export interface PresenceEntry {
  deviceId: string;
  /** Null when that device is in the vault but has no note open. */
  noteId: string | null;
}

/**
 * What comes down the sync socket.
 *
 * A change carries the rows that changed, ciphertext included, so the device on the other end can
 * show the edit without a round trip of its own - see `VaultStore.absorb` for why that is safe to
 * trust and what happens when it cannot be.
 */
export interface SyncEvent {
  kind: 'change' | 'presence' | 'pong';
  vaultId: string;
  cursor: number;
  originDeviceId: string | null;
  notes: Note[];
  versions: NoteVersion[];
  present: PresenceEntry[];
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
