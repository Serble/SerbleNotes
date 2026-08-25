//! Path tests.
//!
//! These decide what the folder tree looks like in the sidebar and, later, what the mounted
//! filesystem looks like. Both read the same functions, so a disagreement here would put the same
//! note in two different places depending on how you opened it.

use serblenotes_core::{
    archive_path, file_name, normalise_path, note_name_from_archive_path, oversized_segments,
    parent_path, reparent, MAX_SEGMENT_BYTES,
};

#[test]
fn a_plain_name_is_left_alone() {
    assert_eq!(normalise_path("Shopping list").unwrap(), "Shopping list");
}

#[test]
fn slashes_make_folders() {
    assert_eq!(normalise_path("Work/Projects/Alpha").unwrap(), "Work/Projects/Alpha");
}

#[test]
fn untidy_input_is_cleaned_up_rather_than_rejected() {
    let cases = [
        ("  Work / Notes  ", "Work/Notes"),
        ("Work//Notes", "Work/Notes"),
        ("/Work/Notes", "Work/Notes"),
        ("Work/Notes/", "Work/Notes"),
        ("///Work///Notes///", "Work/Notes"),
        ("Work /  / Notes", "Work/Notes"),
    ];

    for (input, expected) in cases {
        assert_eq!(normalise_path(input).unwrap(), expected, "cleaning {input:?}");
    }
}

#[test]
fn only_genuinely_impossible_names_are_refused() {
    // The bar for refusing is "cannot be represented", not "looks odd". Everything a filesystem can
    // hold, the user is allowed to type.
    assert!(normalise_path("").is_err(), "empty");
    assert!(normalise_path("   ").is_err(), "whitespace only");
    assert!(normalise_path("///").is_err(), "slashes only");
    assert!(normalise_path("Work/../secrets").is_err(), "parent escape");
    assert!(normalise_path("./Work").is_err(), "current directory");
    assert!(normalise_path("Work/./Notes").is_err(), "embedded current directory");
    assert!(normalise_path("Work\0Notes").is_err(), "null byte");
    assert!(normalise_path("Work\nNotes").is_err(), "line break");
}

#[test]
fn unusual_but_representable_names_are_allowed() {
    // None of these are anyone else's business.
    for name in [
        "a",
        "..hidden",
        "...",
        "note.md",
        "2026-08-21 meeting",
        "emoji in the name",
        "spaces   inside   are   kept",
        "Work/notes (final) (2) FINAL",
        "-",
        "#tag",
    ] {
        assert!(normalise_path(name).is_ok(), "refused a valid name: {name:?}");
    }

    // A dot-segment is only dangerous when it is exactly "." or ".."; "..." is a normal name.
    assert_eq!(normalise_path("...").unwrap(), "...");
    assert_eq!(normalise_path("..hidden").unwrap(), "..hidden");
}

#[test]
fn splitting_a_path_gives_the_folder_and_the_name() {
    assert_eq!(parent_path("Work/Projects/Alpha"), "Work/Projects");
    assert_eq!(file_name("Work/Projects/Alpha"), "Alpha");

    assert_eq!(parent_path("Alpha"), "");
    assert_eq!(file_name("Alpha"), "Alpha");
}

#[test]
fn an_over_long_segment_is_reported_but_not_refused() {
    let long = "x".repeat(MAX_SEGMENT_BYTES + 1);
    let path = format!("Work/{long}");

    assert!(normalise_path(&path).is_ok(), "an over-long name must still save");
    assert_eq!(oversized_segments(&path), vec![long.clone()]);
    assert!(oversized_segments("Work/Notes").is_empty());
}

#[test]
fn a_segment_at_exactly_the_limit_is_fine() {
    let limit = "x".repeat(MAX_SEGMENT_BYTES);
    assert!(oversized_segments(&limit).is_empty());
}

#[test]
fn renaming_a_folder_moves_the_notes_inside_it() {
    assert_eq!(reparent("Work/Alpha", "Work", "Archive").unwrap(), "Archive/Alpha");
    assert_eq!(reparent("Work/Alpha", "Work", "").unwrap(), "Alpha");
    assert_eq!(reparent("Alpha", "", "Work").unwrap(), "Work/Alpha");
}

#[test]
fn renaming_a_folder_keeps_the_structure_underneath_it() {
    assert_eq!(
        reparent("Work/Projects/Alpha", "Work", "Archive").unwrap(),
        "Archive/Projects/Alpha"
    );
    assert_eq!(
        reparent("Work/Projects/Deep/Alpha", "Work/Projects", "Done").unwrap(),
        "Done/Deep/Alpha"
    );
}

#[test]
fn a_path_survives_a_round_trip_through_its_parts() {
    for path in ["Alpha", "Work/Alpha", "Work/Projects/Alpha", "a/b/c/d/e"] {
        let parent = parent_path(path);
        let name = file_name(path);
        let rebuilt = if parent.is_empty() { name } else { format!("{parent}/{name}") };
        assert_eq!(rebuilt, path, "splitting and rejoining changed {path:?}");
    }
}

// --- the archive layout --------------------------------------------------------------------------
// A note becomes a `.md` file and a folder becomes a directory. Export writes this, import reads it,
// and the filesystem will mount it, so these two functions are the whole agreement between them.

#[test]
fn a_note_becomes_a_markdown_file_in_its_folder() {
    assert_eq!(archive_path("Shopping list").unwrap(), "Shopping list.md");
    assert_eq!(archive_path("Work/Projects/Alpha").unwrap(), "Work/Projects/Alpha.md");
}

#[test]
fn a_name_is_tidied_on_the_way_into_an_archive() {
    assert_eq!(archive_path("  Work //  Notes/ ").unwrap(), "Work/Notes.md");
    assert!(archive_path("   ").is_err());
    assert!(archive_path("Work/../etc/passwd").is_err(), "a note must not escape its folder");
}

#[test]
fn every_note_name_survives_the_round_trip_out_and_back() {
    // The archive is a backup, so this is the property that matters most: what comes back has to be
    // what went in, including the names that look like they would confuse it.
    let names = [
        "Alpha",
        "Work/Projects/Alpha",
        "todo.md",
        "todo.md.md",
        "notes.txt",
        "v1.0/release",
        "Work/v1.0/release.md",
        ".hidden",
        "trailing dot.",
        "a.b.c",
        "MD",
        "recipes/pancakes",
        "Ideas/2026",
        "emoji 🔐 name",
        "combining e\u{301}",
        "right-to-left \u{202e}text",
        "a name with spaces and (brackets)",
        "#hash",
    ];

    for name in names {
        let path = archive_path(name).unwrap_or_else(|e| panic!("{name:?} could not be filed: {e}"));
        let back = note_name_from_archive_path(&path)
            .unwrap_or_else(|e| panic!("{path:?} could not be read back: {e}"));
        assert_eq!(back, name, "{name:?} came back as {back:?}");
    }
}

#[test]
fn two_notes_that_differ_only_by_an_md_suffix_stay_apart() {
    // The reason the extension is appended rather than kept: "todo" and "todo.md" are two notes, and
    // an archive that wrote both as "todo.md" would lose one of them.
    assert_ne!(archive_path("todo").unwrap(), archive_path("todo.md").unwrap());
    assert_eq!(note_name_from_archive_path("todo.md").unwrap(), "todo");
    assert_eq!(note_name_from_archive_path("todo.md.md").unwrap(), "todo.md");
}

#[test]
fn a_file_from_anywhere_else_becomes_a_note() {
    // Someone else's folder of markdown is the other thing import is for, so an archive this app did
    // not write has to read sensibly.
    assert_eq!(note_name_from_archive_path("Alpha.md").unwrap(), "Alpha");
    assert_eq!(note_name_from_archive_path("Work/Alpha.MD").unwrap(), "Work/Alpha");
    assert_eq!(note_name_from_archive_path("Work/Alpha.Md").unwrap(), "Work/Alpha");
    assert_eq!(note_name_from_archive_path("./Work/Alpha.md").is_err(), true, "'.' is refused");

    // Not markdown, and not refused either: the name is kept whole and it imports as a note.
    assert_eq!(note_name_from_archive_path("notes.txt").unwrap(), "notes.txt");
    assert_eq!(note_name_from_archive_path("README").unwrap(), "README");
}

#[test]
fn only_the_files_own_name_can_carry_the_extension() {
    // A folder called "v1.0" has a dot in it, and a file called ".md" has nothing left underneath.
    assert_eq!(note_name_from_archive_path("v1.0/notes").unwrap(), "v1.0/notes");
    assert_eq!(note_name_from_archive_path("a.md/b").unwrap(), "a.md/b");
    assert_eq!(note_name_from_archive_path("notes/.md").unwrap(), "notes/.md");
    assert_eq!(note_name_from_archive_path(".md").unwrap(), ".md");
}

#[test]
fn a_directory_entry_reads_as_the_folder_it_is() {
    // Zip writes a folder as a name ending in a slash. Import asks the same function what it means.
    assert_eq!(note_name_from_archive_path("Work/").unwrap(), "Work");
    assert_eq!(note_name_from_archive_path("Work/Projects/").unwrap(), "Work/Projects");
}

#[test]
fn nothing_in_an_archive_can_point_outside_the_vault() {
    // A zip is a file from somewhere else, and "../../.ssh/authorized_keys" is the oldest trick
    // there is. `normalise_path` refuses it, and every path from an archive goes through it.
    for hostile in [
        "../escape.md",
        "Work/../../escape.md",
        "./escape.md",
        "Work/./escape.md",
        "..",
        "/",
        "",
        "   ",
    ] {
        assert!(
            note_name_from_archive_path(hostile).is_err(),
            "an archive entry escaped the vault: {hostile:?}"
        );
    }
}

#[test]
fn an_absolute_entry_is_taken_as_a_path_inside_the_vault() {
    // Some zip tools write a leading slash. It cannot mean the root of the disk here, and dropping
    // the file would be worse than filing it, so the empty first segment is simply tidied away.
    assert_eq!(note_name_from_archive_path("/Work/Alpha.md").unwrap(), "Work/Alpha");
}

/// `reparent` is asked about a path that is not under the folder being moved.
///
/// Every caller today passes a path whose parent really is `old_parent`, so this is about what
/// happens when that stops being true - a bug elsewhere, or a folder operation racing a rename from
/// another device. The answer has to be a value or an error, never a panic: this crate is compiled
/// to WASM and a panic there poisons the module, so the next thing the user does is not "one note
/// moved oddly" but "the app stopped working until it was reloaded".
#[test]
fn reparent_does_not_panic_on_a_path_outside_the_folder_being_moved() {
    // A top-level note, with a folder named as the one being moved from.
    assert!(reparent("Alpha", "Work", "Archive").is_ok());

    // A note in a sibling folder whose name is shorter than the folder being moved from.
    assert!(reparent("A/Alpha", "Work/Projects", "Archive").is_ok());

    // And one whose name merely starts with the same characters, which is not the same as being
    // inside it - "Working" is not under "Work".
    assert_eq!(reparent("Working/Alpha", "Work", "Archive").unwrap(), "Archive/Alpha");
}
