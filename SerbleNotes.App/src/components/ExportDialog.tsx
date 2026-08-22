import { useState } from 'react';
import { EntryList } from './EntryList';
import { Modal } from './Modal';
import { archiveFileName, buildArchive } from '../services/archive';
import { saveFile } from '../services/files';
import type { VaultStore } from '../services/store';

/**
 * Writes the vault out as a zip of markdown files.
 *
 * The dialog exists rather than the button doing it straight away because there are two things the
 * user has to know first, and both of them are easier to say before the file exists than after: the
 * archive is not encrypted, and it holds the notes as they are now rather than their history. Saying
 * so is not a warning to be dismissed - an export people can read in any editor is the point of the
 * feature, and history has nowhere to live in a folder of markdown.
 */
export function ExportDialog({ store, onClose }: { store: VaultStore; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { notes, unreadable } = store.exportEntries();
  const folders = store.folders();

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      // Decryption happens here, on this device, as it does everywhere else. The archive is the one
      // thing the server is not allowed to see, so it is not built anywhere near it.
      const bytes = await buildArchive(notes, folders);
      const where = await saveFile(archiveFileName(store.vault.name), bytes);
      if (where === null) {
        setBusy(false);
        return;
      }
      setDone(where);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Export ${store.vault.name}`} onClose={onClose}>
      <div className="modal-body">
        {done !== null ? (
          <p>
            Saved as <strong>{done}</strong>.
          </p>
        ) : (
          <>
            <p className="muted small">
              {notes.length} {notes.length === 1 ? 'note' : 'notes'} in {folders.length}{' '}
              {folders.length === 1 ? 'folder' : 'folders'}, as a zip: one <code>.md</code> file per
              note, and folders as folders. It is the same shape the vault will have when it can be
              mounted as a filesystem, so anything on your machine can read it.
            </p>
            <p className="warning small notice">
              The archive is not encrypted. Whatever you save it to can read every note in it.
            </p>
            <p className="muted small">
              It holds each note as it stands now. Version history and restore points stay in the
              vault - a folder of markdown has nowhere to put them.
            </p>

            <EntryList title="Cannot be read, and will not be in it:" items={unreadable} />
          </>
        )}

        {error && <p className="error">{error}</p>}
      </div>

      <div className="row end">
        <button className="ghost" onClick={onClose}>
          {done === null ? 'Cancel' : 'Close'}
        </button>
        {done === null && (
          <button className="primary" onClick={() => void run()} disabled={busy}>
            {busy ? 'Preparing...' : 'Export'}
          </button>
        )}
      </div>
    </Modal>
  );
}
