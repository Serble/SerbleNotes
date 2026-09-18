//! The vault store: the DAG, what it downloads, and what it refuses.
//!
//! The rule this file is written to is the project's: **test that wrong input fails, not just that
//! right input works.** Everything dangerous in this layer returns a plausible document instead of
//! an error, so most of what is below is an assertion that something *must* fail.

mod support;

use serblenotes_core::open;
use serblenotes_fuse::store::UnsentEdit;
use support::{a_store, another_device};

#[test]
fn a_note_comes_back_as_what_was_written() {
    let (mut store, _setup) = a_store();

    let note = store.create_note("Work/Alpha", "# Alpha\n\nbody\n").unwrap();

    assert_eq!(store.read_note(&note.id).unwrap(), "# Alpha\n\nbody\n");
    assert_eq!(store.path_of(&note.id).unwrap(), "Work/Alpha");
}

#[test]
fn the_server_is_only_ever_given_ciphertext() {
    let (mut store, setup) = a_store();

    let note = store.create_note("Medical/Test results", "the results\n").unwrap();
    let sealed = setup.server.sealed_name_of(&note.id).unwrap();

    // The name is content: "Medical/Test results" says as much as the body does.
    assert!(!sealed.contains("Medical"));
    assert!(!sealed.contains("Test results"));
    assert_eq!(open(&setup.key, &sealed).unwrap(), "Medical/Test results");
}

#[test]
fn saving_appends_a_version_and_a_snapshot_every_ten() {
    let (mut store, setup) = a_store();
    let note = store.create_note("Alpha", "line 0\n").unwrap();

    for line in 1..=11 {
        store
            .save_note(&note.id, &format!("line {line}\n"), None)
            .unwrap();
    }

    // One for the create, eleven saves.
    assert_eq!(setup.server.version_count(&note.id), 12);
    assert_eq!(store.read_note(&note.id).unwrap(), "line 11\n");

    // And a second device, which has to rebuild all of that from diffs, agrees.
    let mut other = another_device(&setup.server, &setup.key, &setup.vault_id);
    other.pull().unwrap();
    assert_eq!(other.read_note(&note.id).unwrap(), "line 11\n");
}

#[test]
fn saving_the_same_text_again_writes_nothing() {
    let (mut store, setup) = a_store();
    let note = store.create_note("Alpha", "unchanged\n").unwrap();

    assert!(store.save_note(&note.id, "unchanged\n", None).unwrap().is_none());
    assert_eq!(setup.server.version_count(&note.id), 1);
}

#[test]
fn renaming_appends_no_version_and_keeps_the_history() {
    let (mut store, setup) = a_store();
    let note = store.create_note("Alpha", "one\n").unwrap();
    store.save_note(&note.id, "one\ntwo\n", None).unwrap();

    let before = setup.server.version_count(&note.id);
    store.rename_note(&note.id, "Work/Projects/Alpha").unwrap();

    assert_eq!(
        setup.server.version_count(&note.id),
        before,
        "moving a note must not be an edit to it"
    );
    assert_eq!(store.path_of(&note.id).unwrap(), "Work/Projects/Alpha");
    assert_eq!(store.read_note(&note.id).unwrap(), "one\ntwo\n");
}

#[test]
fn renaming_a_folder_moves_everything_under_it() {
    let (mut store, _setup) = a_store();
    let alpha = store.create_note("Work/Alpha", "a\n").unwrap();
    let beta = store.create_note("Work/Projects/Beta", "b\n").unwrap();
    let elsewhere = store.create_note("Working/Gamma", "g\n").unwrap();

    store.rename_folder("Work", "Archive").unwrap();

    assert_eq!(store.path_of(&alpha.id).unwrap(), "Archive/Alpha");
    assert_eq!(store.path_of(&beta.id).unwrap(), "Archive/Projects/Beta");
    assert_eq!(
        store.path_of(&elsewhere.id).unwrap(),
        "Working/Gamma",
        "a folder whose name merely starts the same is not the same folder"
    );
}

#[test]
fn opening_a_vault_downloads_no_note_bodies() {
    let (mut store, setup) = a_store();
    store.create_note("Alpha", "a body nobody has asked for\n").unwrap();

    // A second device, which has only ever pulled metadata.
    let mut other = another_device(&setup.server, &setup.key, &setup.vault_id);
    other.pull().unwrap();

    let note_id = other.note_at("Alpha").unwrap();
    assert_eq!(other.paths(), vec!["Alpha".to_string()], "the tree is drawn from names alone");
    assert!(
        !other.is_readable(&note_id),
        "the body should still be on the server until something reads the note"
    );

    assert_eq!(other.read_note(&note_id).unwrap(), "a body nobody has asked for\n");
    assert!(other.is_readable(&note_id));
}

#[test]
fn a_body_that_has_not_been_downloaded_is_refused_rather_than_read_as_empty() {
    let (mut store, setup) = a_store();
    let note = store.create_note("Alpha", "real text\n").unwrap();

    let mut other = another_device(&setup.server, &setup.key, &setup.vault_id);
    other.pull().unwrap();

    // The whole point: text is what the next save diffs against, so a note that opened blank would
    // be saved blank over the real one.
    setup.server.go_offline();
    let refused = other.read_note(&note.id);
    assert!(refused.is_err(), "a missing body must never come back as an empty note");
}

#[test]
fn a_fast_forward_from_another_device_is_taken_as_it_is() {
    let (mut store, setup) = a_store();
    let note = store.create_note("Alpha", "a\nb\nc\n").unwrap();
    let head = store.head_of(&note.id).unwrap();

    setup
        .server
        .another_device_saves(&setup.key, &note.id, "a\nb\nc\n", "a\nb\nC\n");

    store.pull().unwrap();
    let new_head = store.head_of(&note.id).unwrap();

    assert!(store.descends_from(&new_head, &head));
    assert_eq!(store.read_note(&note.id).unwrap(), "a\nb\nC\n");
}

#[test]
fn two_devices_building_on_the_same_parent_are_siblings_not_a_fast_forward() {
    let (mut store, setup) = a_store();
    let note = store.create_note("Alpha", "a\nb\nc\n").unwrap();
    let base = store.head_of(&note.id).unwrap();

    let ours = store.save_note(&note.id, "A\nb\nc\n", None).unwrap().unwrap();
    let theirs = setup.server.another_device_saves_onto(
        &setup.key,
        &note.id,
        Some(&base),
        "a\nb\nc\n",
        "a\nb\nC\n",
    );

    store.pull().unwrap();
    store.ensure_versions(&[Some(theirs.clone())]).unwrap();

    assert!(
        !store.descends_from(&theirs, &ours.id),
        "neither branch contains the other, so adopting one would drop the other"
    );
    assert_eq!(store.common_ancestor(&ours.id, &theirs).unwrap(), base);

    let (merged, conflicted) = store.merge("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n");
    assert!(!conflicted);
    assert_eq!(merged, "A\nb\nC\n", "both devices' edits survive");
}

#[test]
fn edits_to_the_same_line_conflict_rather_than_picking_a_winner() {
    let (store, _setup) = a_store();

    let (merged, conflicted) = store.merge("shopping list\n", "list for tuesday\n", "list for wednesday\n");

    assert!(conflicted);
    assert!(merged.contains("tuesday") && merged.contains("wednesday"));
}

#[test]
fn a_note_deleted_elsewhere_refuses_a_save_rather_than_writing_where_nothing_can_show_it() {
    let (mut store, setup) = a_store();
    let note = store.create_note("Alpha", "a\n").unwrap();

    let mut other = another_device(&setup.server, &setup.key, &setup.vault_id);
    other.pull().unwrap();
    other.delete_note(&note.id).unwrap();

    store.pull().unwrap();
    assert!(store.save_note(&note.id, "a\nb\n", None).is_err());
}

#[test]
fn deleting_is_a_tombstone_and_keeps_the_history() {
    let (mut store, setup) = a_store();
    let note = store.create_note("Alpha", "a\n").unwrap();
    store.save_note(&note.id, "a\nb\n", None).unwrap();
    let versions = setup.server.version_count(&note.id);

    store.delete_note(&note.id).unwrap();

    assert!(!store.note_ids().contains(&note.id));
    assert_eq!(
        setup.server.version_count(&note.id),
        versions,
        "a delete must not remove history - the retention window is the only way it goes away"
    );
}

#[test]
fn a_write_the_server_refuses_is_reported_rather_than_swallowed() {
    let (mut store, setup) = a_store();
    let note = store.create_note("Alpha", "a\n").unwrap();

    setup.server.refuse_next(403, "You have reached your storage limit.");
    let refused = store.save_note(&note.id, "a\nb\n", None).unwrap_err();

    assert!(!refused.is_offline(), "a limit will not fix itself by waiting");
    assert!(refused.to_string().contains("storage limit"));
}

#[test]
fn a_write_that_never_reached_the_server_is_told_apart_from_one_it_refused() {
    let (mut store, setup) = a_store();
    let note = store.create_note("Alpha", "a\n").unwrap();

    setup.server.go_offline();
    let failed = store.save_note(&note.id, "a\nb\n", None).unwrap_err();

    assert!(failed.is_offline());
}

#[test]
fn unsent_edits_are_sealed_on_this_device_and_come_back() {
    let (mut store, setup) = a_store();
    let note = store.create_note("Alpha", "a\n").unwrap();
    let head = store.head_of(&note.id).unwrap();

    store.keep_unsent(&[UnsentEdit {
        note_id: Some(note.id.clone()),
        name: "Alpha".to_string(),
        text: "a\nunsent\n".to_string(),
        baseline: Some(head.clone()),
    }]);

    // A second device with the same key reads the same cache directory for this vault, which is
    // what the next mount is.
    let other = another_device(&setup.server, &setup.key, &setup.vault_id);
    let restored = other.take_unsent();

    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0].note_id, Some(note.id));
    assert_eq!(restored[0].text, "a\nunsent\n");
    assert_eq!(restored[0].baseline, Some(head));
}

#[test]
fn a_cached_vault_opens_with_no_server_at_all() {
    let (mut store, setup) = a_store();
    let note = store.create_note("Work/Alpha", "cached body\n").unwrap();
    store.read_note(&note.id).unwrap();

    setup.server.go_offline();

    let mut cold = another_device(&setup.server, &setup.key, &setup.vault_id);
    assert!(cold.hydrate(), "the cache written above is what makes this work offline");
    assert_eq!(cold.paths(), vec!["Work/Alpha".to_string()]);
    assert_eq!(cold.read_note(&note.id).unwrap(), "cached body\n");
}

#[test]
fn folders_come_from_names_and_empty_ones_from_this_device() {
    let (mut store, _setup) = a_store();
    store.create_note("Work/Projects/Alpha", "a\n").unwrap();
    store.create_folder("Ideas");

    let folders = store.folders();
    assert!(folders.contains("Work"));
    assert!(folders.contains("Work/Projects"));
    assert!(folders.contains("Ideas"));
    assert!(!folders.contains("Work/Projects/Alpha"), "that is a note, not a folder");
}

// --- what a pull reports, which is what the mount acts on -----------------------------------------

#[test]
fn a_pull_reports_a_head_that_moved_and_only_when_it_moved() {
    let (mut store, setup) = a_store();
    let note = store.create_note("Alpha", "one\n").unwrap();

    // Nothing has happened since, so nothing is reported and the mount does not reconcile.
    let quiet = store.pull().unwrap();
    assert!(quiet.moved.is_empty(), "a pull that found nothing must report nothing");

    setup.server.another_device_saves(&setup.key, &note.id, "one\n", "two\n");
    let moved = store.pull().unwrap();

    assert_eq!(moved.moved, vec![note.id.clone()]);
    assert!(
        !moved.tree_changed,
        "an edit changes what a file contains, not what the directory looks like - saying the tree \
         changed would redraw it on every keystroke anybody makes anywhere"
    );
}

#[test]
fn a_rename_elsewhere_changes_the_tree_without_moving_any_head() {
    let (mut store, setup) = a_store();
    let note = store.create_note("Alpha", "one\n").unwrap();

    let mut other = another_device(&setup.server, &setup.key, &setup.vault_id);
    other.pull().unwrap();
    other.rename_note(&note.id, "Work/Alpha").unwrap();

    let pulled = store.pull().unwrap();
    assert!(pulled.tree_changed, "the file has moved and the mount has to notice");
    assert!(
        pulled.moved.is_empty(),
        "a rename appends no version, so nothing needs reconciling against it"
    );
    assert_eq!(store.path_of(&note.id).unwrap(), "Work/Alpha");
}

#[test]
fn a_delete_elsewhere_changes_the_tree() {
    let (mut store, setup) = a_store();
    let note = store.create_note("Alpha", "one\n").unwrap();

    let mut other = another_device(&setup.server, &setup.key, &setup.vault_id);
    other.pull().unwrap();
    other.delete_note(&note.id).unwrap();

    assert!(store.pull().unwrap().tree_changed);
    assert!(!store.note_ids().contains(&note.id));
}

#[test]
fn the_cursor_only_ever_moves_forward() {
    let (mut store, setup) = a_store();
    let note = store.create_note("Alpha", "one\n").unwrap();
    let reached = store.cursor;
    assert!(reached > 0, "creating a note is a write and reserves a cursor");

    // A pull that finds nothing must not wind it back - the next delta would replay everything.
    store.pull().unwrap();
    assert_eq!(store.cursor, reached);

    setup.server.another_device_saves(&setup.key, &note.id, "one\n", "two\n");
    store.pull().unwrap();
    assert!(store.cursor > reached);
}

#[test]
fn a_body_already_here_is_not_lost_to_a_metadata_pull() {
    // Every pull describes versions without their bodies. One of those overwriting a body already
    // fetched would make the note unreadable until it was downloaded again - and on a mount with
    // no connection, unreadable full stop.
    let (mut store, setup) = a_store();
    let note = store.create_note("Alpha", "the body\n").unwrap();
    assert_eq!(store.read_note(&note.id).unwrap(), "the body\n");

    setup.server.go_offline();
    store.pull().ok();

    assert!(store.is_readable(&note.id), "the body was here a moment ago");
    assert_eq!(store.read_note(&note.id).unwrap(), "the body\n");
}

// --- the snapshot cadence -------------------------------------------------------------------------

#[test]
fn a_snapshot_lands_every_tenth_version_and_not_at_random() {
    let (mut store, setup) = a_store();
    let note = store.create_note("Alpha", "line 0\n").unwrap();

    for line in 1..=25 {
        store.save_note(&note.id, &format!("line {line}\n"), None).unwrap();
    }

    let snapshots = setup.server.snapshot_count(&note.id);
    let total = setup.server.version_count(&note.id);
    assert_eq!(total, 26);

    // The first version is always a snapshot, then one every ten. Never snapshotting means a
    // replay walks the whole history; always snapshotting means every save stores the whole note.
    assert_eq!(snapshots, 3, "one at the start, then at ten and twenty");

    // And the longest run of diffs stays bounded, which is what replay cost depends on.
    assert!(setup.server.longest_diff_run(&note.id) <= 10);
}

#[test]
fn the_first_version_of_a_note_is_always_a_whole_document() {
    // There is no parent to diff against, so anything else would be unreadable.
    let (mut store, setup) = a_store();
    let note = store.create_note("Alpha", "one\n").unwrap();
    assert_eq!(setup.server.snapshot_count(&note.id), 1);
}

// --- two things cannot share a path ----------------------------------------------------------------

#[test]
fn a_path_reports_what_is_standing_on_it() {
    use serblenotes_fuse::store::Occupant;

    let (mut store, _setup) = a_store();
    let note = store.create_note("Work/Alpha", "a\n").unwrap();
    store.create_folder("Ideas");

    assert_eq!(store.occupant("Work/Alpha", None), Some(Occupant::Note(note.id.clone())));
    assert_eq!(store.occupant("Work", None), Some(Occupant::Folder), "a note is filed under it");
    assert_eq!(store.occupant("Ideas", None), Some(Occupant::Folder), "made here, still empty");
    assert_eq!(store.occupant("Nothing", None), None);

    // Ignoring a note is how a rename asks "is anything *else* here".
    assert_eq!(store.occupant("Work/Alpha", Some(&note.id)), None);
}

// --- folders ----------------------------------------------------------------------------------------

#[test]
fn a_folder_that_loses_its_last_note_is_kept() {
    // A file manager does not delete a directory because you moved the last file out of it.
    let (mut store, _setup) = a_store();
    let note = store.create_note("Work/Alpha", "a\n").unwrap();

    store.rename_note(&note.id, "Alpha").unwrap();

    assert!(store.folders().contains("Work"), "Work was there a moment ago");
}

#[test]
fn a_folder_stops_being_remembered_once_a_note_gives_it_one() {
    let (mut store, _setup) = a_store();
    store.create_folder("Ideas");
    assert_eq!(store.empty_folders(), vec!["Ideas".to_string()]);

    store.create_note("Ideas/First", "a\n").unwrap();

    assert!(
        store.empty_folders().is_empty(),
        "a folder with a note in it needs no help existing, and two records of it can disagree"
    );
    assert!(store.folders().contains("Ideas"));
}

#[test]
fn renaming_a_folder_carries_the_empty_ones_inside_it() {
    let (mut store, _setup) = a_store();
    store.create_note("Work/Alpha", "a\n").unwrap();
    store.create_folder("Work/Drafts");
    store.create_folder("Working/Elsewhere");

    store.rename_folder("Work", "Archive").unwrap();

    let folders = store.folders();
    assert!(folders.contains("Archive/Drafts"), "an empty folder must move with its parent");
    assert!(!folders.contains("Work/Drafts"));
    assert!(
        folders.contains("Working/Elsewhere"),
        "a folder whose name merely starts the same is not inside it"
    );
}

#[test]
fn renaming_a_folder_to_the_top_level_brings_its_contents_up() {
    let (mut store, _setup) = a_store();
    let note = store.create_note("Work/Alpha", "a\n").unwrap();
    store.create_folder("Work/Drafts");

    store.rename_folder("Work", "").unwrap();

    assert_eq!(store.path_of(&note.id).unwrap(), "Alpha");
    assert!(store.folders().contains("Drafts"));
}

#[test]
fn the_empty_folders_this_device_remembers_survive_a_restart() {
    let (mut store, setup) = a_store();
    store.create_folder("Ideas");
    store.create_folder("Work/Drafts");

    let mut next = another_device(&setup.server, &setup.key, &setup.vault_id);
    let folders = next.folders();
    assert!(folders.contains("Ideas"));
    assert!(folders.contains("Work/Drafts"));
    assert!(folders.contains("Work"), "the folder above it is derived from the one below");
}

#[test]
fn a_pull_that_found_nothing_writes_nothing() {
    // Not an optimisation. The cache and the cursor are written together, so a pull that rewrote
    // the file having learnt nothing would be indistinguishable, from outside, from one that had -
    // and "when did this device last hear anything" is the first question worth asking when a
    // mount and a server disagree.
    let (mut store, setup) = a_store();
    store.create_note("Alpha", "a\n").unwrap();

    let cache = support::cache_path(&setup.vault_id);
    assert!(cache.exists(), "creating a note is a write and is cached");
    std::fs::remove_file(&cache).unwrap();

    store.pull().unwrap();
    assert!(!cache.exists(), "nothing changed, so nothing should have been written");

    setup.server.another_device_saves(&setup.key, &store.note_ids()[0], "a\n", "b\n");
    store.pull().unwrap();
    assert!(cache.exists(), "and something did change, so it was");
}

#[test]
fn losing_the_last_note_at_the_top_level_does_not_invent_a_folder_with_no_name() {
    // The top level is not a folder, and remembering it as one puts an entry with an empty name in
    // the list this device keeps - which then draws as a directory nothing can be done with.
    let (mut store, _setup) = a_store();
    let note = store.create_note("Alone", "a\n").unwrap();

    store.delete_note(&note.id).unwrap();

    assert!(store.empty_folders().is_empty(), "got {:?}", store.empty_folders());
    assert!(!store.folders().contains(""), "the root is not a folder in its own tree");
}

#[test]
fn losing_the_last_note_in_a_real_folder_does_keep_that_folder() {
    let (mut store, _setup) = a_store();
    let note = store.create_note("Work/Alone", "a\n").unwrap();

    store.delete_note(&note.id).unwrap();

    assert_eq!(store.empty_folders(), vec!["Work".to_string()]);
}

#[test]
fn a_pull_that_found_a_rename_writes_it_down() {
    // A rename moves the cursor and changes the tree but moves no head. All three of those are
    // reasons to write the cache, and a condition that needed all of them at once would leave this
    // device re-learning the same rename on every mount.
    let (mut store, setup) = a_store();
    let note = store.create_note("Alpha", "a\n").unwrap();

    let mut other = another_device(&setup.server, &setup.key, &setup.vault_id);
    other.pull().unwrap();
    other.rename_note(&note.id, "Work/Alpha").unwrap();

    let cache = support::cache_path(&setup.vault_id);
    std::fs::remove_file(&cache).unwrap();
    store.pull().unwrap();

    assert!(cache.exists(), "the rename has to survive this mount ending");
    let cached: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&cache).unwrap()).unwrap();
    assert!(cached["cursor"].as_i64().unwrap() > 0);
}
