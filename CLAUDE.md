# Serble Notes

End-to-end encrypted, version-controlled markdown notes platform. Backend is ASP.NET Core; clients
are Tauri v2 apps sharing one Rust core that owns *all* crypto and version-control logic.

`PROJECT.md` holds the original brief. **This file is the project-wide context only** - the rules and
shapes that hold everywhere, and the things that will waste a day if you do not know them. Detail
about one component lives in comments next to that component; read the code before changing it.

**Status: MVP built and working.** Vaults, notes, the version DAG, live sync, zip import/export, the
web client, the Tauri shell and the FUSE filesystem all exist. Deliberately *not* built yet: file
attachments and S3 (needs MinIO), and the Redis backplane.

## Architecture

Monorepo. Everything lives here:

| Path | What |
| --- | --- |
| `SerbleNotes.Backend/` | ASP.NET Core API (net10.0). Sync, metadata, auth. **Also serves the web client.** |
| `SerbleNotes.Core/` | Rust crate: crypto, diffing, merge, replay. Compiles native (rlib) and to WASM. |
| `SerbleNotes.App/` | React + TS client. Built into the backend's `wwwroot` for the web, and wrapped by the Tauri shell for desktop and Android. |
| `SerbleNotes.App/src-tauri/` | The Tauri v2 shell: Linux, Windows, macOS and Android. Thin - see "The native clients". |
| `SerbleNotes.Fuse/` | Rust CLI: mounts a vault as a folder of markdown files, so it can be edited in any editor. |

Infrastructure: **MySQL** (metadata, EF Core migrations) is in use today. **MinIO / S3** (attachment
blobs) and **Redis** (pub/sub fan-out across backend instances) are designed for but not yet wired
up - sync currently fans out in-process, which is correct for a single instance.

### The one rule: the server never sees plaintext of an encrypted vault

The backend is a **dumb encrypted blob store**. It stores ciphertext plus the minimum metadata needed
to sync - ids, sizes, timestamps, parent-version pointers. It never diffs, merges, indexes or renders
note content. Every one of those operations happens client-side in the Rust core.

If a feature seems to require the server understanding note content, it is the wrong design. Push it
into the Rust core and give the server a metadata-only view of it.

### Encryption model

Every vault has a random per-vault data key; content is encrypted with it before it ever leaves the
client. How that key is protected is what separates the two vault kinds:

- **Password vaults.** Key wrapped with an Argon2id-derived key from the vault password. The user
  enters the password **once per device**; the unwrapped key is then cached in the OS keychain
  (and IndexedDB-with-caveats on web). The server stores only the salt, KDF params and the wrapped
  blob.
- **Unencrypted vaults.** Key derived from material the server can see. This is deliberate: these
  vaults are *not* E2E. Never imply to the user that an unencrypted vault is private from the server.

The wire and storage format is identical for both, so the sync path has exactly one code path.

**Changing a password re-wraps the key; it does not replace it.** `rewrap_vault_key` seals the *same*
vault key under the new password, so nothing in the vault is rewritten and a device that already
holds the key carries on working. The old password is checked by being used. Someone who knew the old
password and kept the old blob can still derive the key - `ChangePasswordDialog` says so. Only
re-keying takes that back, and re-keying means rewriting every note name and stored version.

**Key material lives in `VaultKeys`, one row per person who can open the vault - not on the vault
row.** There is one row today (the owner) and nothing can make a second, but the key is shared and
only its *wrapping* differs per person, so sharing later is inserting a row rather than migrating
live key material. **A key row *is* the membership**: `VaultAccess` asks for the row and that is the
access check; `IsOwner` is asked separately for deleting a vault and changing its password.
`VaultResponse` is still exactly the JSON the vault row used to serialise to (the vault, plus *your*
key), so no client had to learn that the key moved.

### Version control

Versions form a **DAG**, not a line. Every version references its parent(s); content is stored as a
diff against the parent, with a full snapshot every `SNAPSHOT_EVERY` (10) versions so replay stays
cheap. Automatic snapshots as the user types (1.2s debounce), plus manual named restore points.
Concurrent edits get a three-way merge in the core against the common ancestor; unmergeable hunks
become conflict markers the user resolves - no silent loss, no auto-pick. Because the server cannot
read diffs, history pruning is driven by client-supplied metadata.

**The stored diff format is `serblenotes-diff-v1 <fingerprint>\n<unified diff>`.** The fingerprint is
the first 128 bits of a Blake2s hash of the base text, and `apply_diff` refuses any base that does
not match. This is not decoration: a unified diff applies wherever its context lines happen to fit,
so applying one twice, or to a near-identical document, produced a plausible *wrong* note that the
next autosave then wrote over the real one.

- **Changing this format orphans every stored diff.** Bump the version in the prefix and keep reading
  the old one. `the_diff_format_this_module_emits_is_pinned` fails if it drifts by accident.
- **Never bypass `apply_diff` to call `diffy::apply` directly.** The guard is the only thing between a
  mis-parented version and silent corruption.

### Notes, names and folders

A note has one name, and a `/` in it is a folder. `Work/Projects/Alpha` puts Alpha inside Projects
inside Work. **There are no folder records anywhere** - not in the database, not in the client. The
tree the sidebar draws is derived from the names, and so is the tree the FUSE filesystem mounts (the
same function in `path.rs`). Nothing to create before filing a note, nothing to clean up when
the last note leaves, and no second structure that can drift out of step with the first.

- **The name is ciphertext**, sealed with the vault key and stored in `Note.Name` as a blob, so
  folder names cannot leak either. It is not nullable and there is no read-the-first-line fallback -
  that fallback meant downloading note bodies just to draw the tree.
- **Renaming is metadata, not an edit.** `PUT /api/notes/{id}/name` bumps the vault cursor and
  notifies other devices but appends no version. **Moving is renaming**; renaming a folder is the
  client rewriting the names underneath it.
- **The path is never shown as text.** A note is called "Test results"; "Medical" is where it is.
  Nobody types a `/` to nest something - they drag it or pick a folder.
- **Two things cannot share a path** (`VaultStore.refuseIfTaken`), for the same reason
  `normalise_path` refuses `..`: not a judgement about what the user should want, but about what can
  be represented.
- **Everything is joined through `VaultStore.join`, never by normalising a joined string.**
  `normalise_path("Work/   ")` is `"Work"`, so a note renamed to blank silently took its folder's
  name and jumped a level. A real bug, with a test.
- **Empty folders are per-device**, in `localStorage`, because a folder with no note in it has no
  name to be read out of. Do not "fix" this by adding folder rows to the database.

### Archives: a vault is a folder of markdown files

Export writes the vault as a zip - one `.md` file per note, real directory entries for folders - and
import reads one back. **This is the layout the FUSE filesystem mounts**, which is why
`archive_path` and `note_name_from_archive_path` live in `path.rs` with everything else that decides
where a note lives. The whole note name is the file's stem and `.md` is added on the way out and
taken off on the way in, so `todo.md` becomes `todo.md.md` - ugly, and the only reversible mapping.

The archive is plaintext, built and read on the device, and never passes through the server; no
backend route was added. History is not in it. Nothing is ever overwritten or merged on import: a
name already in the vault is left alone and reported, and anything that cannot become a note is
listed with the reason rather than dropped.

### The client, in one table

`services/store.ts` is the centre of it: the client-side DAG, the folder tree built from decrypted
names, and every move and rename (`moveNote`, `moveFolder`, `renameNoteTo`, `renameFolderTo`,
`createFolder`, `deleteFolder`). The React layer is a thin wrapper over those, which is why they are
what the tests cover.

| Where | What |
| --- | --- |
| `core/` | The only door to the WASM. |
| `services/stores.ts` | One `VaultStore` per vault per session, keyed by vault id **and** key. |
| `services/noteSync.ts` | Reconnect: pull, merge, then send. |
| `services/settings.ts` | Per-device preferences - one JSON object, one key. New ones go here. |
| `services/vaultCache.ts` | IndexedDB cache of **ciphertext**, never plaintext. |
| `pages/VaultPage.tsx` | The workspace: sidebar, editor, panels, autosave, reconciliation. |
| `components/livePreview.ts`, `markdownLanguage.ts` | Markdown rendered in place as you type. There is no edit/preview toggle. |
| `components/noteHtml.ts` | The one sanitiser. Every place a note is drawn goes through it. |
| `components/table*.ts` | Drawn tables: the source is laid out, not just rendered. |
| `components/conflict*.ts` | Merge conflicts drawn as the choice they are. |
| `components/htmlToMarkdown.ts` | Pasting formatted text out of a browser, Word or Docs. |

Two boundaries in there that are project-wide rather than component detail:

- **Nothing a note says ever runs.** No script, no event handler, no iframe, no form control, no
  remote fetch. A note arrives from somewhere - an archive, another device, someone else - and this
  app decrypts it on the user's own origin holding their vault key. Markup from a note is inert;
  anything on the page that acts was put there by this app. What is not understood is shown as its
  source, never swallowed.
- **The markdown language is assembled by hand** from `@lezer/markdown` rather than using
  `@codemirror/lang-markdown`, which statically pulls in the JavaScript and CSS parsers and was about
  two thirds of the bundle. If you swap the parser back, check every node name `livePreview` keys off
  still exists, or rendering silently stops working.

### Sync

WebSocket push (Redis fan-out designed, in-process today). Clients must work fully offline and
reconcile on reconnect - sync is an optimisation over a local-first store, not the source of truth.

- **The socket carries the rows, not just a nudge.** `SyncEvent` carries the changed notes and
  versions, ciphertext included; it is still a dumb relay. A payload over 256 KB is pushed as
  `payload: null` and the client fetches that note the way it already does, so this is an
  optimisation the client never has to trust.
- **`VaultStore.absorb` decides whether a pushed event is enough on its own.** A device may only
  advance its cursor to a point where it has seen everything below it. One write reserves exactly one
  cursor value, so equal to ours plus one means nothing was missed; anything else means pull.
- **The client pings, and gives up on a socket that stops answering.** A dead path leaves the socket
  `OPEN` forever with no close frame - "I have to reload for it to notice my other device". Ping every
  20s, two missed answers closes it by hand, backoff 500ms to 15s.
- **Reconnecting is `resync`, and the order is the point** - pull, merge, then send what could not be
  sent. Saving first parents the new version on a head only this device believes is current.
- **Presence is your other devices, never another person.** Vaults are single-owner; the note bar says
  "Open elsewhere" and nothing more.
- **nginx must forward the upgrade** (`proxy_http_version 1.1`, `Upgrade`, `Connection: "upgrade"`).
  Without it the socket never connects and the symptom is indistinguishable from a client bug.

### Opening a vault does not download it, and neither does opening a note

`/changes` sends version metadata only unless asked for `bodies=true`; the client fetches ciphertext
from `GET /notes/{id}/versions?ids=...` when it has to read something. On the vault this was measured
on (196 notes, 6.5 MB, 92% of it in five notes) metadata is 160 KB and ~100 ms against 1.6 s for
everything. Cold open went 2.8s -> 1.3s, warm 0.35s, returning to a vault 0.25s.

- **A note is opened by its chain, not its history.** `chainFrom` walks back to the nearest snapshot
  over metadata already held; `ensureVersions` fetches exactly what that walk will read.
  `ensureNote(id)` is `ensureVersions([headOf(id)])`; anything wanting a *particular* version says so.
- **A chain that cannot be walked falls back to the whole note.** `chainFrom` returns null rather than
  a short answer - a chain read one version short rebuilds the wrong document.
- **A missing body is never an empty one.** `bodyOf` throws rather than returning `''`: text is what
  the next autosave diffs against, so a note that opened blank would be saved blank.
- **Only `pull` moves the cursor.** A version this device just wrote carries one, but that says
  nothing about other devices' writes below it.

Export is the one operation that still needs every note, so `ExportDialog` fetches them all with
progress first.

### The backend

All routes live under `/api` so the SPA fallback can never shadow them.

| Route | Purpose |
| --- | --- |
| `GET /api` | Health. |
| `GET /api/config` | The Serble application id, so no client is built with it. Anonymous. |
| `POST /api/account` | Serble OAuth code -> this backend's JWT. `GET` returns the current user. |
| `GET/POST /api/vaults`, `GET/DELETE /api/vaults/{id}` | Vault CRUD. |
| `PUT /api/vaults/{id}/password` | New wrapped key, salt and KDF params after a password change. |
| `GET/POST /api/vaults/{id}/notes` | List and create notes. |
| `GET /api/vaults/{id}/changes?since=N&bodies=false` | The sync read path. |
| `GET/POST /api/notes/{id}/versions`, `DELETE /api/notes/{id}` | DAG append and note tombstone. `?ids=` fetches named versions, scoped to the note in the URL. |
| `PUT /api/notes/{id}/name` | Rename or move. Metadata only. |
| `GET /api/sync` | WebSocket, token via `?access_token=`. |

- **The web client is served by this app**, published into `wwwroot` by the csproj during
  `dotnet publish` (`SkipWebClientBuild=true` to skip it). `UseStaticFiles()` +
  `MapFallbackToFile("index.html")`, deliberately not `MapStaticAssets`, whose build-time manifest is
  a sharp edge when the frontend is generated during publish. CORS stays: the Tauri clients call the
  API from `tauri://localhost`. In development Vite still runs separately - do not make the dev loop
  depend on a publish.
- **A version id is chosen by the client**, so `POST /notes/{id}/versions` asks two questions: is it
  already on *this* note (a retry - hand back the row), and does it exist anywhere at all (a collision
  - 409 and nothing else). Asking only the second handed back rows from vaults the caller had never
  been near.
- **Ciphertext is stored as bytes, not base64 text.** `NoteVersion.Payload` is a `longblob`; the wire
  is still base64 because JSON has no other way to carry bytes. `Helpers/Ciphertext.TryDecode` is the
  only place that decoding happens, and malformed input is a 400.
- **Sync cursor.** Every vault carries a monotonic `Cursor`; each write reserves the next value via
  `IVaultRepo.NextCursor` (`UPDATE ... SET Cursor = Cursor + 1` read inside one transaction) and the
  same statement carries the `Vault.StorageBytes` change, because the two move on exactly the same
  writes. It follows that **a vault row must never be written back wholesale** from a request that
  loaded it earlier - both columns are counters another device can move in between. `/changes` reports
  the highest cursor *in the rows it returned*, not the vault's current one.
- **Deletes are tombstones and carry a time** (`DeletedAt`, not a flag), because a retention window is
  the only way this data ever goes away. Nothing frees storage yet, so an account's usage only grows
  and the limit message says so rather than implying that deleting helps.
- **Migrations apply at startup**, before the port is bound, creating the database if needed and
  retrying ten times over ~20s. EF's lock makes several instances starting together safe. The
  consequence: a destructive migration runs the moment the new build starts, and rolling back means
  writing a migration that undoes it.
- **Every limit is asked for through `IUserLimits`**, never by reading config in a controller -
  limits are about to stop being the same for everybody. Enforced: vaults per account, notes per
  vault, bytes in a version, and total ciphertext across an account (the one that actually bounds the
  service, read per write by summing the owner's *vault* rows). Charged to the vault's owner, not the
  caller. There is deliberately no cap on versions per note. A refusal names the number that refused
  it, through `Helpers/Sizes.Describe`.

### Auth: Serble OAuth

Login goes through Serble, exactly as in `../SerbleFiles` - read
`SerbleFiles.Backend/Services/Impl/SerbleApiClient.cs` and `Controllers/AccountController.cs` before
touching auth. Client gets a `code` -> POSTs to `/account` -> backend exchanges it at
`oauth/token/refresh` then `oauth/token/access`, calls `GET account` with `SerbleAuth: App <token>`,
upserts a local user row and issues **its own JWT**, which is what every later request uses.

**A valid signature is not enough.** `OnTokenValidated` loads the account row the token names (a
token for a deleted account otherwise dies on a foreign key as a 500, which a client can do nothing
with) and refuses any token whose `iat` is at or before `NotesUser.TokensValidAfter`. These JWTs last
a year, so without that column a session cannot be ended at all. Two ways to get it wrong: read `iat`
off the **claim**, never by casting `context.SecurityToken` (the type differs between handlers and a
wrong cast is silently null), and treat a token with no `iat` as *older* than the cutoff, or
revocation is skippable.

Serble auth gates access to vaults at all - server-side security. Encryption is the second,
independent layer. Neither substitutes for the other.

### The native clients

One frontend build decides at runtime which it is (`services/platform.ts`, `isNative()`). **The shell
is deliberately thin and the crypto is not in it**: the core is not linked into the native binary and
not reimplemented there, the webview runs the same WASM the browser does. If something in the shell
needs to touch note content, the design has gone wrong. It exists for two things a browser tab cannot
do:

- **The keychain** (`src-tauri/src/secrets.rs`) - Secret Service, Credential Manager, Keychain; on
  Android a `0600` file in private storage, because that crate has no Android backend. **Say which it
  is, never imply the stronger one** (`secret_backend`), and if the keychain will not answer, drop
  the promise to remember rather than making it anyway. The Linux backend is `async-secret-service`,
  not the sync one, which would link `libdbus`.
- **The deep link**, so the OAuth redirect can return to an app with no pages.

- **Where the API lives:** `VITE_API_BASE_URL` at build time, or the sign-in screen asks and remembers
  it. Every request goes through `apiUrl()`/`socketUrl()`, never a bare `/api` path.
- **The application id comes from the server** (`GET /api/config`), not the build, so it cannot
  disagree with the client secret it is paired with.
- **Sign-in opens the real system browser** so the app never sees the Serble password.
  `serblenotes://auth/callback` must be on the Serble app registration or it fails with
  `redirect-uri-mismatch`. `opener:allow-open-url` is not enough on its own - the command needs a
  *scope*, and with none granted every URL is refused with `ForbiddenUrl`. The `state` must be letters
  and digits only, which is why it is hex rather than a UUID.
- On Windows and Linux a deep link starts the app again, so `tauri-plugin-single-instance` hands the
  URL to the running instance.
- **Android needs the intent filter and the signing config added by hand**, because the Tauri template
  writes neither. `scripts/android-deeplink.py` and `scripts/android-signing.py` are idempotent, both
  run by `npm run android:init`, and the result is committed with the rest of `gen/android` (which is
  committed on purpose - it is a real project we have edited). Signing is applied only when
  `gen/android/keystore.properties` exists, so a checkout without a key still builds a debug APK.
- **Wayland with NVIDIA's driver kills WebKitGTK**, with a message naming neither. `lib.rs` sets
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` when running under Wayland *and* `/sys/module/nvidia_drm` exists;
  setting the variable yourself always wins.

### The filesystem

`SerbleNotes.Fuse` is a Rust CLI that mounts a vault as a folder of markdown files: `login` once per
machine, `mount <vault> <dir>` per vault. It links the **same core natively** that the browser loads
as WASM, so the filesystem and the app cannot disagree about what a stored version means. It talks
to the same routes the web client does and adds none.

**Which server it talks to is a build-time decision**, the same one the packaged clients make with
`VITE_API_BASE_URL`: `config::BUILT_IN_SERVER` is `https://notes.serble.net` unless
`SERBLENOTES_SERVER_URL` is set when compiling. It is the last resort in `config::choose_server` -
`--server`, then `SERBLENOTES_SERVER`, then a saved session, then the build - and `login` writes the
address down only when the run actually named one, so a copy built for somewhere else is not pinned
to whatever it happened to reach first.

**Every value it would otherwise ask a terminal for has a flag and an environment variable**, so a
mount can be brought up by a script or a unit file with stdin closed: `--server`, `--token` (which
skips `login` entirely), `login --code`, and `mount --password` / `--password-stdin` /
`SERBLENOTES_VAULT_PASSWORD`. `--mkdir` makes the mount point, `--ignore` adds to the list of names
that are never notes, `--quiet` drops the routine output.
A password on a command line is visible in `ps`, which is said once, factually, without refusing it
- and an empty password is a real password, so nothing anywhere treats empty as absent.

**Closing a file after writing to it is what appends a version.** That is the whole product: edit a
note in whatever editor you already have, and every save is a point in its history.

- **A note is the file `archive_path(name)`**, the same place it appears in an exported zip, and a
  file is a note only if that mapping comes back to the same name - which in practice means a
  lowercase `.md`. Anything else would rename itself under the editor that made it.
- **A file that is not a note lives in the mount and nowhere else.** This is the load-bearing idea.
  Saving a file is rarely a write to it: `sed -i` writes `sedA1B2C3` beside it and renames it over
  the top, GNOME writes `.goutputstream-...`, vim writes `4913` to see whether it can create files
  at all. Refusing those names would refuse `sed -i`; turning them into notes would fill the vault
  with swap files. They live in the mount, and renaming one onto a note's name is what commits it.
  The built-in list can only ever hold the shapes somebody thought of, so `mount --ignore <GLOB>`
  adds to it - name-only without a `/`, whole-path with one, `*` stopping at `/` as in a
  `.gitignore`.
- **A rename onto an existing note is a new version of that note**, not a delete and a create. Every
  graphical editor saves that way, and reading it the obvious way destroys the history of every note
  they touch.
- **A note renamed to an editor's own name is copied there, and does not move.** The other half of
  the same dance: nvim with `backupcopy=no` renames `Things.md` to `Things.md~` and then writes a
  new `Things.md`. Moving the note really - tombstoning it and leaving the text as a file - left the
  name free, so that write made a *second* note and cut a months-old history in half, findable only
  by restoring a deletion nobody knew about. The note stays put; the backup is a copy; the editor's
  next write is an open of the note, because the kernel looks a name up before it creates one. A
  rename to any *other* non-note name is refused instead, since no reading of it keeps the note.
- **A rename moves the source's inode to the new name.** POSIX, and not optional: keeping the
  destination's left the kernel holding an inode that had just been discarded, and a note saved by
  `sed -i` read back as "no such file". `tests/mounted.rs` is what found it.
- **`flush` only saves when something has been written since the last save.** `flush` runs on every
  `close`, and a `close` is not a program finishing with a file - `sh` opens a redirect, dups it onto
  stdout and closes the original, so the first flush of `printf x > note.md` arrives before a byte
  does, on a buffer just truncated to nothing. Committing that wrote an empty version into every
  save. `release` still saves unconditionally, so truncating a note to nothing is not lost.
- **Unmounting is done by running `fusermount3`, not by `fuser`.** Built without libfuse, fuser
  unmounts by shelling out to `fusermount3` and returning `Ok` whatever it said - so a mount point
  something still had a file open in reported a clean unmount and then blocked forever in `join()`.
  Ctrl-C appeared to hang, with nothing said. It now reports the refusal, keeps retrying so that
  closing the editor is enough on its own, and takes a second Ctrl-C as "detach it anyway" - after
  which it does not `join`, because the worker can still be parked on somebody else's descriptor.
- **`getattr` blocks on rebuilding the note**, because `st_size` is the length of the *plaintext* and
  the server only knows how much ciphertext it holds. The sync thread warms every note in the
  background so `ls -l` is not a download.
- **Remote changes are polled**, not pushed: `/changes` every `--interval` seconds (10 by default).
  **Warming runs on its own thread**, not before the loop: it is one request per note, so on a vault
  of any size against a distant server it used to be minutes during which no poll ran at all and the
  mount quietly noticed nothing anybody else did.
  A note that moved under an open buffer is three-way merged, never overwritten - and a sibling is a
  fork whether or not anything is unsent, which is the case that used to lose a device's own saved
  work.
- **An edit the server would not take is sealed into the cache directory and retried**, including
  across mounts. Offline is not an error the editor is told about; a refusal is.
- **The vault key is kept in a 0600 file, not a keychain**, and every place that offers to remember
  one says so. A mount usually runs where there is no session bus, and a keychain that cannot be
  reached is worse than a file because it makes the promise and does not keep it.
- **`http://127.0.0.1:41780/auth/callback` has to be on the Serble application registration**, the
  same way the native scheme does, or `login` fails with `redirect-uri-mismatch` before the consent
  screen. The port is fixed because a registration is an exact string. `--no-browser` prints the URL
  and takes the redirected address back, which is what works over SSH.
- **Building needs no libfuse headers.** `fuser` is used with `default-features = false`, so mounting
  goes through the `fusermount3` binary every distribution ships with FUSE itself.

## ASCII only, and icons are SVG

**Every character we write is ASCII.** No em dashes, no ellipsis character, no arrows, no curly
quotes, no non-breaking spaces, no BOMs. Use `-`, `...`, `->`, `'`, `"`. UI strings, code, comments,
commit messages and these docs.

**Icons are SVG components, never characters** - `components/Icons.tsx`, `stroke="currentColor"`, one
2.2 weight on the 24 grid. An emoji is a font-dependent picture that cannot be recoloured and has no
accessible name. The one exception is **test fixtures in `SerbleNotes.Core/tests/`**, which
deliberately contain emoji, CJK, RTL text and combining marks: that is not our prose, it is data
proving a *user's* note survives encryption, diffing and merging.

```fish
./scripts/check-ascii.sh    # fails on any non-ASCII outside that fixture directory
```

## Inform, never forbid

**The user's data, the user's risk, the user's call.** This product holds notes nobody else can read,
so the person using it is the only one who can weigh what they are worth. Refusing their instruction
substitutes our guess for their judgement.

- **No minimum lengths, no required character classes, no arbitrary caps** on anything the user is
  choosing for themselves. An empty vault password is permitted.
- **Warn in real time, factually, and say the consequence.** "Roughly seconds to guess" tells someone
  something; "must contain a symbol" trains them to write it on a sticky note.
- **Never disable the submit button, never refuse the save, never silently clamp.** A warning showing
  while the user proceeds anyway is the feature working.
- **Estimates must not flatter.** Where the honest answer is uncertain, show the *less* reassuring
  number, and say what the estimate assumes (`services/passwordStrength.ts`).
- **The exception is catching an accident the user cannot perceive**, which is why the password
  confirmation stays. The test is whether they could tell the difference between what they meant and
  what they did. If they could not, catching it is help; if they could, it is paternalism.

**Questions are asked in the app's own dialogs.** `window.confirm` and `window.prompt` block the page,
cannot be styled, and on some platforms offer to suppress themselves - silently answering the *next*
question on the user's behalf. Use `components/Modal.tsx` and the `ConfirmModal` / `PromptModal` built
on it, and say the consequence rather than "Are you sure?". There are none left in the client; do not
add one.

Server-side resource limits are a different question - they protect other people on the service - but
set them high enough that nobody ordinary meets them, and fail with a clear reason.

## Testing

```fish
cd SerbleNotes.Core; cargo test              # ~25s
dotnet test SerbleNotes.Backend.Tests
cd SerbleNotes.App; npm test                 # node's own runner over SerbleNotes.App/tests
cd SerbleNotes.Fuse; cargo test              # ~5s
```

**The core is held to a stricter standard than the rest of the repo** - it holds the only copy of the
logic that turns stored bytes back into someone's notes, and a bug that corrupts rather than crashes
destroys history no backup helps with, because the server only ever had ciphertext. **Any change to
`crypto.rs` or `version.rs` needs tests before it lands.** `tests/common/mod.rs` holds the text corpus
(empty, no trailing newline, CRLF, emoji, combining marks, content that is itself a diff, content
containing conflict markers) - add a shape when you find one that breaks something.

**Test that wrong input fails, not just that right input works.** Most of the dangerous bugs here
return a plausible document instead of an error; both real bugs found so far were exactly that shape,
and both were caught by a test asserting something *must* fail.

The backend's tests are xUnit over the controllers and services with the EF repos replaced by
in-memory fakes - no database, because everything below the repos is EF's behaviour rather than ours.
**The fakes hand back copies**, which is the point of them: a fake returning the stored instance lets
a caller mutate a row and forget to save it, so the test meant to prove the save happens proves
nothing. **Error message text is deliberately not asserted** - the status code is the contract, the
sentence is not.

The filesystem's tests come in four shapes, and which shape a thing is tested in is the decision
worth getting right.

- **`tests/mount.rs` and `tests/store.rs`** drive `Mount` and `VaultStore` against the in-memory
  server in `tests/support`. The FUSE callbacks do nothing but turn inode numbers into paths and
  call `Mount`'s methods, so this is where the operations are.
- **`tests/api.rs`** runs against a real HTTP server on a real socket (`tests/support/stub.rs`).
  `api.rs` is the one module with no seam a fake can go under - everything below it is `ureq`, the
  URLs, the headers and the shapes `serde` makes of the JSON - and a `Backend` fake proves none of
  it. This is where a field renamed on the server, or a status read the wrong way round, shows up.
- **`tests/mounted.rs`** mounts for real and uses the mount with `ls`, `cat`, `mv`, `sed -i` and a
  shell redirect. It skips where there is no `/dev/fuse`. **It has the best bug-per-test rate in
  this repo by a distance**: both bugs that reached a real vault were invisible to the direct tests
  and obvious the first time a kernel and a real program were involved. Anything about what the
  *kernel* does around a save belongs here. Every test holds its mount through a guard whose `Drop`
  unmounts and then detaches, because a test that panics must not leave a mount on the machine.
- **`tests/cost.rs`** asserts what a vault costs to open and to list - that drawing the tree
  downloads no bodies, that a note is fetched once - by counting requests rather than timing
  anything. A timing assertion on a build machine is a test that fails for reasons nobody can act on.

**The CLI itself is deliberately thin.** Everything in `main.rs` that decides something is lifted
into the library where it can be tested: `config::choose_server` and `choose_token`, `vaults::find`,
`unlock::password_source`, `mountpoint::take_down` and `check`, `api::describe`. What is left is
clap declarations and wiring against a real server. When something in `main.rs` starts making a
decision, move it out rather than leaving it where nothing can reach it.

The client's tests cover the pieces that can be *wrong* rather than broken: the store against
`support/fakeServer.ts` with the real core doing the crypto, paths and archives, the table layout that
rewrites the user's text, the diff reader, conflict parsing, CSS scoping, paste conversion and date
parsing. Everything else in the client is a button that either works or visibly does not.

- No test framework was added: node's own runner with `--experimental-transform-types` (not
  `--experimental-strip-types`, which refuses the parameter properties the editor plugins use), and
  `tests/support/hooks.mjs` puts the `.ts` back on relative imports. The directory is outside
  `tsconfig.json`'s `include`.
- jsdom is a dev dependency; `tests/support/dom.ts` is the whole of using it.

### Mutation testing

Coverage says a line ran; mutation testing says whether anything would have noticed it being wrong.

```fish
cd SerbleNotes.Backend.Tests; dotnet stryker      # ~40s
cd SerbleNotes.App; npm run test:mutants          # one module, ~70s
cd SerbleNotes.Core; cargo mutants -j 4           # ~4 min
cd SerbleNotes.Fuse; cargo mutants -j 4           # ~45 min, 540 mutants
```

On the filesystem it has already earned its keep. It found two functions nothing called at all, a
restored edit that could be stranded on a tombstoned note forever, and a `rmdir` that took a
folder's parents with it; the survivor list is what the suite was written against, rather than a
guess about what might be untested. The score went 58% to 81% on the back of it.

Three things to know before reading its report there:

- **Mutants in the `impl Filesystem` callbacks show as survivors.** Only `tests/mounted.rs` reaches
  them and it needs `/dev/fuse`, which it does not reliably get inside the sandbox. They are covered;
  the report cannot see it.
- **It leaves mounts behind.** Some mutants break the unmount path by design, so a run can strand
  FUSE mounts on the machine. Afterwards:
  `for m in (mount | grep -oP 'on \K[^ ]+' | grep serblenotes); fusermount3 -u -z $m; end`
- **A message string is not worth pinning** - see the rule below. A good share of what is left is
  `replace X -> String with "xyzzy".into()` on something whose only job is to be read by a person.

**A surviving mutant is a question, not a defect.** Three kinds show up: a real gap (fix it), an
equivalent mutant that cannot change behaviour (leave it, say why), and something not worth pinning -
mostly user-facing message strings, by the rule above. It has found real product bugs, not just test
gaps: `BroadcastPresence` handing out a stale device list, and backend writes that were never
persisted.

StrykerJS is run **one module at a time** through `scripts/mutation-tests.sh`, which refuses to run no
tests - node exits 0 when its argument matches nothing, which Stryker reads as "the tests passed" and
reports every mutant as surviving. Two things it needs: `ignorePatterns` for `src-tauri/target` and
`gen` (10 GB that Stryker would otherwise copy into its sandbox per run), and `SERBLENOTES_CORE_PKG`
to tell the sandbox where the crate is.

## Backend code style

Match `../SerbleFiles/SerbleFiles.Backend` - it is the style reference, not a dependency.

- **Explicit types, not `var`.** K&R braces, 4-space indent, file-scoped namespaces.
- **Primary constructors** for controllers, services and repos.
- **Interface + `Impl/` subfolder**: `Services/IThing.cs` + `Services/Impl/Thing.cs`; same under
  `Database/Repos/`.
- **Folders**: `Config/`, `Controllers/`, `Database/{Schema,Repos,Repos/Impl}`, `Helpers/`,
  `Migrations/`, `Schema/` (DTOs), `Services/{,Impl}`.
- **Config POCOs** in `Config/`, bound with `AddOptions<T>().Bind(...)`, injected as `IOptions<T>`.
  Settings needed at startup are read eagerly with `?? throw new Exception("X settings not found")`.
- **EF entities** in `Database/Schema/`, attributes for keys and lengths, non-null reference props
  `= null!`, navigation properties `[JsonIgnore]`.
- **JSON is camelCase.** Error responses are anonymous objects with a user-facing `message`.
- Comment only where the *why* is non-obvious.

Two deliberate deviations from SerbleFiles, both with reasons that outlive the memory of making them:

- **Pomelo 9 / EF Core 9 packages on a net10.0 target.** Pomelo has no EF10 build. The EF10 CLI drives
  it happily; do not "fix" it by bumping EF Core alone, which breaks the provider.
- **`ServerVersion.Parse` from config, not `AutoDetect`.** Auto-detecting means a reachable database is
  needed just to construct the model, so builds, migrations and CI all need a live server.

## Commands

```fish
# Backend. `dotnet build` is pure .NET - it never invokes npm.
# Pending migrations are applied automatically at startup, so `database update` is rarely needed.
dotnet run --project SerbleNotes.Backend --urls http://localhost:5179
dotnet ef migrations add <Name> --project SerbleNotes.Backend

# Rust core: run these before touching anything that reads stored data.
cd SerbleNotes.Core; cargo test
cd SerbleNotes.App; npm run build:core          # wasm-pack -> SerbleNotes.Core/pkg

# Web client. Dev uses Vite on :3000 proxying /api (and the socket) to the backend on :5179.
cd SerbleNotes.App; npm run dev
cd SerbleNotes.App; npm run build               # -> SerbleNotes.Backend/wwwroot
cd SerbleNotes.App; npm run build:app           # -> SerbleNotes.App/dist, what Tauri bundles

# Desktop. `desktop` opens a window against the Vite server, so HMR works in it.
cd SerbleNotes.App; npm run desktop
cd SerbleNotes.App; npm run desktop:build       # -> src-tauri/target/release/bundle

# Android. `android:init` regenerates gen/android and re-adds the deep link filter and the signing
# config; it is already committed, so it is only needed after changing the identifier or wiping it.
cd SerbleNotes.App; npm run android:init
cd SerbleNotes.App; npm run android
cd SerbleNotes.App; npm run android:build -- --apk --debug
cd SerbleNotes.App; npm run android:build -- --aab --apk   # signed, if keystore.properties exists

# The filesystem. Needs no libfuse headers; mounting uses the fusermount3 binary.
# Talks to notes.serble.net unless --server, SERBLENOTES_SERVER or a saved session says otherwise.
cd SerbleNotes.Fuse; cargo build --release
set -x PATH ./SerbleNotes.Fuse/target/release $PATH
serblenotes-fuse login                                  # --server http://localhost:5179 for dev
serblenotes-fuse vaults
serblenotes-fuse mount <vault> ~/notes                  # Ctrl-C unmounts

# The same thing with nothing to type, for a script or a unit file.
serblenotes-fuse --token $JWT -q mount $VAULT ~/notes --password-stdin --mkdir < ~/.vault-password

# Names this mount should leave alone, on top of the editors it already knows about.
serblenotes-fuse mount $VAULT ~/notes --ignore '*.bak' --ignore 'Drafts/**'

# A build for a different deployment.
cd SerbleNotes.Fuse; SERBLENOTES_SERVER_URL=https://notes.example.com cargo build --release

# Production shape: one command builds the core, the client and the backend together.
dotnet publish SerbleNotes.Backend -c Release -o out
```

Local dev database is the existing `dev-mysql` container on **port 3307** (root/root), database
`serblenotes`. Installed: .NET 10.0.201, `dotnet-ef` 10.0.6, Rust 1.94.1, Node 22, docker/podman, the
Android SDK at `~/Android/Sdk` with NDK 27.1.12297006. **Not** installed: Redis, MinIO. Shell is
**fish**, so `export X=y` does not work (`set -x X y`).

**wasm-pack is a devDependency**, so `npm ci` is the whole of installing it and a build agent needs
nothing set up by hand - except a Rust toolchain, which wasm-pack drives. `npm ci --ignore-scripts`
breaks it: the postinstall is what downloads the binary.

### Building the clients

Three things this machine needs that are not in the repo, each failing in a way that does not say so:

- **Desktop:** `sudo dnf install webkit2gtk4.1-devel libsoup3-devel`, or the build stops at
  `javascriptcoregtk-4.1 was not found in the pkg-config search path`. The runtime libraries are there;
  the headers are not.
- **Android:** `set -x JAVA_HOME /usr/lib/jvm/java-21-openjdk` - the default `java` here is 25 and
  Gradle refuses it with `Unsupported class file major version 69`, which does not mention Java. Also
  `ANDROID_HOME` and `NDK_HOME`.
- **Windows:** no supported cross-compile, so it builds in CI. `.github/workflows/clients.yml` builds
  Linux, Windows and Android from one commit and needs `VITE_API_BASE_URL` as a repository variable.

### Releasing to Google Play

Pushing a `v*` tag builds every client and publishes the AAB to the **internal track**;
`workflow_dispatch` builds without publishing unless asked. **A tag goes no further than internal,
deliberately** - promoting means choosing a rollout percentage and writing release notes, which is a
decision somebody makes in the Play Console.

Secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
`PLAY_SERVICE_ACCOUNT_JSON`, and `ANDROID_KEY_PASSWORD` only for an older JKS keystore that really has
a separate key password. `HAS_KEYSTORE`/`HAS_PLAY_KEY` are computed at the top of the job because the
`secrets` context cannot be read from an `if`, and with neither set the job falls back to a debug APK -
so a fork is not a workflow that fails. The key is written into the workspace and shredded in a step
that runs `always()`.

```fish
keytool -genkey -v -keystore upload-keystore.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload
base64 -w0 upload-keystore.jks    # this is what goes in the secret
```

Four things that each cost a release to find out:

- **Turn on Play App Signing**, or losing that key means losing the app. With it, this is only an
  *upload* key and Google can reset it.
- **The first upload cannot be done by the API.** Play will not accept an AAB for a package it has
  never seen, so the first build is uploaded by hand to create the app. A first run failing with a 404
  about the package name is this, not the credentials.
- **`versionCode` comes from `tauri.conf.json`** as `major * 1000000 + minor * 1000 + patch`, and Play
  never forgets one - including for a build that was rejected. So the version must be bumped before
  every release and a re-run of a tag cannot publish. The workflow checks the tag against
  `tauri.conf.json` **before compiling anything**, because the alternative is finding out after a
  four-architecture build.
- **The mapping file is uploaded with it**, or every crash report from a real phone is obfuscated.

## Working agreements

- Never weaken the E2E boundary for convenience. If the server needs to know something, add explicit
  metadata; do not leak plaintext into it.
- Crypto and version-control logic lives in the Rust core **only** - never reimplemented per client,
  never duplicated in C#. If C# appears to need it, question the design first.
- Prefer boring, well-reviewed crypto primitives (Argon2id, AEAD) over anything hand-rolled.
- Local-first: every client keeps a working local store and must be fully usable offline.
- Errors in the core are `Result<_, String>`, never `JsError` - that is what keeps the same functions
  compiling natively for Tauri *and* testable with `cargo test`.
- The publish hook must stay ahead of `ResolveStaticWebAssetsInputs`. The SDK precompresses `wwwroot`
  into `.gz`/`.br` during that pass, so building the frontend after it ships compressed copies of the
  *previous* build, which nginx `gzip_static` would then serve as stale HTML. A real bug here.
- Keep this file about the project. A decision that only matters while editing one component belongs
  in a comment in that component.
