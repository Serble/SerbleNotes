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

/**
 * Where the API lives for a native client, compiled in from `.env` at build time
 * (`VITE_API_BASE_URL`). Empty on a web build, which talks to its own origin.
 *
 * This is a build-time decision on purpose. A packaged app is built for the server it belongs to,
 * so asking the person using it to type an address made them answer a question the build already
 * knew the answer to - and a typo there looked like a broken app rather than a wrong address.
 */
const BUILT_IN = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

/**
 * Whether the page was served by something that can answer `/api` itself.
 *
 * True for the web client, and for `tauri dev` on the desktop, where the window loads from the Vite
 * server and that server proxies the API. False for a packaged app, and false for `tauri android
 * dev` too: Android serves the dev server through the app's own asset protocol, so the page comes
 * from `http://tauri.localhost` and there is no proxy behind it. That is why the hostname matters
 * and not just the scheme.
 */
function servedByServer(): boolean {
  if (!isNative()) {
    return true;
  }

  const { protocol, hostname } = window.location;
  return (protocol === 'http:' || protocol === 'https:') && hostname !== 'tauri.localhost';
}

/**
 * Where the API lives. An empty string means "wherever this page came from".
 *
 * The web client is always same-origin - it was served by the server it is going to call, and a
 * build-time address would only be a way to get that wrong.
 */
export function apiOrigin(): string {
  return isNative() ? BUILT_IN : '';
}

/**
 * A native build with no address compiled in and nothing serving it can reach no server at all.
 * There is nothing the person using it can do about that, so the app says what is wrong rather
 * than asking them to fix it: it is the build that is incomplete, not their input.
 */
export function serverMissing(): boolean {
  return isNative() && BUILT_IN === '' && !servedByServer();
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
 * listed there too, or sign-in fails with `redirect-uri-mismatch` before the consent screen.
 */
export const NATIVE_SCHEME = 'serblenotes';

export function redirectUri(): string {
  return isNative() ? `${NATIVE_SCHEME}://auth/callback` : `${window.location.origin}/auth/callback`;
}
