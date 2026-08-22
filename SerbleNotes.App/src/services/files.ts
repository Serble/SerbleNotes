import { isNative } from './platform';

/**
 * Handing a file to the user, and taking one back.
 *
 * These are the two things a browser tab and a native app do completely differently, and the reason
 * they are hidden behind one pair of functions is that everything above them - building an archive,
 * reading one - is identical on every client and should stay that way.
 *
 * The native side goes through the OS file dialogs rather than a webview download, because a webview
 * download is at the mercy of the engine underneath it (and of this app's own content policy, which
 * does not allow much). A dialog also puts the user in charge of where the file lands, which is what
 * they expect from an app rather than a page. Tauri adds whatever the user picks to the filesystem
 * scope for that session, so nothing here can read or write anywhere the user did not point at.
 */

/** A file the user chose, read into memory. */
export interface PickedFile {
  name: string;
  bytes: Uint8Array;
}

/**
 * Offers bytes to the user as a file. Returns where it went - a real path on the native clients, and
 * just the name in a browser, which decides for itself - or null if the user backed out.
 */
export async function saveFile(suggestedName: string, bytes: Uint8Array): Promise<string | null> {
  if (isNative()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({
      defaultPath: suggestedName,
      filters: [{ name: 'Zip archive', extensions: ['zip'] }],
    });
    if (path === null) {
      return null;
    }

    const { writeFile } = await import('@tauri-apps/plugin-fs');
    await writeFile(path, bytes);
    return path;
  }

  // A browser has no save dialog it will let a page open, so this is the download it does have. The
  // object URL is revoked on a later turn of the event loop: revoking it in the same one races the
  // click in some browsers and the download arrives empty.
  // The cast is a type-level detail: a Uint8Array's buffer is `ArrayBufferLike` while the DOM types
  // ask for an `ArrayBuffer`, and every value that reaches here is one.
  const blob = new Blob([bytes as BlobPart], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = suggestedName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);

  return suggestedName;
}

/** Asks the user for a zip archive and reads it. Null means they closed the picker. */
export async function pickFile(): Promise<PickedFile | null> {
  if (isNative()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: 'Zip archive', extensions: ['zip'] }],
    });
    if (path === null) {
      return null;
    }

    const { readFile } = await import('@tauri-apps/plugin-fs');
    return {
      name: path.split(/[\\/]/).pop() || 'archive.zip',
      bytes: await readFile(path),
    };
  }

  return new Promise<PickedFile | null>((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,application/zip';
    // In the page, because some browsers ignore a click on an input that is not in the document,
    // and out of sight, because it is a dialog opener rather than a control anybody should see.
    input.style.display = 'none';

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) {
        resolve(null);
        return;
      }

      file
        .arrayBuffer()
        .then((buffer) => resolve({ name: file.name, bytes: new Uint8Array(buffer) }))
        .catch(reject);
    });

    // Not every browser fires this, which is why nothing is left waiting on it: an unresolved promise
    // here means the dialog the user closed simply never came back, and pressing the button again
    // starts a new one.
    input.addEventListener('cancel', () => {
      input.remove();
      resolve(null);
    });

    document.body.appendChild(input);
    input.click();
  });
}
