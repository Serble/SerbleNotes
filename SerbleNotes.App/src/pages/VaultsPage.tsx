import { useEffect, useState } from 'react';
import {
  ChevronRightIcon,
  KeyIcon,
  LockIcon,
  LogoIcon,
  PlusIcon,
  SignOutIcon,
  TrashIcon,
  UnlockedIcon,
  VaultIcon,
} from '../components/Icons';
import { ConfirmModal } from '../components/ConfirmModal';
import { Modal } from '../components/Modal';
import { PasswordStrength } from '../components/PasswordStrength';
import { api } from '../services/api';
import { logout } from '../services/auth';
import { day, relative } from '../services/dates';
import { forgetVault } from '../services/settings';
import { forgetAllStores, forgetStore } from '../services/stores';
import {
  cachedKey,
  changePassword,
  forgetKey,
  newVaultMaterial,
  rememberKey,
} from '../services/vaultKeys';
import type { Vault } from '../types';

interface VaultsPageProps {
  onOpenVault: (vault: Vault) => void;
}

export function VaultsPage({ onOpenVault }: VaultsPageProps) {
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Vault | null>(null);
  const [repasswording, setRepasswording] = useState<Vault | null>(null);
  const [changed, setChanged] = useState<string | null>(null);

  // Which encrypted vaults this device already holds the key for. A keychain is asked
  // asynchronously and can refuse to answer at all, so this arrives after the list does; until it
  // lands an encrypted vault is drawn as locked, which is the state that promises the least.
  const [unlocked, setUnlocked] = useState<ReadonlySet<string>>(new Set());

  const load = () => {
    setLoading(true);
    api
      .listVaults()
      .then(async (list) => {
        setVaults(list);
        const keys = await Promise.all(
          list.map((vault) => (vault.encrypted ? cachedKey(vault.id) : null)),
        );
        setUnlocked(new Set(list.filter((_, i) => keys[i] !== null).map((vault) => vault.id)));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const remove = async (vault: Vault) => {
    try {
      await api.deleteVault(vault.id);
      await forgetKey(vault.id);
      forgetVault(vault.id);
      // The vault is gone, so this device's copy of its ciphertext goes with it.
      await forgetStore(vault.id);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Most recently touched first: `updatedAt` moves with every write to the vault, so this is the
  // order someone actually works in rather than the order they happened to create them.
  const ordered = [...vaults].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <div className="shell">
      <header className="app-bar">
        <span className="brand">
          <LogoIcon size={18} />
          Serble Notes
        </span>
        <button
          className="ghost"
          onClick={() => {
            // Nothing decrypted outlives the session. What is cached on the device is ciphertext.
            forgetAllStores();
            logout();
          }}
        >
          <SignOutIcon />
          <span className="wide-only">Sign out</span>
        </button>
      </header>

      <main className="page">
        <div className="page-head">
          <div>
            <h1>Vaults</h1>
            <p className="muted small">
              Each vault has its own key. Notes never leave this device unencrypted.
            </p>
          </div>
          <button className="primary" onClick={() => setCreating(true)}>
            <PlusIcon />
            New vault
          </button>
        </div>

        {error && <p className="error notice">{error}</p>}
        {changed && <p className="notice">Password changed for {changed}.</p>}

        {loading ? (
          <p className="muted">Loading...</p>
        ) : ordered.length === 0 ? (
          <div className="empty">
            <VaultIcon size={22} />
            <h2>No vaults yet</h2>
            <p className="muted">
              A vault holds notes and their whole history. Make one to start writing.
            </p>
            <button className="primary" onClick={() => setCreating(true)}>
              <PlusIcon />
              New vault
            </button>
          </div>
        ) : (
          <ul className="vault-list">
            {ordered.map((vault) => {
              // Three states, and the one that matters before a tap is whether opening this vault
              // will ask for a password. The mark is the glance and the line under the name is the
              // sentence; an unencrypted vault keeps the warning colour it has always had.
              const state = !vault.encrypted
                ? 'plain'
                : unlocked.has(vault.id)
                  ? 'ready'
                  : 'locked';

              return (
                <li key={vault.id} className="vault-row">
                  <button className="vault-open" onClick={() => onOpenVault(vault)}>
                    <span className={`vault-mark ${state}`}>
                      {state === 'locked' ? <LockIcon size={17} /> : <UnlockedIcon size={17} />}
                    </span>

                    <span className="vault-text">
                      <span className="vault-name">{vault.name}</span>
                      <span className="vault-meta">
                        {state === 'plain' ? (
                          <span className="warning">Not encrypted</span>
                        ) : state === 'ready' ? (
                          <span>Encrypted - unlocked on this device</span>
                        ) : (
                          <span>Encrypted - password needed</span>
                        )}
                        <span className="sep" aria-hidden="true" />
                        <span title={`Created ${day(vault.createdAt)}`}>
                          Updated {relative(vault.updatedAt)}
                        </span>
                      </span>
                    </span>

                    <ChevronRightIcon size={15} />
                  </button>

                  {vault.encrypted && (
                    <button
                      className="icon"
                      title={`Change the password for ${vault.name}`}
                      aria-label={`Change the password for ${vault.name}`}
                      onClick={() => {
                        setChanged(null);
                        setRepasswording(vault);
                      }}
                    >
                      <KeyIcon />
                    </button>
                  )}

                  <button
                    className="icon danger"
                    title={`Delete ${vault.name}`}
                    aria-label={`Delete ${vault.name}`}
                    onClick={() => setDeleting(vault)}
                  >
                    <TrashIcon />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </main>

      {deleting && (
        <ConfirmModal
          title="Delete vault"
          confirmLabel="Delete vault"
          danger
          body={
            <p>
              <strong>{deleting.name}</strong> and every note in it are deleted, with all their
              history.{' '}
              {deleting.encrypted
                ? 'Nothing anywhere can recover them: the server only ever held this vault encrypted.'
                : 'This cannot be undone.'}
            </p>
          }
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const vault = deleting;
            setDeleting(null);
            void remove(vault);
          }}
        />
      )}

      {repasswording && (
        <ChangePasswordDialog
          vault={repasswording}
          onClose={() => setRepasswording(null)}
          onChanged={(vault) => {
            setRepasswording(null);
            setChanged(vault.name);
            // The row now holds a wrapped key and salt that nothing here can open with the old
            // password. Keeping the stale one would send the next unlock at a blob that is gone.
            setVaults((current) => current.map((v) => (v.id === vault.id ? vault : v)));
            // Changing the password unwrapped the key here, so this device now holds it whether or
            // not it did a moment ago.
            setUnlocked((current) => new Set(current).add(vault.id));
          }}
        />
      )}

      {creating && (
        <CreateVaultDialog
          onClose={() => setCreating(false)}
          onCreated={(vault) => {
            setCreating(false);
            setVaults((current) => [...current, vault]);
            onOpenVault(vault);
          }}
        />
      )}
    </div>
  );
}

function CreateVaultDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (vault: Vault) => void;
}) {
  const [name, setName] = useState('');
  const [encrypted, setEncrypted] = useState(true);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    // The only check here. A mismatch is not a choice the user is making, it is a typo they cannot
    // see - and with no recovery, a typo means the vault is gone the moment they close the tab.
    // Password *strength* is their call and is never blocked; see PasswordStrength.
    if (encrypted && password !== confirmation) {
      setError('The two passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      // Key generation and wrapping happen here, on this device. The server is handed a blob.
      const material = newVaultMaterial(encrypted ? password : null);
      const vault = await api.createVault({
        name: name.trim(),
        encrypted: material.encrypted,
        wrappedKey: material.wrappedKey,
        kdfSalt: material.kdfSalt,
        kdfParams: material.kdfParams,
      });

      // Written before the vault opens, so the key is on this device even if the app is closed
      // straight away - otherwise a vault could exist that nothing here can open.
      await rememberKey(vault.id, material.key);
      onCreated(vault);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="New vault" onClose={onClose}>
      <form onSubmit={submit}>
        <label>
          Name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Work notes"
            required
            autoFocus
          />
        </label>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={encrypted}
            onChange={(event) => setEncrypted(event.target.checked)}
          />
          Protect with a password
        </label>

        {encrypted ? (
          <>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
              />
            </label>
            <PasswordStrength password={password} />
            <label>
              Confirm password
              <input
                type="password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="new-password"
              />
            </label>
            <p className="muted small">
              There is no recovery. If you forget this password the notes in this vault are gone -
              the server cannot read them either.
            </p>
          </>
        ) : (
          <p className="muted small">
            This vault will not be end-to-end encrypted. The server can read everything in it. Use it
            for things you would be comfortable storing in plain text.
          </p>
        )}

        {error && <p className="error">{error}</p>}

        <div className="row end">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Creating...' : 'Create vault'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Changing a vault password re-wraps the key; it does not replace it. That is what makes the whole
 * thing instant and safe - no note is rewritten, and a device that has already unlocked this vault
 * carries on with the key it has - and it is also the one thing about it that could mislead someone,
 * so the dialog says it rather than letting a new password imply more than it does.
 */
function ChangePasswordDialog({
  vault,
  onClose,
  onChanged,
}: {
  vault: Vault;
  onClose: () => void;
  onChanged: (vault: Vault) => void;
}) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    // Same single check as creating a vault: a mismatch is a typo nobody can see, and this password
    // is the only way back into the vault from any device that has not already unlocked it. How
    // strong it is remains the user's call - see PasswordStrength.
    if (password !== confirmation) {
      setError('The two new passwords do not match.');
      return;
    }

    setBusy(true);

    // Two Argon2 derivations at full cost, so let the browser paint the busy state before starting.
    window.setTimeout(() => {
      void (async () => {
        try {
          // Unwrapping with the old password and wrapping with the new one both happen here. If the
          // current password is wrong this throws and nothing is sent.
          const material = await changePassword(vault, current, password);
          onChanged(await api.changeVaultPassword(vault.id, material));
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      })();
    }, 0);
  };

  return (
    <Modal title={`Change password for ${vault.name}`} onClose={onClose}>
      <form onSubmit={submit}>
        <label>
          Current password
          <input
            type="password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            autoComplete="current-password"
            autoFocus
          />
        </label>

        <label>
          New password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
          />
        </label>
        <PasswordStrength password={password} />

        <label>
          Confirm new password
          <input
            type="password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="new-password"
          />
        </label>

        <p className="muted small">
          Your notes are not re-encrypted: the new password wraps the same vault key, so nothing in
          the vault changes and devices that have already unlocked it keep working. There is still no
          recovery - forget this one and the notes are gone.
        </p>
        <p className="muted small">
          It also means the old password is not made worthless. Anyone who knew it and kept a copy of
          the stored key from before can still work out the key this vault uses. A new password shuts
          out anyone trying to unlock the vault from now on; it does not change the lock the notes
          themselves are behind.
        </p>

        {error && <p className="error">{error}</p>}

        <div className="row end">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Changing...' : 'Change password'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
