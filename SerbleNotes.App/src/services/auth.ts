import { api, clearToken, setToken } from './api';
import { isNative, redirectUri } from './platform';

const SERBLE_OAUTH_URL = 'https://serble.net/oauth/authorize';
const STATE_KEY = 'serblenotes.oauthState';

/**
 * The Serble application id, asked of the server rather than compiled in.
 *
 * The backend already had it - the token exchange it does sends the same id, paired with the secret
 * only it holds - so building it into the client as well meant one value in two places, and a
 * deployment pointed at a different Serble app was two changes rather than one. It is not a secret:
 * it travels in the query string of every sign-in.
 *
 * Remembered for the session, because a native client can come back to the sign-in screen without
 * reloading. A failed request is deliberately not remembered - it is usually a connection that was
 * not there yet, and the next press of the button should try again rather than repeat the error.
 */
let appIdRequest: Promise<string> | null = null;

async function serbleAppId(): Promise<string> {
  appIdRequest ??= api.config().then((config) => config.serbleAppId);
  try {
    return await appIdRequest;
  } catch (e) {
    appIdRequest = null;
    throw e;
  }
}

/**
 * Serble refuses a state that contains anything but letters and digits, so this is hex rather than a
 * UUID - a UUID's hyphens come back as "invalid-state" instead of a login.
 */
function newState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Serble login gates access to the vaults at all. It is deliberately independent of the encryption:
 * an account gets you the ciphertext, and only a vault password turns that into readable notes.
 *
 * The web client navigates away and comes back to /auth/callback. A native client cannot do that -
 * it has no pages - so it hands the URL to the system browser and waits for the operating system to
 * hand the redirect back through the app's registered scheme. Signing in through the real browser,
 * rather than a webview the app controls, is also the point: the app never sees the Serble password.
 */
export async function beginLogin(): Promise<void> {
  const appId = await serbleAppId();
  if (!appId) {
    throw new Error('This server has no Serble application id configured, so there is nothing to sign in to.');
  }

  const state = newState();
  sessionStorage.setItem(STATE_KEY, state);

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: 'user_info',
    state,
  });
  const url = `${SERBLE_OAUTH_URL}?${params.toString()}`;

  if (!isNative()) {
    window.location.href = url;
    return;
  }

  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}

/** Trades the code Serble handed back for this backend's own token. */
export async function completeLogin(code: string, state: string | null): Promise<void> {
  const expected = sessionStorage.getItem(STATE_KEY);
  if (expected && state && expected !== state) {
    throw new Error('Login state did not match. Please try signing in again.');
  }
  sessionStorage.removeItem(STATE_KEY);

  const { accessToken } = await api.authenticate(code);
  setToken(accessToken);
}

/**
 * A URL the operating system handed to the app. Only the sign-in redirect means anything to us;
 * anything else is ignored rather than treated as an error, because another app, or the user, can
 * put any URL through a registered scheme.
 */
export async function completeLoginFromUrl(raw: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  const code = url.searchParams.get('code');
  if (!code) {
    return false;
  }

  await completeLogin(code, url.searchParams.get('state'));
  return true;
}

export function logout(): void {
  clearToken();
  if (isNative()) {
    // There is no page to navigate to; the app re-renders into the signed-out state on its own.
    return;
  }
  window.location.href = '/';
}
