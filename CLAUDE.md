# Serble Notes

End-to-end encrypted, version-controlled markdown notes platform. Backend is ASP.NET Core; clients
are Tauri v2 apps sharing one Rust core that owns *all* crypto and version-control logic.

`PROJECT.md` holds the original brief. This file is the working context; keep both in sync when the
design changes.

**Status: MVP built and working.** Vaults, notes, the version DAG, live sync, zip import/export, the
web client and the Tauri shell all exist. What is deliberately *not* built yet: file attachments and S3 (needs MinIO),
the Redis backplane, and the FUSE filesystem. Those are described below as design, not as code that
exists - everything else is real.

## Architecture

Monorepo. Everything lives here:

| Path | What |
| --- | --- |
| `SerbleNotes.Backend/` | ASP.NET Core API (net10.0). Sync, metadata, auth. **Also serves the web client.** |
| `SerbleNotes.Core/` | Rust crate: crypto, diffing, merge, replay. Compiles native (rlib) and to WASM. |
| `SerbleNotes.App/` | React + TS client. Built into the backend's `wwwroot` for the web, and wrapped by the Tauri shell for desktop and Android. |
| `SerbleNotes.App/src-tauri/` | The Tauri v2 shell: Linux, Windows, macOS and Android. Thin - see "The native clients". |
| `SerbleNotes.Fuse/` | (not built) Linux FUSE filesystem so a vault can be edited in any editor. |

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
  (Keychain / Credential Manager / Secret Service / Android Keystore, and IndexedDB-with-caveats on
  web). Server stores only the salt, KDF params, and the wrapped blob - it cannot open them.
- **Unencrypted vaults.** Key derived from material the server can see. This is deliberate: these
  vaults are *not* E2E, and the server can read them. That's the point of the option - no per-device
  unlock, and future server-side conveniences (share links, previews) are possible for these vaults
  only. Never imply to the user that an unencrypted vault is private from the server.

**Changing a password re-wraps the key; it does not replace it.** `rewrap_vault_key` unwraps with the
old password and seals the *same* vault key under the new one, so nothing in the vault is rewritten,
no cursor moves, and a device that already holds the key carries on working. The old password is
checked by being used - the server holds a blob it cannot open and has nothing to compare against -
and a fresh salt and today's KDF params are used for the new wrapping, so a vault made under weaker
settings is upgraded by the change. `ChangePasswordDialog` says all of this, including the part that
does not flatter: someone who knew the old password and kept a copy of the old blob can still derive
the key, and it opens everything the vault will ever hold. Only re-keying would take that back, and
re-keying means rewriting every note name and every stored version - not built.

The wire and storage format is identical for both kinds, so the sync path has exactly one code path.
Attachments are encrypted with the same vault key.

### Version control

Versions form a **DAG**, not a line. Every version references its parent(s); content is stored as a
diff against the parent, with periodic full snapshots so history replay stays cheap.

- Automatic snapshots as the user types (debounced), plus **manual named restore points**.
- Concurrent edits: the Rust core does a three-way merge against the common ancestor. Unmergeable
  hunks become conflict markers the user resolves in the editor - no silent loss, no auto-pick.
- The UI must make all of this legible: what changed, when, which branch, how to go back.

Because the server can't read diffs, history pruning/GC decisions are driven by client-supplied
metadata, not by inspecting content.

### Notes, names and folders

A note has one name, and a `/` in it is a folder. `Work/Projects/Alpha` puts Alpha inside Projects
inside Work. **There are no folder records anywhere** - not in the database, not in the client. The
tree the sidebar draws is derived from the names, and the tree the FUSE filesystem will mount is
derived from the same function in the core (`path.rs`). Nothing to create before filing a note into
it, nothing to clean up when the last note leaves, and no second structure that can drift out of step
with the first.

- **The name is ciphertext.** "Medical/Test results" tells you as much as the note body does, so it
  is sealed with the vault key like everything else and stored in `Note.Name` as a blob. Folder names
  therefore cannot leak either - they only exist inside that string.
- **Renaming is metadata, not an edit.** `PUT /api/notes/{id}/name` changes the sealed name, bumps
  the vault cursor and notifies other devices, but appends no version. History stays a record of what
  a note said, not where it was filed - and it maps onto a plain filesystem `rename()` later.
- **Moving is renaming.** Put a different folder in front of the name and the note lives somewhere
  else. Renaming a folder is the client rewriting the names of everything underneath it.
- **The path is never shown as text.** That a note's name happens to encode its folder is an
  implementation detail of the storage, and the UI does not repeat it at the user. A note is called
  "Test results"; "Medical" is where it is, not what it is called. The editor shows a folder trail
  above an editable title holding only the leaf, and the sidebar shows leaf names in a tree. Nobody
  types a `/` to file something - they drag it, or pick a folder. (A `/` typed into a name still
  nests, because `normalise_path` still means what it means. It is just never advertised or
  displayed.)
- **Two things cannot share a path.** `VaultStore.refuseIfTaken` blocks a move or rename that would
  put a note and a folder, or two notes, at the same place. This is the same class of refusal as
  `normalise_path` rejecting `..`: not a judgement about what the user should want, but about what
  can be represented - the tree could not draw them apart and a filesystem could not hold them. It
  fails with a sentence naming what is in the way.
- **Everything is joined through `VaultStore.join`, never by normalising a joined string.**
  `normalise_path("Work/   ")` is `"Work"`, so a note renamed to nothing would silently take its own
  folder's name and jump up a level. Tidying the leaf on its own refuses it instead. This was a real
  bug, caught by a test asserting a blank rename *must* fail.

### Empty folders

A folder with nothing in it has no note name to be read out of, so it cannot exist in the model at
all. Giving the server folder records would create exactly the second structure this design avoids.
Instead `VaultStore` keeps a per-device list in `localStorage` (`serblenotes.emptyFolders.<vaultId>`)
of folders made but not yet written into. They draw in the tree, accept drops, move when renamed, and
are forgotten the moment a note gives them a real existence. A folder that loses its last note is
added back to that list, because a file manager does not delete a directory when you drag a file out
of it.

The honest limitation: an empty folder is local to the device that made it, and vanishes if that
browser's storage is cleared. Nothing is lost when it does - an empty folder holds no data - and the
same will be true of `mkdir` on the FUSE mount before anything is written to it. Do not "fix" this by
adding folder rows to the database.

### Archives: a vault is a folder of markdown files

Export writes the vault as a zip - one `.md` file per note, real directory entries for folders - and
import reads one back. **This is the layout the FUSE filesystem will mount**, which is why the two
functions that decide it live in `path.rs` next to everything else that decides where a note is:
`archive_path` and `note_name_from_archive_path`. If the archive and the mount disagreed about what
a file is called, a vault would look like two different things depending on how it was opened.

- **The whole note name is the file's stem; `.md` is added on the way out and taken off on the way
  in.** A note called `todo.md` becomes `todo.md.md`. That looks wrong and is the only mapping that
  is reversible - `todo` and `todo.md` are two notes and both have to come back as what they were.
  A property test generates names and asserts the round trip; an export that renames notes is not a
  backup.
- **Anything else in the archive still becomes a note.** `notes.txt` imports as a note called
  `notes.txt`, and so does a file with no extension. Only `.md` is stripped. Dropping someone's file
  because of its name would be the forbidding kind of behaviour this project does not do.
- **What cannot become a note is reported, never guessed at.** A file that is not valid UTF-8 has
  nowhere to go until attachments exist; `__MACOSX/`, `.DS_Store` and `Thumbs.db` are the unzipper's
  files rather than the user's. Both are listed in the dialog with the reason.
- **Every path from an archive goes through `normalise_path`**, so `../../.ssh/authorized_keys`
  cannot be imported at all - it is refused for the same reason a note cannot be named that. A
  leading `/` is tidied away rather than refused, because it can only mean the root of the archive.
- **Nothing is ever overwritten or merged.** A name already in the vault is left exactly as it is and
  reported: the archive cannot say whether its copy is newer or a different note that shares a name,
  and guessing destroys the one the user did not pick. Everything else still imports, so one clash
  does not cost them the other two hundred.
- **History is not in the archive**, and the export dialog says so. A folder of markdown has nowhere
  to put a version DAG, and a sidecar format would make the archive readable only by this app.
- **The archive is plaintext and is built and read on the device.** It never passes through the
  server - it is exactly what the server is not allowed to see - and the export dialog says that too.
- **No backend route was added.** Import creates notes through the API that already exists; export
  reads the store that is already in memory. The server does not know an archive happened.

`services/archive.ts` turns the model into a zip with **fflate**, whose *synchronous* API is the one
to use: the async one spins up a worker from a blob URL, and the Tauri app's CSP (`default-src
'self'`) does not allow that. It is dynamically imported, so a session that never exports downloads
none of it. `VaultStore.exportEntries` / `importNotes` own the vault side, as with every other
operation, and `importNotes` posts each note without pulling and pulls once at the end - the
per-note pull `createNote` does would otherwise be one extra round trip per file.

Saving and picking a file is `services/files.ts`. The web client uses a download and a hidden file
input; the native clients go through the OS dialogs (`tauri-plugin-dialog`) and read or write the
result with `tauri-plugin-fs`. That pairing is deliberate: **the dialog plugin adds the file the user
picked to the fs plugin's scope**, so `capabilities/default.json` grants `fs:allow-read-file` and
`fs:allow-write-file` with no path scope at all - with none granted, the app can touch nothing except
what someone pointed it at. A webview download would also be at the mercy of the engine underneath,
and on Android the picker hands back a `content://` URI that only the fs plugin can open.

### The sidebar is a file manager

`components/NoteTree.tsx` is expected to be as capable as any file tree: drag a note or a folder onto
another folder to move it, drop onto empty space for the top level, hover a shut folder mid-drag to
open it, right-click anything for a menu, rename in place (double-click, or the menu), filter, and
"Move to..." for when dragging is awkward or impossible (a phone). Two things worth knowing:

- **The drag payload is a module-level variable, not React state.** `dragover` fires continuously and
  cannot read `dataTransfer` - browsers only expose the payload on `drop` - so the handler needs a
  value it can read synchronously without re-rendering the tree on every pixel.
- **One button collapses every folder, and expands them when they are all shut.** Same idea as the
  tree toggle in the app bar: it does the thing there is any point in doing, so it only offers
  "expand" at the moment nothing is open. The shut set is `useCollapsedFolders` in `NoteTree.tsx` -
  the tree draws the folders and the toolbar above it has the button, so the state cannot live in
  either one. Shutting everything writes down the folders that exist rather than every folder ever
  seen, so the list does not accumulate paths that were deleted years ago.
- **It remembers which folders are *shut*, not which are open.** A folder's only identity is its
  path, so renaming or moving one loses whatever was remembered about it, and that failure has to
  fall the harmless way. Remembering open folders meant a renamed folder slammed shut and swallowed
  the note that had just been dropped into it - found by driving the real UI in a browser.
- **`normalise_path` cleans, it does not judge.** Whitespace trimmed, repeated slashes collapsed,
  empty segments dropped. It refuses only what cannot be represented: an empty name, a `.` or `..`
  segment (which would let a note escape its folder once mounted), NUL, and line breaks. An
  over-long segment is *reported* so the UI can mention it, never refused - see "Inform, never
  forbid".

### The shell around it

One dark theme, deliberately quiet: the chrome is near-monochrome so the note is the brightest thing
on screen, and colour is reserved for state - unsaved, not encrypted, refused, an older version.
Every value lives as a custom property at the top of `index.css`, and the CodeMirror theme in
`MarkdownEditor.tsx` reads the same ones (`--text`, `--muted`, `--accent`, `--surface`,
`--surface-2`, `--border`), so renaming a token changes the editor too.

- **One icon weight, and glyphs simple enough to carry it.** `base()` in `components/Icons.tsx`
  gives every icon a 2.2 stroke on the 24 grid. Weight and detail trade against each other: at 16px
  a hairline reads as disabled rather than quiet, and anything with more than two or three strokes
  fills in solid once it thickens. So the safe lost the tick marks around its dial, the key was laid
  flat because a diagonal shaft ran into its own ring, the bin lost its taper, and the open folder
  was redrawn so its two halves meet at one corner instead of overlapping. If a new icon needs a
  fourth stroke to be readable, it is the drawing that is wrong, not the weight.
- **The mark is the page as the power ring.** Serble's symbol is the power glyph, so the product
  mark is a page whose top edge breaks for the power stem, with the note's lines written inside it.
  It is drawn twice and only twice: `LogoIcon` in `components/Icons.tsx` on the 24 grid every other
  icon uses, and `public/icon.svg` on a 64 grid for everything outside the app. Change one and
  change the other. Two things about it are not preference: it holds three horizontal strokes in a
  small space, so it stops reading below about 18px and is never rendered smaller than that in the
  app; and in the chrome it stays `--muted` like any other icon, because colour here means state and
  a logo is not a state.
- **`public/icon.svg` is published, not just shipped.** It is the browser tab's icon *and* the file
  other sites embed - `/icon.svg`, with `/icon.png` (512px), `/favicon-32.png` and
  `/apple-touch-icon.png` beside it, all generated from that one drawing and listed in the README.
  `Program.cs` gives those four paths a one-day cache instead of the shell's revalidate-every-time,
  and they already answer cross-origin because `UseCors` sits ahead of the static file middleware.
  Two things follow from being embeddable. It takes **one** fixed blue, `--accent-fill`: a
  `prefers-color-scheme` query would follow the *viewer's* OS theme, which says nothing about the
  background of the page it was embedded on, so it would be wrong half the time - and the deep blue
  is the one that reads on both, about 4.6:1 on white and 3.5:1 on a dark tab strip. And it is
  served from `wwwroot`, which the frontend build empties, so it has to live in `SerbleNotes.App/
  public/` rather than being dropped into `wwwroot` by hand.
- **The platform icon sets are generated from that same file, never drawn again.**
  `scripts/make-icon.py` rasterises `public/icon.svg` into `SerbleNotes.App/icon-build/` (ignored):
  a 1024px tile on the app's own dark ground for desktop, Windows and iOS, plus a transparent
  foreground and a flat background for Android's adaptive icon, and the manifest that names all
  three. Then `npx tauri icon icon-build/manifest.json` writes `src-tauri/icons/**` - the .ico, the
  .icns, the Windows Square logos and the 18 iOS AppIcon sizes. On the tile the mark takes `--accent`
  rather than the committed `--accent-fill`, because here the background is known.
  Two things about it that are not obvious:
  - **`tauri icon` writes the Android set straight into `gen/android` when that project exists**,
    and leaves `src-tauri/icons/android` untouched - which is the copy a *new* `tauri android init`
    would seed from. `make-icon.py --sync-android` copies the first back over the second, or the old
    icon reappears the day someone wipes `gen/android`.
  - **The adaptive foreground is 46% of its canvas** and no larger. A launcher masks it to a circle
    about two thirds across, and a square mark any bigger has its corners cut off by that circle.
- **Buttons are bare by default.** `button` is a label that lights up under the pointer; `.primary`
  is a filled slab and there is at most **one** on a screen, which is what makes it mean something.
  `.ghost` is the bare one, `.ghost.on` is a toggle that is currently on, `.icon` is a square.
  Bordered boxes around every action was the look this replaced.
- **Two blues, on purpose.** `--accent` is for text and marks on a dark ground; `--accent-fill` is
  darker so that white text on a filled button actually reaches contrast. One blue fails at one end
  or the other.
- **Three screens, one structure.** The vault list (`VaultsPage`) is rows, not cards - name, whether
  it is encrypted, when it last changed. The workspace (`VaultPage`) is an app bar, the file-manager
  sidebar, the editor, and a rail of panels on the right. Both sit inside `.shell` / `.workspace`,
  which are full-height flex columns; nothing but the editor surface, the sidebar and the rail
  scrolls.
- **Panels are a component, not a layout.** `components/Panel.tsx` is the shell every side panel
  shares - a title, one action, a close button - and `PanelRow` is a label/value line. `NoteDetails`
  and `HistoryPanel` are both built from it, and both close from the panel itself as well as from
  the toolbar toggle, because on a phone the panel covers the toggle that opened it.
- **The note's own controls live on the note bar**, not in the app bar: Details and History are
  about the open note, so they sit beside its name.
- **The rail is a trough and each panel is a card in it.** Two panels separated by a single
  hairline read as one long list with a heading in the middle, so they get a real gap, their own
  border and their own background. Nothing in the rail scrolls: each panel scrolls its own body,
  which is what lets the boundary between them be dragged.
- **Every boundary is draggable, and the tree collapses.** `components/Splitter.tsx` does both axes:
  the two column edges, and the shelf between the details and history panels. Drag it, double-click
  (or Home) to put it back, arrow keys to nudge - it is a `separator` with a value rather than a bare
  div, so a divider that only answers to a mouse is not one some people cannot move at all. The
  column handles are positioned absolutely over the column's own border, so a 9px grab area costs
  the layout nothing.
- **It measures rather than being told.** A splitter reads the size of the sibling it resizes
  (`previous` or `next`) at the moment it is grabbed, which is what lets the details panel sit at
  whatever its contents come to until someone drags it - and lets a double-click put it back to
  "auto" rather than to a number somebody picked.
- **There are no minimum or maximum sizes**, deliberately: a column dragged shut is a thing someone
  can want and can see happening, and the tree toggle or a panel's own close button brings it back.
  The two things a splitter *does* enforce are about what can be represented rather than what the
  user should want - the size stops at the room actually available (the parent, less the siblings
  that will not yield), and the handle's own position is clamped so it can never follow a column off
  the edge and become ungrabbable.
- **The padding is on an inner box** (`.sidebar-inner`, `.rail-inner`). Padding on a border-box
  element is a width it can never shrink below, so a column with 0.6rem of it stops at 20px instead
  of shutting; the thing being dragged and the thing holding the padding have to be two elements.
- Sizes and the collapsed flag live in `services/layout.ts` (`serblenotes.layout` in localStorage,
  guarded only against values that are not sizes at all) and reach the stylesheet as `--sidebar`,
  `--rail` and `--details` set inline on `.workspace` - which is why a drag re-renders one attribute
  and measures no React tree.
- **One button, two meanings.** The tree toggle collapses a column on a wide screen and opens a
  drawer on a narrow one, because those are the same idea in two layouts. That is the one place a
  breakpoint is duplicated: `NARROW` in `VaultPage.tsx` has to match the `860px` in `index.css`, and
  there is no way to ask the stylesheet, so the comment on it is the link. The app bar holds the vault.

### It has to work on a phone

- **The two side columns become drawers**, over the editor rather than beside it: the rail at
  1100px, the sidebar at 860px. A drawer is sized against the viewport, so the splitters are hidden
  at the same widths - there is no boundary left to drag. Only one is ever open - the tree toggle shuts the panels when it
  opens, because they overlapped and it looked broken. A scrim behind them closes everything.
- **Every control grows where there is no pointer.** `--control` is 32px normally and 44px under
  `(pointer: coarse)`; text inputs are never below 16px, or iOS zooms the page on focus and does not
  zoom back out. Anything that only appeared on hover - the delete icon on a tree row - is simply
  there on a narrow screen, because there is no hover to reveal it.
- **Width and input device are different questions.** `.wide-only` / `.narrow-only` key off width.
  What the *pointer* can do is asked with `(pointer: coarse)` directly, where it matters: `--control`
  grows, the copy button on a code block gets bigger, and the delete icon on a tree row stops waiting
  for a hover. There was once a line of text under the sidebar explaining that you can drag a note
  onto a folder; it was removed. A file tree that behaves like a file tree does not need to say so,
  and the sidebar is short of room before it is short of prose.

### File metadata

`components/NoteDetails.tsx` is the panel that answers "what is this note": where it is filed, when
it was created, when it last changed, how many words and characters, how many versions and named
restore points, and how much the whole history takes up.

Nothing here costs the server anything new. The timestamps are ones it keeps anyway to order the
sync, the counts come from the decrypted text in the editor, and "last edited" is the newest
version's own stamp rather than the note row's `UpdatedAt` - a rename bumps that, and a rename is
not an edit. `services/dates.ts` is the one place a timestamp is turned into words: the API sends
UTC with no zone marker, and `new Date` reads a bare stamp as local time, which puts every date in
the app hours out for anyone not on UTC.

### The editor has no modes

Markdown renders in place as you type. There is no edit view, no preview view, and no toggle between
them, because the document only ever exists in one state. What changes is how much of the markup is
visible: the line the cursor is on shows its raw syntax so it can be edited, every other line hides
the punctuation and shows the result. Put the cursor on a heading and the `#` comes back.

It is CodeMirror 6 with a custom `livePreview` view plugin (`components/livePreview.ts`) that walks
the syntax tree and applies decorations - line classes for headings, quotes and code blocks, mark
classes for emphasis and code, and replace decorations that hide markup on inactive lines. Two things
to know before changing it:

- **Mount the editor with `key={noteId}`.** That rebuilds it per note, which resets the undo history.
  Without it, undo in one note reaches back into another note's text.
- **The markdown language is assembled by hand** in `components/markdownLanguage.ts` from
  `@lezer/markdown`, rather than using `@codemirror/lang-markdown`. That package statically depends
  on `lang-html`, which pulls in the whole JavaScript and CSS parsers so it can highlight HTML
  embedded in a note; tree-shaking cannot reach it, and it was about two thirds of the bundle. If you
  swap the parser back, check that every node name `livePreview` keys off still exists, or rendering
  silently stops working.

### Code blocks

A fenced block is drawn as a card with the language on a chip in its corner, and its contents are
highlighted by that language's own parser, nested into the same syntax tree by `parseCode`.

- **The info string is never shown as text.** ```` ```rust ```` says how to render the block; it is
  not part of what the block says, so `CodeInfo` is hidden exactly like a link's destination and the
  language reappears as the chip. Put the cursor on the fence line and the raw text comes back, like
  every other line.
- **The chip is a CSS `::after` on the line, keyed off a `data-lang` attribute**, not a widget
  decoration. A widget sits in the text flow, and the cursor can then be placed either side of
  something that is not in the document. It sits in the *left* corner, because the right one is
  where the copy button goes and a chip is as wide as the language it names.
- **The chip and the copy button are one line across the top of the block**, so they are the same
  box: same font, padding, line height and border, and one pair of inset constants
  (`CHIP_INSET_Y`/`CHIP_INSET_X` in `MarkdownEditor.tsx`) that the chip uses as `top`/`left` and the
  button as `margin-top`/`margin-right`. Change one without the other and they sit a couple of
  pixels out of step - nobody can name it, everybody can see it.
- **One copy button, which moves** (`components/copyCode.ts`). Not a widget either, and not one
  button per block: it is a plain element in `.cm-scroller`, outside the document entirely,
  positioned over the block the pointer is on - or, when there is no pointer, the block the cursor
  is in, which is how it is reached on a phone. Being a child of the scroller is what makes it scroll
  with the text without a single scroll handler. Three things about it were found by driving a real
  browser, and all three are the kind that look fine in review:
  - **Measuring has to happen in CodeMirror's own read phase.** `coordsAtPos` throws if called from
    an update, and a plugin that throws is removed - so the button never appeared at all. It goes
    through `view.requestMeasure`, reading in `read` and writing the position in `write`.
  - **A position on the edge of a block is outside it.** `resolveInner(pos, 1)` from the newline at
    the end of a closing fence lands past the node, so hovering a block's last line found nothing.
    It now tries both sides.
  - **`right` is measured from the padding box and `getBoundingClientRect` gives the border box**,
    which differ by the scrollbar. The edge comes from `scrollDOM.clientWidth` instead.
  - **`coordsAtPos` answers where the *characters* are**, which is below the block's top padding,
    while the chip is placed from the top of the line - so the two sat a padding apart. It measures
    `lineBlockAt` now, and the result is not rounded: a line does not begin on a whole pixel, and
    rounding it left the button half a pixel off the chip.
- **What it copies is `CodeText`**, which the parser has already stripped of fences, info string and
  - for an indented block - the indent that made it one. It is read at the moment of the click, so
  it is what the block says now rather than what it said when the button appeared.
- **The rendered preview gets the same button on every block** (`MarkdownPreview.tsx`), added after
  sanitising rather than by the renderer: everything markdown produces goes through DOMPurify, and a
  button is exactly the sort of thing that should not survive it. Markup from a note is inert;
  anything interactive on the page was put there by this app. Both share `.copy-code` in `index.css`
  and `services/clipboard.ts`, which falls back to `execCommand` where `navigator.clipboard` is
  refused (an insecure context, or a WebKit embedding) and tells the caller which happened.
- **The card is painted per line.** CodeMirror gives every line its own element, so the sides are on
  each line and the corners on the two ends (`cm-md-code-open` / `cm-md-code-close`). The fence lines
  are left in place rather than collapsed away, and become the card's top and bottom padding once
  their backticks are hidden.
- **There is no width cap on a note.** The editor is as wide as the column it has been given, which
  is the width the user chose when they dragged the splitters, and the rendered preview matches it,
  so a note reads the same width in both.
- **A block is as wide as it needs to be, and then it wraps.** It shrinks to its widest line; past
  the width of the pane it stops and the lines wrap instead of scrolling sideways, with
  `overflow-wrap: anywhere`, because what overflows is usually one unbreakable token (a URL, a hash)
  that a normal word break would leave hanging off the edge.

  In the preview that is two CSS declarations, because a block there is one element. In the editor it
  has to be **measured** (`components/codeWidths.ts`): CodeMirror gives every line its own element
  and the card is painted across them, so "as wide as the widest line in this block" is not something
  the lines can know about each other. A copy of the block is laid out off-screen at its natural
  width, the answer goes into a state field, and `livePreview` puts it on every line of that block -
  which is what keeps the card's sides straight. Four things about it are worth knowing:
  - **What is measured includes the badges.** The chip and the copy button share the row above the
    code, so the off-screen copy has both of them in it, put back into the flow by two rules in the
    theme. A two-character block is still wide enough to show its own furniture, which is the one
    thing "shrink to fit" cannot be allowed to mean.
  - **`.cm-content` needs `min-width: 0`.** It is a flex item, and a flex item will not shrink below
    the widest thing inside it unless it is told it may - so a block wider than the pane made the
    whole editor scroll sideways instead of wrapping.
  - **The widths cannot be dispatched from where they are worked out.** An update is in progress
    both when the block is noticed and when the measure pass sizes it, and a transaction cannot be
    dispatched from inside one. It goes out on a microtask, which still lands before the frame is
    painted, so nothing is ever seen at the wrong width.
  - **`livePreview` has to rebuild for it.** The measurement arrives as a state change of its own
    with no edit, no selection move and no scroll attached, so the decorations are rebuilt on
    `codeWidthsChanged` as well - without that the widths are computed, stored, and never used.
  - In the preview the button gets a measured `padding-right` on the `pre` rather than a minimum
    width: the card is as wide as its widest line, so anything less leaves the code running along
    underneath the button. The editor needs no such gutter - the button sits on the opening fence
    line, which has nothing else on it.
- **Every language loads on demand.** `components/codeLanguages.ts` is a list of `LanguageDescription`s
  whose `load` is a dynamic import, so a note with no code downloads no parsers and a note with one
  Rust block downloads one. While a parser is in flight the block renders plain and re-highlights when
  it lands - `ParseContext.getSkippingParser` schedules the re-parse. This is what lets us have both a
  small initial bundle and `lang-html`, which drags in the JavaScript and CSS parsers behind it.
- **An unknown language still gets a chip**, labelled with whatever was written, and is left
  uncoloured. Nothing is refused for not being in the list.
- **Adding a language is one `LanguageDescription`.** `name` is the chip, `alias` is what can be
  written after the backticks. **TextMate packs go here too** - a grammar runner wrapped as a
  `StreamLanguage` fits the same list, and the editor, the live preview and the markdown parser need
  to know nothing about it. What is missing today is the loader and somewhere to keep the packs, not
  a place to put them.
- **`codeHighlighting` in `MarkdownEditor.tsx` deliberately says nothing about markdown's own tags**
  (heading, strong, emphasis, link, list, quote). Prose is styled by `livePreview` through its own
  classes; colouring it from the highlight style as well means two things fighting over the same
  text.

### Sync

WebSocket push, Redis pub/sub for fan-out across backend instances. A client holds a socket, receives
"vault X changed to cursor N" events, then pulls the encrypted versions it's missing over HTTP. The
socket carries notifications, not content. Clients must also work fully offline and reconcile on
reconnect - sync is an optimisation over a local-first store, not the source of truth.

### The backend serves the web client

Unlike SerbleFiles, where the SPA was hosted separately, here the ASP.NET app serves the web build
itself. One deployable, one origin: the web client fetches the API, opens the sync WebSocket, and
loads the WASM core all from the same host.

- The web build of `SerbleNotes.App` is published into `SerbleNotes.Backend/wwwroot/` - wired up in
  the csproj so `dotnet publish` triggers the frontend build, not copied by hand.
- Served with `UseStaticFiles()` + `MapFallbackToFile("index.html")`. Every API route lives under
  `/api`, and the fallback only matches paths that don't look like files, so a missing asset 404s
  rather than quietly returning the app shell. `MapStaticAssets` is the fancier option (build-time
  fingerprinting and compression) but reads a manifest fixed at build time, which is a sharper edge
  when the frontend is generated during publish; `UseStaticFiles` reads from disk and has no such
  ordering hazard.
- The WASM core is served with the correct `application/wasm` type and is content-hashed by Vite. If
  the core ever needs threads (SharedArrayBuffer), the app needs COOP/COEP headers too - check before
  reaching for that.
- CORS doesn't disappear: the web client is same-origin now, but the Tauri desktop/Android clients hit
  the API from custom-protocol origins, so the policy still has to accommodate them.
- In development the Vite dev server still runs separately for HMR; only published builds go through
  `wwwroot`. Don't make the dev loop depend on a full publish.

### The native clients

`SerbleNotes.App/src-tauri` is a Tauri v2 shell around the same client. Linux, Windows, macOS and
Android all build from it, and the web client is unchanged - there is **one** frontend build, and it
decides at runtime which it is (`services/platform.ts`, `isNative()`).

**The shell is deliberately thin, and the crypto is not in it.** The core is not linked into the
native binary and not reimplemented there: the webview runs the same crate compiled to WASM, exactly
as the browser does. That is what keeps one copy of the logic that turns stored bytes back into
someone's notes. If something in the shell ever needs to touch note content, the design has gone
wrong - the shell exists for the two things a browser tab cannot do:

- **The keychain.** `src-tauri/src/secrets.rs` puts an unlocked vault key in the OS keychain - Secret
  Service on Linux, Credential Manager on Windows, Keychain on macOS - which is what "enter the
  password once per device" is supposed to mean. Android has no keyring backend in that crate, so it
  uses a `0600` file in the app's private storage instead. **Say which of those it is, never imply
  the stronger one**: `secret_backend` exists so the client can tell the truth, and if the keychain
  refuses to answer at all the unlock screen drops its promise to remember rather than making it
  anyway (`storageWarning`).
- **The deep link**, so the OAuth redirect can come back to an app that has no pages.

The Linux keychain backend is `async-secret-service`, not `sync-secret-service`, on purpose: the sync
one links `libdbus` and would put a C library between us and building at all, where the async one
talks D-Bus through zbus in pure Rust.

**Where the API lives.** The web client is served by the server it calls, so it uses its own origin.
A native client was not, so it has to be told: `VITE_API_BASE_URL` at build time, or - when that is
unset - the sign-in screen asks and remembers it on the device. Every request goes through
`apiUrl()`/`socketUrl()` rather than a bare `/api` path, which is the only reason the same code works
in both. CORS on the backend already allows this: a Tauri webview's origin is `tauri://localhost` or
`http://tauri.localhost`, never the API's own.

**Signing in.** The native clients open the real system browser (`plugin-opener`) rather than a
webview they control, so the app never sees the Serble password, and Serble sends the user back to
`serblenotes://auth/callback`. Two things that follow:

- **That URI has to be on the Serble app registration.** Serble checks `redirect_uri` against a
  `;`-separated list and refuses anything else with `redirect-uri-mismatch`, so add
  `serblenotes://auth/callback` alongside the web one or native sign-in cannot work at all.
- **A Tauri permission is not enough on its own when the command is scoped.**
  `opener:allow-open-url` enables the command; *which* URLs it may open comes from a scope, and with
  no scope granted every URL is refused with `ForbiddenUrl` - so sign-in did nothing at all the first
  time. `capabilities/default.json` grants it `https://serble.net/oauth/*` and nothing else. The
  scope is matched as a plain glob against the whole URL string, and the `glob` crate's `*` crosses
  `/` by default, so one pattern covers the path and query. Widen it only for something that genuinely
  needs opening - links inside notes are not clickable today.
- **The `state` must be letters and digits only.** Serble rejects anything else with `invalid-state`,
  which is why `newState()` is hex rather than a `crypto.randomUUID()` - a UUID's hyphens fail that
  check.

On Windows and Linux the OS answers a deep link by starting the app *again* with the URL as an
argument, so `tauri-plugin-single-instance` (with its `deep-link` feature) hands it to the running
instance instead of leaving the user with a second, signed-out window.

**Android needs the intent filter added by hand.** The deep-link plugin's config covers custom
schemes on desktop and verified App Links (`https://your.domain/...`) on mobile - and App Links need
`.well-known/assetlinks.json` served from that domain with the app's signing fingerprint in it. A
custom scheme needs an `intent-filter` in `AndroidManifest.xml` instead, which `scripts/
android-deeplink.py` adds. It is idempotent and `npm run android:init` runs it, so in the normal case
it happens once and the result is committed with the rest of `gen/android`.

**Wayland with NVIDIA's driver kills WebKitGTK, and the app works around it.** WebKitGTK hands its
rendered frames to the compositor as DMABUF buffers, and that path is broken on the proprietary
NVIDIA driver: no window ever appears and the process dies with `Gdk-Message: Error 71 (Protocol
error) dispatching to Wayland display`, which names neither WebKit nor the driver. WebKitGTK's own
MiniBrowser fails identically on such a machine, so it is the environment rather than anything we do
- but "install it and it crashes" is not a diagnosis to leave to the user. `survive_nvidia_on_wayland`
in `lib.rs` sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` before the toolkit starts.

It is narrow on purpose: only when running under Wayland *and* `/sys/module/nvidia_drm` exists, so an
X11 session and every other GPU keep the faster path. Setting the variable yourself always wins, in
either direction. `GDK_BACKEND=x11` and `WEBKIT_DISABLE_COMPOSITING_MODE=1` also avoid the crash -
the first keeps GPU compositing but goes through XWayland, the second gives up more than it needs to.
Verified by A/B on this machine: three launches without it died with that exact message, three with
it stayed up.

**`src-tauri/gen/android` is committed**, as Tauri intends - it is a real Android Studio project we
have edited. Its own generated `.gitignore` files keep the build output out.

### Auth: Serble OAuth

Login goes through Serble, exactly as in `../SerbleFiles` - read
`SerbleFiles.Backend/Services/Impl/SerbleApiClient.cs` and `Controllers/AccountController.cs` before
touching auth. The flow:

1. Client gets an OAuth `code` from Serble, POSTs it to our `/account`.
2. Backend exchanges it at `{SerbleApi.BaseUrl}oauth/token/refresh` -> refresh token; refresh token at
   `oauth/token/access` -> access token.
3. Backend calls `GET {BaseUrl}account` with header `SerbleAuth: App <accessToken>` to get the user.
4. Backend upserts a local user row (storing the Serble refresh token) and issues **its own JWT**,
   which is what every subsequent request uses.

**A valid signature is not enough.** `OnTokenValidated` also checks that the account row the token
names still exists, and fails the token if it does not. Every row this app writes has a foreign key
to `Users`, so a token for a deleted account otherwise gets all the way to the database and dies on a
constraint violation - a 500 for what is really a stale credential. The client turns a 401 into "sign
in again"; it can do nothing sensible with a 500. This costs one primary-key lookup per authenticated
request. Cases that produce such a token: the account was deleted, the database was restored from a
backup older than the login, or a dev database was dropped and recreated.

Serble auth gates *access to vaults at all* - server-side security. Encryption is the second,
independent layer. Neither substitutes for the other.

Attachments upload direct client->MinIO via **presigned PUT/GET URLs** issued by the backend
(multipart for large files), same approach as SerbleFiles. Ciphertext never flows through the API.

## What exists, concretely

**Rust core** (`SerbleNotes.Core/src/`) - `path.rs`: `normalise_path`, `parent_path`, `file_name`,
`reparent`, `archive_path`, `note_name_from_archive_path`. `crypto.rs`: `generate_vault_key`, `generate_salt`,
`derive_key` (Argon2id), `seal`/`open` (XChaCha20-Poly1305, nonce prepended), `rewrap_vault_key`
(password change). `version.rs`: `make_diff`, `apply_diff`, `replay`, `merge3`. Errors are `Result<_, String>`, never `JsError` -
that is what keeps the same functions compiling natively for Tauri *and* testable with `cargo test`.

**The stored diff format is `serblenotes-diff-v1 <fingerprint>\n<unified diff>`.** The fingerprint is
the first 128 bits of a Blake2s hash of the text the diff was built from, and `apply_diff` refuses
any base that doesn't match. This is not decoration. A unified diff matches on context lines, so it
applies wherever those lines happen to fit: applying one twice appended the same line twice, and
applying one to a near-identical document produced a plausible, wrong result. A wrong document that
loads without complaint is worse than one that fails to load - the editor renders it and the next
autosave writes it over the real note. Two consequences to respect:

- **Changing this format orphans every stored diff.** If it has to change, bump the version in the
  prefix and keep reading the old one. `the_diff_format_this_module_emits_is_pinned` fails loudly if
  it drifts by accident.
- **Never bypass `apply_diff` to call `diffy::apply` directly.** The guard is the only thing standing
  between a mis-parented version and silent corruption.

**Backend API** - all routes under `/api` so the SPA fallback can never shadow them:

| Route | Purpose |
| --- | --- |
| `GET /api` | Health. |
| `POST /api/account` | Serble OAuth code -> this backend's JWT. `GET` returns the current user. |
| `GET/POST /api/vaults`, `GET/DELETE /api/vaults/{id}` | Vault CRUD. |
| `PUT /api/vaults/{id}/password` | New wrapped key, salt and KDF params after a password change. |
| `GET/POST /api/vaults/{id}/notes` | List and create notes. |
| `GET /api/vaults/{id}/changes?since=N` | The whole sync read path. |
| `GET/POST /api/notes/{id}/versions`, `DELETE /api/notes/{id}` | Version DAG append and note tombstone. |
| `PUT /api/notes/{id}/name` | Rename or move. Metadata only - appends no version. |
| `GET /api/sync` | WebSocket. Notifications only, token via `?access_token=`. |

**Sync cursor.** Every vault carries a monotonic `Cursor`; each write reserves the next value via
`IVaultRepo.NextCursor` (an `UPDATE ... SET Cursor = Cursor + 1` and read inside one transaction, so
two devices writing at once can't be handed the same number) and stamps the changed rows with it.
`/changes` reports the highest cursor *in the rows it returned*, not the vault's current one -
reporting the vault's would skip a write that landed between the two queries.

**Migrations apply at startup.** `Program.cs` runs pending migrations before the app binds its port,
creating the database if it does not exist. EF holds a lock while it works, so several instances
starting together is safe - one migrates and the rest wait. If the database is not reachable yet it
retries ten times over about twenty seconds, because a container started next to its own database
usually wins that race; after that it throws and the process exits rather than serving against a
schema it could not verify. Consequences worth knowing: a destructive migration runs the moment the
new build starts with nobody reviewing it first, and rolling back means writing a migration that
undoes it.

**Deletes are tombstones.** A client that was offline when something was deleted only learns about it
from the `deleted` row coming back through `/changes`.

**Web client** (`SerbleNotes.App/src/`) - `core/` is the only door to the WASM; `services/store.ts`
holds the client-side DAG (materialise-by-walking-back-to-a-snapshot, memoised; snapshot every 10
diffs; `commonAncestor` by walking both ancestries), builds the folder tree from decrypted names, and
owns every move and rename (`moveNote`, `moveFolder`, `renameNoteTo`, `renameFolderTo`,
`createFolder`, `deleteFolder`) - the React layer is a thin wrapper over those, which is why they are
what the tests cover. `pages/VaultPage.tsx` wires it together: the file-manager sidebar, a folder
trail and title bar, the live-preview editor, 1.2s debounced autosave, a rail holding the details
and history panels, and reconciliation on a remote change - fast-forward when nothing is unsaved locally,
otherwise a three-way merge whose result is written back as a version recording both parents.

## ASCII only, and icons are SVG

**Every character we write is ASCII.** No em dashes, no ellipsis character, no arrows, no curly
quotes, no non-breaking spaces, no byte-order marks. Use `-`, `...`, `->`, `'`, `"`. This covers UI
strings, code, comments, commit messages, and these docs.

Separators between bits of metadata are drawn too - a 3px round `::before`-style span, not a
middot and not a full stop, which reads as punctuation. See `.vault-meta .sep`.

**Icons are SVG components, never characters.** They live in `components/Icons.tsx` as inline
`<svg>` with `stroke="currentColor"`, so they inherit colour, scale with the layout, and render
identically everywhere. An emoji is a font-dependent picture that changes between platforms, cannot
be recoloured, and carries no accessible name - it is not an icon. No emoji, no dingbats, no
box-drawing characters standing in for graphics.

The one exception is **test fixtures in `SerbleNotes.Core/tests/`**, which deliberately contain
emoji, CJK, RTL text and combining marks. That is not our prose, it is the data proving a *user's*
note survives encryption, diffing and merging. Users write whatever they like; we do not.

```fish
./scripts/check-ascii.sh    # fails on any non-ASCII outside that fixture directory
```

Run it before committing. It found a UTF-8 BOM that the .NET scaffolding had left in four generated
files, which is exactly the sort of thing that never gets noticed by eye.

## Inform, never forbid

**The user's data, the user's risk, the user's call.** This product holds notes nobody else can read,
which means the person using it is the only one who can weigh what their notes are worth. Refusing to
carry out their instruction substitutes our guess for their judgement, and it is not our judgement to
make.

So, concretely:

- **No minimum lengths, no required character classes, no arbitrary caps** on anything the user is
  choosing for themselves. An empty vault password is permitted. A one-character one is permitted.
- **Warn in real time, factually, and say the consequence.** "Roughly seconds to guess" tells someone
  something. "Must contain a symbol" tells them nothing and trains them to write it on a sticky note.
- **Never disable the submit button, never refuse the save, never silently clamp a value.** If a
  warning is showing and the user proceeds anyway, that is the feature working.
- **Estimates must not flatter.** Where the honest answer is uncertain, show the *less* reassuring
  number. `passwordStrength.ts` counts a passphrase by words rather than characters and assumes a
  lone word is in a wordlist, because over-stating safety is the failure that costs someone their
  notes. It also states what its estimate assumes.

The one thing that is not a limitation: **catching an accident the user cannot perceive.** The
password-confirmation check stays, because a typo is not a decision - there is no recovery, and a
mis-typed vault password destroys the vault the moment the tab closes. The test is whether the user
could tell the difference between what they meant and what they did. If they couldn't, catching it is
help. If they could, it is paternalism, and it goes.

**Questions are asked in the app's own dialogs.** `window.confirm` and `window.prompt` block the
page, cannot be styled or keyed, and on some platforms offer to suppress themselves - which silently
answers the *next* question on the user's behalf. `components/Modal.tsx` and the `ConfirmModal` /
`PromptModal` / `MoveDialog` built on it handle Escape, keep Tab inside the dialog, and say the
consequence rather than "Are you sure?". There are no `window.confirm` or `window.prompt` calls left
in the client; do not add one.

This rule is about choices over the user's own data and security. Server-side resource limits
(`MaxVaultsPerUser`, `MaxVersionPayloadBytes`) are a different question - they protect the service
and other people on it - but they should still be set high enough that nobody ordinary meets them,
and they must fail with a clear reason rather than a silent truncation.

Where this lives today: `services/passwordStrength.ts` and `components/PasswordStrength.tsx`, and the
unencrypted-vault notice in `VaultsPage.tsx`, which states plainly that the server can read it.

## Testing the core

The core is the one component where a regression is unrecoverable: it holds the only copy of the
logic that turns stored bytes back into someone's notes, and a bug that corrupts rather than crashes
can destroy history that no backup helps with, because the server only ever had ciphertext. It is
therefore held to a stricter standard than the rest of the repo - **125 tests, and any change to
`crypto.rs` or `version.rs` needs tests before it lands.**

```fish
cd SerbleNotes.Core; cargo test              # all of it, ~25s
cd SerbleNotes.Core; cargo test --test version
```

| Suite | Covers |
| --- | --- |
| `src/*.rs` inline | Quick unit checks next to the code. |
| `tests/crypto.rs` | Round trips, nonce uniqueness over 2000 seals, single-byte corruption at *every* offset, truncation at every length, malformed keys and payloads, KDF determinism and sensitivity. |
| `tests/version.rs` | Diff round trips across a corpus of 25 text shapes crossed with itself, wrong-base rejection, malformed diffs, replay chains, and every merge outcome. |
| `tests/lifecycle.rs` | The client's store algorithm reimplemented in Rust: snapshot cadence, materialising every version of a 200-edit session, restore, offline merge, corruption. |
| `tests/paths.rs` | Name and folder semantics: what gets tidied, what gets refused, and how renaming a folder moves what is under it. Also the archive layout - what a note is called as a file, and what an archive from anywhere else means. Shared with the future filesystem, so all three agree on where a note lives. |
| `tests/properties.rs` | proptest invariants over generated documents and edits - the cases nobody thought to write. |

Two rules that matter more than coverage numbers:

- **Test that wrong input fails, not just that right input works.** Most of the dangerous bugs here
  return a plausible document instead of an error. Both real bugs found so far were of exactly that
  shape, and both were caught by a test asserting something *must* fail.
- **`tests/common/mod.rs` holds the text corpus** - empty strings, no trailing newline, CRLF, emoji,
  combining marks, content that is itself a diff, content containing conflict markers. Add a shape
  when you find one that breaks something; the corpus is the institutional memory.

## Backend code style

Match `../SerbleFiles/SerbleFiles.Backend` - it is the style reference, not a dependency. Concretely:

- **Explicit types, not `var`.** `FilesUser? user = await users.GetUser(id);`, `WebApplicationBuilder builder = ...`.
- **K&R braces**: `{` on the same line, `} else {`, `} catch {`. 4-space indent. File-scoped namespaces.
- **Primary constructors** for controllers, services and repos:
  `public class UserRepo(NotesDatabaseContext context) : IUserRepo {`
- **Interface + `Impl/` subfolder**: `Services/IThing.cs` + `Services/Impl/Thing.cs`; same shape under
  `Database/Repos/`.
- **Folder layout**: `Config/`, `Controllers/`, `Database/{Schema,Repos,Repos/Impl}`, `Helpers/`,
  `Migrations/`, `Schema/` (DTOs), `Services/{,Impl}`.
- **Config POCOs** in `Config/`, bound with `builder.Services.AddOptions<T>().Bind(config.GetSection("X"))`,
  injected as `IOptions<T>`. Settings that must exist at startup are read eagerly with
  `?? throw new Exception("X settings not found")`.
- **EF entities** in `Database/Schema/`, `[Key]`/`[StringLength]`/`[ForeignKey]` attributes, non-null
  reference props initialised `= null!`, navigation properties marked `[JsonIgnore]`.
- **Repos return `Task` without `async`** when they only forward (`return context.SaveChangesAsync();`).
- **JSON is camelCase** (`PropertyNamingPolicy = JsonNamingPolicy.CamelCase`).
- **Error responses** are anonymous objects with a user-facing message:
  `return BadRequest(new { message = "Invalid authentication code. Please try logging in again." });`
- Comment only where the *why* is non-obvious (see the `BackgroundServiceExceptionBehavior` note in
  SerbleFiles' `Program.cs` for the intended density).

Differences from SerbleFiles worth knowing: this project targets **net10.0** (SerbleFiles is net8.0),
it uses the built-in `AddOpenApi()`/`MapOpenApi()` rather than Swashbuckle (stay on it unless there's
a reason not to), and the backend serves the web client's static build instead of the frontend being
deployed separately.

Two deliberate deviations, both with reasons that will outlive the memory of making them:

- **Pomelo 9 / EF Core 9 packages on a net10.0 target.** Pomelo has no EF10 build. The combination is
  fine and the EF10 CLI tooling drives it happily; don't "fix" it by bumping EF Core alone, which
  breaks the provider. Switching to Oracle's `MySql.EntityFrameworkCore` would allow EF10 but drops
  the provider SerbleFiles uses.
- **`ServerVersion.Parse` from config, not `AutoDetect`.** SerbleFiles auto-detects, which means a
  reachable database is needed just to construct the model - so builds, migrations and CI all need a
  live server. The version is pinned in `Database:ServerVersion` instead.

## Commands

```fish
# Backend. `dotnet build` is pure .NET - it never invokes npm.
# Pending migrations are applied automatically at startup, so `database update` is rarely needed.
dotnet run --project SerbleNotes.Backend --urls http://localhost:5179
dotnet ef migrations add <Name> --project SerbleNotes.Backend
dotnet ef database update --project SerbleNotes.Backend   # only to migrate without starting the app

# Rust core: run these before touching anything that reads stored data.
cd SerbleNotes.Core; cargo test
cd SerbleNotes.App; npm run build:core          # wasm-pack -> SerbleNotes.Core/pkg

# Web client. Dev uses Vite on :3000 proxying /api (and the socket) to the backend on :5179.
cd SerbleNotes.App; npm run dev
cd SerbleNotes.App; npm run build               # -> SerbleNotes.Backend/wwwroot
cd SerbleNotes.App; npm run build:app           # -> SerbleNotes.App/dist, what Tauri bundles

# Desktop. `dev` opens a window against the Vite server, so HMR works in it.
cd SerbleNotes.App; npm run desktop
cd SerbleNotes.App; npm run desktop:build       # -> src-tauri/target/release/bundle

# Android. `android:init` regenerates gen/android and re-adds the deep link filter; it is already
# committed, so it is only needed after changing the identifier or wiping the directory.
cd SerbleNotes.App; npm run android:init
cd SerbleNotes.App; npm run android             # runs on a connected device or emulator
cd SerbleNotes.App; npm run android:build -- --apk --debug

# Production shape: one command builds the core, the client and the backend together.
dotnet publish SerbleNotes.Backend -c Release -o out
```

Local dev database is the existing `dev-mysql` container on **port 3307** (root/root), database
`serblenotes`. Installed: .NET 10.0.201, `dotnet-ef` 10.0.6, Rust 1.94.1, wasm-pack, Node 22,
docker/podman, the Android SDK at `~/Android/Sdk` with NDK 27.1.12297006. **Not** installed: Redis,
MinIO. Shell is **fish**, so bash-isms like `export X=y` don't work (`set -x X y`).

`SkipWebClientBuild=true` skips the frontend during publish when you only want the backend.

### Building the clients

Three things this machine needs that are not part of the repo, and each fails in a way that does not
say so:

- **Desktop:** `sudo dnf install webkit2gtk4.1-devel libsoup3-devel`. Without them the build stops at
  `javascriptcoregtk-4.1 was not found in the pkg-config search path` - the runtime libraries are
  already there, it is the headers that are missing.
- **Android:** `set -x JAVA_HOME /usr/lib/jvm/java-21-openjdk`. The default `java` here is 25, and
  Gradle 8.14 refuses it with `Unsupported class file major version 69`, which does not mention Java
  at all. Also `set -x ANDROID_HOME ~/Android/Sdk` and
  `set -x NDK_HOME ~/Android/Sdk/ndk/27.1.12297006`.
- **Windows:** Tauri has no supported cross-compile to Windows, so it builds on Windows or in CI.
  `.github/workflows/clients.yml` builds Linux, Windows and Android from one commit; it needs
  `VITE_SERBLE_APP_ID` set as a repository variable or the built apps have no OAuth client id.

## Working agreements

- Never weaken the E2E boundary for convenience. If the server needs to know something, add explicit
  metadata; don't leak plaintext into it.
- Crypto and version-control logic lives in the Rust core **only** - never reimplemented per client,
  never duplicated in C#. If C# appears to need it, question the design first.
- Prefer boring, well-reviewed crypto primitives (Argon2id for KDF, AEAD for content) over anything
  hand-rolled.
- Local-first: every client keeps a working local store and must be fully usable offline.
- The publish hook must stay ahead of `ResolveStaticWebAssetsInputs`. The SDK precompresses `wwwroot`
  into `.gz`/`.br` during that pass, so building the frontend after it ships compressed copies of the
  *previous* build - which nginx `gzip_static` or `MapStaticAssets` would then serve as stale HTML.
  This was a real bug here, not a hypothetical.
