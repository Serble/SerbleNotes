//! The filesystem operations, driven the way the kernel drives them.
//!
//! These go through `Mount` rather than a real mount point: the callbacks in `fs.rs` do nothing but
//! turn inode numbers into paths and call these, and a test that needed `fusermount3` and a kernel
//! would not run in CI.
//!
//! Most of what is here is about saving. A text editor does not write a file, it performs a small
//! ritual - probe files, scratch files, renames - and every step of that ritual arrives here as an
//! operation that could quietly turn into a note, or quietly destroy one.

mod support;

use fuser::Errno;
use serblenotes_fuse::sync;
use serblenotes_fuse::tree::Entry;
use support::{a_mount, another_device, listing, read_file, shared, write_file};

#[test]
fn a_file_written_into_the_mount_becomes_a_note() {
    let (mut mount, setup) = a_mount();

    write_file(&mut mount, "Work/Alpha.md", "# Alpha\n").unwrap();

    let note_id = mount.store.note_at("Work/Alpha").expect("the note should exist");
    assert_eq!(setup.server.note_ids(), vec![note_id.clone()]);
    assert_eq!(read_file(&mut mount, "Work/Alpha.md").unwrap(), "# Alpha\n");
    assert_eq!(listing(&mut mount, "Work"), vec!["Alpha.md".to_string()]);
}

#[test]
fn closing_a_file_after_a_write_is_what_makes_a_version() {
    let (mut mount, setup) = a_mount();
    let ino = write_file(&mut mount, "Alpha.md", "one\n").unwrap();
    let note_id = mount.store.note_at("Alpha").unwrap();

    mount.write_at(ino, 0, b"two\n").unwrap();
    assert_eq!(setup.server.version_count(&note_id), 1, "not yet - it has not been closed");

    mount.commit(ino).unwrap();
    assert_eq!(setup.server.version_count(&note_id), 2);
    assert_eq!(read_file(&mut mount, "Alpha.md").unwrap(), "two\n");
}

#[test]
fn a_close_before_anything_was_written_does_not_save_an_empty_version() {
    let (mut mount, setup) = a_mount();

    // What `printf x > note.md` looks like from here. The shell opens the file, dups it onto
    // standard output and closes the original, so a flush arrives before a single byte has been
    // written - on a buffer that has just been truncated to nothing.
    let ino = mount.create_at("Alpha.md").unwrap();
    mount.flushed(ino).unwrap();
    assert!(
        setup.server.note_ids().is_empty(),
        "that close was the shell putting the file somewhere, not a save"
    );

    mount.write_at(ino, 0, b"the real contents\n").unwrap();
    mount.flushed(ino).unwrap();

    let note_id = mount.store.note_at("Alpha").expect("the note should exist");
    assert_eq!(
        setup.server.version_count(&note_id),
        1,
        "one save, one version - not an empty one and then a diff onto it"
    );
    assert_eq!(read_file(&mut mount, "Alpha.md").unwrap(), "the real contents\n");
}

#[test]
fn truncating_a_note_to_nothing_is_still_a_save() {
    let (mut mount, setup) = a_mount();
    let ino = write_file(&mut mount, "Alpha.md", "something\n").unwrap();
    let note_id = mount.store.note_at("Alpha").unwrap();

    // No write follows, so `flush` leaves it alone - but `release` happens once per open and is the
    // last word, or emptying a note would be the one edit this filesystem quietly dropped.
    mount.resize(ino, 0).unwrap();
    mount.flushed(ino).unwrap();
    assert_eq!(setup.server.version_count(&note_id), 1);

    mount.commit(ino).unwrap();
    assert_eq!(setup.server.version_count(&note_id), 2);
    assert_eq!(read_file(&mut mount, "Alpha.md").unwrap(), "");
}

#[test]
fn a_file_that_is_not_markdown_stays_in_the_mount_and_never_becomes_a_note() {
    let (mut mount, setup) = a_mount();

    // `notes.txt` cannot be a note: it would be stored as `notes.txt` and drawn as `notes.txt.md`,
    // so the file would rename itself underneath whatever made it. It is kept here instead, which
    // is what lets every editor write whatever working file it likes.
    write_file(&mut mount, "notes.txt", "not a note\n").unwrap();
    write_file(&mut mount, "Alpha.MD", "nor this\n").unwrap();

    assert!(setup.server.note_ids().is_empty());
    assert_eq!(read_file(&mut mount, "notes.txt").unwrap(), "not a note\n");
    assert_eq!(listing(&mut mount, ""), vec!["Alpha.MD".to_string(), "notes.txt".to_string()]);
}

#[test]
fn a_folder_name_no_note_could_have_is_refused() {
    let (mut mount, _setup) = a_mount();

    // A folder is the front of a note's name, so this is the same refusal `normalise_path` makes:
    // not a judgement about what the user should want, but about what can be represented.
    assert_eq!(mount.mkdir_at("Work/..").unwrap_err(), Errno::EINVAL);
    assert_eq!(mount.mkdir_at("Work/   ").unwrap_err(), Errno::EINVAL);
}

#[test]
fn an_in_place_edit_lands_as_a_new_version() {
    let (mut mount, setup) = a_mount();
    write_file(&mut mount, "Alpha.md", "first\n").unwrap();
    let note_id = mount.store.note_at("Alpha").unwrap();

    // What `sed -i` does: a temporary beside the file, with a name nothing could predict, then a
    // rename over the top. Refusing that create would refuse `sed -i` on a product whose point is
    // that you can use the tools you already have.
    let scratch = mount.create_at("sedA1B2C3").unwrap();
    mount.write_at(scratch, 0, b"second\n").unwrap();
    mount.rename_path("sedA1B2C3", "Alpha.md", false).unwrap();

    assert_eq!(mount.store.note_at("Alpha"), Some(note_id.clone()));
    assert_eq!(setup.server.version_count(&note_id), 2);
    assert_eq!(read_file(&mut mount, "Alpha.md").unwrap(), "second\n");
}

#[test]
fn backing_a_note_up_before_writing_it_keeps_one_note_with_one_history() {
    let (mut mount, setup) = a_mount();
    write_file(&mut mount, "Things.md", "first\n").unwrap();
    let note_id = mount.store.note_at("Things").unwrap();

    // What an editor with backups on does: rename the original out of the way, then write the new
    // document at the old name. The kernel looks a name up before it creates one, and the note is
    // still sitting at its own name, so that write is an open of the note - see
    // `tests/mounted.rs`, which does this through a real mount.
    mount.rename_path("Things.md", "Things.md~", false).unwrap();

    let entry = mount.at("Things.md").expect("the note has not gone anywhere");
    let ino = mount.inodes.number(entry);
    mount.resize(ino, 0).unwrap();
    mount.write_at(ino, 0, b"second\n").unwrap();
    mount.commit(ino).unwrap();

    // The note that was there is the note that is there. Actually moving it left the name free, so
    // the write above made a *different* note and the history was cut in half.
    assert_eq!(
        mount.store.note_at("Things"),
        Some(note_id.clone()),
        "the editor's new file must land on the note that was already there"
    );
    assert_eq!(setup.server.note_ids().len(), 1, "one note, not a tombstone and a replacement");
    assert!(!setup.server.note(&note_id).unwrap().deleted);
    assert_eq!(setup.server.version_count(&note_id), 2);
    assert_eq!(read_file(&mut mount, "Things.md").unwrap(), "second\n");

    // The backup is a copy, and it is the editor's to delete.
    assert_eq!(read_file(&mut mount, "Things.md~").unwrap(), "first\n");
    mount.unlink_at("Things.md~").unwrap();
    assert_eq!(listing(&mut mount, ""), vec!["Things.md".to_string()]);
}

#[test]
fn a_note_cannot_be_moved_to_a_name_a_note_cannot_have() {
    let (mut mount, setup) = a_mount();
    write_file(&mut mount, "Notes.md", "the text\n").unwrap();
    let note_id = mount.store.note_at("Notes").unwrap();

    // Not an editor's working file, and no reading of it keeps the note - so it is refused rather
    // than quietly deleting one.
    assert_eq!(
        mount.rename_path("Notes.md", "Notes.txt", false).unwrap_err(),
        Errno::EINVAL
    );

    assert_eq!(mount.store.note_at("Notes"), Some(note_id.clone()));
    assert!(!setup.server.note(&note_id).unwrap().deleted);
    assert_eq!(read_file(&mut mount, "Notes.md").unwrap(), "the text\n");
}

#[test]
fn two_things_cannot_share_a_path() {
    let (mut mount, _setup) = a_mount();
    write_file(&mut mount, "Alpha.md", "a\n").unwrap();

    assert_eq!(mount.create_at("Alpha.md").unwrap_err(), Errno::EEXIST);
    assert_eq!(mount.mkdir_at("Alpha.md").unwrap_err(), Errno::EEXIST);
}

#[test]
fn an_editors_own_files_never_reach_the_vault() {
    let (mut mount, setup) = a_mount();

    for scratch in [".Alpha.md.swp", ".#Alpha.md", "4913", "Alpha.md~", ".goutputstream-A1B2", "sedA1B2"] {
        let ino = mount.create_at(scratch).unwrap();
        mount.write_at(ino, 0, b"editor business\n").unwrap();
        mount.commit(ino).unwrap();
    }

    assert!(
        setup.server.note_ids().is_empty(),
        "a vault that filled up with swap files would be unusable within a day"
    );
    assert_eq!(read_file(&mut mount, "4913").unwrap(), "editor business\n");

    // And they go away again without troubling the server.
    mount.unlink_at("4913").unwrap();
    assert!(mount.at("4913").is_none());
}

#[test]
fn the_atomic_save_becomes_a_new_version_of_the_note_it_lands_on() {
    let (mut mount, setup) = a_mount();
    write_file(&mut mount, "Alpha.md", "first\n").unwrap();

    let note_id = mount.store.note_at("Alpha").unwrap();
    let before = setup.server.version_count(&note_id);

    // What gedit, and anything else that saves atomically, actually does.
    let scratch = mount.create_at(".goutputstream-A1B2").unwrap();
    mount.write_at(scratch, 0, b"second\n").unwrap();
    mount.rename_path(".goutputstream-A1B2", "Alpha.md", false).unwrap();

    assert_eq!(
        mount.store.note_at("Alpha"),
        Some(note_id.clone()),
        "saving over a note must not replace it with a different one"
    );
    assert_eq!(setup.server.version_count(&note_id), before + 1);
    assert_eq!(read_file(&mut mount, "Alpha.md").unwrap(), "second\n");
}

#[test]
fn a_rename_leaves_the_new_name_holding_the_inode_the_kernel_already_has() {
    let (mut mount, _setup) = a_mount();
    write_file(&mut mount, "Alpha.md", "first\n").unwrap();
    let note_id = mount.store.note_at("Alpha").unwrap();

    let scratch = mount.create_at("sedA1B2C3").unwrap();
    mount.write_at(scratch, 0, b"second\n").unwrap();
    mount.rename_path("sedA1B2C3", "Alpha.md", false).unwrap();

    // A rename moves the source's identity to the new name. Keeping the note's own number instead
    // left the kernel holding an inode that had just been discarded, and the file that had only
    // just been saved read back as "no such file". `tests/mounted.rs` is where that showed up.
    assert_eq!(
        mount.inodes.entry(scratch),
        Some(&Entry::Note(note_id.clone())),
        "the inode the kernel has for this path has to answer for the note"
    );
    assert_eq!(mount.inodes.number(Entry::Note(note_id)), scratch);
    assert_eq!(
        String::from_utf8(mount.bytes_of(scratch).unwrap()).unwrap(),
        "second\n"
    );
}

#[test]
fn a_scratch_file_renamed_onto_a_new_name_becomes_that_note_straight_away() {
    let (mut mount, setup) = a_mount();

    // The same dance, for a note that does not exist yet. Nothing will reopen this path, so
    // waiting for a flush that is not coming would leave the note unwritten.
    let scratch = mount.create_at(".goutputstream-C3D4").unwrap();
    mount.write_at(scratch, 0, b"brand new\n").unwrap();
    mount.rename_path(".goutputstream-C3D4", "Notes/New.md", false).unwrap();

    let note_id = mount.store.note_at("Notes/New").expect("the note should exist");
    assert_eq!(setup.server.note_ids(), vec![note_id]);
    assert_eq!(read_file(&mut mount, "Notes/New.md").unwrap(), "brand new\n");
}

#[test]
fn vims_dance_leaves_one_note_and_no_litter() {
    let (mut mount, setup) = a_mount();
    write_file(&mut mount, "Alpha.md", "first\n").unwrap();
    let note_id = mount.store.note_at("Alpha").unwrap();

    // Vim probes whether it can create files here, then removes the probe.
    let probe = mount.create_at("4913").unwrap();
    mount.commit(probe).unwrap();
    mount.unlink_at("4913").unwrap();

    // A swap file for the duration.
    let swap = mount.create_at(".Alpha.md.swp").unwrap();
    mount.write_at(swap, 0, b"swap\n").unwrap();

    // Then it writes the file in place.
    let ino = mount.inodes.number(Entry::Note(note_id.clone()));
    mount.resize(ino, 0).unwrap();
    mount.write_at(ino, 0, b"second\n").unwrap();
    mount.commit(ino).unwrap();

    mount.unlink_at(".Alpha.md.swp").unwrap();

    assert_eq!(setup.server.note_ids(), vec![note_id.clone()]);
    assert_eq!(setup.server.version_count(&note_id), 2);
    assert_eq!(read_file(&mut mount, "Alpha.md").unwrap(), "second\n");
    assert_eq!(listing(&mut mount, ""), vec!["Alpha.md".to_string()]);
}

#[test]
fn moving_a_note_keeps_its_inode_and_its_history() {
    let (mut mount, setup) = a_mount();
    let ino = write_file(&mut mount, "Alpha.md", "one\n").unwrap();
    let note_id = mount.store.note_at("Alpha").unwrap();
    let before = setup.server.version_count(&note_id);

    mount.mkdir_at("Work").unwrap();
    mount.rename_path("Alpha.md", "Work/Alpha.md", false).unwrap();

    assert_eq!(mount.store.note_at("Work/Alpha"), Some(note_id.clone()));
    assert_eq!(
        setup.server.version_count(&note_id),
        before,
        "a move is metadata, not an edit"
    );
    assert_eq!(
        mount.inodes.number(Entry::Note(note_id)),
        ino,
        "a rename must not change a file's inode"
    );
    assert_eq!(read_file(&mut mount, "Work/Alpha.md").unwrap(), "one\n");
}

#[test]
fn renaming_a_folder_moves_the_notes_under_it_and_keeps_its_inode() {
    let (mut mount, _setup) = a_mount();
    write_file(&mut mount, "Work/Alpha.md", "a\n").unwrap();
    write_file(&mut mount, "Work/Projects/Beta.md", "b\n").unwrap();

    let work = mount.inodes.number(Entry::Folder("Work".into()));
    mount.rename_path("Work", "Archive", false).unwrap();

    assert_eq!(mount.inodes.number(Entry::Folder("Archive".into())), work);
    assert_eq!(read_file(&mut mount, "Archive/Alpha.md").unwrap(), "a\n");
    assert_eq!(read_file(&mut mount, "Archive/Projects/Beta.md").unwrap(), "b\n");
    assert!(mount.at("Work/Alpha.md").is_none());
}

#[test]
fn a_folder_cannot_be_moved_inside_itself() {
    let (mut mount, _setup) = a_mount();
    mount.mkdir_at("Work").unwrap();

    assert_eq!(mount.rename_path("Work", "Work/Inner", false).unwrap_err(), Errno::EINVAL);
}

#[test]
fn rmdir_only_removes_an_empty_folder() {
    let (mut mount, _setup) = a_mount();
    write_file(&mut mount, "Work/Alpha.md", "a\n").unwrap();

    assert_eq!(mount.rmdir_at("Work").unwrap_err(), Errno::ENOTEMPTY);

    mount.unlink_at("Work/Alpha.md").unwrap();
    // A folder that has just lost its last note is kept, the way a file manager keeps a directory
    // you moved the last file out of.
    assert!(mount.at("Work").is_some());
    mount.rmdir_at("Work").unwrap();
    assert!(mount.at("Work").is_none());
}

#[test]
fn a_folder_made_here_is_visible_before_anything_is_filed_into_it() {
    let (mut mount, setup) = a_mount();

    mount.mkdir_at("Ideas").unwrap();

    assert_eq!(listing(&mut mount, ""), vec!["Ideas".to_string()]);
    assert!(
        setup.server.note_ids().is_empty(),
        "there are no folder records anywhere, and mkdir must not invent one"
    );
}

#[test]
fn removing_a_note_is_a_tombstone_and_the_file_goes() {
    let (mut mount, setup) = a_mount();
    write_file(&mut mount, "Alpha.md", "a\n").unwrap();
    let note_id = mount.store.note_at("Alpha").unwrap();

    mount.unlink_at("Alpha.md").unwrap();

    assert!(mount.at("Alpha.md").is_none());
    assert!(setup.server.note(&note_id).unwrap().deleted);
    assert_eq!(setup.server.version_count(&note_id), 1, "the history stays");
}

#[test]
fn bytes_that_are_not_text_are_refused_rather_than_saved_lossily() {
    let (mut mount, setup) = a_mount();
    let ino = write_file(&mut mount, "Alpha.md", "text\n").unwrap();
    let note_id = mount.store.note_at("Alpha").unwrap();

    mount.resize(ino, 0).unwrap();
    mount.write_at(ino, 0, &[0xff, 0xfe, 0x00]).unwrap();

    assert_eq!(
        mount.commit(ino).unwrap_err(),
        Errno::EINVAL,
        "a note with replacement characters where the user's bytes were is not the note"
    );
    assert_eq!(setup.server.version_count(&note_id), 1);
}

#[test]
fn a_read_only_mount_refuses_every_way_of_changing_anything() {
    let (mut mount, setup) = a_mount();
    write_file(&mut mount, "Alpha.md", "a\n").unwrap();
    let ino = mount.inodes.number(Entry::Note(mount.store.note_at("Alpha").unwrap()));

    mount.read_only = true;

    assert_eq!(mount.create_at("Beta.md").unwrap_err(), Errno::EROFS);
    assert_eq!(mount.mkdir_at("Work").unwrap_err(), Errno::EROFS);
    assert_eq!(mount.unlink_at("Alpha.md").unwrap_err(), Errno::EROFS);
    assert_eq!(mount.rename_path("Alpha.md", "Beta.md", false).unwrap_err(), Errno::EROFS);
    assert_eq!(mount.write_at(ino, 0, b"no").unwrap_err(), Errno::EROFS);
    assert_eq!(mount.resize(ino, 0).unwrap_err(), Errno::EROFS);

    assert_eq!(read_file(&mut mount, "Alpha.md").unwrap(), "a\n");
    assert_eq!(setup.server.note_ids().len(), 1);
}

#[test]
fn a_notes_size_is_the_length_of_its_text() {
    let (mut mount, _setup) = a_mount();
    write_file(&mut mount, "Alpha.md", "twelve chars").unwrap();

    let entry = mount.at("Alpha.md").unwrap();
    assert_eq!(mount.attr_of(&entry).unwrap().size, 12);
}

// --- the sync loop ------------------------------------------------------------------------------

#[test]
fn an_edit_made_while_the_server_is_away_is_kept_and_sent_when_it_comes_back() {
    let (mut mount, setup) = a_mount();
    let ino = write_file(&mut mount, "Alpha.md", "one\n").unwrap();
    let note_id = mount.store.note_at("Alpha").unwrap();

    setup.server.go_offline();
    mount.resize(ino, 0).unwrap();
    mount.write_at(ino, 0, b"two\n").unwrap();

    // Not an error: the bytes are safely on this device and will go out. Reporting a failed write
    // to the editor for a connection that will come back is the wrong answer.
    assert!(mount.commit(ino).is_ok());
    assert_eq!(mount.unsent_count(), 1);
    assert_eq!(setup.server.version_count(&note_id), 1);

    let mount = shared(mount);
    setup.server.come_back();
    sync::tick(&mount);

    let mut guard = serblenotes_fuse::fs::lock(&mount);
    assert_eq!(guard.unsent_count(), 0);
    assert_eq!(setup.server.version_count(&note_id), 2);
    assert_eq!(guard.store.read_note(&note_id).unwrap(), "two\n");
}

#[test]
fn a_new_note_made_while_the_server_is_away_is_created_when_it_comes_back() {
    let (mut mount, setup) = a_mount();

    setup.server.go_offline();
    let ino = mount.create_at("Offline.md").unwrap();
    mount.write_at(ino, 0, b"written on a train\n").unwrap();
    assert!(mount.commit(ino).is_ok());
    assert!(setup.server.note_ids().is_empty());

    let mount = shared(mount);
    setup.server.come_back();
    sync::tick(&mount);

    let mut guard = serblenotes_fuse::fs::lock(&mount);
    let note_id = guard.store.note_at("Offline").expect("the note should exist now");
    assert_eq!(setup.server.note_ids(), vec![note_id.clone()]);
    assert_eq!(guard.store.read_note(&note_id).unwrap(), "written on a train\n");
    assert_eq!(
        guard.inodes.entry(ino),
        Some(&Entry::Note(note_id)),
        "the descriptor the editor is holding has to keep pointing at what it created"
    );
}

#[test]
fn another_devices_edit_arrives_in_the_file() {
    let (mut mount, setup) = a_mount();
    write_file(&mut mount, "Alpha.md", "ours\n").unwrap();
    let note_id = mount.store.note_at("Alpha").unwrap();

    setup
        .server
        .another_device_saves(&setup.key, &note_id, "ours\n", "theirs\n");

    let mount = shared(mount);
    sync::tick(&mount);

    let mut guard = serblenotes_fuse::fs::lock(&mount);
    assert_eq!(read_file(&mut guard, "Alpha.md").unwrap(), "theirs\n");
}

#[test]
fn a_fork_is_merged_rather_than_letting_one_device_win() {
    let (mut mount, setup) = a_mount();
    let ino = write_file(&mut mount, "Alpha.md", "a\nb\nc\n").unwrap();
    let note_id = mount.store.note_at("Alpha").unwrap();
    let base = mount.store.head_of(&note_id).unwrap();

    // Both devices edit the same note from the same starting point, in different places.
    mount.resize(ino, 0).unwrap();
    mount.write_at(ino, 0, b"A\nb\nc\n").unwrap();

    setup.server.another_device_saves_onto(
        &setup.key,
        &note_id,
        Some(&base),
        "a\nb\nc\n",
        "a\nb\nC\n",
    );

    let mount = shared(mount);
    sync::tick(&mount);

    let mut guard = serblenotes_fuse::fs::lock(&mount);
    assert_eq!(
        read_file(&mut guard, "Alpha.md").unwrap(),
        "A\nb\nC\n",
        "neither device's edit may be thrown away"
    );
    assert_eq!(guard.unsent_count(), 0, "and the merge is sent on");
    assert_eq!(guard.store.read_note(&note_id).unwrap(), "A\nb\nC\n");
}

#[test]
fn a_fork_this_device_had_already_saved_is_still_a_fork() {
    let (mut mount, setup) = a_mount();
    let ino = write_file(&mut mount, "Alpha.md", "a\nb\nc\n").unwrap();
    let note_id = mount.store.note_at("Alpha").unwrap();
    let base = mount.store.head_of(&note_id).unwrap();

    // Saved, so there is nothing unsent - which is exactly the case where treating "nothing unsent"
    // as permission to adopt the other head silently drops this device's work.
    mount.resize(ino, 0).unwrap();
    mount.write_at(ino, 0, b"A\nb\nc\n").unwrap();
    mount.commit(ino).unwrap();

    setup.server.another_device_saves_onto(
        &setup.key,
        &note_id,
        Some(&base),
        "a\nb\nc\n",
        "a\nb\nC\n",
    );

    let mount = shared(mount);
    sync::tick(&mount);

    let mut guard = serblenotes_fuse::fs::lock(&mount);
    assert_eq!(read_file(&mut guard, "Alpha.md").unwrap(), "A\nb\nC\n");
}

#[test]
fn an_unmergeable_edit_becomes_conflict_markers_rather_than_a_silent_winner() {
    let (mut mount, setup) = a_mount();
    let ino = write_file(&mut mount, "Alpha.md", "shopping list\n").unwrap();
    let note_id = mount.store.note_at("Alpha").unwrap();
    let base = mount.store.head_of(&note_id).unwrap();

    mount.resize(ino, 0).unwrap();
    mount.write_at(ino, 0, b"shopping list for tuesday\n").unwrap();

    setup.server.another_device_saves_onto(
        &setup.key,
        &note_id,
        Some(&base),
        "shopping list\n",
        "shopping list for wednesday\n",
    );

    let mount = shared(mount);
    sync::tick(&mount);

    let mut guard = serblenotes_fuse::fs::lock(&mount);
    let text = read_file(&mut guard, "Alpha.md").unwrap();
    assert!(text.contains("<<<<<<<"), "the user resolves it in their own editor");
    assert!(text.contains("tuesday") && text.contains("wednesday"));
}

#[test]
fn edits_carried_over_from_a_previous_mount_are_merged_before_they_are_sent() {
    let (mut mount, setup) = a_mount();
    let ino = write_file(&mut mount, "Alpha.md", "a\nb\nc\n").unwrap();
    let note_id = mount.store.note_at("Alpha").unwrap();
    let base = mount.store.head_of(&note_id).unwrap();

    // This mount goes away holding an edit it could not send.
    setup.server.go_offline();
    mount.resize(ino, 0).unwrap();
    mount.write_at(ino, 0, b"A\nb\nc\n").unwrap();
    mount.commit(ino).unwrap();
    drop(mount);

    // Meanwhile the other device edits the same note from the same place.
    setup.server.come_back();
    setup.server.another_device_saves_onto(
        &setup.key,
        &note_id,
        Some(&base),
        "a\nb\nc\n",
        "a\nb\nC\n",
    );

    // A new mount over the same vault, which reads the same cache.
    let (mut fresh, _) = a_mount();
    let fresh_store = serblenotes_fuse::store::VaultStore::new(
        &setup.vault_id,
        &setup.key,
        Box::new(setup.server.clone()),
    );
    fresh.store = fresh_store;
    fresh.store.hydrate();

    let fresh = shared(fresh);
    assert_eq!(sync::restore_unsent(&fresh), 1);
    sync::tick(&fresh);

    let mut guard = serblenotes_fuse::fs::lock(&fresh);
    assert_eq!(
        guard.store.read_note(&note_id).unwrap(),
        "A\nb\nC\n",
        "a restored edit must not be diffed straight onto a head it never saw"
    );
}

// --- names the user chose to leave alone --------------------------------------------------------

#[test]
fn an_ignored_name_lives_in_the_mount_and_never_becomes_a_note() {
    let (mut mount, setup) = support::a_mount_ignoring(&["*.bak", "Drafts/*"]);

    write_file(&mut mount, "Notes.md.bak", "a plugin wrote this\n").unwrap();
    write_file(&mut mount, "Drafts/Half.md", "not ready\n").unwrap();
    write_file(&mut mount, "Real.md", "a note\n").unwrap();

    assert_eq!(setup.server.note_ids().len(), 1);
    assert_eq!(mount.store.paths(), vec!["Real".to_string()]);

    // Still there to read and to delete, for as long as the mount is.
    assert_eq!(read_file(&mut mount, "Notes.md.bak").unwrap(), "a plugin wrote this\n");
    assert_eq!(read_file(&mut mount, "Drafts/Half.md").unwrap(), "not ready\n");
    assert_eq!(mount.unsent_count(), 0, "nothing is waiting to be sent for them");
}

#[test]
fn an_ignored_name_is_treated_as_an_editors_own_file_by_a_rename() {
    let (mut mount, setup) = support::a_mount_ignoring(&["*.bak"]);
    write_file(&mut mount, "Things.md", "first\n").unwrap();
    let note_id = mount.store.note_at("Things").unwrap();

    // The same backup dance, under a name only this mount knows about.
    mount.rename_path("Things.md", "Things.md.bak", false).unwrap();

    assert_eq!(mount.store.note_at("Things"), Some(note_id.clone()));
    assert!(!setup.server.note(&note_id).unwrap().deleted);
    assert_eq!(read_file(&mut mount, "Things.md.bak").unwrap(), "first\n");
}

#[test]
fn ignoring_something_does_not_hide_a_note_that_is_already_there() {
    // The pattern decides what a *file* is, not what the vault holds. A note that matches one is
    // still in the vault and still has to be visible, or the mount would look like somewhere the
    // note had been deleted from.
    let (mut mount, _setup) = a_mount();
    write_file(&mut mount, "Keep.md", "a note\n").unwrap();

    let (mut ignoring, setup) = support::a_mount_ignoring(&["Keep.md"]);
    write_file(&mut ignoring, "Other.md", "another\n").unwrap();
    assert_eq!(setup.server.note_ids().len(), 1, "the ignored name made no note");
}

#[test]
fn removing_a_folder_leaves_the_ones_it_was_inside() {
    let (mut mount, _setup) = a_mount();

    // `mkdir -p a/b/c`, then take it apart from the inside out. A folder exists only because
    // something derives it, so removing the deepest one used to take its parents with it and the
    // next `rmdir` failed on a folder that had silently stopped existing.
    mount.mkdir_at("a").unwrap();
    mount.mkdir_at("a/b").unwrap();
    mount.mkdir_at("a/b/c").unwrap();

    mount.rmdir_at("a/b/c").unwrap();
    assert!(mount.at("a/b").is_some(), "a/b was still there a moment ago");
    assert!(mount.at("a").is_some());

    mount.rmdir_at("a/b").unwrap();
    assert!(mount.at("a").is_some());

    mount.rmdir_at("a").unwrap();
    assert!(mount.at("a").is_none());
}

#[test]
fn removing_a_folder_that_a_note_gave_a_parent_leaves_that_parent() {
    let (mut mount, _setup) = a_mount();
    write_file(&mut mount, "Work/Note.md", "a\n").unwrap();
    mount.mkdir_at("Work/Ideas").unwrap();

    mount.rmdir_at("Work/Ideas").unwrap();

    assert!(mount.at("Work").is_some(), "Work still holds a note");
    assert_eq!(read_file(&mut mount, "Work/Note.md").unwrap(), "a\n");
}

// --- what a close does, and what it reports ------------------------------------------------------

#[test]
fn closing_an_existing_note_after_writing_to_it_saves_it() {
    // The other half of the flush rule. `flushed` looks up whether anything was written, and for an
    // existing note that lookup is a different branch from the one a brand-new file takes.
    let (mut mount, setup) = a_mount();
    let ino = write_file(&mut mount, "Alpha.md", "first\n").unwrap();
    let note_id = mount.store.note_at("Alpha").unwrap();

    mount.resize(ino, 0).unwrap();
    mount.write_at(ino, 0, b"second\n").unwrap();
    mount.flushed(ino).unwrap();

    assert_eq!(setup.server.version_count(&note_id), 2);
    assert_eq!(read_file(&mut mount, "Alpha.md").unwrap(), "second\n");
}

#[test]
fn closing_a_note_nothing_was_written_to_saves_nothing() {
    let (mut mount, setup) = a_mount();
    let ino = write_file(&mut mount, "Alpha.md", "first\n").unwrap();
    let note_id = mount.store.note_at("Alpha").unwrap();

    // Opened and closed, which is what reading it looks like from here.
    mount.flushed(ino).unwrap();
    mount.flushed(ino).unwrap();

    assert_eq!(setup.server.version_count(&note_id), 1, "reading a note is not editing it");
}

#[test]
fn a_save_the_server_refuses_is_reported_and_not_swallowed() {
    // The one that must never be read as "offline, keep it and retry": a storage limit does not
    // fix itself by waiting, and an editor told the save worked will close the buffer.
    let (mut mount, setup) = a_mount();
    let ino = write_file(&mut mount, "Alpha.md", "first\n").unwrap();
    let note_id = mount.store.note_at("Alpha").unwrap();

    setup.server.refuse_next(403, "You have reached your storage limit.");
    mount.write_at(ino, 0, b"second").unwrap();

    assert_eq!(
        mount.commit(ino).unwrap_err(),
        Errno::EIO,
        "a refusal has to reach the program that asked for the write"
    );
    assert_eq!(setup.server.version_count(&note_id), 1);
    // And the text is kept, so nothing is lost while the user reads the reason.
    assert_eq!(read_file(&mut mount, "Alpha.md").unwrap(), "second");
}

#[test]
fn a_new_note_the_server_refuses_is_reported_and_not_swallowed() {
    let (mut mount, setup) = a_mount();
    let ino = mount.create_at("Alpha.md").unwrap();
    mount.write_at(ino, 0, b"first\n").unwrap();

    setup.server.refuse_next(403, "You have reached the limit of 1000 notes.");

    assert_eq!(mount.commit(ino).unwrap_err(), Errno::EIO);
    assert!(setup.server.note_ids().is_empty());
    assert_eq!(read_file(&mut mount, "Alpha.md").unwrap(), "first\n", "the text is still here");
}

#[test]
fn a_save_that_could_not_reach_the_server_is_not_reported_as_a_failure() {
    let (mut mount, setup) = a_mount();
    let ino = write_file(&mut mount, "Alpha.md", "first\n").unwrap();

    setup.server.go_offline();
    mount.write_at(ino, 0, b"second").unwrap();

    assert!(
        mount.commit(ino).is_ok(),
        "the bytes are safe on this device and will go out - telling the editor the save failed \
         would be wrong, and on a train it would be wrong constantly"
    );
    assert_eq!(mount.unsent_count(), 1);
}

#[test]
fn what_is_waiting_to_be_sent_is_counted_exactly() {
    let (mut mount, setup) = a_mount();
    let alpha = write_file(&mut mount, "Alpha.md", "a\n").unwrap();
    write_file(&mut mount, "Beta.md", "b\n").unwrap();
    assert_eq!(mount.unsent_count(), 0, "both of those saved");

    setup.server.go_offline();

    mount.write_at(alpha, 0, b"A").unwrap();
    mount.commit(alpha).unwrap();
    assert_eq!(mount.unsent_count(), 1);

    let fresh = mount.create_at("Gamma.md").unwrap();
    mount.write_at(fresh, 0, b"g\n").unwrap();
    mount.commit(fresh).unwrap();
    assert_eq!(mount.unsent_count(), 2, "an edit and a note that does not exist yet");

    // An editor's own file is not waiting for anything.
    let scratch = mount.create_at(".Alpha.md.swp").unwrap();
    mount.write_at(scratch, 0, b"swap").unwrap();
    assert_eq!(mount.unsent_count(), 2);
}

// --- names a filesystem cannot hold ----------------------------------------------------------------

#[test]
fn a_note_whose_name_is_too_long_to_be_a_filename_is_left_out_rather_than_shortened() {
    let (mut mount, setup) = a_mount();
    write_file(&mut mount, "Fine.md", "a\n").unwrap();

    // 255 bytes is what a directory entry can hold, everywhere this will ever sit. A note made in
    // the app can be longer; shortening it here would put two notes at one name.
    let long = "x".repeat(300);
    let mut other = another_device(&setup.server, &setup.key, &setup.vault_id);
    other.pull().unwrap();
    other.create_note(&long, "too long\n").unwrap();

    mount.store.pull().unwrap();

    let listed = listing(&mut mount, "");
    assert_eq!(listed, vec!["Fine.md".to_string()]);
    assert!(mount.store.paths().iter().any(|p| p.len() == 300), "the note is still in the vault");
}

#[test]
fn a_name_that_just_fits_is_shown() {
    let (mut mount, setup) = a_mount();

    // 252 characters plus `.md` is exactly 255.
    let name = "x".repeat(252);
    let mut other = another_device(&setup.server, &setup.key, &setup.vault_id);
    other.pull().unwrap();
    other.create_note(&name, "just fits\n").unwrap();
    mount.store.pull().unwrap();

    assert_eq!(listing(&mut mount, ""), vec![format!("{name}.md")]);
}

// --- the sync loop's own decisions -----------------------------------------------------------------

#[test]
fn warming_fetches_every_note_once_and_leaves_them_readable_offline() {
    let (mut mount, setup) = a_mount();
    for i in 0..5 {
        write_file(&mut mount, &format!("Note{i}.md"), &format!("body {i}\n")).unwrap();
    }

    // A second machine, which has only ever seen the metadata.
    let cold = another_device(&setup.server, &setup.key, &setup.vault_id);
    let mut cold = serblenotes_fuse::fs::Mount::new(cold, false, Default::default());
    cold.store.pull().unwrap();
    assert!(
        cold.store.note_ids().iter().any(|id| !cold.store.is_readable(id)),
        "nothing should be readable before warming"
    );

    let cold = shared(cold);
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let warming = sync::spawn(std::sync::Arc::clone(&cold), std::time::Duration::from_secs(3600), std::sync::Arc::clone(&stop));
    for _ in 0..200 {
        std::thread::sleep(std::time::Duration::from_millis(25));
        // One lock, not one per note: taking it again while still holding it deadlocks this
        // thread against itself, which is a mistake worth only making once.
        let ready = {
            let guard = serblenotes_fuse::fs::lock(&cold);
            let ids = guard.store.note_ids();
            ids.iter().all(|id| guard.store.is_readable(id))
        };
        if ready {
            break;
        }
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = warming.join();

    let mut guard = serblenotes_fuse::fs::lock(&cold);
    setup.server.go_offline();
    for id in guard.store.note_ids() {
        assert!(guard.store.is_readable(&id), "warming is what makes a mount work on a train");
        assert!(guard.store.read_note(&id).is_ok());
    }
}

#[test]
fn an_edit_carried_over_for_a_note_that_is_gone_comes_back_as_a_file() {
    // The note was deleted elsewhere, or this cache is simply older than the edit. Either way the
    // text is the only copy there is, so it must not be dropped on the floor.
    let (mut mount, setup) = a_mount();

    setup.server.go_offline();
    let ino = mount.create_at("Rescued.md").unwrap();
    mount.write_at(ino, 0, b"written with no server\n").unwrap();
    mount.commit(ino).unwrap();
    assert_eq!(mount.unsent_count(), 1);
    drop(mount);

    // A fresh mount over the same vault reads the same unsent list.
    let store = another_device(&setup.server, &setup.key, &setup.vault_id);
    let fresh = shared(serblenotes_fuse::fs::Mount::new(store, false, Default::default()));

    assert_eq!(sync::restore_unsent(&fresh), 1);

    let mut guard = serblenotes_fuse::fs::lock(&fresh);
    assert_eq!(read_file(&mut guard, "Rescued.md").unwrap(), "written with no server\n");
    assert_eq!(guard.unsent_count(), 1, "still waiting to be sent");
}

#[test]
fn a_tick_that_cannot_reach_the_server_leaves_everything_where_it_was() {
    let (mut mount, setup) = a_mount();
    write_file(&mut mount, "Alpha.md", "a\n").unwrap();
    let note_id = mount.store.note_at("Alpha").unwrap();

    let mount = shared(mount);
    setup.server.go_offline();
    sync::tick(&mount);

    let mut guard = serblenotes_fuse::fs::lock(&mount);
    assert_eq!(read_file(&mut guard, "Alpha.md").unwrap(), "a\n");
    assert_eq!(setup.server.version_count(&note_id), 1);
}

#[test]
fn a_local_file_is_listed_under_its_own_name_and_not_another_files() {
    // The listing looks each local file up by path to find its inode. Handing back the wrong one
    // means two names in a directory pointing at the same bytes.
    let (mut mount, _setup) = a_mount();
    let first = mount.create_at("4913").unwrap();
    mount.write_at(first, 0, b"first\n").unwrap();
    let second = mount.create_at("5036").unwrap();
    mount.write_at(second, 0, b"second\n").unwrap();

    let listed: Vec<(u64, String)> = mount
        .children("")
        .into_iter()
        .map(|(ino, _, name)| (ino, name))
        .collect();

    assert_eq!(listed.len(), 2);
    for (ino, name) in listed {
        let want = if name == "4913" { "first\n" } else { "second\n" };
        assert_eq!(
            String::from_utf8(mount.bytes_of(ino).unwrap()).unwrap(),
            want,
            "{name} was listed with the wrong inode"
        );
    }
}

#[test]
fn an_edit_carried_over_for_a_note_that_no_longer_exists_is_not_replayed_onto_nothing() {
    // The note was deleted elsewhere while this machine was away. The edit cannot be appended to
    // it, so it has to come back as a file rather than as a buffer for a note that is not there.
    let (mut mount, setup) = a_mount();
    let ino = write_file(&mut mount, "Doomed.md", "first\n").unwrap();
    let note_id = mount.store.note_at("Doomed").unwrap();

    setup.server.go_offline();
    mount.write_at(ino, 0, b"edited while away\n").unwrap();
    mount.commit(ino).unwrap();
    assert_eq!(mount.unsent_count(), 1);
    drop(mount);

    // Meanwhile the note goes away, and this machine's next mount starts from a cache that has
    // never heard of the deletion being relevant to the edit it is holding.
    setup.server.come_back();
    let mut other = another_device(&setup.server, &setup.key, &setup.vault_id);
    other.pull().unwrap();
    other.delete_note(&note_id).unwrap();

    let store = another_device(&setup.server, &setup.key, &setup.vault_id);
    let fresh = shared(serblenotes_fuse::fs::Mount::new(store, false, Default::default()));
    {
        let mut guard = serblenotes_fuse::fs::lock(&fresh);
        guard.store.hydrate();
        guard.store.pull().unwrap();
    }

    assert_eq!(sync::restore_unsent(&fresh), 1);

    let mut guard = serblenotes_fuse::fs::lock(&fresh);
    assert_eq!(
        read_file(&mut guard, "Doomed.md").unwrap(),
        "edited while away\n",
        "the text was the only copy there was"
    );
}

#[test]
fn an_edit_whose_note_moved_under_it_is_merged_before_it_is_sent() {
    // The dangerous one. `send_unsent` reconciles only when the buffer's baseline is behind the
    // note's head; getting that test backwards means a restored edit is diffed straight onto a
    // head it never saw, and the other device's work disappears.
    let (mut mount, setup) = a_mount();
    let ino = write_file(&mut mount, "Alpha.md", "a\nb\nc\n").unwrap();
    let note_id = mount.store.note_at("Alpha").unwrap();
    let base = mount.store.head_of(&note_id).unwrap();

    setup.server.go_offline();
    mount.resize(ino, 0).unwrap();
    mount.write_at(ino, 0, b"A\nb\nc\n").unwrap();
    mount.commit(ino).unwrap();

    setup.server.come_back();
    setup.server.another_device_saves_onto(&setup.key, &note_id, Some(&base), "a\nb\nc\n", "a\nb\nC\n");

    let mount = shared(mount);
    sync::tick(&mount);

    let mut guard = serblenotes_fuse::fs::lock(&mount);
    assert_eq!(
        guard.store.read_note(&note_id).unwrap(),
        "A\nb\nC\n",
        "both devices' edits have to survive"
    );
    assert_eq!(guard.unsent_count(), 0);
}

#[test]
fn an_edit_stale_against_a_head_this_device_already_knew_is_still_merged() {
    // The case `reconcile`-on-pull does not cover. If the newer version arrived on an earlier pull,
    // a later tick reports nothing moved - so the only thing standing between a restored edit and
    // being diffed straight onto a head it never saw is `send_unsent`'s own staleness check.
    let (mut mount, setup) = a_mount();
    write_file(&mut mount, "Alpha.md", "a\nb\nc\n").unwrap();
    let note_id = mount.store.note_at("Alpha").unwrap();
    let base = mount.store.head_of(&note_id).unwrap();

    // Another device forks from the same parent, and this device learns about it by pulling -
    // without anything reconciling the buffer, because there is no buffer yet.
    setup.server.another_device_saves_onto(&setup.key, &note_id, Some(&base), "a\nb\nc\n", "a\nb\nC\n");
    mount.store.pull().unwrap();
    assert_ne!(mount.store.head_of(&note_id).as_deref(), Some(base.as_str()));

    // Now an edit appears that was made against the older version.
    mount.open_notes.insert(
        note_id.clone(),
        serblenotes_fuse::fs::OpenNote {
            data: b"A\nb\nc\n".to_vec(),
            dirty: true,
            written: true,
            baseline: Some(base),
            merge_parent: None,
        },
    );

    let mount = shared(mount);
    sync::tick(&mount);

    let mut guard = serblenotes_fuse::fs::lock(&mount);
    assert_eq!(
        guard.store.read_note(&note_id).unwrap(),
        "A\nb\nC\n",
        "the other device's edit must not be overwritten by one that never saw it"
    );
}

#[test]
fn the_sync_loop_keeps_polling_for_as_long_as_it_is_running() {
    // The loop itself, rather than one pass of it. A condition inverted here is a mount that comes
    // up, reads the vault once, and then quietly never notices anything again.
    let (mut mount, setup) = a_mount();
    write_file(&mut mount, "Alpha.md", "before\n").unwrap();
    let note_id = mount.store.note_at("Alpha").unwrap();

    let mount = shared(mount);
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let syncing = sync::spawn(
        std::sync::Arc::clone(&mount),
        std::time::Duration::from_millis(200),
        std::sync::Arc::clone(&stop),
    );

    // Made after the loop started, so only a later pass can find it.
    std::thread::sleep(std::time::Duration::from_millis(300));
    setup.server.another_device_saves(&setup.key, &note_id, "before\n", "after\n");

    let mut seen = false;
    for _ in 0..100 {
        std::thread::sleep(std::time::Duration::from_millis(50));
        let mut guard = serblenotes_fuse::fs::lock(&mount);
        if read_file(&mut guard, "Alpha.md").as_deref() == Some("after\n") {
            seen = true;
            break;
        }
    }

    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = syncing.join();
    assert!(seen, "a change made after the mount came up was never noticed");
}
