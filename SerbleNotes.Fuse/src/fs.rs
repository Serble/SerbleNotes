//! The filesystem itself: a vault, drawn as a folder of markdown files.
//!
//! Three kinds of thing appear in a mount.
//!
//! - **Notes**, one markdown file each, at `archive_path(name)` - the same place they appear in an
//!   exported zip. Reading one rebuilds it from the DAG; closing one after a write appends a
//!   version.
//! - **Folders**, which are not records anywhere. They are the `/` in a note's name, and the empty
//!   ones are a list this device keeps, because a folder with no note in it has no name to be read
//!   out of. See `store.rs`.
//! - **Files an editor made for itself**, which live in this process and are never sent anywhere.
//!   See `names::is_transient` for why a filesystem without that idea would fill a vault with vim
//!   swap files, and `Mount::rename_path` for how the atomic-save dance turns one into a note.
//!
//! The operations are methods on [`Mount`], taking paths. The `Filesystem` callbacks below turn the
//! kernel's inode numbers into paths and call them, and do nothing else - a callback can only be
//! reached through a real mount, and the parts that can be quietly wrong should not need one.
//!
//! Everything mutable is behind one mutex, including while a request is out on the network. That
//! makes the mount single-file, which it is anyway - the session runs one event loop thread - and
//! it is what lets the sync thread share the state without a second model of who owns what.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fuser::{
    AccessFlags, BsdFileFlags, Errno, FileAttr, FileHandle, FileType, Filesystem, FopenFlags,
    Generation, INodeNo, LockOwner, OpenAccMode, OpenFlags, RenameFlags, ReplyAttr, ReplyCreate,
    ReplyData, ReplyDirectory, ReplyEmpty, ReplyEntry, ReplyOpen, ReplyStatfs, ReplyWrite,
    ReplyXattr, Request, TimeOrNow, WriteFlags,
};
use serblenotes_core::{file_name, normalise_path, parent_path, MAX_SEGMENT_BYTES};

use crate::names::{file_path_for, is_editor_scratch, is_note_file, note_name_for, Ignore};
use crate::store::{StoreError, UnsentEdit, VaultStore};
use crate::tree::{join, Entry, Inodes, ROOT};

/// How long the kernel may believe an answer.
///
/// Short, because a note can change on another device at any moment and nothing here can tell the
/// kernel about it. One second means a stale listing or size lasts about as long as it takes to
/// notice, and costs nothing - every answer below is served from memory.
const TTL: Duration = Duration::from_secs(1);

const BLOCK_SIZE: u32 = 4096;

/// A note with a buffer of its own.
///
/// The buffer is per note rather than per file descriptor, so two programs with the file open see
/// the same bytes, which is what they would on any other filesystem.
pub struct OpenNote {
    pub data: Vec<u8>,
    /// Whether the buffer holds something the server has not taken.
    pub dirty: bool,
    /// Whether anything has been written since the last version was saved. See `Mount::flushed`.
    pub written: bool,
    /// The version this buffer was built from, and the parent of the next save.
    pub baseline: Option<String>,
    /// A branch merged into this buffer that is not yet an ancestor of anything stored. The next
    /// save records it as a second parent, which is what stops the merge being seen as a fork
    /// forever.
    pub merge_parent: Option<String>,
}

/// A file that exists only in this mount.
pub struct LocalFile {
    pub path: String,
    pub data: Vec<u8>,
    /// Whether anything has been written since this file was made or last saved.
    pub written: bool,
    pub created: SystemTime,
    pub modified: SystemTime,
}

/// Everything the mount can change, and everything the sync thread shares with it.
pub struct Mount {
    pub store: VaultStore,
    pub inodes: Inodes,
    pub locals: HashMap<u64, LocalFile>,
    pub open_notes: HashMap<String, OpenNote>,
    next_local: u64,
    pub read_only: bool,
    /// Names the user has said to leave alone, on top of the built-in list.
    ignore: Ignore,
    uid: u32,
    gid: u32,
}

impl Mount {
    pub fn new(store: VaultStore, read_only: bool, ignore: Ignore) -> Mount {
        Mount {
            store,
            inodes: Inodes::new(),
            locals: HashMap::new(),
            open_notes: HashMap::new(),
            next_local: 1,
            read_only,
            ignore,
            // Everything in the mount belongs to whoever mounted it. There is one account behind a
            // vault, and FUSE already refuses everybody else by default.
            uid: unsafe { libc::geteuid() },
            gid: unsafe { libc::getegid() },
        }
    }

    // --- looking things up ----------------------------------------------------------------------

    /// Where an inode is, as a path inside the mount. The root is the empty string.
    pub fn path_of(&mut self, ino: u64) -> Option<String> {
        match self.inodes.entry(ino)?.clone() {
            Entry::Root => Some(String::new()),
            Entry::Folder(path) => Some(path),
            Entry::Note(note_id) => {
                let name = self.store.path_of(&note_id)?;
                file_path_for(&name).ok()
            }
            Entry::Local(id) => self.locals.get(&id).map(|file| file.path.clone()),
        }
    }

    /// Whether a file at this path becomes a note when it is closed with something in it.
    ///
    /// Both halves matter. A name that is not a note's is never one, and a name the user has told
    /// this mount to leave alone is never one either - which is how a plugin's `.bak` files, or a
    /// folder of drafts that should stay on this machine, stay out of the vault.
    pub fn is_note_path(&self, path: &str) -> bool {
        !self.ignore.matches(path) && is_note_file(path)
    }

    /// Whether a file that is not a note is one nothing needs to be said about.
    ///
    /// An editor's own working file, or one the user has named themselves - either way they know
    /// it is there and why. Anything else that is not a note looks saved and is not, and that is
    /// worth interrupting for.
    pub fn is_scratch(&self, path: &str) -> bool {
        self.ignore.matches(path) || is_editor_scratch(&file_name(path))
    }

    /// What is at a path, if anything.
    pub fn at(&mut self, path: &str) -> Option<Entry> {
        if path.is_empty() {
            return Some(Entry::Root);
        }

        if let Some((id, _)) = self.locals.iter().find(|(_, file)| file.path == path) {
            return Some(Entry::Local(*id));
        }

        if self.is_note_path(path) {
            if let Some(note_id) = note_name_for(path)
                .ok()
                .and_then(|name| self.store.note_at(&name))
            {
                return Some(Entry::Note(note_id));
            }
        }

        if self.store.folders().contains(path) {
            return Some(Entry::Folder(path.to_string()));
        }

        None
    }

    /// Whether anything at all is at a path, folders included. Asked before creating something.
    pub fn occupied(&mut self, path: &str) -> bool {
        if self.at(path).is_some() {
            return true;
        }

        // A local file deeper down makes this path a folder, even though nothing is filed at it.
        let prefix = format!("{path}/");
        self.locals.values().any(|file| file.path.starts_with(&prefix))
    }

    /// What is directly inside a folder.
    pub fn children(&mut self, folder: &str) -> Vec<(u64, FileType, String)> {
        let mut entries: Vec<(u64, FileType, String)> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();

        for (name, note_id) in self.store.notes_under(folder) {
            if parent_path(&name) != folder {
                continue;
            }
            let Ok(path) = file_path_for(&name) else {
                continue;
            };
            let leaf = file_name(&path);
            if !nameable(&leaf) {
                log::warn!(
                    "{path}: this note's name is too long to be a filename, so it is not shown in \
                     the mount. Rename it in the app to make it visible here."
                );
                continue;
            }
            let ino = self.inodes.number(Entry::Note(note_id));
            if seen.insert(leaf.clone()) {
                entries.push((ino, FileType::RegularFile, leaf));
            }
        }

        for path in self.store.folders() {
            if path.is_empty() || parent_path(&path) != folder {
                continue;
            }
            let leaf = file_name(&path);
            if !nameable(&leaf) {
                continue;
            }
            let ino = self.inodes.number(Entry::Folder(path.clone()));
            if seen.insert(leaf.clone()) {
                entries.push((ino, FileType::Directory, leaf));
            }
        }

        // Folders that exist only because a local file is sitting in one, so `mkdir a && vim
        // a/b/c.md` behaves the way it does anywhere else.
        let locals: Vec<String> = self.locals.values().map(|file| file.path.clone()).collect();
        let prefix = if folder.is_empty() {
            String::new()
        } else {
            format!("{folder}/")
        };

        for path in locals {
            if parent_path(&path) == folder {
                let Some(id) = self.local_at(&path) else { continue };
                let leaf = file_name(&path);
                let ino = self.inodes.number(Entry::Local(id));
                if seen.insert(leaf.clone()) {
                    entries.push((ino, FileType::RegularFile, leaf));
                }
            } else if let Some(tail) = path.strip_prefix(&prefix) {
                if let Some(index) = tail.find('/') {
                    let leaf = tail[..index].to_string();
                    let ino = self.inodes.number(Entry::Folder(join(folder, &leaf)));
                    if seen.insert(leaf.clone()) {
                        entries.push((ino, FileType::Directory, leaf));
                    }
                }
            }
        }

        entries.sort_by(|a, b| a.2.cmp(&b.2));
        entries
    }

    fn local_at(&self, path: &str) -> Option<u64> {
        self.locals
            .iter()
            .find(|(_, file)| file.path == path)
            .map(|(id, _)| *id)
    }

    // --- attributes -----------------------------------------------------------------------------

    fn dir_attr(&self, ino: u64, time: SystemTime) -> FileAttr {
        FileAttr {
            ino: INodeNo(ino),
            size: 0,
            blocks: 0,
            atime: time,
            mtime: time,
            ctime: time,
            crtime: time,
            kind: FileType::Directory,
            perm: if self.read_only { 0o500 } else { 0o700 },
            nlink: 2,
            uid: self.uid,
            gid: self.gid,
            rdev: 0,
            blksize: BLOCK_SIZE,
            flags: 0,
        }
    }

    fn file_attr(&self, ino: u64, size: u64, modified: SystemTime, created: SystemTime) -> FileAttr {
        FileAttr {
            ino: INodeNo(ino),
            size,
            blocks: size.div_ceil(512),
            atime: modified,
            mtime: modified,
            ctime: modified,
            crtime: created,
            kind: FileType::RegularFile,
            perm: if self.read_only { 0o400 } else { 0o600 },
            nlink: 1,
            uid: self.uid,
            gid: self.gid,
            rdev: 0,
            blksize: BLOCK_SIZE,
            flags: 0,
        }
    }

    /// The attributes of something, fetching the note body if that is what it takes.
    ///
    /// A file's size has to be right. Tools trust it: a reader that stops at `st_size` truncates
    /// the note, and one that sees zero shows nothing at all. A note's size is the length of its
    /// *plaintext*, and the server only knows how many bytes of ciphertext it is holding - which,
    /// for a version that is a diff, is the size of the diff and says nothing about the document.
    /// So there is no answer short of rebuilding the note, and this blocks on doing it.
    ///
    /// That is why the mount warms itself in the background (see `sync.rs`): by the time anyone
    /// runs `ls -l`, nearly every note is already here and this costs nothing.
    pub fn attr_of(&mut self, entry: &Entry) -> Result<FileAttr, StoreError> {
        match entry {
            Entry::Root => {
                let ino = self.inodes.number(Entry::Root);
                Ok(self.dir_attr(ino, SystemTime::now()))
            }
            Entry::Folder(path) => {
                let ino = self.inodes.number(Entry::Folder(path.clone()));
                Ok(self.dir_attr(ino, SystemTime::now()))
            }
            Entry::Local(id) => {
                let ino = self.inodes.number(Entry::Local(*id));
                let file = self
                    .locals
                    .get(id)
                    .ok_or_else(|| StoreError::Missing("no such file".into()))?;
                Ok(self.file_attr(ino, file.data.len() as u64, file.modified, file.created))
            }
            Entry::Note(note_id) => {
                let ino = self.inodes.number(Entry::Note(note_id.clone()));

                let size = match self.open_notes.get(note_id) {
                    Some(open) => open.data.len() as u64,
                    None => self.store.read_note(note_id)?.len() as u64,
                };

                let note = self
                    .store
                    .get_note(note_id)
                    .ok_or_else(|| StoreError::Missing("no such note".into()))?;
                let modified = parse_time(&note.updated_at);
                let created = parse_time(&note.created_at);

                Ok(self.file_attr(ino, size, modified, created))
            }
        }
    }

    /// The attributes of an inode, for a reply that has just made one.
    pub fn attr_for(&mut self, ino: u64) -> FileAttr {
        let now = SystemTime::now();
        match self.inodes.entry(ino).cloned() {
            Some(entry) => self
                .attr_of(&entry)
                .unwrap_or_else(|_| self.file_attr(ino, 0, now, now)),
            None => self.file_attr(ino, 0, now, now),
        }
    }

    pub fn dir_attr_for(&mut self, ino: u64) -> FileAttr {
        self.dir_attr(ino, SystemTime::now())
    }

    // --- reading and writing note text ----------------------------------------------------------

    /// The bytes of a note as they stand: the open buffer if there is one, the stored text if not.
    pub fn note_bytes(&mut self, note_id: &str) -> Result<Vec<u8>, StoreError> {
        if let Some(open) = self.open_notes.get(note_id) {
            return Ok(open.data.clone());
        }
        Ok(self.store.read_note(note_id)?.into_bytes())
    }

    /// The buffer a write goes into, made from the note's current text the first time.
    ///
    /// Starting it from the stored text rather than from nothing is not a nicety: a write at offset
    /// 4000 into an empty buffer would produce four kilobytes of zeroes followed by the new bytes,
    /// and that is what would be saved as the note.
    pub fn buffer_for(&mut self, note_id: &str) -> Result<&mut OpenNote, StoreError> {
        if !self.open_notes.contains_key(note_id) {
            let text = self.store.read_note(note_id)?;
            let baseline = self.store.head_of(note_id);
            self.open_notes.insert(
                note_id.to_string(),
                OpenNote {
                    data: text.into_bytes(),
                    dirty: false,
                    written: false,
                    baseline,
                    merge_parent: None,
                },
            );
        }

        Ok(self.open_notes.get_mut(note_id).expect("just inserted"))
    }

    // --- committing -----------------------------------------------------------------------------

    /// What `flush` does, which is not quite what `commit` does.
    ///
    /// `flush` runs on every `close`, and a `close` is not the same thing as a program finishing
    /// with a file: a descriptor can be duplicated, and closing the duplicate flushes. `sh` does
    /// exactly that for a redirect - it opens the file, dups it onto standard output and closes the
    /// original - so the first `flush` on `printf x > note.md` arrives **before a single byte has
    /// been written**, with the buffer freshly truncated to nothing.
    ///
    /// Committing that wrote an empty version into the note's history on every save, and created
    /// every new note empty with its contents as the diff after it. Real, found against a real
    /// server, and invisible from inside the mount because the *end* state was always right.
    ///
    /// So a flush saves only when something has actually been written since the last save.
    /// `release` still saves unconditionally - it happens once per open and is the last word - so a
    /// truncate with no write after it, which is a legitimate way to empty a note, is not lost.
    pub fn flushed(&mut self, ino: u64) -> Result<(), Errno> {
        let written = match self.inodes.entry(ino) {
            Some(Entry::Note(note_id)) => {
                self.open_notes.get(note_id).is_some_and(|open| open.written)
            }
            Some(Entry::Local(id)) => self.locals.get(id).is_some_and(|file| file.written),
            _ => false,
        };

        if !written {
            return Ok(());
        }
        self.commit(ino)
    }

    /// Writes whatever is unsent for one inode, whether or not anything was written this time.
    ///
    /// This is where "every write is a snapshot" happens, and its three outcomes are deliberately
    /// different. A save the server took clears the buffer. A save that could not reach the server
    /// is **not** an error: the text is sealed onto this device and the sync thread keeps trying,
    /// which is what local-first means and what stops an editor reporting a failed write on a
    /// train. A save the server *refused* - a storage limit, a note deleted elsewhere - will not fix
    /// itself, so it is reported, and the buffer is kept so nothing is lost while the user reads the
    /// reason.
    pub fn commit(&mut self, ino: u64) -> Result<(), Errno> {
        match self.inodes.entry(ino).cloned() {
            Some(Entry::Note(note_id)) => self.commit_note(&note_id),
            Some(Entry::Local(id)) => self.commit_local(ino, id),
            _ => Ok(()),
        }
    }

    fn commit_note(&mut self, note_id: &str) -> Result<(), Errno> {
        let Some(open) = self.open_notes.get(note_id) else {
            return Ok(());
        };
        if !open.dirty {
            return Ok(());
        }

        let text = match String::from_utf8(open.data.clone()) {
            Ok(text) => text,
            Err(_) => {
                // A note is text and the core seals a string. Saying so is better than sealing
                // something lossy and handing back a note with replacement characters in it where
                // the user's bytes were.
                let what = self.describe(note_id);
                log::error!("{what}: a note has to be UTF-8 text. Nothing was saved.");
                return Err(Errno::EINVAL);
            }
        };

        let merge_parent = open.merge_parent.clone();

        match self.store.save_note(note_id, &text, merge_parent) {
            Ok(_) => {
                let head = self.store.head_of(note_id);
                if let Some(open) = self.open_notes.get_mut(note_id) {
                    open.dirty = false;
                    open.written = false;
                    open.baseline = head;
                    open.merge_parent = None;
                }
                self.persist_unsent();
                Ok(())
            }
            Err(error) if error.is_offline() => {
                let what = self.describe(note_id);
                log::info!("{what}: kept on this device, the server is not reachable ({error})");
                self.persist_unsent();
                Ok(())
            }
            Err(error) => {
                let what = self.describe(note_id);
                log::error!("{what}: the server refused this save: {error}");
                self.persist_unsent();
                Err(Errno::EIO)
            }
        }
    }

    fn commit_local(&mut self, ino: u64, id: u64) -> Result<(), Errno> {
        let Some(file) = self.locals.get(&id) else {
            return Ok(());
        };
        let path = file.path.clone();
        if !self.is_note_path(&path) {
            // An editor's own working file, or one the user has told this mount to leave alone.
            // It lives here and goes nowhere.
            return Ok(());
        }

        let Ok(name) = note_name_for(&path) else {
            // Unreachable: a file only takes a name like this by being created or renamed, and both
            // check first. Refusing rather than inventing a name for it if it ever happens.
            return Err(Errno::EINVAL);
        };

        let text = match String::from_utf8(file.data.clone()) {
            Ok(text) => text,
            Err(_) => {
                log::error!("{path}: a note has to be UTF-8 text. Nothing was saved.");
                return Err(Errno::EINVAL);
            }
        };

        match self.store.create_note(&name, &text) {
            Ok(note) => {
                // The descriptor the editor is holding has to keep pointing at what it created.
                self.inodes.rebind(ino, Entry::Note(note.id.clone()));
                self.locals.remove(&id);
                self.persist_unsent();
                Ok(())
            }
            Err(error) if error.is_offline() => {
                log::info!("{path}: kept on this device, the server is not reachable ({error})");
                self.persist_unsent();
                Ok(())
            }
            Err(error) => {
                log::error!("{path}: the server refused this note: {error}");
                self.persist_unsent();
                Err(Errno::EIO)
            }
        }
    }

    /// Seals every unsent edit onto this device.
    ///
    /// Rewritten whole each time rather than added to, so the file is always exactly what is still
    /// outstanding - an entry left behind for a note that has since saved would be replayed over a
    /// newer version at the next mount.
    pub fn persist_unsent(&mut self) {
        let mut edits: Vec<UnsentEdit> = Vec::new();

        let dirty: Vec<(String, Vec<u8>, Option<String>)> = self
            .open_notes
            .iter()
            .filter(|(_, open)| open.dirty)
            .map(|(note_id, open)| (note_id.clone(), open.data.clone(), open.baseline.clone()))
            .collect();

        for (note_id, data, baseline) in dirty {
            let Ok(text) = String::from_utf8(data) else {
                continue;
            };
            // The note's own name, so an edit for a note this device later loses track of can still
            // come back as a file.
            let name = self.store.path_of(&note_id).unwrap_or_default();
            edits.push(UnsentEdit { note_id: Some(note_id), name, text, baseline });
        }

        let pending: Vec<(String, Vec<u8>)> = self
            .locals
            .values()
            .filter(|file| self.is_note_path(&file.path))
            .map(|file| (file.path.clone(), file.data.clone()))
            .collect();

        for (path, data) in pending {
            let Ok(text) = String::from_utf8(data) else {
                continue;
            };
            let Ok(name) = note_name_for(&path) else {
                continue;
            };
            edits.push(UnsentEdit { note_id: None, name, text, baseline: None });
        }

        self.store.keep_unsent(&edits);
    }

    /// How many edits this device is holding that the server has not taken.
    pub fn unsent_count(&self) -> usize {
        self.open_notes.values().filter(|open| open.dirty).count()
            + self
                .locals
                .values()
                .filter(|file| self.is_note_path(&file.path))
                .count()
    }

    /// A note, as a sentence a log line can use.
    fn describe(&mut self, note_id: &str) -> String {
        self.store
            .path_of(note_id)
            .and_then(|name| file_path_for(&name).ok())
            .unwrap_or_else(|| note_id.to_string())
    }

    // --- the operations -------------------------------------------------------------------------

    pub fn make_local(&mut self, path: &str) -> (u64, u64) {
        let id = self.next_local;
        self.next_local += 1;

        let now = SystemTime::now();
        self.locals.insert(
            id,
            LocalFile {
                path: path.to_string(),
                data: Vec::new(),
                written: false,
                created: now,
                modified: now,
            },
        );

        let ino = self.inodes.number(Entry::Local(id));
        (id, ino)
    }

    /// A local file with contents already in it, for an edit carried over from a previous mount.
    pub fn add_local(&mut self, path: &str, data: &[u8]) -> u64 {
        let (id, ino) = self.make_local(path);
        if let Some(file) = self.locals.get_mut(&id) {
            file.data = data.to_vec();
        }
        ino
    }

    /// Makes a file. Returns its inode.
    ///
    /// Nothing is sent anywhere yet: a file created here is local until it is closed with something
    /// in it, which is what makes `touch a.md && rm a.md` cost the server nothing, and what lets
    /// vim write and remove its probe file without either reaching the vault.
    pub fn create_at(&mut self, path: &str) -> Result<u64, Errno> {
        if self.read_only {
            return Err(Errno::EROFS);
        }
        if self.occupied(path) {
            return Err(Errno::EEXIST);
        }

        // Nothing is refused for its name. A file that is not a note is a file that lives in this
        // mount and nowhere else, which is what lets `sed -i`, vim and every other editor write
        // whatever working file they like beside the one they are saving.
        //
        // The one thing worth saying out loud is a file the user brought in themselves, because
        // that one looks saved and is not - and being unable to tell is exactly what makes it worth
        // interrupting for. See `names::is_editor_scratch`.
        if !self.is_note_path(path) && !self.is_scratch(path) {
            let leaf = file_name(path);
            log::warn!(
                "{path} is not a markdown file, so it stays in this mount and does not become a \
                 note. Name it \"{leaf}.md\" to save it into the vault."
            );
        }

        let (_, ino) = self.make_local(path);
        Ok(ino)
    }

    /// Makes a folder. Local to this device until a note is filed into it - there is nothing to
    /// create on the server, because folders are not records anywhere.
    pub fn mkdir_at(&mut self, path: &str) -> Result<u64, Errno> {
        if self.read_only {
            return Err(Errno::EROFS);
        }
        if self.occupied(path) {
            return Err(Errno::EEXIST);
        }

        // A folder is the front of a note's name, so it has to be a name a note could have. The
        // leaf is checked on its own, never as part of the joined string - see `tree::join`.
        let leaf = file_name(path);
        if normalise_path(&leaf).map(|tidied| tidied != leaf).unwrap_or(true) {
            log::warn!("{path}: a folder name cannot be blank, padded with spaces, or '.' or '..'.");
            return Err(Errno::EINVAL);
        }

        self.store.create_folder(path);
        Ok(self.inodes.number(Entry::Folder(path.to_string())))
    }

    /// Removes an empty folder, and only an empty one. Emptying it first is a decision the user
    /// makes one file at a time, which is what `rm -r` is.
    pub fn rmdir_at(&mut self, path: &str) -> Result<(), Errno> {
        if self.read_only {
            return Err(Errno::EROFS);
        }
        if !matches!(self.at(path), Some(Entry::Folder(_))) {
            return Err(Errno::ENOTDIR);
        }
        if !self.children(path).is_empty() {
            return Err(Errno::ENOTEMPTY);
        }

        self.store.remove_folder(path);
        self.inodes.forget(&Entry::Folder(path.to_string()));
        Ok(())
    }

    /// Removes a file.
    ///
    /// For a note this is a tombstone: the row and its whole history stay on the server, and only
    /// a retention window will ever actually remove them.
    ///
    /// **That is not the same as recoverable, and nothing here may say it is.** No client has an
    /// undelete - the web client filters `!note.deleted` and there is no route behind it - so from
    /// where the user is standing this is as final as `rm`, and the bytes surviving on a server
    /// they cannot ask for them back from is no comfort at all.
    pub fn unlink_at(&mut self, path: &str) -> Result<(), Errno> {
        if self.read_only {
            return Err(Errno::EROFS);
        }

        match self.at(path) {
            Some(Entry::Local(id)) => {
                self.locals.remove(&id);
                self.inodes.forget(&Entry::Local(id));
                self.persist_unsent();
                Ok(())
            }
            Some(Entry::Note(note_id)) => match self.store.delete_note(&note_id) {
                Ok(()) => {
                    self.open_notes.remove(&note_id);
                    self.inodes.forget(&Entry::Note(note_id));
                    self.persist_unsent();
                    Ok(())
                }
                Err(error) => Err(report(path, &error)),
            },
            Some(_) => Err(Errno::EISDIR),
            None => Err(Errno::ENOENT),
        }
    }

    /// Renaming, which is most of what saving a file actually is.
    ///
    /// The two cases that matter are both about not throwing history away:
    ///
    /// - **A note moving anywhere** is `PUT /api/notes/{id}/name` and appends no version. Its whole
    ///   history comes with it, because its folder was only ever the front of its name.
    /// - **A file an editor wrote, renamed over a note**, is the atomic-save dance - write the new
    ///   document to a scratch name, rename it into place - and it is committed as a *new version
    ///   of that note*. Reading it as "delete the note, create a different one" is the obvious
    ///   thing to do, and it would silently destroy the history of every note saved by anything
    ///   that saves this way, which is most graphical editors.
    pub fn rename_path(&mut self, from: &str, to: &str, no_replace: bool) -> Result<(), Errno> {
        if self.read_only {
            return Err(Errno::EROFS);
        }
        if from == to {
            return Ok(());
        }

        let Some(source) = self.at(from) else {
            return Err(Errno::ENOENT);
        };
        let destination = self.at(to);

        if destination.is_some() && no_replace {
            return Err(Errno::EEXIST);
        }

        match source {
            Entry::Root => Err(Errno::EBUSY),
            Entry::Folder(path) => self.rename_folder_to(&path, to, destination),
            Entry::Note(note_id) => self.rename_note_to(&note_id, to, destination),
            Entry::Local(id) => self.rename_local_to(id, to, destination),
        }
    }

    fn rename_folder_to(
        &mut self,
        from: &str,
        to: &str,
        destination: Option<Entry>,
    ) -> Result<(), Errno> {
        if to == from || to.starts_with(&format!("{from}/")) {
            return Err(Errno::EINVAL);
        }

        match destination {
            Some(Entry::Folder(_)) => return Err(Errno::ENOTEMPTY),
            Some(_) => return Err(Errno::ENOTDIR),
            None => {}
        }

        if normalise_path(to).map(|tidied| tidied != to).unwrap_or(true) {
            return Err(Errno::EINVAL);
        }

        self.store
            .rename_folder(from, to)
            .map_err(|error| report(from, &error))?;

        // Local files under the folder travel with it, or an editor part way through writing one
        // loses track of where it put it.
        let prefix = format!("{from}/");
        for file in self.locals.values_mut() {
            if let Some(tail) = file.path.strip_prefix(&prefix) {
                file.path = format!("{to}/{tail}");
            }
        }

        self.inodes.rename_folder(from, to);
        Ok(())
    }

    fn rename_note_to(
        &mut self,
        note_id: &str,
        to: &str,
        destination: Option<Entry>,
    ) -> Result<(), Errno> {
        if !self.is_note_path(to) {
            if self.is_scratch(to) {
                // An editor moving the original out of the way before writing a new one in its
                // place. See `copy_note_aside` for why the note does not actually move.
                return self.copy_note_aside(note_id, to);
            }

            // A note cannot be called this, and unlike the case above there is no reading of it
            // that keeps the note. The same refusal `normalise_path` makes about `..`: not a
            // judgement about what the user should want, but about what a vault can hold.
            log::warn!(
                "{to} is not a markdown file, so a note cannot be moved to it. Copy it out of the \
                 mount instead, or rename it to something ending in .md."
            );
            return Err(Errno::EINVAL);
        }

        // The new name is worked out before anything is destroyed, so a rename onto an impossible
        // name cannot take the note that was already there with it.
        let name = note_name_for(to).map_err(|reason| {
            log::warn!("{reason}");
            Errno::EINVAL
        })?;

        match destination {
            Some(Entry::Folder(_)) => return Err(Errno::EISDIR),
            Some(Entry::Note(existing)) => {
                // Replacing one note with another. The note being moved keeps its history - it is
                // the file the user is keeping - and the one it lands on is tombstoned.
                self.store
                    .delete_note(&existing)
                    .map_err(|error| report(to, &error))?;
                self.open_notes.remove(&existing);
                self.inodes.forget(&Entry::Note(existing));
            }
            Some(Entry::Local(id)) => {
                self.locals.remove(&id);
                self.inodes.forget(&Entry::Local(id));
            }
            Some(Entry::Root) | None => {}
        }

        self.store
            .rename_note(note_id, &name)
            .map_err(|error| report(to, &error))
    }

    /// An editor renaming a note out of the way before writing a new one in its place.
    ///
    /// The note **stays where it is** and a copy of its text appears under the new name. That is
    /// not what a rename means, and it is what this operation is: the editor is about to create a
    /// file at the old name and write the new document into it, and every reading that actually
    /// moves the note ends with the history split in two.
    ///
    /// Moving it really - tombstoning the note and leaving the text behind as a file - is what this
    /// used to do, and it was wrong in the way that matters. The editor's next write found the name
    /// free and made a *new* note under it, so a note that had been edited for months became a
    /// tombstone plus a fresh note with one version in it - and since no client can undelete
    /// anything, that history was gone as far as its owner could tell. It happened to a real vault:
    /// nvim renamed `Things.md` to `Things.md~`, and 20 milliseconds later there were two notes
    /// called `Things`, one of them deleted and holding everything.
    ///
    /// The cost is that `mv note.md note.md~` leaves `note.md` there, which is a lie about what
    /// `mv` did. Nothing that does this is looking - the editor goes straight on to write the new
    /// file - and it is a far smaller lie than quietly cutting a note's history in half.
    fn copy_note_aside(&mut self, note_id: &str, to: &str) -> Result<(), Errno> {
        match self.at(to) {
            Some(Entry::Folder(_)) | Some(Entry::Root) => return Err(Errno::EISDIR),
            Some(Entry::Local(id)) => {
                self.locals.remove(&id);
                self.inodes.forget(&Entry::Local(id));
            }
            // A note cannot live at a name that is not a note's, so there is nothing else to be
            // standing here.
            Some(Entry::Note(_)) | None => {}
        }

        let text = self
            .note_bytes(note_id)
            .map_err(|error| report(note_id, &error))?;

        let was = self
            .store
            .path_of(note_id)
            .and_then(|name| file_path_for(&name).ok())
            .unwrap_or_else(|| note_id.to_string());

        log::debug!("{was} was copied to {to}, which is a file an editor keeps for itself.");
        self.add_local(to, &text);
        Ok(())
    }

    fn rename_local_to(
        &mut self,
        id: u64,
        to: &str,
        destination: Option<Entry>,
    ) -> Result<(), Errno> {
        let Some(file) = self.locals.get(&id) else {
            return Err(Errno::ENOENT);
        };
        let data = file.data.clone();
        let ino = self.inodes.number(Entry::Local(id));

        match destination {
            Some(Entry::Folder(_)) => Err(Errno::EISDIR),
            Some(Entry::Root) => Err(Errno::EBUSY),

            // The atomic save. What the editor wrote becomes the next version of the note that was
            // already there, so its history survives being saved over.
            Some(Entry::Note(note_id)) => {
                let text = String::from_utf8(data).map_err(|_| {
                    log::error!("{to}: a note has to be UTF-8 text. Nothing was saved.");
                    Errno::EINVAL
                })?;

                self.locals.remove(&id);

                let open = self.buffer_for(&note_id).map_err(|error| report(to, &error))?;
                open.data = text.into_bytes();
                open.dirty = true;

                // A rename moves the *source's* identity to the new name: after it, the inode the
                // kernel has for `to` is the one the scratch file had, not the one the note had.
                // Keeping the note's own number instead left the kernel holding an inode this had
                // just discarded, and the file that had only just been saved read back as "no such
                // file" - which is exactly what `sed -i` does to a note.
                self.inodes.rebind(ino, Entry::Note(note_id));
                self.commit(ino)
            }

            Some(Entry::Local(existing)) => {
                self.locals.remove(&existing);
                self.inodes.forget(&Entry::Local(existing));
                self.move_local(id, ino, to)
            }

            None => self.move_local(id, ino, to),
        }
    }

    /// Moves a local file somewhere nothing is, and commits it if it has landed on a note's name.
    ///
    /// The commit is the point. An editor that writes a scratch file and renames it into place for
    /// a note that does not exist yet may never open that path again, so waiting for a `flush` that
    /// is not coming would leave the note unwritten.
    fn move_local(&mut self, id: u64, ino: u64, to: &str) -> Result<(), Errno> {
        let becoming_note = self.is_note_path(to);

        if let Some(file) = self.locals.get_mut(&id) {
            file.path = to.to_string();
            file.modified = SystemTime::now();
        }

        if becoming_note {
            self.commit(ino)?;
        }

        Ok(())
    }

    /// Writes into a file at an offset, whatever kind of file it is.
    pub fn write_at(&mut self, ino: u64, offset: usize, data: &[u8]) -> Result<(), Errno> {
        if self.read_only {
            return Err(Errno::EROFS);
        }

        match self.inodes.entry(ino).cloned() {
            Some(Entry::Note(note_id)) => {
                let open = self
                    .buffer_for(&note_id)
                    .map_err(|error| report(&note_id, &error))?;
                splice(&mut open.data, offset, data);
                open.dirty = true;
                open.written = true;
                Ok(())
            }
            Some(Entry::Local(id)) => {
                let Some(file) = self.locals.get_mut(&id) else {
                    return Err(Errno::ENOENT);
                };
                splice(&mut file.data, offset, data);
                file.written = true;
                file.modified = SystemTime::now();
                Ok(())
            }
            Some(_) => Err(Errno::EISDIR),
            None => Err(Errno::ENOENT),
        }
    }

    /// Truncates or extends a file. A hole reads as zeroes, as it would anywhere else.
    pub fn resize(&mut self, ino: u64, size: usize) -> Result<(), Errno> {
        if self.read_only {
            return Err(Errno::EROFS);
        }

        match self.inodes.entry(ino).cloned() {
            Some(Entry::Note(note_id)) => {
                let open = self
                    .buffer_for(&note_id)
                    .map_err(|error| report(&note_id, &error))?;
                open.data.resize(size, 0);
                open.dirty = true;
                Ok(())
            }
            Some(Entry::Local(id)) => {
                let Some(file) = self.locals.get_mut(&id) else {
                    return Err(Errno::ENOENT);
                };
                file.data.resize(size, 0);
                file.modified = SystemTime::now();
                Ok(())
            }
            Some(_) => Err(Errno::EISDIR),
            None => Err(Errno::ENOENT),
        }
    }

    /// The bytes of whatever an inode is, for a read.
    pub fn bytes_of(&mut self, ino: u64) -> Result<Vec<u8>, Errno> {
        match self.inodes.entry(ino).cloned() {
            Some(Entry::Note(note_id)) => self
                .note_bytes(&note_id)
                .map_err(|error| report(&note_id, &error)),
            Some(Entry::Local(id)) => self
                .locals
                .get(&id)
                .map(|file| file.data.clone())
                .ok_or(Errno::ENOENT),
            Some(_) => Err(Errno::EISDIR),
            None => Err(Errno::ENOENT),
        }
    }
}

/// Whether a name fits in a directory entry at all. `NAME_MAX` is 255 bytes on every filesystem
/// this will ever sit next to, which is what `MAX_SEGMENT_BYTES` is about.
pub fn nameable(leaf: &str) -> bool {
    !leaf.is_empty() && leaf.len() <= MAX_SEGMENT_BYTES
}

/// A timestamp from the server.
///
/// Tolerant on purpose. A row that was just written carries a UTC `DateTime` and serialises with a
/// `Z`; the same row read back out of MySQL comes back with its kind unspecified and serialises
/// without one. Both are the same instant and both have to parse, or a note's mtime jumps around
/// depending on whether this device happened to be the one that wrote it.
pub fn parse_time(text: &str) -> SystemTime {
    use chrono::{DateTime, NaiveDateTime, Utc};

    let seconds = DateTime::parse_from_rfc3339(text)
        .map(|when| when.with_timezone(&Utc).timestamp())
        .or_else(|_| {
            NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f")
                .map(|when| when.and_utc().timestamp())
        })
        .unwrap_or(0);

    if seconds < 0 {
        return UNIX_EPOCH;
    }
    UNIX_EPOCH + Duration::from_secs(seconds as u64)
}

/// Turns a refusal from the store into the number the kernel understands, and says the sentence
/// that number throws away.
fn report(context: &str, error: &StoreError) -> Errno {
    if error.is_offline() {
        log::warn!("{context}: {error}");
    } else {
        log::error!("{context}: {error}");
    }
    Errno::EIO
}

/// Writes `data` into `buffer` at `offset`, growing it as a real file would.
fn splice(buffer: &mut Vec<u8>, offset: usize, data: &[u8]) {
    let end = offset + data.len();
    if buffer.len() < end {
        // A write past the end of a file leaves a hole, and a hole reads as zeroes.
        buffer.resize(end, 0);
    }
    buffer[offset..end].copy_from_slice(data);
}

/// The mounted filesystem.
pub struct VaultFs {
    mount: Arc<Mutex<Mount>>,
}

impl VaultFs {
    pub fn new(mount: Arc<Mutex<Mount>>) -> VaultFs {
        VaultFs { mount }
    }
}

/// Borrows the mount, recovering if a previous request panicked while holding it.
///
/// A poisoned mutex would mean every later request failing the same way and a mount that cannot
/// even be listed. What is behind it is a cache of the server's state, so carrying on with it is
/// better than refusing everything.
pub fn lock(mount: &Arc<Mutex<Mount>>) -> MutexGuard<'_, Mount> {
    mount.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The path a callback is talking about: a directory inode, plus a name inside it.
///
/// A name that is not UTF-8 can never be a note - a note name is a string the core decrypted - so
/// there is nothing to look up and nothing that could be created.
fn at_child(mount: &mut Mount, parent: INodeNo, name: &OsStr) -> Result<String, Errno> {
    let Some(parent_path) = mount.path_of(parent.0) else {
        return Err(Errno::ENOENT);
    };
    let Some(name) = name.to_str() else {
        return Err(Errno::EINVAL);
    };

    Ok(join(&parent_path, name))
}

impl Filesystem for VaultFs {
    fn lookup(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEntry) {
        let mut mount = lock(&self.mount);

        let path = match at_child(&mut mount, parent, name) {
            Ok(path) => path,
            Err(_) => {
                reply.error(Errno::ENOENT);
                return;
            }
        };

        let Some(entry) = mount.at(&path) else {
            reply.error(Errno::ENOENT);
            return;
        };

        match mount.attr_of(&entry) {
            Ok(attr) => reply.entry(&TTL, &attr, Generation(0)),
            Err(error) => reply.error(report(&path, &error)),
        }
    }

    fn getattr(&self, _req: &Request, ino: INodeNo, _fh: Option<FileHandle>, reply: ReplyAttr) {
        let mut mount = lock(&self.mount);

        let Some(entry) = mount.inodes.entry(ino.0).cloned() else {
            reply.error(Errno::ENOENT);
            return;
        };

        match mount.attr_of(&entry) {
            Ok(attr) => reply.attr(&TTL, &attr),
            Err(error) => reply.error(report(&format!("inode {}", ino.0), &error)),
        }
    }

    /// Only a size change means anything here.
    ///
    /// Mode, owner and times are accepted and ignored rather than refused. Every one of them is
    /// something an editor or `cp -p` does on the way to saving a file, and a filesystem that
    /// returns an error for `chmod` is one that reports a failed save for a save that worked. There
    /// is nowhere to put them either: a note has a name and a history, and no mode bits.
    fn setattr(
        &self,
        _req: &Request,
        ino: INodeNo,
        _mode: Option<u32>,
        _uid: Option<u32>,
        _gid: Option<u32>,
        size: Option<u64>,
        _atime: Option<TimeOrNow>,
        _mtime: Option<TimeOrNow>,
        _ctime: Option<SystemTime>,
        _fh: Option<FileHandle>,
        _crtime: Option<SystemTime>,
        _chgtime: Option<SystemTime>,
        _bkuptime: Option<SystemTime>,
        _flags: Option<BsdFileFlags>,
        reply: ReplyAttr,
    ) {
        let mut mount = lock(&self.mount);

        if let Some(size) = size {
            if let Err(errno) = mount.resize(ino.0, size as usize) {
                reply.error(errno);
                return;
            }
        }

        let Some(entry) = mount.inodes.entry(ino.0).cloned() else {
            reply.error(Errno::ENOENT);
            return;
        };

        match mount.attr_of(&entry) {
            Ok(attr) => reply.attr(&TTL, &attr),
            Err(error) => reply.error(report(&format!("inode {}", ino.0), &error)),
        }
    }

    fn readdir(
        &self,
        _req: &Request,
        ino: INodeNo,
        _fh: FileHandle,
        offset: u64,
        mut reply: ReplyDirectory,
    ) {
        let mut mount = lock(&self.mount);

        if !matches!(mount.inodes.entry(ino.0), Some(Entry::Root | Entry::Folder(_))) {
            reply.error(if mount.inodes.entry(ino.0).is_none() {
                Errno::ENOENT
            } else {
                Errno::ENOTDIR
            });
            return;
        }

        let Some(path) = mount.path_of(ino.0) else {
            reply.error(Errno::ENOENT);
            return;
        };

        let parent_ino = if path.is_empty() {
            ROOT
        } else {
            let parent = parent_path(&path);
            let entry = if parent.is_empty() {
                Entry::Root
            } else {
                Entry::Folder(parent)
            };
            mount.inodes.number(entry)
        };

        let mut entries: Vec<(u64, FileType, String)> = vec![
            (ino.0, FileType::Directory, ".".to_string()),
            (parent_ino, FileType::Directory, "..".to_string()),
        ];
        entries.extend(mount.children(&path));

        for (index, (entry_ino, kind, name)) in entries.into_iter().enumerate().skip(offset as usize)
        {
            // The offset is where to resume, so it is this entry's index plus one.
            if reply.add(INodeNo(entry_ino), index as u64 + 1, kind, name) {
                break;
            }
        }

        reply.ok();
    }

    fn open(&self, _req: &Request, ino: INodeNo, flags: OpenFlags, reply: ReplyOpen) {
        let mut mount = lock(&self.mount);

        let Some(entry) = mount.inodes.entry(ino.0).cloned() else {
            reply.error(Errno::ENOENT);
            return;
        };

        if matches!(entry, Entry::Root | Entry::Folder(_)) {
            reply.error(Errno::EISDIR);
            return;
        }

        if mount.read_only && flags.acc_mode() != OpenAccMode::O_RDONLY {
            reply.error(Errno::EROFS);
            return;
        }

        // Reading is what opening is for, so the bytes are fetched now rather than at the first
        // read: an editor that opened a note and then hit an I/O error partway down it would leave
        // the user looking at half a document.
        if let Entry::Note(note_id) = &entry {
            let note_id = note_id.clone();
            if let Err(error) = mount.store.ensure_note(&note_id) {
                reply.error(report(&note_id, &error));
                return;
            }
        }

        reply.opened(FileHandle(0), FopenFlags::empty());
    }

    fn read(
        &self,
        _req: &Request,
        ino: INodeNo,
        _fh: FileHandle,
        offset: u64,
        size: u32,
        _flags: OpenFlags,
        _lock_owner: Option<LockOwner>,
        reply: ReplyData,
    ) {
        let mut mount = lock(&self.mount);

        let bytes = match mount.bytes_of(ino.0) {
            Ok(bytes) => bytes,
            Err(errno) => {
                reply.error(errno);
                return;
            }
        };

        let start = (offset as usize).min(bytes.len());
        let end = start.saturating_add(size as usize).min(bytes.len());
        reply.data(&bytes[start..end]);
    }

    fn write(
        &self,
        _req: &Request,
        ino: INodeNo,
        _fh: FileHandle,
        offset: u64,
        data: &[u8],
        _write_flags: WriteFlags,
        _flags: OpenFlags,
        _lock_owner: Option<LockOwner>,
        reply: ReplyWrite,
    ) {
        let mut mount = lock(&self.mount);

        match mount.write_at(ino.0, offset as usize, data) {
            Ok(()) => reply.written(data.len() as u32),
            Err(errno) => reply.error(errno),
        }
    }

    /// Called on every `close`. This is where a save becomes a version.
    fn flush(
        &self,
        _req: &Request,
        ino: INodeNo,
        _fh: FileHandle,
        _lock_owner: LockOwner,
        reply: ReplyEmpty,
    ) {
        let mut mount = lock(&self.mount);
        match mount.flushed(ino.0) {
            Ok(()) => reply.ok(),
            Err(errno) => reply.error(errno),
        }
    }

    fn fsync(
        &self,
        _req: &Request,
        ino: INodeNo,
        _fh: FileHandle,
        _datasync: bool,
        reply: ReplyEmpty,
    ) {
        let mut mount = lock(&self.mount);
        match mount.commit(ino.0) {
            Ok(()) => reply.ok(),
            Err(errno) => reply.error(errno),
        }
    }

    /// The last descriptor on a file went away.
    ///
    /// `flush` has almost always saved already, and an error here is not reported to `close()`
    /// anyway - but a file written to and never flushed, which the kernel is allowed to do, would
    /// otherwise reach the end of its life with the edit still only in memory.
    fn release(
        &self,
        _req: &Request,
        ino: INodeNo,
        _fh: FileHandle,
        _flags: OpenFlags,
        _lock_owner: Option<LockOwner>,
        _flush: bool,
        reply: ReplyEmpty,
    ) {
        let mut mount = lock(&self.mount);
        let _ = mount.commit(ino.0);
        reply.ok();
    }

    fn create(
        &self,
        _req: &Request,
        parent: INodeNo,
        name: &OsStr,
        _mode: u32,
        _umask: u32,
        _flags: i32,
        reply: ReplyCreate,
    ) {
        let mut mount = lock(&self.mount);

        let made = at_child(&mut mount, parent, name).and_then(|path| mount.create_at(&path));
        match made {
            Ok(ino) => {
                let attr = mount.attr_for(ino);
                reply.created(&TTL, &attr, Generation(0), FileHandle(0), FopenFlags::empty());
            }
            Err(errno) => reply.error(errno),
        }
    }

    /// Some programs make a file with `mknod` and open it afterwards rather than using `create`.
    fn mknod(
        &self,
        _req: &Request,
        parent: INodeNo,
        name: &OsStr,
        mode: u32,
        _umask: u32,
        _rdev: u32,
        reply: ReplyEntry,
    ) {
        if mode & libc::S_IFMT != 0 && mode & libc::S_IFMT != libc::S_IFREG {
            // Devices, sockets and fifos. A vault holds notes.
            reply.error(Errno::EPERM);
            return;
        }

        let mut mount = lock(&self.mount);

        let made = at_child(&mut mount, parent, name).and_then(|path| mount.create_at(&path));
        match made {
            Ok(ino) => {
                let attr = mount.attr_for(ino);
                reply.entry(&TTL, &attr, Generation(0));
            }
            Err(errno) => reply.error(errno),
        }
    }

    fn mkdir(
        &self,
        _req: &Request,
        parent: INodeNo,
        name: &OsStr,
        _mode: u32,
        _umask: u32,
        reply: ReplyEntry,
    ) {
        let mut mount = lock(&self.mount);

        let made = at_child(&mut mount, parent, name).and_then(|path| mount.mkdir_at(&path));
        match made {
            Ok(ino) => {
                let attr = mount.dir_attr_for(ino);
                reply.entry(&TTL, &attr, Generation(0));
            }
            Err(errno) => reply.error(errno),
        }
    }

    fn rmdir(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        let mut mount = lock(&self.mount);

        match at_child(&mut mount, parent, name).and_then(|path| mount.rmdir_at(&path)) {
            Ok(()) => reply.ok(),
            Err(errno) => reply.error(errno),
        }
    }

    fn unlink(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        let mut mount = lock(&self.mount);

        match at_child(&mut mount, parent, name).and_then(|path| mount.unlink_at(&path)) {
            Ok(()) => reply.ok(),
            Err(errno) => reply.error(errno),
        }
    }

    fn rename(
        &self,
        _req: &Request,
        parent: INodeNo,
        name: &OsStr,
        newparent: INodeNo,
        newname: &OsStr,
        flags: RenameFlags,
        reply: ReplyEmpty,
    ) {
        if flags.contains(RenameFlags::RENAME_EXCHANGE) {
            // Swapping two notes atomically is not something this can do: the two renames are two
            // requests, and a crash between them leaves one name on both.
            reply.error(Errno::EINVAL);
            return;
        }

        let mut mount = lock(&self.mount);

        let outcome = at_child(&mut mount, parent, name).and_then(|from| {
            let to = at_child(&mut mount, newparent, newname)?;
            mount.rename_path(&from, &to, flags.contains(RenameFlags::RENAME_NOREPLACE))
        });

        match outcome {
            Ok(()) => reply.ok(),
            Err(errno) => reply.error(errno),
        }
    }

    /// A note is a file with a history behind it, not a second name for one. There is nothing a
    /// hard link could point at.
    fn link(
        &self,
        _req: &Request,
        _ino: INodeNo,
        _newparent: INodeNo,
        _newname: &OsStr,
        reply: ReplyEntry,
    ) {
        reply.error(Errno::EPERM);
    }

    fn symlink(
        &self,
        _req: &Request,
        _parent: INodeNo,
        _link_name: &OsStr,
        _target: &std::path::Path,
        reply: ReplyEntry,
    ) {
        // Emacs makes one of these as a lock file, and carries on perfectly well when it cannot.
        reply.error(Errno::EPERM);
    }

    fn access(&self, _req: &Request, _ino: INodeNo, _mask: AccessFlags, reply: ReplyEmpty) {
        reply.ok();
    }

    // Extended attributes. A note has a name and a history and nothing else, so there is nowhere to
    // put one - and `ENOSYS` rather than `ENODATA` is deliberate: it tells the kernel to stop asking
    // for the whole filesystem, instead of asking again for `security.capability` on every open.
    // Answered explicitly rather than left to the default so that nothing logs a line about it.

    fn getxattr(&self, _req: &Request, _ino: INodeNo, _name: &OsStr, _size: u32, reply: ReplyXattr) {
        reply.error(Errno::ENOSYS);
    }

    fn listxattr(&self, _req: &Request, _ino: INodeNo, _size: u32, reply: ReplyXattr) {
        reply.error(Errno::ENOSYS);
    }

    fn setxattr(
        &self,
        _req: &Request,
        _ino: INodeNo,
        _name: &OsStr,
        _value: &[u8],
        _flags: i32,
        _position: u32,
        reply: ReplyEmpty,
    ) {
        reply.error(Errno::ENOSYS);
    }

    fn removexattr(&self, _req: &Request, _ino: INodeNo, _name: &OsStr, reply: ReplyEmpty) {
        reply.error(Errno::ENOSYS);
    }

    /// Enough for `df` to say something true.
    ///
    /// The only number here that means anything is how many notes there are. There is no block
    /// device under this and no quota `df` could report - the real limit is the account's total
    /// ciphertext, which the server enforces and names in its refusal.
    fn statfs(&self, _req: &Request, _ino: INodeNo, reply: ReplyStatfs) {
        let mount = lock(&self.mount);
        let files = mount.store.note_ids().len() as u64;

        reply.statfs(0, 0, 0, files, 0, BLOCK_SIZE, MAX_SEGMENT_BYTES as u32, BLOCK_SIZE);
    }

    fn destroy(&mut self) {
        let mut mount = lock(&self.mount);
        mount.persist_unsent();

        let outstanding = mount.unsent_count();
        if outstanding > 0 {
            log::warn!(
                "unmounting with {outstanding} edit(s) the server has not taken. They are sealed \
                 on this device and will go out the next time this vault is mounted."
            );
        }

        // Files that were never notes go away with the mount. The ones an editor made for itself
        // are supposed to; anything else the user put here is not, and this is the last chance to
        // say so while the bytes still exist.
        let lost: Vec<String> = mount
            .locals
            .values()
            .filter(|file| {
                !file.data.is_empty()
                    && !mount.is_note_path(&file.path)
                    && !mount.is_scratch(&file.path)
            })
            .map(|file| file.path.clone())
            .collect();

        for path in lost {
            log::warn!(
                "{path} was not a markdown file, so it was never saved into the vault and is now \
                 gone."
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seconds(text: &str) -> u64 {
        parse_time(text)
            .duration_since(UNIX_EPOCH)
            .expect("after the epoch")
            .as_secs()
    }

    #[test]
    fn both_shapes_the_server_sends_are_the_same_instant() {
        // A row just written carries a UTC DateTime and serialises with a `Z`; the same row read
        // back out of MySQL comes back with its kind unspecified and serialises without one. A
        // client that understood only one would have a note's mtime jump around depending on
        // whether this device happened to be the one that wrote it.
        assert_eq!(seconds("2026-09-17T00:39:59.6360247Z"), seconds("2026-09-17T00:39:59.636024"));
        assert_eq!(seconds("2026-09-17T00:39:59Z"), seconds("2026-09-17T00:39:59"));
    }

    #[test]
    fn a_later_row_reads_as_later() {
        assert!(seconds("2026-09-17T00:40:00") > seconds("2026-09-17T00:39:59"));
        assert!(seconds("2026-09-18T00:00:00Z") > seconds("2026-09-17T23:59:59Z"));
    }

    #[test]
    fn an_offset_is_applied_rather_than_ignored() {
        // Same instant, written two ways.
        assert_eq!(seconds("2026-09-17T10:39:59+10:00"), seconds("2026-09-17T00:39:59Z"));
    }

    #[test]
    fn a_timestamp_that_cannot_be_read_is_the_epoch_and_not_a_panic() {
        // A mount must not fall over because one row's date is a shape nothing expected.
        assert_eq!(parse_time(""), UNIX_EPOCH);
        assert_eq!(parse_time("not a date"), UNIX_EPOCH);
        assert_eq!(parse_time("2026-13-45T99:99:99"), UNIX_EPOCH);
    }

    #[test]
    fn a_date_before_the_epoch_does_not_wrap_around_to_the_far_future() {
        // `SystemTime` counts from the epoch, so a negative has to be clamped rather than cast.
        assert_eq!(parse_time("1969-07-20T20:17:00Z"), UNIX_EPOCH);
    }

    #[test]
    fn a_name_that_fits_in_a_directory_entry_is_allowed_and_one_that_does_not_is_not() {
        assert!(nameable("Alpha.md"));
        assert!(nameable(&format!("{}.md", "x".repeat(252))), "255 bytes exactly");
        assert!(!nameable(&format!("{}.md", "x".repeat(253))), "256 bytes is one too many");
        assert!(!nameable(""), "there is no such directory entry");
    }

    #[test]
    fn a_name_is_measured_in_bytes_not_characters() {
        // What a filesystem can hold is 255 bytes, and the note corpus this project tests against
        // is full of characters that are more than one.
        let wide = "\u{4e2d}".repeat(85); // 255 bytes
        assert_eq!(wide.len(), 255);
        assert!(nameable(&wide));
        assert!(!nameable(&"\u{4e2d}".repeat(86)));
    }

    #[test]
    fn writing_past_the_end_of_a_file_leaves_zeroes_rather_than_rubbish() {
        let mut buffer = b"abc".to_vec();
        splice(&mut buffer, 6, b"xyz");
        assert_eq!(buffer, b"abc\0\0\0xyz");
    }

    #[test]
    fn writing_inside_a_file_replaces_exactly_what_it_covers() {
        let mut buffer = b"abcdef".to_vec();
        splice(&mut buffer, 2, b"XY");
        assert_eq!(buffer, b"abXYef", "a write must not truncate what follows it");
    }

    #[test]
    fn writing_to_the_end_extends_by_exactly_what_was_written() {
        let mut buffer = b"abc".to_vec();
        splice(&mut buffer, 3, b"def");
        assert_eq!(buffer, b"abcdef");
        assert_eq!(buffer.len(), 6);
    }
}
