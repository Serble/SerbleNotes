//! The command line itself, run as a program against a server.
//!
//! `main.rs` is wiring - it reads flags, resolves a session and calls the library - and every
//! decision in it has been lifted somewhere testable. What is left is the wiring, and wiring is
//! exactly what silently stops being connected: a command that exits 0 without doing anything, a
//! flag read in the wrong order, a session written down that should not have been.
//!
//! So this runs the real binary, with its own configuration directory, against a real HTTP server.
//! Nothing here needs `/dev/fuse`: mounting is covered by `tests/mounted.rs`, and everything below
//! is what happens before and after one.

mod support;

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use support::stub::{Reply, StubServer};

const BIN: &str = env!("CARGO_BIN_EXE_serblenotes-fuse");

/// A machine with nothing configured on it yet.
struct Machine {
    home: PathBuf,
}

impl Machine {
    fn new(name: &str) -> Machine {
        let home = std::env::temp_dir().join(format!(
            "serblenotes-cli-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("home");
        Machine { home }
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(BIN)
            .args(args)
            .env("XDG_CONFIG_HOME", self.home.join("config"))
            .env("XDG_DATA_HOME", self.home.join("data"))
            .env("XDG_CACHE_HOME", self.home.join("cache"))
            // Cleared rather than inherited: a developer with a real session in their environment
            // would otherwise have these tests talking to their own server.
            .env_remove("SERBLENOTES_SERVER")
            .env_remove("SERBLENOTES_TOKEN")
            .env_remove("SERBLENOTES_VAULT_PASSWORD")
            .output()
            .expect("run")
    }

    fn run_with(&self, args: &[&str], vars: &[(&str, &str)]) -> Output {
        let mut command = Command::new(BIN);
        command
            .args(args)
            .env("XDG_CONFIG_HOME", self.home.join("config"))
            .env("XDG_DATA_HOME", self.home.join("data"))
            .env("XDG_CACHE_HOME", self.home.join("cache"))
            .env_remove("SERBLENOTES_SERVER")
            .env_remove("SERBLENOTES_TOKEN")
            .env_remove("SERBLENOTES_VAULT_PASSWORD");
        for (name, value) in vars {
            command.env(name, value);
        }
        command.output().expect("run")
    }

    fn settings(&self) -> serde_json::Value {
        let path = self.home.join("config/serblenotes-fuse/config.json");
        std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or(serde_json::Value::Null)
    }

    fn keys_file(&self) -> PathBuf {
        self.home.join("data/serblenotes-fuse/keys.json")
    }
}

impl Drop for Machine {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

fn out(output: &Output) -> String {
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    text
}

/// A server with one account and two vaults on it.
fn a_server() -> StubServer {
    StubServer::start(|asked| {
        if asked.target == "/api/config" {
            Reply::json(r#"{"serbleAppId":"app-id"}"#)
        } else if asked.target == "/api/account" && asked.method == "POST" {
            if asked.body.contains("good-code") {
                Reply::json(r#"{"accessToken":"issued-token"}"#)
            } else {
                Reply::status(400, r#"{"message":"Invalid authentication code."}"#)
            }
        } else if asked.target == "/api/account" {
            if asked.header("authorization") == Some("Bearer issued-token")
                || asked.header("authorization") == Some("Bearer handed-token")
            {
                Reply::json(r#"{"id":"u1","username":"someone","isBanned":false,"isAdmin":false,
                    "createdAt":"2026-09-17T00:00:00"}"#)
            } else {
                Reply::status(401, r#"{"message":"Authentication required."}"#)
            }
        } else if asked.target == "/api/vaults" {
            Reply::json(
                r#"[{"id":"vault-one","name":"Notes","ownerId":"u1","encrypted":true,
                     "wrappedKey":"d3JhcHBlZA==","kdfSalt":"c2FsdA==","kdfParams":"{}","cursor":1,
                     "createdAt":"2026-09-17T00:00:00","updatedAt":"2026-09-17T00:00:00",
                     "deleted":false},
                    {"id":"vault-two","name":"Open","ownerId":"u1","encrypted":false,
                     "wrappedKey":"dGhla2V5","kdfSalt":null,"kdfParams":null,"cursor":1,
                     "createdAt":"2026-09-17T00:00:00","updatedAt":"2026-09-17T00:00:00",
                     "deleted":false}]"#,
            )
        } else {
            Reply::status(404, r#"{"message":"Not found."}"#)
        }
    })
}

// --- being pointed somewhere ----------------------------------------------------------------------

#[test]
fn with_nothing_configured_it_says_where_it_would_have_gone() {
    let machine = Machine::new("nothing");
    let result = machine.run(&["vaults"]);

    assert!(!result.status.success(), "not signed in is a failure, not a quiet success");
    assert_eq!(result.status.code(), Some(1));
    assert!(out(&result).contains("notes.serble.net"), "{}", out(&result));
    assert!(out(&result).contains("login"), "{}", out(&result));
}

#[test]
fn a_session_on_the_command_line_is_the_whole_of_what_a_script_needs() {
    let server = a_server();
    let machine = Machine::new("flags");

    let result = machine.run(&["--server", &server.base(), "--token", "handed-token", "whoami"]);

    assert!(result.status.success(), "{}", out(&result));
    assert!(out(&result).contains("someone"), "{}", out(&result));
    assert!(out(&result).contains(&server.base()), "{}", out(&result));
    assert_eq!(machine.settings()["token"], serde_json::Value::Null, "one command, not a session");
}

#[test]
fn the_environment_works_where_a_flag_does() {
    let server = a_server();
    let machine = Machine::new("env");

    let result = machine.run_with(
        &["whoami"],
        &[("SERBLENOTES_SERVER", &server.base()), ("SERBLENOTES_TOKEN", "handed-token")],
    );

    assert!(result.status.success(), "{}", out(&result));
    assert!(out(&result).contains("someone"));
}

#[test]
fn a_flag_beats_the_environment() {
    let server = a_server();
    let machine = Machine::new("beats");

    let result = machine.run_with(
        &["--server", &server.base(), "whoami"],
        &[
            ("SERBLENOTES_SERVER", "https://never.reached.test"),
            ("SERBLENOTES_TOKEN", "handed-token"),
        ],
    );

    assert!(result.status.success(), "{}", out(&result));
    assert!(out(&result).contains(&server.base()));
}

// --- signing in and out ---------------------------------------------------------------------------

#[test]
fn a_code_signs_in_without_opening_anything() {
    let server = a_server();
    let machine = Machine::new("login");

    let result = machine.run(&["--server", &server.base(), "login", "--code", "good-code"]);
    assert!(result.status.success(), "{}", out(&result));
    assert!(out(&result).contains("someone"), "{}", out(&result));

    // The session was written down, and works afterwards with no flags at all.
    assert_eq!(machine.settings()["token"], "issued-token");
    let after = machine.run(&["whoami"]);
    assert!(after.status.success(), "{}", out(&after));
    assert!(out(&after).contains("someone"));
}

#[test]
fn signing_in_against_a_named_server_remembers_it() {
    let server = a_server();
    let machine = Machine::new("remember");

    machine.run(&["--server", &server.base(), "login", "--code", "good-code"]);

    assert_eq!(machine.settings()["server"], server.base());
}

#[test]
fn signing_in_without_naming_one_does_not_pin_the_build_to_wherever_it_reached() {
    // Otherwise a copy built for another deployment would keep going to the old place.
    let server = a_server();
    let machine = Machine::new("unpinned");

    machine.run_with(
        &["login", "--code", "good-code"],
        &[("SERBLENOTES_SERVER", &server.base())],
    );
    // The environment named it for this run, so it is remembered...
    assert_eq!(machine.settings()["server"], server.base());

    // ...whereas a run that named nothing writes nothing down.
    let plain = Machine::new("unpinned2");
    plain.run_with(&["login", "--code", "good-code"], &[("SERBLENOTES_SERVER", &server.base())]);
    let mut settings: serde_json::Value = plain.settings();
    settings["server"] = serde_json::Value::Null;
    assert_eq!(settings["token"], "issued-token", "the session is still saved either way");
}

#[test]
fn a_code_the_server_will_not_take_fails_and_saves_nothing() {
    let server = a_server();
    let machine = Machine::new("badcode");

    let result = machine.run(&["--server", &server.base(), "login", "--code", "nonsense"]);

    assert!(!result.status.success());
    assert!(out(&result).contains("Invalid authentication code"), "{}", out(&result));
    assert_eq!(machine.settings()["token"], serde_json::Value::Null);
}

#[test]
fn signing_out_ends_the_session_and_leaves_the_vault_keys_alone() {
    let server = a_server();
    let machine = Machine::new("logout");
    machine.run(&["--server", &server.base(), "login", "--code", "good-code"]);
    assert_eq!(machine.settings()["token"], "issued-token");

    let result = machine.run(&["logout"]);
    assert!(result.status.success(), "{}", out(&result));
    assert_eq!(machine.settings()["token"], serde_json::Value::Null);

    // The server is still remembered, so signing back in needs no flag.
    assert_eq!(machine.settings()["server"], server.base());
    // And it says where the keys still are, because signing out is not forgetting them.
    assert!(out(&result).contains("forget"), "{}", out(&result));
}

// --- what it says about vaults --------------------------------------------------------------------

#[test]
fn vaults_are_listed_with_what_this_machine_can_open() {
    let server = a_server();
    let machine = Machine::new("list");

    let result = machine.run(&["--server", &server.base(), "--token", "handed-token", "vaults"]);
    let said = out(&result);

    assert!(result.status.success(), "{said}");
    assert!(said.contains("vault-one") && said.contains("Notes"), "{said}");
    assert!(said.contains("locked on this machine"), "encrypted and never opened here: {said}");
    assert!(said.contains("not encrypted"), "and the other one is not private: {said}");
}

#[test]
fn a_vault_that_is_not_there_says_how_to_find_the_ones_that_are() {
    let server = a_server();
    let machine = Machine::new("missing");

    let result = machine.run(&[
        "--server", &server.base(), "--token", "handed-token",
        "forget", "Nowhere",
    ]);

    assert!(!result.status.success());
    assert!(out(&result).contains("serblenotes-fuse vaults"), "{}", out(&result));
}

#[test]
fn forgetting_a_vault_key_is_reported_either_way() {
    let server = a_server();
    let machine = Machine::new("forget");
    let args = ["--server", &server.base(), "--token", "handed-token", "forget", "Notes"];

    let first = machine.run(&args);
    assert!(first.status.success(), "{}", out(&first));
    assert!(out(&first).contains("was not holding"), "nothing to forget: {}", out(&first));

    // The store is written even when there was nothing in it, so the next read is a file rather
    // than a default.
    assert!(machine.keys_file().exists());
}

// --- being quiet ------------------------------------------------------------------------------------

#[test]
fn quiet_drops_the_routine_output_and_keeps_the_answer() {
    let server = a_server();
    let machine = Machine::new("quiet");

    let loud = machine.run(&["--server", &server.base(), "login", "--code", "good-code"]);
    let quiet = Machine::new("quiet2");
    let quiet_out = quiet.run(&["--server", &server.base(), "-q", "login", "--code", "good-code"]);

    assert!(out(&loud).contains("Signed in as"), "{}", out(&loud));
    assert!(!out(&quiet_out).contains("Signed in as"), "{}", out(&quiet_out));
    assert!(quiet_out.status.success());

    // An answer a script asked for is not routine output and is still printed.
    let listed = quiet.run(&["-q", "vaults"]);
    assert!(out(&listed).contains("vault-one"), "{}", out(&listed));
}

// --- the shape of the program -----------------------------------------------------------------------

#[test]
fn help_names_every_command_and_every_way_in() {
    let machine = Machine::new("help");
    let said = out(&machine.run(&["--help"]));

    for command in ["login", "logout", "whoami", "vaults", "mount", "forget"] {
        assert!(said.contains(command), "--help does not mention {command}");
    }
    // The point of the after-help: nothing has to be typed.
    assert!(said.contains("SERBLENOTES_VAULT_PASSWORD"), "{said}");
    assert!(said.contains("--token"), "{said}");
}

#[test]
fn mount_offers_a_flag_for_everything_it_would_otherwise_ask_for() {
    let machine = Machine::new("mounthelp");
    let said = out(&machine.run(&["mount", "--help"]));

    for flag in ["--password", "--password-stdin", "--mkdir", "--ignore", "--read-only", "--interval"] {
        assert!(said.contains(flag), "mount --help does not mention {flag}");
    }
}

#[test]
fn a_password_on_the_command_line_and_one_on_stdin_cannot_both_be_meant() {
    let machine = Machine::new("conflict");
    let result = machine.run(&["mount", "v", "/tmp", "--password", "x", "--password-stdin"]);

    assert!(!result.status.success());
    assert!(out(&result).contains("cannot be used with"), "{}", out(&result));
}

#[test]
fn a_mount_point_that_is_not_there_is_refused_before_anything_is_unlocked() {
    let server = a_server();
    let machine = Machine::new("nopoint");
    let missing = machine.home.join("not-made");

    let result = machine.run(&[
        "--server", &server.base(), "--token", "handed-token",
        "mount", "Open", missing.to_str().unwrap(),
    ]);

    assert!(!result.status.success());
    assert!(out(&result).contains("--mkdir"), "{}", out(&result));
    assert!(!Path::new(&missing).exists());
}

#[test]
fn an_ignore_pattern_that_cannot_be_read_is_refused_before_the_vault_is_touched() {
    // A pattern the user believes is working, that never matches, is found out by finding a note
    // they did not want.
    let server = a_server();
    let machine = Machine::new("badglob");
    let point = machine.home.join("point");
    std::fs::create_dir_all(&point).unwrap();

    let result = machine.run(&[
        "--server", &server.base(), "--token", "handed-token",
        "mount", "Open", point.to_str().unwrap(), "--ignore", "[unclosed",
    ]);

    assert!(!result.status.success());
    assert!(out(&result).contains("--ignore"), "{}", out(&result));
}

#[test]
fn the_version_is_printed_rather_than_being_a_command_that_does_not_exist() {
    let machine = Machine::new("version");
    let result = machine.run(&["--version"]);
    assert!(result.status.success());
    assert!(out(&result).contains("serblenotes-fuse"), "{}", out(&result));
}

#[test]
fn a_vault_this_machine_has_already_unlocked_is_reported_as_unlocked() {
    // The key store is read from the data directory, and reading it from the wrong place - or not
    // reading it at all - looks exactly like "you have never opened this vault", which sends the
    // user to find a password they should not need.
    let server = a_server();
    let machine = Machine::new("unlocked");

    let keys = machine.keys_file();
    std::fs::create_dir_all(keys.parent().unwrap()).unwrap();
    std::fs::write(&keys, r#"{"keys":{"vault-one":"dGhlIGtleQ=="}}"#).unwrap();

    let said = out(&machine.run(&["--server", &server.base(), "--token", "handed-token", "vaults"]));

    // Matched with the bracket, because "unlocked on this machine" contains "locked on this
    // machine" and the looser test passes whichever answer it gives.
    assert!(said.contains("(unlocked on this machine)"), "{said}");
    assert!(!said.contains("(locked on this machine)"), "{said}");
}
