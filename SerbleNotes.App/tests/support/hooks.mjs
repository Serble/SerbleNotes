/**
 * Lets node resolve the client's own imports, and swaps the network for something a test can drive.
 *
 * Three jobs, in the order they appear below:
 *
 * - **`@core` is the Rust crate.** Vite aliases it to the wasm-pack output (see `vite.config.ts`);
 *   node has no such notion, so the same path is resolved here. `support/core.ts` then loads the
 *   `.wasm` itself, because node cannot `fetch` a `file:` URL the way a browser can.
 * - **`./api` becomes `support/fakeServer.ts`** for anything under `src/`. The store is the client's
 *   sync engine and every one of its interesting behaviours is a conversation with the server, so a
 *   test that cannot answer for the server can only test the parts that do not sync. This is the one
 *   substitution the suite makes; everything else below `store.ts` is the real thing.
 * - **Extensions and directory imports.** The app is bundled by Vite, so a module here says
 *   `from './tableFormat'` and `from '../core'` the way every other file in `src/` does. Node will
 *   not guess at either - correctly, for anything it is asked to run in production - so this puts
 *   the `.ts` back for relative paths only, and only when there was not an extension there already.
 *
 * The alternative to the last one was writing `.ts` into the imports of the files that happen to
 * have tests, which would make two import styles in one directory and put the reason in a comment
 * nobody reads before copying the file next to it.
 */
import { fileURLToPath } from 'node:url';

const CORE = fileURLToPath(new URL('../../../SerbleNotes.Core/pkg/serblenotes_core.js', import.meta.url));
const FAKE_SERVER = fileURLToPath(new URL('./fakeServer.ts', import.meta.url));
const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

export async function resolve(specifier, context, next) {
  if (specifier === '@core') {
    return next(CORE, context);
  }

  // Only for the app's own modules. A test that wants the fake server imports it by name.
  if (specifier === './api' && context.parentURL?.startsWith(`file://${SRC}`)) {
    return next(FAKE_SERVER, context);
  }

  if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    try {
      return await next(`${specifier}.ts`, context);
    } catch {
      // Not a TypeScript module at that name; try it as a directory before giving up.
    }
    try {
      return await next(`${specifier}/index.ts`, context);
    } catch {
      // Not a directory either; let node answer for itself below.
    }
  }

  return next(specifier, context);
}
