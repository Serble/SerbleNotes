/**
 * Archives: a vault is a folder of markdown files, and this is the round trip through one.
 *
 * The rules here all exist because the failure is somebody's data. An export that renames notes is
 * not a backup; an import that overwrites a note the user already had destroys the one they did not
 * pick; and every path in an archive came from outside, so `../../.ssh/authorized_keys` has to be
 * refused for the same reason a note cannot be named that.
 *
 * The zip is built and read with the real fflate and the real `archive_path` from the core, because
 * what is being tested is precisely that the two agree about what a note is called as a file.
 */
import './support/core';

import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { newVaultKey } from '../src/core';
import { buildArchive, readArchive, archiveFileName } from '../src/services/archive';
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

/** A zip holding exactly these files, as an unzipper anywhere else would have written it. */
async function zipOf(entries: Record<string, string>): Promise<Uint8Array> {
  const { zipSync, strToU8 } = await import('fflate');
  return zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)])));
}

// --- the round trip -----------------------------------------------------------------------------

test('a vault survives being written out and read back', async () => {
  await pc.createNote('Top level', 'one\n');
  await pc.createNote('Work/Report', 'two\n');
  await pc.createNote('Work/Projects/Alpha', 'three\n');

  const exported = await pc.store.exportEntries();
  const archive = await buildArchive(exported.notes, pc.store.folders());
  const read = await readArchive(archive);

  assert.deepEqual(
    read.notes.map((note) => [note.name, note.text]),
    [
      ['Top level', 'one\n'],
      ['Work/Projects/Alpha', 'three\n'],
      ['Work/Report', 'two\n'],
    ],
  );
});

test('a note called todo.md comes back as todo.md and not as todo', async () => {
  // `.md` is added on the way out and taken off on the way in, so this file is `todo.md.md`. It
  // looks wrong and it is the only mapping that is reversible - `todo` and `todo.md` are two notes.
  await pc.createNote('todo', 'plain\n');
  await pc.createNote('todo.md', 'suffixed\n');

  const exported = await pc.store.exportEntries();
  const read = await readArchive(await buildArchive(exported.notes, pc.store.folders()));

  assert.deepEqual(read.notes.map((note) => note.name).sort(), ['todo', 'todo.md']);
  assert.equal(read.notes.find((note) => note.name === 'todo.md')!.text, 'suffixed\n');
  assert.equal(read.notes.find((note) => note.name === 'todo')!.text, 'plain\n');
});

test('an empty folder is carried through the archive', async () => {
  pc.store.createFolder('', 'Later');
  await pc.createNote('Work/Report', 'x\n');

  const exported = await pc.store.exportEntries();
  const read = await readArchive(await buildArchive(exported.notes, pc.store.folders()));

  assert.ok(read.folders.includes('Later'));
  assert.ok(!read.folders.includes('Work'), 'a folder with a note in it needs no record of its own');
});

// --- reading an archive from anywhere else ------------------------------------------------------

test('a file that is not markdown still becomes a note, keeping its whole name', async () => {
  const read = await readArchive(await zipOf({ 'notes.txt': 'hello', README: 'read me' }));

  // Only `.md` is stripped. Dropping somebody's file because of its name would be the forbidding
  // kind of behaviour this project does not do.
  assert.deepEqual(read.notes.map((note) => note.name).sort(), ['README', 'notes.txt']);
});

test('a path climbing out of the archive is refused rather than imported', async () => {
  const read = await readArchive(await zipOf({ '../../.ssh/authorized_keys': 'ssh-rsa AAAA' }));

  assert.equal(read.notes.length, 0);
  assert.equal(read.skipped.length, 1);
});

test('a leading slash is tidied away rather than refused', async () => {
  // It can only mean the root of the archive, so it is not ambiguous and not dangerous.
  const read = await readArchive(await zipOf({ '/Work/Report.md': 'x' }));

  assert.equal(read.notes[0].name, 'Work/Report');
});

test('the unzippers own files are reported, not imported', async () => {
  const read = await readArchive(await zipOf({
    '__MACOSX/._Report.md': 'junk',
    '.DS_Store': 'junk',
    'Thumbs.db': 'junk',
    'Report.md': 'real',
  }));

  assert.deepEqual(read.notes.map((note) => note.name), ['Report']);
  assert.equal(read.skipped.length, 3);
  assert.ok(read.skipped.every((entry) => entry.reason.length > 0), 'and each says why');
});

test('a file that is not text is reported rather than mangled into a note', async () => {
  const { zipSync } = await import('fflate');
  const archive = zipSync({ 'photo.png': new Uint8Array([0xff, 0xfe, 0xfd, 0x00, 0x80]) });

  const read = await readArchive(archive);

  assert.equal(read.notes.length, 0);
  assert.match(read.skipped[0].reason, /attachment/i);
});

test('two files that would become the same note are not silently merged', async () => {
  // `Report.md` and `Report` both want to be the note "Report" - wait, they do not: only `.md` is
  // stripped, so these are `Report` and `Report`. One of them has to be reported.
  const read = await readArchive(await zipOf({ 'Report.md': 'first', 'Report': 'second' }));

  assert.equal(read.notes.length, 1);
  assert.equal(read.skipped.length, 1);
});

test('a broken file is not read as an empty archive', async () => {
  await assert.rejects(
    () => readArchive(new Uint8Array([1, 2, 3, 4, 5])),
    /could not be read as a zip/,
  );
});

// --- importing into a vault ---------------------------------------------------------------------

test('a name already in the vault is left exactly as it was and reported', async () => {
  const existing = await pc.createNote('Report', 'THE ORIGINAL\n');

  const result = await pc.store.importNotes([{ name: 'Report', text: 'FROM THE ARCHIVE\n' }], []);

  // The archive cannot say whether its copy is newer or a different note that shares a name, and
  // guessing destroys the one the user did not pick.
  assert.equal(result.created, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(pc.store.textOf(existing.id), 'THE ORIGINAL\n');
});

test('one clash does not cost the user everything else in the archive', async () => {
  await pc.createNote('Report', 'THE ORIGINAL\n');

  const result = await pc.store.importNotes(
    [
      { name: 'Report', text: 'clash\n' },
      { name: 'Work/Alpha', text: 'a\n' },
      { name: 'Work/Beta', text: 'b\n' },
    ],
    [],
  );

  assert.equal(result.created, 2);
  assert.equal(result.failed.length, 1);
  assert.deepEqual(
    pc.store.listNotes().map((note) => pc.store.pathOf(note.id)).sort(),
    ['Report', 'Work/Alpha', 'Work/Beta'],
  );
});

test('an imported note is a real note with a history of its own', async () => {
  await pc.store.importNotes([{ name: 'Work/Imported', text: 'from the archive\n' }], []);

  const note = pc.store.listNotes()[0];
  assert.equal(pc.store.textOf(note.id), 'from the archive\n');
  assert.equal(pc.store.historyOf(note.id).length, 1, 'history is not in an archive, so it starts here');
});

test('an imported folder that a note landed in is not also remembered as empty', async () => {
  const result = await pc.store.importNotes([{ name: 'Work/Alpha', text: 'a\n' }], ['Work', 'Empty']);

  assert.equal(result.folders, 1, 'only the one that stayed empty');
  assert.ok(pc.store.tree().some((node) => node.path === 'Empty'));
});

// --- the file it is offered as ------------------------------------------------------------------

test('the download name is a filename whatever the vault is called', async () => {
  const name = archiveFileName('Work / Personal: 2026', new Date(Date.UTC(2026, 7, 24)));

  assert.doesNotMatch(name, /[/\\:]/, 'nothing a filesystem would object to');
  assert.match(name, /2026-08-24/, 'and the date, because the second export needs telling from the first');
  assert.match(name, /\.zip$/);
});
