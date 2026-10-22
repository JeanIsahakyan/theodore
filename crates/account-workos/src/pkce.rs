//! PKCE (RFC 7636, `S256` only) and the `state` CSRF token.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::rand::{SecureRandom, SystemRandom};
use sha2::{Digest, Sha256};
use theodore_ports::{AccountError, AccountResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

/// 32 random bytes, base64url: 43 chars, inside RFC 7636's 43..=128 and
/// its unreserved alphabet.
pub fn random_token() -> AccountResult<String> {
    let mut bytes = [0u8; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| AccountError::Protocol("no system randomness".into()))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub fn generate() -> AccountResult<Pkce> {
    let verifier = random_token()?;
    let challenge = challenge_for(&verifier);
    Ok(Pkce {
        verifier,
        challenge,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_matches_the_rfc_7636_example() {
        // RFC 7636 appendix B.
        assert_eq!(
            challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn verifier_is_a_valid_rfc_7636_verifier() {
        let p = generate().unwrap();
        assert_eq!(p.verifier.len(), 43);
        assert!(
            p.verifier
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-._~".contains(c))
        );
        assert_eq!(p.challenge, challenge_for(&p.verifier));
        assert!(!p.challenge.contains('='));
    }

    #[test]
    fn every_call_is_fresh() {
        let a = generate().unwrap();
        let b = generate().unwrap();
        assert_ne!(a.verifier, b.verifier);
        assert_ne!(random_token().unwrap(), random_token().unwrap());
    }
}
