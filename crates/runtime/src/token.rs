//! Host token lookup: keychain → `gh auth token` → `GITHUB_TOKEN` (plan §6.8).

use std::sync::{Arc, Mutex};

use theodore_domain::RepoRef;
use theodore_ports::{CredentialSource, Secrets};

pub struct HostToken {
    secrets: Arc<dyn Secrets>,
    fallback: Mutex<Option<Option<String>>>,
}

impl HostToken {
    pub fn new(secrets: Arc<dyn Secrets>) -> Self {
        Self {
            secrets,
            fallback: Mutex::new(None),
        }
    }

    fn fallback(&self) -> Option<String> {
        let mut cached = self.fallback.lock().unwrap_or_else(|p| p.into_inner());
        cached.get_or_insert_with(gh_or_env).clone()
    }
}

fn gh_or_env() -> Option<String> {
    let gh = std::process::Command::new("gh")
        .args(["auth", "token"])
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    gh.or_else(|| std::env::var("GITHUB_TOKEN").ok().filter(|t| !t.is_empty()))
}

impl theodore_host_http::TokenSource for HostToken {
    fn token(&self) -> Option<String> {
        match self.secrets.get(theodore_secrets::GITHUB_TOKEN) {
            Ok(Some(t)) => Some(t),
            _ => self.fallback(),
        }
    }
}

impl CredentialSource for HostToken {
    fn token_for(&self, _repo: &RepoRef) -> Option<String> {
        theodore_host_http::TokenSource::token(self)
    }
}
