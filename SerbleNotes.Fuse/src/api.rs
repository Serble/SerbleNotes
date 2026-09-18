//! The backend, as this client sees it.
//!
//! Every route here is one from the table in CLAUDE.md, and every `payload`, `name` and `label`
//! crossing this module is ciphertext the server cannot read and neither can this file. Nothing in
//! here decrypts anything; that is `store.rs`, through the core.
//!
//! [`Backend`] is a trait rather than a struct so the tests can drive the whole of `store.rs` and
//! the filesystem against an in-memory server, the way the backend's own tests replace the EF repos
//! with fakes. The fake is in `tests/support`.

use std::fmt;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// How long to wait for the server before deciding it is not there.
///
/// The same reasoning as the web client's: a connection that has gone away does not refuse
/// requests, it swallows them, and nothing above this can tell a slow server from an absent one.
/// It matters more here - a FUSE callback that never returns is a process stuck in uninterruptible
/// sleep and a mount point that cannot even be unmounted.
const TIMEOUT: Duration = Duration::from_secs(20);

/// How many version ids one request may name. The server refuses more than 200.
pub const IDS_PER_REQUEST: usize = 40;

/// A vault and the caller's own key to it. Exactly the backend's `VaultResponse`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vault {
    pub id: String,
    pub name: String,
    pub owner_id: String,
    pub encrypted: bool,
    /// The vault key sealed under the vault password, or - for an unencrypted vault - the key
    /// itself, in the clear. See CLAUDE.md: such a vault is not private from the server, and this
    /// client must never say otherwise.
    pub wrapped_key: String,
    pub kdf_salt: Option<String>,
    pub kdf_params: Option<String>,
    pub cursor: i64,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub vault_id: String,
    /// The note's whole name, folders included, sealed with the vault key.
    pub name: String,
    pub head_version_id: Option<String>,
    pub cursor: i64,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteVersion {
    pub id: String,
    pub note_id: String,
    pub vault_id: String,
    pub parent_id: Option<String>,
    pub merge_parent_id: Option<String>,
    pub is_snapshot: bool,
    pub is_named: bool,
    /// Base64 ciphertext, or `None` when only this version's metadata has been fetched. Never
    /// treat the absence of a body as an empty one - see `VaultStore::body_of`.
    pub payload: Option<String>,
    pub label: Option<String>,
    pub device_id: Option<String>,
    pub size: i64,
    pub cursor: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub vault_id: String,
    pub cursor: i64,
    #[serde(default)]
    pub notes: Vec<Note>,
    #[serde(default)]
    pub versions: Vec<NoteVersion>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewVersion {
    pub id: String,
    pub parent_id: Option<String>,
    pub merge_parent_id: Option<String>,
    pub is_snapshot: bool,
    pub is_named: bool,
    /// Base64 of the sealed body: a whole document when `is_snapshot`, a diff against the parent
    /// otherwise.
    pub payload: String,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewNote {
    pub id: String,
    pub name: String,
    pub initial_version: NewVersion,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientConfig {
    pub serble_app_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub username: String,
}

/// Why a request did not produce an answer.
///
/// The split between "nothing reached the server" and "the server said no" is the one distinction
/// everything above this module makes decisions on: the first will fix itself when the connection
/// comes back and the edit is kept for then, the second will not and has to be reported. Asking it
/// once, here, is what stops it being re-derived by matching on message text.
#[derive(Debug)]
pub enum ApiError {
    /// Nothing came back, so there is no status to report: offline, DNS, refused, or a timeout.
    Offline(String),
    /// The server answered, and the answer was no. `message` is its own sentence.
    Refused { status: u16, message: String },
    /// The server answered with something this client could not read.
    Malformed(String),
}

impl ApiError {
    /// Whether waiting and trying again is the right response.
    pub fn is_offline(&self) -> bool {
        matches!(self, ApiError::Offline(_))
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ApiError::Offline(detail) => write!(
                f,
                "Could not reach the server ({detail}). This machine may be offline, \
                 or the server may be down."
            ),
            ApiError::Refused { status, message } => write!(f, "{message} (HTTP {status})"),
            ApiError::Malformed(detail) => write!(f, "The server sent something unreadable: {detail}"),
        }
    }
}

impl std::error::Error for ApiError {}

/// Everything mounting a vault needs from the server.
///
/// Deliberately the sync surface and nothing else. Logging in and listing vaults live on
/// [`HttpBackend`] directly: they happen before there is a vault to mount, so a fake that exists to
/// test the filesystem has no business having to answer them.
pub trait Backend: Send + Sync {
    fn changes(&self, vault_id: &str, since: i64, bodies: bool) -> Result<Changes, ApiError>;

    /// A note's whole history. The fallback for a chain that cannot be worked out locally.
    fn note_versions(&self, note_id: &str) -> Result<Vec<NoteVersion>, ApiError>;

    /// Named versions of one note, which is the ordinary way a note is read.
    fn note_versions_by_ids(&self, note_id: &str, ids: &[String]) -> Result<Vec<NoteVersion>, ApiError>;

    fn create_note(&self, vault_id: &str, body: &NewNote) -> Result<Note, ApiError>;

    fn create_version(&self, note_id: &str, body: &NewVersion) -> Result<NoteVersion, ApiError>;

    fn rename_note(&self, note_id: &str, sealed_name: &str) -> Result<Note, ApiError>;

    fn delete_note(&self, note_id: &str) -> Result<(), ApiError>;
}

/// A failure as a sentence the user can do something about.
///
/// The one that matters is 401: a dead session looks like every other refusal from inside, and
/// "Unauthorized" sends somebody to look at their account when what they need is to sign in again.
pub fn describe(error: &ApiError, server: &str) -> String {
    match error {
        ApiError::Refused { status: 401, .. } => {
            "This machine's session has expired or been ended. Run `serblenotes-fuse login`.".into()
        }
        ApiError::Offline(_) => format!(
            "{error}\nThis build talks to {server} unless --server or a saved session says otherwise."
        ),
        other => other.to_string(),
    }
}

/// The real thing, talking to a deployment of `SerbleNotes.Backend`.
pub struct HttpBackend {
    agent: ureq::Agent,
    /// Origin only, with no trailing slash and no `/api`. Every path is built by `url`.
    base: String,
    token: Option<String>,
    device_id: String,
}

impl HttpBackend {
    pub fn new(base: &str, token: Option<String>, device_id: String) -> HttpBackend {
        HttpBackend {
            agent: ureq::AgentBuilder::new()
                .timeout_connect(TIMEOUT)
                .timeout_read(TIMEOUT)
                .timeout_write(TIMEOUT)
                .build(),
            base: base.trim_end_matches('/').to_string(),
            token,
            device_id,
        }
    }

    /// All routes live under `/api`, so the SPA fallback can never shadow them.
    fn url(&self, path: &str) -> String {
        format!("{}/api{path}", self.base)
    }

    fn prepare(&self, request: ureq::Request) -> ureq::Request {
        let request = request.set("X-Device-Id", &self.device_id);
        match &self.token {
            Some(token) => request.set("Authorization", &format!("Bearer {token}")),
            None => request,
        }
    }

    fn get<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T, ApiError> {
        let response = self
            .prepare(self.agent.get(&self.url(path)))
            .call()
            .map_err(translate)?;
        read_json(response)
    }

    fn send<T: serde::de::DeserializeOwned>(
        &self,
        method: &str,
        path: &str,
        body: &impl Serialize,
    ) -> Result<T, ApiError> {
        let response = self
            .prepare(self.agent.request(method, &self.url(path)))
            .send_json(serde_json::to_value(body).map_err(|e| ApiError::Malformed(e.to_string()))?)
            .map_err(translate)?;
        read_json(response)
    }

    /// The Serble application id this deployment signs in against. Anonymous, and the one call that
    /// works before there is a token.
    pub fn client_config(&self) -> Result<ClientConfig, ApiError> {
        self.get("/config")
    }

    /// Trades the code Serble handed back for this backend's own JWT.
    pub fn authenticate(&self, code: &str) -> Result<String, ApiError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct AuthResponse {
            access_token: String,
        }

        let response: AuthResponse =
            self.send("POST", "/account", &serde_json::json!({ "code": code }))?;
        Ok(response.access_token)
    }

    pub fn account(&self) -> Result<Account, ApiError> {
        self.get("/account")
    }

    pub fn list_vaults(&self) -> Result<Vec<Vault>, ApiError> {
        self.get("/vaults")
    }

    pub fn get_vault(&self, id: &str) -> Result<Vault, ApiError> {
        self.get(&format!("/vaults/{id}"))
    }
}

impl Backend for HttpBackend {
    fn changes(&self, vault_id: &str, since: i64, bodies: bool) -> Result<Changes, ApiError> {
        self.get(&format!("/vaults/{vault_id}/changes?since={since}&bodies={bodies}"))
    }

    fn note_versions(&self, note_id: &str) -> Result<Vec<NoteVersion>, ApiError> {
        self.get(&format!("/notes/{note_id}/versions"))
    }

    fn note_versions_by_ids(&self, note_id: &str, ids: &[String]) -> Result<Vec<NoteVersion>, ApiError> {
        // Version ids are UUIDs, so nothing here needs escaping - but they are chosen by clients
        // and arrive here from stored metadata, so they are escaped anyway rather than trusted to
        // stay that shape.
        let joined = ids
            .iter()
            .map(|id| {
                percent_encoding::utf8_percent_encode(id, percent_encoding::NON_ALPHANUMERIC)
                    .to_string()
            })
            .collect::<Vec<_>>()
            .join(",");

        self.get(&format!("/notes/{note_id}/versions?ids={joined}"))
    }

    fn create_note(&self, vault_id: &str, body: &NewNote) -> Result<Note, ApiError> {
        self.send("POST", &format!("/vaults/{vault_id}/notes"), body)
    }

    fn create_version(&self, note_id: &str, body: &NewVersion) -> Result<NoteVersion, ApiError> {
        self.send("POST", &format!("/notes/{note_id}/versions"), body)
    }

    fn rename_note(&self, note_id: &str, sealed_name: &str) -> Result<Note, ApiError> {
        self.send(
            "PUT",
            &format!("/notes/{note_id}/name"),
            &serde_json::json!({ "name": sealed_name }),
        )
    }

    fn delete_note(&self, note_id: &str) -> Result<(), ApiError> {
        self.prepare(self.agent.delete(&self.url(&format!("/notes/{note_id}"))))
            .call()
            .map_err(translate)?;
        Ok(())
    }
}

/// Reads a JSON body, or says the body was not JSON rather than dying on an unwrap.
fn read_json<T: serde::de::DeserializeOwned>(response: ureq::Response) -> Result<T, ApiError> {
    if response.status() == 204 {
        // `DELETE` answers with no content, and nothing asks it for a value.
        return serde_json::from_str("null").map_err(|e| ApiError::Malformed(e.to_string()));
    }

    response
        .into_json()
        .map_err(|e| ApiError::Malformed(e.to_string()))
}

/// Turns ureq's two failure shapes into the one distinction this client acts on.
///
/// The split is the whole reason this function exists, and getting it backwards is not a cosmetic
/// bug: `Offline` means the edit is kept and retried, `Refused` means it is reported and the user
/// has to do something. A refusal read as offline retries forever in silence; an offline read as a
/// refusal throws an error at somebody on a train.
fn translate(error: ureq::Error) -> ApiError {
    match error {
        ureq::Error::Status(status, response) => {
            refusal(status, &response.into_string().unwrap_or_default())
        }
        ureq::Error::Transport(transport) => ApiError::Offline(transport.to_string()),
    }
}

/// The sentence a refusal carries, given the status and whatever body came with it.
///
/// Split out from [`translate`] so it can be tested without constructing a `ureq::Error`, which has
/// no public constructor. The backend puts a user-facing sentence in `message`; a proxy error page,
/// an empty body or anything that is not JSON has to come back as something readable rather than as
/// a blank message, because this string is all the user is ever shown about why a save did not
/// happen.
pub fn refusal(status: u16, body: &str) -> ApiError {
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|body| body.get("message")?.as_str().map(str::to_string))
        .filter(|message| !message.trim().is_empty())
        .unwrap_or_else(|| format!("The server refused that request ({status})."));

    ApiError::Refused { status, message }
}
