//! `viewer`, `host_status`, `set_host_token` (plan §6.8): the authenticated
//! host user, connection state for onboarding/Settings → Account, and the
//! one path that changes the stored token.

use theodore_contract::{HostAuthStatus, SetTokenRequest, TokenSource};
use theodore_domain::Person;

use crate::core::Core;
use crate::error::{AppError, AppResult};

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
        if req.host != self.0.deps.host.kind() {
            return Err(AppError::Invalid(format!(
                "host {:?} is not configured",
                req.host
            )));
        }
        let secrets = self.0.deps.secrets.clone();
        match req.token {
            Some(token) => {
                let previous = secrets.get(theodore_secrets::GITHUB_TOKEN).ok().flatten();
                secrets
                    .set(theodore_secrets::GITHUB_TOKEN, &token)
                    .map_err(|e| AppError::Invalid(e.to_string()))?;
                self.invalidate_token_cache();
                match self.0.deps.host.viewer().await {
                    Ok(person) => Ok(HostAuthStatus {
                        host: self.0.deps.host.kind(),
                        connected: true,
                        login: Some(person.login),
                        source: TokenSource::Keychain,
                    }),
                    Err(e) => {
                        match previous {
                            Some(p) => {
                                let _ = secrets.set(theodore_secrets::GITHUB_TOKEN, &p);
                            }
                            None => {
                                let _ = secrets.delete(theodore_secrets::GITHUB_TOKEN);
                            }
                        }
                        self.invalidate_token_cache();
                        Err(AppError::Host(e))
                    }
                }
            }
            None => {
                secrets
                    .delete(theodore_secrets::GITHUB_TOKEN)
                    .map_err(|e| AppError::Invalid(e.to_string()))?;
                self.invalidate_token_cache();
                self.host_status().await
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
