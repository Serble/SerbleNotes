import { DEFAULT_KDF, deriveKey, newSalt, newVaultKey, open, rewrapVaultKey, seal } from '../core';
import { deleteSecret, getSecret, setSecret } from './secrets';
import type { StoredKdfParams, Vault } from '../types';

/**
 * Unlocked vault keys are cached per device, which is what makes "enter the password once per
 * device" work. Where they are cached depends on the client - the OS keychain in the desktop and
 * Android apps, local storage on the web - and either way they never go to the server. See
 * services/secrets.ts.
 *
 * These are async because a keychain is. The web client could answer immediately, but having two
 * shapes of the same function is how the two clients start to drift apart.
 */
export function cachedKey(vaultId: string): Promise<string | null> {
  return getSecret(vaultId);
}

export function rememberKey(vaultId: string, key: string): Promise<void> {
  return setSecret(vaultId, key);
}

export function forgetKey(vaultId: string): Promise<void> {
  return deleteSecret(vaultId);
}

function kdfParamsOf(vault: Vault): StoredKdfParams {
  if (!vault.kdfParams) {
    return DEFAULT_KDF;
  }
  return JSON.parse(vault.kdfParams) as StoredKdfParams;
}

/**
 * The key for a vault, or null when it needs a password first.
 *
 * For an unencrypted vault the stored "wrapped" key is simply the key: the server can read it, and
 * therefore the server can read the notes. That is the documented trade-off of that vault type, not
 * an oversight.
 */
export async function keyFor(vault: Vault): Promise<string | null> {
  if (!vault.encrypted) {
    return vault.wrappedKey;
  }
  return cachedKey(vault.id);
}

/** Unwraps the vault key with a password. A wrong password fails as a decryption error. */
export async function unlock(vault: Vault, password: string): Promise<string> {
  if (!vault.kdfSalt) {
    throw new Error('This vault is missing its salt and cannot be unlocked.');
  }

  const wrappingKey = deriveKey(password, vault.kdfSalt, kdfParamsOf(vault));
  const vaultKey = open(wrappingKey, vault.wrappedKey);
  await rememberKey(vault.id, vaultKey);
  return vaultKey;
}

/**
 * Changes a vault's password, wrapping the same vault key under the new one. The old password is
 * checked by being used - there is no other way to check it, and no way for this to succeed without
 * it. A wrong one throws before anything is written anywhere.
 *
 * Nothing in the vault is re-encrypted, because the key has not changed. The caller sends the result
 * to the server; this device is left holding the key either way, which is what lets the password be
 * changed from a device that had not unlocked the vault yet.
 */
export async function changePassword(
  vault: Vault,
  oldPassword: string,
  newPassword: string,
): Promise<{ wrappedKey: string; kdfSalt: string; kdfParams: string }> {
  if (!vault.encrypted) {
    throw new Error('This vault is not encrypted, so it has no password.');
  }
  if (!vault.kdfSalt) {
    throw new Error('This vault is missing its salt and cannot be unlocked.');
  }

  // A change is also the moment to move onto today's cost parameters, whatever the vault was made
  // with. The old ones are still needed to open the existing wrapping.
  const changed = rewrapVaultKey(
    vault.wrappedKey,
    oldPassword,
    vault.kdfSalt,
    kdfParamsOf(vault),
    newPassword,
    DEFAULT_KDF,
  );

  await rememberKey(vault.id, changed.key);

  return {
    wrappedKey: changed.wrappedKey,
    kdfSalt: changed.salt,
    kdfParams: JSON.stringify(DEFAULT_KDF),
  };
}

/**
 * Builds what the server needs to store for a new vault. The key is generated here and, for an
 * encrypted vault, wrapped here - the plaintext key never exists outside this device.
 */
export function newVaultMaterial(password: string | null): {
  key: string;
  encrypted: boolean;
  wrappedKey: string;
  kdfSalt: string | null;
  kdfParams: string | null;
} {
  const key = newVaultKey();

  // `null` means the user chose not to encrypt. An empty string means they chose an empty password,
  // which is a different thing entirely: the vault is still end-to-end encrypted, just badly. A
  // truthiness check here would collapse the two and silently hand the server a readable vault.
  if (password === null) {
    return { key, encrypted: false, wrappedKey: key, kdfSalt: null, kdfParams: null };
  }

  const salt = newSalt();
  const wrappingKey = deriveKey(password, salt, DEFAULT_KDF);

  return {
    key,
    encrypted: true,
    wrappedKey: seal(wrappingKey, key),
    kdfSalt: salt,
    kdfParams: JSON.stringify(DEFAULT_KDF),
  };
}
