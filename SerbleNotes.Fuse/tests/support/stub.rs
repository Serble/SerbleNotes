//! A throwaway HTTP server, for testing the half of this client that talks to a real one.
//!
//! `api.rs` is the only part of this crate with no seam a fake can be slid under: everything below
//! it is `ureq`, the URLs it builds, the headers it sets and the shapes `serde` makes of the JSON
//! that comes back. A `Backend` fake tests none of that, and that is exactly where a mismatch with
//! the backend would live - a renamed field, a status read the wrong way round, base64 that does
//! not survive the round trip.
//!
//! So this answers real requests on a real socket. It records everything it was asked, which is how
//! a test checks that a header was sent or a query was built the way the server's route expects.

#![allow(dead_code)]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// One request, as the server saw it.
#[derive(Debug, Clone)]
pub struct Asked {
    pub method: String,
    /// Path and query exactly as it arrived, unescaped by nothing.
    pub target: String,
    pub headers: HashMap<String, String>,
    pub body: String,
}

impl Asked {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(&name.to_ascii_lowercase()).map(String::as_str)
    }
}

/// What to answer with.
pub struct Reply {
    pub status: u16,
    pub content_type: &'static str,
    pub body: String,
}

impl Reply {
    pub fn json(body: impl Into<String>) -> Reply {
        Reply { status: 200, content_type: "application/json", body: body.into() }
    }

    pub fn status(status: u16, body: impl Into<String>) -> Reply {
        Reply { status, content_type: "application/json", body: body.into() }
    }

    pub fn text(status: u16, body: impl Into<String>) -> Reply {
        Reply { status, content_type: "text/html", body: body.into() }
    }

    /// No content at all, which is what a successful DELETE answers with.
    pub fn empty() -> Reply {
        Reply { status: 204, content_type: "application/json", body: String::new() }
    }
}

pub struct StubServer {
    port: u16,
    asked: Arc<Mutex<Vec<Asked>>>,
    stop: Arc<AtomicBool>,
}

impl StubServer {
    /// Starts answering, on a port the operating system picks.
    pub fn start(handler: impl Fn(&Asked) -> Reply + Send + Sync + 'static) -> StubServer {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        listener.set_nonblocking(true).expect("nonblocking");

        let asked = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));

        let recorded = Arc::clone(&asked);
        let stopping = Arc::clone(&stop);
        std::thread::spawn(move || {
            while !stopping.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        if let Some(request) = read_request(&stream) {
                            let reply = handler(&request);
                            recorded.lock().expect("lock").push(request);
                            write_reply(stream, &reply);
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                    Err(_) => return,
                }
            }
        });

        StubServer { port, asked, stop }
    }

    /// Answers everything the same way.
    pub fn always(reply: impl Fn() -> Reply + Send + Sync + 'static) -> StubServer {
        StubServer::start(move |_| reply())
    }

    /// The origin to hand `HttpBackend`, with no `/api` on it.
    pub fn base(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// An address nothing is listening on, for the case where the server cannot be reached.
    pub fn unreachable() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        drop(listener);
        format!("http://127.0.0.1:{port}")
    }

    pub fn asked(&self) -> Vec<Asked> {
        self.asked.lock().expect("lock").clone()
    }

    pub fn last(&self) -> Asked {
        self.asked().pop().expect("nothing was asked")
    }
}

impl Drop for StubServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

fn read_request(stream: &TcpStream) -> Option<Asked> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);

    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();

    let mut headers = HashMap::new();
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).ok()? == 0 {
            break;
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    let length: usize = headers
        .get("content-length")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);

    let mut body = vec![0u8; length];
    if length > 0 {
        reader.read_exact(&mut body).ok()?;
    }

    Some(Asked {
        method,
        target,
        headers,
        body: String::from_utf8_lossy(&body).to_string(),
    })
}

fn write_reply(mut stream: TcpStream, reply: &Reply) {
    // `Connection: close` on purpose: a pooled connection makes a test depend on whether the client
    // reused one, which is not what any of these are about.
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        reply.status,
        if reply.status == 204 { "No Content" } else { "OK" },
        reply.content_type,
        reply.body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(reply.body.as_bytes());
    let _ = stream.flush();
}
