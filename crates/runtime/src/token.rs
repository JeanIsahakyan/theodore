//! Host token lookup: keychain → `gh auth token` → `GITHUB_TOKEN` (plan §6.8).

use std::sync::{Arc, Mutex};

use theodore_contract::TokenSource as ContractTokenSource;
use theodore_domain::RepoRef;
use theodore_ports::{CredentialSource, Secrets};

/// A cached `gh`/env fallback lookup, remembering which of the two (if any)
/// answered, so `HostToken::source` can report it (plan §6.8).
#[derive(Clone)]
enum Fallback {
    Gh(String),
    Env(String),
    None,
}

pub struct HostToken {
    secrets: Arc<dyn Secrets>,
    fallback: Mutex<Option<Fallback>>,
}

impl HostToken {
    pub fn new(secrets: Arc<dyn Secrets>) -> Self {
        Self {
            secrets,
            fallback: Mutex::new(None),
        }
    }

    fn fallback(&self) -> Fallback {
        let mut cached = self.fallback.lock().unwrap_or_else(|p| p.into_inner());
        cached.get_or_insert_with(compute_fallback).clone()
    }

    /// Drops the cached `gh`/env lookup, so the next read re-checks the
    /// environment. Call this after the keychain token changes (set or
    /// removed) — a stale cache would otherwise keep answering with
    /// whatever the fallback was before the keychain token existed.
    pub fn invalidate_fallback(&self) {
        *self.fallback.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
}

/// `TokenSource::token`/`TokenStatus::source` are synchronous trait methods
/// (implemented across crates this slice doesn't own, so their signatures
/// aren't ours to change), but this still runs from inside an async
/// context on every call. `block_in_place` moves the actual blocking
/// `Command::output()` off the current worker thread's task queue instead
/// of stalling it for however long `gh` takes to spawn and answer.
fn gh_token() -> Option<String> {
    tokio::task::block_in_place(|| {
        std::process::Command::new("gh")
            .args(["auth", "token"])
            .stderr(std::process::Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    })
}

fn env_token() -> Option<String> {
    std::env::var("GITHUB_TOKEN").ok().filter(|t| !t.is_empty())
}

fn compute_fallback() -> Fallback {
    if let Some(t) = gh_token() {
        return Fallback::Gh(t);
    }
    if let Some(t) = env_token() {
        return Fallback::Env(t);
    }
    Fallback::None
}

impl theodore_host_http::TokenSource for HostToken {
    fn token(&self) -> Option<String> {
        match self.secrets.get(theodore_secrets::GITHUB_TOKEN) {
            Ok(Some(t)) => Some(t),
            _ => match self.fallback() {
                Fallback::Gh(t) | Fallback::Env(t) => Some(t),
                Fallback::None => None,
            },
        }
    }
}

impl CredentialSource for HostToken {
    fn token_for(&self, repo: &RepoRef) -> Option<String> {
        match repo.host {
            theodore_domain::HostKind::Gitlab => GitlabToken::new(self.secrets.clone()).lookup(),
            _ => theodore_host_http::TokenSource::token(self),
        }
    }
}

/// GitLab token: keychain → `GITLAB_TOKEN`.
pub struct GitlabToken {
    secrets: Arc<dyn Secrets>,
}

impl GitlabToken {
    pub fn new(secrets: Arc<dyn Secrets>) -> Self {
        Self { secrets }
    }

    fn lookup(&self) -> Option<String> {
        match self.secrets.get(theodore_secrets::GITLAB_TOKEN) {
            Ok(Some(t)) => Some(t),
            _ => std::env::var("GITLAB_TOKEN").ok().filter(|t| !t.is_empty()),
        }
    }
}

impl theodore_host_http::TokenSource for GitlabToken {
    fn token(&self) -> Option<String> {
        self.lookup()
    }
}

impl theodore_app::TokenStatus for HostToken {
    fn source(&self) -> ContractTokenSource {
        if matches!(
            self.secrets.get(theodore_secrets::GITHUB_TOKEN),
            Ok(Some(_))
        ) {
            return ContractTokenSource::Keychain;
        }
        match self.fallback() {
            Fallback::Gh(_) => ContractTokenSource::Gh,
            Fallback::Env(_) => ContractTokenSource::Env,
            Fallback::None => ContractTokenSource::None,
        }
    }

    fn invalidate(&self) {
        self.invalidate_fallback();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `block_in_place` panics outside a multi-threaded runtime; every real
    /// caller (desktop, cli) runs one, so exercise `gh_token` under the same
    /// flavor here rather than `#[tokio::test]`'s current-thread default.
    #[tokio::test(flavor = "multi_thread")]
    async fn gh_token_lookup_does_not_panic_on_a_multi_thread_runtime() {
        let _ = gh_token();
    }
}
