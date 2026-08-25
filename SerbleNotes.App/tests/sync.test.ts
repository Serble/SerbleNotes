/**
 * The sync engine: pulling, cursors, downloading bodies, and appending to the version DAG.
 *
 * This is `services/store.ts` driven against `support/fakeServer.ts`, with the real Rust core doing
 * the crypto and the diffing. Nothing here is about the merge decision - that is `merge.test.ts`.
 * What is tested here is the machinery that decision depends on being right about: that a delta pull
 * is really a delta, that a cursor never claims to have seen more than it has, and that a note whose
 * ciphertext is not on this device fails loudly rather than reading as empty.
 *
 * A note on what these tests are worth. The core's own suite proves `seal`, `make_diff` and `merge3`
 * are correct; `tests/lifecycle.rs` proves an algorithm shaped like the store's preserves text. What
 * neither can prove is that the TypeScript actually implements that algorithm, because both are
 * Rust. That gap is what this file is for.
 */
import './support/core';

import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { newVaultKey } from '../src/core';
import { Device, newVault } from './support/device';
import { calls, resetServer, serverState } from './support/fakeServer';
import { resetStorage } from './support/storage';

let key: string;

beforeEach(() => {
  resetServer();
  resetStorage();
  key = newVaultKey();
});

/** A device with one note in it, opened, plus a second device that has never seen the vault. */
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

// --- pulling ------------------------------------------------------------------------------------

test('a device that has never seen the vault pulls its notes', async () => {
  const vault = newVault();
  const pc = new Device(vault, key);
  await pc.createNote('Work/Notes', 'hello\n');
  await pc.createNote('Top level', 'also hello\n');

  const phone = new Device(vault, key);
  assert.equal(phone.store.listNotes().length, 0);

  await phone.pull();

  assert.equal(phone.store.listNotes().length, 2);
  assert.deepEqual(
    phone.store.listNotes().map((note) => phone.store.pathOf(note.id)).sort(),
    ['Top level', 'Work/Notes'],
  );
});

test('a pull brings metadata only - the ciphertext is left on the server', async () => {
  const { note } = await twoDevices();

  const fresh = new Device(newVault(), key);
  await fresh.pull();

  assert.equal(fresh.store.hasChain(fresh.store.headOf(note.id)), false);
  assert.throws(() => fresh.store.textOf(note.id), /still downloading/);
});

test('a second pull is a delta and brings nothing back', async () => {
  const { phone } = await twoDevices();

  const before = phone.store.cursor;
  calls.changes = 0;
  await phone.pull();

  assert.equal(phone.store.cursor, before, 'the cursor did not move');
  assert.equal(calls.changes, 1, 'it still asked');
});

test('a pull moves the cursor to the highest row it was given', async () => {
  const { pc, phone } = await twoDevices();

  pc.type('line one\nsecond\n');
  await pc.autosave();

  await phone.pull();

  assert.equal(phone.store.cursor, serverState.cursor());
});

test('a pull never moves the cursor backwards', async () => {
  const { pc, phone } = await twoDevices();

  pc.type('line one\nsecond\n');
  await pc.autosave();
  await phone.pull();

  const reached = phone.store.cursor;
  await phone.pull();
  await phone.pull();

  assert.equal(phone.store.cursor, reached);
});

test('a metadata pull does not destroy ciphertext the device already holds', async () => {
  const { pc, phone, note } = await twoDevices();

  // The phone has the bodies for this note.
  assert.equal(phone.store.hasChain(phone.store.headOf(note.id)), true);
  const text = phone.store.textOf(note.id);

  // The computer writes; the phone pulls metadata, which describes versions with `payload: null`.
  pc.type('line one\nsecond\n');
  await pc.autosave();
  await phone.pull();

  // The version it already had must still be readable. If a null payload had overwritten a real
  // one, the note would silently become unreadable until it was downloaded again.
  assert.equal(phone.store.materialise(phone.editor.baseline!), text);
});

// --- fetching bodies ----------------------------------------------------------------------------

test('ensureNote downloads the bodies and makes the note readable', async () => {
  const { note } = await twoDevices('the body\n');

  const fresh = new Device(newVault(), key);
  await fresh.pull();
  assert.throws(() => fresh.store.textOf(note.id));

  await fresh.ensureNote(note.id);

  assert.equal(fresh.store.textOf(note.id), 'the body\n');
});

test('ensureNote does not move the cursor', async () => {
  const { note } = await twoDevices();

  const fresh = new Device(newVault(), key);
  await fresh.pull();
  const cursor = fresh.store.cursor;

  await fresh.ensureNote(note.id);

  // The rows a body fetch returns are already accounted for by the pull that named them. Moving the
  // cursor here would claim to have seen changes this device has not.
  assert.equal(fresh.store.cursor, cursor);
});

test('two callers opening the same note at once make one request', async () => {
  const { note } = await twoDevices();

  const fresh = new Device(newVault(), key);
  await fresh.pull();
  calls.noteVersionsByIds = 0;

  await Promise.all([fresh.ensureNote(note.id), fresh.ensureNote(note.id), fresh.ensureNote(note.id)]);

  assert.equal(calls.noteVersionsByIds, 1);
});

test('ensureNote is a no-op once the bodies are here', async () => {
  const { phone, note } = await twoDevices();
  calls.noteVersions = 0;
  calls.noteVersionsByIds = 0;

  await phone.ensureNote(note.id);

  assert.equal(calls.noteVersions + calls.noteVersionsByIds, 0);
});

test('a missing body throws rather than reading as empty', async () => {
  const { note } = await twoDevices('real content\n');

  const fresh = new Device(newVault(), key);
  await fresh.pull();

  // This is the single most dangerous "" in the client: text is what the next autosave diffs
  // against, so a note that opened blank would be saved blank.
  assert.throws(() => fresh.store.textOf(note.id), /still downloading/);
});

// --- appending ----------------------------------------------------------------------------------

test('the first version of a note is a full snapshot with no parent', async () => {
  const { note } = await twoDevices('first\n');

  const [initial] = serverState.versionsOf(note.id);

  assert.equal(initial.parentId, null);
  assert.equal(initial.isSnapshot, true);
});

test('saving parents the new version on the local head', async () => {
  const { pc } = await twoDevices();

  const before = pc.head();
  pc.type('line one\nsecond\n');
  await pc.autosave();

  const head = serverState.version(pc.head()!)!;
  assert.equal(head.parentId, before);
});

test('saving unchanged text writes nothing', async () => {
  const { pc, note } = await twoDevices();
  const before = serverState.versionsOf(note.id).length;

  pc.type(pc.text());
  await pc.autosave();

  assert.equal(serverState.versionsOf(note.id).length, before);
  assert.equal(pc.editor.status, 'saved');
});

test('a named restore point is written even when the text has not changed', async () => {
  const { pc, note } = await twoDevices();
  const before = serverState.versionsOf(note.id).length;

  await pc.store.saveNote(note.id, pc.text(), { isNamed: true, label: 'before the rewrite' });

  const versions = serverState.versionsOf(note.id);
  assert.equal(versions.length, before + 1);

  const named = versions.find((v) => v.isNamed)!;
  assert.equal(named.isSnapshot, true, 'a place someone will come back to is stored whole');
  assert.equal(pc.store.labelOf(named), 'before the rewrite');
});

test('saving does not move the cursor', async () => {
  const { pc } = await twoDevices();
  const before = pc.store.cursor;

  pc.type('line one\nsecond\n');
  await pc.autosave();

  // This version's own cursor says where it landed, not that this device has seen everything below
  // it. Only `pull` knows that, so only `pull` moves it.
  assert.equal(pc.store.cursor, before);
});

test('a long editing session rebuilds every version exactly', async () => {
  const { pc, note } = await twoDevices('0\n');

  const written: string[] = [pc.text()];
  for (let i = 1; i <= 40; i += 1) {
    pc.type(`${written[written.length - 1]}${i}\n`);
    await pc.autosave();
    written.push(pc.editor.text);
  }

  const history = pc.store.historyOf(note.id).reverse();
  assert.equal(history.length, written.length);
  history.forEach((version, index) => {
    assert.equal(pc.store.materialise(version.id), written[index], `version ${index}`);
  });
});

test('the snapshot cadence bounds the replay chain', async () => {
  const { pc, note } = await twoDevices('0\n');

  for (let i = 1; i <= 40; i += 1) {
    pc.type(`${pc.editor.text}${i}\n`);
    await pc.autosave();
  }

  const versions = serverState.versionsOf(note.id).sort((a, b) => a.cursor - b.cursor);
  let sinceSnapshot = 0;
  let worst = 0;
  for (const version of versions) {
    sinceSnapshot = version.isSnapshot ? 0 : sinceSnapshot + 1;
    worst = Math.max(worst, sinceSnapshot);
  }

  assert.ok(worst <= 10, `longest diff chain was ${worst}`);
});

test('opening a note downloads its chain, not its history', async () => {
  const { pc, note } = await twoDevices('0\n');

  // A long session, so "the whole history" and "enough to open it" are very different amounts.
  for (let i = 1; i <= 40; i += 1) {
    pc.type(`${pc.editor.text}${i}\n`);
    await pc.autosave();
  }

  const fresh = new Device(newVault(), key, 'fresh');
  await fresh.pull();
  calls.versionIdsFetched.length = 0;
  calls.noteVersions = 0;

  await fresh.ensureNote(note.id);

  const stored = serverState.versionsOf(note.id).length;
  assert.ok(stored > 20, `the history should be long for this to mean anything, was ${stored}`);
  assert.equal(calls.noteVersions, 0, 'it never asked for the whole note');

  // At most a snapshot plus the diffs after it - the same bound `SNAPSHOT_EVERY` puts on a replay.
  assert.ok(
    calls.versionIdsFetched.length <= 11,
    `fetched ${calls.versionIdsFetched.length} versions to open one note`,
  );
  assert.ok(calls.versionIdsFetched.length < stored, 'and fewer than the history holds');

  assert.equal(fresh.store.textOf(note.id), pc.editor.text, 'and the note still opens correctly');
});

test('every version it downloaded is one the replay actually reads', async () => {
  const { pc, note } = await twoDevices('0\n');

  for (let i = 1; i <= 25; i += 1) {
    pc.type(`${pc.editor.text}${i}\n`);
    await pc.autosave();
  }

  const fresh = new Device(newVault(), key, 'fresh');
  await fresh.pull();
  calls.versionIdsFetched.length = 0;
  await fresh.ensureNote(note.id);

  // Walk the chain the way `materialise` does and check the two lists are the same set. A fetch
  // that brought anything else is downloading bytes it will not read; one that brought less would
  // have thrown above.
  const known = new Map(fresh.store.historyOf(note.id).map((version) => [version.id, version]));
  const walked: string[] = [];
  let current = known.get(fresh.store.headOf(note.id)!);
  while (current && !current.isSnapshot) {
    walked.push(current.id);
    current = current.parentId ? known.get(current.parentId) : undefined;
  }
  assert.ok(current, 'the chain reached a snapshot');
  walked.push(current!.id);

  assert.deepEqual([...calls.versionIdsFetched].sort(), walked.sort());
});

test('reading an old version fetches only what that version needs', async () => {
  const { pc, note } = await twoDevices('0\n');

  for (let i = 1; i <= 30; i += 1) {
    pc.type(`${pc.editor.text}${i}\n`);
    await pc.autosave();
  }

  const fresh = new Device(newVault(), key, 'fresh');
  await fresh.pull();
  await fresh.ensureNote(note.id);

  // The oldest version, which the head's chain cannot have reached.
  const oldest = fresh.store.historyOf(note.id).at(-1)!;
  assert.throws(() => fresh.store.materialise(oldest.id), /still downloading/);

  calls.versionIdsFetched.length = 0;
  calls.noteVersions = 0;
  await fresh.ensureVersions([oldest.id]);

  assert.equal(calls.noteVersions, 0, 'still not the whole note');
  assert.ok(calls.versionIdsFetched.length <= 11, 'just that version\'s own chain');
  assert.doesNotThrow(() => fresh.store.materialise(oldest.id));
});

test('a version already on the device is not fetched again', async () => {
  const { pc, note } = await twoDevices('0\n');

  for (let i = 1; i <= 15; i += 1) {
    pc.type(`${pc.editor.text}${i}\n`);
    await pc.autosave();
  }

  const fresh = new Device(newVault(), key, 'fresh');
  await fresh.pull();
  await fresh.ensureNote(note.id);

  calls.versionIdsFetched.length = 0;
  calls.noteVersionsByIds = 0;
  await fresh.ensureNote(note.id);

  assert.equal(calls.noteVersionsByIds, 0, 'nothing was missing, so nothing was asked for');
  assert.deepEqual(calls.versionIdsFetched, []);
});

test('another device can read every version of a session it did not write', async () => {
  const { pc, phone, note } = await twoDevices('0\n');

  const written: string[] = [pc.text()];
  for (let i = 1; i <= 25; i += 1) {
    pc.type(`${written[written.length - 1]}${i}\n`);
    await pc.autosave();
    written.push(pc.editor.text);
  }

  await phone.pull();
  await phone.ensureHistory(note.id);

  const history = phone.store.historyOf(note.id).reverse();
  history.forEach((version, index) => {
    assert.equal(phone.store.materialise(version.id), written[index], `version ${index}`);
  });
});

test('history comes back newest first', async () => {
  const { pc, note } = await twoDevices();

  pc.type('line one\ntwo\n');
  await pc.autosave();
  pc.type('line one\ntwo\nthree\n');
  await pc.autosave();

  const history = pc.store.historyOf(note.id);
  assert.deepEqual(
    history.map((v) => v.cursor),
    [...history.map((v) => v.cursor)].sort((a, b) => b - a),
  );
});

test('restoring writes the old text forward instead of rewriting history', async () => {
  const { pc, note } = await twoDevices('original\n');

  const first = pc.head()!;
  pc.type('rewritten\n');
  await pc.autosave();
  const second = pc.head()!;

  await pc.restore(note.id, first);

  assert.equal(pc.text(), 'original\n');
  assert.notEqual(pc.head(), first, 'restoring made a new version');
  assert.equal(pc.store.materialise(second), 'rewritten\n', 'the version restored away from survives');
  assert.equal(serverState.versionsOf(note.id).length, 3);
});

// --- names, deletes, tombstones -----------------------------------------------------------------

test('renaming appends no version', async () => {
  const { pc, note } = await twoDevices();
  const before = serverState.versionsOf(note.id).length;

  await pc.rename(note.id, 'Work/Renamed');

  assert.equal(serverState.versionsOf(note.id).length, before);
  assert.equal(pc.store.pathOf(note.id), 'Work/Renamed');
});

test('renaming does not change the head or the text', async () => {
  const { pc, note } = await twoDevices('body\n');
  const head = pc.head();

  await pc.rename(note.id, 'Elsewhere/Moved');

  assert.equal(pc.head(), head);
  assert.equal(pc.text(), 'body\n');
});

test('a rename reaches the other device', async () => {
  const { pc, phone, note } = await twoDevices();

  await pc.rename(note.id, 'Archive/Filed away');
  await phone.pull();

  assert.equal(phone.store.pathOf(note.id), 'Archive/Filed away');
});

test('a delete reaches an offline device as a tombstone when it comes back', async () => {
  const { pc, phone, note } = await twoDevices();

  phone.online = false;
  await pc.deleteNote(note.id);

  assert.equal(phone.store.listNotes().length, 1, 'it does not know yet');

  phone.online = true;
  await phone.pull();

  assert.equal(phone.store.listNotes().length, 0);
  assert.equal(phone.store.getNote(note.id)?.deleted, true, 'the row is still there, marked');
});

test('a deleted note keeps its history on the server', async () => {
  const { pc, note } = await twoDevices();

  pc.type('line one\nmore\n');
  await pc.autosave();
  await pc.deleteNote(note.id);

  assert.equal(serverState.versionsOf(note.id).length, 2);
});

// --- ancestry -----------------------------------------------------------------------------------

test('commonAncestor on a straight line is the older version', async () => {
  const { pc } = await twoDevices();

  const first = pc.head()!;
  pc.type('line one\ntwo\n');
  await pc.autosave();
  const second = pc.head()!;

  assert.equal(pc.store.commonAncestor(first, second), first);
});

test('commonAncestor finds where two branches forked', async () => {
  const { pc, phone, note } = await twoDevices();

  const fork = pc.head()!;

  pc.type('line one\nfrom the computer\n');
  await pc.autosave();

  phone.type('line one\nfrom the phone\n');
  await phone.autosave();

  await pc.pull();
  await pc.ensureNote(note.id);

  assert.equal(pc.store.commonAncestor(fork, phone.head()!), fork);
  assert.equal(pc.store.commonAncestor(pc.editor.baseline!, phone.head()!), fork);
});

test('commonAncestor follows a merge parent as well as a parent', async () => {
  const { pc, phone, note } = await twoDevices();

  const fork = pc.head()!;

  pc.type('line one\ncomputer\n');
  await pc.autosave();
  const pcBranch = pc.head()!;

  phone.type('line one\nphone\n');
  await phone.autosave();

  // The computer merges the fork and writes a version recording both parents.
  await pc.remoteChange();
  assert.equal(pc.editor.mergeParent, pcBranch, 'the branch it merged from');
  await pc.autosave();

  const merged = serverState.version(pc.head()!)!;
  assert.equal(merged.mergeParentId, pcBranch, 'both parents were recorded');

  await phone.pull();
  await phone.ensureNote(note.id);
  assert.equal(phone.store.commonAncestor(pcBranch, pc.head()!), pcBranch);
});

test('commonAncestor returns null for versions from different notes', async () => {
  const { pc } = await twoDevices();

  const other = await pc.createNote('Unrelated', 'nothing to do with it\n');
  await pc.ensureNote(other.id);

  assert.equal(pc.store.commonAncestor(pc.head()!, pc.store.headOf(other.id)!), null);
});
