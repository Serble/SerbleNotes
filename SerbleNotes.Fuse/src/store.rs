//! The client-side model of one vault: its notes, their version DAG, and the decryption that turns
//! the server's opaque blobs into text.
//!
//! This is the same thing `SerbleNotes.App/src/services/store.ts` is, in Rust, for the same reason
//! it exists there: every read below is answered from memory and the network only ever adds to it,
//! which is what makes the mount work on a train. Where the two differ, the difference is noted -
//! the filesystem asks some questions the sidebar never has to.
//!
//! All of the crypto and all of the version control is the core's. Nothing here hashes, diffs,
//! merges or encrypts anything itself.

use std::collections::{HashMap, HashSet};

use serblenotes_core::{
    make_diff, merge3, normalise_path, open, parent_path, replay, reparent, seal,
};

use crate::api::{ApiError, Backend, NewNote, NewVersion, Note, NoteVersion, IDS_PER_REQUEST};
use crate::cache::{CachedVault, Unsent, VaultCache};
use crate::ids::random_id;

/// How many diffs to allow before writing a full snapshot, so replaying history stays cheap. The
/// same number the other clients use - it is a property of the stored history, not a preference.
const SNAPSHOT_EVERY: usize = 10;

#[derive(Debug)]
pub enum StoreError {
    /// The server could not be reached, or refused.
    Api(ApiError),
    /// The core refused: a diff that does not apply, a name that will not decrypt, a history with
    /// no snapshot at the bottom of it. Always a damaged vault, never a transient failure.
    Core(String),
    /// Something was asked for that this device does not hold. A bug in the caller - every path
    /// that turns a version into text is supposed to fetch first.
    Missing(String),
}

impl StoreError {
    /// Whether waiting and trying again is the right answer.
    pub fn is_offline(&self) -> bool {
        matches!(self, StoreError::Api(e) if e.is_offline())
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Api(e) => write!(f, "{e}"),
            StoreError::Core(message) | StoreError::Missing(message) => write!(f, "{message}"),
        }
    }
}

impl From<ApiError> for StoreError {
    fn from(error: ApiError) -> StoreError {
        StoreError::Api(error)
    }
}

/// What changed in the vault, as far as anything above the store is concerned.
#[derive(Debug, Default)]
pub struct Pulled {
    /// Notes whose head version moved. The caller decides what that means for a file somebody has
    /// open - see `sync::reconcile`.
    pub moved: Vec<String>,
    /// Notes that appeared, were renamed, or were tombstoned. The tree is different now.
    pub tree_changed: bool,
}

pub struct VaultStore {
    pub vault_id: String,
    /// The unwrapped vault key, base64. Everything this store reads or writes passes through it.
    key: String,
    backend: Box<dyn Backend>,
    cache: VaultCache,

    notes: HashMap<String, Note>,
    versions: HashMap<String, NoteVersion>,
    versions_by_note: HashMap<String, HashSet<String>>,

    /// Rebuilt documents, because the same head is asked for by every `getattr`, `read` and save.
    materialised: HashMap<String, String>,

    /// Decrypted names, kept against the sealed name they came from so a rename invalidates its own
    /// entry. Without this the whole vault's names are decrypted on every directory listing.
    paths: HashMap<String, (String, String)>,

    /// Note id by path. The filesystem asks "what is at this path" for every lookup the kernel
    /// makes, which is far more often than the sidebar ever asks, so it is an index rather than a
    /// scan. Rebuilt when `revision` moves.
    by_path: HashMap<String, String>,
    index_revision: u64,
    revision: u64,

    /// Folders with nothing in them, remembered on this device. See `cache.rs`.
    empty_folders: HashSet<String>,

    pub cursor: i64,
}

impl VaultStore {
    pub fn new(vault_id: &str, key: &str, backend: Box<dyn Backend>) -> VaultStore {
        let cache = VaultCache::for_vault(vault_id);
        let empty_folders = cache.read_folders().into_iter().collect();

        VaultStore {
            vault_id: vault_id.to_string(),
            key: key.to_string(),
            backend,
            cache,
            notes: HashMap::new(),
            versions: HashMap::new(),
            versions_by_note: HashMap::new(),
            materialised: HashMap::new(),
            paths: HashMap::new(),
            by_path: HashMap::new(),
            index_revision: u64::MAX,
            revision: 0,
            empty_folders,
            cursor: 0,
        }
    }

    // --- coming into being ----------------------------------------------------------------------

    /// Loads what this device already had, and says whether there was anything.
    ///
    /// The cached rows and the cursor were written together, so this is either a consistent point
    /// in the vault's history or absent.
    pub fn hydrate(&mut self) -> bool {
        let Some(cached) = self.cache.read_vault() else {
            return false;
        };

        for version in cached.versions {
            self.merge_version(version);
        }
        for note in cached.notes {
            self.notes.insert(note.id.clone(), note);
        }
        self.cursor = cached.cursor;
        self.bump();

        !self.notes.is_empty()
    }

    /// Pulls everything that changed since our cursor, metadata only.
    ///
    /// Payloads are almost all of a vault's bytes and none of them are needed to know what the tree
    /// looks like, so they stay on the server until something reads a note - see `ensure_note`.
    pub fn pull(&mut self) -> Result<Pulled, StoreError> {
        let changes = self.backend.changes(&self.vault_id, self.cursor, false)?;

        let mut pulled = Pulled::default();

        for version in changes.versions {
            self.merge_version(version);
        }

        for note in changes.notes {
            let head_moved = self
                .notes
                .get(&note.id)
                .is_none_or(|existing| existing.head_version_id != note.head_version_id);
            let shape_changed = self
                .notes
                .get(&note.id)
                .is_none_or(|existing| existing.name != note.name || existing.deleted != note.deleted);

            if head_moved && note.head_version_id.is_some() {
                pulled.moved.push(note.id.clone());
            }
            pulled.tree_changed |= shape_changed;

            self.notes.insert(note.id.clone(), note);
            self.bump();
        }

        let moved = changes.cursor > self.cursor;
        self.cursor = self.cursor.max(changes.cursor);

        if moved || pulled.tree_changed || !pulled.moved.is_empty() {
            self.prune_folders();
            self.persist();
        }

        Ok(pulled)
    }

    // --- holding versions -----------------------------------------------------------------------

    /// Stores a version without ever losing ciphertext we already hold.
    ///
    /// A metadata pull describes versions with no payload. One of those overwriting a version whose
    /// body had been fetched would make the note unreadable until it was downloaded again, so the
    /// payload we have always wins over the absence of one.
    fn merge_version(&mut self, version: NoteVersion) {
        self.versions_by_note
            .entry(version.note_id.clone())
            .or_default()
            .insert(version.id.clone());

        let kept = match self.versions.get(&version.id) {
            Some(existing) if existing.payload.is_some() && version.payload.is_none() => NoteVersion {
                payload: existing.payload.clone(),
                ..version
            },
            _ => version,
        };

        self.versions.insert(kept.id.clone(), kept);
    }

    /// The versions whose ciphertext is needed to rebuild one version: itself, then back along the
    /// parent chain to the nearest snapshot.
    ///
    /// `None` means the walk could not be finished - a parent whose metadata never arrived, or a
    /// history with no snapshot at the bottom. The caller falls back to fetching the note whole
    /// rather than guessing at a shorter answer, because a chain read one version short rebuilds
    /// the wrong document.
    fn chain_from(&self, version_id: &str) -> Option<Vec<String>> {
        let mut chain = Vec::new();
        let mut current = self.versions.get(version_id);

        while let Some(version) = current {
            chain.push(version.id.clone());
            if version.is_snapshot {
                return Some(chain);
            }
            current = version.parent_id.as_ref().and_then(|id| self.versions.get(id));
        }

        None
    }

    /// Makes sure these versions can be rebuilt on this device, downloading only what is missing.
    ///
    /// Everything that turns a version into text goes through here first. `materialise` refuses to
    /// work from a version it does not hold rather than inventing one, and this is what keeps that
    /// refusal from being seen.
    pub fn ensure_versions(&mut self, version_ids: &[Option<String>]) -> Result<(), StoreError> {
        let mut wanted: HashMap<String, Vec<String>> = HashMap::new();
        let mut whole_notes: HashSet<String> = HashSet::new();

        for version_id in version_ids.iter().flatten() {
            let Some(version) = self.versions.get(version_id) else {
                // Not a version this device has ever heard of. Nothing can be fetched for it and
                // nothing should be guessed; `materialise` says so plainly if anyone asks for it.
                continue;
            };
            let note_id = version.note_id.clone();

            match self.chain_from(version_id) {
                None => {
                    whole_notes.insert(note_id);
                }
                Some(chain) => {
                    for id in chain {
                        if self.versions.get(&id).and_then(|v| v.payload.as_ref()).is_none() {
                            let batch = wanted.entry(note_id.clone()).or_default();
                            if !batch.contains(&id) {
                                batch.push(id);
                            }
                        }
                    }
                }
            }
        }

        let mut fetched = Vec::new();

        for note_id in &whole_notes {
            fetched.extend(self.backend.note_versions(note_id)?);
        }

        for (note_id, ids) in &wanted {
            if whole_notes.contains(note_id) {
                continue;
            }
            for batch in ids.chunks(IDS_PER_REQUEST) {
                fetched.extend(self.backend.note_versions_by_ids(note_id, batch)?);
            }
        }

        if fetched.is_empty() {
            return Ok(());
        }

        for version in fetched {
            self.merge_version(version);
        }

        // No cursor moves here. These rows are already accounted for by the metadata pull that
        // named them, and moving the cursor for a body fetch would claim to have seen changes this
        // device has not.
        self.persist();
        Ok(())
    }

    /// Makes sure a note's current text can be rebuilt.
    pub fn ensure_note(&mut self, note_id: &str) -> Result<(), StoreError> {
        let head = self.head_of(note_id);
        self.ensure_versions(&[head])
    }

    /// The ciphertext of a version, or a refusal.
    ///
    /// A version whose body has not been downloaded is not an empty one, and the difference matters
    /// more here than anywhere else: text is what the next save diffs against, so treating "not
    /// here yet" as "" would write a diff that empties the note and store it as the truth.
    fn body_of(&self, version: &NoteVersion) -> Result<String, StoreError> {
        version.payload.clone().ok_or_else(|| {
            StoreError::Missing(format!(
                "Version {} has not been downloaded on this device.",
                version.id
            ))
        })
    }

    /// Reconstructs the document at a version: walk back to the nearest snapshot, then replay the
    /// diffs forward.
    pub fn materialise(&mut self, version_id: &str) -> Result<String, StoreError> {
        if let Some(text) = self.materialised.get(version_id) {
            return Ok(text.clone());
        }

        let mut diffs: Vec<String> = Vec::new();
        let mut current = self
            .versions
            .get(version_id)
            .ok_or_else(|| StoreError::Missing("That version has not been downloaded yet.".into()))?;

        while !current.is_snapshot {
            diffs.push(self.body_of(current)?);
            current = match current.parent_id.as_ref().and_then(|id| self.versions.get(id)) {
                Some(parent) => parent,
                None => {
                    return Err(StoreError::Core(
                        "This history is missing a snapshot and cannot be rebuilt.".into(),
                    ))
                }
            };
        }

        let snapshot = open(&self.key, &self.body_of(current)?).map_err(StoreError::Core)?;

        diffs.reverse();
        let opened: Result<Vec<String>, String> =
            diffs.iter().map(|diff| open(&self.key, diff)).collect();
        let opened = opened.map_err(StoreError::Core)?;

        let text = replay(
            &snapshot,
            &serde_json::to_string(&opened).map_err(|e| StoreError::Core(e.to_string()))?,
        )
        .map_err(StoreError::Core)?;

        self.materialised.insert(version_id.to_string(), text.clone());
        Ok(text)
    }

    /// A note's current text. `ensure_note` first, or this may refuse.
    pub fn text_of(&mut self, note_id: &str) -> Result<String, StoreError> {
        match self.head_of(note_id) {
            Some(head) => self.materialise(&head),
            None => Ok(String::new()),
        }
    }

    /// Fetches what is needed and then reads, which is what every caller outside a hot loop wants.
    pub fn read_note(&mut self, note_id: &str) -> Result<String, StoreError> {
        self.ensure_note(note_id)?;
        self.text_of(note_id)
    }

    /// Whether a note's text can be rebuilt from what this device holds, with no network.
    pub fn is_readable(&self, note_id: &str) -> bool {
        let Some(head) = self.head_of(note_id) else {
            return true;
        };
        match self.chain_from(&head) {
            None => false,
            Some(chain) => chain
                .iter()
                .all(|id| self.versions.get(id).is_some_and(|v| v.payload.is_some())),
        }
    }

    // --- the DAG --------------------------------------------------------------------------------

    /// Whether `candidate` is `ancestor`, or descends from it.
    ///
    /// This is the question that decides whether a new head can simply be adopted. A version that
    /// descends from the one we are holding contains it. A version that does not is a sibling -
    /// both devices built on the same parent - and adopting one of those silently drops the other.
    pub fn descends_from(&self, candidate: &str, ancestor: &str) -> bool {
        let mut seen = HashSet::new();
        let mut queue = vec![candidate.to_string()];

        while let Some(id) = queue.pop() {
            if id == ancestor {
                return true;
            }
            if !seen.insert(id.clone()) {
                continue;
            }
            if let Some(version) = self.versions.get(&id) {
                queue.extend(version.parent_id.clone());
                queue.extend(version.merge_parent_id.clone());
            }
        }

        false
    }

    /// Where two branches diverged. That version is the base for the three-way merge.
    pub fn common_ancestor(&self, a: &str, b: &str) -> Option<String> {
        let mut seen = HashSet::new();
        let mut queue = vec![a.to_string()];
        while let Some(id) = queue.pop() {
            if !seen.insert(id.clone()) {
                continue;
            }
            if let Some(version) = self.versions.get(&id) {
                queue.extend(version.parent_id.clone());
                queue.extend(version.merge_parent_id.clone());
            }
        }

        // Breadth-first from the other side, so the answer is the nearest shared version rather
        // than whichever one a depth-first walk happened to reach.
        let mut visited = HashSet::new();
        let mut queue = std::collections::VecDeque::from([b.to_string()]);
        while let Some(id) = queue.pop_front() {
            if seen.contains(&id) {
                return Some(id);
            }
            if !visited.insert(id.clone()) {
                continue;
            }
            if let Some(version) = self.versions.get(&id) {
                queue.extend(version.parent_id.clone());
                queue.extend(version.merge_parent_id.clone());
            }
        }

        None
    }

    fn count_since_snapshot(&self, version_id: Option<&str>) -> usize {
        let mut count = 0;
        let mut current = version_id.and_then(|id| self.versions.get(id));

        while let Some(version) = current {
            if version.is_snapshot {
                break;
            }
            count += 1;
            current = version.parent_id.as_ref().and_then(|id| self.versions.get(id));
        }

        count
    }

    /// Three-way merge, through the core. A conflict comes back as text with markers in it, never
    /// as a silent winner.
    pub fn merge(&self, ancestor: &str, ours: &str, theirs: &str) -> (String, bool) {
        let outcome = merge3(ancestor, ours, theirs);
        (outcome.text(), outcome.conflicted())
    }

    // --- reading the vault ----------------------------------------------------------------------

    pub fn head_of(&self, note_id: &str) -> Option<String> {
        self.notes.get(note_id)?.head_version_id.clone()
    }

    pub fn get_note(&self, note_id: &str) -> Option<&Note> {
        self.notes.get(note_id)
    }

    pub fn note_ids(&self) -> Vec<String> {
        self.notes
            .values()
            .filter(|note| !note.deleted)
            .map(|note| note.id.clone())
            .collect()
    }

    /// A note's full path, decrypted.
    ///
    /// Keyed on the sealed name rather than a revision counter, so an entry can never outlive the
    /// name it was decrypted from. A name that will not open is a damaged one and says so; there is
    /// no read-the-first-line fallback, because that means downloading bodies to draw a directory.
    pub fn path_of(&mut self, note_id: &str) -> Option<String> {
        let sealed = self.notes.get(note_id)?.name.clone();

        if let Some((from, path)) = self.paths.get(note_id) {
            if *from == sealed {
                return Some(path.clone());
            }
        }

        let path = open(&self.key, &sealed).unwrap_or_else(|_| format!("Unreadable name {note_id}"));
        self.paths.insert(note_id.to_string(), (sealed, path.clone()));
        Some(path)
    }

    /// Note id by path, for the lookups the kernel makes constantly.
    fn index(&mut self) -> &HashMap<String, String> {
        if self.index_revision == self.revision {
            return &self.by_path;
        }

        let mut index = HashMap::new();
        for note_id in self.note_ids() {
            if let Some(path) = self.path_of(&note_id) {
                // Two notes cannot share a path, so a clash here is two names that both failed to
                // decrypt into the same stand-in. Whichever wins, neither is readable anyway.
                index.insert(path, note_id);
            }
        }

        self.by_path = index;
        self.index_revision = self.revision;
        &self.by_path
    }

    pub fn note_at(&mut self, path: &str) -> Option<String> {
        self.index().get(path).cloned()
    }

    /// Every note path in the vault, sorted.
    pub fn paths(&mut self) -> Vec<String> {
        let mut paths: Vec<String> = self.index().keys().cloned().collect();
        paths.sort();
        paths
    }

    /// Notes filed in a folder, or anywhere below it.
    pub fn notes_under(&mut self, folder: &str) -> Vec<(String, String)> {
        let prefix = format!("{folder}/");
        self.index()
            .iter()
            .filter(|(path, _)| {
                let parent = parent_path(path);
                parent == folder || parent.starts_with(&prefix)
            })
            .map(|(path, id)| (path.clone(), id.clone()))
            .collect()
    }

    /// Every folder in the vault: the ones note names imply, plus the empty ones this device is
    /// remembering.
    pub fn folders(&mut self) -> HashSet<String> {
        let mut found: HashSet<String> = HashSet::new();

        for path in self.paths() {
            let segments: Vec<&str> = path.split('/').collect();
            for index in 0..segments.len().saturating_sub(1) {
                found.insert(segments[..=index].join("/"));
            }
        }

        for path in &self.empty_folders {
            let segments: Vec<&str> = path.split('/').collect();
            for index in 0..segments.len() {
                found.insert(segments[..=index].join("/"));
            }
        }

        found
    }

    /// What already lives at a path, if anything.
    ///
    /// Two things cannot share a path: the tree could not draw them apart and a filesystem could
    /// not hold them at all.
    pub fn occupant(&mut self, path: &str, ignore: Option<&str>) -> Option<Occupant> {
        if self.empty_folders.contains(path) {
            return Some(Occupant::Folder);
        }

        let prefix = format!("{path}/");
        for (existing, note_id) in self.index().clone() {
            if Some(note_id.as_str()) == ignore {
                continue;
            }
            if existing == path {
                return Some(Occupant::Note(note_id));
            }
            if existing.starts_with(&prefix) {
                return Some(Occupant::Folder);
            }
        }

        if self.empty_folders.iter().any(|folder| folder.starts_with(&prefix)) {
            return Some(Occupant::Folder);
        }

        None
    }

    // --- writing --------------------------------------------------------------------------------

    /// Builds the encrypted version body: a diff most of the time, a full snapshot periodically.
    fn build_version(
        &mut self,
        parent_id: Option<&str>,
        previous: &str,
        text: &str,
        merge_parent: Option<String>,
    ) -> Result<NewVersion, StoreError> {
        let is_snapshot =
            parent_id.is_none() || self.count_since_snapshot(parent_id) >= SNAPSHOT_EVERY;

        let body = if is_snapshot {
            text.to_string()
        } else {
            make_diff(previous, text)
        };

        Ok(NewVersion {
            id: random_id(),
            parent_id: parent_id.map(str::to_string),
            merge_parent_id: merge_parent,
            is_snapshot,
            is_named: false,
            payload: seal(&self.key, &body).map_err(StoreError::Core)?,
            label: None,
        })
    }

    /// Takes a version this device just wrote.
    ///
    /// The cursor deliberately does not move. This version's own cursor says where *it* landed, not
    /// that this device has seen everything below it - another device can hold a lower cursor we
    /// have not pulled, and a cursor written to disk ahead of its rows would make the next delta
    /// skip them for good. Only `pull` knows it has seen everything up to a point.
    fn record(&mut self, version: NoteVersion, text: &str) {
        let note_id = version.note_id.clone();
        let version_id = version.id.clone();
        let created_at = version.created_at.clone();

        self.merge_version(version);
        self.materialised.insert(version_id.clone(), text.to_string());

        if let Some(note) = self.notes.get_mut(&note_id) {
            note.head_version_id = Some(version_id);
            note.updated_at = created_at;
        }

        self.bump();
        self.persist();
    }

    /// Saves an edit as a new version. `None` means nothing actually changed.
    pub fn save_note(
        &mut self,
        note_id: &str,
        text: &str,
        merge_parent: Option<String>,
    ) -> Result<Option<NoteVersion>, StoreError> {
        // A note tombstoned on another device still has a head and a readable history here, so
        // every part of a save would work and the text would land somewhere nothing can show it
        // again. Refusing is the only honest answer.
        if self.notes.get(note_id).is_some_and(|note| note.deleted) {
            return Err(StoreError::Core(
                "This note was deleted on another device, so there is nowhere to save it.".into(),
            ));
        }

        // The base has to be the note's real text, not a version this device happens to be missing.
        self.ensure_note(note_id)?;

        let head = self.head_of(note_id);
        let previous = match &head {
            Some(head) => self.materialise(head)?,
            None => String::new(),
        };

        if text == previous {
            return Ok(None);
        }

        let body = self.build_version(head.as_deref(), &previous, text, merge_parent)?;
        let version = self.backend.create_version(note_id, &body)?;
        self.record(version.clone(), text);

        Ok(Some(version))
    }

    /// Creates a note at a path. The path is sealed before it leaves this device, like the body.
    pub fn create_note(&mut self, path: &str, text: &str) -> Result<Note, StoreError> {
        let tidied = normalise_path(path).map_err(StoreError::Core)?;
        let initial = self.build_version(None, "", text, None)?;
        let version_id = initial.id.clone();
        let sealed = initial.payload.clone();

        let note = self.backend.create_note(
            &self.vault_id,
            &NewNote {
                id: random_id(),
                name: seal(&self.key, &tidied).map_err(StoreError::Core)?,
                initial_version: initial,
            },
        )?;

        // The create response describes the note, not the version row it wrote. Building that row
        // here rather than waiting for a pull to describe it matters more than it looks: a pull
        // describes versions without their bodies, and this device would then have a note it had
        // just written and could not read back without asking the server for the bytes it had just
        // sent. On a connection that has since gone away, that is a note that will not open.
        self.merge_version(NoteVersion {
            id: version_id.clone(),
            note_id: note.id.clone(),
            vault_id: self.vault_id.clone(),
            parent_id: None,
            merge_parent_id: None,
            is_snapshot: true,
            is_named: false,
            payload: Some(sealed),
            label: None,
            device_id: None,
            size: 0,
            cursor: 0,
            created_at: note.created_at.clone(),
        });

        self.materialised.insert(version_id, text.to_string());
        self.notes.insert(note.id.clone(), note.clone());
        self.bump();

        // A pull replaces that placeholder with the real row - `merge_version` keeps the body we
        // already hold - and picks up anything else that has happened. Best effort: the note exists
        // either way, and a pull that fails costs only a re-pull next time.
        if let Err(error) = self.pull() {
            log::debug!("created the note but could not pull straight afterwards: {error}");
        }

        Ok(note)
    }

    /// Renames or moves a note. Moving is renaming: a different folder in front of the name and it
    /// lives somewhere else, with no folder records to keep in step. It appends no version.
    pub fn rename_note(&mut self, note_id: &str, path: &str) -> Result<(), StoreError> {
        let tidied = normalise_path(path).map_err(StoreError::Core)?;
        let previous_parent = self.path_of(note_id).map(|path| parent_path(&path));

        let sealed = seal(&self.key, &tidied).map_err(StoreError::Core)?;
        let note = self.backend.rename_note(note_id, &sealed)?;

        self.notes.insert(note.id.clone(), note);
        self.bump();

        if let Some(parent) = previous_parent {
            self.keep_if_now_empty(&parent);
        }
        self.prune_folders();
        self.persist();

        Ok(())
    }

    /// Renames a folder by moving every note underneath it, and carries this device's empty folders
    /// along with it.
    pub fn rename_folder(&mut self, old: &str, new: &str) -> Result<(), StoreError> {
        for (path, note_id) in self.notes_under(old) {
            let moved = reparent(&path, old, new).map_err(StoreError::Core)?;
            self.rename_note(&note_id, &moved)?;
        }

        let prefix = format!("{old}/");
        for path in self.empty_folders.clone() {
            if path != old && !path.starts_with(&prefix) {
                continue;
            }
            self.empty_folders.remove(&path);

            let tail = path[old.len()..].trim_start_matches('/').to_string();
            let moved = if new.is_empty() {
                tail
            } else if tail.is_empty() {
                new.to_string()
            } else {
                format!("{new}/{tail}")
            };
            if !moved.is_empty() {
                self.empty_folders.insert(moved);
            }
        }

        self.keep_if_now_empty(&parent_path(old));
        self.prune_folders();
        self.persist();

        Ok(())
    }

    pub fn delete_note(&mut self, note_id: &str) -> Result<(), StoreError> {
        let folder = self.path_of(note_id).map(|path| parent_path(&path));

        self.backend.delete_note(note_id)?;

        if let Some(note) = self.notes.get_mut(note_id) {
            note.deleted = true;
        }
        self.bump();

        if let Some(folder) = folder {
            self.keep_if_now_empty(&folder);
        }
        self.persist();

        Ok(())
    }

    // --- folders --------------------------------------------------------------------------------

    /// Makes a folder that has nothing in it yet. Local to this device until a note lands in it -
    /// there is nothing to create on the server, because folders are not records anywhere.
    pub fn create_folder(&mut self, path: &str) {
        self.empty_folders.insert(path.to_string());
        self.bump();
        let _ = self.cache.write_folders(&self.sorted_folders());
    }

    /// Removes a folder, and keeps its parent if that has just become empty.
    ///
    /// The second half is not tidiness. A folder only exists because something derives it - a note
    /// filed under it, or an entry in this list - so removing `Work/Projects/Alpha` from the list
    /// takes `Work` and `Work/Projects` with it, and `rmdir a/b/c && rmdir a/b` fails on the second
    /// one because `a/b` is no longer there. On any other filesystem it would be.
    pub fn remove_folder(&mut self, path: &str) {
        self.empty_folders.remove(path);
        self.bump();
        let _ = self.cache.write_folders(&self.sorted_folders());

        self.keep_if_now_empty(&parent_path(path));
    }

    /// A folder that has just lost its last note is kept, rather than blinking out of the tree the
    /// moment something is moved out of it. A file manager does not delete a directory because you
    /// moved a file out of it, and neither does this.
    fn keep_if_now_empty(&mut self, folder: &str) {
        if folder.is_empty() || !self.notes_under(folder).is_empty() {
            return;
        }
        self.create_folder(folder);
    }

    /// Drops local entries for folders that notes now give a real existence to.
    fn prune_folders(&mut self) {
        let stale: Vec<String> = self
            .empty_folders
            .clone()
            .into_iter()
            .filter(|path| !self.notes_under(path).is_empty())
            .collect();

        if stale.is_empty() {
            return;
        }
        for path in stale {
            self.empty_folders.remove(&path);
        }
        self.bump();
        let _ = self.cache.write_folders(&self.sorted_folders());
    }

    /// Folders this device is remembering because nothing is filed in them yet, sorted.
    pub fn empty_folders(&self) -> Vec<String> {
        self.sorted_folders()
    }

    fn sorted_folders(&self) -> Vec<String> {
        let mut folders: Vec<String> = self.empty_folders.iter().cloned().collect();
        folders.sort();
        folders
    }

    // --- unsent edits ---------------------------------------------------------------------------

    /// Remembers text the server has not taken yet, sealed, because it is note content.
    pub fn keep_unsent(&self, edits: &[UnsentEdit]) {
        let sealed: Vec<Unsent> = edits
            .iter()
            .filter_map(|edit| {
                Some(Unsent {
                    note_id: edit.note_id.clone(),
                    path: edit.name.clone(),
                    sealed: seal(&self.key, &edit.text).ok()?,
                    baseline: edit.baseline.clone(),
                })
            })
            .collect();

        let _ = self.cache.write_unsent(&sealed);
    }

    /// Edits this device was holding when it last stopped. One that will not open was sealed under
    /// a different key, and is skipped rather than stopping the mount.
    pub fn take_unsent(&self) -> Vec<UnsentEdit> {
        self.cache
            .read_unsent()
            .into_iter()
            .filter_map(|entry| {
                Some(UnsentEdit {
                    note_id: entry.note_id,
                    name: entry.path,
                    text: open(&self.key, &entry.sealed).ok()?,
                    baseline: entry.baseline,
                })
            })
            .collect()
    }

    // --- bookkeeping ----------------------------------------------------------------------------

    /// Invalidates everything derived from the notes: the path index and any path read from a name
    /// that has since been replaced.
    fn bump(&mut self) {
        self.revision = self.revision.wrapping_add(1);
    }

    /// Writes the rows this device holds back to its cache.
    fn persist(&self) {
        let cached = CachedVault {
            cursor: self.cursor,
            notes: self.notes.values().cloned().collect(),
            versions: self.versions.values().cloned().collect(),
        };
        if let Err(e) = self.cache.write_vault(&cached) {
            // Nothing above this depends on the cache having worked: the mount is still correct,
            // it just starts cold next time.
            log::warn!("could not write the vault cache: {e}");
        }
    }
}

/// One edit the server has not taken, in the clear, as this program passes it around. Sealed the
/// moment it reaches disk - see `VaultStore::keep_unsent`.
pub struct UnsentEdit {
    /// The note it belongs to, or `None` for a note the server has never heard of - which is the
    /// shape of "I made a note on a train".
    pub note_id: Option<String>,
    /// The note's name, so one that was never created can be created under it later.
    pub name: String,
    pub text: String,
    /// The version this edit was made against, so the retry can tell a fast-forward from a fork.
    pub baseline: Option<String>,
}

/// What is at a path already.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Occupant {
    Note(String),
    Folder,
}
