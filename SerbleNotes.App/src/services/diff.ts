/**
 * Reading the core's diff back so it can be *shown*.
 *
 * Every version in a note's history is a change to the one before it, and until now the history
 * panel could only show the result - the whole note as it stood. "What did this save actually do"
 * is the question people bring to a history, and it was the one question it could not answer.
 *
 * Nothing here diffs anything. `make_diff` in the Rust core is the only thing in this project
 * allowed to, and it is what produced the payload sitting in the version anyway; this reads that
 * same unified diff into lines a component can draw. A second differ written in TypeScript would
 * be a second opinion about what changed, and the two would disagree the day one of them was
 * updated.
 *
 * The format is diffy's, which is git's: an optional preamble, then `@@ -a,b +c,d @@` and one line
 * per changed or context line. Two things about it are easy to get wrong and are why this file has
 * tests:
 *
 * - **A hunk is read by counting, not by looking at line prefixes.** The header says how many old
 *   and new lines the hunk holds, so a line of somebody's note that happens to read `@@ -1 +1 @@`
 *   is consumed as content rather than mistaken for the next hunk. Notes are markdown, and a note
 *   about diffs is a note people write.
 * - **A blank context line arrives with no leading space.** diffy formats with
 *   `suppress_blank_empty`, so an unchanged empty line in the note is an empty line in the diff
 *   rather than a line holding one space. Read as "unknown prefix" it would end the hunk early and
 *   swallow the rest of the change.
 */
import { makeDiff } from '../core';

export type DiffLineKind = 'context' | 'add' | 'remove';

export interface DiffLine {
  kind: DiffLineKind;
  /** The line's own text, with no marker and no trailing newline. */
  text: string;
  /** Where this line is in the older text, or null if it is not in it. 1-based. */
  oldLine: number | null;
  /** Where this line is in the newer text, or null if it is not in it. 1-based. */
  newLine: number | null;
  /** The text it belongs to ends here, with no newline after it. */
  noNewline: boolean;
}

export interface DiffHunk {
  oldStart: number;
  oldLen: number;
  newStart: number;
  newLen: number;
  lines: DiffLine[];
}

export interface Diff {
  hunks: DiffHunk[];
  added: number;
  removed: number;
}

const EMPTY: Diff = { hunks: [], added: 0, removed: 0 };

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The marker diffy writes under a line that ends its side of the file without a newline. */
const NO_NEWLINE = '\\';

/**
 * Reads a unified diff into hunks.
 *
 * Anything before the first hunk header is skipped, which covers both the `serblenotes-diff-v1`
 * line the core puts on a stored payload and the `---`/`+++` pair diffy writes. Content only ever
 * appears inside a hunk, so there is nothing there to lose.
 */
export function parseDiff(diff: string): Diff {
  const lines = diff.split('\n');

  // Every line diffy writes is newline-terminated, so the split always ends in one empty element
  // that is not a line of anything. Left in, a hunk whose last lines are missing takes it for a
  // blank context line and reports a change the diff does not contain.
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  const hunks: DiffHunk[] = [];
  let added = 0;
  let removed = 0;
  let at = 0;

  while (at < lines.length) {
    const header = HUNK.exec(lines[at]);
    if (!header) {
      at += 1;
      continue;
    }

    const oldStart = Number(header[1]);
    const oldLen = header[2] === undefined ? 1 : Number(header[2]);
    const newStart = Number(header[3]);
    const newLen = header[4] === undefined ? 1 : Number(header[4]);
    at += 1;

    const hunk: DiffHunk = { oldStart, oldLen, newStart, newLen, lines: [] };
    let oldNo = oldStart;
    let newNo = newStart;
    let oldLeft = oldLen;
    let newLeft = newLen;

    while (at < lines.length && (oldLeft > 0 || newLeft > 0)) {
      const raw = lines[at];
      at += 1;

      // Belongs to the line above rather than being one of its own, and is not counted.
      if (raw.startsWith(NO_NEWLINE)) {
        const previous = hunk.lines[hunk.lines.length - 1];
        if (previous) {
          previous.noNewline = true;
        }
        continue;
      }

      // An empty element is a blank context line - see the note at the top of this file.
      const sign = raw === '' ? ' ' : raw[0];
      const text = raw === '' ? '' : raw.slice(1);

      if (sign === '+') {
        hunk.lines.push({ kind: 'add', text, oldLine: null, newLine: newNo, noNewline: false });
        newNo += 1;
        newLeft -= 1;
        added += 1;
      } else if (sign === '-') {
        hunk.lines.push({ kind: 'remove', text, oldLine: oldNo, newLine: null, noNewline: false });
        oldNo += 1;
        oldLeft -= 1;
        removed += 1;
      } else {
        hunk.lines.push({
          kind: 'context',
          text,
          oldLine: oldNo,
          newLine: newNo,
          noNewline: false,
        });
        oldNo += 1;
        newNo += 1;
        oldLeft -= 1;
        newLeft -= 1;
      }
    }

    // A hunk's last line can carry the marker after the counts have run out - the marker belongs
    // to the line above it and is not one of the lines the header counted. Both sides can end
    // without a newline, so this is the second of the two.
    if (at < lines.length && lines[at].startsWith(NO_NEWLINE)) {
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) {
        last.noNewline = true;
      }
      at += 1;
    }

    hunks.push(hunk);
  }

  return { hunks, added, removed };
}

/**
 * What changed between two versions of a note.
 *
 * The diff comes from the core, so this is the same comparison the version itself was stored as -
 * a save whose payload is a diff will show exactly the diff that was written down.
 */
export function changesBetween(previous: string, current: string): Diff {
  return previous === current ? EMPTY : parseDiff(makeDiff(previous, current));
}
