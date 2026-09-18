//! Inode numbers, and what each one is.
//!
//! The kernel identifies everything by inode and expects one thing to keep one number for as long
//! as it exists. That is not free here, because the three kinds of thing in this filesystem are
//! identified differently: a note by its id, which survives being renamed; a folder by its path,
//! which does not exist anywhere except as the front of note names; and a file an editor made,
//! which exists only in this process.
//!
//! So a note's inode follows its note id and a rename does not disturb it, which is what POSIX
//! says a rename does. A folder's inode is moved by hand when the folder is renamed, for the same
//! reason - the alternative is every open file under a renamed directory becoming a stale handle.

use std::collections::HashMap;

pub const ROOT: u64 = 1;

/// What an inode is.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Entry {
    Root,
    /// A folder, by path. Folders have no records anywhere, so the path is all there is.
    Folder(String),
    /// A note, by note id. Deliberately not by path: renaming a note must not change its inode.
    Note(String),
    /// A file that exists only in this mount, by local id. Either something an editor made for
    /// itself, or a note that has not been created on the server yet.
    Local(u64),
}

pub struct Inodes {
    next: u64,
    by_entry: HashMap<Entry, u64>,
    by_ino: HashMap<u64, Entry>,
}

impl Default for Inodes {
    fn default() -> Inodes {
        Inodes::new()
    }
}

impl Inodes {
    pub fn new() -> Inodes {
        let mut inodes = Inodes {
            next: ROOT + 1,
            by_entry: HashMap::new(),
            by_ino: HashMap::new(),
        };
        inodes.by_entry.insert(Entry::Root, ROOT);
        inodes.by_ino.insert(ROOT, Entry::Root);
        inodes
    }

    /// This entry's inode, allocating one the first time it is asked for.
    pub fn number(&mut self, entry: Entry) -> u64 {
        if let Some(ino) = self.by_entry.get(&entry) {
            return *ino;
        }

        let ino = self.next;
        self.next += 1;
        self.by_entry.insert(entry.clone(), ino);
        self.by_ino.insert(ino, entry);
        ino
    }

    pub fn entry(&self, ino: u64) -> Option<&Entry> {
        self.by_ino.get(&ino)
    }

    /// Points an inode at something else, keeping the number.
    ///
    /// Two callers, both of them a file becoming something else without the kernel's view of it
    /// changing: a file created in the mount turning into a real note, and a scratch file renamed
    /// over one. In both, something is still holding the number it was given - the editor's own
    /// descriptor, or the kernel's directory entry - and handing that a different inode halfway
    /// through a save is how a file ends up half-written or, worse, reads back as missing.
    ///
    /// A number that used to be this entry's keeps resolving to it rather than being dropped,
    /// because the kernel may still be holding one of those too. It just stops being the number
    /// this entry is listed under.
    pub fn rebind(&mut self, ino: u64, entry: Entry) {
        if let Some(previous) = self.by_ino.insert(ino, entry.clone()) {
            self.by_entry.remove(&previous);
        }
        self.by_entry.insert(entry, ino);
    }

    /// Moves a folder and everything under it, keeping every inode.
    pub fn rename_folder(&mut self, old: &str, new: &str) {
        let prefix = format!("{old}/");

        let moved: Vec<(String, String, u64)> = self
            .by_entry
            .iter()
            .filter_map(|(entry, ino)| match entry {
                Entry::Folder(path) if path == old || path.starts_with(&prefix) => {
                    let tail = &path[old.len()..];
                    Some((path.clone(), format!("{new}{tail}"), *ino))
                }
                _ => None,
            })
            .collect();

        for (from, to, ino) in moved {
            self.by_entry.remove(&Entry::Folder(from));
            self.by_entry.insert(Entry::Folder(to.clone()), ino);
            self.by_ino.insert(ino, Entry::Folder(to));
        }
    }

    /// Drops an entry that no longer exists. The number is not reused - the kernel may still be
    /// holding it, and handing the same number to something else is how a reader ends up looking at
    /// a different file than it opened.
    pub fn forget(&mut self, entry: &Entry) {
        if let Some(ino) = self.by_entry.remove(entry) {
            self.by_ino.remove(&ino);
        }
    }
}

/// Puts a name inside a folder.
///
/// The name is never normalised as part of a joined string, which is the same rule
/// `VaultStore.join` follows in the web client and for the same reason: normalising `"Work/   "`
/// collapses it to `"Work"`, so a file renamed to blank would silently take its own folder's name
/// and jump a level. Here the join is purely textual and the checking happens on the leaf.
pub fn join(folder: &str, name: &str) -> String {
    if folder.is_empty() {
        name.to_string()
    } else {
        format!("{folder}/{name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_entry_keeps_its_number() {
        let mut inodes = Inodes::new();
        let first = inodes.number(Entry::Note("a".into()));
        assert_eq!(inodes.number(Entry::Note("a".into())), first);
        assert_ne!(inodes.number(Entry::Note("b".into())), first);
    }

    #[test]
    fn a_renamed_folder_keeps_its_number_and_takes_its_children_with_it() {
        let mut inodes = Inodes::new();
        let work = inodes.number(Entry::Folder("Work".into()));
        let projects = inodes.number(Entry::Folder("Work/Projects".into()));

        inodes.rename_folder("Work", "Archive");

        assert_eq!(inodes.number(Entry::Folder("Archive".into())), work);
        assert_eq!(inodes.number(Entry::Folder("Archive/Projects".into())), projects);
        assert_eq!(inodes.entry(work), Some(&Entry::Folder("Archive".into())));
    }

    #[test]
    fn a_folder_whose_name_merely_starts_the_same_is_left_alone() {
        let mut inodes = Inodes::new();
        let working = inodes.number(Entry::Folder("Working".into()));
        inodes.number(Entry::Folder("Work".into()));

        inodes.rename_folder("Work", "Archive");

        assert_eq!(inodes.entry(working), Some(&Entry::Folder("Working".into())));
    }

    #[test]
    fn a_local_file_becoming_a_note_keeps_the_descriptor_pointing_at_it() {
        let mut inodes = Inodes::new();
        let ino = inodes.number(Entry::Local(7));

        inodes.rebind(ino, Entry::Note("note-id".into()));

        assert_eq!(inodes.entry(ino), Some(&Entry::Note("note-id".into())));
        assert_eq!(inodes.number(Entry::Note("note-id".into())), ino);
    }

    #[test]
    fn something_that_is_gone_stops_resolving() {
        let mut inodes = Inodes::new();
        let ino = inodes.number(Entry::Note("a".into()));

        inodes.forget(&Entry::Note("a".into()));

        assert_eq!(inodes.entry(ino), None, "a deleted note must not still answer for its inode");
    }

    #[test]
    fn a_number_is_never_handed_to_something_else() {
        // The kernel may still be holding it. Reusing it would mean a reader that opened one note
        // finding itself looking at another.
        let mut inodes = Inodes::new();
        let first = inodes.number(Entry::Note("a".into()));
        inodes.forget(&Entry::Note("a".into()));
        let second = inodes.number(Entry::Note("b".into()));

        assert_ne!(first, second);
    }

    #[test]
    fn forgetting_something_that_was_never_there_changes_nothing() {
        let mut inodes = Inodes::new();
        let kept = inodes.number(Entry::Note("a".into()));
        inodes.forget(&Entry::Note("never".into()));
        assert_eq!(inodes.entry(kept), Some(&Entry::Note("a".into())));
    }

    #[test]
    fn joining_never_normalises_the_whole_path() {
        // "Work/   " normalises to "Work", so the leaf is checked on its own and joined afterwards.
        assert_eq!(join("Work", "   "), "Work/   ");
        assert_eq!(join("", "Alpha.md"), "Alpha.md");
    }
}
