//! A device's ed25519 key (docs/fleet.md "Trust"). The private half lives in
//! the keychain as PKCS#8 (base64), never on the wire.

use ring::rand::SystemRandom;
use ring::signature::{ED25519, Ed25519KeyPair, KeyPair, UnparsedPublicKey};
use sha2_free::short_hash;

use crate::{b64, unb64};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum KeyError {
    #[error("couldn't generate a device key")]
    Generate,
    #[error("stored device key is unreadable")]
    Unreadable,
}

pub struct DeviceKey {
    pair: Ed25519KeyPair,
    pkcs8_b64: String,
}

impl std::fmt::Debug for DeviceKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceKey")
            .field("public_key", &self.public_key())
            .finish_non_exhaustive()
    }
}

impl DeviceKey {
    pub fn generate() -> Result<Self, KeyError> {
        let doc =
            Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).map_err(|_| KeyError::Generate)?;
        Self::from_pkcs8(doc.as_ref())
    }

    fn from_pkcs8(bytes: &[u8]) -> Result<Self, KeyError> {
        let pair = Ed25519KeyPair::from_pkcs8(bytes).map_err(|_| KeyError::Unreadable)?;
        Ok(DeviceKey {
            pair,
            pkcs8_b64: b64(bytes),
        })
    }

    /// What to store in the keychain.
    pub fn to_secret(&self) -> &str {
        &self.pkcs8_b64
    }

    pub fn from_secret(secret: &str) -> Result<Self, KeyError> {
        let bytes = unb64(secret.trim()).ok_or(KeyError::Unreadable)?;
        Self::from_pkcs8(&bytes)
    }

    /// Base64 of the raw 32-byte public key.
    pub fn public_key(&self) -> String {
        b64(self.pair.public_key().as_ref())
    }

    /// Base64 signature over `msg`.
    pub fn sign(&self, msg: &[u8]) -> String {
        b64(self.pair.sign(msg).as_ref())
    }
}

/// Checks a base64 signature over `msg` against a base64 public key.
pub fn verify(public_key: &str, msg: &[u8], signature: &str) -> bool {
    let (Some(pk), Some(sig)) = (unb64(public_key), unb64(signature)) else {
        return false;
    };
    if pk.len() != 32 {
        return false;
    }
    UnparsedPublicKey::new(&ED25519, pk)
        .verify(msg, &sig)
        .is_ok()
}

/// A human-comparable fingerprint of a public key: the first 128 bits of
/// its SHA-256 as 8 groups of 4 hex characters ("a1b2 c3d4 … 0718"), shown
/// on both devices when trust is given.
pub fn fingerprint(public_key: &str) -> String {
    short_hash(public_key)
}

mod sha2_free {
    //! SHA-256 via ring (no extra dependency).
    use ring::digest::{SHA256, digest};

    pub fn short_hash(s: &str) -> String {
        let d = digest(&SHA256, s.as_bytes());
        let hex: String = d.as_ref()[..16]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        hex.as_bytes()
            .chunks(4)
            .map(|c| std::str::from_utf8(c).unwrap_or_default())
            .collect::<Vec<_>>()
            .join(" ")
    }
}
