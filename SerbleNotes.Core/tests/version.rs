//! Diff, replay and merge tests.
//!
//! This is where notes are most likely to be lost. A note's history is stored as diffs, so a diff
//! that does not apply back cleanly means every version after it is unreadable - not one bad edit,
//! the rest of the note's life. The tests here care much more about "did the text come back exactly"
//! than about how the diff is represented.

mod common;

use common::{editing_session, text_corpus};
use serblenotes_core::{apply_diff, make_diff, merge3, replay};

/// The invariant the whole storage format rests on.
fn assert_round_trips(label: &str, before: &str, after: &str) {
    let diff = make_diff(before, after);
    let rebuilt = apply_diff(before, &diff)
        .unwrap_or_else(|e| panic!("{label}: diff did not apply back: {e}"));
    assert_eq!(rebuilt, after, "{label}: rebuilt text differs from the original");
}

#[test]
fn every_text_shape_survives_a_diff_round_trip() {
    let corpus = text_corpus();

    // Every shape, edited from and edited to, including to itself.
    for (from_name, from_text) in &corpus {
        for (to_name, to_text) in &corpus {
            assert_round_trips(&format!("{from_name} -> {to_name}"), from_text, to_text);
        }
    }
}

#[test]
fn a_note_about_diffs_survives_being_diffed() {
    // The content itself is patch syntax. If the patch format is parsed loosely, editing this note
    // corrupts it - and a notes app is exactly where someone pastes a diff.
    let before = "# Patch notes\n\n--- a/main.rs\n+++ b/main.rs\n@@ -1,2 +1,2 @@\n-fn old() {}\n+fn new() {}\n";
    let after = "# Patch notes\n\n--- a/main.rs\n+++ b/main.rs\n@@ -1,2 +1,2 @@\n-fn old() {}\n+fn newer() {}\n\nAdded a note.\n";

    assert_round_trips("diff inside a note", before, after);
    assert_round_trips("diff inside a note, reversed", after, before);
}

#[test]
fn a_note_containing_conflict_markers_survives() {
    let before = "<<<<<<< ours\nmine\n=======\ntheirs\n>>>>>>> theirs\n";
    let after = "<<<<<<< ours\nmine edited\n=======\ntheirs\n>>>>>>> theirs\n";

    assert_round_trips("conflict markers in content", before, after);
}

#[test]
fn text_without_a_trailing_newline_survives() {
    // The classic diff data-loss bug: the last line silently gains or loses its newline.
    assert_round_trips("no newline -> no newline", "one\ntwo", "one\ntwo edited");
    assert_round_trips("newline -> none", "one\ntwo\n", "one\ntwo");
    assert_round_trips("none -> newline", "one\ntwo", "one\ntwo\n");
    assert_round_trips("append to unterminated", "one\ntwo", "one\ntwo\nthree\n");

    let diff = make_diff("one\ntwo\n", "one\ntwo");
    assert_eq!(apply_diff("one\ntwo\n", &diff).unwrap(), "one\ntwo", "trailing newline was not removed");
}

#[test]
fn windows_line_endings_are_preserved_exactly() {
    let before = "one\r\ntwo\r\nthree\r\n";
    let after = "one\r\ntwo changed\r\nthree\r\n";

    let rebuilt = apply_diff(before, &make_diff(before, after)).unwrap();
    assert_eq!(rebuilt, after);
    assert!(rebuilt.contains("\r\n"), "carriage returns were stripped");
    assert_eq!(rebuilt.matches("\r\n").count(), 3);
}

#[test]
fn an_identical_edit_produces_a_diff_that_changes_nothing() {
    for (name, text) in text_corpus() {
        let diff = make_diff(&text, &text);
        assert_eq!(apply_diff(&text, &diff).unwrap(), text, "no-op diff altered: {name}");
    }
}

#[test]
fn clearing_a_note_and_writing_it_again_round_trips() {
    assert_round_trips("clear", "# Full note\n\nwith content\n", "");
    assert_round_trips("write from empty", "", "# Full note\n\nwith content\n");
    assert_round_trips("empty to empty", "", "");
}

#[test]
fn a_large_document_round_trips() {
    let before: String = (0..20_000).map(|i| format!("line {i}\n")).collect();
    let mut after = before.clone();
    after.push_str("appended at the end\n");
    after = after.replacen("line 9999\n", "line 9999 edited\n", 1);

    assert_round_trips("20k lines", &before, &after);
}

#[test]
fn applying_a_diff_to_the_wrong_text_is_an_error_not_a_wrong_document() {
    let diff = make_diff("the original text\nsecond line\n", "the edited text\nsecond line\n");

    // Silently producing *something* here is the dangerous outcome: it would be saved as the note.
    let result = apply_diff("a completely different document\n", &diff);
    assert!(result.is_err(), "a diff applied to unrelated text without complaint");
}

#[test]
fn malformed_diffs_are_errors_not_panics() {
    let malformed = [
        "",
        "not a diff at all",
        "@@ -1,1 +1,1 @@",
        "--- a\n+++ b\n@@ garbage @@\n",
        "--- a\n+++ b\n@@ -1,99999 +1,99999 @@\n-x\n+y\n",
        "\u{0}\u{1}\u{2}",
    ];

    for diff in malformed {
        let result = apply_diff("some text\n", diff);
        assert!(result.is_err(), "malformed diff was accepted: {diff:?}");
    }
}

#[test]
fn a_payload_that_is_not_a_diff_never_silently_returns_the_parent_text() {
    // The specific failure this guards: garbage parses as a patch with no hunks, applies as "no
    // change", and the caller stores the parent's text as if it were this version. The note appears
    // to revert, and the next save writes the stale text over the real one.
    let parent = "# The real note\n\nwith content that must not vanish\n";

    for payload in ["", "not a diff", "\u{0}\u{1}", "random\nlines\nof\ntext\n", "+++ b\n--- a\n"] {
        match apply_diff(parent, payload) {
            Err(_) => {}
            Ok(text) => panic!("payload {payload:?} was accepted and returned {text:?}"),
        }
    }
}

#[test]
fn a_legitimate_no_op_diff_is_still_accepted() {
    // Diffs between identical texts have no hunks but are perfectly valid, and must not be caught by
    // the guard above.
    let text = "unchanged content\n";
    let no_op = make_diff(text, text);

    assert!(!no_op.is_empty(), "a no-op diff should still carry its headers");
    assert_eq!(apply_diff(text, &no_op).unwrap(), text);
}

#[test]
fn anything_make_diff_produces_is_accepted_by_apply_diff() {
    // The two halves must never drift apart: if a library upgrade changes the emitted format, this
    // fails here rather than in production against notes people already have.
    let corpus = text_corpus();

    for (from_name, from_text) in &corpus {
        for (to_name, to_text) in &corpus {
            let diff = make_diff(from_text, to_text);
            assert!(
                apply_diff(from_text, &diff).is_ok(),
                "apply_diff rejected a diff make_diff produced: {from_name} -> {to_name}"
            );
        }
    }
}

#[test]
fn a_whole_editing_session_replays_to_every_intermediate_version() {
    let session = editing_session();
    let snapshot = &session[0];

    // Replaying a prefix of the history has to give exactly the version at that point - this is what
    // the history sidebar shows and what "restore" writes back.
    for end in 1..session.len() {
        let diffs: Vec<String> = (1..=end).map(|i| make_diff(&session[i - 1], &session[i])).collect();
        let json = serde_json::to_string(&diffs).unwrap();
        let rebuilt = replay(snapshot, &json).unwrap_or_else(|e| panic!("replay to version {end} failed: {e}"));
        assert_eq!(rebuilt, session[end], "replay to version {end} produced the wrong text");
    }
}

#[test]
fn replaying_no_diffs_returns_the_snapshot_untouched() {
    for (name, text) in text_corpus() {
        assert_eq!(replay(&text, "[]").unwrap(), text, "empty replay altered: {name}");
    }
}

#[test]
fn a_long_chain_of_diffs_replays_exactly() {
    // A note edited 500 times without an intervening snapshot. Each step is small; the risk is drift
    // accumulating across the chain.
    let mut versions = vec!["# Journal\n".to_string()];
    for i in 0..500 {
        let mut next = versions[i].clone();
        next.push_str(&format!("Entry {i}: something happened today.\n"));
        if i % 7 == 0 {
            next = next.replace("something happened", "something else happened");
        }
        versions.push(next);
    }

    let diffs: Vec<String> = (1..versions.len()).map(|i| make_diff(&versions[i - 1], &versions[i])).collect();
    let rebuilt = replay(&versions[0], &serde_json::to_string(&diffs).unwrap()).unwrap();
    assert_eq!(rebuilt, *versions.last().unwrap());
}

#[test]
fn a_broken_history_reports_where_it_broke() {
    let good = make_diff("one\n", "one\ntwo\n");
    let broken = make_diff("something unrelated\n", "something else\n");
    let diffs = serde_json::to_string(&vec![good, broken]).unwrap();

    let error = replay("one\n", &diffs).unwrap_err();
    assert!(error.contains('1'), "the error should name the failing step, got: {error}");
}

#[test]
fn a_malformed_diff_list_is_an_error() {
    for json in ["", "not json", "{}", "[1, 2, 3]", "[\"unterminated"] {
        assert!(replay("text\n", json).is_err(), "accepted diff list: {json:?}");
    }
}

// --- merging -------------------------------------------------------------------------------------

#[test]
fn edits_in_different_places_merge_without_a_conflict() {
    let ancestor = "# Title\n\nbody paragraph\n\nfooter\n";
    let ours = "# Title changed\n\nbody paragraph\n\nfooter\n";
    let theirs = "# Title\n\nbody paragraph\n\nfooter changed\n";

    let outcome = merge3(ancestor, ours, theirs);
    assert!(!outcome.conflicted(), "a clean merge was reported as a conflict");
    assert!(outcome.text().contains("Title changed"), "our edit was lost");
    assert!(outcome.text().contains("footer changed"), "their edit was lost");
}

#[test]
fn the_same_edit_made_on_both_devices_merges_cleanly() {
    let ancestor = "- milk\n- bread\n";
    let both = "- milk\n- sourdough bread\n";

    let outcome = merge3(ancestor, both, both);
    assert!(!outcome.conflicted(), "identical edits should not conflict");
    assert_eq!(outcome.text(), both);
}

#[test]
fn a_change_on_one_side_only_is_taken_as_is() {
    let ancestor = "line one\nline two\n";
    let changed = "line one\nline two\nline three\n";

    let ours = merge3(ancestor, changed, ancestor);
    assert!(!ours.conflicted());
    assert_eq!(ours.text(), changed, "our change was dropped");

    let theirs = merge3(ancestor, ancestor, changed);
    assert!(!theirs.conflicted());
    assert_eq!(theirs.text(), changed, "their change was dropped");
}

#[test]
fn competing_edits_to_one_line_conflict_and_keep_both_sides() {
    let ancestor = "meeting at noon\n";
    let ours = "meeting at 1pm\n";
    let theirs = "meeting at 2pm\n";

    let outcome = merge3(ancestor, ours, theirs);
    assert!(outcome.conflicted(), "competing edits must not be resolved silently");

    // The rule that matters: a conflict is allowed to be ugly, but it may never drop either edit.
    assert!(outcome.text().contains("1pm"), "our edit vanished in the conflict");
    assert!(outcome.text().contains("2pm"), "their edit vanished in the conflict");
}

#[test]
fn a_deletion_racing_an_edit_conflicts_and_keeps_the_edit() {
    let ancestor = "keep me\ndelete me\nkeep me too\n";
    let ours = "keep me\nkeep me too\n";
    let theirs = "keep me\ndelete me but edited\nkeep me too\n";

    let outcome = merge3(ancestor, ours, theirs);
    assert!(outcome.conflicted(), "delete versus edit must surface to the user");
    assert!(outcome.text().contains("delete me but edited"), "the surviving edit was lost");
}

#[test]
fn both_sides_deleting_the_same_thing_is_not_a_conflict() {
    let ancestor = "one\ntwo\nthree\n";
    let without_two = "one\nthree\n";

    let outcome = merge3(ancestor, without_two, without_two);
    assert!(!outcome.conflicted());
    assert_eq!(outcome.text(), without_two);
}

#[test]
fn appending_on_both_devices_keeps_both_additions() {
    let ancestor = "# Log\n\n";
    let ours = "# Log\n\n- from the laptop\n";
    let theirs = "# Log\n\n- from the phone\n";

    let outcome = merge3(ancestor, ours, theirs);
    // Appending at the same spot legitimately conflicts, but both lines have to survive either way.
    assert!(outcome.text().contains("from the laptop"), "laptop edit lost");
    assert!(outcome.text().contains("from the phone"), "phone edit lost");
}

#[test]
fn merging_one_side_cleared_keeps_the_other_sides_content() {
    let ancestor = "important content\n";
    let outcome = merge3(ancestor, "", "important content edited\n");

    // Whatever it decides, the edited text must not disappear without being flagged.
    assert!(
        outcome.conflicted() || outcome.text().contains("important content edited"),
        "content was dropped silently in a clear-versus-edit merge"
    );
}

#[test]
fn merging_unicode_content_preserves_it() {
    let ancestor = "# 日本語\n\nノート\n";
    let ours = "# 日本語 📝\n\nノート\n";
    let theirs = "# 日本語\n\nノート\n追加\n";

    let outcome = merge3(ancestor, ours, theirs);
    assert!(!outcome.conflicted());
    assert!(outcome.text().contains("📝"), "emoji edit lost");
    assert!(outcome.text().contains("追加"), "appended line lost");
}

#[test]
fn merging_identical_input_is_a_no_op() {
    for (name, text) in text_corpus() {
        let outcome = merge3(&text, &text, &text);
        assert!(!outcome.conflicted(), "identical inputs conflicted: {name}");
        assert_eq!(outcome.text(), text, "identical inputs were altered: {name}");
    }
}

// --- guarding against plausible-but-wrong results ------------------------------------------------

#[test]
fn a_repeated_block_does_not_let_a_diff_apply_to_the_wrong_place() {
    // Repeated identical blocks are common in notes (recurring templates, log entries). If the patch
    // machinery matched loosely, an edit to the third block could land on the first - producing a
    // document that looks right and is wrong.
    let block = "## Entry\n\n- did a thing\n- did another thing\n\n";
    let before = format!("{block}{block}{block}");

    let mut after = before.clone();
    let third = before.rfind("## Entry").unwrap();
    after.replace_range(third.., "## Entry\n\n- did a THIRD thing\n- did another thing\n\n");

    let diff = make_diff(&before, &after);
    let rebuilt = apply_diff(&before, &diff).unwrap();

    assert_eq!(rebuilt, after, "the edit landed on the wrong block");
    assert_eq!(rebuilt.matches("THIRD").count(), 1, "the edit was applied more than once");
    assert!(rebuilt.starts_with(block), "the first block was modified");
}

#[test]
fn applying_the_same_diff_twice_is_refused() {
    // A retrying sync client, or a history with a duplicated entry, can present the same diff twice.
    // Before diffs were bound to their base this appended the same line twice and looked fine.
    let before = "one\ntwo\nthree\n";
    let after = "one\ntwo\nthree\nfour\n";
    let diff = make_diff(before, after);

    let once = apply_diff(before, &diff).unwrap();
    assert_eq!(once, after);

    let twice = apply_diff(&once, &diff);
    assert!(twice.is_err(), "applying a diff twice was allowed: {twice:?}");
}

#[test]
fn a_diff_cannot_be_applied_to_text_it_was_not_made_from() {
    let base = "# Report\n\nfindings go here\n";
    let diff = make_diff(base, "# Report\n\nfindings go here\n\n## Summary\n");

    // Every one of these applies cleanly as far as unified-diff context matching is concerned; the
    // resulting document would be plausible, wrong, and saved over the real note.
    let wrong_bases = [
        "# Report\n\nfindings go here\n\n## Summary\n",
        "# Report\n\nfindings go here\n\n## Other\n",
        "# Report\n\nFINDINGS go here\n",
        "# Report\n\nfindings go here",
        "",
    ];

    for wrong in wrong_bases {
        let result = apply_diff(wrong, &diff);
        assert!(result.is_err(), "diff applied to the wrong base {wrong:?} -> {result:?}");
    }

    // ...and the right base still works, which is the half that must not regress.
    assert!(apply_diff(base, &diff).is_ok());
}

#[test]
fn a_duplicated_entry_in_a_history_is_caught_rather_than_replayed_twice() {
    let v1 = "# Log\n";
    let v2 = "# Log\n\n- first entry\n";
    let v3 = "# Log\n\n- first entry\n- second entry\n";

    let good = serde_json::to_string(&vec![make_diff(v1, v2), make_diff(v2, v3)]).unwrap();
    assert_eq!(replay(v1, &good).unwrap(), v3);

    let duplicated = serde_json::to_string(&vec![
        make_diff(v1, v2),
        make_diff(v1, v2),
        make_diff(v2, v3),
    ])
    .unwrap();
    assert!(replay(v1, &duplicated).is_err(), "a duplicated history entry was replayed");
}

#[test]
fn a_tampered_fingerprint_is_rejected() {
    let base = "original content\n";
    let diff = make_diff(base, "edited content\n");

    let mut tampered = diff.clone();
    // Flip one character of the fingerprint; the patch body is untouched and still applies.
    let position = "serblenotes-diff-v1 ".len();
    let replacement = if tampered.as_bytes()[position] == b'a' { 'b' } else { 'a' };
    tampered.replace_range(position..position + 1, &replacement.to_string());

    assert!(apply_diff(base, &tampered).is_err(), "a tampered fingerprint was accepted");
    assert!(apply_diff(base, &diff).is_ok());
}

#[test]
fn the_diff_format_this_module_emits_is_pinned() {
    // Stored diffs are read back for the life of the vault. If an upgrade changes this format,
    // previously written history stops loading - so fail here, in the suite, and not against notes
    // people already have. Changing the format means bumping the version in the prefix.
    let diff = make_diff("before\n", "after\n");
    let mut lines = diff.lines();

    let header = lines.next().unwrap();
    assert!(header.starts_with("serblenotes-diff-v1 "), "the diff header changed: {header:?}");
    assert_eq!(header.len(), "serblenotes-diff-v1 ".len() + 32, "the fingerprint length changed");
    assert!(header[20..].chars().all(|c| c.is_ascii_hexdigit()), "the fingerprint is not hex");

    assert!(lines.next().unwrap().starts_with("--- "), "the patch body lost its --- header");
    assert!(lines.next().unwrap().starts_with("+++ "), "the patch body lost its +++ header");
    assert!(diff.contains("@@"), "diff no longer contains a hunk header");

    // A no-change diff must still be applicable, or saving an unchanged note would break.
    let no_op = make_diff("same\n", "same\n");
    assert!(no_op.starts_with("serblenotes-diff-v1 "), "a no-op diff lost its header");
    assert_eq!(apply_diff("same\n", &no_op).unwrap(), "same\n");
}

#[test]
fn the_fingerprint_distinguishes_documents_that_differ_only_slightly() {
    // The whole guard rests on near-identical documents getting different fingerprints.
    let base = "line one\nline two\n";
    let diff = make_diff(base, "line one\nline two\nline three\n");

    for nearly in ["line one\nline two", "line one\nline two\n\n", "line one\nline  two\n", "Line one\nline two\n"] {
        assert!(apply_diff(nearly, &diff).is_err(), "fingerprint did not distinguish {nearly:?}");
    }
}

/// Every conflict marker begins a line of its own.
///
/// `diffy` writes a marker straight after the section before it, so a side whose last line has no
/// trailing newline used to come back with the marker welded onto its own text - `hgggggg|||||||
/// original`. Anything that reads conflict markers expects them at the start of a line, and in this
/// app's editor a lone `=======` under a line of prose is a setext heading, so the mangled line
/// rendered as a title. This is the shape of a one-line note edited on two devices, which is about
/// the most ordinary conflict there is.
#[test]
fn conflict_markers_never_share_a_line_with_content() {
    let outcome = merge3("base", "ours text", "theirs text");
    assert!(outcome.conflicted());

    for line in outcome.text().lines() {
        for marker in ["<<<<<<<", "|||||||", "=======", ">>>>>>>"] {
            if line.contains(marker) {
                assert!(
                    line.starts_with(marker),
                    "marker {marker} is not at the start of {line:?}"
                );
            }
        }
    }
}

/// The same, for every shape in the corpus that can be made to conflict.
#[test]
fn no_text_shape_can_weld_a_marker_onto_a_line() {
    for (name, ancestor) in text_corpus() {
        let ours = format!("{ancestor}ours");
        let theirs = format!("{ancestor}theirs");

        let outcome = merge3(&ancestor, &ours, &theirs);
        if !outcome.conflicted() {
            continue;
        }

        for line in outcome.text().lines() {
            for marker in ["<<<<<<<", "|||||||", "=======", ">>>>>>>"] {
                assert!(
                    !line.contains(marker) || line.starts_with(marker),
                    "corpus {name} welded {marker} into {line:?}"
                );
            }
        }
    }
}

/// A clean merge is still byte for byte what it always was.
///
/// The padding above must never reach this path: a trailing newline the user did not type is a
/// change to their note, and the corpus is full of documents that deliberately end without one.
#[test]
fn a_clean_merge_does_not_gain_a_trailing_newline() {
    let ancestor = "one\ntwo\nthree";
    let ours = "one CHANGED\ntwo\nthree";
    let theirs = "one\ntwo\nthree CHANGED";

    let outcome = merge3(ancestor, ours, theirs);
    assert!(!outcome.conflicted());
    assert_eq!(outcome.text(), "one CHANGED\ntwo\nthree CHANGED");
    assert!(!outcome.text().ends_with('\n'));
}

/// A side that deleted everything must stay a deletion.
///
/// `merge3` pads every side with a trailing newline before re-merging a conflict, because `diffy`
/// welds its markers onto a section that does not end in one. An empty side is the case that padding
/// must leave alone: "" is not a document missing its newline, it is a document with nothing in it,
/// and turning it into "\n" makes a deletion come back as a blank line. Nobody typed that line, and
/// on the clean path it would be written into the note by the next autosave.
#[test]
fn padding_a_conflict_does_not_turn_a_deletion_into_a_blank_line() {
    let ancestor = "one\ntwo\nthree";

    // One side deletes the lot; the other rewrites it, so the two cannot be reconciled and the
    // padding path is the one that runs.
    let outcome = merge3(ancestor, "", "one CHANGED\ntwo CHANGED\nthree CHANGED");

    // Whatever comes out, the empty side must have contributed no lines at all. Counted rather than
    // trimmed: a section holding one empty line trims to nothing, which is precisely the difference
    // between "this version deleted it" and "this version left a blank line here".
    if outcome.conflicted() {
        let text = outcome.text();
        let ours_section: Vec<&str> = text
            .lines()
            .skip_while(|line| !line.starts_with("<<<<<<<"))
            .skip(1)
            .take_while(|line| !line.starts_with("|||||||") && !line.starts_with("======="))
            .collect();
        assert!(
            ours_section.is_empty(),
            "the side that deleted everything came back holding {ours_section:?}"
        );
    } else {
        assert_eq!(outcome.text(), "one CHANGED\ntwo CHANGED\nthree CHANGED");
    }
}

#[test]
fn merging_two_empty_documents_produces_an_empty_one() {
    // Not a blank line, and not a newline nobody typed.
    let outcome = merge3("", "", "");

    assert!(!outcome.conflicted());
    assert_eq!(outcome.text(), "");
}

#[test]
fn deleting_everything_on_one_side_alone_is_a_clean_deletion() {
    let outcome = merge3("one\ntwo\nthree", "", "one\ntwo\nthree");

    assert!(!outcome.conflicted());
    assert_eq!(outcome.text(), "", "an untouched other side must not resurrect the note");
}
