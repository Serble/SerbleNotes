//! Where this client keeps what it has to remember between runs.
//!
//! Three things, in three places, for three different reasons:
//!
//! - **The session** - the server's address, this backend's JWT, and this device's id - in the
//!   config directory. The token is a credential, so the file is 0600.
//! - **Unlocked vault keys**, in the data directory, also 0600. **This is a file, not the system
//!   keychain, and this client says so wherever it offers to remember one.** The desktop and
//!   Android apps use the keychain where there is one and a 0600 file on Android where there is
//!   not; the rule from CLAUDE.md is that we say which it is and never imply the stronger one. A
//!   long-running mount on a headless machine is the main thing this tool is for, and a headless
//!   machine usually has no Secret Service to talk to, so a file it is - and `forget` exists.
//! - **Cached ciphertext and unsent edits**, in the cache directory, which is `cache.rs`.

use std::fs;
use std::io;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::ids::random_id;

const APP: &str = "serblenotes-fuse";

/// The server this copy was built for.
///
/// A build-time decision, the same one the packaged desktop and Android clients make with
/// `VITE_API_BASE_URL`, and for the same reason: a build belongs to a deployment, and asking the
/// person running it to type an address makes them answer a question the build already knew. Set
/// `SERBLENOTES_SERVER_URL` when compiling to point a build somewhere else.
///
/// It is only ever the last resort. `--server`, `SERBLENOTES_SERVER` and a saved session all win
/// over it, so a self-hosted deployment is one `login --server` away and stays that way.
pub const BUILT_IN_SERVER: &str = match option_env!("SERBLENOTES_SERVER_URL") {
    Some(url) => url,
    None => "https://notes.serble.net",
};

/// The session, as it sits on disk.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Origin of the backend, with no `/api` and no trailing slash.
    pub server: Option<String>,
    /// This backend's own JWT - not a Serble token. It lasts a year, which is why `logout` exists.
    pub token: Option<String>,
    /// Identifies this device so the server can label the versions it writes. Not a secret.
    pub device_id: Option<String>,
}

impl Settings {
    pub fn load() -> Settings {
        Settings::read_from(&settings_path())
    }

    pub fn save(&self) -> io::Result<()> {
        self.save_to(&settings_path())
    }

    /// From a named file, so the tests need no environment variables - two of them setting
    /// `XDG_CONFIG_HOME` at once is a data race, and one that leaked into the real one would
    /// overwrite somebody's session.
    pub fn read_from(path: &Path) -> Settings {
        read_json(path).unwrap_or_default()
    }

    pub fn save_to(&self, path: &Path) -> io::Result<()> {
        write_private(path, &serde_json::to_vec_pretty(self)?)
    }

    /// Where this run is pointed, given what the command line said.
    ///
    /// The environment is read here and the rest is [`choose_server`], which is a plain function
    /// over its three inputs so the order can be tested without a test having to set environment
    /// variables - which two tests running at once cannot do safely.
    pub fn choose_server(&self, flag: Option<&str>) -> ServerChoice {
        let from_env = std::env::var("SERBLENOTES_SERVER").ok();
        choose_server(flag, from_env.as_deref(), self.server.as_deref())
    }

    /// The server to talk to when nothing on the command line says otherwise. There is always one.
    pub fn server(&self) -> String {
        self.choose_server(None).url
    }

    /// The session for this run, given what the command line said.
    pub fn choose_token(&self, flag: Option<&str>) -> Option<String> {
        let from_env = std::env::var("SERBLENOTES_TOKEN").ok();
        choose_token(flag, from_env.as_deref(), self.token.as_deref())
    }

    pub fn token(&self) -> Option<String> {
        self.choose_token(None)
    }

    /// This device's id, made once and kept. Written back immediately: a device that invented a new
    /// id on every run would tag every version it wrote as coming from a device nobody has seen.
    pub fn device_id(&mut self) -> String {
        if let Some(id) = &self.device_id {
            return id.clone();
        }

        let id = random_id();
        self.device_id = Some(id.clone());
        let _ = self.save();
        id
    }
}

/// Vault keys this device has unlocked, by vault id.
///
/// The value is the vault key itself, base64, exactly as the core hands it back. Holding it is what
/// makes "type the password once on this machine" work, and it is also the whole of what an
/// attacker with this file needs to read the vault - which is why `forget` is a command and why
/// every place that offers to write one says it is a file.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct KeyStore {
    #[serde(default)]
    keys: std::collections::HashMap<String, String>,
    /// Where this one lives, when it is not the account's own. Never stored.
    #[serde(skip)]
    path: Option<PathBuf>,
}

impl KeyStore {
    pub fn load() -> KeyStore {
        KeyStore::read_from(&keys_path())
    }

    /// See [`Settings::read_from`].
    pub fn read_from(path: &Path) -> KeyStore {
        let mut store: KeyStore = read_json(path).unwrap_or_default();
        store.path = Some(path.to_path_buf());
        store
    }

    pub fn get(&self, vault_id: &str) -> Option<String> {
        self.keys.get(vault_id).cloned()
    }

    pub fn remember(&mut self, vault_id: &str, key: &str) -> io::Result<()> {
        self.keys.insert(vault_id.to_string(), key.to_string());
        self.save()
    }

    pub fn forget(&mut self, vault_id: &str) -> io::Result<bool> {
        let had = self.keys.remove(vault_id).is_some();
        self.save()?;
        Ok(had)
    }

    fn save(&self) -> io::Result<()> {
        let path = self.path.clone().unwrap_or_else(keys_path);
        write_private(&path, &serde_json::to_vec_pretty(self)?)
    }
}

/// Where a run is pointed, and whether that was this run's doing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerChoice {
    /// The origin to talk to, with no trailing slash. Never empty.
    pub url: String,
    /// True when this run named the server, rather than inheriting one that was already saved or
    /// falling back to the build's own. It is what decides whether `login` writes it down: saving
    /// an address nobody asked for would pin a build to whatever it happened to reach first, and a
    /// copy built for somewhere else would then keep going to the old place.
    pub given: bool,
}

/// The order: what this command was told, then the environment, then what was saved, then what this
/// copy was built for.
///
/// An empty string counts as nothing said, at every level. It is what an unset variable looks like
/// when a script exports it anyway, and resolving it to an empty address would fail later with
/// something about a URL rather than something about configuration.
pub fn choose_server(flag: Option<&str>, from_env: Option<&str>, saved: Option<&str>) -> ServerChoice {
    let named = [flag, from_env]
        .into_iter()
        .flatten()
        .find(|value| !value.is_empty());

    let url = named
        .or_else(|| saved.filter(|value| !value.is_empty()))
        .unwrap_or(BUILT_IN_SERVER);

    ServerChoice {
        url: url.trim_end_matches('/').to_string(),
        given: named.is_some(),
    }
}

/// The session to use, in the same order as the server: what this command was told, then the
/// environment, then what was saved.
///
/// There is no built-in fallback, because there is no such thing as a default session - `None` here
/// means "not signed in" and the caller says so. An empty string counts as nothing at every level,
/// which is what an exported-but-unset variable looks like; resolved as a token it would be sent as
/// `Bearer ` and come back as a 401 about authentication rather than about configuration.
pub fn choose_token(
    flag: Option<&str>,
    from_env: Option<&str>,
    saved: Option<&str>,
) -> Option<String> {
    [flag, from_env, saved]
        .into_iter()
        .flatten()
        .find(|value| !value.is_empty())
        .map(str::to_string)
}

pub fn settings_path() -> PathBuf {
    config_dir().join("config.json")
}

pub fn keys_path() -> PathBuf {
    data_dir().join("keys.json")
}

pub fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP)
}

pub fn data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP)
}

pub fn cache_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP)
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Writes a file only this user can read, and replaces the old one in one step.
///
/// Both halves matter. The mode is applied when the file is created rather than afterwards, so
/// there is no moment where a token sits on disk world-readable. The rename is what stops a crash
/// halfway through a write leaving a truncated config that the next run cannot parse - which, for
/// the key store, would read as "this device has never unlocked that vault".
pub fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
        // The directory too: a 0600 file in a 0755 directory still tells anyone who looks which
        // vaults this account has.
        let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
    }

    let temporary = path.with_extension("tmp");
    {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }

    fs::rename(&temporary, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir()
            .join(format!("serblenotes-config-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        root.join("file.json")
    }

    #[test]
    fn a_session_comes_back_as_it_went_in() {
        let path = scratch("session");
        let settings = Settings {
            server: Some("https://notes.example.com".into()),
            token: Some("a-token".into()),
            device_id: Some("a-device".into()),
        };
        settings.save_to(&path).unwrap();

        let read = Settings::read_from(&path);
        assert_eq!(read.server.as_deref(), Some("https://notes.example.com"));
        assert_eq!(read.token.as_deref(), Some("a-token"));
        assert_eq!(read.device_id.as_deref(), Some("a-device"));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn no_session_file_is_a_blank_session_rather_than_a_failure() {
        // The first run on a machine, which must not be an error.
        let settings = Settings::read_from(&scratch("absent"));
        assert!(settings.server.is_none());
        assert!(settings.token.is_none());
    }

    #[test]
    fn a_damaged_session_file_is_a_blank_session_rather_than_a_wrong_one() {
        let path = scratch("damaged");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{ interrupted").unwrap();

        assert!(Settings::read_from(&path).token.is_none());
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_device_id_is_made_once_and_then_kept() {
        // A device that invented a new id every run would tag every version it wrote as coming
        // from a device nobody has ever seen.
        let path = scratch("device");
        let mut settings = Settings::default();
        let first = settings.device_id();
        assert_eq!(settings.device_id(), first);
        assert_eq!(first.len(), 36);

        settings.save_to(&path).unwrap();
        assert_eq!(Settings::read_from(&path).device_id.as_deref(), Some(first.as_str()));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_vault_key_is_remembered_and_can_be_forgotten_again() {
        let path = scratch("keys");
        let mut keys = KeyStore::read_from(&path);
        assert_eq!(keys.get("v1"), None);

        keys.remember("v1", "dGhlIGtleQ==").unwrap();
        keys.remember("v2", "YW5vdGhlcg==").unwrap();

        // It has to survive being read back, or the password is asked for on every mount.
        let read = KeyStore::read_from(&path);
        assert_eq!(read.get("v1").as_deref(), Some("dGhlIGtleQ=="));
        assert_eq!(read.get("v2").as_deref(), Some("YW5vdGhlcg=="));

        let mut read = read;
        assert!(read.forget("v1").unwrap(), "it was there");
        assert!(!read.forget("v1").unwrap(), "and now it is not");
        assert_eq!(KeyStore::read_from(&path).get("v1"), None);
        assert_eq!(
            KeyStore::read_from(&path).get("v2").as_deref(),
            Some("YW5vdGhlcg=="),
            "forgetting one key must not forget the others"
        );
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn what_holds_a_vault_key_is_readable_only_by_this_user() {
        // This file is the whole of what an attacker with it needs to read the vault, which is why
        // the offer to remember a key says out loud that it is a file.
        use std::os::unix::fs::PermissionsExt;

        let path = scratch("perms");
        KeyStore::read_from(&path).remember("v1", "dGhlIGtleQ==").unwrap();

        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(
            fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777,
            0o700,
            "a 0600 file in a 0755 directory still says which vaults this account has"
        );
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_private_file_is_replaced_in_one_step_and_leaves_no_temporary() {
        // A crash half way through a write must not leave a file the next run cannot parse - for
        // the key store that would read as "this machine has never unlocked that vault".
        let path = scratch("atomic");
        write_private(&path, b"first").unwrap();
        write_private(&path, b"second").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        let left: Vec<String> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(left, vec!["file.json".to_string()]);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_saved_session_is_what_the_plain_accessors_hand_back() {
        // `server()` and `token()` are what every command calls when no flag was given, and they
        // are a different path from the resolver they wrap.
        let settings = Settings {
            server: Some("https://saved.example.com".into()),
            token: Some("saved-token".into()),
            device_id: None,
        };

        assert_eq!(settings.server(), "https://saved.example.com");
        assert_eq!(settings.token().as_deref(), Some("saved-token"));

        let blank = Settings::default();
        assert_eq!(blank.server(), BUILT_IN_SERVER);
        assert_eq!(blank.token(), None);
    }

    #[test]
    fn a_build_always_knows_where_to_go() {
        let choice = choose_server(None, None, None);
        assert_eq!(choice.url, BUILT_IN_SERVER);
        assert!(!choice.given, "nobody named it, so login must not write it down");
    }

    #[test]
    fn a_saved_session_beats_the_build() {
        // A self-hosted deployment stays self-hosted once it has been signed in to.
        let choice = choose_server(None, None, Some("https://notes.example.com"));
        assert_eq!(choice.url, "https://notes.example.com");
        assert!(!choice.given);
    }

    #[test]
    fn the_environment_beats_a_saved_session_and_the_flag_beats_both() {
        assert_eq!(
            choose_server(None, Some("https://from-env"), Some("https://saved")).url,
            "https://from-env"
        );
        assert_eq!(
            choose_server(Some("https://from-flag"), Some("https://from-env"), Some("https://saved")).url,
            "https://from-flag"
        );
    }

    #[test]
    fn naming_it_is_what_makes_login_remember_it() {
        assert!(choose_server(Some("https://x"), None, None).given);
        assert!(choose_server(None, Some("https://x"), None).given);
        assert!(!choose_server(None, None, Some("https://x")).given);
    }

    #[test]
    fn an_exported_but_empty_variable_is_nothing_said() {
        // `export SERBLENOTES_SERVER=` is what a script does when it has nothing to put there, and
        // resolving that to an empty address fails later with something about a URL instead.
        let choice = choose_server(Some(""), Some(""), Some(""));
        assert_eq!(choice.url, BUILT_IN_SERVER);
        assert!(!choice.given);
    }

    #[test]
    fn the_session_follows_the_same_order_as_the_server() {
        assert_eq!(choose_token(Some("flag"), Some("env"), Some("saved")).as_deref(), Some("flag"));
        assert_eq!(choose_token(None, Some("env"), Some("saved")).as_deref(), Some("env"));
        assert_eq!(choose_token(None, None, Some("saved")).as_deref(), Some("saved"));
    }

    #[test]
    fn no_session_anywhere_is_not_signed_in_rather_than_an_empty_one() {
        // A `Bearer ` with nothing after it comes back as a 401 about authentication, which sends
        // the user looking at their account instead of at their configuration.
        assert_eq!(choose_token(None, None, None), None);
        assert_eq!(choose_token(Some(""), Some(""), Some("")), None);
    }

    #[test]
    fn an_empty_value_falls_through_to_the_next_one() {
        assert_eq!(choose_token(Some(""), Some("env"), None).as_deref(), Some("env"));
        assert_eq!(choose_token(None, Some(""), Some("saved")).as_deref(), Some("saved"));
    }

    #[test]
    fn a_trailing_slash_is_not_part_of_the_address() {
        // Every path is built as `{base}/api/...`, so a slash here would send `//api/config`.
        assert_eq!(
            choose_server(Some("https://notes.example.com/"), None, None).url,
            "https://notes.example.com"
        );
    }
}
