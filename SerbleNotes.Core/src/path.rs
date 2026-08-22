//! Note paths.
//!
//! A note has one name, and a `/` in it means a folder. There are no folder records anywhere: the
//! tree the sidebar draws is derived from the names, and the tree the FUSE filesystem will mount is
//! derived the same way from the same function. That is the point of putting this in the core -
//! if the clients and the filesystem disagreed about what "Work/Notes" means, the same note would
//! appear in two places.

use crate::crypto::CoreError;
use wasm_bindgen::prelude::*;

/// Longest a single path segment may be, in bytes. This is not a limit we invented: most
/// filesystems, including the ones FUSE will sit on top of, cannot represent a longer component.
pub const MAX_SEGMENT_BYTES: usize = 255;

/// Cleans up a path the user typed: trims whitespace around each segment, collapses repeated
/// slashes, and drops empty segments. `"  Work //  Notes/ "` becomes `"Work/Notes"`.
///
/// Rejects only what cannot be represented at all - an empty name, a path component of `.` or `..`
/// (which would let a note escape its folder in the mounted filesystem), and control characters.
/// Everything else is the user's business.
#[wasm_bindgen]
pub fn normalise_path(raw: &str) -> Result<String, CoreError> {
    if raw.contains('\0') {
        return Err("A note name cannot contain a null character".to_string());
    }
    if raw.contains(['\n', '\r']) {
        return Err("A note name cannot contain a line break".to_string());
    }

    let segments: Vec<&str> = raw
        .split('/')
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .collect();

    if segments.is_empty() {
        return Err("A note needs a name".to_string());
    }

    for segment in &segments {
        if *segment == "." || *segment == ".." {
            return Err("A note name cannot contain '.' or '..' as a folder".to_string());
        }
    }

    Ok(segments.join("/"))
}

/// The folder a note sits in, or an empty string when it sits at the top level.
#[wasm_bindgen]
pub fn parent_path(path: &str) -> String {
    match path.rfind('/') {
        Some(index) => path[..index].to_string(),
        None => String::new(),
    }
}

/// The note's own name, without the folders leading to it.
#[wasm_bindgen]
pub fn file_name(path: &str) -> String {
    match path.rfind('/') {
        Some(index) => path[index + 1..].to_string(),
        None => path.to_string(),
    }
}

/// Segments that are too long for a real filesystem to store. Reported so the UI can say so, not
/// so anything can be refused - the note still saves, and FUSE will shorten what it must.
#[wasm_bindgen]
pub fn oversized_segments(path: &str) -> Vec<String> {
    path.split('/')
        .filter(|segment| segment.len() > MAX_SEGMENT_BYTES)
        .map(str::to_string)
        .collect()
}

/// The extension a note takes on when it becomes a file. Markdown is what a note *is*, so this is
/// not a preference - it is what makes an exported vault, and a mounted one, editable by anything
/// else on the machine.
pub const NOTE_EXTENSION: &str = ".md";

/// Where a note lives inside an exported archive, and where the filesystem will show it.
///
/// The rule is deliberately dumb and therefore reversible: the whole note name is the file's stem
/// and `.md` is added on the way out. A note actually called `todo.md` becomes `todo.md.md`, which
/// looks odd and is correct - it is the only way `todo.md` and `todo` can both come back as what
/// they were. An archive that renames notes as it writes them is not a backup.
#[wasm_bindgen]
pub fn archive_path(name: &str) -> Result<String, CoreError> {
    Ok(format!("{}{NOTE_EXTENSION}", normalise_path(name)?))
}

/// Reverses [`archive_path`]: the note name a file in an archive - or a file written into the
/// mounted filesystem - is asking for.
///
/// A trailing `.md` is taken off, in any case, because an archive can come from anywhere. Nothing
/// else is: a file called `notes.txt` becomes a note called `notes.txt` rather than being refused,
/// since dropping someone's file on the floor is worse than an odd-looking name.
#[wasm_bindgen]
pub fn note_name_from_archive_path(path: &str) -> Result<String, CoreError> {
    let trimmed = path.trim_end_matches('/');

    // Only the file's own name can carry the extension. Looking for the last dot in the whole path
    // would find one in a folder called "v1.0", and a file called ".md" has no name left once the
    // extension is taken off it - so it keeps it and imports as a note called ".md" rather than
    // silently becoming the folder it was in.
    let (folder, leaf) = match trimmed.rfind('/') {
        Some(index) => trimmed.split_at(index + 1),
        None => ("", trimmed),
    };

    let bytes = leaf.as_bytes();
    let stem = if bytes.len() > NOTE_EXTENSION.len()
        && bytes[bytes.len() - NOTE_EXTENSION.len()..].eq_ignore_ascii_case(NOTE_EXTENSION.as_bytes())
    {
        // The last three bytes are ASCII, so this is a character boundary whatever precedes them.
        &leaf[..leaf.len() - NOTE_EXTENSION.len()]
    } else {
        leaf
    };

    normalise_path(&format!("{folder}{stem}"))
}

/// Moves a note from one folder to another, keeping its own name. Used when a folder is renamed.
#[wasm_bindgen]
pub fn reparent(path: &str, old_parent: &str, new_parent: &str) -> Result<String, CoreError> {
    let name = file_name(path);

    let moved = if new_parent.is_empty() {
        name
    } else {
        format!("{new_parent}/{name}")
    };

    // Anything below the renamed folder keeps the rest of its path underneath it.
    let deeper = parent_path(path);
    if deeper != old_parent && deeper.starts_with(&format!("{old_parent}/")) {
        let tail = &deeper[old_parent.len() + 1..];
        let rebuilt = if new_parent.is_empty() {
            format!("{tail}/{}", file_name(path))
        } else {
            format!("{new_parent}/{tail}/{}", file_name(path))
        };
        return normalise_path(&rebuilt);
    }

    normalise_path(&moved)
}
