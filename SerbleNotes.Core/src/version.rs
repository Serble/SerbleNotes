//! Version control: diffs, replay and merging.
//!
//! A note's history is a DAG. Most versions carry a diff against their parent; every so often the
//! client writes a full snapshot so that replaying history doesn't mean walking back to the very
//! first edit. When two devices edit the same note offline they produce siblings, and merging them
//! is a three-way merge against their common ancestor.

use crate::crypto::CoreError;
use blake2::{Blake2s256, Digest};
use diffy::{apply, create_patch, merge, Patch};
use wasm_bindgen::prelude::*;

/// Marks a payload as a diff this module produced, and carries the fingerprint of the text it was
/// made against. Versioned so the format can change later without misreading old diffs.
const DIFF_PREFIX: &str = "serblenotes-diff-v1 ";

/// A short fingerprint of a document, used only to confirm a diff is being applied to the exact text
/// it was built from. 128 bits is far more than enough to make an accidental match impossible.
fn fingerprint(text: &str) -> String {
    let digest = Blake2s256::digest(text.as_bytes());
    digest[..16].iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Outcome of a three-way merge. `conflicted` means the text came back with conflict markers in it
/// and a human has to choose - the merge is never silently resolved by picking a side.
#[wasm_bindgen]
pub struct MergeOutcome {
    text: String,
    conflicted: bool,
}

#[wasm_bindgen]
impl MergeOutcome {
    #[wasm_bindgen(getter)]
    pub fn text(&self) -> String { self.text.clone() }

    #[wasm_bindgen(getter)]
    pub fn conflicted(&self) -> bool { self.conflicted }
}

/// Produces the diff stored in a version whose parent held `previous`.
///
/// The result is a unified diff with one extra header line binding it to `previous`. See
/// [`apply_diff`] for why that binding is not optional.
#[wasm_bindgen]
pub fn make_diff(previous: &str, current: &str) -> String {
    format!("{DIFF_PREFIX}{}\n{}", fingerprint(previous), create_patch(previous, current))
}

/// Applies one stored diff, but only to the exact text it was made from.
///
/// A unified diff cannot tell on its own whether it is being applied to the right document. It
/// matches on context lines, so applying one to the wrong text often *succeeds* and produces
/// something plausible and wrong - applying the same diff twice, for instance, used to append the
/// same line twice. A wrong document that loads without complaint is worse than one that fails to
/// load: the editor shows it, and the next autosave writes it over the real note.
///
/// So every diff carries a fingerprint of its base and is refused unless the base matches. That also
/// disposes of garbage payloads: text with no hunk header parses as a patch with zero hunks and
/// applies as "no change", which would silently hand back the parent's text as this version.
#[wasm_bindgen]
pub fn apply_diff(previous: &str, diff: &str) -> Result<String, CoreError> {
    let (header, patch_text) = diff
        .split_once('\n')
        .ok_or_else(|| "Malformed diff: this payload is not a diff".to_string())?;

    let expected = header
        .strip_prefix(DIFF_PREFIX)
        .ok_or_else(|| "Malformed diff: this payload is not a diff".to_string())?;

    if expected != fingerprint(previous) {
        return Err("This diff was made against different text and cannot be applied to it".to_string());
    }

    let patch = Patch::from_str(patch_text).map_err(|e| format!("Malformed diff: {e}"))?;
    apply(previous, &patch).map_err(|e| format!("Diff does not apply: {e}"))
}

/// Rebuilds a document by replaying diffs onto a snapshot, which is how any historical version is
/// reconstructed. `diffs_json` is a JSON array of diff strings in order.
#[wasm_bindgen]
pub fn replay(snapshot: &str, diffs_json: &str) -> Result<String, CoreError> {
    let diffs: Vec<String> = serde_json::from_str(diffs_json)
        .map_err(|e| format!("Diff list is not valid JSON: {e}"))?;

    let mut document = snapshot.to_string();
    for (index, diff) in diffs.iter().enumerate() {
        document = apply_diff(&document, diff)
            .map_err(|_| format!("History is broken at step {index}"))?;
    }

    Ok(document)
}

/// Three-way merge of two branches against their common ancestor.
#[wasm_bindgen]
pub fn merge3(ancestor: &str, ours: &str, theirs: &str) -> MergeOutcome {
    match merge(ancestor, ours, theirs) {
        Ok(text) => MergeOutcome { text, conflicted: false },
        Err(text) => MergeOutcome { text, conflicted: true },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_diff_reproduces_the_new_document() {
        let before = "one\ntwo\nthree\n";
        let after = "one\ntwo and a half\nthree\n";
        let diff = make_diff(before, after);
        assert_eq!(apply_diff(before, &diff).unwrap(), after);
    }

    #[test]
    fn replaying_a_history_rebuilds_the_latest_document() {
        let v1 = "line one\n";
        let v2 = "line one\nline two\n";
        let v3 = "line one\nline two\nline three\n";

        let diffs = serde_json::to_string(&vec![make_diff(v1, v2), make_diff(v2, v3)]).unwrap();
        assert_eq!(replay(v1, &diffs).unwrap(), v3);
    }

    #[test]
    fn edits_to_different_parts_merge_cleanly() {
        let ancestor = "title\n\nbody\n\nfooter\n";
        let ours = "title changed\n\nbody\n\nfooter\n";
        let theirs = "title\n\nbody\n\nfooter changed\n";

        let outcome = merge3(ancestor, ours, theirs);
        assert!(!outcome.conflicted());
        assert!(outcome.text().contains("title changed"));
        assert!(outcome.text().contains("footer changed"));
    }

    #[test]
    fn edits_to_the_same_line_conflict_rather_than_picking_a_winner() {
        let ancestor = "shopping list\n";
        let ours = "shopping list for tuesday\n";
        let theirs = "shopping list for wednesday\n";

        let outcome = merge3(ancestor, ours, theirs);
        assert!(outcome.conflicted());
        // Both edits survive in the markers so the user can choose; neither is thrown away.
        assert!(outcome.text().contains("tuesday"));
        assert!(outcome.text().contains("wednesday"));
    }

    #[test]
    fn a_broken_history_is_an_error_not_a_wrong_document() {
        let diff = make_diff("original\n", "edited\n");
        assert!(apply_diff("something else entirely\n", &diff).is_err());
    }
}
