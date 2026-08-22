//! Where an unlocked vault key is kept on this device.
//!
//! This is the whole reason the desktop and Android clients are worth having over the web one:
//! "enter the vault password once per device" needs somewhere to put the key that is better than a
//! browser's local storage. On desktop that is the OS keychain. On Android it is a file inside the
//! app's private storage, which other apps cannot read.
//!
//! Nothing here ever sees a password, and nothing here ever talks to the server. A vault key is
//! produced by the Rust core in the webview, from a password the user typed, and only the result is
//! handed over for safekeeping.
//!
//! Deliberately free of `tauri` types so it can be compiled and exercised on its own.

use std::collections::BTreeMap;
use std::path::PathBuf;

pub struct Store {
    /// Only used by the mobile backend; the desktop one keeps nothing of its own on disk.
    #[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
    dir: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }
}

// --- desktop: the OS keychain --------------------------------------------------------------------

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod backend {
    use super::Store;
    use keyring::{Entry, Error};

    /// Named for the app rather than for a vault: the keychain entry per vault is the *account*, so
    /// all of them group under one service and can be found again.
    const SERVICE: &str = "net.serble.notes";

    fn entry(id: &str) -> Result<Entry, String> {
        Entry::new(SERVICE, id).map_err(describe)
    }

    /// Keychain errors reach the user, so they say what went wrong rather than printing a debug
    /// struct. The one that actually happens is a Linux session with no Secret Service running.
    fn describe(error: Error) -> String {
        match error {
            Error::NoStorageAccess(_) | Error::PlatformFailure(_) => {
                format!("This device's keychain is not available ({error}).")
            }
            other => other.to_string(),
        }
    }

    impl Store {
        pub fn backend(&self) -> &'static str {
            "keychain"
        }

        pub fn set(&self, id: &str, value: &str) -> Result<(), String> {
            entry(id)?.set_password(value).map_err(describe)
        }

        pub fn get(&self, id: &str) -> Result<Option<String>, String> {
            match entry(id)?.get_password() {
                Ok(value) => Ok(Some(value)),
                // Not having a key is an ordinary answer, not a failure: it means this device has
                // never unlocked that vault.
                Err(Error::NoEntry) => Ok(None),
                Err(error) => Err(describe(error)),
            }
        }

        pub fn delete(&self, id: &str) -> Result<(), String> {
            match entry(id)?.delete_credential() {
                Ok(()) | Err(Error::NoEntry) => Ok(()),
                Err(error) => Err(describe(error)),
            }
        }
    }
}

// --- mobile: the app's own private storage -------------------------------------------------------

#[cfg(any(target_os = "android", target_os = "ios"))]
mod backend {
    use super::{read_all, write_all, Store};

    impl Store {
        pub fn backend(&self) -> &'static str {
            "app-storage"
        }

        pub fn set(&self, id: &str, value: &str) -> Result<(), String> {
            let mut all = read_all(&self.dir)?;
            all.insert(id.to_string(), value.to_string());
            write_all(&self.dir, &all)
        }

        pub fn get(&self, id: &str) -> Result<Option<String>, String> {
            Ok(read_all(&self.dir)?.get(id).cloned())
        }

        pub fn delete(&self, id: &str) -> Result<(), String> {
            let mut all = read_all(&self.dir)?;
            if all.remove(id).is_none() {
                return Ok(());
            }
            write_all(&self.dir, &all)
        }
    }
}

#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
fn path(dir: &PathBuf) -> PathBuf {
    dir.join("vault-keys.json")
}

#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
fn read_all(dir: &PathBuf) -> Result<BTreeMap<String, String>, String> {
    let file = path(dir);
    if !file.exists() {
        return Ok(BTreeMap::new());
    }

    let text = std::fs::read_to_string(&file).map_err(|e| format!("Could not read stored keys: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("Stored keys are unreadable: {e}"))
}

#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
fn write_all(dir: &PathBuf, all: &BTreeMap<String, String>) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not create the app's data folder: {e}"))?;

    let text = serde_json::to_string(all).map_err(|e| format!("Could not encode stored keys: {e}"))?;
    let file = path(dir);

    // Write beside it and rename over the top. A half-written file here would lock the user out of
    // every vault on this device at once, and rename is the one filesystem operation that cannot
    // leave that behind.
    let temporary = file.with_extension("json.new");
    std::fs::write(&temporary, text).map_err(|e| format!("Could not save keys: {e}"))?;
    restrict(&temporary)?;
    std::fs::rename(&temporary, &file).map_err(|e| format!("Could not save keys: {e}"))
}

#[cfg(unix)]
#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
fn restrict(file: &PathBuf) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("Could not lock down the key file: {e}"))
}

#[cfg(not(unix))]
#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
fn restrict(_file: &PathBuf) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The mobile backend is compiled out on desktop, so its file handling is tested directly. A
    /// bug in here loses every vault key on the device, which is the same as losing the vaults.
    #[test]
    fn stored_keys_round_trip() {
        let dir = std::env::temp_dir().join(format!("serblenotes-secrets-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        assert!(read_all(&dir).unwrap().is_empty(), "a device with no keys yet reads as empty");

        let mut all = BTreeMap::new();
        all.insert("vault-1".to_string(), "a-key".to_string());
        all.insert("vault-2".to_string(), "another-key".to_string());
        write_all(&dir, &all).unwrap();

        assert_eq!(read_all(&dir).unwrap(), all);

        all.remove("vault-1");
        write_all(&dir, &all).unwrap();
        let back = read_all(&dir).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back.get("vault-2").map(String::as_str), Some("another-key"));

        std::fs::write(path(&dir), "not json").unwrap();
        assert!(read_all(&dir).is_err(), "a corrupt file must fail loudly, not read as empty");

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
