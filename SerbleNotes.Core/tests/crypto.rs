//! Encryption and key-derivation tests.
//!
//! Two failure modes matter here and they are not symmetric. Failing to decrypt data that should
//! decrypt is total data loss for that vault. Decrypting into *wrong* plaintext without an error is
//! worse - it looks like the note, so it gets saved over the real one. Every test below is aimed at
//! one of those two.

mod common;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use common::{fast_kdf, text_corpus};
use serblenotes_core::{
    derive_key, generate_salt, generate_vault_key, open, rewrap_vault_key, seal, KdfParams,
};

#[test]
fn every_text_shape_survives_a_round_trip() {
    let key = generate_vault_key();

    for (name, text) in text_corpus() {
        let sealed = seal(&key, &text).unwrap_or_else(|e| panic!("sealing {name} failed: {e}"));
        let opened = open(&key, &sealed).unwrap_or_else(|e| panic!("opening {name} failed: {e}"));
        assert_eq!(opened, text, "round trip changed the content of: {name}");
    }
}

#[test]
fn a_one_megabyte_note_round_trips() {
    let key = generate_vault_key();
    let text: String = (0..30_000).map(|i| format!("line number {i} with some padding text\n")).collect();
    assert!(text.len() > 1_000_000);

    let sealed = seal(&key, &text).unwrap();
    assert_eq!(open(&key, &sealed).unwrap(), text);
}

#[test]
fn ciphertext_does_not_leak_the_plaintext() {
    let key = generate_vault_key();
    let secret = "the password to the safe is swordfish";
    let sealed = seal(&key, secret).unwrap();

    let raw = B64.decode(&sealed).unwrap();
    assert!(
        !String::from_utf8_lossy(&raw).contains("swordfish"),
        "plaintext appeared in the ciphertext"
    );
    assert!(!sealed.contains("swordfish"));
}

#[test]
fn sealing_the_same_text_never_repeats_a_nonce() {
    let key = generate_vault_key();
    let mut seen = std::collections::HashSet::new();

    // Nonce reuse under one key breaks the cipher outright, so this needs volume, not one sample.
    for _ in 0..2_000 {
        let sealed = seal(&key, "identical content every time").unwrap();
        let raw = B64.decode(&sealed).unwrap();
        let nonce = raw[..24].to_vec();
        assert!(seen.insert(nonce), "a nonce was reused");
    }
}

#[test]
fn a_wrong_key_is_rejected_rather_than_returning_garbage() {
    let sealed = seal(&generate_vault_key(), "sensitive note").unwrap();

    for _ in 0..50 {
        assert!(open(&generate_vault_key(), &sealed).is_err());
    }
}

#[test]
fn flipping_any_single_byte_is_detected() {
    let key = generate_vault_key();
    let sealed = seal(&key, "# Important\n\nDo not lose this.\n").unwrap();
    let raw = B64.decode(&sealed).unwrap();

    // Nonce, ciphertext and authentication tag all live in this blob. Corruption anywhere in it -
    // a bad disk, a truncated upload, a meddling server - must fail loudly.
    for index in 0..raw.len() {
        let mut damaged = raw.clone();
        damaged[index] ^= 0x01;
        let result = open(&key, &B64.encode(&damaged));
        assert!(result.is_err(), "corruption at byte {index} was not detected");
    }
}

#[test]
fn truncated_payloads_are_rejected() {
    let key = generate_vault_key();
    let sealed = seal(&key, "some content here").unwrap();
    let raw = B64.decode(&sealed).unwrap();

    for length in 0..raw.len() {
        let result = open(&key, &B64.encode(&raw[..length]));
        assert!(result.is_err(), "a payload truncated to {length} bytes was accepted");
    }
}

#[test]
fn malformed_payloads_produce_errors_not_panics() {
    let key = generate_vault_key();

    for payload in ["", "not base64!!!", "////", "AAAA", &"A".repeat(1000)] {
        assert!(open(&key, payload).is_err(), "payload {payload:?} was accepted");
    }
}

#[test]
fn malformed_keys_produce_errors_not_panics() {
    let sealed = seal(&generate_vault_key(), "content").unwrap();

    let bad_keys = [
        ("empty", String::new()),
        ("not base64", "!!!!".to_string()),
        ("too short", B64.encode([0u8; 16])),
        ("too long", B64.encode([0u8; 64])),
        ("one byte short", B64.encode([0u8; 31])),
        ("one byte long", B64.encode([0u8; 33])),
    ];

    for (name, key) in bad_keys {
        assert!(open(&key, &sealed).is_err(), "opening accepted a {name} key");
        assert!(seal(&key, "x").is_err(), "sealing accepted a {name} key");
    }
}

#[test]
fn generated_keys_are_the_right_size_and_never_repeat() {
    let mut seen = std::collections::HashSet::new();

    for _ in 0..1_000 {
        let key = generate_vault_key();
        assert_eq!(B64.decode(&key).unwrap().len(), 32);
        assert!(seen.insert(key), "generate_vault_key repeated a key");
    }
}

#[test]
fn generated_salts_never_repeat() {
    let mut seen = std::collections::HashSet::new();

    for _ in 0..1_000 {
        assert!(seen.insert(generate_salt()), "generate_salt repeated a salt");
    }
}

#[test]
fn the_same_password_and_salt_always_derive_the_same_key() {
    let salt = generate_salt();

    // This is the whole basis of "enter the password once per device". If it ever stops holding,
    // every existing vault becomes unopenable.
    let first = derive_key("correct horse battery staple", &salt, &fast_kdf()).unwrap();
    for _ in 0..10 {
        let again = derive_key("correct horse battery staple", &salt, &fast_kdf()).unwrap();
        assert_eq!(first, again);
    }
}

#[test]
fn changing_anything_about_the_derivation_changes_the_key() {
    let salt = generate_salt();
    let other_salt = generate_salt();
    let baseline = derive_key("password", &salt, &fast_kdf()).unwrap();

    assert_ne!(baseline, derive_key("passwore", &salt, &fast_kdf()).unwrap(), "one letter");
    assert_ne!(baseline, derive_key("Password", &salt, &fast_kdf()).unwrap(), "case");
    assert_ne!(baseline, derive_key("password ", &salt, &fast_kdf()).unwrap(), "trailing space");
    assert_ne!(baseline, derive_key("", &salt, &fast_kdf()).unwrap(), "empty");
    assert_ne!(baseline, derive_key("password", &other_salt, &fast_kdf()).unwrap(), "salt");
    assert_ne!(baseline, derive_key("password", &salt, &KdfParams::new(16, 1, 1)).unwrap(), "memory");
    assert_ne!(baseline, derive_key("password", &salt, &KdfParams::new(8, 2, 1)).unwrap(), "iterations");
}

#[test]
fn unusual_passwords_still_derive_a_key() {
    let salt = generate_salt();

    let very_long = "a".repeat(10_000);
    let passwords = [
        "",
        " ",
        "🔐🔐🔐",
        "パスワード",
        very_long.as_str(),
        "line\nbreak",
        "nul\u{0}byte",
        "tab\tseparated",
    ];

    for password in passwords {
        let key = derive_key(password, &salt, &fast_kdf())
            .unwrap_or_else(|e| panic!("password {password:?} failed: {e}"));
        assert_eq!(B64.decode(&key).unwrap().len(), 32);
    }
}

#[test]
fn invalid_kdf_input_errors_instead_of_panicking() {
    // Argon2 rejects these parameter combinations; the failure has to arrive as an error the UI can
    // show, not as a panic that takes the whole WASM module down with it.
    assert!(derive_key("password", &generate_salt(), &KdfParams::new(0, 1, 1)).is_err(), "zero memory");
    assert!(derive_key("password", &generate_salt(), &KdfParams::new(8, 0, 1)).is_err(), "zero iterations");
    assert!(derive_key("password", &generate_salt(), &KdfParams::new(8, 1, 0)).is_err(), "zero parallelism");

    assert!(derive_key("password", "not base64!!", &fast_kdf()).is_err(), "bad salt encoding");
    assert!(derive_key("password", "", &fast_kdf()).is_err(), "empty salt");
}

#[test]
fn a_vault_key_survives_being_wrapped_and_unwrapped() {
    for _ in 0..25 {
        let salt = generate_salt();
        let vault_key = generate_vault_key();
        let wrapping_key = derive_key("vault password", &salt, &fast_kdf()).unwrap();

        let wrapped = seal(&wrapping_key, &vault_key).unwrap();
        let recovered_wrapping_key = derive_key("vault password", &salt, &fast_kdf()).unwrap();

        assert_eq!(open(&recovered_wrapping_key, &wrapped).unwrap(), vault_key);
    }
}

#[test]
fn a_wrong_vault_password_cannot_unwrap_the_key() {
    let salt = generate_salt();
    let vault_key = generate_vault_key();
    let wrapped = seal(&derive_key("right", &salt, &fast_kdf()).unwrap(), &vault_key).unwrap();

    let wrong = derive_key("wrong", &salt, &fast_kdf()).unwrap();
    assert!(open(&wrong, &wrapped).is_err());
}

// --- changing a vault password -------------------------------------------------------------------
// A password change rewraps the key and rewrites the stored blob. There is no copy of the old blob
// anywhere afterwards, so anything that goes wrong here loses the whole vault. Every test below is
// about the moment of the swap.

#[test]
fn a_changed_password_opens_the_vault_and_the_old_one_does_not() {
    let salt = generate_salt();
    let key = generate_vault_key();
    let wrapped = seal(&derive_key("first", &salt, &fast_kdf()).unwrap(), &key).unwrap();

    let changed =
        rewrap_vault_key(&wrapped, "first", &salt, &fast_kdf(), "second", &fast_kdf()).unwrap();

    let with_new = derive_key("second", &changed.salt(), &fast_kdf()).unwrap();
    assert_eq!(open(&with_new, &changed.wrapped_key()).unwrap(), key);

    let with_old = derive_key("first", &changed.salt(), &fast_kdf()).unwrap();
    assert!(open(&with_old, &changed.wrapped_key()).is_err(), "the old password still opened it");
}

#[test]
fn the_vault_key_survives_a_thousand_password_changes() {
    // Every note in a vault is sealed with this key, so a rewrap that quietly returned a *different*
    // key would leave a vault that opens and is empty of anything readable.
    let mut salt = generate_salt();
    let key = generate_vault_key();
    let mut wrapped = seal(&derive_key("pw0", &salt, &fast_kdf()).unwrap(), &key).unwrap();

    for round in 0..1_000 {
        let old = format!("pw{round}");
        let new = format!("pw{}", round + 1);
        let changed = rewrap_vault_key(&wrapped, &old, &salt, &fast_kdf(), &new, &fast_kdf())
            .unwrap_or_else(|e| panic!("round {round} failed: {e}"));

        assert_eq!(changed.key(), key, "the vault key changed at round {round}");
        salt = changed.salt();
        wrapped = changed.wrapped_key();
    }

    let final_key = derive_key("pw1000", &salt, &fast_kdf()).unwrap();
    assert_eq!(open(&final_key, &wrapped).unwrap(), key);
}

#[test]
fn a_wrong_current_password_is_refused_before_anything_is_rewrapped() {
    let salt = generate_salt();
    let wrapped = seal(&derive_key("right", &salt, &fast_kdf()).unwrap(), &generate_vault_key()).unwrap();

    for wrong in ["", "Right", "right ", " right", "wrong", "righ"] {
        assert!(
            rewrap_vault_key(&wrapped, wrong, &salt, &fast_kdf(), "new", &fast_kdf()).is_err(),
            "a rewrap was allowed with the wrong current password: {wrong:?}"
        );
    }
}

#[test]
fn a_corrupted_stored_blob_fails_rather_than_producing_a_new_one() {
    // If the blob the server sent back cannot be opened, writing a *fresh* wrapping of whatever came
    // out of it would replace the only real copy with nonsense.
    let salt = generate_salt();
    let wrapped = seal(&derive_key("pw", &salt, &fast_kdf()).unwrap(), &generate_vault_key()).unwrap();

    let mut raw = B64.decode(&wrapped).unwrap();
    raw[30] ^= 0x01;
    let corrupted = B64.encode(&raw);

    assert!(rewrap_vault_key(&corrupted, "pw", &salt, &fast_kdf(), "new", &fast_kdf()).is_err());
    assert!(rewrap_vault_key("not base64!!", "pw", &salt, &fast_kdf(), "new", &fast_kdf()).is_err());
    assert!(rewrap_vault_key("", "pw", &salt, &fast_kdf(), "new", &fast_kdf()).is_err());
}

#[test]
fn every_rewrap_uses_a_fresh_salt_and_fresh_ciphertext() {
    let salt = generate_salt();
    let key = generate_vault_key();
    let wrapped = seal(&derive_key("pw", &salt, &fast_kdf()).unwrap(), &key).unwrap();

    let first = rewrap_vault_key(&wrapped, "pw", &salt, &fast_kdf(), "same", &fast_kdf()).unwrap();
    let second = rewrap_vault_key(&wrapped, "pw", &salt, &fast_kdf(), "same", &fast_kdf()).unwrap();

    assert_ne!(first.salt(), second.salt(), "the salt was reused");
    assert_ne!(first.salt(), salt, "the old salt was kept");
    assert_ne!(first.wrapped_key(), second.wrapped_key());
}

#[test]
fn any_password_the_user_chooses_is_accepted_as_the_new_one() {
    // No minimum length, no required characters: see "Inform, never forbid". An empty new password is
    // a decision the user is allowed to make, and it has to actually work afterwards.
    let salt = generate_salt();
    let key = generate_vault_key();
    let wrapped = seal(&derive_key("pw", &salt, &fast_kdf()).unwrap(), &key).unwrap();

    for new in ["", " ", "a", "\n", "correct horse battery staple", "🔐🔐🔐", "パスワード"] {
        let changed = rewrap_vault_key(&wrapped, "pw", &salt, &fast_kdf(), new, &fast_kdf())
            .unwrap_or_else(|e| panic!("new password {new:?} was refused: {e}"));

        let wrapping = derive_key(new, &changed.salt(), &fast_kdf()).unwrap();
        assert_eq!(open(&wrapping, &changed.wrapped_key()).unwrap(), key);
    }
}

#[test]
fn a_password_change_can_raise_the_kdf_cost() {
    let salt = generate_salt();
    let key = generate_vault_key();
    let wrapped = seal(&derive_key("pw", &salt, &KdfParams::new(8, 1, 1)).unwrap(), &key).unwrap();

    let stronger = KdfParams::new(64, 2, 1);
    let changed =
        rewrap_vault_key(&wrapped, "pw", &salt, &KdfParams::new(8, 1, 1), "pw", &stronger).unwrap();

    // The new blob is bound to the new parameters: deriving under the old ones must not open it.
    assert_eq!(
        open(&derive_key("pw", &changed.salt(), &stronger).unwrap(), &changed.wrapped_key()).unwrap(),
        key
    );
    assert!(open(
        &derive_key("pw", &changed.salt(), &KdfParams::new(8, 1, 1)).unwrap(),
        &changed.wrapped_key()
    )
    .is_err());
}

#[test]
fn invalid_kdf_parameters_error_instead_of_panicking() {
    let salt = generate_salt();
    let wrapped = seal(&derive_key("pw", &salt, &fast_kdf()).unwrap(), &generate_vault_key()).unwrap();

    assert!(rewrap_vault_key(&wrapped, "pw", &salt, &fast_kdf(), "new", &KdfParams::new(0, 1, 1)).is_err());
    assert!(rewrap_vault_key(&wrapped, "pw", "not base64!!", &fast_kdf(), "new", &fast_kdf()).is_err());
}

/// The KDF parameters a new vault is created under.
///
/// Nothing else in this suite reads them: every other test builds its own deliberately-weak params
/// so it runs in milliseconds, which means `recommended()` could return anything at all and the
/// whole suite would still pass. It is the only thing standing between a vault password and someone
/// with the wrapped blob, so what is pinned here is a floor rather than an exact number - the
/// figures are meant to be raised, and a test that had to be edited every time they were would be
/// deleted the second time.
#[test]
fn the_recommended_kdf_parameters_are_strong_enough_to_be_worth_using() {
    let params = KdfParams::recommended();

    // OWASP's floor for Argon2id is 19 MiB and 2 passes. Below this, deriving a key stops being
    // meaningfully expensive and the wrapping is decoration.
    assert!(
        params.memory_kib() >= 19 * 1024,
        "memory_kib was {}, which is below the point where Argon2id is worth running",
        params.memory_kib()
    );
    assert!(params.iterations() >= 2, "iterations was {}", params.iterations());
    assert!(params.parallelism() >= 1, "parallelism was {}", params.parallelism());
}

#[test]
fn kdf_parameters_are_reported_as_they_were_given() {
    // The three getters are how the parameters reach the server and come back, so a vault made today
    // can be opened under the parameters it was made with. One that lied would seal a vault under
    // settings nobody could reproduce - the blob would be intact and permanently unopenable.
    let params = KdfParams::new(1234, 7, 2);

    assert_eq!(params.memory_kib(), 1234);
    assert_eq!(params.iterations(), 7);
    assert_eq!(params.parallelism(), 2);
}

#[test]
fn the_recommended_parameters_actually_derive_a_key_that_works() {
    // Not just plausible numbers: Argon2 rejects some combinations outright, and a vault created
    // with parameters that cannot derive would fail at the moment it was made.
    let salt = generate_salt();
    let key = derive_key("correct horse", &salt, &KdfParams::recommended()).unwrap();
    let vault_key = generate_vault_key();
    let wrapped = seal(&key, &vault_key).unwrap();

    let again = derive_key("correct horse", &salt, &KdfParams::recommended()).unwrap();
    assert_eq!(open(&again, &wrapped).unwrap(), vault_key);
}
