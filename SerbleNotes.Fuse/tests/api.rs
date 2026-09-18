//! The wire: what this client sends, and what it makes of what comes back.
//!
//! Everything here runs against a real HTTP server on a real socket, because there is nothing else
//! worth testing about this layer. A `Backend` fake proves the callers behave; it proves nothing
//! about the URLs, the headers, the status handling or the JSON shapes, and those are exactly where
//! this client and the backend can drift apart without either of them changing behaviour.

mod support;

use serblenotes_fuse::api::{
    self, refusal, ApiError, Backend, HttpBackend, NewNote, NewVersion, IDS_PER_REQUEST,
};
use support::stub::{Reply, StubServer};

fn client(base: &str) -> HttpBackend {
    HttpBackend::new(base, Some("a-token".into()), "this-device".into())
}

const A_VAULT: &str = r#"{"id":"v1","name":"Notes","ownerId":"u1","encrypted":true,
    "wrappedKey":"d3JhcHBlZA==","kdfSalt":"c2FsdA==","kdfParams":"{}","cursor":7,
    "createdAt":"2026-09-17T00:00:00Z","updatedAt":"2026-09-17T00:00:00","deleted":false}"#;

const A_NOTE: &str = r#"{"id":"n1","vaultId":"v1","name":"c2VhbGVk","headVersionId":"ver1",
    "cursor":9,"createdAt":"2026-09-17T00:00:00Z","updatedAt":"2026-09-17T00:00:00",
    "deletedAt":null,"deleted":false}"#;

// --- what it sends ------------------------------------------------------------------------------

#[test]
fn every_request_carries_the_session_and_the_device() {
    let server = StubServer::always(|| Reply::json("[]"));
    client(&server.base()).list_vaults().unwrap();

    let asked = server.last();
    assert_eq!(asked.header("authorization"), Some("Bearer a-token"));
    assert_eq!(
        asked.header("x-device-id"),
        Some("this-device"),
        "without this the server cannot tell a device its own writes are coming back"
    );
}

#[test]
fn every_route_lives_under_api_so_the_spa_fallback_cannot_shadow_it() {
    let server = StubServer::start(|asked| {
        if asked.target.contains("/changes") {
            Reply::json(r#"{"vaultId":"v1","cursor":4,"notes":[],"versions":[]}"#)
        } else if asked.method == "DELETE" {
            Reply::empty()
        } else if asked.target.ends_with("/name") {
            Reply::json(A_NOTE)
        } else {
            Reply::json("[]")
        }
    });
    let backend = client(&server.base());

    backend.list_vaults().unwrap();
    backend.get_vault("v1").ok();
    backend.changes("v1", 4, false).unwrap();
    backend.note_versions("n1").unwrap();
    backend.note_versions_by_ids("n1", &["a".into()]).unwrap();
    backend.rename_note("n1", "x").unwrap();
    backend.delete_note("n1").unwrap();
    backend.client_config().ok();
    backend.account().ok();

    assert_eq!(server.asked().len(), 9, "every route should have been reached");
    for asked in server.asked() {
        assert!(asked.target.starts_with("/api/"), "{} is not under /api", asked.target);
    }
}

#[test]
fn a_base_url_with_a_trailing_slash_does_not_produce_a_double_one() {
    let server = StubServer::always(|| Reply::json("[]"));
    HttpBackend::new(&format!("{}/", server.base()), None, "d".into())
        .list_vaults()
        .unwrap();

    assert_eq!(server.last().target, "/api/vaults");
}

#[test]
fn the_sync_read_path_asks_for_metadata_only() {
    let server = StubServer::always(|| {
        Reply::json(r#"{"vaultId":"v1","cursor":12,"notes":[],"versions":[]}"#)
    });

    client(&server.base()).changes("v1", 11, false).unwrap();

    // Both parameters matter: `since` is the cursor rule, and `bodies=false` is the whole reason
    // opening a vault does not download it.
    assert_eq!(server.last().target, "/api/vaults/v1/changes?since=11&bodies=false");
}

#[test]
fn named_versions_are_escaped_rather_than_trusted_to_be_tidy() {
    let server = StubServer::always(|| Reply::json("[]"));

    // Version ids are chosen by clients, so they arrive here from stored metadata rather than from
    // anything this process made. Anything that could end a query string has to not.
    client(&server.base())
        .note_versions_by_ids("n1", &["a&b=c".into(), "d/e".into()])
        .unwrap();

    let target = server.last().target;
    assert!(target.starts_with("/api/notes/n1/versions?ids="));
    assert!(!target.contains("a&b=c"), "an unescaped id would become another query parameter");
    assert!(target.contains("a%26b%3Dc"));
    assert!(target.contains("d%2Fe"));
}

#[test]
fn a_version_is_posted_as_the_json_the_server_reads() {
    let server = StubServer::always(|| Reply::json(r#"{"id":"ver2","noteId":"n1","vaultId":"v1",
        "parentId":"ver1","mergeParentId":null,"isSnapshot":false,"isNamed":false,
        "payload":"cGF5","label":null,"deviceId":"this-device","size":3,"cursor":10,
        "createdAt":"2026-09-17T00:00:00"}"#));

    client(&server.base())
        .create_version(
            "n1",
            &NewVersion {
                id: "ver2".into(),
                parent_id: Some("ver1".into()),
                merge_parent_id: None,
                is_snapshot: false,
                is_named: false,
                payload: "cGF5".into(),
                label: None,
            },
        )
        .unwrap();

    let asked = server.last();
    assert_eq!(asked.method, "POST");
    assert_eq!(asked.target, "/api/notes/n1/versions");

    // camelCase, because that is what the backend binds. A field this client spells differently is
    // a field the server silently reads as absent.
    let sent: serde_json::Value = serde_json::from_str(&asked.body).unwrap();
    assert_eq!(sent["parentId"], "ver1");
    assert_eq!(sent["isSnapshot"], false);
    assert_eq!(sent["isNamed"], false);
    assert_eq!(sent["payload"], "cGF5");
    assert!(sent.get("mergeParentId").is_some(), "a null has to be sent, not left out");
}

#[test]
fn creating_a_note_nests_its_first_version_the_way_the_server_expects() {
    let server = StubServer::always(|| Reply::json(A_NOTE));

    client(&server.base())
        .create_note(
            "v1",
            &NewNote {
                id: "n1".into(),
                name: "c2VhbGVk".into(),
                initial_version: NewVersion {
                    id: "ver1".into(),
                    parent_id: None,
                    merge_parent_id: None,
                    is_snapshot: true,
                    is_named: false,
                    payload: "Ym9keQ==".into(),
                    label: None,
                },
            },
        )
        .unwrap();

    let sent: serde_json::Value = serde_json::from_str(&server.last().body).unwrap();
    assert_eq!(sent["initialVersion"]["payload"], "Ym9keQ==");
    assert_eq!(sent["name"], "c2VhbGVk");
}

#[test]
fn renaming_sends_only_the_sealed_name() {
    let server = StubServer::always(|| Reply::json(A_NOTE));
    client(&server.base()).rename_note("n1", "bmV3IG5hbWU=").unwrap();

    let asked = server.last();
    assert_eq!(asked.method, "PUT");
    assert_eq!(asked.target, "/api/notes/n1/name");
    let sent: serde_json::Value = serde_json::from_str(&asked.body).unwrap();
    assert_eq!(sent["name"], "bmV3IG5hbWU=");
}

#[test]
fn a_batch_never_asks_for_more_than_the_server_will_take() {
    // The server refuses more than 200 ids in one request, so this is checked by actually sending
    // a full batch rather than by asserting the constant against itself.
    let server = StubServer::always(|| Reply::json("[]"));
    let ids: Vec<String> = (0..IDS_PER_REQUEST).map(|i| format!("id-{i}")).collect();

    client(&server.base()).note_versions_by_ids("n1", &ids).unwrap();

    let target = server.last().target;
    let sent = target.split("ids=").nth(1).expect("ids=").split(',').count();
    assert_eq!(sent, IDS_PER_REQUEST);
    assert!(sent <= 200, "the server refuses more than 200 at a time");
    assert!(target.len() < 8000, "and the URL still has to be sendable: {} bytes", target.len());
}

// --- what it makes of the answer ----------------------------------------------------------------

#[test]
fn a_vault_is_read_the_way_the_backend_spells_it() {
    let server = StubServer::always(|| Reply::json(format!("[{A_VAULT}]")));
    let vaults = client(&server.base()).list_vaults().unwrap();

    assert_eq!(vaults.len(), 1);
    assert_eq!(vaults[0].id, "v1");
    assert_eq!(vaults[0].wrapped_key, "d3JhcHBlZA==");
    assert_eq!(vaults[0].kdf_salt.as_deref(), Some("c2FsdA=="));
    assert_eq!(vaults[0].cursor, 7);
    assert!(vaults[0].encrypted);
    assert!(!vaults[0].deleted);
}

#[test]
fn a_field_this_client_does_not_know_about_is_ignored_rather_than_fatal() {
    // The backend's Note already carries DeletedAt as well as the flag, and it will grow more. A
    // client that refused unknown fields would stop working the next time the server learned
    // something, which is not a failure mode a notes app should have.
    let server = StubServer::always(|| {
        Reply::json(r#"{"vaultId":"v1","cursor":3,"somethingNew":42,
            "notes":[{"id":"n1","vaultId":"v1","name":"c2VhbGVk","headVersionId":null,"cursor":1,
                      "createdAt":"2026-09-17T00:00:00","updatedAt":"2026-09-17T00:00:00",
                      "deletedAt":null,"deleted":false,"alsoNew":"x"}],
            "versions":[]}"#)
    });

    let changes = client(&server.base()).changes("v1", 0, false).unwrap();
    assert_eq!(changes.notes[0].id, "n1");
    assert_eq!(changes.cursor, 3);
}

#[test]
fn a_tombstone_arrives_as_one() {
    let server = StubServer::always(|| {
        Reply::json(r#"{"vaultId":"v1","cursor":5,"versions":[],
            "notes":[{"id":"n1","vaultId":"v1","name":"c2VhbGVk","headVersionId":"ver1","cursor":5,
                      "createdAt":"2026-09-17T00:00:00","updatedAt":"2026-09-17T00:00:00",
                      "deletedAt":"2026-09-17T00:00:00","deleted":true}]}"#)
    });

    let changes = client(&server.base()).changes("v1", 0, false).unwrap();
    assert!(changes.notes[0].deleted, "a deleted note read as live is a note that cannot be deleted");
}

#[test]
fn a_note_with_no_head_yet_is_not_a_parse_failure() {
    let server = StubServer::always(|| {
        Reply::json(r#"{"vaultId":"v1","cursor":1,"versions":[],
            "notes":[{"id":"n1","vaultId":"v1","name":"c2VhbGVk","headVersionId":null,"cursor":1,
                      "createdAt":"2026-09-17T00:00:00","updatedAt":"2026-09-17T00:00:00",
                      "deletedAt":null,"deleted":false}]}"#)
    });

    let changes = client(&server.base()).changes("v1", 0, false).unwrap();
    assert!(changes.notes[0].head_version_id.is_none());
}

#[test]
fn a_metadata_only_version_has_no_body_and_says_so() {
    let server = StubServer::always(|| {
        Reply::json(r#"{"vaultId":"v1","cursor":12,"notes":[],"versions":[
            {"id":"ver1","noteId":"n1","vaultId":"v1","parentId":null,"mergeParentId":null,
             "isSnapshot":true,"isNamed":false,"payload":null,"label":null,"deviceId":null,
             "size":40,"cursor":12,"createdAt":"2026-09-17T00:00:00"}]}"#)
    });

    let changes = client(&server.base()).changes("v1", 0, false).unwrap();
    assert_eq!(changes.cursor, 12);
    assert!(
        changes.versions[0].payload.is_none(),
        "absent has to stay absent - read as empty it would save a note over with nothing"
    );
    assert_eq!(changes.versions[0].size, 40);
}

#[test]
fn a_delete_answers_with_nothing_and_that_is_success() {
    let server = StubServer::always(Reply::empty);
    client(&server.base()).delete_note("n1").unwrap();

    assert_eq!(server.last().method, "DELETE");
}

// --- how it fails -------------------------------------------------------------------------------

#[test]
fn a_server_that_cannot_be_reached_is_offline_not_refused() {
    // The distinction everything downstream branches on: offline keeps the edit and retries,
    // refused reports it and stops. Backwards, an edit made on a train is thrown away.
    let error = client(&StubServer::unreachable()).list_vaults().unwrap_err();

    assert!(error.is_offline(), "got {error:?}");
    assert!(error.to_string().contains("Could not reach the server"));
}

#[test]
fn a_refusal_carries_the_servers_own_sentence() {
    let server = StubServer::always(|| {
        Reply::status(403, r#"{"message":"You have reached the limit of 100 vaults."}"#)
    });

    match client(&server.base()).list_vaults().unwrap_err() {
        ApiError::Refused { status, message } => {
            assert_eq!(status, 403);
            assert_eq!(message, "You have reached the limit of 100 vaults.");
        }
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn a_refusal_is_never_offline_however_it_is_worded() {
    let server = StubServer::always(|| Reply::status(500, r#"{"message":"boom"}"#));
    let error = client(&server.base()).list_vaults().unwrap_err();

    assert!(!error.is_offline(), "a 500 will not fix itself by waiting quietly");
}

#[test]
fn an_error_page_that_is_not_json_still_says_something_readable() {
    // nginx, a gateway, anything in front of the backend. A blank message is all the user would
    // otherwise be told about why their note did not save.
    let error = refusal(502, "<html><body>Bad Gateway</body></html>");
    match error {
        ApiError::Refused { status, message } => {
            assert_eq!(status, 502);
            assert!(message.contains("502"), "got {message:?}");
            assert!(!message.is_empty());
        }
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn an_empty_body_and_an_empty_message_both_fall_back() {
    for body in ["", "{}", r#"{"message":""}"#, r#"{"message":"   "}"#, "null", "not json at all"] {
        match refusal(400, body) {
            ApiError::Refused { message, .. } => assert!(
                message.contains("400"),
                "body {body:?} produced an unhelpful message: {message:?}"
            ),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }
}

#[test]
fn a_message_that_is_not_a_string_does_not_become_one() {
    match refusal(400, r#"{"message":{"nested":"object"}}"#) {
        ApiError::Refused { message, .. } => assert!(message.contains("400")),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn an_answer_this_client_cannot_read_is_its_own_kind_of_failure() {
    let server = StubServer::always(|| Reply::json("{ this is not json"));
    let error = client(&server.base()).list_vaults().unwrap_err();

    assert!(matches!(error, ApiError::Malformed(_)), "got {error:?}");
    assert!(
        !error.is_offline(),
        "a server that answered with nonsense is not one that could not be reached"
    );
}

#[test]
fn a_401_is_a_refusal_the_caller_can_recognise() {
    let server = StubServer::always(|| Reply::status(401, r#"{"message":"Authentication required."}"#));

    match client(&server.base()).changes("v1", 0, false).unwrap_err() {
        ApiError::Refused { status, .. } => assert_eq!(status, 401),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn a_request_with_no_session_simply_sends_no_authorization() {
    let server = StubServer::always(|| Reply::json(r#"{"serbleAppId":"app-id"}"#));
    let config = HttpBackend::new(&server.base(), None, "d".into())
        .client_config()
        .unwrap();

    assert_eq!(config.serble_app_id, "app-id");
    assert_eq!(server.last().header("authorization"), None);
}

// --- what the user is told ------------------------------------------------------------------------

#[test]
fn a_dead_session_says_to_sign_in_rather_than_saying_unauthorized() {
    // From inside, a dead session looks like every other refusal. "Unauthorized" sends somebody to
    // look at their account when what they need is one command.
    let said = api::describe(
        &ApiError::Refused { status: 401, message: "Authentication required.".into() },
        "https://notes.example.com",
    );
    assert!(said.contains("serblenotes-fuse login"), "{said}");
}

#[test]
fn a_refusal_that_is_not_about_the_session_is_passed_through_as_it_was_written() {
    let said = api::describe(
        &ApiError::Refused { status: 403, message: "You have reached your storage limit.".into() },
        "https://notes.example.com",
    );
    assert!(said.contains("storage limit"), "{said}");
    assert!(!said.contains("login"), "this is not a session problem: {said}");
}

#[test]
fn not_reaching_the_server_says_which_server_it_could_not_reach() {
    // The commonest cause of this is a build talking to somewhere the user did not expect, and
    // they cannot work that out from "could not reach the server".
    let said = api::describe(
        &ApiError::Offline("connection refused".into()),
        "https://notes.example.com",
    );
    assert!(said.contains("https://notes.example.com"), "{said}");
    assert!(said.contains("--server"), "and how to point it somewhere else: {said}");
}

#[test]
fn an_unreadable_answer_is_described_as_itself() {
    let said = api::describe(&ApiError::Malformed("expected value".into()), "https://x");
    assert!(said.contains("unreadable"), "{said}");
    assert!(!said.contains("login"));
}
