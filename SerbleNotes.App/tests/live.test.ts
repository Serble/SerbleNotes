/**
 * Live sync: a change arriving over the socket, with the rows attached, and no request of its own.
 *
 * The rule everything here turns on is the cursor rule, seen from the pushed side. A device may only
 * advance its cursor to a point where it has seen everything below it, and a pushed event proves one
 * write happened - not that no other write was missed while the socket was away. `absorb` says which
 * of those it is, and the tests below are mostly about it saying so correctly, because getting it
 * wrong means a delta pull that skips versions permanently.
 */
import './support/core';

import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { newVaultKey } from '../src/core';
import { Device, newVault } from './support/device';
import { broadcasts, calls, lastBroadcast, resetServer, serverState } from './support/fakeServer';
import { resetStorage } from './support/storage';

let key: string;

beforeEach(() => {
  resetServer();
  resetStorage();
  key = newVaultKey();
});

async function twoDevices(text = 'line one\n') {
  const vault = newVault();
  const pc = new Device(vault, key, 'pc');
  const note = await pc.createNote('Shared', text);
  await pc.open(note.id);

  const phone = new Device(vault, key, 'phone');
  await phone.pull();
  await phone.open(note.id);

  return { pc, phone, note, vault };
}

// --- the rows travel with the notification --------------------------------------------------------

test('a pushed change needs no request at all', async () => {
  const { pc, phone, note, vault } = await twoDevices();

  pc.type('line one\nfrom the computer\n');
  await pc.autosave();

  calls.changes = 0;
  calls.noteVersions = 0;
  await phone.pushed(lastBroadcast(vault.id));

  assert.equal(calls.changes, 0, 'it did not pull');
  assert.equal(calls.noteVersions, 0, 'it did not fetch bodies either');
  assert.equal(phone.editor.text, 'line one\nfrom the computer\n');
  assert.equal(phone.text(note.id), 'line one\nfrom the computer\n');
});

test('a pushed change advances the cursor when it follows the last one', async () => {
  const { pc, phone, vault } = await twoDevices();

  const before = phone.store.cursor;
  pc.type('line one\ntwo\n');
  await pc.autosave();

  const event = lastBroadcast(vault.id);
  assert.equal(event.cursor, before + 1, 'the write that happened is the next one along');

  await phone.pushed(event);

  assert.equal(phone.store.cursor, event.cursor);
});

test('a pushed rename arrives without a version and moves the note', async () => {
  const { pc, phone, note, vault } = await twoDevices();

  await pc.rename(note.id, 'Archive/Filed away');
  calls.changes = 0;
  await phone.pushed(lastBroadcast(vault.id));

  assert.equal(calls.changes, 0);
  assert.equal(phone.store.pathOf(note.id), 'Archive/Filed away');
});

test('a pushed delete tombstones the note', async () => {
  const { pc, phone, note, vault } = await twoDevices();

  await pc.deleteNote(note.id);
  await phone.pushed(lastBroadcast(vault.id));

  assert.equal(phone.store.listNotes().length, 0);
  assert.equal(phone.store.getNote(note.id)?.deleted, true);
});

// --- what happens when something was missed --------------------------------------------------------

test('a gap in the cursors is not absorbed as if it were complete', async () => {
  const { pc, phone, vault } = await twoDevices();

  // Two writes, but the device only sees the second - the first landed while its socket was away.
  pc.type('line one\ntwo\n');
  await pc.autosave();
  pc.type('line one\ntwo\nthree\n');
  await pc.autosave();

  const missed = lastBroadcast(vault.id);
  const complete = await phone.store.absorb(missed);

  assert.equal(complete, false, 'it knows it cannot be sure');
  assert.notEqual(phone.store.cursor, missed.cursor, 'and it did not move the cursor');
});

test('a gap makes the client pull, and it ends up correct anyway', async () => {
  const { pc, phone, note, vault } = await twoDevices();

  pc.type('line one\ntwo\n');
  await pc.autosave();
  pc.type('line one\ntwo\nthree\n');
  await pc.autosave();

  calls.changes = 0;
  await phone.pushed(lastBroadcast(vault.id));

  assert.equal(calls.changes, 1, 'it fell back to a pull');
  assert.equal(phone.store.cursor, serverState.cursor());
  assert.equal(phone.editor.text, 'line one\ntwo\nthree\n');
  assert.equal(phone.text(note.id), 'line one\ntwo\nthree\n');
});

test('the version skipped over is still readable after the fallback pull', async () => {
  const { pc, phone, note, vault } = await twoDevices();

  pc.type('line one\ntwo\n');
  await pc.autosave();
  const skipped = pc.head()!;
  pc.type('line one\ntwo\nthree\n');
  await pc.autosave();

  await phone.pushed(lastBroadcast(vault.id));
  await phone.ensureNote(note.id);

  assert.equal(phone.store.materialise(skipped), 'line one\ntwo\n');
});

test('absorbing the same event twice changes nothing the second time', async () => {
  const { pc, phone, vault } = await twoDevices();

  pc.type('line one\ntwo\n');
  await pc.autosave();
  const event = lastBroadcast(vault.id);

  await phone.pushed(event);
  const cursor = phone.store.cursor;
  const text = phone.editor.text;

  await phone.pushed(event);

  assert.equal(phone.store.cursor, cursor);
  assert.equal(phone.editor.text, text);
});

// --- pushed rows and the merge ---------------------------------------------------------------------

test('a pushed change merges into what is being typed rather than replacing it', async () => {
  const { pc, phone, vault } = await twoDevices('middle\n');

  pc.type('top\nmiddle\n');
  await pc.autosave();

  // The phone is mid-sentence and has not saved.
  phone.type('middle\nbottom\n');
  await phone.pushed(lastBroadcast(vault.id));

  assert.equal(phone.editor.text, 'top\nmiddle\nbottom\n');
  assert.equal(phone.editor.conflicted, false);
});

test('a pushed sibling is merged, not adopted', async () => {
  const { pc, phone, note, vault } = await twoDevices('line one\n');

  // Both save from the same parent, so neither branch contains the other.
  phone.online = false;
  phone.type('line one\nphone\n');
  await phone.autosave();
  phone.online = true;
  await phone.settled();

  const ours = phone.head()!;
  pc.type('line one\ncomputer\n');
  await pc.autosave();

  await phone.pushed(lastBroadcast(vault.id));

  assert.match(phone.editor.text, /phone/, 'this device kept its own work');
  assert.match(phone.editor.text, /computer/, 'and took the other side too');
  assert.equal(phone.editor.mergeParent, ours, 'the branch it merged from is recorded');
});

test('a payload too large to push is fetched instead', async () => {
  const { pc, phone, note, vault } = await twoDevices('start\n');

  // Bigger than the 256 KB the notifier will push.
  pc.type(`start\n${'x'.repeat(400 * 1024)}\n`);
  await pc.autosave();

  const event = lastBroadcast(vault.id);
  assert.equal(event.versions[0].payload, null, 'the server left it out');

  calls.noteVersions = 0;
  await phone.pushed(event);

  assert.equal(calls.noteVersions, 1, 'so the device went and got it');
  assert.equal(phone.editor.text, pc.editor.text);
});

test('a change to a note this device does not have open still updates the tree', async () => {
  const { pc, phone, vault } = await twoDevices('first\n');

  const second = await pc.createNote('Second', 'second\n');
  await phone.pushed(lastBroadcast(vault.id));

  assert.equal(phone.store.listNotes().length, 2);
  assert.deepEqual(
    phone.store.listNotes().map((n) => phone.store.pathOf(n.id)).sort(),
    ['Second', 'Shared'],
  );
  assert.equal(phone.store.getNote(second.id)?.id, second.id);
});

test('every write broadcasts exactly one event', async () => {
  const { pc, note, vault } = await twoDevices();

  const before = broadcasts.length;
  pc.type('line one\ntwo\n');
  await pc.autosave();
  await pc.rename(note.id, 'Renamed');
  await pc.deleteNote(note.id);

  const sent = broadcasts.slice(before);
  assert.equal(sent.length, 3, 'an edit, a rename and a delete');

  // Consecutive, which is what makes `absorb`'s contiguity check a sound proof rather than a guess:
  // one write reserves one cursor value, so an unbroken stream has no gaps in it.
  const cursors = sent.map((event) => event.cursor);
  assert.deepEqual(cursors, [cursors[0], cursors[0] + 1, cursors[0] + 2]);
});
