import { useState } from 'react';
import { LogoIcon } from '../components/Icons';
import { beginLogin } from '../services/auth';
import {
  apiOrigin,
  isNative,
  needsServer,
  normaliseServer,
  setStoredServer,
  storedServer,
} from '../services/platform';

export function LoginPage({ notice, error }: { notice?: string | null; error?: string | null }) {
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const signIn = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await beginLogin();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="centred">
      <div className="card hero">
        <span className="hero-mark">
          <LogoIcon size={24} />
        </span>
        <div>
          <h1>Serble Notes</h1>
          <p className="muted small">
            End-to-end encrypted markdown notes, with every version kept.
          </p>
        </div>

        {/* The web client was served by the server it talks to, and so is a `tauri dev` window. A
            packaged app was not, so it has to be told, and there is no sensible default to guess. */}
        {(needsServer() || storedServer() !== '') && <ServerField />}

        {notice && <p className="muted small notice">{notice}</p>}
        <button className="primary full" onClick={() => void signIn()} disabled={busy}>
          {busy ? 'Opening your browser...' : 'Sign in with Serble'}
        </button>

        {isNative() && (
          <p className="muted small">
            Signing in opens your browser. Come back here when Serble sends you on.
          </p>
        )}

        {(failure ?? error) && <p className="error">{failure ?? error}</p>}
      </div>
    </div>
  );
}

function ServerField() {
  const [draft, setDraft] = useState(storedServer());
  const [saved, setSaved] = useState<string>(apiOrigin());
  const [problem, setProblem] = useState<string | null>(null);

  const commit = () => {
    try {
      const origin = normaliseServer(draft);
      setStoredServer(origin);
      setSaved(origin || apiOrigin());
      setDraft(origin);
      setProblem(null);
    } catch {
      setProblem('That does not look like a web address.');
    }
  };

  return (
    <label>
      Server
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
        }}
        placeholder="notes.example.net"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        inputMode="url"
      />
      {problem ? (
        <span className="error small">{problem}</span>
      ) : saved === '' ? (
        <span className="warning small">
          Enter the address of your Serble Notes server to sign in.
        </span>
      ) : (
        <span className="muted small">Signing in to {saved}</span>
      )}
    </label>
  );
}
