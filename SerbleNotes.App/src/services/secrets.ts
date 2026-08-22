import { isNative } from './platform';

/**
 * Where an unlocked vault key is kept on this device.
 *
 * In a browser tab there is nowhere better than local storage, with the caveat that anything with
 * script access to the origin can read it. A native client has somewhere better - the OS keychain on
 * desktop, the app's private storage on Android - and that is most of the reason those clients
 * exist. The shell owns that; this is the door to it.
 *
 * Nothing here ever holds a password. A key arrives already derived and unwrapped by the Rust core,
 * from a password that never left the editor.
 */

const WEB_PREFIX = 'serblenotes.vaultKey.';

/** Read through: what the store answered, so a second vault open does not wait on IPC again. */
const cache = new Map<string, string | null>();

/** Set when the device's keychain refused to work, so the UI can say so instead of pretending. */
let unavailable: string | null = null;

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

let invoking: Promise<Invoke> | null = null;

function invoke(): Promise<Invoke> {
  // Loaded on demand so the web build never ships the Tauri bindings at all.
  invoking ??= import('@tauri-apps/api/core').then((module) => module.invoke as Invoke);
  return invoking;
}

/**
 * Why the keychain is not being used, if it is not. Null means keys are being stored properly - or
 * that this is the web client, where local storage is the documented arrangement rather than a
 * failure.
 */
export function storageWarning(): string | null {
  return unavailable;
}

/** Which store the keys are in. Used to tell the user the truth, never to reassure them. */
export async function storageBackend(): Promise<'keychain' | 'app-storage' | 'browser'> {
  if (!isNative() || unavailable !== null) {
    return 'browser';
  }
  try {
    return await (await invoke())<'keychain' | 'app-storage'>('secret_backend');
  } catch {
    return 'browser';
  }
}

export async function getSecret(id: string): Promise<string | null> {
  const known = cache.get(id);
  if (known !== undefined) {
    return known;
  }

  let value: string | null = null;
  if (isNative() && unavailable === null) {
    try {
      value = await (await invoke())<string | null>('secret_get', { id });
    } catch (e) {
      // A keychain that cannot be read is not a reason to refuse to open the vault: the user can
      // still type the password. It is a reason to stop pretending the key is being remembered.
      unavailable = e instanceof Error ? e.message : String(e);
      value = null;
    }
  } else if (!isNative()) {
    value = readWeb(id);
  }

  cache.set(id, value);
  return value;
}

export async function setSecret(id: string, value: string): Promise<void> {
  cache.set(id, value);

  if (!isNative()) {
    writeWeb(id, value);
    return;
  }
  if (unavailable !== null) {
    return;
  }

  try {
    await (await invoke())('secret_set', { id, value });
  } catch (e) {
    unavailable = e instanceof Error ? e.message : String(e);
  }
}

export async function deleteSecret(id: string): Promise<void> {
  cache.delete(id);

  if (!isNative()) {
    try {
      localStorage.removeItem(WEB_PREFIX + id);
    } catch {
      // Nothing to remove.
    }
    return;
  }
  if (unavailable !== null) {
    return;
  }

  try {
    await (await invoke())('secret_delete', { id });
  } catch (e) {
    unavailable = e instanceof Error ? e.message : String(e);
  }
}

function readWeb(id: string): string | null {
  try {
    return localStorage.getItem(WEB_PREFIX + id);
  } catch {
    return null;
  }
}

function writeWeb(id: string, value: string): void {
  try {
    localStorage.setItem(WEB_PREFIX + id, value);
  } catch {
    // Private browsing, or storage full. The key still works for this session.
  }
}
