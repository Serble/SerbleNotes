/**
 * What the editor does when the note underneath it moves, and what happens when a save fails.
 *
 * This used to live inside `VaultPage` as a `useCallback` and a `useEffect`, which meant the part
 * of the client most able to lose someone's work was the part that could not be tested at all. It
 * is plain functions over a `VaultStore` and a state object now: the workspace holds one
 * `EditorState` in React state and swaps it for whatever these return, and `tests/merge.test.ts`
 * drives the same functions against a fake server.
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
  return { ...state, text, status: state.status === 'error' ? 'error' : 'saving' };
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
 * Returns the state unchanged when there is nothing to do, so a caller can compare by identity.
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
  state: EditorState,
): Promise<EditorState> {
  const remoteHead = store.headOf(noteId);
  const base = state.baseline;

  if (!remoteHead || remoteHead === base) {
    return state;
  }

  // The new head is metadata until its ciphertext is here.
  await store.ensureNote(noteId);

  const remoteText = store.materialise(remoteHead);
  const baseText = base ? store.materialise(base) : '';
  const unsent = state.text !== baseText;

  // No baseline at all means this editor is not holding a version to lose.
  if (base === null || (!unsent && store.descendsFrom(remoteHead, base))) {
    return {
      ...state,
      text: remoteText,
      baseline: remoteHead,
      mergeParent: null,
      conflicted: false,
      status: 'saved',
      error: null,
    };
  }

  // Merge against where the two branches diverged. `state.text` is "ours" whether it was saved or
  // not: on a fork, our own saved version is a branch the other side has never seen either.
  const ancestorId = base ? store.commonAncestor(base, remoteHead) : null;
  const ancestorText = ancestorId ? store.materialise(ancestorId) : baseText;
  const merged = merge(ancestorText, state.text, remoteText);

  return {
    ...state,
    text: merged.text,
    conflicted: merged.conflicted,
    // The branch we came from, so the version written next records both sides of the fork.
    mergeParent: base,
    baseline: remoteHead,
    status: 'saving',
    error: null,
  };
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
  state: EditorState,
): Promise<EditorState> {
  if (!unsaved(store, noteId, state)) {
    store.dropDraft(noteId);
    return state.status === 'saved' ? state : { ...state, status: 'saved', error: null };
  }

  try {
    await store.saveNote(noteId, state.text, { mergeParentId: state.mergeParent });
    store.dropDraft(noteId);

    return {
      ...state,
      baseline: store.headOf(noteId),
      mergeParent: null,
      status: 'saved',
      error: null,
    };
  } catch (e: unknown) {
    store.keepDraft(noteId, state.text);

    return {
      ...state,
      status: isOffline(e) ? 'offline' : 'error',
      error: e instanceof Error ? e.message : String(e),
    };
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
  state: EditorState,
): Promise<EditorState> {
  await store.pull();

  if (!noteId) {
    return state;
  }

  const reconciled = await reconcile(store, noteId, state);
  return commit(store, noteId, reconciled);
}
