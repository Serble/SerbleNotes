/**
 * The backend, in memory.
 *
 * This stands in for `services/api.ts` when the store is under test (the swap is in `hooks.mjs`),
 * and it is written to mirror `SerbleNotes.Backend/Services/Impl/NotesService.cs` rather than to be
 * convenient. Where the real server does something that looks like a bug and is not, this does the
 * same thing and says so - the sibling-parent rule below is the whole reason the suite exists.
 *
 * It is deliberately not a mock: no call counting on the assertion side, no canned responses. It
 * holds rows, hands out cursors, and answers the four questions the store asks. A test that wants to
 * know what the server ended up holding reads `serverState`.
 */
import type { ChangesResponse, Note, NoteVersion } from '../../src/types';

interface NewVersionBody {
  id: string;
  parentId: string | null;
  mergeParentId: string | null;
  isSnapshot: boolean;
  isNamed: boolean;
  payload: string;
  label: string | null;
}

const notes = new Map<string, Note>();
const versions = new Map<string, NoteVersion>();

let cursor = 0;
let clock = 0;
let offline = false;

/** Every request the fake has answered, so a test can assert that two callers made one call. */
export const calls = { changes: 0, noteVersions: 0, createNote: 0, createVersion: 0, rename: 0, delete: 0 };

/**
 * Timestamps are counted rather than read from the wall clock. A vault's whole life happens inside
 * one millisecond here, and `new Date().toISOString()` would give every row the same stamp - which
 * hides an ordering bug rather than exposing one.
 */
function now(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0) + clock * 1000).toISOString();
}

/**
 * Whether this device can reach the server. The store holds no notion of a device, so "the phone is
 * offline" is expressed as a flag that is on for the duration of that device's calls - see
 * `Device.net` in `device.ts`, which is what actually drives it.
 */
export function setOffline(value: boolean): void {
  offline = value;
}

/** Puts the server back to empty. Call it in a `beforeEach`; node reuses the module across tests. */
export function resetServer(): void {
  notes.clear();
  versions.clear();
  cursor = 0;
  clock = 0;
  offline = false;
  for (const key of Object.keys(calls) as (keyof typeof calls)[]) {
    calls[key] = 0;
  }
}

/** What the server actually holds, for assertions about the DAG rather than about one device. */
export const serverState = {
  cursor: () => cursor,
  note: (id: string) => notes.get(id),
  notes: () => [...notes.values()].map((note) => ({ ...note })),
  version: (id: string) => versions.get(id),
  versions: () => [...versions.values()].map((version) => ({ ...version })),
  versionsOf: (noteId: string) => [...versions.values()].filter((v) => v.noteId === noteId),
};

class OfflineError extends Error {
  /** Status 0, exactly as `api.ts` reports an unreachable server: nothing came back to have a status. */
  readonly status = 0;
  constructor() {
    super('Could not reach the server. This device may be offline, or the server may be down.');
  }
}

function reachable(): void {
  if (offline) {
    throw new OfflineError();
  }
}

/** `IVaultRepo.NextCursor`: reserve the next value. Monotonic, never reused. */
function nextCursor(): number {
  cursor += 1;
  return cursor;
}

function buildVersion(
  body: NewVersionBody,
  noteId: string,
  vaultId: string,
  at: number,
  stamp: string,
): NoteVersion {
  return {
    id: body.id,
    noteId,
    vaultId,
    parentId: body.parentId,
    mergeParentId: body.mergeParentId,
    isSnapshot: body.isSnapshot,
    isNamed: body.isNamed,
    payload: body.payload,
    label: body.label,
    deviceId: null,
    cursor: at,
    createdAt: stamp,
  } as NoteVersion;
}

export const api = {
  createNote: async (
    vaultId: string,
    body: { id: string; name: string; initialVersion: NewVersionBody },
  ): Promise<Note> => {
    reachable();
    calls.createNote += 1;

    const at = nextCursor();
    const stamp = now();
    const note: Note = {
      id: body.id,
      vaultId,
      name: body.name,
      headVersionId: body.initialVersion.id,
      cursor: at,
      createdAt: stamp,
      updatedAt: stamp,
      deleted: false,
    };
    notes.set(note.id, note);

    // NotesService.CreateNote forces this, because there is no parent to diff against.
    const initial = { ...body.initialVersion, isSnapshot: true, parentId: null };
    versions.set(initial.id, buildVersion(initial, note.id, vaultId, at, stamp));

    return { ...note };
  },

  createVersion: async (noteId: string, body: NewVersionBody): Promise<NoteVersion> => {
    reachable();
    calls.createVersion += 1;

    const note = notes.get(noteId);
    if (!note) {
      throw new Error('No such note.');
    }

    const at = nextCursor();
    const stamp = now();
    const version = buildVersion(body, noteId, note.vaultId, at, stamp);
    versions.set(version.id, version);

    // NotesService.cs:43-47, verbatim in behaviour and deliberate: a parent that is not the current
    // head is accepted, because two devices editing offline legitimately produce siblings and the
    // DAG is what makes that representable. The head pointer is simply the last write. Everything
    // that keeps this from losing an edit lives in the client.
    notes.set(noteId, { ...note, headVersionId: version.id, cursor: at, updatedAt: stamp });

    return { ...version };
  },

  changes: async (vaultId: string, since: number, bodies = false): Promise<ChangesResponse> => {
    reachable();
    calls.changes += 1;

    const changedNotes = [...notes.values()]
      .filter((note) => note.vaultId === vaultId && note.cursor > since)
      .map((note) => ({ ...note }));
    const changedVersions = [...versions.values()]
      .filter((version) => version.vaultId === vaultId && version.cursor > since)
      .map((version) => (bodies ? { ...version } : { ...version, payload: null }));

    // The highest cursor *in the rows returned*, never the vault's own - reporting the vault's would
    // skip a write that landed between the two queries. See CLAUDE.md, "Sync cursor".
    const highest = Math.max(
      since,
      ...changedNotes.map((note) => note.cursor),
      ...changedVersions.map((version) => version.cursor),
    );

    return { vaultId, cursor: highest, notes: changedNotes, versions: changedVersions };
  },

  noteVersions: async (noteId: string): Promise<NoteVersion[]> => {
    reachable();
    calls.noteVersions += 1;
    return [...versions.values()].filter((v) => v.noteId === noteId).map((v) => ({ ...v }));
  },

  renameNote: async (id: string, sealedName: string): Promise<Note> => {
    reachable();
    calls.rename += 1;

    const note = notes.get(id);
    if (!note) {
      throw new Error('No such note.');
    }

    // A rename bumps the cursor and appends no version: history records what a note said, not where
    // it was filed.
    const renamed = { ...note, name: sealedName, cursor: nextCursor(), updatedAt: now() };
    notes.set(id, renamed);
    return { ...renamed };
  },

  deleteNote: async (id: string): Promise<void> => {
    reachable();
    calls.delete += 1;

    const note = notes.get(id);
    if (!note) {
      return;
    }
    // A tombstone, not a delete: an offline client learns the note is gone by syncing the row.
    notes.set(id, { ...note, deleted: true, cursor: nextCursor(), updatedAt: now() });
  },
};
