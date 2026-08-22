import { useState } from 'react';
import { ChevronRightIcon, FolderIcon } from './Icons';
import { Modal } from './Modal';

interface MoveDialogProps {
  title: string;
  /** Every folder in the vault, deepest paths included. */
  folders: string[];
  /** Where the thing being moved is now, so it can be marked rather than offered. */
  current: string;
  /** Folders that cannot receive it - a folder cannot be moved inside itself. */
  isBlocked?: (folder: string) => boolean;
  onPick: (folder: string) => void;
  onCancel: () => void;
}

/** Picking a destination, for when dragging is not convenient - or not possible, on a phone. */
export function MoveDialog({
  title,
  folders,
  current,
  isBlocked,
  onPick,
  onCancel,
}: MoveDialogProps) {
  const [filter, setFilter] = useState('');

  const needle = filter.trim().toLowerCase();
  const shown = folders.filter((folder) => folder.toLowerCase().includes(needle));

  const row = (folder: string, label: React.ReactNode) => {
    const blocked = isBlocked?.(folder) ?? false;
    const here = folder === current;

    return (
      <button
        key={folder === '' ? '<root>' : folder}
        className={here ? 'move-row here' : 'move-row'}
        disabled={blocked || here}
        onClick={() => onPick(folder)}
      >
        <FolderIcon />
        <span className="move-label">{label}</span>
        {here && <span className="muted small">Already here</span>}
      </button>
    );
  };

  return (
    <Modal title={title} onClose={onCancel}>
      <label>
        Find a folder
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter folders"
          autoFocus
        />
      </label>

      <div className="move-list">
        {needle === '' && row('', <span className="muted">Top level</span>)}
        {shown.map((folder) =>
          row(
            folder,
            folder.split('/').map((segment, index) => (
              <span className="crumb" key={`${segment}-${index}`}>
                {index > 0 && <ChevronRightIcon size={12} />}
                {segment}
              </span>
            )),
          ),
        )}
        {shown.length === 0 && needle !== '' && (
          <p className="muted small">No folder matches. Folders are made in the sidebar.</p>
        )}
      </div>

      <div className="row end">
        <button className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
