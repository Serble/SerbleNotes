import { randomId } from './ids';
import { apiUrl } from './platform';
import type {
  ChangesResponse,
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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Device-Id': deviceId(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

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
  authenticate: (code: string) =>
    request<{ accessToken: string }>('/account', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),

  me: () => request<NotesUser>('/account'),

  listVaults: () => request<Vault[]>('/vaults'),

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

  changes: (vaultId: string, since: number) =>
    request<ChangesResponse>(`/vaults/${vaultId}/changes?since=${since}`),

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
