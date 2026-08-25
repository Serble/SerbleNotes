/**
 * Loads the Rust core into node.
 *
 * The crate is built with `wasm-pack --target web`, whose generated `init()` resolves the `.wasm`
 * beside itself and `fetch`es it. Node's `fetch` does not do `file:` URLs, so the bytes are read
 * from disk and handed to `initSync` instead. Nothing else differs: this is the same WebAssembly
 * module the browser and the Tauri webview run, which is the point - a test that ran a second
 * implementation of the crypto would prove nothing about the one that holds people's notes.
 *
 * Import this module first in any test file that touches the store. It has no exports; loading it
 * is the effect.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error - resolved by tests/support/hooks.mjs, exactly as Vite resolves it for the app.
import { initSync } from '@core';

// See the note on CORE in `hooks.mjs`: the same override, for the binary beside the glue.
const WASM = process.env.SERBLENOTES_CORE_PKG
  ? `${process.env.SERBLENOTES_CORE_PKG}/serblenotes_core_bg.wasm`
  : fileURLToPath(new URL('../../../SerbleNotes.Core/pkg/serblenotes_core_bg.wasm', import.meta.url));

initSync({ module: readFileSync(WASM) });
