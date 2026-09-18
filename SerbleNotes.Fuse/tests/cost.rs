//! What a vault costs to open and to list.
//!
//! Opening a vault does not download it, and neither does opening a note - that is a property of
//! the whole product, measured on a 196-note vault, and it is the sort of thing that stops being
//! true by accident. So this asserts what the server is *asked for*, rather than how long anything
//! takes: a timing assertion on a build machine is a test that fails for reasons nobody can act on.

mod support;

use support::{a_mount, another_device, listing, read_file, write_file, Setup};
use serblenotes_fuse::fs::Mount;
use serblenotes_fuse::store::VaultStore;

const NOTES: usize = 300;
const FOLDERS: usize = 12;

fn a_full_vault() -> (Mount, Setup) {
    let (mut mount, setup) = a_mount();
    for i in 0..NOTES {
        let folder = i % FOLDERS;
        write_file(&mut mount, &format!("Folder{folder}/Note{i}.md"), &format!("note {i}\n")).unwrap();
    }
    (mount, setup)
}

/// A second mount over the same vault, with nothing cached: what a fresh machine sees.
fn a_cold_mount(setup: &Setup) -> Mount {
    let store: VaultStore = another_device(&setup.server, &setup.key, &setup.vault_id);
    Mount::new(store, false, Default::default())
}

#[test]
fn drawing_the_whole_tree_downloads_no_note_bodies() {
    let (_written, setup) = a_full_vault();

    let mut cold = a_cold_mount(&setup);
    cold.store.pull().unwrap();
    let before = setup.server.body_requests();

    let folders = listing(&mut cold, "");
    let mut files = 0;
    for folder in &folders {
        files += listing(&mut cold, folder).len();
    }

    assert_eq!(folders.len(), FOLDERS);
    assert_eq!(files, NOTES);
    assert_eq!(
        setup.server.body_requests(),
        before,
        "the tree is drawn from note names, which the metadata pull already brought"
    );
}

#[test]
fn reading_one_note_downloads_one_note() {
    let (_written, setup) = a_full_vault();

    let mut cold = a_cold_mount(&setup);
    cold.store.pull().unwrap();
    let before = setup.server.body_requests();

    assert_eq!(read_file(&mut cold, "Folder0/Note0.md").unwrap(), "note 0\n");

    assert_eq!(
        setup.server.body_requests() - before,
        1,
        "a note is opened by its chain, not by fetching the vault"
    );
}

#[test]
fn a_listing_that_needs_sizes_fetches_each_note_once_and_then_stops() {
    let (_written, setup) = a_full_vault();

    let mut cold = a_cold_mount(&setup);
    cold.store.pull().unwrap();
    let before = setup.server.body_requests();

    // `ls -l` needs every size, and a size is the length of the plaintext - so this is the one
    // listing that has to rebuild every note. It must not do it twice.
    let sizes = |mount: &mut Mount| {
        let mut total = 0u64;
        for folder in listing(mount, "") {
            for (_, _, name) in mount.children(&folder) {
                let path = format!("{folder}/{name}");
                let entry = mount.at(&path).unwrap();
                total += mount.attr_of(&entry).unwrap().size;
            }
        }
        total
    };

    let first = sizes(&mut cold);
    let after_first = setup.server.body_requests() - before;
    let second = sizes(&mut cold);
    let after_second = setup.server.body_requests() - before;

    assert_eq!(first, second);
    assert_eq!(after_first, NOTES, "one fetch per note, and no more");
    assert_eq!(after_second, after_first, "and nothing at all the second time");
}
