//! Getting hold of a vault's key.
//!
//! A vault has one random content key and everything stored for it is sealed with that key. How the
//! key is protected is the whole difference between the two kinds of vault, and this is the only
//! place in this program that a password is ever turned into key material - through the core, which
//! is the only place in the project that happens at all.

use serde::{Deserialize, Serialize};
use serblenotes_core::{derive_key, open, KdfParams};

use crate::api::Vault;
use crate::config::KeyStore;

/// Argon2id settings, as they are stored on the vault. Written by whichever client created it, so
/// the shape is the web client's `StoredKdfParams` and the names are its names.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredKdf {
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
}

impl Default for StoredKdf {
    /// What a vault made today uses: 64 MiB and 3 passes. Only reached for a vault that stored no
    /// parameters at all - the stored ones always win, which is the point of storing them.
    fn default() -> StoredKdf {
        StoredKdf {
            memory_kib: 64 * 1024,
            iterations: 3,
            parallelism: 1,
        }
    }
}

impl StoredKdf {
    fn of(vault: &Vault) -> StoredKdf {
        vault
            .kdf_params
            .as_deref()
            .and_then(|json| serde_json::from_str(json).ok())
            .unwrap_or_default()
    }
}

/// Whether this vault needs a password at all.
pub fn needs_password(vault: &Vault, keys: &KeyStore) -> bool {
    vault.encrypted && keys.get(&vault.id).is_none()
}

/// The key for a vault this device has already unlocked, or for one that was never encrypted.
///
/// For an unencrypted vault the stored "wrapped" key is simply the key, in the clear, which means
/// the server can read every note in it. That is the documented trade-off of that vault type and
/// not an oversight - but nothing in this program may present such a vault as private, which is why
/// `describe_privacy` exists and is printed on every mount.
pub fn cached_key(vault: &Vault, keys: &KeyStore) -> Option<String> {
    if !vault.encrypted {
        return Some(vault.wrapped_key.clone());
    }
    keys.get(&vault.id)
}

/// Unwraps the vault key with a password. A wrong password fails as a decryption error, which is
/// the only check there can be: the server holds a blob it cannot open and has nothing to compare
/// against.
pub fn unlock(vault: &Vault, password: &str) -> Result<String, String> {
    let salt = vault
        .kdf_salt
        .as_deref()
        .ok_or("This vault is missing its salt and cannot be unlocked.")?;

    let stored = StoredKdf::of(vault);
    let params = KdfParams::new(stored.memory_kib, stored.iterations, stored.parallelism);
    let wrapping_key = derive_key(password, salt, &params)?;

    open(&wrapping_key, &vault.wrapped_key)
        .map_err(|_| "That is not this vault's password.".to_string())
}

/// Where a vault password is coming from on this run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PasswordSource {
    /// Given on the command line. Convenient, and visible to anyone who can list processes.
    Given(String),
    /// To be read from standard input.
    Stdin,
    /// From `SERBLENOTES_VAULT_PASSWORD`.
    Environment(String),
    /// Nothing supplied it, so a person has to be asked.
    Ask,
}

/// Which of them applies, in order.
///
/// **An empty password is a real password**, and no level here may treat one as absent - that is
/// the "Inform, never forbid" rule from CLAUDE.md reaching this far down. A vault whose password is
/// the empty string is badly protected and still end-to-end encrypted, and a client that quietly
/// turned `--password ''` into a prompt would make it impossible to open one without a terminal.
///
/// This is why the environment variable is read with `.ok()` and never filtered for emptiness, and
/// why it differs from the server and the session above it, where empty genuinely does mean unset.
pub fn password_source(
    given: Option<&str>,
    from_stdin: bool,
    from_env: Option<&str>,
) -> PasswordSource {
    if let Some(given) = given {
        return PasswordSource::Given(given.to_string());
    }
    if from_stdin {
        return PasswordSource::Stdin;
    }
    match from_env {
        Some(password) => PasswordSource::Environment(password.to_string()),
        None => PasswordSource::Ask,
    }
}

/// One sentence about who can read this vault, printed wherever a vault is opened.
///
/// Said every time rather than once at creation, because the person mounting a vault on a server
/// somewhere is not necessarily the person who chose how it was made.
pub fn describe_privacy(vault: &Vault) -> &'static str {
    if vault.encrypted {
        "end-to-end encrypted: the server holds ciphertext it cannot read"
    } else {
        "NOT encrypted: this vault's key is stored on the server, which can read every note in it"
    }
}

/// Where an unlocked key is kept on this machine, in one sentence.
///
/// **A file, not the system keychain.** The desktop app uses Secret Service, Credential Manager or
/// Keychain, and this does not - a mount usually runs on a machine with no session bus to talk to,
/// and a keychain that cannot be reached is worse than a file, because it makes the promise and
/// then does not keep it. Saying which it is, rather than implying the stronger one, is the rule in
/// CLAUDE.md and this is the sentence that keeps it.
pub fn describe_key_storage() -> String {
    format!(
        "The key is kept in {} (readable only by you), not in a system keychain. \
         'serblenotes-fuse forget' removes it.",
        crate::config::keys_path().display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serblenotes_core::{generate_salt, generate_vault_key, seal, KdfParams};

    fn a_vault(encrypted: bool, wrapped_key: &str, salt: Option<&str>, params: Option<&str>) -> Vault {
        Vault {
            id: "v1".into(),
            name: "Notes".into(),
            owner_id: "owner".into(),
            encrypted,
            wrapped_key: wrapped_key.into(),
            kdf_salt: salt.map(str::to_string),
            kdf_params: params.map(str::to_string),
            cursor: 0,
            created_at: String::new(),
            updated_at: String::new(),
            deleted: false,
        }
    }

    /// A vault wrapped with deliberately cheap parameters, so the tests do not spend 64 MiB each.
    fn a_locked_vault(password: &str) -> (Vault, String) {
        let key = generate_vault_key();
        let salt = generate_salt();
        let stored = StoredKdf { memory_kib: 8, iterations: 1, parallelism: 1 };
        let params = KdfParams::new(stored.memory_kib, stored.iterations, stored.parallelism);
        let wrapping = serblenotes_core::derive_key(password, &salt, &params).unwrap();
        let wrapped = seal(&wrapping, &key).unwrap();

        let vault = a_vault(
            true,
            &wrapped,
            Some(&salt),
            Some(&serde_json::to_string(&stored).unwrap()),
        );
        (vault, key)
    }

    // --- where the password comes from ----------------------------------------------------------

    #[test]
    fn the_order_is_flag_then_stdin_then_environment_then_a_person() {
        assert_eq!(
            password_source(Some("flag"), true, Some("env")),
            PasswordSource::Given("flag".into())
        );
        assert_eq!(password_source(None, true, Some("env")), PasswordSource::Stdin);
        assert_eq!(
            password_source(None, false, Some("env")),
            PasswordSource::Environment("env".into())
        );
        assert_eq!(password_source(None, false, None), PasswordSource::Ask);
    }

    #[test]
    fn an_empty_password_is_a_password_and_not_an_absent_one() {
        // Otherwise a vault with an empty password could not be opened without a terminal, and the
        // whole point of the flags is that there does not have to be one.
        assert_eq!(password_source(Some(""), false, None), PasswordSource::Given(String::new()));
        assert_eq!(
            password_source(None, false, Some("")),
            PasswordSource::Environment(String::new())
        );
    }

    // --- unlocking ------------------------------------------------------------------------------

    #[test]
    fn the_right_password_gives_back_the_vaults_own_key() {
        let (vault, key) = a_locked_vault("correct horse");
        assert_eq!(unlock(&vault, "correct horse").unwrap(), key);
    }

    #[test]
    fn a_wrong_password_fails_rather_than_returning_something() {
        // The only check there can be: the server holds a blob it cannot open and has nothing to
        // compare against, so "is this the password" only ever means "does it unwrap the key".
        let (vault, _) = a_locked_vault("correct horse");
        assert!(unlock(&vault, "correct hors").is_err());
        assert!(unlock(&vault, "").is_err());
    }

    #[test]
    fn an_empty_password_unlocks_a_vault_that_has_one() {
        let (vault, key) = a_locked_vault("");
        assert_eq!(unlock(&vault, "").unwrap(), key);
        assert!(unlock(&vault, "something").is_err());
    }

    #[test]
    fn a_vault_with_no_salt_says_so_rather_than_deriving_from_nothing() {
        let vault = a_vault(true, "d3JhcHBlZA==", None, None);
        let refused = unlock(&vault, "anything").unwrap_err();
        assert!(refused.contains("salt"), "{refused}");
    }

    // --- the stored cost parameters -------------------------------------------------------------

    #[test]
    fn the_parameters_a_vault_was_made_with_are_the_ones_used() {
        // Not today's defaults. A vault made under weaker settings still has to open, or raising
        // the recommended cost would lock everybody out of every vault they already had.
        let stored = StoredKdf::of(&a_vault(
            true,
            "k",
            Some("s"),
            Some(r#"{"memoryKib":19456,"iterations":2,"parallelism":1}"#),
        ));
        assert_eq!(stored.memory_kib, 19456);
        assert_eq!(stored.iterations, 2);
    }

    #[test]
    fn a_vault_that_stored_no_parameters_gets_todays() {
        for params in [None, Some("not json"), Some("{}"), Some("null")] {
            let stored = StoredKdf::of(&a_vault(true, "k", Some("s"), params));
            let default = StoredKdf::default();
            assert_eq!(
                (stored.memory_kib, stored.iterations, stored.parallelism),
                (default.memory_kib, default.iterations, default.parallelism),
                "params {params:?} should have fallen back"
            );
        }
    }

    #[test]
    fn the_default_is_what_the_other_clients_write() {
        // Shared with the web client's DEFAULT_KDF. Drifting apart means a vault made in one client
        // and opened in the other derives a different key from the same password.
        let default = StoredKdf::default();
        assert_eq!(default.memory_kib, 64 * 1024);
        assert_eq!(default.iterations, 3);
        assert_eq!(default.parallelism, 1);
    }

    #[test]
    fn the_stored_shape_is_the_one_the_other_clients_wrote() {
        // camelCase, because the web client stores `JSON.stringify(DEFAULT_KDF)`. A field spelled
        // differently here reads as absent and silently falls back to the defaults - which opens
        // nothing, on a vault that was made with anything else.
        let json = serde_json::to_string(&StoredKdf::default()).unwrap();
        assert!(json.contains("memoryKib"), "{json}");
        assert!(json.contains("iterations"));
        assert!(json.contains("parallelism"));
    }

    // --- what a vault is, said out loud ---------------------------------------------------------

    #[test]
    fn an_unencrypted_vault_hands_back_its_key_without_a_password() {
        // The stored "wrapped" key is the key. That is the documented trade-off of that vault kind.
        let vault = a_vault(false, "dGhlIGtleQ==", None, None);
        assert_eq!(cached_key(&vault, &KeyStore::default()).as_deref(), Some("dGhlIGtleQ=="));
        assert!(!needs_password(&vault, &KeyStore::default()));
    }

    #[test]
    fn an_encrypted_vault_this_machine_has_not_opened_needs_a_password() {
        let (vault, _) = a_locked_vault("p");
        assert!(needs_password(&vault, &KeyStore::default()));
        assert!(cached_key(&vault, &KeyStore::default()).is_none());
    }

    #[test]
    fn an_unencrypted_vault_is_never_described_as_private() {
        let said = describe_privacy(&a_vault(false, "k", None, None));
        assert!(said.contains("NOT encrypted"), "{said}");
        assert!(said.contains("server"), "it has to say who can read it: {said}");

        let encrypted = describe_privacy(&a_vault(true, "k", Some("s"), None));
        assert!(encrypted.contains("end-to-end"), "{encrypted}");
        assert_ne!(said, encrypted);
    }

    #[test]
    fn where_the_key_is_kept_is_said_plainly_and_not_dressed_up() {
        // The rule from CLAUDE.md: say which it is, never imply the stronger one.
        let said = describe_key_storage();
        assert!(said.contains("not in a system keychain"), "{said}");
        assert!(said.contains("keys.json"), "{said}");
        assert!(said.contains("forget"), "it has to say how to undo it: {said}");
    }
}
