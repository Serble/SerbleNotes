//! End-to-end data-preservation tests.
//!
//! These drive the core the way the client actually does - a real vault, a real chain of snapshots
//! and diffs - and assert the thing users care about: the text they typed comes back byte for byte,
//! at every version, forever. The mini store below mirrors `SerbleNotes.App/src/services/store.ts`;
//! if the client's algorithm changes, this should change with it.

mod common;

use common::{editing_session, fast_kdf, text_corpus};
use serblenotes_core::{
    apply_diff, derive_key, generate_salt, generate_vault_key, make_diff, merge3, open, replay, seal,
};

/// How many diffs the client allows before writing a full snapshot.
const SNAPSHOT_EVERY: usize = 10;

#[derive(Clone)]
struct Version {
    id: usize,
    parent: Option<usize>,
    is_snapshot: bool,
    payload: String,
}

/// A stand-in for the client's note store: append-only versions, each holding sealed content that is
/// either a whole document or a diff against its parent.
struct Store {
    key: String,
    versions: Vec<Version>,
}

impl Store {
    fn new(key: String) -> Store {
        Store { key, versions: Vec::new() }
    }

    /// Mirrors `store.ts`: snapshot when there is no parent or the diff chain has grown too long.
    fn save(&mut self, text: &str) -> usize {
        let id = self.versions.len();
        let parent = id.checked_sub(1);

        let is_snapshot = match parent {
            None => true,
            Some(parent_id) => self.diffs_since_snapshot(parent_id) >= SNAPSHOT_EVERY,
        };

        let payload = if is_snapshot {
            seal(&self.key, text).unwrap()
        } else {
            let previous = self.materialise(parent.unwrap());
            seal(&self.key, &make_diff(&previous, text)).unwrap()
        };

        self.versions.push(Version { id, parent, is_snapshot, payload });
        id
    }

    fn diffs_since_snapshot(&self, from: usize) -> usize {
        let mut count = 0;
        let mut current = Some(from);

        while let Some(id) = current {
            let version = &self.versions[id];
            if version.is_snapshot {
                break;
            }
            count += 1;
            current = version.parent;
        }

        count
    }

    /// Walk back to the nearest snapshot, then replay forward - the client's `materialise`.
    fn materialise(&self, id: usize) -> String {
        let mut diffs: Vec<String> = Vec::new();
        let mut current = Some(id);

        while let Some(index) = current {
            let version = &self.versions[index];
            if version.is_snapshot {
                let snapshot = open(&self.key, &version.payload).unwrap();
                diffs.reverse();
                let opened: Vec<String> =
                    diffs.iter().map(|payload| open(&self.key, payload).unwrap()).collect();
                return replay(&snapshot, &serde_json::to_string(&opened).unwrap()).unwrap();
            }
            diffs.push(version.payload.clone());
            current = version.parent;
        }

        panic!("history had no snapshot to rebuild from");
    }
}

#[test]
fn a_vault_created_on_one_device_opens_on_another() {
    let password = "a long enough vault password";
    let salt = generate_salt();
    let vault_key = generate_vault_key();

    // Device one: wrap the key and hand the blob to the server.
    let wrapped = seal(&derive_key(password, &salt, &fast_kdf()).unwrap(), &vault_key).unwrap();
    let note = "# Private\n\nOnly I can read this.\n";
    let stored = seal(&vault_key, note).unwrap();

    // Device two: the server gives back only the salt and the two blobs.
    let recovered_key = open(&derive_key(password, &salt, &fast_kdf()).unwrap(), &wrapped).unwrap();
    assert_eq!(open(&recovered_key, &stored).unwrap(), note);
}

#[test]
fn every_version_of_an_editing_session_can_be_rebuilt() {
    let mut store = Store::new(generate_vault_key());
    let session = editing_session();

    let ids: Vec<usize> = session.iter().map(|text| store.save(text)).collect();

    // Not just the latest - the history panel offers all of these, and restore writes them back.
    for (index, id) in ids.iter().enumerate() {
        assert_eq!(store.materialise(*id), session[index], "version {index} rebuilt incorrectly");
    }
}

#[test]
fn a_two_hundred_edit_session_rebuilds_every_version_exactly() {
    let mut store = Store::new(generate_vault_key());
    let mut texts = Vec::new();
    let mut document = String::from("# Journal\n\n");

    for day in 0..200 {
        document.push_str(&format!("## Day {day}\n\nWrote some notes today. Weather was fine.\n\n"));
        if day % 5 == 0 {
            document = document.replace("Weather was fine.", "Weather was not fine.");
        }
        if day % 17 == 0 {
            document.insert_str(0, "(edited) ");
        }
        texts.push(document.clone());
    }

    let ids: Vec<usize> = texts.iter().map(|text| store.save(text)).collect();

    for (index, id) in ids.iter().enumerate() {
        assert_eq!(store.materialise(*id), texts[index], "version {index} of 200 rebuilt incorrectly");
    }
}

#[test]
fn the_snapshot_cadence_actually_bounds_the_replay_chain() {
    let mut store = Store::new(generate_vault_key());

    for i in 0..100 {
        store.save(&format!("line {i}\n"));
    }

    // If snapshots silently stopped happening, everything would still pass the round-trip tests
    // while replay got slower and more fragile with every edit - so assert the cadence directly.
    for version in &store.versions {
        assert!(
            store.diffs_since_snapshot(version.id) <= SNAPSHOT_EVERY,
            "version {} sits {} diffs from a snapshot",
            version.id,
            store.diffs_since_snapshot(version.id)
        );
    }

    let snapshots = store.versions.iter().filter(|version| version.is_snapshot).count();
    assert!(snapshots >= 9, "expected periodic snapshots, found {snapshots}");
}

#[test]
fn every_text_shape_survives_a_full_store_lifecycle() {
    let mut store = Store::new(generate_vault_key());
    let corpus = text_corpus();

    let ids: Vec<usize> = corpus.iter().map(|(_, text)| store.save(text)).collect();

    for (index, id) in ids.iter().enumerate() {
        let (name, expected) = &corpus[index];
        assert_eq!(store.materialise(*id), *expected, "shape did not survive the store: {name}");
    }
}

#[test]
fn restoring_an_old_version_reproduces_it_byte_for_byte() {
    let mut store = Store::new(generate_vault_key());
    let session = editing_session();
    for text in &session {
        store.save(text);
    }

    // Restore writes the old text forward as a new version rather than rewriting history.
    let target = 3;
    let restored_text = store.materialise(target);
    let new_id = store.save(&restored_text);

    assert_eq!(store.materialise(new_id), session[target]);
    // The version being restored from must be untouched by the restore.
    assert_eq!(store.materialise(target), session[target]);
}

#[test]
fn a_named_restore_point_keeps_its_label_and_its_content() {
    let key = generate_vault_key();
    let label = "before the big rewrite 🚧";
    let content = "# Draft\n\nthe good version\n";

    let sealed_label = seal(&key, label).unwrap();
    let sealed_content = seal(&key, content).unwrap();

    assert_eq!(open(&key, &sealed_label).unwrap(), label);
    assert_eq!(open(&key, &sealed_content).unwrap(), content);
    assert!(!sealed_label.contains("rewrite"), "the label leaked in plaintext");
}

#[test]
fn two_devices_editing_offline_lose_nothing() {
    let key = generate_vault_key();
    let ancestor = "# Trip plan\n\n- book flights\n- pack bags\n";

    // Laptop and phone both edit from the same starting point, offline.
    let laptop = "# Trip plan\n\n- book flights (done)\n- pack bags\n";
    let phone = "# Trip plan\n\n- book flights\n- pack bags\n- check passport\n";

    let sealed_ancestor = seal(&key, ancestor).unwrap();
    let sealed_laptop = seal(&key, laptop).unwrap();
    let sealed_phone = seal(&key, phone).unwrap();

    let merged = merge3(
        &open(&key, &sealed_ancestor).unwrap(),
        &open(&key, &sealed_laptop).unwrap(),
        &open(&key, &sealed_phone).unwrap(),
    );

    assert!(!merged.conflicted(), "edits in different places should merge cleanly");
    assert!(merged.text().contains("(done)"), "the laptop's edit was lost");
    assert!(merged.text().contains("check passport"), "the phone's edit was lost");

    // The merge result becomes a new version, and has to store and reload like any other.
    let sealed_merge = seal(&key, &merged.text()).unwrap();
    assert_eq!(open(&key, &sealed_merge).unwrap(), merged.text());
}

#[test]
fn a_conflicted_merge_still_stores_and_reloads_intact() {
    let key = generate_vault_key();
    let merged = merge3("meeting at noon\n", "meeting at 1pm\n", "meeting at 2pm\n");
    assert!(merged.conflicted());

    let sealed = seal(&key, &merged.text()).unwrap();
    let reloaded = open(&key, &sealed).unwrap();

    assert_eq!(reloaded, merged.text());
    assert!(reloaded.contains("1pm") && reloaded.contains("2pm"), "a side was lost in storage");
}

#[test]
fn a_corrupted_version_fails_loudly_instead_of_returning_the_previous_text() {
    let mut store = Store::new(generate_vault_key());
    store.save("# Version one\n");
    let second = store.save("# Version one\n\n# Version two\n");

    // Whatever the corruption - a bad byte on disk, a truncated payload, an empty payload - the
    // result must be an error. Returning the parent's text would look like the note reverting, and
    // the next save would write that stale text over the real one.
    let key = store.key.clone();
    let corruptions = [
        String::new(),
        "not a payload".to_string(),
        store.versions[second].payload[..store.versions[second].payload.len() / 2].to_string(),
        seal(&key, "").unwrap(),
        seal(&key, "garbage that is not a diff").unwrap(),
    ];

    for (index, corrupted) in corruptions.iter().enumerate() {
        let parent_text = store.materialise(store.versions[second].parent.unwrap());

        let rebuilt = open(&key, corrupted).and_then(|diff| apply_diff(&parent_text, &diff));
        assert!(rebuilt.is_err(), "corruption {index} was accepted and produced {rebuilt:?}");
    }
}

#[test]
fn an_unencrypted_vault_still_round_trips() {
    // Unencrypted vaults use the same envelope with a server-visible key, so the storage path is
    // identical and must be just as lossless.
    let key = generate_vault_key();
    let mut store = Store::new(key);

    for text in editing_session() {
        let id = store.save(&text);
        assert_eq!(store.materialise(id), text);
    }
}

#[test]
fn history_survives_a_note_being_emptied_and_rewritten() {
    let mut store = Store::new(generate_vault_key());
    let texts = [
        "# Original\n\nlots of content here\n",
        "",
        "# Rewritten\n\ncompletely different\n",
        "",
        "# Third attempt\n",
    ];

    let ids: Vec<usize> = texts.iter().map(|text| store.save(text)).collect();

    for (index, id) in ids.iter().enumerate() {
        assert_eq!(store.materialise(*id), texts[index], "version {index} lost after clearing");
    }
}
