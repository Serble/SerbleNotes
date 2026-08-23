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
- **Three screens, one structure.** The vault list (`VaultsPage`) is rows, not cards - name, which
  of the three states it is in, when it last changed. The workspace (`VaultPage`) is an app bar, the file-manager
  sidebar, the editor, and a rail of panels on the right. Both sit inside `.shell` / `.workspace`,
  which are full-height flex columns; nothing but the editor surface, the sidebar and the rail
  scrolls.
- **A vault row says whether opening it will ask for anything.** Three states, three marks: an
  encrypted vault whose key is already on this device (open padlock, quiet - the ordinary case,
  and colouring most of the list would say nothing), one that still needs its password (closed
  padlock, `--accent`, because it is the only one that wants something), and an unencrypted vault
  (open padlock, `--warning`). The list asks `cachedKey` per vault after it loads, so the state
  arrives a moment behind the names; until it does an encrypted vault is drawn as locked, which is
  the reading that promises the least. The row's line of text names the state and stops there - the
  full "the server can read this" is said where the choice is made, in the create dialog, and a
  yellow mark on a row nobody is deciding anything on had become wallpaper.
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
- **A note opens to be read, not to be typed into.** `MarkdownEditor` focuses itself on mount only
  where the pointer is fine. On a desktop that means you can type the moment a note opens; on a
  phone it summoned the keyboard over half the note every time one was opened. A tap in the text is
  how you say you want to write, and it is the same tap that would otherwise have dismissed the
  keyboard.
- **On touch, a table keeps the width the "add column" strip was taking.** That strip is 37px of a
  383px pane - a tenth of the screen, spent narrowing the thing being read. It is hidden under
  `(pointer: coarse)` and a column is added from the long-press menu, like every other structural
  edit to a table. The row bar along the bottom stays: height is not the scarce direction.
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

- **A blank line inside a selection is painted by the editor, not the browser.** The browser paints a
  selection onto text and a blank line has none, so dragging across one left a gap that read as "this
  line was not selected" - when in fact its line break was, and would be cut or copied with the rest.
  `livePreview` gives such a line `.cm-md-blank-selected`, whose style paints the width of a space:
  a gradient rather than a width, because what is being coloured is the line's own element, and that
  is as wide as the pane whatever is on it. The colour is `--selection`, which the browser's own
  painting reads too, so a selection cannot end up two different colours. Blank lines are walked line
  by line rather than taken from the syntax tree, because a line with nothing on it is not a node.
- **Mount the editor with `key={noteId}`.** That rebuilds it per note, which resets the undo history.
  Without it, undo in one note reaches back into another note's text.
- **A note may be written in HTML, and it is rendered.** Not a handful of tags mapped onto
  markdown's own styles - tags, attributes, `style` on any of them, `<style>` blocks and `<font>`.
  See "HTML and CSS" below, which is where all of it is decided.
- **A table cell renders its markdown, because a cell is a widget and not a run of text.** There are
  no character offsets inside one for `livePreview` to decorate, so `components/inlineMarkdown.ts`
  turns the cell's markdown into inert markup instead: marked's *inline* parser (a cell cannot
  introduce a heading or a list), then the same sanitiser everything else in a note goes through.
  What that refuses is shown as the text it is - `drawsFaithfully` in `noteHtml.ts` is the rule, and
  it is the rule for HTML blocks too. A cell swaps to its markdown on `pointerdown` - before the
  caret is placed, so it lands in what will be edited - and back when it is left. A cell with no
  markup in it is never rewritten at all.
- **Markup is only revealed while the editor has focus.** A cursor in an editor nobody is typing in
  is where you *were*, and it defaults to position 0 - so an unfocused note used to show its first
  line's syntax for no visible reason. Plain on a phone, where opening a note no longer focuses it.
- **What markdown a note may use**, measured against markdownguide.org. Everything in the basic
  syntax works: both kinds of heading (`#` and the `===` / `---` underline, which applies to the
  whole paragraph above it), emphasis, blockquotes **nested to any depth** (drawn as one bar per
  level - a line is walked past once per quote it is inside, and the depth reaches the stylesheet as
  `--quote-depth`), lists, code, horizontal rules in all three spellings, links, images, escapes and
  HTML. From the extended syntax: tables, fenced code with a language, strikethrough, task lists
  with boxes that can actually be ticked, autolinks, `x^2^`, `H~2~O`, and `==highlight==` - the last
  written here as a delimiter extension in the same shape as the parser's own Strikethrough.
  **Not supported, deliberately:** footnotes, definition lists, heading IDs and `:emoji:`
  shortcodes. The first three need block parsers and mean nothing without anchors or a footnote
  section to link to; the fourth needs a shortcode table of thousands of entries, and a note can
  hold the character itself. A footnote reference is left exactly as written rather than half-drawn:
  `[^1]` parses as a link, and hiding its brackets turned `here[^1]` into `here^1`.
- **An empty checkbox is a checkbox.** GFM defines a task list item as `[ ]` *followed by a space*,
  so `- [ ]` on its own is a list item whose text is "[ ]" and `- [x]` is a list item containing a
  link - which is exactly what somebody typing one gets, because the empty box is the first thing
  anyone writes and the trailing space that would have fixed it is invisible. `markdownLanguage.ts`
  therefore uses its own `Tasks` extension in place of GFM's `TaskList`, identical but for accepting
  the end of the line as well as a space, and `GFM` is taken apart into `Table`, `Strikethrough` and
  `Autolink` so the other three still apply. `- [x]text` with no space at all is still not a task, as
  upstream has it. `lists.ts` matches the same shape, so Enter on an empty task item ends the list
  rather than adding another. marked has the identical rule and is not ours to configure, so
  `MarkdownPreview` completes such a line with a space before parsing (skipping fenced blocks) -
  the same relaxation, expressed as text because that renderer is somebody else's.
- **The tick in a ticked box is a drawn path, masked in.** `--tick` in `index.css` is the one copy
  of it - a stroked, round-ended checkmark on the same 24 grid every icon in `Icons.tsx` uses, though
  heavier at 4 rather than 2.2 because it renders into about 10px, where the app's usual weight is a
  hairline. It is a *mask* rather than a background because the box is already painted `--accent` and
  a mask applies to everything an element draws, so the tick has to be its own layer; that is also
  what keeps its colour a token instead of a colour written into the picture. It was two rotated
  gradient bars before, which is a way of drawing a tick that only works at one size - at 14px the
  bars met in the wrong place and it read as a lopsided X.
- **A task's box is drawn, never an `<input>`.** In the editor that is `TaskWidget`; in the rendered
  preview marked's own checkbox renderer is replaced so it emits the same span, styled by `.md-task`
  in `index.css` to match. A form control is exactly what a note may not put on this page - the
  sanitiser refuses `<input>`, so the default would silently leave a task list looking like an
  ordinary one, which is how it was found. The preview's box is not tickable: it shows what a note
  said at a point in the past, and ticking a box in a version would either do nothing or edit
  history.
- **An image that would have to be fetched is shown as its alt text.** Asking a host for a picture
  tells it when the note was opened, and the app's own content policy refuses the request anyway -
  so it reads as the reference it is. That is true of `![alt](url)` and of `<img src>` alike; an
  image carrying its own bytes (`data:`) is drawn, because it is already in the note.
- **The markdown language is assembled by hand** in `components/markdownLanguage.ts` from
  `@lezer/markdown`, rather than using `@codemirror/lang-markdown`. That package statically depends
  on `lang-html`, which pulls in the whole JavaScript and CSS parsers so it can highlight HTML
  embedded in a note; tree-shaking cannot reach it, and it was about two thirds of the bundle. If you
  swap the parser back, check that every node name `livePreview` keys off still exists, or rendering
  silently stops working.

### HTML and CSS

A note may be written in HTML as well as markdown, and the HTML is rendered. `<table>` is a table,
`<div style="color: orange">` is orange, `<font color="red" size="5">` is what it says it is, and a
`<style>` block styles the note. No JavaScript, ever - see below for what that costs and why the
line is where it is.

`components/noteHtml.ts` decides all of it, once. Three places draw a note - the editor's live
preview, a table cell, and the rendered preview in the history panel - and all three come through
that file, so a note cannot look like two different documents depending on where it is read.

- **Nothing a note says ever runs.** No script, no event handler, no `iframe`, no form control, no
  remote fetch. That is not a style rule, it is the boundary: a note arrives from somewhere -
  imported from an archive, synced from another device, written by somebody else - and this app
  decrypts it on the user's own origin, holding their vault key. Markup from a note is inert, and
  anything on the page that acts was put there by this app. `ALLOWED_TAGS` and `ALLOWED_ATTR` are
  exhaustive lists rather than a set of rules with exceptions, so `onclick` is not refused by
  something that could be got round - it is simply not a name that appears in them.
- **What is not understood is shown as written, never swallowed.** `drawsFaithfully` asks two
  questions before any markup is drawn: is every element one this app renders, and did sanitising
  keep all of the text? `<script>alert(1)</script>` fails both, and a `<td>` with no table round it
  fails the second - the HTML parser drops it and takes the words with it. Either way the note shows
  its source. An editor that silently swallowed a tag would be lying about what the note says.
- **Deliberately not built yet:** `<svg>`, `<audio>` and `<video>`. Not refused on principle - just
  not done, and a tag that is not understood shows as text rather than disappearing.
- **Inline HTML becomes a real element.** `livePreview` pairs tags like brackets and puts a mark
  decoration with the tag's own `tagName` and attributes round the text between them, so the browser
  renders `<font color="red">` exactly as it would anywhere else. A tag that never closes stays the
  text it is. Both halves follow the usual rule: the styling always applies, and the tags themselves
  hide while the cursor is off their line.
- **A block of HTML is a widget**, from a state field (`components/htmlView.ts`), for the same
  reason a table is: replacing four lines with one element changes the block structure of the
  document, and a view plugin only sees the viewport. The source comes back when the cursor is in it.
- **Markdown inside HTML works, and that is why `htmlView` is more than "render the block".** A blank
  line ends an HTML block, so `<div class="warn">`, a blank line, some markdown, a blank line and
  `</div>` is three separate things to CommonMark - which is why that pattern is written everywhere
  and works almost nowhere. A block that is **nothing but tags** is therefore treated as a boundary:
  an unclosed opening tag waits for the block that closes it, the two are then hidden, and what the
  tag was setting - its `style`, its `class`, its `align` - is put on every line between them as a
  line decoration. CodeMirror combines `class` and `style` across line decorations, so nested
  wrappers nest. A tag that is never closed is left as text, exactly as an unclosed inline tag is.
  What this does *not* give a wrapper is the element's own default box: a `<blockquote>` used this
  way indents nothing by itself. It carries the styling that was asked for.
- **A note's CSS is collected, scoped, and applied to the whole note.** Every `<style>` block in the
  note becomes one stylesheet outside the document (`NoteStyles`), which is what lets a rule at the
  bottom reach a paragraph at the top and what keeps the CSS live while it is being written - a
  stylesheet that only applied when the cursor was elsewhere would be impossible to edit. The block
  itself collapses to a small "CSS" chip that puts the caret back in the source when clicked.
- **Scoping is the part that can be quietly wrong**, so it is `components/cssScope.ts` and it has
  tests. A selector that comes out unprefixed still works - and what it styles is the app. Rules are
  read with the browser's own parser, not with a regular expression, and every selector is prefixed
  with `[data-note-css="..."]`; `html`, `body` and `:root` are taken to mean the note itself, because
  that is what somebody writing them means. The editor and the history panel get a scope each, so
  two notes on screen do not reach each other.
- **The sheet is parsed as a constructed `CSSStyleSheet`**, which is the one kind that cannot be in
  force anywhere - it applies only to a document that has adopted it, and this one is adopted by
  nothing. `replaceSync` also drops `@import` by specification, which is a second answer to the
  question `IMPORT_RULE` asks: a note is not allowed to tell a third party when it was read. The
  fallback for an engine without it is a style element in a document with no browsing context.
- **Two things are taken back off a note wherever it is drawn.** `position: fixed` becomes
  `absolute`, because it is measured against the window rather than against anything in the note and
  is the one declaration that can put a note's markup over the app - over the vault list, over a
  password box. A note is a region of a page, not the page. And `target` is removed from every
  anchor: links are opened by `bindLinks`, which hands them to the system browser through `openLink`,
  because a real anchor would navigate the app away and a webview has no back button.
- **The honest limitation.** In the editor, markdown is decorated text rather than elements, so a
  note's CSS reaches the HTML the note itself wrote and not the markdown around it: `h1 { color: red }`
  colours nothing there, because there is no `h1`. In the rendered preview, where marked does produce
  elements, the same rule does colour headings. Fixing that would mean giving markdown's own output
  real tag names in the editor, which is a change to how the live preview works rather than to this.

### Merge conflicts

A conflict is the one thing this app writes into somebody's note that they did not type, and it
arrives in a notation borrowed from a command-line tool. Left as text it is bad markdown *and* a bad
question: a lone `=======` under a line of prose is a setext heading, so the note draws half the
conflict as a title, and resolving one means deleting exactly the right seven characters in three
places without deleting anything else. So the region is drawn as the choice it is - two versions
side by side, a button under each - by `conflictView.ts`, `conflictWidget.ts` and `conflicts.ts`.

- **The core stopped welding markers onto prose.** `diffy` writes each marker straight after the
  section before it, so a side whose last line had no trailing newline came back as
  `hgggggg||||||| original`. `merge3` now re-merges with every side newline-terminated when the
  first attempt conflicts - and only then, because on the clean path a trailing newline the user did
  not type is a change to their note. Padding can also resolve a conflict that only existed because
  of the missing newline, so the second attempt reports its own outcome.
- **The parser reads welded markers too, and has to.** Fixing the core stopped *new* conflicts being
  mangled and did nothing for the ones already sitting in people's notes. A parser that only accepts
  a marker at the start of a line reads `bbbbbbb>>>>>>> theirs` as ordinary text, never finds the
  closing marker, treats the region as unclosed and draws nothing - so the notes that most need the
  conflict shown as a choice are exactly the ones that would get no card at all. `markerIn` looks
  anywhere in the line, and that is safe because it is only ever asked about lines *between* an
  opener and its closer: `|||||||` in the middle of ordinary prose is ordinary prose, but the same
  characters inside a conflict are the divider they look like. Resolving one writes clean text, so a
  welded conflict repairs itself the moment it is answered.
- **`livePreview` refuses any node that *overlaps* a conflict**, not one that starts inside it, and
  that distinction is the whole of it. The markdown parser has never heard of conflict markers, so a
  `=======` inside one is a setext heading underline - and a setext underline applies to the
  paragraph *before* it. With no blank line in between, that heading node begins outside the region
  and reaches in, so everything from the paragraph down rendered at title size. Containment was the
  obvious test and the wrong one. It applies whether the conflict is drawn or shown as its markers:
  the card replaces its own lines either way, and what has to be stopped is markup reaching out of
  them.
- **`conflictsIn` is a state field**, because three things want the conflict list and finding them
  walks the whole document. They can only change when the text does.
- **"Text" and "Resolve" are one control in two states**, like a table's "Text" and "Table". The
  first lives in the card's header; the second is a bar above the region with the button in the same
  place, because the button that got you into the source belongs to the card you just replaced, and
  without a way back the source is a room with no door. The bar is a block widget rather than a
  floating control - it has a line of its own, so there is nothing to position and nothing to keep in
  step when the region moves.
- **A block replace decoration, so it comes from a state field**, exactly as a table does: replacing
  eight lines with one card changes the block structure of the document, and a view plugin only sees
  the viewport.
- **Nothing is preselected and nothing is recommended.** The app has no idea which version the
  person wanted, and a highlighted "suggested" side would be a guess dressed as an answer. "Keep
  both" exists because it is what people often want and doing it by hand means resolving the
  conflict and then retyping the half that was thrown away.
- **"Text" puts the markers back**, the twin of a table's button and for the same reason: a drawn
  thing that cannot be seen as its source cannot be checked or fixed by hand. Shown that way, every
  line of the region gets `.cm-conflict-raw` so the markers read as markers rather than as the
  markdown they accidentally are.
- **An empty side says so.** "(nothing - this version deleted it)" - a deletion is a real answer to
  the question and has to be legible as one rather than as an empty box.
- **Resolving is an ordinary edit**, so undo puts the conflict back and the autosave writes the
  result away knowing nothing about merges. `resolutionChange` is separate from the dispatch because
  it is where this goes quietly wrong: the region stops at the *end* of the `>>>>>>>` line and the
  document's own newline follows it, so a replacement that keeps its trailing newline inserts two.
  A side that deleted the passage takes that newline with it, or the deletion comes out as a blank
  line. Both were found on a real phone and both have tests.
- **The rendered preview fences them** rather than resolving them (`fenceConflicts` in
  `MarkdownPreview.tsx`). History shows what a note said at a point in the past; there is nothing to
  resolve, only something to read, and it must read as what was written.
- **The warning clears when the last marker goes**, checked with a substring scan in `typed` rather
  than a parse, because that runs on every keystroke and only has to be right about whether any are
  left.

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

### Tables

A table is drawn as a table. The markdown is taken out of the flow and replaced by a real `<table>`
whose cells are editable in place, columns as wide as what is in them, rows draggable to reorder -
and a "Text" button on it that puts the markdown back when somebody wants to see it. Styling the
source until it looked table-ish was the first attempt, and it could never do the two things that
make a table a table rather than a paragraph with pipes in it: a column that fits its contents, and a
cell you can point at.

Six files, in the order the work flows through them:

| File | What |
| --- | --- |
| `tableFormat.ts` | The text: reading a table out of markdown, changing the model, writing it back laid out. Knows nothing about CodeMirror. |
| `tableState.ts` | The two things that are a view of a note rather than part of it - which tables are showing their markdown, and which cell is being edited. |
| `tableView.ts` | The state field that decides which tables are drawn. |
| `tableWidget.ts` | The drawn table itself: the DOM, the editable cells, the buttons, the drag. |
| `tables.ts` | Every command, written in terms of the model. |
| `tableControls.ts` | The one floating button that gets you back from the markdown to the table. |

**The source is laid out, not just rendered.** `| a | b |` and `| c | ddddddd |` renders correctly and
is unreadable in a plain editor, in a diff, in an exported archive, and on the FUSE mount when there
is one. `renderTable` pads every column to its widest cell and draws the delimiter row to match,
following the column's alignment, so a right-aligned column of numbers reads as one in the source
too. Padding is counted in **display columns**, not characters: a CJK character or an emoji takes two
columns of a monospace grid and counts as one character - or as several, for an emoji built from
joined code points, which `Intl.Segmenter` puts back together. Getting that wrong is not a rounding
error, it is a table whose sides do not line up for anybody writing in a language nobody tested.

**Laying out a laid-out table has to change nothing.** Every edit to a drawn table writes the whole
thing back, so a layout that was not a fixed point would leave a note permanently unsaved. There is a
test.

**Every command replaces the whole table.** Read it out, change the model, write it back rendered -
which is why adding a column and tidying the layout are one code path, and why no command can leave a
row with the wrong number of pipes in it. Nothing is dropped to tidy something up: a body row with
more cells than the header widens the header rather than losing the cell, and a table keeps its header
row and its last column, because a table without them cannot be written down at all.

#### What the widget has to get right

- **It is a block replace decoration, so it comes from a state field, not a view plugin.** A
  decoration that changes the block structure of the document is not allowed to come from a plugin,
  because a plugin only sees the viewport and the editor needs the heights of everything to know what
  the viewport is. The cost is working over the whole document; it is paid only when something
  changed - an edit, the text button, or **the parser reaching further into a long note than it had
  before**. That last one is the easy one to forget, and it shows up as a table further down a note
  that never becomes one.
- **The cells are `contenteditable` islands, not part of the editor's document.** CodeMirror's cursor
  is never inside a drawn table. That is what lets a cell answer for its own Enter and Tab, and it is
  why `tableState.ts` has to remember which cell is being edited: `activeTable` asks it first and
  falls back to the cursor, which is what makes one set of commands serve the drawn table and the
  markdown behind it. It is also why `write` does not move the cursor for a drawn table - that would
  put it inside a range nobody can see.
- **This works because CodeMirror keeps out of it.** `ignoreEvent` returns true for everything, and
  CodeMirror's own `mayControlSelection` declines to move the DOM selection while the active element
  is inside the content but is not the content - which is exactly a focused cell. The consequence to
  remember: **CodeMirror does not deliver events it has been told to ignore**, so the context menu is
  opened from a React handler on `.editor-surface` rather than through `EditorView.domEventHandlers`.
  A right-click on a table cell is precisely such an event.
- **What is typed is written back debounced, at 300ms.** Not on blur alone: the autosave runs on its
  own clock, and a note closed mid-cell would lose what was in it. Not per keystroke either, because
  every write re-renders the whole table.
- **The table is never stretched to fill the pane.** The widget is `max-content` wide, capped at the
  pane, and the table inside it takes exactly the width its columns need; when that is more than there
  is room for, the card shrinks and the table scrolls inside it. Making the table `min-width: 100%`
  instead - so a narrow one did not leave a gap where the card should be - meant the surplus had to be
  given to some column, and the browser gave nearly all of it to whichever column held the most text.
  That column then grew every time somebody typed in its heading, and because the editable box inside
  the cell keeps its own 22rem cap, the column grew out from under it and left a dead strip that
  looked like part of the cell and could not be clicked into. The cell now focuses its box when
  anything in it is clicked, which is the belt to that braces.
- **The widget is spaced with padding, never margin.** The editor measures a block widget with
  `getBoundingClientRect`, which does not include margins - so a margin on `.cm-table` is space on the
  screen the editor does not know about, and every line below the table sits that much lower than the
  editor thinks it does. Nothing about that is cosmetic: clicking, dragging out a selection and
  arrowing up and down all go through the editor's idea of where the lines are. A 0.7rem margin top
  and bottom meant clicking about 22px above the text you wanted, per table above it - and arrowing up
  jumping to a table rather than to the previous line, because the position it computed was inside the
  range the widget had replaced, where there is no line and no caret to draw. For the same reason the
  `ResizeObserver` reads `borderBoxSize` rather than `contentRect`: what is being estimated is the box
  the editor will measure.
- **The widget must answer `estimatedHeight` honestly.** Every keystroke in a cell rewrites the whole
  table, and rewriting the text a block widget stands in for throws away the height the editor had
  measured - so the estimate is what the height map uses until the next measure pass. The default
  estimate is "no idea", which the editor reads as one line: a ten-row table collapsed to a line in
  the height map, the document lost several hundred pixels, the scroll position was adjusted to suit,
  and then it all came back. That was the view snapping about while somebody typed, and it was worse
  the taller the table and the further down the note. A `ResizeObserver` keeps the real height - cells
  that wrapped included - and `updateDOM` carries it across when a table slides down the note, because
  a resize observer says nothing about something that moved without changing size.
- **`updateDOM` patches instead of rebuilding whenever the shape is unchanged**, and never touches the
  cell that has focus. Rebuilding would take the caret out of the cell being typed in on every
  keystroke, which is the whole game. It also means the DOM's event handlers outlive the widget that
  made them, so **nothing in the widget captures the table's position** - it is read off the DOM
  (`data-from`), and a table that slid down the note because something was typed above it keeps
  working without being drawn again.
- **The buttons on a table deliberately do not `preventDefault` on mousedown**, unlike every other
  floating control in the editor. Taking focus is what makes the cell being typed in blur, and
  blurring is what writes it into the note - so a button pressed a moment after typing acts on the
  text that was just typed. The drag handle cannot do that, because its default is a text selection,
  so it blurs the active element itself instead.
- **Leaving a cell puts the editor's cursor at the table first.** It could be anywhere - wherever it
  was when somebody clicked into a cell, possibly pages away - and focusing the editor scrolls to it.
- **Anything that changes a table's shape asks for the caret** through `focusCellAfterRender`, because
  the element it wants to focus does not exist yet. That is a module-level variable rather than more
  editor state for the same reason the file tree's drag payload is: it is read once, immediately, by
  the render that the change itself caused, and would be stale a moment later.
- **Reordering is pointer events, not HTML5 drag and drop**, which does not exist on a touchscreen. A
  table only reorderable with a mouse is one that half the people using this app cannot reorder.
  `setPointerCapture` keeps the drag alive once the finger leaves the handle; `touch-action: none`
  stops the page scrolling underneath it instead. The handles get a **lane of their own**: `--grip`
  on `.cm-table` insets the whole first column, header included, and positions the handle inside that
  inset. One value for both, because when they were set separately the handles were drawn on top of
  the first thing every row said.
- **Cells escape and unescape at the boundary.** The model holds what markdown holds, so a `|` in
  someone's prose is a backslash-pipe in the model and a plain `|` in the cell. A line break cannot be
  represented in a cell at all, so a pasted paragraph becomes one line rather than being refused -
  what was pasted is still there, and the person who pasted it can see what it did.

#### Showing the markdown

The button on a table turns it back into text, one table at a time, remembered in `tableState.ts` and
carried through every edit so a table that moved is still the same table. There is deliberately **no**
"shows its source while the cursor is in it" rule, which is how the rest of the live preview works: a
drawn table's cells are their own editable islands, so the cursor is never inside one, and a rule that
could only fire while somebody was hand-typing a table would be a rule almost nobody would ever see.

A table shown as markdown is styled by the `.cm-md-table` rules in `MarkdownEditor.tsx` - a monospace
band, the header emboldened, the `|---|` row kept but drawn faint because it is what somebody edits to
change an alignment by hand. The band is **as wide as what is in it**, and unlike a code block's card
that needs no measuring pass: the lines are monospace and `renderTable` has already padded every one
of them to the same number of columns, so `ch` turns that count straight into a width. `livePreview`
gives every line of the table the widest one, which keeps the sides straight even part-way through
typing a row that is longer than the rest. Tab and Shift-Tab move between its cells, and `FormatOnLeave` lays it out
again when the cursor leaves it, on a microtask, because a transaction cannot go out from inside an
update. Its one floating control is the way back, and it sits at the **bottom right of the band** - which is
where the button that sent you there was. The "Text" button in a drawn table's footer and the "Table"
button over its markdown are one control in its two states, and a control that moved across the screen
when it was pressed would be two controls. They share a rule in `index.css` for the same reason. Not
the top right, where a code block's copy button goes: a code block's opening fence line is empty once
its backticks are hidden, and a table's first line is its header row with writing on it. The button
measures the *line's* right edge rather than the pane's, as the copy button does now that a card is
only as wide as it needs to be.

The icons in both are built out of elements rather than JSX, because they live in CodeMirror's DOM
rather than React's. `components/domIcons.ts` is the one copy of them, and each is the twin of the
component of the same name in `Icons.tsx`.

### The editor's context menu

`components/ContextMenu.tsx` is the menu the file tree has always had, moved out of `NoteTree.tsx` so
the editor can open the same object: same looks, same ways out, same nudge back inside the window near
an edge. Two menus that behaved slightly differently would be two menus to learn.

`editorMenu.tsx` says what is in it - cut, copy and paste, then everything about the table the cursor
or the edited cell is in, and "Insert table" when there is neither.

- **Cut and copy and paste are here because a note in a web view does not reliably have them.** Cut
  copies first and deletes only if that worked: a cut that could not reach the clipboard and deleted
  the text anyway is the one outcome here that loses something unrecoverable. Paste cannot fall back
  on `execCommand` the way copy can - reading the clipboard was removed from it deliberately - so when
  the browser refuses, it says so and points at Ctrl-V rather than doing nothing.
- **It opens on a long press as well as a right-click.** Android fires `contextmenu` on a long press
  and desktop fires it on a right-click; iOS fires neither, so there is a 500ms timer that abandons
  the moment the finger moves more than a few pixels - a drag is a scroll or a selection, and taking
  either of those to make a menu work would be a bad trade.
- **Opening it moves the cursor to what was clicked**, unless the click was inside the selection (in
  which case the selection is left alone - cutting the thing you just selected is the point of the
  menu) or inside a drawn table (in which case the cell already said which table this is about). That
  move can itself take the cursor out of a table shown as markdown and set off the layout above it, so
  every command reads the selection again when it runs rather than using the offsets the menu was
  built from.
- **A command that does not apply is shown disabled with a reason**, never left out. A menu whose
  items move about between openings is one nobody can learn.

### Sync

WebSocket push, Redis pub/sub for fan-out across backend instances (Redis not built - fan-out is
in-process today, which is correct for one instance). Clients must also work fully offline and
reconcile on reconnect - sync is an optimisation over a local-first store, not the source of truth.

**The socket carries the rows, not just a nudge.** It used to say "vault X is at cursor N" and the
client answered with an HTTP pull. That was a round trip on a connection that had just proved it
works - most of the delay between one device typing and the other showing it - and the pulls raced
each other when two writes landed together. `SyncEvent` now carries the changed notes and versions,
ciphertext included. It is still a dumb relay: the server can no more read a pushed version than a
stored one. A payload over 256 KB is pushed with `payload: null` and the client fetches that note the
way it already does for every note it opens, so this is an optimisation the client never has to
trust.

**`VaultStore.absorb` decides whether a pushed event is enough on its own.** The cursor rule from the
other side: a device may only advance its cursor to a point where it has seen *everything* below it,
and a pushed event proves one write happened, not that none was missed while the socket was away. The
proof is contiguity - one write reserves exactly one cursor value and every device gets every event,
so an unbroken stream arrives one higher each time. Equal to ours plus one means nothing can have
happened in between; anything else means pull. The rows are kept either way, so the pull that follows
is answered from memory.

**The client pings, and gives up on a socket that stops answering.** This is the failure a WebSocket
cannot report: the path dies without either end sending a close frame - the normal way a mobile
connection ends - and the socket object stays `OPEN` forever. `onclose` never fires, nothing
reconnects, and the client sits there believing it is live while receiving nothing. That was "I have
to reload the page for it to notice edits from my other device". `sync.ts` sends `{kind:"ping"}` every
20s, the server answers `pong`, and two missed answers (45s of silence) means the socket is closed by
hand - which is what makes `onclose` fire and the reconnect happen. Backoff is 500ms to 15s, not the
1s-to-30s it was: a reconnect is how a device finds out what it missed.

**Reconnecting is `resync`, and the order is the point** - pull, merge, then send what could not be
sent. Saving first parents the new version on a head this device only believes is current, which is
a fork. See `services/noteSync.ts`.

**Presence is your other devices, never another person.** Vaults are single-owner, so a `watch`
command tells the server what this device has open and every other device of the same account is
told. The note bar shows "Open elsewhere" and nothing more - not a count, not a name. Wording it as
though a second person were there would be inventing one out of a phone left open on the sofa. The
socket remembers what it is watching and says it again after a reconnect, because the server holds
presence against the connection and that connection is gone.

**A remote edit is merged into the open editor immediately**, cursor kept. `MarkdownEditor` narrows
an external change to the part that actually differs rather than replacing the document, so
CodeMirror can map the selection through it - someone typing in the third paragraph stays there when
a line arrives at the top.

**nginx must forward the upgrade.** A `location` block that only does `proxy_pass` strips the
WebSocket handshake, and the socket then never connects at all - no error the client can report, just
silence and a close code of 1006. It needs `proxy_http_version 1.1`, `Upgrade: $http_upgrade` and
`Connection: "upgrade"`. This was real: live sync had never worked through the deployed URL, and the
symptom was indistinguishable from the client bug above.

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
| `GET /api/vaults/{id}/changes?since=N&bodies=false` | The sync read path. `bodies=false` leaves the ciphertext out - see "Opening a vault". |
| `GET/POST /api/notes/{id}/versions`, `DELETE /api/notes/{id}` | Version DAG append and note tombstone. |
| `PUT /api/notes/{id}/name` | Rename or move. Metadata only - appends no version. |
| `GET /api/sync` | WebSocket. Notifications only, token via `?access_token=`. |

**Opening a vault does not download it.** `/changes` sends version metadata only unless asked for
`bodies=true`, and the client fetches a note's ciphertext from `GET /notes/{id}/versions` when the
note is opened. This is not a small saving: the vault it was measured on is 196 notes and 6.5 MB, of
which **92% is five large notes**, and none of it is needed to draw a tree built from note names.
Metadata for that vault is 160 KB and answers in about 100 ms, against 1.6 s for the whole thing.
Three rules keep it safe:

- **A missing body is never an empty one.** `bodyOf` in `store.ts` throws rather than returning `''`,
  because text is what the next autosave diffs against - a note that opened blank would be saved
  blank. Everything that reads text calls `VaultStore.ensureNote` first, and `saveNote` and
  `restore` call it themselves so no caller can forget.
- **The device cache holds ciphertext, never plaintext** (`services/vaultCache.ts`, IndexedDB). It is
  the same bytes the server holds, so keeping them is no weaker than the sync that fetched them; a
  cache of decrypted notes would undo the point of the product.
- **Only `pull` moves the cursor.** A version this device just wrote carries a cursor, but that says
  nothing about whether other devices' writes below it have been seen. Storing it would make the
  next delta skip them permanently. In memory that only cost a re-pull; on disk it would be
  unrecoverable.

`services/stores.ts` keeps one `VaultStore` per vault for the session, keyed by vault id **and** key -
a store built under one key must never serve a session that unlocked with another. Cold open of that
vault went from 2.8 s to 1.3 s, a warm one from the device cache to 0.35 s, and leaving a vault and
coming back to 0.25 s. Export is the one operation that still needs every note, so `ExportDialog`
fetches them all (six at a time) with progress before it will build an archive.

`services/settings.ts` is the client's own configuration - one JSON object under one key, currently
holding which note was last open in each vault and which vault was open when the app was last used.
New per-device preferences belong there rather than in a key of their own; `layout.ts` and the folder
state in `store.ts` predate it.

**The app starts where it was left.** `App` reads `lastVaultOpened()` once at mount and fetches that
one vault (`GET /vaults/{id}`, not the list - the list is not needed to draw a vault, and this is the
first screen), so a restart lands in the vault and then, through `lastNoteIn`, on the note. Three
things about it are decisions rather than details:

- **Going back to the vault list forgets it.** That is the only way a user can say "not this one
  next time", and it costs them one press. Anything else - closing the app mid-note, a crash - means
  they were in the vault, so that is where they come back to.
- **A vault that cannot be fetched is not forgotten.** Deleted, offline, a token the server no
  longer likes: all of them fall back to the vault list, which says its own piece about why, and the
  id stays for the next attempt. Only `forgetVault` clears it, on the one occasion it is known to
  mean nothing.
- **Restoring into a locked vault is the unlock screen, not an error.** The remembered vault is a
  vault, not a key: a device that has not cached this vault's key asks for the password exactly as
  it would have done from the list.

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
unencrypted-vault notice in `CreateVaultDialog`, which states plainly that the server can read it.

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

### The client's own tests

`SerbleNotes.App/tests/` holds the few pieces of the client that can be wrong rather than broken -
today the markdown table layout, which rewrites the user's text and whose bugs save a table with a
cell missing rather than failing, and the CSS scoping in `cssScope.ts`, whose bug is a note styling
the app with nothing on the screen to say so. Everything else in the client is a button that either
works or visibly does not.

The DOM half of drawing a note - the sanitiser, the CSS parse, the decorations `htmlView` builds -
has no tests here, because a DOM is what it needs and jsdom is not a dependency. It was driven under
one during the work and the results checked by hand; if that becomes a regular need, adding jsdom as
a dev dependency is the change to make, and it is the reason `cssScope.ts` has no imports of its own.

```fish
cd SerbleNotes.App; npm test
```

No test framework was added for it: node's own runner and its TypeScript transform, so the client's
dependency list is unchanged. Two things make that work and are worth knowing before adding a file:

- **`--experimental-transform-types`, not `--experimental-strip-types`.** The plugin classes in the
  editor use TypeScript parameter properties (`constructor(private readonly view: EditorView)`),
  which strip-only mode refuses outright.
- **`tests/support/hooks.mjs` puts the `.ts` back on relative imports.** The app is bundled by Vite,
  so `src/` writes `from './tableFormat'` with no extension, and node will not guess. The alternative
  was two import styles inside one directory.

The directory is outside `tsconfig.json`'s `include`, so `tsc` does not typecheck it - which is what
lets a test import `node:test` without `@types/node` being a dependency of the client.

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
cd SerbleNotes.App; npm test                    # node's own runner over SerbleNotes.App/tests
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
