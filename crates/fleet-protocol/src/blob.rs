//! Files between devices (docs/fleet.md "Files (blobs)"): a file is split
//! into chunks, each encrypted for the recipient's device key, stored in the
//! cloud under a random blob id and fetched by the recipient. The cloud sees
//! only ciphertext; the [`BlobRef`] that describes the blob travels inside a
//! signed request or reply.
//!
//! ```text
//! "theodore-blob-v1"
//! recipient   x25519_pk = birational(ed25519 pk)      x25519_sk = clamp(SHA-512(seed)[..32])
//! sender      eph_sk random ─▶ eph_pk
//!             shared = X25519(eph_sk, x25519_pk)
//!             key    = HKDF-SHA256(ikm = shared, salt = eph_pk ‖ x25519_pk, info = "theodore-blob-v1", 32)
//! chunk i     XChaCha20-Poly1305(key, nonce = nonce_prefix(16) ‖ u64be(i),
//!                                aad = blob_id ‖ u32be(i) ‖ u32be(chunks), plaintext[i·4 MiB ..])
//! BlobRef     blob_id, name, mime, size, chunks, sha256(plaintext), eph_pk, nonce_prefix
//! ```
//!
//! No new key, no new trust: the recipient's encryption key is derived from
//! the ed25519 key every device already pins, exactly as libsodium's
//! `crypto_sign_ed25519_pk_to_curve25519` / `_sk_to_curve25519` do.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use curve25519_dalek::edwards::CompressedEdwardsY;
use hkdf::Hkdf;
use ring::rand::{SecureRandom, SystemRandom};
use sha2::{Digest, Sha256, Sha512};
use x25519_dalek::{PublicKey, StaticSecret};

use crate::{BlobRef, b64, unb64};

/// The HKDF info and the scheme's name.
pub const INFO: &[u8] = b"theodore-blob-v1";
/// Plaintext bytes per chunk, at most.
pub const CHUNK_BYTES: usize = 4 * 1024 * 1024;
/// The Poly1305 tag after every chunk's ciphertext.
pub const TAG_BYTES: usize = 16;
/// Random bytes every nonce of a blob starts with.
pub const NONCE_PREFIX_BYTES: usize = 16;
/// Chunks per blob, at most (64 × 4 MiB: well over any file sent).
pub const MAX_CHUNKS: u32 = 64;
/// Blobs one request carries, at most.
pub const MAX_ATTACHMENTS: usize = 10;
/// One attachment's plaintext, at most.
pub const MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
/// What a `read_file` hands back, at most (the request's `max_bytes` may
/// ask for less).
pub const MAX_READ_FILE_BYTES: u64 = 50 * 1024 * 1024;
/// A `BlobRef::name`, at most.
pub const MAX_NAME_CHARS: usize = 200;
/// A `BlobRef::mime`, at most.
pub const MAX_MIME_CHARS: usize = 100;
/// A `read_file` path, at most.
pub const MAX_PATH_CHARS: usize = 1024;
/// A blob id: 16 random bytes as lowercase hex.
pub const BLOB_ID_CHARS: usize = 32;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum BlobError {
    /// A field of the [`BlobRef`] is out of its bounds (which one).
    #[error("invalid blob reference: {0}")]
    Invalid(&'static str),
    /// Over [`MAX_CHUNKS`] chunks, or a `size` above what the op allows.
    #[error("file too large")]
    TooLarge,
    #[error("too many attachments")]
    TooManyAttachments,
    /// The recipient's public key isn't a point on the curve.
    #[error("recipient key unusable")]
    BadRecipientKey,
    /// `chunks` doesn't match the reference.
    #[error("expected {expected} chunks, got {got}")]
    ChunkCount { expected: u32, got: usize },
    /// A chunk's tag didn't verify: wrong recipient, tampered, or not this
    /// blob's.
    #[error("chunk {0} doesn't open")]
    Tamper(u32),
    /// The plaintext's size or SHA-256 isn't the reference's.
    #[error("plaintext doesn't match the reference")]
    Digest,
    #[error("no randomness")]
    Rng,
}

// ── keys ────────────────────────────────────────────────────────────────────

/// The X25519 public key of an ed25519 public key (the birational map
/// Edwards ─▶ Montgomery, `u = (1 + y) / (1 − y)`), as libsodium's
/// `crypto_sign_ed25519_pk_to_curve25519`. `None` unless the bytes are a
/// point on the curve.
pub fn x25519_public_from_ed25519(ed25519_pk: &[u8; 32]) -> Option<[u8; 32]> {
    let point = CompressedEdwardsY(*ed25519_pk).decompress()?;
    if point.is_small_order() {
        return None;
    }
    Some(point.to_montgomery().to_bytes())
}

/// The X25519 secret of an ed25519 seed: the first 32 bytes of its
/// SHA-512, clamped, as libsodium's `crypto_sign_ed25519_sk_to_curve25519`.
/// Its X25519 public key is [`x25519_public_from_ed25519`] of the ed25519
/// public key.
pub fn x25519_secret_from_ed25519_seed(seed: &[u8; 32]) -> [u8; 32] {
    let h = Sha512::digest(seed);
    let mut sk = [0u8; 32];
    sk.copy_from_slice(&h[..32]);
    clamp(&mut sk);
    sk
}

/// X25519 scalar clamping (RFC 7748).
pub fn clamp(sk: &mut [u8; 32]) {
    sk[0] &= 248;
    sk[31] &= 127;
    sk[31] |= 64;
}

/// `HKDF-SHA256(ikm = X25519(eph_sk, recipient), salt = eph_pk ‖ recipient,
/// info = INFO)`: the blob's key, and the ephemeral public key that goes
/// in the reference.
pub fn blob_key(eph_sk: &[u8; 32], recipient_x25519_pk: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    let sk = StaticSecret::from(*eph_sk);
    let eph_pk = PublicKey::from(&sk).to_bytes();
    let shared = sk.diffie_hellman(&PublicKey::from(*recipient_x25519_pk));
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(&eph_pk);
    salt[32..].copy_from_slice(recipient_x25519_pk);
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&salt), shared.as_bytes())
        .expand(INFO, &mut key)
        .expect("32 bytes is a valid HKDF length");
    (eph_pk, key)
}

/// The nonce of chunk `i`: `nonce_prefix ‖ u64be(i)`.
pub fn chunk_nonce(nonce_prefix: &[u8; NONCE_PREFIX_BYTES], i: u32) -> [u8; 24] {
    let mut n = [0u8; 24];
    n[..16].copy_from_slice(nonce_prefix);
    n[16..].copy_from_slice(&u64::from(i).to_be_bytes());
    n
}

/// The AAD of chunk `i`: `blob_id ‖ u32be(i) ‖ u32be(chunks)`.
pub fn chunk_aad(blob_id: &str, i: u32, chunks: u32) -> Vec<u8> {
    let mut a = Vec::with_capacity(blob_id.len() + 8);
    a.extend_from_slice(blob_id.as_bytes());
    a.extend_from_slice(&i.to_be_bytes());
    a.extend_from_slice(&chunks.to_be_bytes());
    a
}

/// How many chunks `size` plaintext bytes take (an empty file is one).
pub fn chunk_count(size: u64) -> u64 {
    size.div_ceil(CHUNK_BYTES as u64).max(1)
}

/// A fresh blob id: 16 random bytes, lowercase hex.
pub fn new_blob_id() -> Result<String, BlobError> {
    let mut id = [0u8; 16];
    SystemRandom::new()
        .fill(&mut id)
        .map_err(|_| BlobError::Rng)?;
    Ok(hex::encode(id))
}

// ── seal / open ─────────────────────────────────────────────────────────────

/// What [`seal_blob`] draws at random; fixed for test vectors
/// ([`seal_blob_with`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealParams {
    pub blob_id: String,
    /// Clamped on use (X25519 does), so any 32 bytes do.
    pub eph_sk: [u8; 32],
    pub nonce_prefix: [u8; NONCE_PREFIX_BYTES],
}

impl SealParams {
    pub fn random() -> Result<Self, BlobError> {
        let rng = SystemRandom::new();
        let mut eph_sk = [0u8; 32];
        let mut nonce_prefix = [0u8; NONCE_PREFIX_BYTES];
        rng.fill(&mut eph_sk).map_err(|_| BlobError::Rng)?;
        rng.fill(&mut nonce_prefix).map_err(|_| BlobError::Rng)?;
        Ok(SealParams {
            blob_id: new_blob_id()?,
            eph_sk,
            nonce_prefix,
        })
    }
}

/// Encrypts `plaintext` for the device whose ed25519 public key (base64,
/// as pinned) is `recipient_ed25519_pk`: the reference to put in the
/// request or reply, and the ciphertext chunks to `PUT` in order. `name` is
/// passed through [`safe_attachment_name`].
pub fn seal_blob(
    recipient_ed25519_pk: &str,
    plaintext: &[u8],
    name: &str,
    mime: &str,
) -> Result<(BlobRef, Vec<Vec<u8>>), BlobError> {
    seal_blob_with(
        &SealParams::random()?,
        recipient_ed25519_pk,
        plaintext,
        name,
        mime,
    )
}

/// [`seal_blob`] with the random parts given.
pub fn seal_blob_with(
    params: &SealParams,
    recipient_ed25519_pk: &str,
    plaintext: &[u8],
    name: &str,
    mime: &str,
) -> Result<(BlobRef, Vec<Vec<u8>>), BlobError> {
    let recipient = recipient_x25519(recipient_ed25519_pk)?;
    let chunks = chunk_count(plaintext.len() as u64);
    if chunks > u64::from(MAX_CHUNKS) {
        return Err(BlobError::TooLarge);
    }
    let chunks = chunks as u32;
    let (eph_pk, key) = blob_key(&params.eph_sk, &recipient);
    let cipher = XChaCha20Poly1305::new(&key.into());
    let mut out = Vec::with_capacity(chunks as usize);
    for i in 0..chunks {
        let start = i as usize * CHUNK_BYTES;
        let end = (start + CHUNK_BYTES).min(plaintext.len());
        let nonce = chunk_nonce(&params.nonce_prefix, i);
        let sealed = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &plaintext[start..end],
                    aad: &chunk_aad(&params.blob_id, i, chunks),
                },
            )
            .map_err(|_| BlobError::Tamper(i))?;
        out.push(sealed);
    }
    let r = BlobRef {
        blob_id: params.blob_id.clone(),
        name: safe_attachment_name(name),
        mime: cut(mime, MAX_MIME_CHARS),
        size: plaintext.len() as u64,
        chunks,
        sha256: hex::encode(Sha256::digest(plaintext)),
        eph_pk: b64(&eph_pk),
        nonce_prefix: b64(&params.nonce_prefix),
    };
    r.validate()?;
    Ok((r, out))
}

/// Decrypts a blob sealed for the device with ed25519 seed `own_seed`:
/// every chunk's tag must open and the plaintext must have the reference's
/// size and SHA-256. Nothing is returned on any failure.
pub fn open_blob(
    own_seed: &[u8; 32],
    r: &BlobRef,
    chunks: &[Vec<u8>],
) -> Result<Vec<u8>, BlobError> {
    r.validate()?;
    if chunks.len() != r.chunks as usize {
        return Err(BlobError::ChunkCount {
            expected: r.chunks,
            got: chunks.len(),
        });
    }
    let eph_pk: [u8; 32] = unb64(&r.eph_pk)
        .and_then(|b| b.try_into().ok())
        .ok_or(BlobError::Invalid("eph_pk"))?;
    let nonce_prefix: [u8; NONCE_PREFIX_BYTES] = unb64(&r.nonce_prefix)
        .and_then(|b| b.try_into().ok())
        .ok_or(BlobError::Invalid("nonce_prefix"))?;
    let sk = StaticSecret::from(x25519_secret_from_ed25519_seed(own_seed));
    let own_pk = PublicKey::from(&sk).to_bytes();
    let shared = sk.diffie_hellman(&PublicKey::from(eph_pk));
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(&eph_pk);
    salt[32..].copy_from_slice(&own_pk);
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&salt), shared.as_bytes())
        .expand(INFO, &mut key)
        .expect("32 bytes is a valid HKDF length");
    let cipher = XChaCha20Poly1305::new(&key.into());
    let size = usize::try_from(r.size).map_err(|_| BlobError::TooLarge)?;
    let mut plain = Vec::with_capacity(size);
    for (i, sealed) in (0u32..).zip(chunks) {
        // Bounded before decrypting: a chunk can't be longer than its
        // share of `size` plus the tag.
        if sealed.len() > CHUNK_BYTES + TAG_BYTES {
            return Err(BlobError::Tamper(i));
        }
        let nonce = chunk_nonce(&nonce_prefix, i);
        let part = cipher
            .decrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: sealed,
                    aad: &chunk_aad(&r.blob_id, i, r.chunks),
                },
            )
            .map_err(|_| BlobError::Tamper(i))?;
        plain.extend_from_slice(&part);
    }
    if plain.len() != size || hex::encode(Sha256::digest(&plain)) != r.sha256 {
        return Err(BlobError::Digest);
    }
    Ok(plain)
}

/// The X25519 key of a pinned ed25519 public key (base64).
fn recipient_x25519(ed25519_pk_b64: &str) -> Result<[u8; 32], BlobError> {
    let pk: [u8; 32] = unb64(ed25519_pk_b64)
        .and_then(|b| b.try_into().ok())
        .ok_or(BlobError::BadRecipientKey)?;
    x25519_public_from_ed25519(&pk).ok_or(BlobError::BadRecipientKey)
}

// ── validation ──────────────────────────────────────────────────────────────

impl BlobRef {
    /// Every field within its bounds: the id 32 lowercase hex, the name
    /// 1 to [`MAX_NAME_CHARS`] characters with no `/`, `\` or NUL, the mime
    /// at most [`MAX_MIME_CHARS`], 1 to [`MAX_CHUNKS`] chunks matching
    /// `size`, a 64-hex sha256, 32-byte `eph_pk` and 16-byte `nonce_prefix`
    /// in base64. The size caps of the op (attachment, `read_file`) are
    /// the op's to check.
    pub fn validate(&self) -> Result<(), BlobError> {
        if self.blob_id.len() != BLOB_ID_CHARS || !is_lower_hex(&self.blob_id) {
            return Err(BlobError::Invalid("blob_id"));
        }
        if self.name.is_empty()
            || self.name.chars().count() > MAX_NAME_CHARS
            || self.name.contains(['/', '\\', '\0'])
        {
            return Err(BlobError::Invalid("name"));
        }
        if self.mime.chars().count() > MAX_MIME_CHARS || self.mime.contains(char::is_control) {
            return Err(BlobError::Invalid("mime"));
        }
        if self.chunks == 0 || self.chunks > MAX_CHUNKS {
            return Err(BlobError::Invalid("chunks"));
        }
        if chunk_count(self.size) != u64::from(self.chunks) {
            return Err(BlobError::Invalid("chunks"));
        }
        if self.sha256.len() != 64 || !is_lower_hex(&self.sha256) {
            return Err(BlobError::Invalid("sha256"));
        }
        if unb64(&self.eph_pk).is_none_or(|b| b.len() != 32) {
            return Err(BlobError::Invalid("eph_pk"));
        }
        if unb64(&self.nonce_prefix).is_none_or(|b| b.len() != NONCE_PREFIX_BYTES) {
            return Err(BlobError::Invalid("nonce_prefix"));
        }
        Ok(())
    }
}

fn is_lower_hex(s: &str) -> bool {
    s.bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn cut(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// A file name safe to write under a directory: the last path component
/// only (both separators), control characters and NUL dropped, no leading
/// dots (no hidden files, no `..`), trimmed, cut to [`MAX_NAME_CHARS`]
/// keeping the extension; `file` when nothing is left.
pub fn safe_attachment_name(name: &str) -> String {
    let last = name
        .rsplit(['/', '\\'])
        .find(|p| !p.trim().is_empty())
        .unwrap_or("");
    let cleaned: String = last
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .trim_start_matches('.')
        .trim()
        .to_string();
    if cleaned.is_empty() {
        return "file".to_string();
    }
    if cleaned.chars().count() <= MAX_NAME_CHARS {
        return cleaned;
    }
    // Keep a short extension when cutting.
    let ext = cleaned
        .rsplit_once('.')
        .map(|(_, e)| e)
        .filter(|e| !e.is_empty() && e.chars().count() <= 16 && !e.contains(' '))
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let keep = MAX_NAME_CHARS - ext.chars().count();
    let stem: String = cleaned.chars().take(keep).collect();
    format!("{}{ext}", stem.trim_end())
}
