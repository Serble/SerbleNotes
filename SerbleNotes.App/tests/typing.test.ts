/**
 * What happens to what is being typed while something else is in flight.
 *
 * The bug these describe is the one people actually report: text is inserted - typed or pasted -
 * and a moment later it is gone again, as though the editor had undone it. It looks like a
 * CodeMirror problem and is not. The workspace hands `MarkdownEditor` a `value`, and that
 * component's effect pushes any change to it into the open document, so anything that makes the
 * value go *backwards* is seen as the insert being undone. What makes it go backwards is a request.
 *
 * `commit`, `reconcile` and `resync` were each handed an `EditorState` by value and returned a
 * state built from that same snapshot (`{...state}`), which `VaultPage` applied wholesale. Between
 * the snapshot being taken and the answer arriving there is a network round trip - a real one, of
 * real milliseconds - and a person typing through it was producing keystrokes that the answer then
 * overwrote. One keystroke lost per request in flight, which is exactly "sometimes a character is
 * skipped" and "sometimes I have to paste twice".
 *
 * They take an `EditorAccess` now and read the editor again after their last await, writing what
 * they worked out in the same breath. These tests are what says so: each types during a request the
 * client really makes, and asserts that what was typed is still there when it is answered.
 *
 * The gap has to be a real one for the test to mean anything: a keystroke is a task of its own and
 * cannot land in the middle of a chain of microtasks, so a test that interleaved by resolving
 * promises would be describing something that cannot happen in a browser. `intercept` in
 * `support/fakeServer.ts` is the whole of the trick - it is called as each request goes out and the
 * request is not answered until it returns, so typing from inside it is typing while that request is
 * unanswered, and nothing else about the client is changed to let it happen.
 *
 * Every one of these failed when it was written, which is the convention of `merge.test.ts` next
 * door: assert what the client is supposed to do, name the cause, then make them pass without
 * touching an assertion. What each one guards against is written above it, because a test that says
 * only what must be true is a test somebody will one day satisfy by deleting it.
 */
import './support/core';

import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { newVaultKey } from '../src/core';
import { Device, newVault } from './support/device';
import { intercept, lastBroadcast, resetServer } from './support/fakeServer';
import { resetStorage } from './support/storage';

let key: string;

beforeEach(() => {
  resetServer();
  resetStorage();
  key = newVaultKey();
});

/** Three paragraphs, so an edit at the bottom and an edit at the top merge without meeting. */
const NOTE = 'top\n\nmiddle\n\nbottom\n';

/** One device with `NOTE` open and saved, which is where every one of these starts. */
async function typing(text = NOTE) {
  const vault = newVault();
  const pc = new Device(vault, key, 'pc');
  const note = await pc.createNote('Shared', text);
  await pc.open(note.id);

  return { pc, note, vault };
}

/**
 * Types `text` into `device` while the named request is unanswered, once.
 *
 * Once, because the point is a person typing during one round trip rather than a machine typing
 * into every one of them, and because the save that follows has to be left alone to prove that what
 * was typed did or did not survive.
 *
 * Returns whether it ever fired, and every test below asserts on that. A request the client turns
 * out not to make is the one way one of these tests could fail while describing nothing: no
 * keystroke, no window, and an assertion about text nobody typed. It has already happened once
 * while these were being written.
 */
function typeDuring(device: Device, call: string, text: string): () => boolean {
  let done = false;
  intercept((outgoing) => {
    if (outgoing === call && !done) {
      done = true;
      device.type(text);
    }
  });

  return () => done;
}

// --- typing through a save ------------------------------------------------------------------------

test('a keystroke made while the save is in flight is not thrown away', async () => {
  const { pc } = await typing();

  // The autosave fires in a pause in typing (1.2s), and the person starts typing again before the
  // server has answered. This is the ordinary way to use the app, not an edge case.
  pc.type('top\n\nmiddle\n\nbottom, edited\n');
  const typedIt = typeDuring(pc, 'createVersion', 'top\n\nmiddle\n\nbottom, edited a\n');

  // The bug: `commit` built its answer out of the state it was handed before the request, so the
  // keystroke made while that request was out was replaced by the text as it had been before it.
  await pc.autosave();

  assert.ok(typedIt(), 'the save made no request, so nothing was typed during one');
  assert.equal(pc.editor.text, 'top\n\nmiddle\n\nbottom, edited a\n');
});

test('a paste made while the save is in flight does not have to be made twice', async () => {
  const { pc } = await typing();
  const pasted = `${NOTE}\nA paragraph off the clipboard.\n`;

  pc.type('top\n\nmiddle\n\nbottom, edited\n');
  const pastedIt = typeDuring(pc, 'createVersion', pasted);

  // The bug: as above. A paste is one change like any other, so a save in flight swallowed the
  // whole of it - which is why pasting a second time appeared to be what made it work.
  await pc.autosave();

  assert.ok(pastedIt(), 'the save made no request, so nothing was pasted during one');
  assert.equal(pc.editor.text, pasted);
});

test('text typed while the save is in flight still reaches the server', async () => {
  const { pc } = await typing();

  pc.type('top\n\nmiddle\n\nbottom, edited\n');
  const typedIt = typeDuring(pc, 'createVersion', 'top\n\nmiddle\n\nbottom, edited a\n');
  await pc.autosave();
  assert.ok(typedIt(), 'the save made no request, so nothing was typed during one');

  // The next pause in typing saves again. Nothing is typed during this one.
  await pc.autosave();

  // The bug was not only on the screen. The editor was put back to the text that had just been
  // saved, so the autosave that followed found nothing unsaved and the keystroke was gone from the
  // device as well as from the note - no draft, no history, nothing to recover it from. What makes
  // this pass is `commit` leaving the status at "saving" when the editor has moved past what it
  // sent: that is what arms the save below.
  assert.equal(pc.text(), 'top\n\nmiddle\n\nbottom, edited a\n');
  assert.equal(pc.editor.status, 'saved');
});

test('the editor is never handed text that undoes what was just typed', async () => {
  const { pc } = await typing();
  const typedDuringSave = 'top\n\nmiddle\n\nbottom, edited a\n';

  pc.type('top\n\nmiddle\n\nbottom, edited\n');
  const typedIt = typeDuring(pc, 'createVersion', typedDuringSave);
  await pc.autosave();
  assert.ok(typedIt(), 'the save made no request, so nothing was typed during one');

  // The symptom, stated as what the user sees. `shown` is the sequence of values handed to
  // MarkdownEditor, whose effect pushes each one into the document: once the editor has been shown
  // the text with the keystroke in it, showing it anything shorter is the visible undo.
  //
  // The bug: the save's answer was the entry that went backwards.
  const after = pc.shown.slice(pc.shown.indexOf(typedDuringSave) + 1);
  assert.deepEqual(
    after.filter((text) => text !== typedDuringSave),
    [],
    'the editor was shown text it had already moved past',
  );
});

// --- typing through a merge -----------------------------------------------------------------------

test('a keystroke made while a remote change is being merged is not thrown away', async () => {
  const { pc, note, vault } = await typing();

  const phone = new Device(vault, key, 'phone');
  await phone.pull();
  await phone.open(note.id);
  phone.type('top, edited on the phone\n\nmiddle\n\nbottom\n');
  await phone.autosave();

  // The pc is part-way through a sentence when the other device's change arrives. Merging it means
  // fetching the body of the version that arrived, and the person carries on typing while it comes.
  pc.type('top\n\nmiddle\n\nbottom, typed on the pc\n');
  const typedIt = typeDuring(
    pc,
    'noteVersionsByIds',
    'top\n\nmiddle\n\nbottom, typed on the pc and more\n',
  );

  // The bug: `reconcile` merged the snapshot it was handed - taken before `ensureVersions` went to
  // the server - so "ours" was the text as it had been one keystroke earlier, and the result was
  // applied over the newer one. The identity check `reconcileNote` made did not help: what came
  // back was a different object from what the editor held, which is exactly why it got applied.
  await pc.remoteChange();

  assert.ok(typedIt(), 'the merge fetched nothing, so nothing was typed while it was fetching');
  assert.equal(
    pc.editor.text,
    'top, edited on the phone\n\nmiddle\n\nbottom, typed on the pc and more\n',
  );
  assert.equal(pc.editor.conflicted, false);
});

test('a keystroke made while a pushed change is being caught up on is not thrown away', async () => {
  const { pc, note, vault } = await typing();

  const phone = new Device(vault, key, 'phone');
  await phone.pull();
  await phone.open(note.id);
  phone.type('top, edited on the phone\n\nmiddle\n\nbottom\n');
  await phone.autosave();
  phone.type('top, edited twice on the phone\n\nmiddle\n\nbottom\n');
  await phone.autosave();

  // The live path, on a socket that missed something. A pushed event whose cursor does not follow
  // this device's proves one write happened and says nothing about the one before it, so `absorb`
  // refuses to advance the cursor and the client pulls - metadata only, which leaves the body of
  // the version it missed to be fetched during the merge. That fetch is the window.
  //
  // Not the contiguous case, deliberately: there the rows travel with the notification and the
  // merge asks the server for nothing, so there is no gap for a keystroke to fall into. A test
  // written over that path types into a chain of microtasks, which a browser never interrupts, and
  // proves nothing at all.
  pc.type('top\n\nmiddle\n\nbottom, typed on the pc\n');
  const typedIt = typeDuring(
    pc,
    'noteVersionsByIds',
    'top\n\nmiddle\n\nbottom, typed on the pc and more\n',
  );

  // The bug: as above - `handleRemoteChange` in pages/VaultPage.tsx reaches the same `reconcile`.
  await pc.pushed(lastBroadcast(vault.id));

  assert.ok(typedIt(), 'the catch-up fetched nothing, so nothing was typed while it was fetching');
  assert.equal(
    pc.editor.text,
    'top, edited twice on the phone\n\nmiddle\n\nbottom, typed on the pc and more\n',
  );
});

// --- typing through a reconnect -------------------------------------------------------------------

test('a keystroke made while the device is catching up is not thrown away', async () => {
  const { pc } = await typing();

  // Offline, so the save is kept as a draft rather than sent.
  pc.online = false;
  pc.type('top\n\nmiddle\n\nbottom, written on a train\n');
  await pc.autosave();
  assert.equal(pc.editor.status, 'offline');

  // The network comes back and the device pulls what it missed before sending what it held. That
  // pull is a request like any other, and the person is still typing.
  const typedIt = typeDuring(
    pc,
    'changes',
    'top\n\nmiddle\n\nbottom, written on a train, and finished\n',
  );
  pc.online = true;
  await pc.settled();
  assert.ok(typedIt(), 'the reconnect pulled nothing, so nothing was typed while it was pulling');

  // The bug: `resync` passed the state it was handed to `reconcile` and then to `commit`, both of
  // them after `store.pull()` had been to the server, so a keystroke made during the catch-up was
  // not merely dropped from the editor - the commit that followed succeeded, the draft was dropped
  // with it, and the sentence was gone from the device for good.
  assert.equal(pc.editor.text, 'top\n\nmiddle\n\nbottom, written on a train, and finished\n');
  assert.equal(pc.text(), 'top\n\nmiddle\n\nbottom, written on a train, and finished\n');
});
