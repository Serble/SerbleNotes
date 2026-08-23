import { useMemo } from 'react';
import { changesBetween, type DiffHunk } from '../services/diff';

/**
 * A version shown as the change it made, the way a diff is read anywhere else: removed lines, added
 * lines, and enough of what was around them to see where they went.
 *
 * This is source text rather than rendered markdown, and deliberately so. A rendered before-and-
 * after would show two documents that look almost the same and leave the reader to spot the
 * difference, which is the job this is here to do. The whole note, rendered, is the other half of
 * the switch above it.
 *
 * `noNewline` is parsed and not drawn. Whether a note ends with a newline is invisible in the
 * editor and true of almost every save the app makes, so a "no newline at end of file" row would
 * appear on nearly every diff and mean nothing to anybody reading one. The parser still has to
 * understand the marker, because a hunk that miscounts it eats the rest of the change.
 */
export function VersionDiff({ previous, current }: { previous: string; current: string }) {
  const diff = useMemo(() => changesBetween(previous, current), [previous, current]);

  if (diff.hunks.length === 0) {
    return (
      <div className="diff">
        <p className="muted">This save changed nothing in the note.</p>
      </div>
    );
  }

  return (
    <div className="diff">
      <p className="diff-summary muted small">
        <span className="diff-count added">{diff.added} added</span>
        <span className="diff-count removed">{diff.removed} removed</span>
      </p>

      {diff.hunks.map((hunk, index) => (
        <section className="diff-hunk" key={index}>
          <h3 className="diff-hunk-head">{hunkLabel(hunk)}</h3>
          {hunk.lines.map((line, row) => (
            <div className={`diff-line diff-${line.kind}`} key={row}>
              <span className="diff-no" aria-hidden="true">
                {line.oldLine ?? ''}
              </span>
              <span className="diff-no" aria-hidden="true">
                {line.newLine ?? ''}
              </span>
              <span className="diff-sign" aria-hidden="true">
                {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ''}
              </span>
              <span className="diff-text">{line.text}</span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

/**
 * Where in the note this hunk is, named after the newer text - which is the version being read.
 * A hunk that only removes lines has no place in the newer text at all, so it is named after the
 * lines it took out.
 */
function hunkLabel(hunk: DiffHunk): string {
  const start = hunk.newLen > 0 ? hunk.newStart : hunk.oldStart;
  const len = hunk.newLen > 0 ? hunk.newLen : hunk.oldLen;

  return len === 1 ? `Line ${start}` : `Lines ${start} to ${start + len - 1}`;
}
