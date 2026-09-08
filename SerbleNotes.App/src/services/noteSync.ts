/**
 * What the editor does when the note underneath it moves, and what happens when a save fails.
 *
 * This used to live inside `VaultPage` as a `useCallback` and a `useEffect`, which meant the part
 * of the client most able to lose someone's work was the part that could not be tested at all. It
 * is plain functions over a `VaultStore` and the editor now: the workspace holds one `EditorState`
 * and hands these an `EditorAccess` onto it, and `tests/merge.test.ts` and `tests/typing.test.ts`
 * drive the same functions against a fake server.
 *
 * Nothing here touches React, the DOM, or the network directly - the store owns all three.
 */
import { merge } from '../core';
import type { VaultStore } from './store';

/** Whether the editor's text has reached the server, and if not, why not. */
export type SaveStatus =
  /** Everything typed is on the server. */
  | 'saved'
  /** There are unsent changes and a save is either running or about to. */
  | 'saving'
  /** There are unsent changes and the server cannot be reached. They are kept on this device. */
  | 'offline'
  /** There are unsent changes and the server refused them. `error` says what it said. */
  | 'error';

export interface EditorState {
  /** What is in the editor. */
  text: string;
  /** The version `text` was last known to equal, and the parent of the next save. */
  baseline: string | null;
  /**
   * A branch that was merged into `text` and is not yet an ancestor of anything stored. The next
   * save records it as a second parent, which is what stops the merge being seen as a fork forever.
   */
  mergeParent: string | null;
  /** The merge left conflict markers in `text` for someone to resolve. */
  conflicted: boolean;
  status: SaveStatus;
  /** The sentence to show, when `status` is `error`. */
  error: string | null;
}

/**
 * A failure that means "the server was not reached", as opposed to one that means "the server said
 * no". `api.ts` reports the first as status 0, because nothing came back to have a status.
 *
 * The difference decides what the user is told and whether anything retries, so it is asked once,
 * here, rather than by matching on the message anywhere it matters.
 */
export function isOffline(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 0;
}

/**
 * The editor state, as the functions below read and write it.
 *
 * Every one of them goes to the server in the middle, and the person on the other end of the round
 * trip is still typing. A state read before that request is a state one or more keystrokes old, so
 * nothing here may build its answer out of one: read again after the last await, and write the
 * result in the same breath, with nothing in between that could yield. What is on screen then only
 * ever moves forwards - which is the whole difference between a save happening and a save undoing
 * the word that was just typed. `tests/typing.test.ts` is that rule, one test per request.
 *
 * These used to take an `EditorState` and return a new one, which reads more simply and is exactly
 * the bug: a value handed in before a request and a value applied wholesale after it are, between
 * them, a window that swallows everything typed during it.
 *
 * `read` is the workspace's ref rather than its React state: the state a render has not happened
 * for yet would be precisely the keystroke this is trying not to lose.
 */
export interface EditorAccess {
  read(): EditorState;
  write(next: EditorState): void;
}

/**
 * Someone typed.
 *
 * This exists as a function rather than as "set the text and move on" because the status has to
 * move with it: the moment the editor holds something the server does not, the indicator is no
 * longer entitled to say "Saved". Leaving it alone until the save came back meant the app said
 * everything was safe for as long as a request took - and a request on a device that has just lost
 * its connection does not fail quickly, it hangs. That is the one lie this indicator must never
 * tell, and it is worse than the "Saving" that never stopped, because it does not even look wrong.
 *
 * An `error` is deliberately kept: a save the server refused is still refused while the next one is
 * being typed, and the sentence explaining it should not flicker away on a keystroke.
 */
export function typed(state: EditorState, text: string): EditorState {
  if (text === state.text) {
    return state;
  }

  return {
    ...state,
    text,
    // Resolving the last conflict is how the warning about them goes away. It is a substring scan
    // rather than a parse because this runs on every keystroke, and it only has to be right about
    // "are there any left" - a half-deleted marker still counts as one, which is the safe way for
    // it to be wrong.
    conflicted: state.conflicted && text.includes('<<<<<<<'),
    status: state.status === 'error' ? 'error' : 'saving',
  };
}

/** The state a note opens in. Call `store.ensureNote` first: the bytes have to be here. */
export function opened(store: VaultStore, noteId: string): EditorState {
  const head = store.headOf(noteId);
  const stored = head ? store.materialise(head) : '';

  // An edit this device made and could not send outlives the session that made it. It comes back
  // as what is in the editor, still unsent, so the retry has something to send and the user does
  // not reopen a note to find their train journey missing.
  const draft = store.draftOf(noteId);

  return {
    text: draft ?? stored,
    baseline: head,
    mergeParent: null,
    conflicted: false,
    status: draft != null && draft !== stored ? 'offline' : 'saved',
    error: null,
  };
}

/**
 * Brings the editor into line with the store after new versions arrive - from another device, or
 * from the pull that follows opening a cached vault.
 *
 * Writes nothing when there is nothing to do, so a vault that is already up to date does not
 * re-render the workspace on every notification.
 *
 * The decision this makes is the one thing in the client that can silently destroy an edit, so it
 * is worth stating plainly. There are three cases, not two:
 *
 * - **The head has not moved.** Nothing to do.
 * - **The new head descends from ours.** It contains everything our baseline contained, so it can
 *   be taken as-is - merged with what is unsent if there is any, adopted outright if there is not.
 * - **The new head is a sibling.** Both devices built on the same parent. Neither branch contains
 *   the other, so there is nothing to fast-forward *to*: whichever one were adopted, the other
 *   device's edit would vanish from the note. This is a fork whether or not anything is unsent,
 *   and the only answer that keeps both is a three-way merge.
 *
 * The old version of this asked whether the editor had unsaved text and treated "no" as permission
 * to adopt the remote head. That is right for a descendant and wrong for a sibling, and it is
 * exactly the case where a device came back from being offline: it had saved, so nothing was
 * unsent, and its saved work was replaced by the other device's.
 */
export async function reconcile(
  store: VaultStore,
  noteId: string,
  editor: EditorAccess,
): Promise<void> {
  // Around the fetches rather than inside them: what is fetched depends on the baseline and on the
  // head, and either can move while the fetching is going on - a save landing, another device's
  // change arriving. Anything that moves is a reason to work the answer out again rather than to
  // apply one that was true a moment ago.
  for (;;) {
    const state = editor.read();
    const remoteHead = store.headOf(noteId);
    const base = state.baseline;

    if (!remoteHead || remoteHead === base) {
      return;
    }

    // The new head is metadata until its ciphertext is here, and so is the version this editor has
    // been working from - two chains, named rather than fetched as "the whole note" as this once was.
    await store.ensureVersions([remoteHead, base]);

    // Where the two branches diverged. Asked for separately because there is no knowing which
    // version it will be until they are walked, and it can be far enough back to share no chain
    // with either of them. Both of these are worked out from ids alone, so neither depends on what
    // the editor holds - which is what lets every text decision below wait until the fetching is
    // finished.
    const ancestorId = base ? store.commonAncestor(base, remoteHead) : null;
    await store.ensureVersions([ancestorId]);

    // The last await is above this line. Everything from here to the write is synchronous, so the
    // text being merged is the text on the screen and cannot be overtaken between the two.
    const current = editor.read();
    if (current.baseline !== base || store.headOf(noteId) !== remoteHead) {
      continue;
    }

    const remoteText = store.materialise(remoteHead);
    const baseText = base ? store.materialise(base) : '';
    const unsent = current.text !== baseText;

    // No baseline at all means this editor is not holding a version to lose.
    if (base === null || (!unsent && store.descendsFrom(remoteHead, base))) {
      editor.write({
        ...current,
        text: remoteText,
        baseline: remoteHead,
        mergeParent: null,
        conflicted: false,
        status: 'saved',
        error: null,
      });
      return;
    }

    // Merge against where the two branches diverged. `current.text` is "ours" whether it was saved
    // or not: on a fork, our own saved version is a branch the other side has never seen either.
    const ancestorText = ancestorId ? store.materialise(ancestorId) : baseText;
    const merged = merge(ancestorText, current.text, remoteText);

    editor.write({
      ...current,
      text: merged.text,
      conflicted: merged.conflicted,
      // The branch we came from, so the version written next records both sides of the fork.
      mergeParent: base,
      baseline: remoteHead,
      status: 'saving',
      error: null,
    });
    return;
  }
}

/** Whether `text` is something the server has not got. */
export function unsaved(store: VaultStore, noteId: string, state: EditorState): boolean {
  try {
    return state.text !== store.textOf(noteId);
  } catch {
    // The bodies are not here, so nothing can be compared - and nothing should be written either.
    return false;
  }
}

/**
 * Writes the editor's text as a new version.
 *
 * A failure is not the end of the edit. Whatever could not be sent is kept on the device, sealed,
 * and the state says which kind of failure it was: `offline` is temporary and will be retried when
 * the network returns, `error` is the server refusing and will not be.
 */
export async function commit(
  store: VaultStore,
  noteId: string,
  editor: EditorAccess,
): Promise<void> {
  const state = editor.read();

  if (!unsaved(store, noteId, state)) {
    store.dropDraft(noteId);
    if (state.status !== 'saved') {
      editor.write({ ...state, status: 'saved', error: null });
    }
    return;
  }

  try {
    await store.saveNote(noteId, state.text, { mergeParentId: state.mergeParent });
    store.dropDraft(noteId);

    // The other side of the round trip. What the editor holds now is what was typed during it, and
    // only the bookkeeping below is this function's to change - the text is the user's.
    const current = editor.read();
    editor.write({
      ...current,
      baseline: store.headOf(noteId),
      // Recorded by the version just written, whatever has been typed since.
      mergeParent: null,
      // A keystroke made while the request was out is not on the server, and the indicator says so
      // rather than claiming everything is safe. The autosave that keystroke armed writes it next.
      status: unsaved(store, noteId, current) ? 'saving' : 'saved',
      error: null,
    });
  } catch (e: unknown) {
    const current = editor.read();

    // The draft is what survives a reload, so it is the text as it is now rather than the text that
    // was refused - they differ by whatever was typed while the request was failing.
    store.keepDraft(noteId, current.text);

    editor.write({
      ...current,
      status: isOffline(e) ? 'offline' : 'error',
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Everything a device does when it can reach the server again: catch up, merge, and send what it
 * was holding.
 *
 * The order is the whole point. A device that was offline missed the notifications it would have
 * been sent - the sync socket carries events, not a replayable log - so it has to pull before it
 * can know what it is building on. Saving first is what turns every reconnect into a fork.
 */
export async function resync(
  store: VaultStore,
  noteId: string | null,
  editor: EditorAccess,
): Promise<void> {
  await store.pull();

  if (!noteId) {
    return;
  }

  // Each step reads the editor for itself, which is what makes the pull above safe to type through:
  // the merge sees the sentence that was finished while it was running, and the save sends it.
  await reconcile(store, noteId, editor);
  await commit(store, noteId, editor);
}
