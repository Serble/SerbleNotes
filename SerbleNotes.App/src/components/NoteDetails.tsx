import { ChevronRightIcon, FolderIcon } from './Icons';
import { Panel, PanelRow } from './Panel';
import { absolute, relative } from '../services/dates';
import type { Note, NoteVersion } from '../types';

interface NoteDetailsProps {
  note: Note;
  /** The folder the note is in, '' for the top level. */
  folder: string;
  /** The note's whole history, newest first. */
  versions: NoteVersion[];
  /** What is in the editor right now, which is what the counts should describe. */
  text: string;
  onPickFolder: () => void;
  onClose: () => void;
  /** Set by the rail once this panel has been dragged to a height of its own. */
  className?: string;
}

/**
 * What is known about a note as a thing, rather than as text: when it started, when it last
 * changed, how much of it there is, and how much history is behind it.
 *
 * Everything here is either a client-side count of decrypted text or a timestamp the server keeps
 * anyway to order the sync. Nothing new is asked of the server to fill this in.
 */
export function NoteDetails({
  note,
  folder,
  versions,
  text,
  onPickFolder,
  onClose,
  className,
}: NoteDetailsProps) {
  const latest = versions[0];
  const named = versions.filter((version) => version.isNamed).length;
  const stored = versions.reduce((total, version) => total + version.size, 0);
  const segments = folder === '' ? [] : folder.split('/');

  return (
    <Panel title="Details" onClose={onClose} className={className}>
      <div className="panel-rows">
        <PanelRow
          label="Folder"
          value={
            <button className="crumbs inline" onClick={onPickFolder} title="Move to another folder">
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
          }
        />
        <PanelRow
          label="Last edited"
          value={latest ? relative(latest.createdAt) : 'Never'}
          title={latest ? absolute(latest.createdAt) : undefined}
        />
        <PanelRow
          label="Created"
          value={relative(note.createdAt)}
          title={absolute(note.createdAt)}
        />
      </div>

      <div className="panel-rows">
        <PanelRow label="Words" value={countWords(text).toLocaleString()} />
        <PanelRow label="Characters" value={text.length.toLocaleString()} />
      </div>

      <div className="panel-rows">
        <PanelRow label="Versions" value={versions.length.toLocaleString()} />
        <PanelRow label="Restore points" value={named.toLocaleString()} />
        <PanelRow
          label="History size"
          value={bytes(stored)}
          title="How much the whole history of this note takes up on the server, encrypted."
        />
      </div>
    </Panel>
  );
}

/**
 * Runs of non-whitespace. Deliberately simple: it is a rough figure people use to gauge length, and
 * every language-aware refinement makes it wrong for some other language.
 */
function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

function bytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} kB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
