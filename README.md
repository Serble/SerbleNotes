<div align="center">

<img src="SerbleNotes.App/public/icon.svg" alt="Serble Notes" width="120" height="120">

<h1>Serble Notes</h1>

<p><strong>Markdown notes with every version kept, on a server that cannot read a word of them.</strong></p>

<p>
  <img alt="ASP.NET Core 10" src="https://img.shields.io/badge/ASP.NET_Core-10-512BD4?style=flat-square">
  <img alt="Rust core" src="https://img.shields.io/badge/Rust_core-WASM-CE422B?style=flat-square">
  <img alt="React 18" src="https://img.shields.io/badge/React-18-149ECA?style=flat-square">
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square">
  <img alt="MySQL" src="https://img.shields.io/badge/MySQL-9-4479A1?style=flat-square">
</p>

</div>

---

Sign in with Serble, make a vault, write. It syncs to every device you use, keeps the history of
every note, and the server storing it all only ever holds ciphertext.

## The idea

- **The backend is a dumb encrypted blob store.** Ciphertext, plus the least metadata that can order
  a sync. It never diffs, merges, indexes or renders a note.
- **All of that happens on the device**, in a Rust core compiled to WebAssembly - one copy of the
  crypto and version control, shared by the web, desktop and Android clients.
- **Note names are ciphertext too**, so folder names cannot leak either.
- **Serble OAuth gates access to a vault at all.** The encryption is a second, independent layer.

## Vaults

- **Password vaults** wrap the vault key with an Argon2id key from a password the server never sees.
  Entered once per device, then kept in the OS keychain.
- **Unencrypted vaults** are readable by the server. That is the point of the option, and the app
  says so plainly rather than implying privacy it does not have.
- **Changing a password re-wraps the key rather than replacing it**, so nothing in the vault is
  rewritten and a device that already holds the key carries on working.

## History

- **Versions form a DAG**, not a line: diffs against a parent, with periodic snapshots so replay
  stays cheap.
- **Automatic snapshots as you type**, plus named restore points.
- **Concurrent edits three-way merge** against the common ancestor. Conflicts become markers you
  resolve - no silent loss, no auto-pick.
- **Every diff carries a hash of the text it was built from** and refuses to apply to anything else.
  A wrong document that loads quietly is worse than one that fails.

## Notes and folders

- **A note has one name, and a `/` in it is a folder.** There are no folder records anywhere; the
  tree is derived from the names.
- **Renaming is metadata, not an edit.** History is what a note said, not where it was filed.
- **Moving is renaming.** Renaming a folder rewrites the names underneath it.
- **The sidebar is a file manager**: drag to move, right-click for a menu, rename in place, filter.

## The editor

- **No modes.** Markdown renders in place as you type; the line the cursor is on shows its raw
  syntax, every other line shows the result.
- **Code blocks are highlighted by that language's own parser**, loaded on demand.
- **Autosave is debounced**, and the sidebar, editor and panels all sit behind draggable splitters.

## Sync

- **The socket carries notifications, not content.** "Vault X moved to cursor N"; the client then
  pulls what it is missing over HTTP.
- **Local-first.** Every client works fully offline and reconciles on reconnect.
- **Deletes are tombstones**, so a device that was away still learns what happened.

## Import and export

- **A vault exports as a zip of markdown files**, one per note, with real directories for folders.
- **Built and read on the device.** It never passes through the server.
- **Nothing is ever overwritten.** A name already in the vault is reported and skipped; everything
  else still imports.
- **History is not in the archive.** A folder of markdown has nowhere to put a version DAG.

## Projects

- **`SerbleNotes.Backend`** - ASP.NET Core 10, EF Core + MySQL. The sync API, and it serves the web
  client itself.
- **`SerbleNotes.Core`** - Rust. Crypto, diffing, merging, paths. 125 tests.
- **`SerbleNotes.App`** - React + TypeScript + Vite.
- **`SerbleNotes.App/src-tauri`** - the Tauri v2 shell for Linux, Windows, macOS and Android.

## Running it

Needs .NET 10, Rust with `wasm-pack`, Node 22, and a MySQL the backend can reach. Migrations apply
themselves at startup.

```fish
cd SerbleNotes.App; npm install; npm run build:core   # Rust core -> WASM

# Backend on :5179, and the client on :3000 proxying to it.
dotnet run --project SerbleNotes.Backend --urls http://localhost:5179
cd SerbleNotes.App; npm run dev

# Desktop and Android, both against the same client.
cd SerbleNotes.App; npm run desktop
cd SerbleNotes.App; npm run android

# Production: one command builds the core, the client and the backend together.
dotnet publish SerbleNotes.Backend -c Release -o out
```

## Not built yet

- **File attachments**, which need object storage.
- **The Redis backplane.** Sync fans out in-process, which is right for one instance and wrong for
  two.
- **The FUSE filesystem**, for editing a vault in any editor.
- **Re-keying a vault.** A password change re-wraps the existing key; replacing it would mean
  rewriting every note name and every stored version.
