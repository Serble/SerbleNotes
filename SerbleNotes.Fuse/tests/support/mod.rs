//! An in-memory Serble Notes server, and the scaffolding for a mount that talks to one.
//!
//! The same idea as the backend's own tests replacing its EF repos with fakes, and for the same
//! reason: everything worth testing here is what this client does with what the server says, and
//! standing up MySQL to find that out would only be testing EF.
//!
//! It answers the way the real one does, including the parts that are easy to get wrong and that
//! this client depends on: a version id already on the note is a retry and comes back as success,
//! one that exists on another note is a conflict, a rename appends no version, a delete is a
//! tombstone, and every write reserves exactly one cursor value.
//!
//! **Rows are handed back as copies.** A fake that returned the stored row would let a caller
//! mutate the server's state by accident and a test meant to prove a write happened would prove
//! nothing.

#![allow(dead_code)]

pub mod stub;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serblenotes_core::{make_diff, seal};

use serblenotes_fuse::api::{
    ApiError, Backend, Changes, NewNote, NewVersion, Note, NoteVersion, Vault,
};
use serblenotes_fuse::fs::Mount;
use serblenotes_fuse::names::Ignore;
use serblenotes_fuse::ids::random_id;
use serblenotes_fuse::store::VaultStore;

/// Keeps every test's cache out of the real one, and out of each other's.
///
/// `VaultStore` writes ciphertext and unsent edits under the cache directory, which is exactly what
/// it should do - but a test run that wrote into `~/.cache` would leave a vault behind and, worse,
/// read one back on the next run.
pub fn use_a_scratch_cache() {
    use std::sync::Once;
    static ONCE: Once = Once::new();

    ONCE.call_once(|| {
        let root = std::env::temp_dir().join(format!("serblenotes-fuse-tests-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("could not make a scratch cache directory");
        std::env::set_var("XDG_CACHE_HOME", &root);
        std::env::set_var("XDG_CONFIG_HOME", &root);
        std::env::set_var("XDG_DATA_HOME", &root);
    });
}

struct State {
    vault_id: String,
    cursor: i64,
    notes: HashMap<String, Note>,
    versions: Vec<NoteVersion>,
    /// When set, every request fails the way an unreachable server does.
    offline: bool,
    /// When set, the next write is refused with this status and sentence.
    refuse: Option<(u16, String)>,
    /// How many requests have been made for note bodies. Counted because the cost of opening a
    /// vault, and of listing one, is the whole reason the metadata path exists.
    body_requests: usize,
}

/// A server, shared between the test and the store under test.
#[derive(Clone)]
pub struct FakeServer {
    state: Arc<Mutex<State>>,
}

impl FakeServer {
    pub fn new(vault_id: &str) -> FakeServer {
        FakeServer {
            state: Arc::new(Mutex::new(State {
                vault_id: vault_id.to_string(),
                cursor: 0,
                notes: HashMap::new(),
                versions: Vec::new(),
                offline: false,
                refuse: None,
                body_requests: 0,
            })),
        }
    }

    pub fn go_offline(&self) {
        self.state.lock().unwrap().offline = true;
    }

    pub fn come_back(&self) {
        self.state.lock().unwrap().offline = false;
    }

    pub fn refuse_next(&self, status: u16, message: &str) {
        self.state.lock().unwrap().refuse = Some((status, message.to_string()));
    }

    /// How many requests have asked for ciphertext, of any shape.
    pub fn body_requests(&self) -> usize {
        self.state.lock().unwrap().body_requests
    }

    /// How many of a note's versions are whole documents rather than diffs.
    pub fn snapshot_count(&self, note_id: &str) -> usize {
        self.state
            .lock()
            .unwrap()
            .versions
            .iter()
            .filter(|version| version.note_id == note_id && version.is_snapshot)
            .count()
    }

    /// The longest run of diffs with no snapshot in it, which is what replaying a note costs.
    pub fn longest_diff_run(&self, note_id: &str) -> usize {
        let state = self.state.lock().unwrap();
        let mut longest = 0;
        let mut run = 0;
        for version in state.versions.iter().filter(|v| v.note_id == note_id) {
            if version.is_snapshot {
                run = 0;
            } else {
                run += 1;
                longest = longest.max(run);
            }
        }
        longest
    }

    pub fn version_count(&self, note_id: &str) -> usize {
        self.state
            .lock()
            .unwrap()
            .versions
            .iter()
            .filter(|version| version.note_id == note_id)
            .count()
    }

    pub fn note(&self, note_id: &str) -> Option<Note> {
        self.state.lock().unwrap().notes.get(note_id).cloned()
    }

    pub fn note_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.state.lock().unwrap().notes.keys().cloned().collect();
        ids.sort();
        ids
    }

    pub fn sealed_name_of(&self, note_id: &str) -> Option<String> {
        self.note(note_id).map(|note| note.name)
    }

    /// Writes a version the way another device would: on top of the note's current head, as a diff
    /// against the text that head holds.
    ///
    /// This is how a test makes a fast-forward. For a *fork*, name the parent explicitly.
    pub fn another_device_saves(&self, key: &str, note_id: &str, previous: &str, text: &str) -> String {
        let head = self.note(note_id).and_then(|note| note.head_version_id);
        self.another_device_saves_onto(key, note_id, head.as_deref(), previous, text)
    }

    /// The same, but building on a named parent - so a test can make two siblings on purpose.
    pub fn another_device_saves_onto(
        &self,
        key: &str,
        note_id: &str,
        parent: Option<&str>,
        previous: &str,
        text: &str,
    ) -> String {
        let body = match parent {
            Some(_) => make_diff(previous, text),
            None => text.to_string(),
        };

        let version = NewVersion {
            id: random_id(),
            parent_id: parent.map(str::to_string),
            merge_parent_id: None,
            is_snapshot: parent.is_none(),
            is_named: false,
            payload: seal(key, &body).expect("seal"),
            label: None,
        };

        let mut state = self.state.lock().unwrap();
        let stored = append(&mut state, note_id, &version, "another-device");
        stored.id
    }
}

fn next_cursor(state: &mut State) -> i64 {
    state.cursor += 1;
    state.cursor
}

fn now() -> String {
    // The shape a row read back out of MySQL has: no zone, because EF hands back an unspecified
    // kind. Using the awkward one in the fake is the point - the parser has to cope with it.
    "2026-09-17T12:00:00.000".to_string()
}

fn append(state: &mut State, note_id: &str, request: &NewVersion, device: &str) -> NoteVersion {
    let cursor = next_cursor(state);
    let vault_id = state.vault_id.clone();

    let version = NoteVersion {
        id: request.id.clone(),
        note_id: note_id.to_string(),
        vault_id,
        parent_id: request.parent_id.clone(),
        merge_parent_id: request.merge_parent_id.clone(),
        is_snapshot: request.is_snapshot,
        is_named: request.is_named,
        payload: Some(request.payload.clone()),
        label: request.label.clone(),
        device_id: Some(device.to_string()),
        size: request.payload.len() as i64,
        cursor,
        created_at: now(),
    };

    state.versions.push(version.clone());

    if let Some(note) = state.notes.get_mut(note_id) {
        // Deliberately not refusing a parent that is not the current head. Two devices editing
        // offline legitimately produce siblings, and the DAG is what makes that representable.
        note.head_version_id = Some(version.id.clone());
        note.cursor = cursor;
        note.updated_at = now();
    }

    version
}

fn check(state: &mut State) -> Result<(), ApiError> {
    if state.offline {
        return Err(ApiError::Offline("the fake server is switched off".into()));
    }
    if let Some((status, message)) = state.refuse.take() {
        return Err(ApiError::Refused { status, message });
    }
    Ok(())
}

impl Backend for FakeServer {
    fn changes(&self, _vault_id: &str, since: i64, bodies: bool) -> Result<Changes, ApiError> {
        let mut state = self.state.lock().unwrap();
        check(&mut state)?;

        let notes: Vec<Note> = state
            .notes
            .values()
            .filter(|note| note.cursor > since)
            .cloned()
            .collect();

        let versions: Vec<NoteVersion> = state
            .versions
            .iter()
            .filter(|version| version.cursor > since)
            .map(|version| NoteVersion {
                payload: if bodies { version.payload.clone() } else { None },
                ..version.clone()
            })
            .collect();

        // The cursor comes from the rows actually returned, not from the vault - exactly as the
        // real one does, so a client that trusted the vault's newer cursor would skip a change.
        let highest = notes
            .iter()
            .map(|note| note.cursor)
            .chain(versions.iter().map(|version| version.cursor))
            .fold(since, i64::max);

        Ok(Changes {
            vault_id: state.vault_id.clone(),
            cursor: highest,
            notes,
            versions,
        })
    }

    fn note_versions(&self, note_id: &str) -> Result<Vec<NoteVersion>, ApiError> {
        let mut state = self.state.lock().unwrap();
        check(&mut state)?;
        state.body_requests += 1;

        Ok(state
            .versions
            .iter()
            .filter(|version| version.note_id == note_id)
            .cloned()
            .collect())
    }

    fn note_versions_by_ids(&self, note_id: &str, ids: &[String]) -> Result<Vec<NoteVersion>, ApiError> {
        let mut state = self.state.lock().unwrap();
        check(&mut state)?;
        state.body_requests += 1;

        // Scoped to the note in the URL, which is the whole point of that scoping on the real one:
        // asking "does this id exist" without saying where would answer about another vault's row.
        Ok(state
            .versions
            .iter()
            .filter(|version| version.note_id == note_id && ids.contains(&version.id))
            .cloned()
            .collect())
    }

    fn create_note(&self, _vault_id: &str, body: &NewNote) -> Result<Note, ApiError> {
        let mut state = self.state.lock().unwrap();
        check(&mut state)?;

        if state.notes.contains_key(&body.id) {
            return Err(ApiError::Refused {
                status: 409,
                message: "A note with that id already exists.".into(),
            });
        }

        let cursor = next_cursor(&mut state);
        let vault_id = state.vault_id.clone();

        let note = Note {
            id: body.id.clone(),
            vault_id,
            name: body.name.clone(),
            head_version_id: Some(body.initial_version.id.clone()),
            cursor,
            created_at: now(),
            updated_at: now(),
            deleted: false,
        };
        state.notes.insert(note.id.clone(), note.clone());

        // The first version is always a full document: there is no parent to diff against.
        let initial = NewVersion {
            is_snapshot: true,
            parent_id: None,
            ..body.initial_version.clone()
        };
        let version = NoteVersion {
            id: initial.id.clone(),
            note_id: note.id.clone(),
            vault_id: state.vault_id.clone(),
            parent_id: None,
            merge_parent_id: None,
            is_snapshot: true,
            is_named: initial.is_named,
            payload: Some(initial.payload.clone()),
            label: initial.label.clone(),
            device_id: Some("this-device".into()),
            size: initial.payload.len() as i64,
            cursor,
            created_at: now(),
        };
        state.versions.push(version);

        Ok(note)
    }

    fn create_version(&self, note_id: &str, body: &NewVersion) -> Result<NoteVersion, ApiError> {
        let mut state = self.state.lock().unwrap();
        check(&mut state)?;

        if !state.notes.contains_key(note_id) {
            return Err(ApiError::Refused {
                status: 404,
                message: "Note not found.".into(),
            });
        }

        // A retry after a flaky connection is normal for a sync client, so an id already on this
        // note is success rather than an error.
        if let Some(existing) = state
            .versions
            .iter()
            .find(|version| version.note_id == note_id && version.id == body.id)
        {
            return Ok(existing.clone());
        }

        // The id is not on this note, so if it exists at all it belongs to another one.
        if state.versions.iter().any(|version| version.id == body.id) {
            return Err(ApiError::Refused {
                status: 409,
                message: "A version with that id already exists.".into(),
            });
        }

        if let Some(parent) = &body.parent_id {
            if !state
                .versions
                .iter()
                .any(|version| version.note_id == note_id && version.id == *parent)
            {
                return Err(ApiError::Refused {
                    status: 400,
                    message: "The parent version does not exist.".into(),
                });
            }
        } else if !body.is_snapshot {
            return Err(ApiError::Refused {
                status: 400,
                message: "A diff version must have a parent.".into(),
            });
        }

        Ok(append(&mut state, note_id, body, "this-device"))
    }

    fn rename_note(&self, note_id: &str, sealed_name: &str) -> Result<Note, ApiError> {
        let mut state = self.state.lock().unwrap();
        check(&mut state)?;

        let cursor = next_cursor(&mut state);
        let Some(note) = state.notes.get_mut(note_id) else {
            return Err(ApiError::Refused {
                status: 404,
                message: "Note not found.".into(),
            });
        };

        // A rename appends no version, which is what lets a move be a move.
        note.name = sealed_name.to_string();
        note.cursor = cursor;
        note.updated_at = now();
        Ok(note.clone())
    }

    fn delete_note(&self, note_id: &str) -> Result<(), ApiError> {
        let mut state = self.state.lock().unwrap();
        check(&mut state)?;

        let cursor = next_cursor(&mut state);
        let Some(note) = state.notes.get_mut(note_id) else {
            return Err(ApiError::Refused {
                status: 404,
                message: "Note not found.".into(),
            });
        };

        // A tombstone. The history stays, which is why nothing here removes a version.
        note.deleted = true;
        note.cursor = cursor;
        note.updated_at = now();
        Ok(())
    }
}

/// A vault that is not encrypted, so a test does not have to derive an Argon2id key to make one.
///
/// The key is a real random vault key and everything is really sealed with it - the difference from
/// an encrypted vault is only how the key itself is protected, which is not what any of this is
/// about.
pub fn a_vault(key: &str) -> Vault {
    Vault {
        id: random_id(),
        name: "Test vault".into(),
        owner_id: "owner".into(),
        encrypted: false,
        wrapped_key: key.to_string(),
        kdf_salt: None,
        kdf_params: None,
        cursor: 0,
        created_at: now(),
        updated_at: now(),
        deleted: false,
    }
}

/// Everything a test needs to talk to one vault.
pub struct Setup {
    pub server: FakeServer,
    pub key: String,
    pub vault_id: String,
}

/// A store and the server behind it, both fresh.
pub fn a_store() -> (VaultStore, Setup) {
    use_a_scratch_cache();

    let key = serblenotes_core::generate_vault_key();
    let vault = a_vault(&key);
    let server = FakeServer::new(&vault.id);

    let store = VaultStore::new(&vault.id, &key, Box::new(server.clone()));
    (
        store,
        Setup {
            server,
            key,
            vault_id: vault.id,
        },
    )
}

/// Where a vault's cache sits, so a test can see whether anything wrote to it.
pub fn cache_path(vault_id: &str) -> std::path::PathBuf {
    serblenotes_fuse::config::cache_dir().join(vault_id).join("vault.json")
}

/// A mount over a fresh store.
pub fn a_mount() -> (Mount, Setup) {
    a_mount_ignoring(&[])
}

/// A mount that has been told to leave some names alone.
pub fn a_mount_ignoring(patterns: &[&str]) -> (Mount, Setup) {
    let (store, setup) = a_store();
    let owned: Vec<String> = patterns.iter().map(|p| (*p).to_string()).collect();
    (Mount::new(store, false, Ignore::new(&owned).unwrap()), setup)
}

/// A second device onto the same server: its own store, its own cache, the same vault key.
pub fn another_device(server: &FakeServer, key: &str, vault_id: &str) -> VaultStore {
    VaultStore::new(vault_id, key, Box::new(server.clone()))
}

/// A mount the sync loop can be run against.
pub fn shared(mount: Mount) -> Arc<Mutex<Mount>> {
    Arc::new(Mutex::new(mount))
}

/// Writes a whole file the way a program does: create, write, close.
pub fn write_file(mount: &mut Mount, path: &str, text: &str) -> Result<u64, fuser::Errno> {
    let ino = mount.create_at(path)?;
    mount.write_at(ino, 0, text.as_bytes())?;
    mount.commit(ino)?;
    Ok(ino)
}

/// What a file in the mount reads back as.
pub fn read_file(mount: &mut Mount, path: &str) -> Option<String> {
    let entry = mount.at(path)?;
    let ino = mount.inodes.number(entry);
    String::from_utf8(mount.bytes_of(ino).ok()?).ok()
}

/// The names directly inside a folder, sorted.
pub fn listing(mount: &mut Mount, folder: &str) -> Vec<String> {
    mount
        .children(folder)
        .into_iter()
        .map(|(_, _, name)| name)
        .collect()
}
