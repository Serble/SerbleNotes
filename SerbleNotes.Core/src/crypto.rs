//! Vault key handling and content encryption.
//!
//! A vault has one random 256-bit content key. Everything stored for that vault - note bodies,
//! diffs, restore-point labels - is sealed with it. How that key is protected is what separates an
//! encrypted vault from an unencrypted one, and that decision lives in the caller, not here.

use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, OsRng};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand_core::RngCore;
use wasm_bindgen::prelude::*;

/// Errors cross the wasm boundary as plain strings so the same functions compile, and stay testable,
/// on native targets - where a `JsError` cannot even be constructed.
pub type CoreError = String;

const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 24;

/// Argon2id cost parameters. Stored alongside the vault so they can be raised later without
/// stranding vaults created under the old settings.
#[wasm_bindgen]
pub struct KdfParams {
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
}

#[wasm_bindgen]
impl KdfParams {
    #[wasm_bindgen(constructor)]
    pub fn new(memory_kib: u32, iterations: u32, parallelism: u32) -> KdfParams {
        KdfParams { memory_kib, iterations, parallelism }
    }

    /// Defaults tuned to be painful for an attacker but tolerable on a phone: 64 MiB, 3 passes.
    pub fn recommended() -> KdfParams {
        KdfParams { memory_kib: 64 * 1024, iterations: 3, parallelism: 1 }
    }

    #[wasm_bindgen(getter)]
    pub fn memory_kib(&self) -> u32 { self.memory_kib }

    #[wasm_bindgen(getter)]
    pub fn iterations(&self) -> u32 { self.iterations }

    #[wasm_bindgen(getter)]
    pub fn parallelism(&self) -> u32 { self.parallelism }
}

fn random_bytes(len: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; len];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

/// A fresh random content key for a new vault, base64 encoded.
#[wasm_bindgen]
pub fn generate_vault_key() -> String {
    B64.encode(random_bytes(KEY_BYTES))
}

/// A fresh random Argon2id salt, base64 encoded.
#[wasm_bindgen]
pub fn generate_salt() -> String {
    B64.encode(random_bytes(16))
}

/// Stretches a vault password into a wrapping key. This is the only place a password is ever turned
/// into key material, and the result never leaves the device.
#[wasm_bindgen]
pub fn derive_key(password: &str, salt_b64: &str, params: &KdfParams) -> Result<String, CoreError> {
    let salt = B64
        .decode(salt_b64)
        .map_err(|_| "Salt is not valid base64".to_string())?;

    let argon_params = Params::new(params.memory_kib, params.iterations, params.parallelism, Some(KEY_BYTES))
        .map_err(|e| format!("Invalid Argon2 parameters: {e}"))?;

    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params);

    let mut key = [0u8; KEY_BYTES];
    argon
        .hash_password_into(password.as_bytes(), &salt, &mut key)
        .map_err(|e| format!("Key derivation failed: {e}"))?;

    Ok(B64.encode(key))
}

fn cipher_for(key_b64: &str) -> Result<XChaCha20Poly1305, CoreError> {
    let key = B64
        .decode(key_b64)
        .map_err(|_| "Key is not valid base64".to_string())?;

    if key.len() != KEY_BYTES {
        return Err("Key must be 32 bytes".to_string());
    }

    Ok(XChaCha20Poly1305::new(key.as_slice().into()))
}

/// Encrypts text with a vault key. The random nonce is prepended to the ciphertext, so the caller
/// gets one opaque blob it can hand to the server without understanding any of it.
#[wasm_bindgen]
pub fn seal(key_b64: &str, plaintext: &str) -> Result<String, CoreError> {
    let cipher = cipher_for(key_b64)?;
    let nonce_bytes = random_bytes(NONCE_BYTES);
    let nonce = XNonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|_| "Encryption failed".to_string())?;

    let mut blob = nonce_bytes;
    blob.extend_from_slice(&ciphertext);
    Ok(B64.encode(blob))
}

/// Reverses [`seal`]. A wrong key fails here as an authentication error rather than returning
/// garbage, which is what makes it usable as the password check when unlocking a vault.
#[wasm_bindgen]
pub fn open(key_b64: &str, blob_b64: &str) -> Result<String, CoreError> {
    let cipher = cipher_for(key_b64)?;
    let blob = B64
        .decode(blob_b64)
        .map_err(|_| "Payload is not valid base64".to_string())?;

    if blob.len() <= NONCE_BYTES {
        return Err("Payload is too short to be valid".to_string());
    }

    let (nonce_bytes, ciphertext) = blob.split_at(NONCE_BYTES);
    let plaintext = cipher
        .decrypt(XNonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|_| "Could not decrypt - wrong password or corrupted data".to_string())?;

    String::from_utf8(plaintext).map_err(|_| "Decrypted data is not valid UTF-8".to_string())
}

/// What a vault password change produces. The vault key itself is *unchanged* - only the wrapping
/// around it is new - which is why changing a password re-encrypts nothing and touches no note.
///
/// The flip side is worth being clear about, because the UI has to say it: anyone who kept a copy of
/// the old wrapped blob and knows the old password can still derive this same key, and it opens
/// everything the vault will ever hold. Changing the password closes the door to new devices; it
/// does not take back a key that has already been worked out. Only re-keying the vault would, and
/// that means rewriting every note and every stored version.
#[wasm_bindgen]
pub struct RewrappedKey {
    key: String,
    wrapped_key: String,
    salt: String,
}

#[wasm_bindgen]
impl RewrappedKey {
    /// The vault key, unwrapped. The caller has it now and can cache it on this device.
    #[wasm_bindgen(getter)]
    pub fn key(&self) -> String { self.key.clone() }

    /// The key sealed under the new password. This is what replaces the stored blob.
    #[wasm_bindgen(getter)]
    pub fn wrapped_key(&self) -> String { self.wrapped_key.clone() }

    /// The new salt. Always fresh, so the new wrapping shares nothing with the old one.
    #[wasm_bindgen(getter)]
    pub fn salt(&self) -> String { self.salt.clone() }
}

/// Changes a vault's password: unwrap with the old one, wrap again with the new one.
///
/// The old password is checked here rather than anywhere else, because here is the only place it
/// *can* be checked - the server holds a blob it cannot open, so "is this the right password" only
/// ever means "does it unwrap the key". A wrong one fails as a decryption error before anything new
/// is derived.
///
/// `new_params` is taken separately from the old ones so a password change is also the moment the
/// KDF cost can be raised; a vault made under weaker settings does not have to stay on them.
#[wasm_bindgen]
pub fn rewrap_vault_key(
    wrapped_key_b64: &str,
    old_password: &str,
    old_salt_b64: &str,
    old_params: &KdfParams,
    new_password: &str,
    new_params: &KdfParams,
) -> Result<RewrappedKey, CoreError> {
    let old_wrapping_key = derive_key(old_password, old_salt_b64, old_params)?;

    // Every way this can fail is worth saying in one sentence, because the user is looking at two
    // password fields and needs to know it is the first one. The stored blob being unreadable would
    // land here too, and the parenthesis is there rather than a flat "wrong password" for that case.
    let key = open(&old_wrapping_key, wrapped_key_b64).map_err(|_| {
        "That is not this vault's current password (or its stored key is damaged)".to_string()
    })?;

    let salt = generate_salt();
    let new_wrapping_key = derive_key(new_password, &salt, new_params)?;
    let wrapped_key = seal(&new_wrapping_key, &key)?;

    // Open what we are about to hand back before the caller sends it to the server. The old blob is
    // overwritten by this operation and there is no second copy anywhere, so a wrapping that does not
    // open is the whole vault gone. It costs one decryption of 44 bytes and no key derivation.
    if open(&new_wrapping_key, &wrapped_key)? != key {
        return Err("The new wrapping did not verify - the password was not changed".to_string());
    }

    Ok(RewrappedKey { key, wrapped_key, salt })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_then_open_round_trips() {
        let key = generate_vault_key();
        let blob = seal(&key, "# hello\n\nsome notes").unwrap();
        assert_eq!(open(&key, &blob).unwrap(), "# hello\n\nsome notes");
    }

    #[test]
    fn sealing_twice_gives_different_ciphertext() {
        let key = generate_vault_key();
        assert_ne!(seal(&key, "same").unwrap(), seal(&key, "same").unwrap());
    }

    #[test]
    fn wrong_key_fails_instead_of_returning_garbage() {
        let blob = seal(&generate_vault_key(), "secret").unwrap();
        assert!(open(&generate_vault_key(), &blob).is_err());
    }

    #[test]
    fn same_password_and_salt_derive_the_same_key() {
        let salt = generate_salt();
        let params = KdfParams::new(8, 1, 1);
        let first = derive_key("correct horse", &salt, &params).unwrap();
        let second = derive_key("correct horse", &salt, &params).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn a_different_password_derives_a_different_key() {
        let salt = generate_salt();
        let params = KdfParams::new(8, 1, 1);
        let right = derive_key("correct horse", &salt, &params).unwrap();
        let wrong = derive_key("correct hors", &salt, &params).unwrap();
        assert_ne!(right, wrong);
    }

    #[test]
    fn wrapping_a_vault_key_round_trips() {
        let salt = generate_salt();
        let params = KdfParams::new(8, 1, 1);
        let wrapping_key = derive_key("hunter2", &salt, &params).unwrap();
        let vault_key = generate_vault_key();

        let wrapped = seal(&wrapping_key, &vault_key).unwrap();
        assert_eq!(open(&wrapping_key, &wrapped).unwrap(), vault_key);
    }

    #[test]
    fn changing_the_password_keeps_the_same_vault_key() {
        let params = KdfParams::new(8, 1, 1);
        let salt = generate_salt();
        let key = generate_vault_key();
        let wrapped = seal(&derive_key("old", &salt, &params).unwrap(), &key).unwrap();

        let changed = rewrap_vault_key(&wrapped, "old", &salt, &params, "new", &params).unwrap();

        assert_eq!(changed.key(), key, "the vault key must not change, or every note stops opening");
        let new_wrapping = derive_key("new", &changed.salt(), &params).unwrap();
        assert_eq!(open(&new_wrapping, &changed.wrapped_key()).unwrap(), key);
    }

    #[test]
    fn the_wrong_current_password_changes_nothing() {
        let params = KdfParams::new(8, 1, 1);
        let salt = generate_salt();
        let wrapped = seal(&derive_key("old", &salt, &params).unwrap(), &generate_vault_key()).unwrap();

        assert!(rewrap_vault_key(&wrapped, "not it", &salt, &params, "new", &params).is_err());
    }
}
