//! Property-based tests.
//!
//! The example-based suites cover the cases someone thought of. These cover the ones nobody did:
//! proptest generates thousands of documents and edits, and on failure shrinks them to the smallest
//! input that still breaks - which is usually the bug report written for you.

mod common;

use common::fast_kdf;
use proptest::prelude::*;
use serblenotes_core::{
    apply_diff, archive_path, derive_key, generate_salt, generate_vault_key, make_diff, merge3,
    normalise_path, note_name_from_archive_path, open, replay, seal,
};

/// Line-structured text, which is what a markdown note actually is and what diffs operate on.
fn document() -> impl Strategy<Value = String> {
    prop::collection::vec("[^\n]{0,40}", 0..20)
        .prop_map(|lines| if lines.is_empty() { String::new() } else { lines.join("\n") + "\n" })
}

/// A document and a plausible edit of it, rather than two unrelated documents - this is what
/// actually exercises the diff machinery.
fn document_and_edit() -> impl Strategy<Value = (String, String)> {
    (document(), prop::collection::vec(0usize..4, 0..8), any::<u64>()).prop_map(
        |(original, operations, seed)| {
            let mut lines: Vec<String> = original.lines().map(str::to_string).collect();
            let mut counter = seed;

            for operation in operations {
                counter = counter.wrapping_mul(6364136223846793005).wrapping_add(1);
                let position = if lines.is_empty() { 0 } else { (counter as usize) % lines.len() };

                match operation {
                    0 => lines.insert(position, format!("inserted line {counter}")),
                    1 if !lines.is_empty() => { lines.remove(position); }
                    2 if !lines.is_empty() => lines[position] = format!("edited line {counter}"),
                    _ => lines.push(format!("appended line {counter}")),
                }
            }

            let edited = if lines.is_empty() { String::new() } else { lines.join("\n") + "\n" };
            (original, edited)
        },
    )
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(400))]

    /// Nothing typed into a note may change on its way to storage and back.
    #[test]
    fn sealing_and_opening_returns_the_original_text(text in any::<String>()) {
        let key = generate_vault_key();
        let sealed = seal(&key, &text).unwrap();
        prop_assert_eq!(open(&key, &sealed).unwrap(), text);
    }

    /// A wrong key must never produce readable output, whatever the content was.
    #[test]
    fn a_wrong_key_never_opens_a_payload(text in any::<String>()) {
        let sealed = seal(&generate_vault_key(), &text).unwrap();
        prop_assert!(open(&generate_vault_key(), &sealed).is_err());
    }

    /// Arbitrary input from a hostile or broken server must not take the module down.
    #[test]
    fn opening_arbitrary_input_never_panics(key in any::<String>(), payload in any::<String>()) {
        let _ = open(&key, &payload);
    }

    #[test]
    fn applying_arbitrary_input_as_a_diff_never_panics(base in any::<String>(), diff in any::<String>()) {
        let _ = apply_diff(&base, &diff);
    }

    #[test]
    fn replaying_arbitrary_input_never_panics(snapshot in any::<String>(), diffs in any::<String>()) {
        let _ = replay(&snapshot, &diffs);
    }

    /// The single most important invariant in the module: a diff always rebuilds its target.
    #[test]
    fn a_diff_always_rebuilds_the_edited_document((original, edited) in document_and_edit()) {
        let diff = make_diff(&original, &edited);
        let rebuilt = apply_diff(&original, &diff)
            .map_err(|e| TestCaseError::fail(format!("diff did not apply: {e}")))?;
        prop_assert_eq!(rebuilt, edited);
    }

    /// The same holds for two completely unrelated documents, which is what a paste-over looks like.
    #[test]
    fn a_diff_between_unrelated_documents_still_rebuilds(before in document(), after in document()) {
        let diff = make_diff(&before, &after);
        prop_assert_eq!(apply_diff(&before, &diff).unwrap(), after);
    }

    /// A diff must refuse every document except the one it was made from. Unified-diff context
    /// matching alone does not give this: it applies wherever the surrounding lines happen to fit,
    /// which is how a plausible, wrong document gets written over a real note.
    #[test]
    fn a_diff_never_applies_to_a_document_it_was_not_made_from(
        (original, edited) in document_and_edit(),
        other in document(),
    ) {
        prop_assume!(other != original);
        let diff = make_diff(&original, &edited);
        prop_assert!(
            apply_diff(&other, &diff).is_err(),
            "a diff built from {:?} applied to {:?}", original, other
        );
    }

    /// Diffs must be reproducible: the same edit always produces the same bytes.
    #[test]
    fn diffing_is_deterministic((original, edited) in document_and_edit()) {
        prop_assert_eq!(make_diff(&original, &edited), make_diff(&original, &edited));
    }

    /// A whole history replays to the latest document, however long the chain.
    #[test]
    fn replaying_a_chain_of_edits_reaches_the_final_document(
        versions in prop::collection::vec(document(), 1..12)
    ) {
        let diffs: Vec<String> = (1..versions.len())
            .map(|i| make_diff(&versions[i - 1], &versions[i]))
            .collect();

        let rebuilt = replay(&versions[0], &serde_json::to_string(&diffs).unwrap()).unwrap();
        prop_assert_eq!(rebuilt, versions.last().unwrap().clone());
    }

    /// Every prefix of a history rebuilds the version at that point, which is what the history
    /// sidebar and restore both depend on.
    #[test]
    fn every_prefix_of_a_history_rebuilds_its_own_version(
        versions in prop::collection::vec(document(), 1..8)
    ) {
        for end in 0..versions.len() {
            let diffs: Vec<String> = (1..=end)
                .map(|i| make_diff(&versions[i - 1], &versions[i]))
                .collect();
            let rebuilt = replay(&versions[0], &serde_json::to_string(&diffs).unwrap()).unwrap();
            prop_assert_eq!(rebuilt, versions[end].clone());
        }
    }

    /// The full storage path - seal a diff, open it, apply it - as the client performs it.
    #[test]
    fn a_sealed_diff_rebuilds_the_document((original, edited) in document_and_edit()) {
        let key = generate_vault_key();
        let sealed_diff = seal(&key, &make_diff(&original, &edited)).unwrap();
        let rebuilt = apply_diff(&original, &open(&key, &sealed_diff).unwrap()).unwrap();
        prop_assert_eq!(rebuilt, edited);
    }

    /// If only one device changed anything, the merge is that device's version. No conflict, and
    /// above all no reverting to the ancestor.
    #[test]
    fn a_merge_where_only_one_side_changed_takes_that_side(
        (ancestor, changed) in document_and_edit()
    ) {
        let ours = merge3(&ancestor, &changed, &ancestor);
        prop_assert!(!ours.conflicted(), "one-sided change reported a conflict");
        prop_assert_eq!(ours.text(), changed.clone());

        let theirs = merge3(&ancestor, &ancestor, &changed);
        prop_assert!(!theirs.conflicted());
        prop_assert_eq!(theirs.text(), changed);
    }

    /// Both devices making the identical edit is agreement, not a conflict.
    #[test]
    fn an_identical_edit_on_both_sides_merges_to_that_edit(
        (ancestor, changed) in document_and_edit()
    ) {
        let outcome = merge3(&ancestor, &changed, &changed);
        prop_assert!(!outcome.conflicted());
        prop_assert_eq!(outcome.text(), changed);
    }

    /// A clean merge may never quietly drop a line that one side added and neither side touched.
    #[test]
    fn a_clean_merge_keeps_lines_added_by_either_side(base in document()) {
        let ours = format!("UNIQUE-OURS-MARKER\n{base}");
        let theirs = format!("{base}UNIQUE-THEIRS-MARKER\n");

        let outcome = merge3(&base, &ours, &theirs);
        prop_assert!(outcome.text().contains("UNIQUE-OURS-MARKER"), "our line was lost");
        prop_assert!(outcome.text().contains("UNIQUE-THEIRS-MARKER"), "their line was lost");
    }

    /// Key derivation has to be a pure function of password, salt and parameters - for as long as
    /// the vault exists.
    #[test]
    fn key_derivation_is_deterministic(password in any::<String>()) {
        let salt = generate_salt();
        let first = derive_key(&password, &salt, &fast_kdf()).unwrap();
        let second = derive_key(&password, &salt, &fast_kdf()).unwrap();
        prop_assert_eq!(first, second);
    }

    /// Different passwords must not collide onto the same key.
    #[test]
    fn different_passwords_derive_different_keys(a in ".{0,40}", b in ".{0,40}") {
        prop_assume!(a != b);
        let salt = generate_salt();
        prop_assert_ne!(
            derive_key(&a, &salt, &fast_kdf()).unwrap(),
            derive_key(&b, &salt, &fast_kdf()).unwrap()
        );
    }

    /// A vault key survives being wrapped by a password and unwrapped on another device.
    #[test]
    fn a_vault_key_survives_wrapping_with_any_password(password in any::<String>()) {
        let salt = generate_salt();
        let vault_key = generate_vault_key();

        let wrapping_key = derive_key(&password, &salt, &fast_kdf()).unwrap();
        let wrapped = seal(&wrapping_key, &vault_key).unwrap();

        let reopened = derive_key(&password, &salt, &fast_kdf()).unwrap();
        prop_assert_eq!(open(&reopened, &wrapped).unwrap(), vault_key);
    }

    /// Any note name that can exist comes back out of an archive as itself.
    ///
    /// Export is what someone reaches for before they trust this app with something, so the archive
    /// has to be exact for names nobody thought to try - the ones with dots, slashes and extensions
    /// in them are what generated input finds and a fixture list does not.
    #[test]
    fn every_name_survives_becoming_a_file_and_coming_back(raw in ".{0,60}") {
        // Only names the app would accept in the first place: the rest cannot be filed anywhere.
        let name = match normalise_path(&raw) {
            Ok(name) => name,
            Err(_) => return Ok(()),
        };

        let path = archive_path(&name).unwrap();
        prop_assert!(path.ends_with(".md"), "{path:?} is not a markdown file");
        prop_assert_eq!(note_name_from_archive_path(&path).unwrap(), name);
    }

    /// Two different notes never land on the same file, which is the property that stops an export
    /// quietly losing one of them.
    #[test]
    fn two_different_names_never_become_the_same_file(a in ".{0,40}", b in ".{0,40}") {
        let (first, second) = match (normalise_path(&a), normalise_path(&b)) {
            (Ok(first), Ok(second)) => (first, second),
            _ => return Ok(()),
        };
        prop_assume!(first != second);

        prop_assert_ne!(archive_path(&first).unwrap(), archive_path(&second).unwrap());
    }
}
