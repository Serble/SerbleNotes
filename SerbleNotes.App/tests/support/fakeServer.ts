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
import type { ChangesResponse, Note, NoteVersion, SyncEvent } from '../../src/types';

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
export const calls = {
  changes: 0,
  noteVersions: 0,
  noteVersionsByIds: 0,
  /** Version ids named across every by-ids call, so a test can assert what was *not* downloaded. */
  versionIdsFetched: [] as string[],
  createNote: 0,
  createVersion: 0,
  rename: 0,
  delete: 0,
};

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
  intercept(null);
  notes.clear();
  versions.clear();
  broadcasts.length = 0;
  cursor = 0;
  clock = 0;
  offline = false;
  calls.versionIdsFetched.length = 0;
  for (const key of Object.keys(calls) as (keyof typeof calls)[]) {
    if (typeof calls[key] === 'number') {
      (calls as Record<string, number>)[key] = 0;
    }
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

/**
 * Change events the server has broadcast, in order - the sync socket, as a list.
 *
 * A test reads these and hands them to a device's `absorb`, which is what the real client does with
 * a socket frame. That keeps the interesting half honest: the rows a test absorbs are the rows the
 * server actually decided to push, trimmed payloads included, rather than ones the test made up.
 */
export const broadcasts: SyncEvent[] = [];

/** Above this a payload is left out of the push, exactly as `InProcessSyncNotifier` does. */
const MAX_PUSHED_PAYLOAD = 256 * 1024;

function broadcast(vaultId: string, at: number, changedNotes: Note[], changedVersions: NoteVersion[]): void {
  broadcasts.push({
    kind: 'change',
    vaultId,
    cursor: at,
    originDeviceId: null,
    notes: changedNotes.map((note) => ({ ...note })),
    versions: changedVersions.map((version) => ({
      ...version,
      payload:
        version.payload != null && version.payload.length > MAX_PUSHED_PAYLOAD ? null : version.payload,
    })),
    present: [],
  });
}

/** The last event for a vault, which is what a connected device would just have received. */
export function lastBroadcast(vaultId: string): SyncEvent {
  const events = broadcasts.filter((event) => event.vaultId === vaultId);
  return events[events.length - 1];
}

/**
 * Something the test does while a request is unanswered.
 *
 * Every call below returns on the next microtask, which is a poor model of the only moment in a
 * syncing client that is actually hard: the gap between a request leaving the device and its answer
 * arriving, during which the person carries on typing. That gap is real time - a keystroke is a task
 * of its own and cannot land inside a chain of microtasks - so a test that needs one has to be given
 * it, and this is where.
 *
 * The function is called with the name of the request as it goes out, and the request is not
 * answered until whatever it returns settles. Typing from inside it is therefore typing while that
 * request is in flight, which is exactly the situation `tests/typing.test.ts` is about.
 *
 * Set back to null by `resetServer`, so a test that installs one cannot leak it into the next.
 */
type Interceptor = (call: keyof typeof answers) => unknown;

let interceptor: Interceptor | null = null;

export function intercept(fn: Interceptor | null): void {
  interceptor = fn;
}

const answers = {
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
    const initialVersion = buildVersion(initial, note.id, vaultId, at, stamp);
    versions.set(initial.id, initialVersion);
    broadcast(vaultId, at, [note], [initialVersion]);

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
    const moved = { ...note, headVersionId: version.id, cursor: at, updatedAt: stamp };
    notes.set(noteId, moved);
    broadcast(note.vaultId, at, [moved], [version]);

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
    // skip a write that landed between the two queries. The real server answers the same way.
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

  /**
   * NotesController.GetVersions with `ids`. Scoped to the note like the real one, so an id belonging
   * to another note is absent from the answer rather than an error - a test that expects otherwise
   * is testing something the server does not do.
   */
  noteVersionsByIds: async (noteId: string, ids: string[]): Promise<NoteVersion[]> => {
    reachable();
    calls.noteVersionsByIds += 1;
    calls.versionIdsFetched.push(...ids);

    const wanted = new Set(ids);
    return [...versions.values()]
      .filter((v) => v.noteId === noteId && wanted.has(v.id))
      .map((v) => ({ ...v }));
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
    // A rename appends no version, so the note row is the whole of the change.
    broadcast(note.vaultId, renamed.cursor, [renamed], []);
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
    const tombstone = { ...note, deleted: true, cursor: nextCursor(), updatedAt: now() };
    notes.set(id, tombstone);
    broadcast(note.vaultId, tombstone.cursor, [tombstone], []);
  },
};

/**
 * What `services/api.ts` exports, as far as the store is concerned.
 *
 * Wrapped rather than exported directly so that every request passes the interceptor above on its
 * way out. Nothing else about it changes: the call is the same function with the same arguments,
 * one await later.
 */
export const api: typeof answers = Object.fromEntries(
  Object.entries(answers).map(([name, call]) => [
    name,
    async (...args: unknown[]) => {
      // Before the interceptor, so a request from a device with no network never looks like one
      // that is in flight - it never left.
      reachable();
      await interceptor?.(name as keyof typeof answers);
      return (call as (...rest: unknown[]) => unknown)(...args);
    },
  ]),
) as typeof answers;
