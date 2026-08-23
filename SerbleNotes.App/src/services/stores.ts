/**
 * The open vaults, for as long as this session lasts.
 *
 * A `VaultStore` is an expensive thing to throw away: it holds the vault's metadata, the notes it
 * has decrypted names for, and every body fetched so far. Building one per visit meant that going
 * back to the vault list and returning re-downloaded and re-decrypted everything - measured at
 * about 2.8 seconds on a 196-note vault, for a vault the device had finished reading seconds
 * earlier. Keeping it here makes the second visit a delta pull.
 *
 * The key is the vault id *and* the vault key. A store built with one key must never be handed back
 * for a session that unlocked with a different one: the ciphertext would be opened with the wrong
 * key, which fails loudly for a note body but would quietly show the wrong names. Re-locking a
 * vault, changing its password, or signing in as someone else all end up here as a different key,
 * and get a store of their own.
 */

import type { Vault } from '../types';
import { VaultStore } from './store';
import { dropVault } from './vaultCache';

const open = new Map<string, { key: string; store: VaultStore }>();

/** The store for a vault, reused if this session already has one for the same key. */
export function storeFor(vault: Vault, key: string): VaultStore {
  const existing = open.get(vault.id);
  if (existing && existing.key === key) {
    // The vault row itself can have moved on - its cursor and timestamps come with every list -
    // and the store shows its name, so it takes the newer copy.
    existing.store.vault = vault;
    return existing.store;
  }

  const store = new VaultStore(vault, key);
  open.set(vault.id, { key, store });
  return store;
}

/** Forgets a vault's store, and the ciphertext this device kept for it. Used when it is deleted. */
export async function forgetStore(vaultId: string): Promise<void> {
  open.delete(vaultId);
  await dropVault(vaultId);
}

/**
 * Drops every open store, without touching what is on disk.
 *
 * Signing out ends this session's right to talk to the server, not this device's copy of a vault it
 * has already been trusted with - that copy is ciphertext, and the vault key it needs is in the
 * keychain either way. Dropping the stores means nothing decrypted survives the sign-out in memory.
 */
export function forgetAllStores(): void {
  open.clear();
}
