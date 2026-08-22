import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRightIcon, FolderIcon } from './Icons';
import { oversizedSegments } from '../core';

interface NotePathBarProps {
  /** The folder the note is in, or '' for the top level. */
  folder: string;
  /** The note's own name, without any folders in it. */
  title: string;
  /** Resolves false if the name was refused, so the box can put the old one back. */
  onRename: (title: string) => Promise<boolean>;
  onPickFolder: () => void;
  /** Note-level controls, shown on the right of the bar. */
  actions?: ReactNode;
}

/**
 * The bar above the editor: the note's name, editable in place, with the folders leading to it
 * shown as a trail rather than typed into the name. A note is called "Test results"; that it
 * happens to live in "Medical" is where it is, not what it is called, and the two should not be the
 * same box of text.
 *
 * The controls that act on this note - its details, its history - live here rather than in the app
 * header, because that is what they are about.
 */
export function NotePathBar({ folder, title, onRename, onPickFolder, actions }: NotePathBarProps) {
  const [draft, setDraft] = useState(title);

  // Follows the note when you switch notes, or when another device renames this one.
  useEffect(() => {
    setDraft(title);
  }, [title, folder]);

  const commit = async () => {
    const next = draft.trim();
    if (next === title || next === '') {
      setDraft(title);
      return;
    }

    if (!(await onRename(next))) {
      setDraft(title);
    }
  };

  const segments = folder === '' ? [] : folder.split('/');
  const tooLong = oversizedSegments(draft);

  return (
    <div className="note-bar">
      <div className="note-bar-main">
        <button className="crumbs" onClick={onPickFolder} title="Move this note to another folder">
          <FolderIcon size={13} />
          {segments.length === 0 ? (
            <span className="crumb muted">Top level</span>
          ) : (
            segments.map((segment, index) => (
              <span className="crumb" key={`${segment}-${index}`}>
                {index > 0 && <ChevronRightIcon size={11} />}
                {segment}
              </span>
            ))
          )}
        </button>

        <input
          className="path-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            }
            if (event.key === 'Escape') {
              setDraft(title);
              event.currentTarget.blur();
            }
          }}
          spellCheck={false}
          aria-label="Note name"
        />
      </div>

      {actions && <div className="note-bar-actions">{actions}</div>}

      {tooLong.length > 0 && (
        // Informative, not a refusal: the note saves either way. See "Inform, never forbid".
        <p className="warning small note-bar-note">
          This name is longer than a filesystem can store, so it will be shortened when the vault is
          mounted as folders.
        </p>
      )}
    </div>
  );
}
