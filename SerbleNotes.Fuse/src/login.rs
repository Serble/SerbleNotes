//! Signing in to Serble from a terminal.
//!
//! Serble login is what gates access to vaults at all, and it is deliberately independent of the
//! encryption: an account gets you ciphertext, and only the vault password turns that into notes.
//! The exchange is the same one every other client does - Serble hands back a `code`, this posts it
//! to `/api/account`, and the backend trades it at Serble and issues its own JWT, which is what
//! every later request carries.
//!
//! What is different here is where the redirect lands. The web client comes back to a page it owns
//! and the Tauri shell registers `serblenotes://auth/callback` with the operating system; a command
//! line program has neither. So it listens on a fixed loopback port for exactly one request.
//!
//! **`http://127.0.0.1:41780/auth/callback` has to be on the Serble application registration**, the
//! same way the native scheme does, or sign-in fails with `redirect-uri-mismatch` before the
//! consent screen is ever shown. The port is fixed rather than picked at random because a
//! registration is an exact string.
//!
//! The browser opened is the real system browser, which is the point: this program never sees the
//! Serble password.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

const AUTHORIZE_URL: &str = "https://serble.net/oauth/authorize";

/// The port the redirect comes back to. Must match the Serble application registration exactly.
pub const LOOPBACK_PORT: u16 = 41780;

pub fn redirect_uri() -> String {
    format!("http://127.0.0.1:{LOOPBACK_PORT}/auth/callback")
}

/// How long to hold the port open waiting for somebody to finish signing in.
const PATIENCE: Duration = Duration::from_secs(300);

/// The sign-in URL for this deployment's application id.
pub fn authorize_url(app_id: &str, state: &str) -> String {
    let encode = |value: &str| {
        percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC).to_string()
    };

    format!(
        "{AUTHORIZE_URL}?client_id={}&redirect_uri={}&response_type=token&scope=user_info&state={}",
        encode(app_id),
        encode(&redirect_uri()),
        encode(state),
    )
}

/// Serble refuses a state containing anything but letters and digits, so this is hex rather than a
/// UUID - a UUID's hyphens come back as `invalid-state` instead of a login.
pub fn new_state() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("the operating system has no randomness available");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Waits for the browser to come back, and hands over the code it brought.
///
/// The listener is opened *before* the browser, so a login that completes instantly - because the
/// session is already signed in to Serble - cannot arrive before there is anything listening.
pub struct Callback {
    listener: TcpListener,
    state: String,
}

impl Callback {
    pub fn listen(state: &str) -> Result<Callback, String> {
        Callback::listen_on(LOOPBACK_PORT, state)
    }

    /// On a named port. `0` lets the operating system pick one, which is what the tests use: the
    /// real port is fixed because a registration is an exact string, and two tests cannot both have
    /// it.
    pub fn listen_on(port: u16, state: &str) -> Result<Callback, String> {
        let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| {
            format!(
                "Could not listen on 127.0.0.1:{port} ({e}). Another copy of this program may \
                 already be signing in. Use --no-browser to paste the address back instead."
            )
        })?;
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("Could not set up the callback listener: {e}"))?;

        Ok(Callback {
            listener,
            state: state.to_string(),
        })
    }

    /// The port it is actually listening on.
    pub fn port(&self) -> u16 {
        self.listener.local_addr().map(|addr| addr.port()).unwrap_or(0)
    }

    /// Blocks until the redirect arrives, and answers the browser with a page saying so.
    pub fn wait(self) -> Result<String, String> {
        let deadline = Instant::now() + PATIENCE;

        loop {
            match self.listener.accept() {
                Ok((stream, _)) => return self.answer(stream),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() > deadline {
                        return Err("Timed out waiting for the browser to come back.".into());
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => return Err(format!("The callback listener failed: {e}")),
            }
        }
    }

    fn answer(&self, mut stream: TcpStream) -> Result<String, String> {
        let mut line = String::new();
        BufReader::new(
            stream
                .try_clone()
                .map_err(|e| format!("Could not read the callback: {e}"))?,
        )
        .read_line(&mut line)
        .map_err(|e| format!("Could not read the callback: {e}"))?;

        // "GET /auth/callback?code=...&state=... HTTP/1.1"
        let target = line.split_whitespace().nth(1).unwrap_or("");
        let result = code_from(target, &self.state);

        let body = match &result {
            Ok(_) => "<h1>Signed in</h1><p>You can close this tab and go back to the terminal.</p>",
            Err(_) => "<h1>Sign-in failed</h1><p>The terminal says what went wrong.</p>",
        };
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
             Connection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.flush();

        result
    }
}

/// Pulls the code out of a redirect, checking the state it came back with.
///
/// The state is what ties the redirect to the request this program made. Without the check, any
/// page the user visits could send them to this port with a code of somebody else's choosing.
pub fn code_from(target: &str, expected_state: &str) -> Result<String, String> {
    let query = target.split_once('?').map(|(_, query)| query).unwrap_or("");

    let mut code = None;
    let mut state = None;
    let mut error = None;

    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        let value = percent_encoding::percent_decode_str(value)
            .decode_utf8_lossy()
            .replace('+', " ");
        match key {
            "code" => code = Some(value),
            "state" => state = Some(value),
            "error" | "error_description" => error = Some(value),
            _ => {}
        }
    }

    if let Some(error) = error {
        return Err(format!("Serble refused the sign-in: {error}"));
    }

    match (code, state) {
        (Some(code), Some(state)) if state == expected_state => Ok(code),
        (Some(_), _) => Err(
            "The sign-in came back with a state that does not match the one this program sent, so \
             it is not the sign-in this program started. Nothing was saved."
                .into(),
        ),
        _ => Err("That address has no sign-in code in it.".into()),
    }
}

/// Hands a URL to whatever the desktop uses to open one. A failure is not fatal - the URL is
/// printed as well, and on a machine with no browser that is the whole of the flow.
pub fn open_browser(url: &str) -> bool {
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };

    std::process::Command::new(opener)
        .arg(url)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sends one request to a listening `Callback`, the way a browser would, and hands back what
    /// the browser was shown.
    fn as_a_browser(port: u16, target: &str) -> String {
        use std::io::{Read, Write};

        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect");
        write!(stream, "GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").expect("write");
        stream.flush().expect("flush");

        let mut shown = String::new();
        let _ = stream.read_to_string(&mut shown);
        shown
    }

    #[test]
    fn a_redirect_that_arrives_hands_over_its_code() {
        let callback = Callback::listen_on(0, "deadbeef").unwrap();
        let port = callback.port();

        let browser = std::thread::spawn(move || {
            as_a_browser(port, "/auth/callback?code=the-code&state=deadbeef")
        });

        assert_eq!(callback.wait().unwrap(), "the-code");
        let shown = browser.join().unwrap();
        assert!(shown.contains("200 OK"), "the browser has to be answered: {shown}");
        assert!(shown.contains("Signed in"), "{shown}");
    }

    #[test]
    fn a_redirect_this_program_did_not_start_is_refused_and_still_answered() {
        // Any page the user visits can send them to this port. Without the state check it could
        // choose the code, and this program would exchange it for a session.
        let callback = Callback::listen_on(0, "deadbeef").unwrap();
        let port = callback.port();

        let browser = std::thread::spawn(move || {
            as_a_browser(port, "/auth/callback?code=somebody-elses&state=not-ours")
        });

        assert!(callback.wait().is_err());
        let shown = browser.join().unwrap();
        assert!(shown.contains("Sign-in failed"), "the browser must not be left hanging: {shown}");
    }

    #[test]
    fn serbles_own_refusal_reaches_the_terminal() {
        let callback = Callback::listen_on(0, "deadbeef").unwrap();
        let port = callback.port();

        let browser = std::thread::spawn(move || {
            as_a_browser(port, "/auth/callback?error=redirect-uri-mismatch&state=deadbeef")
        });

        let said = callback.wait().unwrap_err();
        assert!(said.contains("redirect-uri-mismatch"), "{said}");
        let _ = browser.join();
    }

    #[test]
    fn the_port_is_the_one_the_registration_names() {
        // It is fixed because a redirect URI on an application registration is an exact string.
        assert_eq!(LOOPBACK_PORT, 41780);
        assert!(redirect_uri().contains(&LOOPBACK_PORT.to_string()));
        assert!(redirect_uri().starts_with("http://127.0.0.1:"));
        assert!(redirect_uri().ends_with("/auth/callback"));
    }

    #[test]
    fn a_port_already_in_use_is_reported_rather_than_waited_on() {
        let first = Callback::listen_on(0, "deadbeef").unwrap();
        let taken = first.port();

        let refused = match Callback::listen_on(taken, "deadbeef") {
            Err(said) => said,
            Ok(_) => panic!("two programs cannot both own the port a registration names"),
        };
        assert!(refused.contains("--no-browser"), "it has to say what to do instead: {refused}");
    }

    #[test]
    fn the_code_comes_out_of_the_redirect() {
        let target = "/auth/callback?code=abc123&state=deadbeef";
        assert_eq!(code_from(target, "deadbeef").unwrap(), "abc123");
    }

    #[test]
    fn a_state_that_does_not_match_is_refused() {
        let target = "/auth/callback?code=abc123&state=somebodyelse";
        assert!(code_from(target, "deadbeef").is_err());
    }

    #[test]
    fn a_redirect_with_no_code_is_refused_rather_than_read_as_empty() {
        assert!(code_from("/auth/callback", "deadbeef").is_err());
        assert!(code_from("/auth/callback?state=deadbeef", "deadbeef").is_err());
    }

    #[test]
    fn serbles_own_error_is_reported_rather_than_becoming_no_code() {
        let target = "/auth/callback?error=redirect-uri-mismatch&state=deadbeef";
        let message = code_from(target, "deadbeef").unwrap_err();
        assert!(message.contains("redirect-uri-mismatch"));
    }

    #[test]
    fn every_sign_in_gets_a_state_of_its_own() {
        // The state is the only thing tying a redirect to the request this program made. A
        // constant one would be no check at all: anything that had seen it once could send a code
        // of its own choosing to this port and have it exchanged for a session.
        let states: std::collections::HashSet<String> = (0..50).map(|_| new_state()).collect();
        assert_eq!(states.len(), 50, "two sign-ins shared a state");
        assert!(new_state().len() >= 32, "and it has to be long enough to be worth checking");
    }

    #[test]
    fn the_state_is_something_serble_accepts() {
        let state = new_state();
        assert!(state.chars().all(|c| c.is_ascii_alphanumeric()), "letters and digits only");
    }

    #[test]
    fn the_authorize_url_carries_the_loopback_redirect() {
        let url = authorize_url("app-id", "deadbeef");
        assert!(url.contains("client_id=app%2Did"));
        assert!(url.contains(&format!("127%2E0%2E0%2E1%3A{LOOPBACK_PORT}")));
        assert!(url.contains("state=deadbeef"));
    }
}
