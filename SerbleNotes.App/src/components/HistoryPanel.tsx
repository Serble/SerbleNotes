import { Panel } from './Panel';
import { absolute, relative } from '../services/dates';
import type { NoteVersion } from '../types';

interface HistoryPanelProps {
  versions: NoteVersion[];
  labelOf: (version: NoteVersion) => string | null;
  headId: string | null;
  previewingId: string | null;
  onPreview: (version: NoteVersion) => void;
  onRestore: (version: NoteVersion) => void;
  onNamePoint: () => void;
  onClose: () => void;
}

/**
 * The full history of a note. Every edit is here - the automatic snapshots the editor takes as you
 * type, and the points you named yourself.
 */
export function HistoryPanel({
  versions,
  labelOf,
  headId,
  previewingId,
  onPreview,
  onRestore,
  onNamePoint,
  onClose,
}: HistoryPanelProps) {
  return (
    <Panel
      title="History"
      scrolls
      onClose={onClose}
      action={
        <button className="ghost small" onClick={onNamePoint}>
          Name this point
        </button>
      }
    >
      <ol className="history-list">
        {versions.map((version) => {
          const label = version.isNamed ? labelOf(version) : null;
          const current = version.id === headId;

          return (
            <li
              key={version.id}
              className={[
                'history-item',
                current ? 'current' : '',
                version.id === previewingId ? 'previewing' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <button
                className="history-open"
                onClick={() => onPreview(version)}
                title={absolute(version.createdAt)}
              >
                <span className="history-line">
                  <span className="history-when">{relative(version.createdAt)}</span>
                  <span className="history-kind">
                    {version.mergeParentId ? 'merge' : version.isSnapshot ? 'snapshot' : 'edit'}
                  </span>
                </span>
                {label && <span className="history-label">{label}</span>}
                {current && <span className="history-current">Current</span>}
              </button>
              {!current && (
                <button className="ghost small" onClick={() => onRestore(version)}>
                  Restore
                </button>
              )}
            </li>
          );
        })}

        {versions.length === 0 && <p className="muted small">Nothing saved yet.</p>}
      </ol>
    </Panel>
  );
}
