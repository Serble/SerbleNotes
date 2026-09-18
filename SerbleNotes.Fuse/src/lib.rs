//! Mounts a Serble Notes vault as a directory of markdown files.
//!
//! The binary is `main.rs`; everything it does is here so the tests can drive the same code with an
//! in-memory server in place of a real one.
//!
//! The one rule this crate lives under is the project's: **the server never sees plaintext.** Every
//! name and every body crossing `api.rs` is ciphertext, and the only thing that turns it back into
//! text is the Rust core, which this crate links and never reimplements.

pub mod api;
pub mod cache;
pub mod config;
pub mod fs;
pub mod ids;
pub mod login;
pub mod mountpoint;
pub mod names;
pub mod store;
pub mod sync;
pub mod tree;
pub mod unlock;
pub mod vaults;
