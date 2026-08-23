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

  /**
   * The vault that was open when the app was last used, so starting it comes back to the note you
   * were writing rather than to a list. Null means the vault list is where the user left off -
   * going back to it is a deliberate act, and it is the way to say "not this one next time".
   */
  lastVault: string | null;

  /**
   * Whether an older version opened from the history panel is shown as the changes that save made,
   * rather than as the whole note. On by default: a version is a *change*, and "what did this save
   * do" is the question a history is opened to answer - the whole note is the thing the editor is
   * already showing. The other reading is one press away and is remembered, because somebody
   * reading back through a note wants it every time.
   */
  versionDiff: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  lastNote: {},
  lastVault: null,
  versionDiff: true,
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

  const lastVault =
    typeof stored.lastVault === 'string' && stored.lastVault !== '' ? stored.lastVault : null;

  const versionDiff =
    typeof stored.versionDiff === 'boolean' ? stored.versionDiff : DEFAULT_SETTINGS.versionDiff;

  return { lastNote, lastVault, versionDiff };
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

/**
 * The vault to open on startup, if this device remembers one. Checked against the server before it
 * is used: a vault deleted from another device leaves an id here that opens nothing.
 */
export function lastVaultOpened(): string | null {
  return getSetting('lastVault');
}

export function rememberVault(vaultId: string): void {
  if (getSetting('lastVault') !== vaultId) {
    setSetting('lastVault', vaultId);
  }
}

/** Leaving a vault for the list is the user saying that is where they want to start next time. */
export function forgetLastVault(): void {
  if (getSetting('lastVault') !== null) {
    setSetting('lastVault', null);
  }
}

/** Used when a vault is gone, so its entry does not sit here for the life of the browser. */
export function forgetVault(vaultId: string): void {
  if (getSetting('lastVault') === vaultId) {
    setSetting('lastVault', null);
  }

  const lastNote = getSetting('lastNote');
  if (!(vaultId in lastNote)) {
    return;
  }

  const next = { ...lastNote };
  delete next[vaultId];
  setSetting('lastNote', next);
}

/** How a version opened from the history panel is shown: its changes, or the whole note. */
export function showVersionDiff(): boolean {
  return getSetting('versionDiff');
}

export function rememberVersionDiff(diff: boolean): void {
  if (getSetting('versionDiff') !== diff) {
    setSetting('versionDiff', diff);
  }
}
