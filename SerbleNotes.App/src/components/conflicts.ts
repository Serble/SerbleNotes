import { EditorSelection, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/**
 * Merge conflicts, read out of the document.
 *
 * A conflict is the one thing this app writes into a note that the person reading it did not type,
 * and it is written in a notation borrowed from a command-line tool. Left as text it is bad
 * markdown - the lone `=======` under a line of prose is a setext heading, so half of it renders as
 * a title - and worse, it asks somebody to resolve a merge by deleting exactly the right seven
 * characters seven times. So it is drawn instead: see `conflictView.ts`.
 *
 * Nothing here knows about the DOM. Finding the regions and rewriting one of them are text
 * operations on the document, which is what makes them testable.
 */

/** One `<<<<<<< / ||||||| / ======= / >>>>>>>` region, in document offsets. */
export interface Conflict {
  /** Start of the `<<<<<<<` line. */
  from: number;
  /** End of the `>>>>>>>` line. */
  to: number;
  /** This device's version. */
  ours: string;
  /** What both sides started from. Absent when the merge wrote no `|||||||` section. */
  original: string | null;
  /** The other device's version. */
  theirs: string;
}

const OURS = '<<<<<<<';
const ORIGINAL = '|||||||';
const SPLIT = '=======';
const THEIRS = '>>>>>>>';

/** Whether a line opens, divides or closes a conflict. */
export function isConflictMarker(line: string): boolean {
  return (
    line.startsWith(OURS) ||
    line.startsWith(ORIGINAL) ||
    line === SPLIT ||
    line.startsWith(SPLIT + ' ') ||
    line.startsWith(THEIRS)
  );
}

/**
 * Where a line's first dividing marker is, if it has one.
 *
 * Only ever asked about lines *inside* an opened region, which is what makes looking anywhere but
 * the start of the line safe: `|||||||` in the middle of ordinary prose is ordinary prose, but the
 * same characters between a `<<<<<<<` and its `>>>>>>>` are the divider they look like.
 *
 * That leniency is not for show. `diffy` used to write each marker straight after the section before
 * it, so a side whose last line had no trailing newline came back as `aaaaaaa||||||| original` and
 * the closing marker as `bbbbbbb>>>>>>> theirs`. The core no longer produces that, but every note
 * merged before it stopped still contains it - and a strict parser reads such a region as one that
 * never closes, so the notes that most need the conflict drawn are exactly the ones that would get
 * nothing at all.
 */
function markerIn(line: string): { marker: string; at: number } | null {
  let found: { marker: string; at: number } | null = null;

  for (const marker of [ORIGINAL, SPLIT, THEIRS]) {
    const at = line.indexOf(marker);
    if (at !== -1 && (found === null || at < found.at)) {
      found = { marker, at };
    }
  }

  return found;
}

/**
 * Every conflict in the document, in order.
 *
 * Deliberately line-based rather than a regular expression over the whole text. A marker only counts
 * at the start of a line - which is the rule every tool that reads these uses, and the reason the
 * core was changed to stop welding them onto the end of somebody's prose - and a region that is
 * missing its closing marker is not a conflict at all. Half-typed or half-deleted markers are
 * common while somebody is resolving one by hand, and drawing a widget over an unclosed region
 * would swallow the rest of the note.
 */
export function findConflicts(text: string): Conflict[] {
  const conflicts: Conflict[] = [];
  const lines = text.split('\n');

  let offset = 0;
  const offsets = lines.map((line) => {
    const at = offset;
    offset += line.length + 1;
    return at;
  });

  let index = 0;
  while (index < lines.length) {
    if (!lines[index].startsWith(OURS)) {
      index += 1;
      continue;
    }

    const start = index;
    const ours: string[] = [];
    const original: string[] = [];
    const theirs: string[] = [];
    let section: 'ours' | 'original' | 'theirs' = 'ours';
    let closed = -1;

    const push = (text: string) => {
      if (section === 'ours') {
        ours.push(text);
      } else if (section === 'original') {
        original.push(text);
      } else {
        theirs.push(text);
      }
    };

    index += 1;
    while (index < lines.length) {
      const line = lines[index];

      if (line.startsWith(OURS)) {
        // A second opener before this one closed: the first was never a conflict.
        break;
      }

      const marker = markerIn(line);
      if (marker === null) {
        push(line);
        index += 1;
        continue;
      }

      // Anything before the marker is the last line of the section that is ending. Notes merged
      // before the core stopped welding markers onto prose have exactly this shape and are the ones
      // that most need drawing - see `markerIn`.
      if (marker.at > 0) {
        push(line.slice(0, marker.at));
      }

      if (marker.marker === THEIRS) {
        closed = index;
        break;
      }
      section = marker.marker === ORIGINAL ? 'original' : 'theirs';

      index += 1;
    }

    if (closed === -1) {
      // Unclosed. Leave it as the text it is and carry on looking from the line after the opener.
      index = start + 1;
      continue;
    }

    conflicts.push({
      from: offsets[start],
      to: offsets[closed] + lines[closed].length,
      ours: join(ours),
      original: original.length > 0 ? join(original) : null,
      theirs: join(theirs),
    });

    index = closed + 1;
  }

  return conflicts;
}

/**
 * A section's lines as text.
 *
 * Every line inside a conflict was a whole line in the note, so each one keeps its newline. An empty
 * section is empty rather than a blank line - "this side deleted it" has to stay distinguishable
 * from "this side left a blank line here".
 */
function join(lines: string[]): string {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** Which side a resolution keeps. */
export type Resolution = 'ours' | 'theirs' | 'both' | 'original';

export function resolvedText(conflict: Conflict, choice: Resolution): string {
  switch (choice) {
    case 'ours':
      return conflict.ours;
    case 'theirs':
      return conflict.theirs;
    case 'original':
      return conflict.original ?? '';
    case 'both':
      return conflict.ours + conflict.theirs;
  }
}

/**
 * The change that resolves a conflict: what to replace, and what with.
 *
 * Separated from the dispatch so it can be tested, because this is where resolving goes quietly
 * wrong. A conflict region runs from the start of the `<<<<<<<` line to the *end* of the `>>>>>>>`
 * line and does not include the newline after it - the document already has that, and it is what
 * terminates whatever line follows. Each section's text keeps its own trailing newline, because a
 * section is a run of whole lines. Put those together without thinking and every resolution leaves
 * a blank line behind where the markers were.
 *
 * The other case is a side that deleted the passage. Its text is empty, so replacing the region
 * with it would leave the line break that used to end the markers, and the deletion would come out
 * as a blank line rather than as nothing. The trailing newline is taken with it instead.
 */
export function resolutionChange(
  conflict: Conflict,
  choice: Resolution,
  documentLength: number,
): { from: number; to: number; insert: string } {
  const insert = resolvedText(conflict, choice).replace(/\n$/, '');

  return {
    from: conflict.from,
    to: insert === '' && conflict.to < documentLength ? conflict.to + 1 : conflict.to,
    insert,
  };
}

/** The whole document, with one conflict resolved. What the editor ends up holding. */
export function documentAfterResolving(
  text: string,
  conflict: Conflict,
  choice: Resolution,
): string {
  const change = resolutionChange(conflict, choice, text.length);
  return text.slice(0, change.from) + change.insert + text.slice(change.to);
}

/**
 * Replaces a conflict with the side that was chosen.
 *
 * An ordinary edit, which is the point: it goes through the same history as anything typed, so
 * Ctrl-Z puts the conflict back, and the autosave writes the result away without knowing a merge
 * ever happened.
 */
export function resolveConflict(view: EditorView, conflict: Conflict, choice: Resolution): void {
  const change = resolutionChange(conflict, choice, view.state.doc.length);

  view.dispatch({
    changes: change,
    selection: EditorSelection.cursor(change.from + change.insert.length),
    scrollIntoView: true,
  });
  view.focus();
}

// --- which conflicts are shown as text ----------------------------------------------------------
// The same shape as `tableState.ts`: a view of the note rather than part of it, remembered by the
// position the region starts at and carried through edits so a conflict that moved is still the
// same conflict.

export const toggleConflictText = StateEffect.define<number>({
  map: (from, change) => change.mapPos(from),
});

const textModeField = StateField.define<readonly number[]>({
  create: () => [],

  update(value, transaction) {
    let next = value.map((from) => transaction.changes.mapPos(from));

    for (const effect of transaction.effects) {
      if (effect.is(toggleConflictText)) {
        next = next.includes(effect.value)
          ? next.filter((from) => from !== effect.value)
          : [...next, effect.value];
      }
    }

    return next;
  },
});

export function conflictsShownAsText(state: EditorState): readonly number[] {
  return state.field(textModeField, false) ?? [];
}

/**
 * Every conflict in the document, worked out once per edit.
 *
 * A field rather than a call, because three things want the answer - the decorations, the live
 * preview, and anything asking whether a region is drawn - and `findConflicts` walks the whole
 * document. Conflicts can only change when the text does, so once per edit is exactly often enough.
 */
const conflictsField = StateField.define<Conflict[]>({
  create: (state) => findConflicts(state.doc.toString()),

  update(value, transaction) {
    return transaction.docChanged ? findConflicts(transaction.state.doc.toString()) : value;
  },
});

export function conflictsIn(state: EditorState): readonly Conflict[] {
  return state.field(conflictsField, false) ?? [];
}

/**
 * Whether a range of the document touches a conflict.
 *
 * `livePreview` asks so it can leave such a range alone, and the test is *overlap* rather than
 * "starts inside", which is the whole point. Conflict markers are not markdown, but the markdown
 * parser does not know that and reads them as ordinary text - so a `=======` inside a conflict is a
 * setext underline, and a setext underline applies to the paragraph *before* it. That paragraph is
 * outside the conflict, so a node starting inside the region was never the problem: the heading
 * node started three lines above it and reached in. It rendered everything from there down as a
 * title, which is what "it's still affecting formatting" was.
 *
 * It applies whether the conflict is drawn as a card or shown as its markers. The card replaces its
 * own lines either way; what has to be stopped is the markup reaching out of them.
 */
export function touchesConflict(state: EditorState, from: number, to: number): boolean {
  return conflictsIn(state).some((conflict) => from <= conflict.to && to >= conflict.from);
}

export const conflictState: Extension = [textModeField, conflictsField];
