/**
 * The handful of places where running inside a Tauri shell differs from running in a browser tab.
 *
 * There is one build of the client, and it decides at runtime which it is. Two builds would mean two
 * things to keep in step, and the difference is small enough not to be worth that: where the API
 * lives, where the OAuth redirect comes back to, and where an unlocked vault key is kept.
 */

/**
 * Tauri injects this before any of our code runs, on every platform it supports. Sniffing for it is
 * how the official API detects itself, and it works the same in the Android WebView as on desktop.
 */
export function isNative(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

const SERVER_KEY = 'serblenotes.serverUrl';

/** Compiled in from `.env` if it is set there. Empty on a plain web build, which wants same-origin. */
const BUILT_IN = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

/**
 * Tidies a server address into an origin. Accepts what someone would actually type - "notes.example"
 * or "notes.example/" - and assumes https, because a plaintext address is not something to guess on
 * the user's behalf.
 */
export function normaliseServer(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed === '') {
    return '';
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  // Throws for anything that is not a URL at all, which the caller turns into a message.
  const url = new URL(withScheme);
  return url.origin;
}

/** The address the user set on this device, if any. */
export function storedServer(): string {
  try {
    return localStorage.getItem(SERVER_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setStoredServer(origin: string): void {
  try {
    if (origin === '') {
      localStorage.removeItem(SERVER_KEY);
    } else {
      localStorage.setItem(SERVER_KEY, origin);
    }
  } catch {
    // Nowhere to remember it. The address still works for this session.
  }
}

/**
 * Where the API lives. An empty string means "wherever this page came from", which is right for the
 * web client and impossible for a native one - see `needsServer`.
 */
export function apiOrigin(): string {
  return storedServer() || BUILT_IN;
}

/**
 * Whether the page was served by something that can answer `/api` itself.
 *
 * True for the web client, and also true for `tauri dev`, where the window loads from the Vite
 * server and that server proxies the API. False for a packaged app, which loads from the app's own
 * asset protocol - `tauri://localhost`, or `http://tauri.localhost` on Windows and Android, which is
 * why the hostname matters and not just the scheme.
 */
function servedByServer(): boolean {
  if (!isNative()) {
    return true;
  }

  const { protocol, hostname } = window.location;
  return (protocol === 'http:' || protocol === 'https:') && hostname !== 'tauri.localhost';
}

/**
 * A packaged native client that has not been told which server to talk to cannot do anything at
 * all, so the sign-in screen asks first. The web client is never in this position: it was served by
 * the server it is going to call.
 */
export function needsServer(): boolean {
  return !servedByServer() && apiOrigin() === '';
}

/** Absolute URL for an API path, same-origin-relative on the web. */
export function apiUrl(path: string): string {
  return `${apiOrigin()}/api${path}`;
}

/** The sync socket's URL, which is the API origin with the scheme swapped. */
export function socketUrl(path: string): string {
  const origin = apiOrigin();
  if (origin === '') {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/api${path}`;
  }
  return `${origin.replace(/^http/, 'ws')}/api${path}`;
}

/**
 * Where Serble sends the user back to after they sign in.
 *
 * On the web that is a page in this app. A native app has no pages and no origin worth redirecting
 * to, so it registers a URL scheme with the operating system and gets handed the whole URL instead.
 * Serble checks the redirect against the list on the app registration, so the scheme below has to be
 * listed there too - see CLAUDE.md.
 */
export const NATIVE_SCHEME = 'serblenotes';

export function redirectUri(): string {
  return isNative() ? `${NATIVE_SCHEME}://auth/callback` : `${window.location.origin}/auth/callback`;
}
