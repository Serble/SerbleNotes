/**
 * The app's only door to the Rust core. Nothing else in the client is allowed to do crypto, produce
 * a diff or merge two versions - if it isn't exposed here, it belongs in the crate, not in TypeScript.
 */
import init, {
  KdfParams,
  apply_diff,
  archive_path,
  derive_key,
  file_name,
  generate_salt,
  generate_vault_key,
  make_diff,
  merge3,
  normalise_path,
  note_name_from_archive_path,
  open as coreOpen,
  oversized_segments,
  parent_path,
  replay as coreReplay,
  reparent as coreReparent,
  rewrap_vault_key,
  seal as coreSeal,
} from '@core';

import type { StoredKdfParams } from '../types';

let ready: Promise<void> | null = null;

/** Loads the WASM module. Safe to call repeatedly; the work happens once. */
export function initCore(): Promise<void> {
  const pending = ready ?? init().then(() => undefined);
  ready = pending;
  return pending;
}

// Development only, and stripped from any build. The WASM instance lives inside this module, so a
// hot swap hands the app a fresh copy of it with nothing loaded, and the next call into the core
// dies with "Cannot read properties of undefined (reading '__wbindgen_free')" - which names neither
// HMR nor the core. Reloading the page is the only correct way to update this module.
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    import.meta.hot?.invalidate();
  });
}

/**
 * The core reports failures as plain strings so it can compile natively as well as to WASM. Turning
 * them into real Errors here means the rest of the app can just use try/catch normally.
 */
function call<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export const DEFAULT_KDF: StoredKdfParams = {
  memoryKib: 64 * 1024,
  iterations: 3,
  parallelism: 1,
};

function paramsFor(stored: StoredKdfParams): KdfParams {
  return new KdfParams(stored.memoryKib, stored.iterations, stored.parallelism);
}

export function newVaultKey(): string {
  return call(() => generate_vault_key());
}

export function newSalt(): string {
  return call(() => generate_salt());
}

/** Stretches a vault password into the key that wraps the vault key. Never leaves this device. */
export function deriveKey(password: string, saltB64: string, stored: StoredKdfParams): string {
  const params = paramsFor(stored);
  try {
    return call(() => derive_key(password, saltB64, params));
  } finally {
    // wasm-bindgen objects hold WASM memory that the JS GC doesn't track.
    params.free();
  }
}

/** New stored material for a vault after its password changed. The key itself is unchanged. */
export interface RewrappedKey {
  /** The vault key, unwrapped - the same one as before, so nothing needs re-encrypting. */
  key: string;
  wrappedKey: string;
  salt: string;
}

/**
 * Changes a vault password. The old password is verified by unwrapping with it, which is the only
 * check there can be: the server holds a blob it cannot open and has nothing to compare against.
 *
 * `newParams` is passed separately so a change can also raise the KDF cost on a vault made under
 * weaker settings.
 */
export function rewrapVaultKey(
  wrappedKey: string,
  oldPassword: string,
  oldSalt: string,
  oldStored: StoredKdfParams,
  newPassword: string,
  newStored: StoredKdfParams,
): RewrappedKey {
  const oldParams = paramsFor(oldStored);
  const newParams = paramsFor(newStored);
  try {
    const result = call(() =>
      rewrap_vault_key(wrappedKey, oldPassword, oldSalt, oldParams, newPassword, newParams),
    );
    try {
      return { key: result.key, wrappedKey: result.wrapped_key, salt: result.salt };
    } finally {
      result.free();
    }
  } finally {
    oldParams.free();
    newParams.free();
  }
}

export function seal(keyB64: string, plaintext: string): string {
  return call(() => coreSeal(keyB64, plaintext));
}

export function open(keyB64: string, blobB64: string): string {
  return call(() => coreOpen(keyB64, blobB64));
}

export function makeDiff(previous: string, current: string): string {
  return call(() => make_diff(previous, current));
}

export function applyDiff(previous: string, diff: string): string {
  return call(() => apply_diff(previous, diff));
}

export function replay(snapshot: string, diffs: string[]): string {
  return call(() => coreReplay(snapshot, JSON.stringify(diffs)));
}

export interface MergeResult {
  text: string;
  conflicted: boolean;
}

/** Three-way merge. A conflict comes back as text with markers in it - never a silent winner. */
export function merge(ancestor: string, ours: string, theirs: string): MergeResult {
  const outcome = call(() => merge3(ancestor, ours, theirs));
  try {
    return { text: outcome.text, conflicted: outcome.conflicted };
  } finally {
    outcome.free();
  }
}

// --- note paths ---------------------------------------------------------------------------------
// Folders are not stored anywhere; they are read out of note names. These functions decide what the
// tree looks like, and the FUSE filesystem will call the same ones, so the two can never disagree.

/** Tidies a name the user typed. Throws only for names no filesystem could hold. */
export function normalisePath(raw: string): string {
  return call(() => normalise_path(raw));
}

/** The folder part of a path, or '' for a note at the top level. */
export function parentPath(path: string): string {
  return call(() => parent_path(path));
}

/** The note's own name, without its folders. */
export function fileName(path: string): string {
  return call(() => file_name(path));
}

/** Segments too long for a real filesystem. Reported to the user, never used to refuse a name. */
export function oversizedSegments(path: string): string[] {
  return call(() => oversized_segments(path));
}

/** Recomputes a note's path when the folder it lives in is renamed or moved. */
export function reparent(path: string, oldParent: string, newParent: string): string {
  return call(() => coreReparent(path, oldParent, newParent));
}

/**
 * Where a note lives inside an exported archive, and where the filesystem will show it: the whole
 * note name, with `.md` on the end. A note called `todo.md` becomes `todo.md.md`, which is what
 * makes the mapping reversible - see the crate for why that matters more than how it looks.
 */
export function archivePath(name: string): string {
  return call(() => archive_path(name));
}

/** Reverses `archivePath`: the note name a file in an archive is asking to become. */
export function noteNameFromArchivePath(path: string): string {
  return call(() => note_name_from_archive_path(path));
}
