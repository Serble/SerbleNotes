//! This device's copy of a vault, so a mount is local-first rather than a view of the network.
//!
//! Three files per vault, all under the cache directory and all 0600:
//!
//! - `vault.json` - the notes and versions exactly as the server sent them, **ciphertext**, with
//!   the cursor they account for. Never plaintext: the same rule the web client's `vaultCache`
//!   follows, and for the same reason. Mounting with this present draws the tree before a single
//!   request goes out, and mounting with no network at all still works.
//! - `folders.json` - folders with nothing in them. A folder is read out of note names, so one with
//!   no note in it has no name to be read out of, and `mkdir` would otherwise vanish the moment the
//!   kernel forgot the directory. This is the same device-local list the web client keeps, for the
//!   same reason, and it is emphatically not a set of folder records in the database.
//! - `unsent.json` - edits the server has not taken, sealed with the vault key. This is the only
//!   place this program can lose something with no copy anywhere, so it is the one place worth
//!   writing to disk on every failure.
//!
//! The cursor is written only with the rows that account for it, everywhere, exactly as in the web
//! client: a cursor that ran ahead of its rows would make the next delta skip those versions for
//! good.

use std::fs;
use std::io;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::api::{Note, NoteVersion};
use crate::config::{cache_dir, write_private};

/// The whole of a vault as it sits on this device.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedVault {
    pub cursor: i64,
    #[serde(default)]
    pub notes: Vec<Note>,
    #[serde(default)]
    pub versions: Vec<NoteVersion>,
}

/// One edit that has not reached the server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unsent {
    /// The note it belongs to, or `None` for a file created in the mount that the server has never
    /// heard of - which is the shape of "I made a note on a train".
    pub note_id: Option<String>,
    /// The note's name, so a note that was never created can be created under it later.
    pub path: String,
    /// The text, sealed with the vault key. A draft is note content, and the rule that this
    /// directory holds ciphertext does not stop applying because the note has not been saved yet.
    pub sealed: String,
    /// The version this edit was made against, so the retry can tell a fast-forward from a fork.
    pub baseline: Option<String>,
}

/// The cache directory for one vault.
pub struct VaultCache {
    root: PathBuf,
}

impl VaultCache {
    pub fn for_vault(vault_id: &str) -> VaultCache {
        VaultCache::at(cache_dir().join(vault_id))
    }

    /// A cache in a directory named outright.
    ///
    /// The tests use it so they need no environment variables: two of them setting `XDG_CACHE_HOME`
    /// at once is a data race, and one that leaked into the real cache directory would leave a
    /// vault behind and, worse, read it back on the next run.
    pub fn at(root: PathBuf) -> VaultCache {
        VaultCache { root }
    }

    pub fn read_vault(&self) -> Option<CachedVault> {
        read(&self.root.join("vault.json"))
    }

    /// Replaces the stored vault.
    ///
    /// The whole file is rewritten rather than the changed rows appended, which costs a few
    /// megabytes of writing on a large vault every time something changes. That is the deliberate
    /// trade: the alternative is a second store with its own consistency to reason about, and the
    /// one thing this file must never be is a set of rows that disagree with the cursor written
    /// beside them.
    pub fn write_vault(&self, vault: &CachedVault) -> io::Result<()> {
        write_private(&self.root.join("vault.json"), &serde_json::to_vec(vault)?)
    }

    pub fn read_folders(&self) -> Vec<String> {
        read(&self.root.join("folders.json")).unwrap_or_default()
    }

    pub fn write_folders(&self, folders: &[String]) -> io::Result<()> {
        write_private(&self.root.join("folders.json"), &serde_json::to_vec(folders)?)
    }

    pub fn read_unsent(&self) -> Vec<Unsent> {
        read(&self.root.join("unsent.json")).unwrap_or_default()
    }

    pub fn write_unsent(&self, unsent: &[Unsent]) -> io::Result<()> {
        write_private(&self.root.join("unsent.json"), &serde_json::to_vec(unsent)?)
    }

    /// Everything this device holds for the vault. Used by `forget`, which is the other half of
    /// offering to remember a key: a key dropped while a cache of the vault stays behind has only
    /// moved the problem.
    pub fn discard(&self) -> io::Result<()> {
        match fs::remove_dir_all(&self.root) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }
}

fn read<T: serde::de::DeserializeOwned>(path: &std::path::Path) -> Option<T> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn scratch(name: &str) -> VaultCache {
        let root = std::env::temp_dir().join(format!(
            "serblenotes-cache-{}-{name}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        VaultCache::at(root)
    }

    fn a_note(id: &str, cursor: i64) -> Note {
        Note {
            id: id.into(),
            vault_id: "v1".into(),
            name: "c2VhbGVk".into(),
            head_version_id: Some("ver1".into()),
            cursor,
            created_at: "2026-09-17T00:00:00".into(),
            updated_at: "2026-09-17T00:00:00".into(),
            deleted: false,
        }
    }

    fn a_version(id: &str, payload: Option<&str>) -> NoteVersion {
        NoteVersion {
            id: id.into(),
            note_id: "n1".into(),
            vault_id: "v1".into(),
            parent_id: None,
            merge_parent_id: None,
            is_snapshot: true,
            is_named: false,
            payload: payload.map(str::to_string),
            label: None,
            device_id: None,
            size: 40,
            cursor: 1,
            created_at: "2026-09-17T00:00:00".into(),
        }
    }

    #[test]
    fn a_vault_comes_back_as_it_went_in() {
        let cache = scratch("roundtrip");
        let stored = CachedVault {
            cursor: 12,
            notes: vec![a_note("n1", 9)],
            versions: vec![a_version("ver1", Some("Y2lwaGVy"))],
        };

        cache.write_vault(&stored).unwrap();
        let read = cache.read_vault().expect("it was just written");

        assert_eq!(read.cursor, 12);
        assert_eq!(read.notes[0].id, "n1");
        assert_eq!(read.notes[0].head_version_id.as_deref(), Some("ver1"));
        assert_eq!(read.versions[0].payload.as_deref(), Some("Y2lwaGVy"));
        let _ = fs::remove_dir_all(&cache.root);
    }

    #[test]
    fn a_version_with_no_body_stays_one() {
        // The cursor rule's other half: a metadata-only row read back as having an empty body would
        // rebuild the note as nothing.
        let cache = scratch("nobody");
        cache
            .write_vault(&CachedVault {
                cursor: 1,
                notes: vec![],
                versions: vec![a_version("ver1", None)],
            })
            .unwrap();

        assert!(cache.read_vault().unwrap().versions[0].payload.is_none());
        let _ = fs::remove_dir_all(&cache.root);
    }

    #[test]
    fn nothing_cached_is_nothing_rather_than_an_empty_vault() {
        // The difference decides whether a mount pulls from zero or believes it is up to date.
        let cache = scratch("empty");
        assert!(cache.read_vault().is_none());
        assert!(cache.read_folders().is_empty());
        assert!(cache.read_unsent().is_empty());
    }

    #[test]
    fn a_half_written_file_is_read_as_nothing_rather_than_trusted() {
        let cache = scratch("corrupt");
        cache.write_vault(&CachedVault::default()).unwrap();
        fs::write(cache.root.join("vault.json"), "{ this was interrupted").unwrap();

        assert!(cache.read_vault().is_none(), "a truncated cache must not read as a real one");
        let _ = fs::remove_dir_all(&cache.root);
    }

    #[test]
    fn what_this_device_holds_is_readable_only_by_this_user() {
        // It is ciphertext, but it is also the whole of somebody's vault, and a 0600 file in a
        // 0755 directory still tells anyone who looks which vaults this account has.
        let cache = scratch("perms");
        cache.write_vault(&CachedVault::default()).unwrap();
        cache.write_unsent(&[]).unwrap();

        let file = fs::metadata(cache.root.join("vault.json")).unwrap();
        assert_eq!(file.permissions().mode() & 0o777, 0o600);

        let dir = fs::metadata(&cache.root).unwrap();
        assert_eq!(dir.permissions().mode() & 0o777, 0o700);
        let _ = fs::remove_dir_all(&cache.root);
    }

    #[test]
    fn writing_again_replaces_rather_than_appends() {
        let cache = scratch("replace");
        cache
            .write_vault(&CachedVault { cursor: 1, notes: vec![a_note("n1", 1)], versions: vec![] })
            .unwrap();
        cache
            .write_vault(&CachedVault { cursor: 2, notes: vec![a_note("n2", 2)], versions: vec![] })
            .unwrap();

        let read = cache.read_vault().unwrap();
        assert_eq!(read.cursor, 2);
        assert_eq!(read.notes.len(), 1);
        assert_eq!(read.notes[0].id, "n2");

        // And it leaves no temporary behind, which would otherwise accumulate one per write.
        let left: Vec<String> = fs::read_dir(&cache.root)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(left, vec!["vault.json".to_string()]);
        let _ = fs::remove_dir_all(&cache.root);
    }

    #[test]
    fn the_three_files_do_not_write_over_each_other() {
        // They share a directory and are written through the same replace-in-one-step path, so a
        // shared temporary name would have them overwriting one another.
        let cache = scratch("three");
        cache
            .write_vault(&CachedVault { cursor: 5, notes: vec![], versions: vec![] })
            .unwrap();
        cache.write_folders(&["Ideas".to_string()]).unwrap();
        cache
            .write_unsent(&[Unsent {
                note_id: Some("n1".into()),
                path: "Alpha".into(),
                sealed: "c2VhbGVk".into(),
                baseline: Some("ver1".into()),
            }])
            .unwrap();

        assert_eq!(cache.read_vault().unwrap().cursor, 5);
        assert_eq!(cache.read_folders(), vec!["Ideas".to_string()]);
        let unsent = cache.read_unsent();
        assert_eq!(unsent.len(), 1);
        assert_eq!(unsent[0].path, "Alpha");
        assert_eq!(unsent[0].baseline.as_deref(), Some("ver1"));
        let _ = fs::remove_dir_all(&cache.root);
    }

    #[test]
    fn an_unsent_edit_is_stored_sealed_and_never_as_text() {
        // It is note content. That this directory holds ciphertext does not stop applying because
        // the note has not been saved yet.
        let cache = scratch("sealed");
        cache
            .write_unsent(&[Unsent {
                note_id: None,
                path: "Secrets/Diary".into(),
                sealed: "c2VhbGVkIGJ5dGVz".into(),
                baseline: None,
            }])
            .unwrap();

        let raw = fs::read_to_string(cache.root.join("unsent.json")).unwrap();
        assert!(raw.contains("c2VhbGVkIGJ5dGVz"));
        assert!(!raw.contains("sealed bytes"), "the cache must hold the sealed form, not the text");
        let _ = fs::remove_dir_all(&cache.root);
    }

    #[test]
    fn discarding_removes_everything_this_device_held() {
        let cache = scratch("discard");
        cache.write_vault(&CachedVault::default()).unwrap();
        cache.write_folders(&["Ideas".to_string()]).unwrap();
        assert!(cache.root.exists());

        cache.discard().unwrap();
        assert!(!cache.root.exists());
        assert!(cache.read_vault().is_none());
    }

    #[test]
    fn discarding_a_cache_that_was_never_there_is_not_a_failure() {
        // `forget --cache` on a vault this machine has only ever listed.
        assert!(scratch("never").discard().is_ok());
    }
}
