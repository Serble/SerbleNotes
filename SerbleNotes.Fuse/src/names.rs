//! What a file in the mount is called, and whether it is a note at all.
//!
//! A vault is a folder of markdown files - the same layout export writes and import reads - so the
//! mapping between a note name and a file name is `archive_path` and `note_name_from_archive_path`
//! from the core, and not a second copy of the rule living here. If the archive and the filesystem
//! disagreed about where a note lives, the same vault would unzip into a different shape from the
//! one it mounts as.
//!
//! Two things are decided here that an archive never has to decide, because an archive is read once
//! and a filesystem is written to by whatever the user has open.

use glob::{MatchOptions, Pattern};
use serblenotes_core::{archive_path, file_name, note_name_from_archive_path};

/// The note name a file in the mount is asking to be.
///
/// The extra condition over the archive importer is that the mapping must come back to the same
/// file name. The importer is one-way: it takes `notes.txt` and cheerfully makes a note called
/// `notes.txt`, because dropping someone's file on the floor is worse than an odd name. Here that
/// note would immediately draw as `notes.txt.md`, because that is what `archive_path` makes of it -
/// so the file the user just created would rename itself underneath them, and the editor that
/// created it would be holding a path that no longer exists.
///
/// So a file in the mount has to be a fixed point of the mapping, which in practice means it ends
/// in a lowercase `.md`. That is the same class of refusal as `normalise_path` rejecting `..` and
/// `VaultStore.refuseIfTaken` rejecting a path already in use: not a judgement about what the user
/// should want, but about what can be represented. The caller says so in as many words rather than
/// letting `touch` print "Invalid argument" on its own.
pub fn note_name_for(path: &str) -> Result<String, String> {
    let name = note_name_from_archive_path(path)?;

    let round_trip = archive_path(&name)?;
    if round_trip != path {
        return Err(format!(
            "A note is a markdown file, so \"{path}\" would have to be stored as \"{round_trip}\" \
             and would not keep the name it was given. Name it with a .md extension."
        ));
    }

    Ok(name)
}

/// Where a note shows up in the mount.
pub fn file_path_for(note_name: &str) -> Result<String, String> {
    archive_path(note_name)
}

/// Whether a file in the mount is a note.
///
/// This is the whole rule, and it decides the only thing that matters: whether closing this file
/// puts something in the user's vault. A vault holds notes, a note is a markdown file, so a file
/// that is not one is a file that lives in this mount and nowhere else.
///
/// Drawing the line here rather than refusing the create is what makes ordinary tools work. Saving
/// a file is rarely a write to it: `sed -i` writes `sedA1B2C3` beside it and renames it over the
/// top, GNOME writes `.goutputstream-A1B2C3`, vim writes `4913` to find out whether it can create
/// files here at all. None of those names is predictable, all of them arrive here as a create, and
/// a filesystem that refused them would refuse `sed -i` - on a product whose entire point is that
/// you can use the editor you already have.
///
/// It is also what keeps a vault from filling up with swap files. Renaming one of these onto a
/// note's name is what commits it, which is exactly the move the atomic-save dance is making.
pub fn is_note_file(path: &str) -> bool {
    // Emacs's lock file for `Alpha.md` is `.#Alpha.md`, which would otherwise round-trip perfectly
    // well and become a note called `.#Alpha`.
    if file_name(path).starts_with(".#") {
        return false;
    }

    note_name_for(path).is_ok()
}

/// Whether a file that is not a note looks like an editor made it, rather than like something the
/// user brought in and expects to keep.
///
/// Nothing depends on this being right - both kinds live in the mount and go no further. It decides
/// only whether to say anything: a `4913` that the user never sees appear or disappear does not
/// need explaining, while a `report.txt` copied in does, because otherwise it looks saved and is
/// not. That is the accident the user cannot perceive, which is the one case worth speaking up in.
pub fn is_editor_scratch(file_name: &str) -> bool {
    if file_name.starts_with('.') || file_name.starts_with('#') {
        return true;
    }

    // Vim's probe file, which it names with a number and then removes. It tries 4913 first and
    // counts up by 123 until one is free, so the name is not a constant to match against.
    if !file_name.is_empty() && file_name.bytes().all(|byte| byte.is_ascii_digit()) {
        return true;
    }

    if file_name.ends_with('~') {
        return true;
    }

    let lower = file_name.to_ascii_lowercase();
    lower.ends_with(".tmp")
        || lower.ends_with(".swp")
        || lower.ends_with(".swx")
        || lower.ends_with(".part")
        || lower.ends_with(".crdownload")
        // The temporary an in-place edit writes beside the file it is rewriting.
        || lower.starts_with("sed")
        || lower.starts_with("tmp")
        || lower == "thumbs.db"
}

/// Names the user has said are not theirs to keep.
///
/// The built-in list covers the editors whose working files are a known shape, and it can only ever
/// be a list of the ones somebody thought of. A plugin that writes `notes.md.bak`, a sync tool
/// leaving `.partial` files, a directory of drafts that should stay on this machine - none of those
/// are guessable, and all of them are one pattern.
///
/// A pattern with no `/` is matched against the file's own name, wherever it is; one with a `/` is
/// matched against the whole path from the root of the mount, and `*` stops at a `/` the way it
/// does in a `.gitignore`. Anything matching is treated exactly as an editor's own file: it lives
/// in the mount, it is never sent anywhere, and nothing is said about it.
#[derive(Default, Clone)]
pub struct Ignore {
    /// The pattern, and whether it is about the whole path rather than the name.
    patterns: Vec<(Pattern, bool)>,
}

impl Ignore {
    /// Compiles the patterns, or says which one could not be read and why.
    ///
    /// Checked up front rather than per file: a pattern that silently never matches is a flag the
    /// user believes is working, and they would find out by finding a note they did not want.
    pub fn new(patterns: &[String]) -> Result<Ignore, String> {
        let mut compiled = Vec::new();

        for pattern in patterns {
            let about_path = pattern.contains('/');
            let parsed = Pattern::new(pattern)
                .map_err(|e| format!("--ignore {pattern:?} is not a pattern this understands: {e}"))?;
            compiled.push((parsed, about_path));
        }

        Ok(Ignore { patterns: compiled })
    }

    /// Whether a path in the mount is one to leave alone.
    pub fn matches(&self, path: &str) -> bool {
        let leaf = file_name(path);

        self.patterns.iter().any(|(pattern, about_path)| {
            if *about_path {
                pattern.matches_with(path, PATH_OPTIONS)
            } else {
                pattern.matches(&leaf)
            }
        })
    }
}

/// `*` stops at a `/`, as it does in a `.gitignore`: `Drafts/*` is the files in `Drafts`, not
/// everything underneath it. `Drafts/**` is everything underneath it.
const PATH_OPTIONS: MatchOptions = MatchOptions {
    case_sensitive: true,
    require_literal_separator: true,
    require_literal_leading_dot: false,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_markdown_file_is_the_note_it_names() {
        assert_eq!(note_name_for("Work/Alpha.md").unwrap(), "Work/Alpha");
        assert_eq!(note_name_for("Alpha.md").unwrap(), "Alpha");
    }

    #[test]
    fn a_note_called_todo_md_is_the_file_todo_md_md() {
        // The archive's rule, and the reason it is the archive's rule: this is the only mapping
        // under which `todo` and `todo.md` can both come back as what they were.
        assert_eq!(file_path_for("todo.md").unwrap(), "todo.md.md");
        assert_eq!(note_name_for("todo.md.md").unwrap(), "todo.md");
    }

    #[test]
    fn a_name_that_would_not_keep_itself_is_not_a_note() {
        // `notes.txt` would import as a note called `notes.txt`, which draws as `notes.txt.md` - so
        // the file would rename itself underneath whatever created it.
        assert!(note_name_for("notes.txt").is_err());
        assert!(!is_note_file("notes.txt"));
        assert!(!is_note_file("README"));
        // Upper case for the same reason: archive_path only ever writes lowercase.
        assert!(!is_note_file("Alpha.MD"));
    }

    #[test]
    fn a_name_no_note_could_have_is_not_a_note() {
        assert!(!is_note_file("../escape.md"));
        assert!(!is_note_file("   .md"));
    }

    #[test]
    fn the_files_editors_make_for_themselves_are_not_notes() {
        for name in [
            ".Alpha.md.swp",
            ".#Alpha.md",
            "#Alpha.md#",
            "Alpha.md~",
            "4913",
            "5036",
            ".goutputstream-A1B2C3",
            ".DS_Store",
            "Thumbs.db",
            "download.part",
            "sedA1B2C3",
        ] {
            assert!(!is_note_file(name), "{name} must never become a note");
        }
    }

    #[test]
    fn nothing_is_said_about_a_file_the_user_never_sees() {
        for name in [
            // Caught by the leading dot or hash.
            ".Alpha.md.swp",
            ".#Alpha.md",
            "#Alpha.md#",
            ".goutputstream-A1B2C3",
            // By the trailing tilde, and by being all digits.
            "Alpha.md~",
            "4913",
            // And these reach the list of extensions at the end, which nothing else covers.
            "notes.tmp",
            "Session.swp",
            "Session.swx",
            "download.part",
            "video.crdownload",
            "sedA1B2C3",
            "tmpXK29fa",
            "thumbs.db",
        ] {
            assert!(is_editor_scratch(name), "{name} needs no explaining");
        }
    }

    #[test]
    fn a_file_the_user_named_reaches_the_end_of_the_list_and_is_worth_a_word() {
        // Each of these gets past every arm, which is what makes the arms above meaningful.
        for name in ["report.txt", "photo.jpeg", "data.csv", "Makefile", "notes.markdown"] {
            assert!(!is_editor_scratch(name), "{name} is the user's own");
        }
    }

    #[test]
    fn a_file_the_user_brought_in_is_worth_a_word() {
        // Not a note, and not something an editor made either - so it looks saved and is not.
        assert!(!is_note_file("report.txt"));
        assert!(!is_editor_scratch("report.txt"));
    }

    #[test]
    fn a_pattern_with_no_slash_is_about_the_name_wherever_it_is() {
        let ignore = Ignore::new(&["*.bak".to_string()]).unwrap();
        assert!(ignore.matches("notes.md.bak"));
        assert!(ignore.matches("Work/Projects/notes.md.bak"));
        assert!(!ignore.matches("notes.md"));
    }

    #[test]
    fn a_pattern_with_a_slash_is_about_the_whole_path() {
        let ignore = Ignore::new(&["Drafts/*".to_string()]).unwrap();
        assert!(ignore.matches("Drafts/one.md"));
        assert!(!ignore.matches("Work/Drafts/one.md"), "it is anchored at the root of the mount");
        assert!(
            !ignore.matches("Drafts/Deep/one.md"),
            "* stops at a slash, as it does in a .gitignore"
        );

        let deep = Ignore::new(&["Drafts/**".to_string()]).unwrap();
        assert!(deep.matches("Drafts/Deep/one.md"));
    }

    #[test]
    fn nothing_ignored_means_nothing_ignored() {
        assert!(!Ignore::default().matches("anything.md"));
        assert!(!Ignore::default().matches("Deep/inside/anything.md"));
    }

    #[test]
    fn a_pattern_that_cannot_be_read_is_reported_rather_than_silently_never_matching() {
        // A flag the user believes is working, that never matches, is found out by finding a note
        // they did not want.
        assert!(Ignore::new(&["[unclosed".to_string()]).is_err());
    }

    #[test]
    fn a_note_is_not_mistaken_for_a_scratch_file() {
        for name in ["Alpha.md", ".hidden.md", "2026.md", "notes.md", "Work/Alpha.md"] {
            assert!(is_note_file(name), "{name} is a note");
        }
    }
}