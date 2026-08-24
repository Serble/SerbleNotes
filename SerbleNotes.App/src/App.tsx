import { useEffect, useReducer, useState } from 'react';
import { AuthCallback } from './pages/AuthCallback';
import { LoginPage } from './pages/LoginPage';
import { VaultPage } from './pages/VaultPage';
import { VaultsPage } from './pages/VaultsPage';
import { initCore } from './core';
import { api, getToken, onSessionChanged, onSessionExpired } from './services/api';
import { completeLoginFromUrl } from './services/auth';
import { isNative } from './services/platform';
import { forgetLastVault, lastVaultOpened, rememberVault } from './services/settings';
import type { Vault } from './types';

/** Redirect URLs already exchanged, so a repeated delivery is ignored rather than re-used. */
const handledLinks = new Set<string>();

export default function App() {
  const [coreReady, setCoreReady] = useState(false);
  const [coreError, setCoreError] = useState<string | null>(null);
  const [openVault, setOpenVault] = useState<Vault | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Whether the app is still working out where it left off. Read once, at mount: a vault is
  // reopened when the app starts, not every time the session changes underneath it. Starting as
  // false when there is nothing to restore is what keeps the ordinary path free of an extra frame.
  const [restoring, setRestoring] = useState(
    () =>
      getToken() !== null &&
      lastVaultOpened() !== null &&
      // A sign-in coming back through /auth/callback has its own page to render, and the vault it
      // lands on is whatever the app decides once there is a session.
      !(!isNative() && window.location.pathname === '/auth/callback'),
  );

  // Signing in or out changes no state of ours, only what is in storage, so this is what redraws.
  const [, sessionChanged] = useReducer((count: number) => count + 1, 0);

  useEffect(() => {
    // Nothing in the app can read a note before the Rust core is loaded, so this gate comes first.
    initCore()
      .then(() => setCoreReady(true))
      .catch((e: unknown) => setCoreError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (!restoring) {
      return;
    }

    const id = lastVaultOpened();
    if (id === null) {
      setRestoring(false);
      return;
    }

    // The vault is fetched rather than taken from the list, because the list is not needed to draw
    // it and this is the first screen. Anything at all going wrong here - the vault deleted from
    // another device, no network, a token the server no longer likes - falls back to the vault
    // list, which says its own piece about why. Nothing is forgotten on the way: a vault that could
    // not be reached today is still where this device was, and `forgetVault` clears the id on the
    // one occasion it is known to be meaningless.
    api
      .getVault(id)
      .then(setOpenVault)
      .catch(() => undefined)
      .finally(() => setRestoring(false));
  }, []);

  useEffect(() => {
    // Ctrl-S offers to save the page as an HTML file, which for this app is the empty shell the
    // client boots from - the note is not in it, and would not be readable if it were. There is
    // nothing for the keystroke to mean either: an edit is written 1.2s after it is typed, so a
    // note is already saved by the time anybody reaches for it. So it is swallowed rather than
    // given a job. Capturing, so it never reaches a text box or the editor's own keymap.
    const swallowSave = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
      }
    };

    window.addEventListener('keydown', swallowSave, true);
    return () => window.removeEventListener('keydown', swallowSave, true);
  }, []);

  useEffect(() => {
    onSessionChanged(sessionChanged);

    // The token has already been cleared by the time this fires; all that is left is to stop
    // rendering a vault the server will no longer talk to, and say why.
    onSessionExpired(() => {
      setOpenVault(null);
      setSessionExpired(true);
    });
  }, []);

  useEffect(() => {
    if (!isNative()) {
      return;
    }

    // The native clients come back from Serble through the operating system rather than through a
    // page load: the browser hands the redirect to whoever registered the scheme, and that is us.
    // Two ways in, because the app may already be running or may be started by the link itself.
    let stop: (() => void) | undefined;
    let cancelled = false;

    const arrive = (urls: string[] | null) => {
      for (const url of urls ?? []) {
        // The same redirect can arrive twice: once as the event, once from getCurrent, and twice
        // again because StrictMode runs this effect twice in development. An OAuth code is single
        // use, so exchanging it a second time races two account creations and burns the code - the
        // sign-in that worked reports an error. Module-level, because it has to outlive the remount.
        if (handledLinks.has(url)) {
          continue;
        }
        handledLinks.add(url);

        completeLoginFromUrl(url).catch((e: unknown) =>
          setLoginError(e instanceof Error ? e.message : String(e)),
        );
      }
    };

    void import('@tauri-apps/plugin-deep-link')
      .then(async (deepLink) => {
        arrive(await deepLink.getCurrent());
        const unlisten = await deepLink.onOpenUrl(arrive);
        if (cancelled) {
          unlisten();
        } else {
          stop = unlisten;
        }
      })
      .catch((e: unknown) => setLoginError(e instanceof Error ? e.message : String(e)));

    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  if (coreError) {
    return (
      <div className="centred">
        <div className="card hero">
          <h1>Could not start</h1>
          <p className="error">The encryption module failed to load: {coreError}</p>
        </div>
      </div>
    );
  }

  if (!coreReady || restoring) {
    return (
      <div className="centred">
        <p className="muted">Loading...</p>
      </div>
    );
  }

  // Only the web client has pages to be on. A native shell always starts at the app itself.
  if (!isNative() && window.location.pathname === '/auth/callback') {
    return <AuthCallback />;
  }

  if (!getToken()) {
    return (
      <LoginPage
        notice={sessionExpired ? 'Your session ended. Please sign in again.' : null}
        error={loginError}
      />
    );
  }

  if (openVault) {
    return (
      <VaultPage
        vault={openVault}
        onBack={() => {
          // Going back to the list is the user saying that is where they want to start next time.
          forgetLastVault();
          setOpenVault(null);
        }}
      />
    );
  }

  return (
    <VaultsPage
      onOpenVault={(vault) => {
        rememberVault(vault.id);
        setOpenVault(vault);
      }}
    />
  );
}
