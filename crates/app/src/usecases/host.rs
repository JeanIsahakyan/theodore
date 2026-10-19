//! `viewer`, `host_status`, `set_host_token` (plan §6.8): the authenticated
//! host user, connection state for onboarding/Settings → Account, and the
//! one path that changes the stored token.

use theodore_contract::{HostAuthStatus, SetTokenRequest, TokenSource};
use theodore_domain::{HostKind, Person};

use crate::core::Core;
use crate::error::{AppError, AppResult};

/// The vault key for a host's own token (plan §6.8): each host keeps its
/// token independent of the others, keyed by kind rather than hardcoded to
/// whichever host happens to be primary.
fn token_key(host: HostKind) -> AppResult<&'static str> {
    match host {
        HostKind::Github => Ok(theodore_secrets::GITHUB_TOKEN),
        HostKind::Gitlab => Ok(theodore_secrets::GITLAB_TOKEN),
        HostKind::Bitbucket => Ok(theodore_secrets::BITBUCKET_TOKEN),
        HostKind::Local => Err(AppError::Invalid("local reviews have no host token".into())),
    }
}

impl Core {
    pub async fn viewer(&self) -> AppResult<Person> {
        Ok(self.0.deps.host.viewer().await?)
    }

    pub async fn host_status(&self) -> AppResult<HostAuthStatus> {
        let host = self.0.deps.host.kind();
        let source = self.token_source();
        if source == TokenSource::None {
            return Ok(HostAuthStatus {
                host,
                connected: false,
                login: None,
                source,
            });
        }
        match self.0.deps.host.viewer().await {
            Ok(person) => Ok(HostAuthStatus {
                host,
                connected: true,
                login: Some(person.login),
                source,
            }),
            Err(_) => Ok(HostAuthStatus {
                host,
                connected: false,
                login: None,
                source,
            }),
        }
    }

    /// Validates the new token against the host before storing it, so a
    /// typo never silently replaces a working token. Removing the token
    /// (`req.token: None`) always succeeds.
    pub async fn set_host_token(&self, req: SetTokenRequest) -> AppResult<HostAuthStatus> {
        let key = token_key(req.host)?;
        let secrets = self.0.deps.secrets.clone();
        match req.token {
            Some(token) => {
                // Only `key` (this host's own slot) is ever touched below —
                // another host's token is never read, written or deleted
                // by this call.
                let previous = secrets.get(key).ok().flatten();
                secrets
                    .set(key, &token)
                    .map_err(|e| AppError::Invalid(e.to_string()))?;
                self.invalidate_token_cache();
                match self.0.deps.host.viewer_for(req.host).await {
                    Ok(person) => Ok(HostAuthStatus {
                        host: req.host,
                        connected: true,
                        login: Some(person.login),
                        source: TokenSource::Keychain,
                    }),
                    Err(e) => {
                        match previous {
                            Some(p) => {
                                let _ = secrets.set(key, &p);
                            }
                            None => {
                                let _ = secrets.delete(key);
                            }
                        }
                        self.invalidate_token_cache();
                        Err(AppError::Host(e))
                    }
                }
            }
            None => {
                secrets
                    .delete(key)
                    .map_err(|e| AppError::Invalid(e.to_string()))?;
                self.invalidate_token_cache();
                Ok(HostAuthStatus {
                    host: req.host,
                    connected: false,
                    login: None,
                    source: TokenSource::None,
                })
            }
        }
    }

    fn token_source(&self) -> TokenSource {
        self.0
            .deps
            .token_status
            .as_ref()
            .map(|t| t.source())
            .unwrap_or(TokenSource::None)
    }

    fn invalidate_token_cache(&self) {
        if let Some(t) = &self.0.deps.token_status {
            t.invalidate();
        }
    }
}
