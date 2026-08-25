import { randomId } from './ids';
import { apiUrl } from './platform';
import type {
  ChangesResponse,
  ClientConfig,
  Note,
  NoteVersion,
  NotesUser,
  Vault,
} from '../types';

const TOKEN_KEY = 'serblenotes.token';
const DEVICE_KEY = 'serblenotes.deviceId';

/**
 * Identifies this device so the server can tell us which sync events are the echo of our own writes.
 * It is not a secret and never leaves the account.
 */
export function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = randomId();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  sessionChangedHandler?.();
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  sessionChangedHandler?.();
}

/**
 * Signing in and out are not always a page navigation. On the web they were - the OAuth callback
 * replaced the location - but a native client never leaves the page it is on, so whoever is drawing
 * the app has to be told the token changed.
 */
let sessionChangedHandler: (() => void) | null = null;

export function onSessionChanged(handler: () => void): void {
  sessionChangedHandler = handler;
}

/**
 * A 401 on a request we sent a token with means that token is dead: expired, or issued for an
 * account the server no longer has. Nothing the app tries next can succeed, so the token is dropped
 * and the app is told to show the login page. Without this it sits on a dead credential and every
 * action fails with the same unexplained error.
 */
let sessionExpiredHandler: (() => void) | null = null;

export function onSessionExpired(handler: () => void): void {
  sessionExpiredHandler = handler;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * How long to wait for the server before deciding it is not there.
 *
 * A connection that has gone away does not refuse requests, it swallows them: the phone keeps the
 * socket open, the TCP retries run their course, and `fetch` sits there for minutes without either
 * succeeding or failing. That is what "stuck on Saving" was - not a bug in what the client did with
 * a failure, but a failure that never arrived. Nothing above this can tell the difference between a
 * slow server and an absent one, so the difference has to be decided here.
 *
 * Generous on purpose. Everything the client sends is a small JSON body - a diff, a sealed name -
 * so twenty seconds is far beyond a slow-but-working connection, and the cost of being wrong is
 * small now: the edit is kept as a draft and sent again when the connection comes back.
 */
const TIMEOUT_MS = 20000;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();

  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      // `init.signal` wins if a caller brought its own, so this can never take one away.
      signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': deviceId(),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch {
    // `fetch` rejects with "Failed to fetch" for everything from no network to DNS to a refused
    // connection, and that sentence tells the user nothing they can act on. Status 0 because there
    // is no response: nothing reached the server, so nothing it says can be reported.
    //
    // A timeout lands here too, and deliberately reads the same way: from the caller's point of
    // view a server that never answered and a server that could not be reached are one situation,
    // and both are retried when the connection comes back.
    throw new ApiError(
      'Could not reach the server. This device may be offline, or the server may be down.',
      0,
    );
  }

  if (!response.ok) {
    if (response.status === 401 && token) {
      clearToken();
      sessionExpiredHandler?.();
    }

    // The backend puts a user-facing sentence in `message`; fall back to something readable if it
    // ever doesn't (a proxy error page, say).
    let message = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      if (body?.message) {
        message = body.message;
      }
    } catch {
      // Body wasn't JSON - the status-based message is the best we have.
    }
    throw new ApiError(message, response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export const api = {
  /**
   * The settings the sign-in screen needs, which the client is not built with. Anonymous, so it is
   * the one call that works before there is a token.
   */
  config: () => request<ClientConfig>('/config'),

  authenticate: (code: string) =>
    request<{ accessToken: string }>('/account', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),

  me: () => request<NotesUser>('/account'),

  listVaults: () => request<Vault[]>('/vaults'),

  /**
   * One vault. Used to reopen the vault this device was last in without waiting for the whole list,
   * and it is what checks that the remembered vault is still there.
   */
  getVault: (id: string) => request<Vault>(`/vaults/${id}`),

  createVault: (body: {
    name: string;
    encrypted: boolean;
    wrappedKey: string;
    kdfSalt: string | null;
    kdfParams: string | null;
  }) => request<Vault>('/vaults', { method: 'POST', body: JSON.stringify(body) }),

  changeVaultPassword: (
    id: string,
    body: { wrappedKey: string; kdfSalt: string; kdfParams: string },
  ) => request<Vault>(`/vaults/${id}/password`, { method: 'PUT', body: JSON.stringify(body) }),

  deleteVault: (id: string) => request<void>(`/vaults/${id}`, { method: 'DELETE' }),

  /**
   * The sync read path. `bodies` is false for everything that opens or refreshes a vault: the tree
   * is drawn from note names, so the payloads - which are almost all of the bytes - are fetched per
   * note by `noteVersions` when one is actually read.
   */
  changes: (vaultId: string, since: number, bodies = false) =>
    request<ChangesResponse>(`/vaults/${vaultId}/changes?since=${since}&bodies=${bodies}`),

  /** Every version of one note, ciphertext included. */
  /**
   * A note's whole version history. Only the fallback for a chain that cannot be worked out locally
   * - the ordinary path is `noteVersionsByIds`, which fetches the ten or so versions a note actually
   * needs to open.
   */
  noteVersions: (noteId: string) => request<NoteVersion[]>(`/notes/${noteId}/versions`),

  /** Named versions of one note, for a client that already knows which ciphertext it is missing. */
  noteVersionsByIds: (noteId: string, ids: string[]) =>
    request<NoteVersion[]>(`/notes/${noteId}/versions?ids=${ids.map(encodeURIComponent).join(',')}`),

  createNote: (
    vaultId: string,
    body: { id: string; name: string; initialVersion: NewVersion },
  ) => request<Note>(`/vaults/${vaultId}/notes`, { method: 'POST', body: JSON.stringify(body) }),

  renameNote: (id: string, sealedName: string) =>
    request<Note>(`/notes/${id}/name`, {
      method: 'PUT',
      body: JSON.stringify({ name: sealedName }),
    }),

  deleteNote: (id: string) => request<void>(`/notes/${id}`, { method: 'DELETE' }),

  createVersion: (noteId: string, body: NewVersion) =>
    request<NoteVersion>(`/notes/${noteId}/versions`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

export interface NewVersion {
  id: string;
  parentId: string | null;
  mergeParentId: string | null;
  isSnapshot: boolean;
  isNamed: boolean;
  payload: string;
  label: string | null;
}
