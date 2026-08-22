//! Shared core for every Serble Notes client.
//!
//! Two responsibilities live here and nowhere else: the crypto that makes a vault end-to-end
//! encrypted, and the version-control logic that turns edits into a DAG of diffs. Clients are
//! presentation on top of this - no client reimplements any of it, and neither does the backend,
//! which only ever sees the ciphertext this module produces.

mod crypto;
mod path;
mod version;

pub use crypto::*;
pub use path::*;
pub use version::*;
