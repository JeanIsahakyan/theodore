//! Bearer token source. Adapters inject one backed by the keychain; tests use
//! [`StaticToken`].

/// Supplies the bearer token for outgoing requests. `None` means "send
/// unauthenticated" (some read endpoints on some hosts allow it).
pub trait TokenSource: Send + Sync {
    fn token(&self) -> Option<String>;
}

/// A fixed token, or none. Useful for tests and for callers that already
/// resolved the token once (e.g. from `gh auth token`).
pub struct StaticToken(pub Option<String>);

impl StaticToken {
    pub fn new(token: impl Into<String>) -> Self {
        Self(Some(token.into()))
    }

    pub fn none() -> Self {
        Self(None)
    }
}

impl TokenSource for StaticToken {
    fn token(&self) -> Option<String> {
        self.0.clone()
    }
}
