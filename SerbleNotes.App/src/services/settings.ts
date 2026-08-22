/**
 * What this device remembers about how the app is being used - the client's own configuration, as
 * opposed to anything that is in a vault.
 *
 * It is one JSON object under one key, read and written whole. That is deliberate: a setting added
 * later needs a field and a default here and nothing else, and everything the client remembers is
 * in one place to be read, cleared or reasoned about rather than scattered across keys nobody can
 * enumerate. `layout.ts` and the folder state in `store.ts` predate this and still have their own
 * keys; new preferences belong here.
 *
 * Two rules this file keeps:
 *
 * - **Nothing here ever reaches the server.** These are facts about a device, not about a vault,
 *   and some of them - which note you had open - would say something about the contents if they
 *   did. Note ids are already known to the server; which one you were reading is not.
 * - **Storage is allowed to refuse.** A private window, a locked-down webview or a browser with
 *   site data disabled throws on the first touch, so every path falls back to the defaults and the
 *   app carries on forgetting things rather than failing to open.
 */

const KEY = 'serblenotes.settings';

export interface Settings {
  /**
   * The note that was open in each vault, by vault id. Opening a vault comes back to where you
   * were, and the id is checked against the vault before it is used - a note deleted on another
   * device leaves an id here that means nothing, which costs a lookup rather than an error.
   */
  lastNote: Record<string, string>;
}

export const DEFAULT_SETTINGS: Settings = {
  lastNote: {},
};

/**
 * Read once, then kept. Reading is on the path that opens a vault, and a device whose storage
 * throws should throw once rather than on every call.
 */
let cache: Settings | null = null;

/** Keeps only what has the shape of the setting; anything else falls back to its default. */
function clean(stored: Partial<Settings>): Settings {
  const lastNote: Record<string, string> = {};
  const raw: unknown = stored.lastNote;

  if (raw !== null && typeof raw === 'object') {
    for (const [vaultId, noteId] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof noteId === 'string' && noteId !== '') {
        lastNote[vaultId] = noteId;
      }
    }
  }

  return { lastNote };
}

export function readSettings(): Settings {
  if (cache) {
    return cache;
  }

  try {
    const raw = localStorage.getItem(KEY);
    cache = raw === null ? DEFAULT_SETTINGS : clean(JSON.parse(raw) as Partial<Settings>);
  } catch {
    cache = DEFAULT_SETTINGS;
  }

  return cache;
}

/** Reads one setting. */
export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  return readSettings()[key];
}

/**
 * Writes one setting. The value in memory is updated whether or not the write lands, so the app
 * behaves the same for this session on a device that cannot store anything.
 */
export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  cache = { ...readSettings(), [key]: value };

  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // Nowhere to remember it. This session still behaves as though it were remembered.
  }
}

/** The note that was open in this vault last time, if this device remembers one. */
export function lastNoteIn(vaultId: string): string | null {
  return getSetting('lastNote')[vaultId] ?? null;
}

export function rememberNote(vaultId: string, noteId: string): void {
  const lastNote = getSetting('lastNote');
  if (lastNote[vaultId] === noteId) {
    return;
  }

  setSetting('lastNote', { ...lastNote, [vaultId]: noteId });
}

/** Used when a vault is gone, so its entry does not sit here for the life of the browser. */
export function forgetVault(vaultId: string): void {
  const lastNote = getSetting('lastNote');
  if (!(vaultId in lastNote)) {
    return;
  }

  const next = { ...lastNote };
  delete next[vaultId];
  setSetting('lastNote', next);
}
