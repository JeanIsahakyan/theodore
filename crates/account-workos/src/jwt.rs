//! Access-token validation: RS256 against the provider's public JWKS, then
//! issuer, expiry and subject.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::signature::{RSA_PKCS1_2048_8192_SHA256, RsaPublicKeyComponents};
use serde::Deserialize;
use theodore_ports::{AccountError, AccountResult};

/// Clock skew tolerated on `exp`.
pub const LEEWAY_SECS: i64 = 60;

#[derive(Debug, Clone, Deserialize)]
pub struct Jwk {
    pub kid: Option<String>,
    pub kty: String,
    pub n: Option<String>,
    pub e: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Jwks {
    pub keys: Vec<Jwk>,
}

#[derive(Debug, Deserialize)]
struct Header {
    alg: String,
    kid: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub iss: Option<String>,
    pub exp: i64,
    pub sid: Option<String>,
    pub org_id: Option<String>,
    pub client_id: Option<String>,
}

/// A token split into its parts, before any check.
pub struct Parsed<'a> {
    pub kid: Option<String>,
    pub claims: Claims,
    signing_input: &'a str,
    signature: Vec<u8>,
}

fn b64(part: &str) -> AccountResult<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(part)
        .map_err(|e| AccountError::InvalidToken(format!("bad base64url: {e}")))
}

pub fn parse(token: &str) -> AccountResult<Parsed<'_>> {
    let mut parts = token.split('.');
    let (Some(h), Some(p), Some(s), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(AccountError::InvalidToken("not a JWT".into()));
    };
    let header: Header = serde_json::from_slice(&b64(h)?)
        .map_err(|e| AccountError::InvalidToken(format!("bad header: {e}")))?;
    if header.alg != "RS256" {
        return Err(AccountError::InvalidToken(format!(
            "unexpected alg {:?}",
            header.alg
        )));
    }
    let claims: Claims = serde_json::from_slice(&b64(p)?)
        .map_err(|e| AccountError::InvalidToken(format!("bad claims: {e}")))?;
    Ok(Parsed {
        kid: header.kid,
        claims,
        signing_input: &token[..h.len() + 1 + p.len()],
        signature: b64(s)?,
    })
}

/// The key `kid` names; with no `kid`, the only RSA key if there is one.
pub fn find_key<'a>(jwks: &'a Jwks, kid: Option<&str>) -> Option<&'a Jwk> {
    let rsa = jwks.keys.iter().filter(|k| k.kty == "RSA");
    match kid {
        Some(kid) => rsa.into_iter().find(|k| k.kid.as_deref() == Some(kid)),
        None => {
            let all: Vec<_> = rsa.collect();
            (all.len() == 1).then(|| all[0])
        }
    }
}

pub fn verify_signature(parsed: &Parsed<'_>, key: &Jwk) -> AccountResult<()> {
    let (Some(n), Some(e)) = (&key.n, &key.e) else {
        return Err(AccountError::InvalidToken(
            "JWK has no RSA components".into(),
        ));
    };
    let components = RsaPublicKeyComponents {
        n: b64(n)?,
        e: b64(e)?,
    };
    components
        .verify(
            &RSA_PKCS1_2048_8192_SHA256,
            parsed.signing_input.as_bytes(),
            &parsed.signature,
        )
        .map_err(|_| AccountError::InvalidToken("signature doesn't verify".into()))
}

/// Issuer, expiry, audience and subject. `issuers` are the accepted `iss`
/// values (trailing slashes ignored); `expected_sub` is the user id the
/// token came back with.
pub fn check_claims(
    claims: &Claims,
    issuers: &[String],
    client_id: &str,
    expected_sub: &str,
    now_secs: i64,
) -> AccountResult<()> {
    let trim = |s: &str| s.trim_end_matches('/').to_string();
    // AuthKit access tokens name the client in the issuer:
    // `https://api.workos.com/user_management/<client_id>`.
    let accepted = |iss: &str| {
        issuers.iter().any(|i| {
            trim(i) == trim(iss) || format!("{}/user_management/{client_id}", trim(i)) == trim(iss)
        })
    };
    match &claims.iss {
        Some(iss) if accepted(iss) => {}
        other => {
            return Err(AccountError::InvalidToken(format!(
                "unexpected issuer {other:?}"
            )));
        }
    }
    if claims.exp + LEEWAY_SECS < now_secs {
        return Err(AccountError::InvalidToken("token expired".into()));
    }
    if let Some(cid) = &claims.client_id
        && cid != client_id
    {
        return Err(AccountError::InvalidToken(format!(
            "token is for client {cid:?}"
        )));
    }
    if claims.sub != expected_sub {
        return Err(AccountError::InvalidToken(
            "token subject doesn't match the user".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod testing {
    //! Signs tokens with a throwaway RSA key (`testdata/`, generated for
    //! these tests only; it protects nothing) whose public half is
    //! `testdata/jwks.json`.

    use super::*;
    use ring::rand::SystemRandom;
    use ring::signature::{RSA_PKCS1_SHA256, RsaKeyPair};

    pub const KEY: &[u8] = include_bytes!("../testdata/test-only-rsa-key.pk8");
    pub const JWKS: &str = include_str!("../testdata/jwks.json");
    pub const KID: &str = "test-key-1";

    pub fn sign(header: &serde_json::Value, claims: &serde_json::Value) -> String {
        let h = URL_SAFE_NO_PAD.encode(header.to_string());
        let p = URL_SAFE_NO_PAD.encode(claims.to_string());
        let input = format!("{h}.{p}");
        let key = RsaKeyPair::from_pkcs8(KEY).expect("test key");
        let mut sig = vec![0u8; key.public().modulus_len()];
        key.sign(
            &RSA_PKCS1_SHA256,
            &SystemRandom::new(),
            input.as_bytes(),
            &mut sig,
        )
        .expect("sign");
        format!("{input}.{}", URL_SAFE_NO_PAD.encode(sig))
    }

    pub fn token(claims: &serde_json::Value) -> String {
        sign(
            &serde_json::json!({"alg": "RS256", "typ": "JWT", "kid": KID}),
            claims,
        )
    }

    pub fn jwks() -> Jwks {
        serde_json::from_str(JWKS).expect("jwks fixture")
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_800_000_000;

    fn claims() -> serde_json::Value {
        json!({
            "iss": "https://api.workos.com",
            "sub": "user_1",
            "sid": "session_1",
            "org_id": "org_1",
            "exp": NOW + 300,
            "iat": NOW,
            "jti": "j1",
        })
    }

    fn issuers() -> Vec<String> {
        vec!["https://api.workos.com/".into()]
    }

    #[test]
    fn a_good_token_verifies() {
        let t = token(&claims());
        let parsed = parse(&t).unwrap();
        assert_eq!(parsed.kid.as_deref(), Some(KID));
        let jwks = jwks();
        let key = find_key(&jwks, parsed.kid.as_deref()).unwrap();
        verify_signature(&parsed, key).unwrap();
        check_claims(&parsed.claims, &issuers(), "client_1", "user_1", NOW).unwrap();
        assert_eq!(parsed.claims.sid.as_deref(), Some("session_1"));
        assert_eq!(parsed.claims.org_id.as_deref(), Some("org_1"));
    }

    #[test]
    fn a_tampered_payload_fails_the_signature() {
        let t = token(&claims());
        let mut parts: Vec<&str> = t.split('.').collect();
        let mut forged = claims();
        forged["sub"] = json!("user_2");
        let p = URL_SAFE_NO_PAD.encode(forged.to_string());
        parts[1] = &p;
        let forged = parts.join(".");
        let parsed = parse(&forged).unwrap();
        let jwks = jwks();
        let key = find_key(&jwks, parsed.kid.as_deref()).unwrap();
        assert!(matches!(
            verify_signature(&parsed, key),
            Err(AccountError::InvalidToken(_))
        ));
    }

    #[test]
    fn other_algorithms_are_refused() {
        let t = sign(&json!({"alg": "HS256", "kid": KID}), &claims());
        assert!(matches!(parse(&t), Err(AccountError::InvalidToken(_))));
        let t = sign(&json!({"alg": "none"}), &claims());
        assert!(matches!(parse(&t), Err(AccountError::InvalidToken(_))));
        assert!(matches!(parse("a.b"), Err(AccountError::InvalidToken(_))));
    }

    #[test]
    fn claims_checks() {
        let base: Claims = serde_json::from_value(claims()).unwrap();
        check_claims(&base, &issuers(), "c", "user_1", NOW).unwrap();

        let mut c = base.clone();
        c.iss = Some("https://evil.example".into());
        assert!(check_claims(&c, &issuers(), "c", "user_1", NOW).is_err());

        let mut c = base.clone();
        c.iss = None;
        assert!(check_claims(&c, &issuers(), "c", "user_1", NOW).is_err());

        let mut c = base.clone();
        c.exp = NOW - LEEWAY_SECS - 1;
        assert!(check_claims(&c, &issuers(), "c", "user_1", NOW).is_err());
        c.exp = NOW - LEEWAY_SECS + 1;
        assert!(check_claims(&c, &issuers(), "c", "user_1", NOW).is_ok());

        let mut c = base.clone();
        c.client_id = Some("other".into());
        assert!(check_claims(&c, &issuers(), "c", "user_1", NOW).is_err());
        c.client_id = Some("c".into());
        assert!(check_claims(&c, &issuers(), "c", "user_1", NOW).is_ok());

        assert!(check_claims(&base, &issuers(), "c", "user_2", NOW).is_err());
    }

    #[test]
    fn find_key_by_kid_or_the_only_one() {
        let jwks = jwks();
        assert!(find_key(&jwks, Some(KID)).is_some());
        assert!(find_key(&jwks, Some("nope")).is_none());
        assert!(find_key(&jwks, None).is_some());
    }

    #[test]
    fn accepts_the_user_management_issuer_of_this_client() {
        let mut c = claims();
        c["iss"] = json!("https://api.workos.com/user_management/client_1");
        let t = token(&c);
        let parsed = parse(&t).unwrap();
        check_claims(&parsed.claims, &issuers(), "client_1", "user_1", NOW).unwrap();

        c["iss"] = json!("https://api.workos.com/user_management/client_2");
        let t = token(&c);
        let parsed = parse(&t).unwrap();
        assert!(check_claims(&parsed.claims, &issuers(), "client_1", "user_1", NOW).is_err());
    }
}
