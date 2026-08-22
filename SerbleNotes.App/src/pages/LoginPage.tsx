import { useState } from 'react';
import { LogoIcon } from '../components/Icons';
import { beginLogin } from '../services/auth';
import { isNative, serverMissing } from '../services/platform';

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

        {notice && <p className="muted small notice">{notice}</p>}

        {/* Not something the user can answer: the address is compiled in, so an empty one is a
            build that was made without VITE_API_BASE_URL. Say that rather than asking them. */}
        {serverMissing() && (
          <p className="error">
            This build has no server address in it. It was built without VITE_API_BASE_URL, so it
            has nowhere to sign in to.
          </p>
        )}

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
