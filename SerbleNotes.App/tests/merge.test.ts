/**
 * Divergence: what happens when two devices edit the same note, and what the editor does when the
 * note underneath it moves.
 *
 * The core's suite already proves `merge3` merges correctly, and `tests/lifecycle.rs` proves an
 * algorithm shaped like the store's loses nothing. Neither says anything about *when* the client
 * decides to merge, and that decision - `reconcile` in `pages/VaultPage.tsx` - is where every bug
 * in this file lives. See the note at the top of `support/device.ts` about the transcription.
 *
 * Some of these tests fail. That is deliberate: they assert what the client is supposed to do, and
 * each one that fails is a bug that is still there. Every failing test carries a KNOWN BUG comment
 * naming the cause and the file it lives in. Fixing a bug means making its test pass without
 * touching the assertions - if an assertion has to change, the disagreement is about what correct
 * means, and that is worth settling before writing the fix.
 */
import './support/core';

import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { newVaultKey } from '../src/core';
import { Device, descendsFrom, newVault } from './support/device';
import { resetServer, serverState } from './support/fakeServer';
import { resetStorage } from './support/storage';

let key: string;

beforeEach(() => {
  resetServer();
  resetStorage();
  key = newVaultKey();
});

/** Two devices, both holding the same note at the same version. */
async function twoDevices(text = 'line one\n') {
  const vault = newVault();
  const pc = new Device(vault, key, 'pc');
  const note = await pc.createNote('Shared', text);
  await pc.open(note.id);

  const phone = new Device(vault, key, 'phone');
  await phone.pull();
  await phone.open(note.id);

  return { pc, phone, note };
}

// --- reconcile when nothing has forked -----------------------------------------------------------

test('reconciling does nothing when the head has not moved', async () => {
  const { pc } = await twoDevices();

  const before = { ...pc.editor };
  await pc.remoteChange();

  assert.deepEqual({ ...pc.editor }, before);
});

test('reconciling does nothing after this device made the change itself', async () => {
  const { pc } = await twoDevices();

  pc.type('line one\nmine\n');
  await pc.autosave();
  const afterSave = pc.editor.text;

  await pc.remoteChange();

  assert.equal(pc.editor.text, afterSave);
  assert.equal(pc.editor.baseline, pc.head());
});

test('a remote edit is adopted when this device has nothing unsaved', async () => {
  const { pc, phone } = await twoDevices();

  phone.type('line one\nfrom the phone\n');
  await phone.autosave();

  await pc.remoteChange();

  assert.equal(pc.editor.text, 'line one\nfrom the phone\n');
  assert.equal(pc.editor.baseline, phone.head());
  assert.equal(pc.editor.conflicted, false);
});

test('an unsaved local edit is merged with a remote one instead of being dropped', async () => {
  const { pc, phone } = await twoDevices('middle\n');

  phone.type('top\nmiddle\n');
  await phone.autosave();

  // The computer has typed but its autosave has not run.
  pc.type('middle\nbottom\n');
  assert.equal(pc.unsaved(), true);

  await pc.remoteChange();

  assert.equal(pc.editor.text, 'top\nmiddle\nbottom\n');
  assert.equal(pc.editor.conflicted, false);
});

test('an unsaved local edit that clashes comes back with conflict markers', async () => {
  const { pc, phone } = await twoDevices('the line\n');

  phone.type('the phone rewrote it\n');
  await phone.autosave();

  pc.type('the computer rewrote it\n');
  await pc.remoteChange();

  assert.equal(pc.editor.conflicted, true);
  assert.match(pc.editor.text, /<<<<<<</);
  assert.match(pc.editor.text, /the computer rewrote it/);
  assert.match(pc.editor.text, /the phone rewrote it/);
});

test('the conflict warning clears once the markers are gone', async () => {
  const { pc, phone } = await twoDevices('the line\n');

  phone.type('the phone rewrote it\n');
  await phone.autosave();
  pc.type('the computer rewrote it\n');
  await pc.remoteChange();

  assert.equal(pc.editor.conflicted, true);

  // What resolving a conflict in the editor comes to: the markers are edited away.
  pc.type('the version we settled on\n');

  assert.equal(pc.editor.conflicted, false);
});

test('the conflict warning stays while any marker is left', async () => {
  const { pc, phone } = await twoDevices('the line\n');

  phone.type('the phone rewrote it\n');
  await phone.autosave();
  pc.type('the computer rewrote it\n');
  await pc.remoteChange();

  // Half-resolved: one marker deleted, the rest still there.
  pc.type(pc.editor.text.replace('>>>>>>>', 'still here'));

  assert.equal(pc.editor.conflicted, true);
});

test('the version written after a merge records both parents', async () => {
  const { pc, phone } = await twoDevices('middle\n');

  const ours = pc.head()!;
  phone.type('top\nmiddle\n');
  await phone.autosave();

  pc.type('middle\nbottom\n');
  await pc.remoteChange();

  assert.equal(pc.editor.mergeParent, ours);

  await pc.autosave();

  const merged = serverState.version(pc.head()!)!;
  assert.equal(merged.parentId, phone.head());
  assert.equal(merged.mergeParentId, ours);
  assert.equal(pc.editor.mergeParent, null, 'it is not recorded twice');
});

test('both devices converge on the merged text', async () => {
  const { pc, phone, note } = await twoDevices('middle\n');

  phone.type('top\nmiddle\n');
  await phone.autosave();

  pc.type('middle\nbottom\n');
  await pc.remoteChange();
  await pc.autosave();

  await phone.remoteChange();

  assert.equal(phone.editor.text, pc.editor.text);
  assert.equal(phone.editor.text, 'top\nmiddle\nbottom\n');
  assert.equal(phone.head(), pc.head());
  assert.equal(phone.text(note.id), pc.text(note.id));
});

test('a merge is not re-merged when it comes back round', async () => {
  const { pc, phone } = await twoDevices('middle\n');

  phone.type('top\nmiddle\n');
  await phone.autosave();
  pc.type('middle\nbottom\n');
  await pc.remoteChange();
  await pc.autosave();

  await phone.remoteChange();
  const settled = phone.editor.text;

  await phone.remoteChange();
  await pc.remoteChange();

  assert.equal(phone.editor.text, settled);
  assert.equal(pc.editor.text, settled);
  assert.equal(phone.editor.conflicted, false);
});

// --- the fast-forward rule -----------------------------------------------------------------------

test('the remote head descends from the baseline when a fast-forward is correct', async () => {
  const { pc, phone, note } = await twoDevices();

  const base = pc.editor.baseline!;
  phone.type('line one\nfrom the phone\n');
  await phone.autosave();

  await pc.pull();
  await pc.ensureNote(note.id);

  // This is the question `reconcile` never asks, and the whole of the next test is about what
  // happens when the answer is no.
  assert.equal(descendsFrom(pc.store, note.id, pc.head()!, base), true);
});

/**
 * KNOWN BUG. This test fails, and is meant to: it asserts what the client should do.
 *
 * VaultPage.tsx:350 fast-forwards whenever the editor has nothing unsaved, without asking
 * whether the remote head descends from the baseline. Two siblings are a fork, and adopting one
 * of them silently drops the other. The fix is a descendant check before that branch, falling
 * through to the merge below it when the answer is no.
 */
test('a saved local edit is merged, not discarded, when the remote head is a sibling', async () => {
  const { pc, phone, note } = await twoDevices('line one\n');

  // The computer edits and saves. Nothing is unsaved afterwards.
  pc.type('line one\ncomputer edit\n');
  await pc.autosave();
  const ours = pc.head()!;
  assert.equal(pc.editor.status, 'saved');

  // The phone was offline and never saw that. It saves a sibling.
  phone.type('line one\nphone edit\n');
  await phone.autosave();

  assert.equal(descendsFrom(phone.store, note.id, phone.head()!, ours), false, 'it forked');

  // The computer is told the vault moved.
  await pc.remoteChange();

  assert.match(pc.editor.text, /computer edit/, "the computer's own saved edit survived");
  assert.match(pc.editor.text, /phone edit/, "the phone's edit arrived");
});

/**
 * KNOWN BUG. This test fails, and is meant to: it asserts what the client should do.
 *
 * Same cause as above. This is the worst shape of it: the two edits are to one line, so the
 * correct outcome is conflict markers the user resolves. Instead one version is adopted whole
 * and nothing on screen says the other existed.
 */
test('two saved edits to the same line conflict rather than one winning silently', async () => {
  const { pc, phone } = await twoDevices('the line\n');

  pc.type('the computer rewrote it\n');
  await pc.autosave();

  phone.type('the phone rewrote it\n');
  await phone.autosave();

  await pc.remoteChange();

  assert.equal(pc.editor.conflicted, true);
  assert.match(pc.editor.text, /the computer rewrote it/);
});

test('the discarded branch still exists in history', async () => {
  const { pc, phone, note } = await twoDevices('line one\n');

  pc.type('line one\ncomputer edit\n');
  await pc.autosave();
  const ours = pc.head()!;

  phone.type('line one\nphone edit\n');
  await phone.autosave();

  await pc.remoteChange();

  // Even with the bug above, nothing is destroyed: the version is append-only and the branch is
  // still on the server. It is reachable from the history panel, which is why this is a bug about
  // what the editor shows rather than about data loss on disk.
  assert.equal(pc.store.materialise(ours), 'line one\ncomputer edit\n');
  assert.equal(serverState.versionsOf(note.id).length, 3);
});

// --- being offline --------------------------------------------------------------------------------

test('a save made while offline fails and changes nothing on the server', async () => {
  const { pc, note } = await twoDevices();
  const head = pc.head();

  pc.online = false;
  pc.type('line one\nwritten in a tunnel\n');
  await pc.autosave();

  assert.match(pc.editor.error!, /Could not reach the server/);
  assert.equal(serverState.note(note.id)!.headVersionId, head);
  assert.equal(serverState.versionsOf(note.id).length, 1);
});

/**
 * Found on a real phone, not here: the indicator said "Saved" over text that was not saved.
 *
 * `VaultPage` set the text without touching the status, so the editor kept saying "Saved" for the
 * whole of a pending request - and a request from a device that has just lost its connection hangs
 * rather than failing, so that was not a flicker, it was minutes. The harness did not catch it
 * because its `type()` set the status itself instead of calling what the app calls. Both go through
 * `typed` now, which is the only reason this test means anything.
 */
test('the indicator stops saying Saved the moment the text differs from the server', async () => {
  const { pc } = await twoDevices();

  assert.equal(pc.editor.status, 'saved');

  pc.type('line one\nnot on the server yet\n');

  assert.equal(pc.editor.status, 'saving');
  assert.equal(pc.unsaved(), true);
});

test('a save that is still in flight never reads as saved', async () => {
  const { pc } = await twoDevices();

  // A request that never answers, which is what a connection lost mid-save actually does.
  pc.online = false;
  let released: () => void = () => {};
  const hang = new Promise<void>((resolve) => {
    released = resolve;
  });

  pc.type('line one\nwritten into the void\n');
  const saving = (async () => {
    await hang;
    await pc.autosave();
  })();

  assert.equal(pc.editor.status, 'saving', 'while the request is outstanding');

  released();
  await saving;

  assert.equal(pc.editor.status, 'offline', 'once it has failed');
});

test('a pull made while offline fails and leaves the cursor alone', async () => {
  const { phone } = await twoDevices();
  const cursor = phone.store.cursor;

  phone.online = false;
  await assert.rejects(() => phone.pull(), /Could not reach the server/);

  assert.equal(phone.store.cursor, cursor);
});

/**
 * KNOWN BUG. This test fails, and is meant to: it asserts what the client should do.
 *
 * VaultPage.tsx:473-484. The indicator is `dirty ? "Saving" : "Saved"` and the failure path sets
 * an error banner without clearing `dirty`, so it reads "Saving" for as long as the app is open.
 * `api.ts:84-91` already distinguishes an unreachable server (ApiError, status 0) from every
 * other failure, so the information needed for a third state is there and unused.
 */
test('a device that cannot reach the server says so instead of saying it is saving', async () => {
  const { pc } = await twoDevices();

  pc.online = false;
  pc.type('line one\nwritten in a tunnel\n');
  await pc.autosave();

  assert.equal(pc.editor.status, 'offline', 'it is not saving - it cannot reach the server');
});

/**
 * KNOWN BUG. This test fails, and is meant to: it asserts what the client should do.
 *
 * Nothing retries. The autosave is a `useEffect` keyed on [text, selected, store,
 * pendingMergeParent], none of which change when a save rejects, so the next attempt waits for
 * the user to type. Reconnecting the sync socket does not trigger one either.
 */
test('a save that failed is retried when the network comes back', async () => {
  const { pc, note } = await twoDevices();

  pc.online = false;
  pc.type('line one\nwritten in a tunnel\n');
  await pc.autosave();

  // Nothing typed, nothing opened - just the network returning.
  pc.online = true;
  await pc.settled();

  assert.equal(serverState.versionsOf(note.id).length, 2, 'the edit reached the server');
});

/**
 * KNOWN BUG. This test fails, and is meant to: it asserts what the client should do.
 *
 * There is no local queue and no draft. `saveNote` is write-through: only a version the server
 * acknowledged reaches `vaultCache`, so an edit whose save failed lives solely in reads and not
 * yet of writes.
 */
test('an edit made offline survives the app being closed and reopened', async () => {
  const vault = newVault();
  const pc = new Device(vault, key, 'pc');
  const note = await pc.createNote('Shared', 'line one\n');
  await pc.open(note.id);

  pc.online = false;
  pc.type('line one\nwritten in a tunnel\n');
  await pc.autosave();

  // The app is closed and opened again: a new store, and the network is back.
  const restarted = new Device(vault, key, 'pc-restarted');
  await restarted.pull();
  await restarted.open(note.id);

  assert.match(restarted.editor.text, /written in a tunnel/);
});

/**
 * KNOWN BUG. This test fails, and is meant to: it asserts what the client should do.
 *
 * Two causes. `sync.ts:27-29` resets the backoff on reopen and pulls nothing, so a device that
 * was offline never learns what it missed - the socket carries notifications, not a replayable
 * log. And `saveNote` (store.ts:657) parents on the local head without asking. Together they
 * turn every reconnect into a fork.
 */
test('a device that reconnects parents its save on what the server actually holds', async () => {
  const { pc, phone, note } = await twoDevices('line one\n');

  phone.online = false;
  phone.type('line one\nphone edit\n');
  await phone.autosave();

  pc.type('line one\ncomputer edit\n');
  await pc.autosave();
  const serverHead = serverState.note(note.id)!.headVersionId!;

  // The network comes back and the phone saves.
  phone.online = true;
  await phone.settled();

  assert.equal(
    descendsFrom(phone.store, note.id, phone.head()!, serverHead),
    true,
    'the version written descends from what the server held',
  );
});

test('pulling before saving produces a child rather than a fork', async () => {
  const { pc, phone, note } = await twoDevices('line one\n');

  phone.online = false;
  phone.type('line one\nphone edit\n');
  await phone.autosave();

  pc.type('line one\ncomputer edit\n');
  await pc.autosave();
  const serverHead = serverState.note(note.id)!.headVersionId!;

  // The same reconnect. `resync` pulls, merges and sends, in that order - the order is what stops
  // it forking.
  phone.online = true;
  await phone.settled();

  assert.equal(descendsFrom(phone.store, note.id, phone.head()!, serverHead), true);
  assert.match(phone.editor.text, /computer edit/);
  assert.match(phone.editor.text, /phone edit/);

  await pc.remoteChange();
  assert.equal(pc.editor.text, phone.editor.text);
});

test('two rounds of offline editing still converge when each reconnect pulls', async () => {
  const { pc, phone, note } = await twoDevices('start\n');

  for (const round of [1, 2]) {
    phone.online = false;
    phone.type(`${phone.editor.text}phone ${round}\n`);
    await phone.autosave();

    pc.type(`${pc.editor.text}computer ${round}\n`);
    await pc.autosave();

    phone.online = true;
    await phone.settled();
    await pc.remoteChange();
  }

  assert.equal(pc.editor.text, phone.editor.text);
  for (const marker of ['phone 1', 'phone 2', 'computer 1', 'computer 2']) {
    assert.match(pc.editor.text, new RegExp(marker), `${marker} survived`);
  }
  assert.equal(pc.text(note.id), phone.text(note.id));
});

// --- more than two devices ------------------------------------------------------------------------

test('three devices editing the same note all converge', async () => {
  const vault = newVault();
  const pc = new Device(vault, key, 'pc');
  const note = await pc.createNote('Shared', 'middle\n');
  await pc.open(note.id);

  const phone = new Device(vault, key, 'phone');
  const tablet = new Device(vault, key, 'tablet');
  for (const device of [phone, tablet]) {
    await device.pull();
    await device.open(note.id);
  }

  pc.type('top\nmiddle\n');
  phone.type('middle\nbottom\n');
  tablet.type('middle\nthe very bottom\n');

  // Each writes in turn, pulling and merging first, which is what a correct client would do.
  for (const device of [pc, phone, tablet]) {
    await device.remoteChange();
    await device.autosave();
  }
  for (const device of [pc, phone, tablet]) {
    await device.remoteChange();
  }

  assert.equal(phone.editor.text, pc.editor.text);
  assert.equal(tablet.editor.text, pc.editor.text);
  for (const marker of ['top', 'bottom', 'the very bottom']) {
    assert.match(pc.editor.text, new RegExp(marker));
  }
});

// --- edits crossing other kinds of change ---------------------------------------------------------

test('an edit and a rename on different devices both survive', async () => {
  const { pc, phone, note } = await twoDevices('body\n');

  await phone.rename(note.id, 'Archive/Filed away');

  pc.type('body\nmore body\n');
  await pc.remoteChange();
  await pc.autosave();

  assert.equal(pc.store.pathOf(note.id), 'Archive/Filed away', 'the rename survived');
  assert.equal(pc.text(note.id), 'body\nmore body\n', 'the edit survived');

  await phone.remoteChange();
  assert.equal(phone.editor.text, 'body\nmore body\n');
});

test('a rename does not make the editor think the note moved', async () => {
  const { pc, phone, note } = await twoDevices('body\n');

  const baseline = pc.editor.baseline;
  await phone.rename(note.id, 'Elsewhere/Renamed');
  await pc.remoteChange();

  // History records what a note said, not where it was filed, so a rename appends no version and
  // reconcile has nothing to do.
  assert.equal(pc.editor.baseline, baseline);
  assert.equal(pc.editor.text, 'body\n');
});

test('a device learns a note was deleted elsewhere', async () => {
  const { pc, phone, note } = await twoDevices('body\n');

  await phone.deleteNote(note.id);

  pc.type('body\nstill typing\n');
  await pc.remoteChange();

  assert.equal(pc.store.getNote(note.id)?.deleted, true);
  assert.equal(pc.store.listNotes().length, 0, 'it is gone from the tree');
});

/**
 * KNOWN BUG. This test fails, and is meant to: it asserts what the client should do.
 *
 * Nothing checks `deleted` on the way into a save. `reconcile` (VaultPage.tsx:328) only looks at
 * the head version, the note stays selected because the editor is not told it vanished, and the
 * autosave appends to the tombstoned row perfectly happily - the server does not check either.
 * The indicator then reads "Saved" for text filed under a note that is no longer in the tree and
 * cannot be opened again. Whatever the right answer is - refuse the save, or offer to bring the
 * note back - writing it somewhere invisible and calling it saved is not it.
 */
test('typing into a note deleted elsewhere does not silently write into a tombstone', async () => {
  const { pc, phone, note } = await twoDevices('body\n');

  await phone.deleteNote(note.id);

  pc.type('body\nstill typing\n');
  await pc.remoteChange();
  await pc.autosave();

  const invisible = pc.store.getNote(note.id)?.deleted === true
    && serverState.versionsOf(note.id).length > 1;
  assert.equal(invisible, false, 'the edit was not written into a note nobody can see');
});

test('a change to one note leaves another note alone', async () => {
  const { pc, phone } = await twoDevices('first note\n');

  const second = await pc.createNote('Second', 'second note\n');
  await phone.pull();
  await phone.open(second.id);

  // The computer edits the first note; the phone has the second one open.
  pc.type('first note\nedited\n');
  await pc.autosave();

  const before = phone.editor.text;
  await phone.remoteChange();

  assert.equal(phone.editor.text, before);
  assert.equal(phone.editor.baseline, phone.head(second.id));
});

// --- data preservation ----------------------------------------------------------------------------

test('a merged document round trips through the store byte for byte', async () => {
  const { pc, phone, note } = await twoDevices('middle\n');

  phone.type('top\r\nmiddle\n');
  await phone.autosave();

  pc.type('middle\nbottom with an emoji and combining marks\n');
  await pc.remoteChange();
  await pc.autosave();

  const written = pc.editor.text;

  const fresh = new Device(newVault(), key, 'fresh');
  await fresh.pull();
  await fresh.open(note.id);

  assert.equal(fresh.editor.text, written);
});

test('a conflicted document is stored and reloaded with its markers intact', async () => {
  const { pc, phone, note } = await twoDevices('the line\n');

  phone.type('the phone rewrote it\n');
  await phone.autosave();

  pc.type('the computer rewrote it\n');
  await pc.remoteChange();
  assert.equal(pc.editor.conflicted, true);
  await pc.autosave();

  const stored = pc.editor.text;

  const fresh = new Device(newVault(), key, 'fresh');
  await fresh.pull();
  await fresh.open(note.id);

  assert.equal(fresh.editor.text, stored);
  assert.match(fresh.editor.text, /<<<<<<</);
});

test('every version of a forked history is still readable from a fresh device', async () => {
  const { pc, phone, note } = await twoDevices('start\n');

  pc.type('start\ncomputer\n');
  await pc.autosave();
  phone.type('start\nphone\n');
  await phone.autosave();

  await pc.remoteChange();
  pc.editor.text = 'start\ncomputer\nphone\n';
  await pc.autosave();

  const fresh = new Device(newVault(), key, 'fresh');
  await fresh.pull();

  // Opening a note now brings only the chain that rebuilds its current text, so a test that reads
  // the whole history has to ask for the whole history - as the version panel does when a version
  // is picked out of it.
  await fresh.ensureHistory(note.id);

  for (const version of fresh.store.historyOf(note.id)) {
    assert.doesNotThrow(() => fresh.store.materialise(version.id), `version ${version.id}`);
  }
});
