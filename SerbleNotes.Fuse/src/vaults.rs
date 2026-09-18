//! Choosing which vault a command is about.

use crate::api::Vault;

/// A vault by id, or by name when that names exactly one.
///
/// An ambiguous name is refused rather than resolved by picking the first. Vault names are the one
/// thing about a vault the server can read, they are chosen by the user, and two vaults called
/// "Notes" is an ordinary thing to have - so guessing would mean mounting the wrong one and, from
/// there, writing notes into it.
///
/// The id wins over a name, and deliberately: a vault whose *name* happens to be another vault's
/// id must not be able to take that id's place.
pub fn find(vaults: &[Vault], wanted: &str) -> Result<Vault, String> {
    let live: Vec<&Vault> = vaults.iter().filter(|vault| !vault.deleted).collect();

    if let Some(vault) = live.iter().find(|vault| vault.id == wanted) {
        return Ok((*vault).clone());
    }

    let matching: Vec<&&Vault> = live.iter().filter(|vault| vault.name == wanted).collect();
    match matching.as_slice() {
        [vault] => Ok((**vault).clone()),
        [] => Err(format!(
            "No vault called \"{wanted}\" on this account. `serblenotes-fuse vaults` lists them."
        )),
        several => Err(format!(
            "{} vaults are called \"{wanted}\". Use the id instead; `serblenotes-fuse vaults` \
             lists them.",
            several.len()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a_vault(id: &str, name: &str, deleted: bool) -> Vault {
        Vault {
            id: id.into(),
            name: name.into(),
            owner_id: "owner".into(),
            encrypted: false,
            wrapped_key: "key".into(),
            kdf_salt: None,
            kdf_params: None,
            cursor: 0,
            created_at: String::new(),
            updated_at: String::new(),
            deleted,
        }
    }

    #[test]
    fn an_id_finds_its_vault() {
        let vaults = [a_vault("id-1", "Notes", false), a_vault("id-2", "Work", false)];
        assert_eq!(find(&vaults, "id-2").unwrap().name, "Work");
    }

    #[test]
    fn a_name_finds_its_vault_when_it_names_only_one() {
        let vaults = [a_vault("id-1", "Notes", false), a_vault("id-2", "Work", false)];
        assert_eq!(find(&vaults, "Work").unwrap().id, "id-2");
    }

    #[test]
    fn a_name_that_names_two_is_refused_rather_than_guessed() {
        // Mounting the wrong vault means writing notes into it.
        let vaults = [a_vault("id-1", "Notes", false), a_vault("id-2", "Notes", false)];
        let refused = find(&vaults, "Notes").unwrap_err();
        assert!(refused.contains("2 vaults"), "{refused}");
        assert!(refused.contains("Use the id"));
    }

    #[test]
    fn a_deleted_vault_is_not_there_to_be_found() {
        let vaults = [a_vault("id-1", "Notes", true)];
        assert!(find(&vaults, "id-1").is_err());
        assert!(find(&vaults, "Notes").is_err());
    }

    #[test]
    fn a_deleted_vault_does_not_make_a_live_name_ambiguous() {
        let vaults = [a_vault("id-1", "Notes", true), a_vault("id-2", "Notes", false)];
        assert_eq!(find(&vaults, "Notes").unwrap().id, "id-2");
    }

    #[test]
    fn an_id_wins_over_a_name_that_happens_to_match_it() {
        // Otherwise a vault could be named after another vault's id and take its place.
        let vaults = [a_vault("id-1", "id-2", false), a_vault("id-2", "Work", false)];
        assert_eq!(find(&vaults, "id-2").unwrap().name, "Work");
    }

    #[test]
    fn nothing_matching_says_how_to_look() {
        let refused = find(&[a_vault("id-1", "Notes", false)], "Missing").unwrap_err();
        assert!(refused.contains("serblenotes-fuse vaults"), "{refused}");
    }

    #[test]
    fn an_empty_account_is_not_a_panic() {
        assert!(find(&[], "anything").is_err());
    }
}
