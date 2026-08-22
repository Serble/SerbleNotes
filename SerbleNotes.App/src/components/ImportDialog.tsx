import { useState } from 'react';
import { EntryList } from './EntryList';
import { Modal } from './Modal';
import { readArchive, type ArchiveContents } from '../services/archive';
import { pickFile } from '../services/files';
import type { VaultStore } from '../services/store';

interface ImportResult {
  created: number;
  folders: number;
  failed: { name: string; reason: string }[];
}

/**
 * Reads a zip of markdown files into the vault.
 *
 * It is deliberately two steps. The archive is read and worked out first and shown to the user -
 * how many notes, which ones are already here, what in it is not a note - and only then does
 * anything get written. That is what makes it possible to say "these three already exist and will
 * be left alone" rather than discovering it halfway through, and it means an archive from somewhere
 * else can be inspected without committing to it.
 */
export function ImportDialog({
  store,
  onClose,
  onImported,
}: {
  store: VaultStore;
  onClose: () => void;
  onImported: () => void;
}) {
  const [file, setFile] = useState<string | null>(null);
  const [contents, setContents] = useState<ArchiveContents | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async () => {
    setBusy(true);
    setError(null);
    try {
      const picked = await pickFile();
      if (picked === null) {
        return;
      }
      setFile(picked.name);
      setContents(await readArchive(picked.bytes));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Worked out before anything is written, which is the whole reason the dialog has two steps.
  const clashes: { name: string; reason: string }[] =
    contents?.notes
      .map((note) => ({ name: note.name, taken: store.occupantOf(note.name) }))
      .filter((entry) => entry.taken !== null)
      .map((entry) => ({
        name: entry.name,
        reason: `a ${entry.taken} of that name is already here`,
      })) ?? [];

  const willCreate = (contents?.notes.length ?? 0) - clashes.length;
  const emptyFolders = contents?.folders.length ?? 0;
  const nothingToDo = willCreate === 0 && emptyFolders === 0;

  /** "12 notes and 2 empty folders" - said the same way before and after, so it reads as one thing. */
  const count = (notes: number, folders: number): string => {
    const parts = [`${notes} ${notes === 1 ? 'note' : 'notes'}`];
    if (folders > 0) {
      parts.push(`${folders} empty ${folders === 1 ? 'folder' : 'folders'}`);
    }
    return parts.join(' and ');
  };

  const run = async () => {
    if (!contents) {
      return;
    }

    setBusy(true);
    setError(null);
    setProgress({ done: 0, total: contents.notes.length });
    try {
      setResult(
        await store.importNotes(contents.notes, contents.folders, (done, total) =>
          setProgress({ done, total }),
        ),
      );
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <Modal title={`Import into ${store.vault.name}`} onClose={onClose} wide>
      <div className="modal-body">
        {result !== null ? (
          <>
            <p>Imported {count(result.created, result.folders)}.</p>
            <EntryList title="Left alone:" items={result.failed} />
          </>
        ) : contents === null ? (
          <>
            <p className="muted small">
              A zip of markdown files, laid out the way an export writes one: a <code>.md</code> file
              per note, folders as folders. A folder of notes you zipped up yourself works too - the
              file name becomes the note name, minus <code>.md</code>.
            </p>
            <p className="muted small">
              Everything in it is encrypted on this device before it is sent anywhere, exactly like a
              note you type.
            </p>
          </>
        ) : (
          <>
            <p>
              <strong>{file}</strong> holds {count(contents.notes.length, emptyFolders)}.
            </p>

            {clashes.length > 0 && (
              <p className="warning small notice">
                {clashes.length} of {contents.notes.length}{' '}
                {clashes.length === 1 ? 'is already in' : 'are already in'} this vault and will be
                left exactly as {clashes.length === 1 ? 'it is' : 'they are'}. Nothing here is
                overwritten or merged; the other {willCreate} still come in.
              </p>
            )}

            <EntryList title="Already here:" items={clashes} />
            <EntryList
              title="Not imported:"
              items={contents.skipped.map((entry) => ({ name: entry.path, reason: entry.reason }))}
            />
          </>
        )}

        {progress !== null && (
          <p className="muted small" aria-live="polite">
            Importing {progress.done} of {progress.total}...
          </p>
        )}
        {error && <p className="error">{error}</p>}
      </div>

      <div className="row end">
        <button className="ghost" onClick={onClose}>
          {result === null ? 'Cancel' : 'Close'}
        </button>

        {result === null &&
          (contents === null ? (
            <button className="primary" onClick={() => void choose()} disabled={busy}>
              {busy ? 'Reading...' : 'Choose archive...'}
            </button>
          ) : (
            <button
              className="primary"
              onClick={() => void run()}
              disabled={busy || nothingToDo}
            >
              {busy
                ? 'Importing...'
                : nothingToDo
                  ? 'Nothing to import'
                  : `Import ${count(willCreate, emptyFolders)}`}
            </button>
          ))}
      </div>
    </Modal>
  );
}
