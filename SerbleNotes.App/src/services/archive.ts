import { archivePath, noteNameFromArchivePath } from '../core';

/**
 * A vault as a folder of markdown files: one `.md` per note, real directories for folders, nothing
 * else. It is the layout the FUSE filesystem will mount, which is the reason it is this and not a
 * database dump - what comes out of here is meant to be readable by any editor on the machine, and
 * what goes back in is meant to be a folder someone made anywhere.
 *
 * The zip is built and read on this device. Ciphertext is decrypted here, an archive is plaintext,
 * and neither ever passes through the server - the archive is exactly the thing the server is not
 * allowed to see.
 *
 * What is *not* in it: history. An archive holds each note as it stands now, because a folder of
 * markdown has nowhere to put a version DAG, and inventing a sidecar format would make the archive
 * something only this app can read. The UI has to say so rather than letting "export" imply a backup
 * of everything.
 */

/** A note on its way into or out of an archive. `name` is the note name, not the file path. */
export interface ArchiveNote {
  name: string;
  text: string;
}

/** Something in the archive that did not become a note, and the reason, for the report. */
export interface SkippedEntry {
  path: string;
  reason: string;
}

/** What an archive turned out to hold, worked out before anything is written to the vault. */
export interface ArchiveContents {
  notes: ArchiveNote[];
  /** Folders in the archive that no note lands in - the empty ones worth keeping. */
  folders: string[];
  skipped: SkippedEntry[];
}

/**
 * Files a zip carries around that are not anybody's notes. They are skipped by name rather than by
 * content because an AppleDouble file is *valid* text as far as anything here can tell, and would
 * import as a note full of control characters.
 */
function isToolJunk(path: string): boolean {
  const leaf = path.split('/').pop() ?? '';
  return path.startsWith('__MACOSX/') || leaf === '.DS_Store' || leaf === 'Thumbs.db';
}

/**
 * Builds the archive. Folder entries are written for every folder, including the ones that have
 * notes in them: a zip does not need them, but some unpackers only show a folder that is declared,
 * and "folders show as folders" is the whole point of the layout.
 */
export async function buildArchive(
  notes: ArchiveNote[],
  folders: string[],
): Promise<Uint8Array> {
  const { strToU8, zipSync } = await import('fflate');

  const entries: Record<string, Uint8Array> = {};

  // Folders first so an unpacker meets a directory before the files inside it.
  for (const folder of [...folders].sort()) {
    entries[`${folder}/`] = new Uint8Array(0);
  }

  for (const note of notes) {
    entries[archivePath(note.name)] = strToU8(note.text);
  }

  return zipSync(entries, { level: 6 });
}

/**
 * Reads an archive and works out what it would put in the vault. Nothing is written here: the caller
 * shows this to the user first, which is what makes it possible to say "3 of these already exist"
 * before any of it happens.
 */
export async function readArchive(bytes: Uint8Array): Promise<ArchiveContents> {
  const { unzipSync } = await import('fflate');

  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(bytes);
  } catch (e) {
    throw new Error(
      `This file could not be read as a zip archive: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const notes: ArchiveNote[] = [];
  const skipped: SkippedEntry[] = [];
  const declaredFolders: string[] = [];
  const taken = new Map<string, string>();

  for (const [path, content] of Object.entries(raw)) {
    if (isToolJunk(path)) {
      skipped.push({ path, reason: 'Not a note - your unzipper made this file, not you.' });
      continue;
    }

    // A zip writes a folder as an entry whose name ends in a slash.
    const isFolder = path.endsWith('/');

    let name: string;
    try {
      name = noteNameFromArchivePath(path);
    } catch (e) {
      // `normalise_path` refuses what cannot be represented, and that includes the one thing a
      // hostile archive would try: a `..` climbing out of the vault.
      skipped.push({ path, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }

    if (isFolder) {
      declaredFolders.push(name);
      continue;
    }

    let text: string;
    try {
      // Strict decoding is the only test of "is this a note". Attachments are not built yet, so a
      // file that is not text has nowhere to go and is reported rather than mangled into one.
      text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      skipped.push({ path, reason: 'Not text - attachments are not supported yet.' });
      continue;
    }

    const already = taken.get(name);
    if (already !== undefined) {
      skipped.push({ path, reason: `"${already}" in this archive is already the note "${name}".` });
      continue;
    }

    taken.set(name, path);
    notes.push({ name, text });
  }

  // Only folders that stay empty are worth carrying over: the rest come back into being on their own
  // the moment a note inside them is created, which is what "there are no folder records" means.
  const folders = [...new Set(declaredFolders)]
    .filter((folder) => !notes.some((note) => note.name.startsWith(`${folder}/`)))
    .sort();

  notes.sort((a, b) => a.name.localeCompare(b.name));
  skipped.sort((a, b) => a.path.localeCompare(b.path));

  return { notes, folders, skipped };
}

/**
 * The file name an exported vault is offered under. A vault name is free text and this has to be a
 * filename, so anything a filesystem would object to becomes a dash; the date is there because the
 * second export is the one that needs telling apart from the first.
 */
export function archiveFileName(vaultName: string, on: Date = new Date()): string {
  const safe = vaultName.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
  const day = [
    on.getFullYear(),
    String(on.getMonth() + 1).padStart(2, '0'),
    String(on.getDate()).padStart(2, '0'),
  ].join('-');

  return `${safe || 'vault'} ${day}.zip`;
}
