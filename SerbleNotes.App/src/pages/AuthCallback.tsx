import { useEffect, useRef, useState } from 'react';
import { completeLogin } from '../services/auth';

export function AuthCallback() {
  const [error, setError] = useState<string | null>(null);

  // StrictMode runs effects twice in development, and an OAuth code is single use - exchanging it
  // twice races two account creations against each other and burns the code. The guard is a ref
  // rather than state because it has to survive the second invocation without a re-render.
  const exchangeStarted = useRef(false);

  useEffect(() => {
    if (exchangeStarted.current) {
      return;
    }
    exchangeStarted.current = true;

    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');

    if (!code) {
      setError('Serble did not send a login code back.');
      return;
    }

    completeLogin(code, params.get('state'))
      .then(() => window.location.replace('/'))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div className="centred">
      <div className="card hero">
        {error ? (
          <>
            <h1>Sign in failed</h1>
            <p className="error">{error}</p>
            <button className="primary" onClick={() => window.location.replace('/')}>
              Back to sign in
            </button>
          </>
        ) : (
          <>
            <h1>Signing you in...</h1>
            <p className="muted">One moment.</p>
          </>
        )}
      </div>
    </div>
  );
}
