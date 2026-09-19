# Serble Notes

End-to-end encrypted, version-controlled markdown notes. The backend is ASP.NET Core; the clients are
Tauri v2 apps over one Rust core that owns *all* crypto and version-control logic.

**This file is the project-wide context only**: the rules that span components, and the things that
are not in any file. Why a particular piece of code does what it does is in a comment next to it -
those comments are thorough and they are the real documentation. Read the code before changing it.

**Status: MVP built and working.** Vaults, notes, the version DAG, live sync, zip import/export, the
web client, the Tauri shell and the FUSE filesystem all exist. Deliberately *not* built: file
attachments and S3, and the Redis backplane.

## Architecture

Monorepo. Everything lives here:

| Path | What |
| --- | --- |
| `SerbleNotes.Backend/` | ASP.NET Core API (net10.0). Sync, metadata, auth. **Also serves the web client.** |
| `SerbleNotes.Core/` | Rust crate: crypto, diffing, merge, replay. Compiles native (rlib) and to WASM. |
| `SerbleNotes.App/` | React + TS client. Built into the backend's `wwwroot` for the web, and wrapped by the Tauri shell for desktop and Android. |
| `SerbleNotes.App/src-tauri/` | The Tauri v2 shell: Linux, Windows, macOS and Android. Thin - see below. |
| `SerbleNotes.Fuse/` | Rust CLI: mounts a vault as a folder of markdown files, editable in any editor. |

**MySQL** (metadata, EF Core migrations) is in use. **MinIO / S3** (attachment blobs) and **Redis**
(pub/sub across backend instances) are designed for but not wired up - sync fans out in-process,
which is correct for a single instance.

### The one rule: the server never sees plaintext of an encrypted vault

The backend is a **dumb encrypted blob store**. It stores ciphertext plus the minimum metadata needed
to sync - ids, sizes, timestamps, parent-version pointers. It never diffs, merges, indexes or renders
note content. Every one of those happens client-side in the Rust core.

If a feature seems to require the server understanding note content, it is the wrong design. Push it
into the core and give the server a metadata-only view of it.

Serble auth gates access to a vault at all - server-side security. Encryption is a second,
independent layer. Neither substitutes for the other.

### Encryption

Every vault has a random per-vault data key; content is encrypted with it before it leaves the client.
The wire and storage format is identical for both vault kinds, so the sync path has one code path.

- **Password vaults** wrap the key with an Argon2id key from the vault password, entered once per
  device and then cached in the OS keychain. The server stores only salt, KDF params and the blob.
- **Unencrypted vaults** derive the key from material the server can see. They are deliberately *not*
  E2E. Never imply to the user that an unencrypted vault is private from the server.
- **A password change re-wraps the key; it does not replace it**, so nothing in the vault is rewritten
  and devices that hold the key carry on working. Someone with the old password and the old blob can
  still derive the key - `ChangePasswordDialog` says so. Only re-keying takes that back, and that
  means rewriting every note name and stored version.
- **Key material lives in `VaultKeys`, one row per person, not on the vault row**, so sharing later is
  inserting a row rather than migrating live key material. **A key row *is* the membership**:
  `VaultAccess` asks for the row and that is the access check. `IsOwner` is separate, for deleting a
  vault and changing its password.

### Version control

Versions form a **DAG**, not a line. Each references its parent(s) and is stored as a diff against it,
with a full snapshot every `SNAPSHOT_EVERY` (10) versions so replay stays cheap. Automatic snapshots
as the user types (1.2s debounce), plus manual named restore points. Concurrent edits three-way merge
in the core against the common ancestor; unmergeable hunks become conflict markers the user resolves -
no silent loss, no auto-pick. The server cannot read diffs, so history pruning is driven by
client-supplied metadata.

**The stored diff format is `serblenotes-diff-v1 <fingerprint>\n<unified diff>`.** `apply_diff`
refuses any base whose hash does not match the fingerprint.

- **Changing the format orphans every stored diff.** Bump the version in the prefix and keep reading
  the old one. `the_diff_format_this_module_emits_is_pinned` fails if it drifts by accident.
- **Never bypass `apply_diff` to call `diffy::apply` directly.** That guard is the only thing between
  a mis-parented version and silent corruption.

### Notes, names and folders

A note has one name, and a `/` in it is a folder. **There are no folder records anywhere** - not in
the database, not in the client. The sidebar's tree is derived from the names, and so is the tree FUSE
mounts, by the same function in `path.rs`. Nothing to create before filing a note, nothing to clean up
when the last note leaves, and no second structure that can drift out of step with the first.

- **The name is ciphertext**, so folder names cannot leak either. It is not nullable and there is no
  read-the-first-line fallback, which meant downloading note bodies just to draw the tree.
- **Renaming is metadata, not an edit** - it bumps the cursor and appends no version. **Moving is
  renaming**; renaming a folder is the client rewriting the names underneath it.
- **The path is never shown as text.** A note is called "Test results"; "Medical" is where it is.
  Nobody types a `/` to nest something - they drag it or pick a folder.
- **Two things cannot share a path**, for the same reason `normalise_path` refuses `..`.
- **Join through `VaultStore.join`, never by normalising a joined string.** `normalise_path("Work/  ")`
  is `"Work"`, so a note renamed to blank took its folder's name and jumped a level. A real bug.
- **Empty folders are per-device**, in `localStorage`, because a folder with no note in it has no name
  to read out of. Do not "fix" this by adding folder rows to the database.

**A vault exports as a zip of markdown files, and that is the layout FUSE mounts** - one `.md` per
note, real directory entries for folders, decided by `archive_path` in `path.rs`. The archive is
plaintext, built and read on the device, and never passes through the server; there is no backend
route for it. History is not in it, and nothing is ever overwritten on import.

## The client

`services/store.ts` is the centre: the client-side DAG, the folder tree built from decrypted names,
and every move and rename. The React layer is a thin wrapper over those, which is why they are what
the tests cover.

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

Two boundaries there are project-wide rather than component detail:

- **Nothing a note says ever runs.** No script, no event handler, no iframe, no form control, no
  remote fetch. A note arrives from somewhere and this app decrypts it on the user's own origin
  holding their vault key. Markup from a note is inert; anything on the page that acts was put there
  by this app. What is not understood is shown as its source, never swallowed.
- **The markdown language is assembled by hand** from `@lezer/markdown` rather than using
  `@codemirror/lang-markdown`, which statically pulls in the JavaScript and CSS parsers and was about
  two thirds of the bundle. Swapping the parser back means checking every node name `livePreview` keys
  off still exists, or rendering silently stops working.

### Sync

WebSocket push, over a local-first store. Clients must work fully offline and reconcile on reconnect -
sync is an optimisation, not the source of truth.

- **The socket carries the rows, not just a nudge**, ciphertext included; over 256 KB it pushes
  `payload: null` and the client fetches the note the way it already does. Still a dumb relay.
- **`VaultStore.absorb` decides whether a pushed event is enough on its own.** One write reserves
  exactly one cursor value, so equal to ours plus one means nothing was missed; anything else pulls.
- **Reconnecting is `resync`, and the order is the point** - pull, merge, then send what could not be
  sent. Saving first parents the new version on a head only this device believes is current.
- **Presence is your other devices, never another person.** Vaults are single-owner.
- **nginx must forward the upgrade** (`proxy_http_version 1.1`, `Upgrade`, `Connection: "upgrade"`).
  Without it the socket never connects and the symptom looks exactly like a client bug.

### Opening a vault does not download it, and neither does opening a note

`/changes` sends version metadata only unless asked for `bodies=true`; the client fetches ciphertext
from `GET /notes/{id}/versions?ids=...` when it has to read something. On a real vault that was the
difference between 160 KB and 6.5 MB on open. A note is opened by its chain (`chainFrom` back to the
nearest snapshot, `ensureVersions` to fetch exactly that), never by its history. Export is the one
operation that still needs every note.

Two invariants that a convenience change would quietly break: **a chain that cannot be walked falls
back to the whole note** rather than returning a short answer, and **a missing body is never an empty
one** - `bodyOf` throws, because text is what the next autosave diffs against.

## The backend

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

- **Sync cursor.** Every vault carries a monotonic `Cursor`; each write reserves the next value via
  `IVaultRepo.NextCursor`, which carries the `Vault.StorageBytes` change in the same statement. It
  follows that **a vault row must never be written back wholesale** from a request that loaded it
  earlier - both columns are counters another device can move in between. `/changes` reports the
  highest cursor *in the rows it returned*, not the vault's current one.
- **A version id is chosen by the client**, so an append asks two questions: already on *this* note (a
  retry - hand back the row), or existing anywhere at all (a collision - 409 and nothing else).
- **Ciphertext is stored as bytes, not base64 text.** `Helpers/Ciphertext.TryDecode` is the only place
  decoding happens; malformed input is a 400.
- **Deletes are tombstones carrying a time**, not a flag, because a retention window is the only way
  this data ever goes away. Nothing frees storage yet, so usage only grows and the limit message says
  so rather than implying that deleting helps.
- **Migrations apply at startup**, before the port is bound. A destructive migration therefore runs the
  moment the new build starts, and rolling back means writing a migration that undoes it.
- **Every limit is asked for through `IUserLimits`**, never by reading config in a controller.
  Charged to the vault's owner, not the caller. There is deliberately no cap on versions per note.
- **The web client is served by this app**, published into `wwwroot` by the csproj during
  `dotnet publish` (`SkipWebClientBuild=true` to skip it). `UseStaticFiles()` +
  `MapFallbackToFile("index.html")`, deliberately not `MapStaticAssets`, whose build-time manifest is
  a sharp edge when the frontend is generated during publish. CORS stays: the Tauri clients call from
  `tauri://localhost`. In development Vite runs separately - do not make the dev loop need a publish.

### Auth: Serble OAuth

The client gets a `code` -> POSTs it to `/account` -> the backend exchanges it at
`oauth/token/refresh` then `oauth/token/access`, calls `GET account` with `SerbleAuth: App <token>`,
upserts a local user row and issues **its own JWT**, which is what every later request uses.

**A valid signature is not enough.** `OnTokenValidated` loads the account row the token names, and
refuses any token whose `iat` is at or before `NotesUser.TokensValidAfter`. These JWTs last a year, so
without that column a session cannot be ended at all. Two ways to get it wrong: read `iat` off the
**claim**, never by casting `context.SecurityToken` (the type differs between handlers and a wrong
cast is silently null), and treat a token with no `iat` as *older* than the cutoff, or revocation is
skippable.

## The native clients

One frontend build decides at runtime which it is (`services/platform.ts`, `isNative()`). **The shell
is deliberately thin and the crypto is not in it**: the core is neither linked into the native binary
nor reimplemented there - the webview runs the same WASM the browser does. If something in the shell
needs to touch note content, the design has gone wrong. It exists for the two things a browser tab
cannot do: the OS keychain, and the deep link that brings the OAuth redirect back to an app with no
pages.

- **Where the API lives:** `VITE_API_BASE_URL` at build time, or the sign-in screen asks and remembers
  it. Every request goes through `apiUrl()`/`socketUrl()`, never a bare `/api` path.
- **The application id comes from the server** (`GET /api/config`), not the build, so it cannot
  disagree with the client secret it is paired with.
- **Both redirect URIs must be on the Serble app registration** - `serblenotes://auth/callback` for
  the apps and `http://127.0.0.1:41780/auth/callback` for the FUSE CLI - or sign-in fails with
  `redirect-uri-mismatch` before the consent screen. Sign-in opens the real system browser, so no
  client ever sees the Serble password.
- **The keychain** (`src-tauri/src/secrets.rs`) is Secret Service, Credential Manager or Keychain; on
  Android a `0600` file, because that crate has no Android backend. **Say which it is, never imply the
  stronger one**, and if the keychain will not answer, drop the promise to remember rather than making
  it anyway.
- **Android needs the intent filter and the signing config added by hand**, because the Tauri template
  writes neither. `scripts/android-deeplink.py` and `scripts/android-signing.py` are idempotent, both
  run by `npm run android:init`, and the result is committed with the rest of `gen/android` (committed
  on purpose - it is a real project we have edited). Signing applies only when
  `gen/android/keystore.properties` exists, so a checkout without a key still builds a debug APK.

## The filesystem

`SerbleNotes.Fuse` mounts a vault as a folder of markdown files. It links the **same core natively**
that the browser loads as WASM, so the filesystem and the app cannot disagree about what a stored
version means, and it talks to the same routes the web client does, adding none.

**Closing a file after writing to it is what appends a version.** That is the whole product: edit a
note in whatever editor you already have, and every save is a point in its history.

- **A file that is not a note lives in the mount and nowhere else.** This is the load-bearing idea.
  Saving a file is rarely a write to it - `sed -i` writes a temporary beside it and renames it over
  the top, GNOME writes `.goutputstream-...`, vim writes `4913` to test whether it can create files.
  Refusing those names would refuse `sed -i`; turning them into notes would fill the vault with swap
  files. They live in the mount, and renaming one onto a note's name is what commits it.
  `mount --ignore <GLOB>` adds to the built-in list, which can only hold shapes somebody thought of.
- **A rename onto an existing note is a new version of it**, and **a note renamed to an editor's own
  name is copied there and does not move.** Every graphical editor saves one of those two ways, and
  reading either the obvious way destroys the history of every note it touches. `fs.rs` has the full
  account of both, including the real vault it happened to.
- **Which server it talks to is a build-time decision**, the same one the packaged clients make:
  `config::BUILT_IN_SERVER` is the last resort in `config::choose_server`, behind `--server`,
  `SERBLENOTES_SERVER` and a saved session, and is set by `SERBLENOTES_SERVER_URL` at compile time.
- **Every value it would otherwise ask a terminal for has a flag and an environment variable**, so a
  mount comes up from a script or a unit file with stdin closed. A password on a command line is
  visible in `ps`, which is said once, factually, without refusing it - and an empty password is a
  real password, so nothing treats empty as absent.
- **The vault key is kept in a 0600 file, not a keychain**, and every place offering to remember one
  says so. A mount usually runs where there is no session bus, and a keychain that cannot be reached
  is worse than a file because it makes the promise and does not keep it.
- **Remote changes are polled**, not pushed. A note that moved under an open buffer is three-way
  merged, never overwritten. An edit the server would not take is sealed into the cache directory and
  retried, including across mounts: offline is not an error the editor is told about; a refusal is.
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
- **Questions are asked in the app's own dialogs.** `window.confirm` and `window.prompt` block the
  page, cannot be styled, and on some platforms offer to suppress themselves - silently answering the
  *next* question on the user's behalf. Use `components/Modal.tsx` and the `ConfirmModal` /
  `PromptModal` built on it, and say the consequence rather than "Are you sure?". There are none left
  in the client; do not add one.

Server-side resource limits are a different question - they protect other people on the service - but
set them high enough that nobody ordinary meets them, and fail with a clear reason.

## Testing

```fish
cd SerbleNotes.Core; cargo test              # ~25s
dotnet test SerbleNotes.Backend.Tests
cd SerbleNotes.App; npm test                 # node's own runner over SerbleNotes.App/tests
cd SerbleNotes.Fuse; cargo test              # ~5s
```

**The core is held to a stricter standard than the rest of the repo.** It holds the only copy of the
logic that turns stored bytes back into someone's notes, and a bug that corrupts rather than crashes
destroys history no backup helps with, because the server only ever had ciphertext. **Any change to
`crypto.rs` or `version.rs` needs tests before it lands.** `tests/common/mod.rs` holds the text corpus
(empty, no trailing newline, CRLF, emoji, combining marks, content that is itself a diff, content
containing conflict markers) - add a shape when you find one that breaks something.

**Test that wrong input fails, not just that right input works.** Most of the dangerous bugs here
return a plausible document instead of an error; both real bugs found so far were exactly that shape,
and both were caught by a test asserting something *must* fail.

- **Backend:** xUnit over controllers and services with the EF repos replaced by in-memory fakes - no
  database, because everything below the repos is EF's behaviour rather than ours. **The fakes hand
  back copies**, which is the point of them: a fake returning the stored instance lets a caller mutate
  a row and forget to save it, so the test meant to prove the save happens proves nothing. **Error
  message text is deliberately not asserted** - the status code is the contract, the sentence is not.
- **Filesystem:** `mount.rs`/`store.rs` drive the types against an in-memory server, `api.rs` runs
  against a real socket because it is the one module with no seam a fake can go under, `cost.rs`
  counts requests rather than timing anything, and **`mounted.rs` mounts for real and uses `ls`,
  `cat`, `mv` and `sed -i` against it**. `mounted.rs` has the best bug-per-test rate in this repo by a
  distance: both bugs that reached a real vault were invisible to the direct tests and obvious the
  first time a kernel and a real program were involved. Anything about what the *kernel* does around a
  save belongs there.
- **The FUSE CLI is deliberately thin.** Everything in `main.rs` that decides something is lifted into
  the library where it can be tested. When something there starts making a decision, move it out.
- **Client:** the pieces that can be *wrong* rather than broken - the store against a fake server with
  the real core doing the crypto, paths and archives, the table layout that rewrites the user's text,
  the diff reader, conflict parsing, CSS scoping, paste conversion, date parsing. Everything else is a
  button that either works or visibly does not. No test framework was added: node's own runner with
  `--experimental-transform-types` (not `--experimental-strip-types`, which refuses the parameter
  properties the editor plugins use), and `tests/support/hooks.mjs` puts the `.ts` back on relative
  imports. The directory is outside `tsconfig.json`'s `include`. jsdom is a dev dependency and
  `tests/support/dom.ts` is the whole of using it, so anything that is really DOM is left untested
  rather than tested through a second-hand DOM.

### Mutation testing

Coverage says a line ran; mutation testing says whether anything would have noticed it being wrong.

```fish
cd SerbleNotes.Backend.Tests; dotnet stryker      # ~40s
cd SerbleNotes.App; npm run test:mutants          # one module, ~70s
cd SerbleNotes.Core; cargo mutants -j 4           # ~4 min
cd SerbleNotes.Fuse; cargo mutants -j 4           # ~45 min, 540 mutants
```

**A surviving mutant is a question, not a defect.** Three kinds show up: a real gap (fix it), an
equivalent mutant that cannot change behaviour (leave it, say why), and something not worth pinning -
mostly user-facing message strings, by the rule above. It has found real product bugs, not just test
gaps: a stale device list handed out by presence, backend writes that were never persisted, two
functions nothing called at all, and a `rmdir` that took a folder's parents with it.

Two things to know before reading the filesystem's report. **Mutants in the `impl Filesystem`
callbacks show as survivors**, because only `mounted.rs` reaches them and it needs `/dev/fuse`, which
a sandbox does not reliably have - they are covered, the report cannot see it. And **it leaves mounts
behind**, because some mutants break the unmount path by design:

```fish
for m in (mount | grep -oP 'on \K[^ ]+' | grep serblenotes); fusermount3 -u -z $m; end
```

StrykerJS is run **one module at a time** through `scripts/mutation-tests.sh`, which refuses to run no
tests - node exits 0 when its argument matches nothing, which Stryker reads as "the tests passed" and
reports every mutant as surviving. It also needs `ignorePatterns` for `src-tauri/target` and `gen`
(10 GB it would otherwise copy per run) and `SERBLENOTES_CORE_PKG` to find the crate.

## Backend code style

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

Two deliberate oddities, both with reasons that outlive the memory of making them:

- **Pomelo 9 / EF Core 9 packages on a net10.0 target.** Pomelo has no EF10 build. The EF10 CLI drives
  it happily; do not "fix" it by bumping EF Core alone, which breaks the provider.
- **`ServerVersion.Parse` from config, not `AutoDetect`.** Auto-detecting means a reachable database is
  needed just to construct the model, so builds, migrations and CI would all need a live server.

## Commands

Needs .NET 10 with `dotnet-ef`, Rust, Node 22, and a MySQL the backend can reach - point
`ConnectionStrings:MySql` at it in `appsettings.Development.json`, which is not committed. Redis and
MinIO are not needed; nothing uses them yet. Examples are fish, so `export X=y` does not work
(`set -x X y`).

```fish
# Backend. `dotnet build` is pure .NET - it never invokes npm.
# Pending migrations apply automatically at startup, so `database update` is rarely needed.
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
cd SerbleNotes.Fuse; cargo build --release
serblenotes-fuse login --server http://localhost:5179
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

**wasm-pack is a devDependency**, so `npm ci` is the whole of installing it and a build agent needs
nothing set up by hand, except a Rust toolchain for wasm-pack to drive. `npm ci --ignore-scripts`
breaks it: the postinstall is what downloads the binary.

### Building the clients

Three things that are not in the repo, each failing in a way that does not say so:

- **Desktop:** development headers for `webkit2gtk-4.1` and `libsoup3`, or the build stops at
  `javascriptcoregtk-4.1 was not found in the pkg-config search path`. The runtime libraries are
  usually already installed; the headers are not.
- **Android:** a JDK the Android Gradle Plugin accepts (17 to 21) on `JAVA_HOME`, plus `ANDROID_HOME`
  and `NDK_HOME`. A newer default `java` fails with `Unsupported class file major version`, which does
  not mention Java.
- **Windows:** no supported cross-compile, so it builds in CI. `.github/workflows/clients.yml` builds
  Linux, Windows and Android from one commit and needs `VITE_API_BASE_URL` as a repository variable.

### Releasing

Two channels and one button. **Bump `version` in `tauri.conf.json`, commit and push**, then run the
Clients workflow from the Actions tab with **Create a GitHub release** and **Publish to Google Play**
ticked as wanted. It reads that version, builds Linux, Windows and Android from the commit you pushed,
uploads the AAB to Play and attaches the APK to a GitHub release.

**Only the APK is released; the desktop bundles stay run artifacts.** The release job downloads one
named artifact and ships whatever is in it, so shipping desktop too is deleting that name - but it
still waits on every client compiling.

**The workflow creates the tag, and creates it last** - the release is what makes it, at the commit
that was actually built. A tag naming a commit whose Windows build failed would be a lie, and tagging
by hand beforehand means a second copy of a version that already lives in `tauri.conf.json`. So there
is deliberately **no `push: tags` trigger**; a hand-pushed tag does nothing.

**Play goes no further than the track you pick, and `internal` is the default.** Promoting means
choosing a rollout percentage and writing release notes, which somebody decides in the Play Console.

**The GitHub APK and the Play build are not interchangeable.** Play App Signing means Play hands out
an app signed by Google's key while the APK here carries our upload key, so Android treats them as
different apps and refuses to install either over the other. Moving between them means uninstalling,
which costs the cached vault key and the per-device empty folders - the notes themselves are on the
server. The generated release notes say so, on the page where somebody is about to download it.

The APK is one universal file rather than per-architecture splits, and
[Obtainium](https://github.com/ImranR98/Obtainium) pointed at the repository is how it updates itself.
**F-Droid proper is not worth starting on**: they build on their own servers, where `wasm-pack` being
an npm package that downloads a prebuilt binary is disqualifying, and they sign with a third key.

Secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
`PLAY_SERVICE_ACCOUNT_JSON`, and `ANDROID_KEY_PASSWORD` only for an older JKS keystore that really has
a separate key password. With none set the job falls back to a debug APK, so a fork is not a workflow
that fails. The key is written into the workspace and shredded in a step that runs `always()`.

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
  every release and re-running one cannot publish. The `preflight` job refuses a version whose tag
  already exists, **before compiling anything**. Play is uploaded to before the tag is written, so a
  run that fails after that step leaves a version Play has seen and git has not - it is spent either
  way, and the next run has to be a new one.
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
