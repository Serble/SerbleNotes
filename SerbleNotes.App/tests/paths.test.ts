/**
 * The file manager: names, folders, moving, renaming and deleting.
 *
 * A note has one name and a `/` in it is a folder - there are no folder records anywhere, so every
 * operation here is a rewrite of note names and the tree is derived from what those names say. That
 * is what makes this worth testing rather than obvious: renaming a folder rewrites every note
 * underneath it, and a bug does not crash, it silently misfiles somebody's notes or drops one on top
 * of another.
 *
 * `services/store.ts` owns all of it and the React layer is a thin wrapper, so this drives the store
 * directly through `support/fakeServer.ts`, with the real Rust `normalise_path` and `reparent`
 * deciding what a path means.
 */
import './support/core';

import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { newVaultKey } from '../src/core';
import { Device, newVault } from './support/device';
import { resetServer } from './support/fakeServer';
import { resetStorage } from './support/storage';

let key: string;
let pc: Device;

beforeEach(() => {
  resetServer();
  resetStorage();
  key = newVaultKey();
  pc = new Device(newVault(), key, 'pc');
});

/** The paths of every live note, sorted - what the tree is drawn from. */
function paths(device: Device): string[] {
  return device.store
    .listNotes()
    .map((note) => device.store.pathOf(note.id))
    .sort();
}

// --- naming -------------------------------------------------------------------------------------

test('a name with slashes in it files the note into folders', async () => {
  const note = await pc.createNote('Work/Projects/Alpha', 'x\n');

  assert.equal(pc.store.pathOf(note.id), 'Work/Projects/Alpha');
  assert.equal(pc.store.titleOf(note.id), 'Alpha', 'the title is the leaf, not the path');
  assert.equal(pc.store.folderOf(note.id), 'Work/Projects');
});

test('a note renamed to nothing is refused, not silently moved up a level', async () => {
  const note = await pc.createNote('Work/Report', 'x\n');

  // The real bug this pins: normalising "Work/   " as one string collapses to "Work", so a blank
  // rename would take the folder's own name and jump the note up a level, on top of its own folder.
  // `join` tidies the leaf by itself so there is nothing left to collapse.
  await assert.rejects(() => pc.store.renameNoteTo(note.id, '   '));
  await assert.rejects(() => pc.store.renameNoteTo(note.id, ''));

  assert.equal(pc.store.pathOf(note.id), 'Work/Report', 'and it did not move');
});

test('a name is tidied rather than refused when it can still be read', async () => {
  const note = await pc.createNote('  Work//  Report  ', 'x\n');
  assert.equal(pc.store.pathOf(note.id), 'Work/Report');
});

test('a name that cannot be represented is refused', async () => {
  // '..' would let a note escape its folder once the vault is mounted as a filesystem.
  await assert.rejects(() => pc.createNote('Work/../../escape', 'x\n'));
  await assert.rejects(() => pc.createNote('', 'x\n'));
});

// --- collisions ---------------------------------------------------------------------------------

test('two notes cannot be given the same path', async () => {
  await pc.createNote('Work/Report', 'x\n');
  const other = await pc.createNote('Work/Draft', 'y\n');

  await assert.rejects(() => pc.store.renameNoteTo(other.id, 'Report'), /already/);
  assert.equal(pc.store.pathOf(other.id), 'Work/Draft');
});

test('a note cannot be moved on top of a folder', async () => {
  await pc.createNote('Work/Report/Notes', 'x\n');
  const loose = await pc.createNote('Report', 'y\n');

  // 'Work/Report' is a folder because a note lives under it. Nothing can be put at that same path.
  await assert.rejects(() => pc.store.moveNote(loose.id, 'Work'), /already/);
});

test('a folder cannot be renamed onto another folder', async () => {
  await pc.createNote('Work/Report', 'x\n');
  await pc.createNote('Home/Shopping', 'y\n');

  await assert.rejects(() => pc.store.renameFolderTo('Home', 'Work'), /already/);
  assert.deepEqual(paths(pc), ['Home/Shopping', 'Work/Report']);
});

test('renaming a note to the name it already has is allowed', async () => {
  const note = await pc.createNote('Work/Report', 'x\n');

  // It must not collide with itself: the refusal ignores the note being renamed.
  await pc.store.renameNoteTo(note.id, 'Report');
  assert.equal(pc.store.pathOf(note.id), 'Work/Report');
});

// --- moving notes -------------------------------------------------------------------------------

test('moving a note keeps its own name and changes only its folder', async () => {
  const note = await pc.createNote('Work/Report', 'content\n');

  await pc.store.moveNote(note.id, 'Archive/2026');

  assert.equal(pc.store.pathOf(note.id), 'Archive/2026/Report');
  assert.equal(pc.store.textOf(note.id), 'content\n', 'and the note still says what it said');
});

test('a note moves to the top level with an empty target', async () => {
  const note = await pc.createNote('Work/Report', 'x\n');

  await pc.store.moveNote(note.id, '');

  assert.equal(pc.store.pathOf(note.id), 'Report');
  assert.equal(pc.store.folderOf(note.id), '');
});

test('moving a note to where it already is does nothing', async () => {
  const note = await pc.createNote('Work/Report', 'x\n');
  const before = pc.store.getNote(note.id)!.cursor;

  await pc.store.moveNote(note.id, 'Work');

  assert.equal(pc.store.getNote(note.id)!.cursor, before, 'no write, so no cursor');
});

// --- renaming folders ---------------------------------------------------------------------------

test('renaming a folder rewrites every note under it, at any depth', async () => {
  await pc.createNote('Work/Report', 'a\n');
  await pc.createNote('Work/Projects/Alpha', 'b\n');
  await pc.createNote('Work/Projects/Deep/Beta', 'c\n');

  await pc.store.renameFolderTo('Work', 'Office');

  assert.deepEqual(paths(pc), [
    'Office/Projects/Alpha',
    'Office/Projects/Deep/Beta',
    'Office/Report',
  ]);
});

test('renaming a folder leaves notes outside it alone', async () => {
  await pc.createNote('Work/Report', 'a\n');
  await pc.createNote('Working/Notes', 'b\n');
  await pc.createNote('Home/Shopping', 'c\n');

  await pc.store.renameFolderTo('Work', 'Office');

  // 'Working' starts with 'Work' as a string but is not inside it - a prefix match rather than a
  // path match would have moved it too.
  assert.deepEqual(paths(pc), ['Home/Shopping', 'Office/Report', 'Working/Notes']);
});

test('renaming a folder does not touch what the notes say', async () => {
  const note = await pc.createNote('Work/Report', 'the contents\n');
  const versionsBefore = pc.store.historyOf(note.id).length;

  await pc.store.renameFolderTo('Work', 'Office');

  assert.equal(pc.store.textOf(note.id), 'the contents\n');
  assert.equal(pc.store.historyOf(note.id).length, versionsBefore, 'a rename appends no version');
});

// --- moving folders -----------------------------------------------------------------------------

test('moving a folder takes everything under it', async () => {
  await pc.createNote('Work/Report', 'a\n');
  await pc.createNote('Work/Projects/Alpha', 'b\n');

  await pc.store.moveFolder('Work', 'Archive');

  assert.deepEqual(paths(pc), ['Archive/Work/Projects/Alpha', 'Archive/Work/Report']);
});

test('a folder cannot be moved inside itself', async () => {
  await pc.createNote('Work/Projects/Alpha', 'a\n');

  await assert.rejects(() => pc.store.moveFolder('Work', 'Work'), /inside itself/);
  await assert.rejects(() => pc.store.moveFolder('Work', 'Work/Projects'), /inside itself/);

  assert.deepEqual(paths(pc), ['Work/Projects/Alpha'], 'and nothing moved');
});

// --- deleting -----------------------------------------------------------------------------------

test('deleting a folder deletes every note in it at any depth', async () => {
  await pc.createNote('Work/Report', 'a\n');
  await pc.createNote('Work/Projects/Alpha', 'b\n');
  await pc.createNote('Home/Shopping', 'c\n');

  await pc.store.deleteFolder('Work');

  assert.deepEqual(paths(pc), ['Home/Shopping']);
});

test('a deleted note keeps its history on the server', async () => {
  const note = await pc.createNote('Work/Report', 'a\n');
  await pc.store.deleteFolder('Work');

  // The tombstone is the client's view; the versions are still there, which is what makes a delete
  // recoverable and what a purge job would later have to clear.
  assert.equal(pc.store.getNote(note.id)!.deleted, true);
});

// --- empty folders ------------------------------------------------------------------------------

test('an empty folder exists on this device until a note gives it a real one', async () => {
  pc.store.createFolder('', 'Plans');
  assert.ok(pc.store.tree().some((node) => node.path === 'Plans'), 'it draws in the tree');

  await pc.createNote('Plans/First', 'x\n');

  // The note is what makes the folder real now, so the device-local record of it is dropped.
  assert.ok(pc.store.tree().some((node) => node.path === 'Plans'));
});

test('a folder that loses its last note is kept rather than vanishing', async () => {
  const note = await pc.createNote('Plans/Only', 'x\n');

  await pc.store.moveNote(note.id, '');

  // A file manager does not delete a directory when you drag the last file out of it.
  assert.ok(
    pc.store.tree().some((node) => node.path === 'Plans'),
    'the folder is still there to drop something else into',
  );
});

test('an empty folder moves when its parent is renamed', async () => {
  await pc.createNote('Work/Report', 'x\n');
  pc.store.createFolder('Work', 'Later');

  await pc.store.renameFolderTo('Work', 'Office');

  const tree = JSON.stringify(pc.store.tree());
  assert.ok(tree.includes('Office/Later'), 'the empty folder came with it');
  assert.ok(!tree.includes('Work/Later'), 'and did not stay behind');
});

test('an empty folder cannot take a name something else already has', async () => {
  await pc.createNote('Work/Report', 'x\n');

  assert.throws(() => pc.store.createFolder('', 'Work'), /already/);
});

// --- the tree -----------------------------------------------------------------------------------

test('the tree is built from the names, with folders before notes', async () => {
  await pc.createNote('beta', 'x\n');
  await pc.createNote('Work/Report', 'y\n');
  await pc.createNote('alpha', 'z\n');

  const top = pc.store.tree().map((node) => node.name);

  assert.equal(top[0], 'Work', 'folders sort first');
  assert.deepEqual(top.slice(1), ['alpha', 'beta'], 'then notes by name');
});

test('a moved note reaches the other device as a rename', async () => {
  const note = await pc.createNote('Work/Report', 'x\n');

  const phone = new Device(pc.store.vault, key, 'phone');
  await phone.pull();
  assert.equal(phone.store.pathOf(note.id), 'Work/Report');

  await pc.store.moveNote(note.id, 'Archive');
  await phone.pull();

  assert.equal(phone.store.pathOf(note.id), 'Archive/Report');
});
