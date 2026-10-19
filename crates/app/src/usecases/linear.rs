//! `set_linear_token`, `linear_status`, `linear_issues` (plan "Linear"): a
//! read-only Linear integration — connect a personal API key, and look up
//! the issues a PR's title, head branch or body reference.
//!
//! Results are cached in `Core::linear_cache` per PR for `CACHE_TTL_MS`:
//! Peek and the Review header both ask for the same PR's issues on every
//! render, and Linear's API has no conditional-GET story to make that free
//! the way host-http's ETag cache does for GitHub/GitLab.

use theodore_contract::{LinearIssue, LinearIssuesRequest, LinearStatus, SetLinearTokenRequest};
use theodore_domain::{PrDetail, PrId};
use theodore_linear::{LinearClient, LinearError};

use crate::core::Core;
use crate::error::{AppError, AppResult};

const CACHE_TTL_MS: i64 = 5 * 60 * 1000;

impl Core {
    /// Connection state for Settings → Integrations → Linear. Reports
    /// disconnected (rather than erroring) whenever the stored token no
    /// longer validates — the same shape `host_status` uses for hosts.
    pub async fn linear_status(&self) -> AppResult<LinearStatus> {
        let Some(token) = self.linear_token()? else {
            return Ok(disconnected());
        };
        match LinearClient::new(token).viewer().await {
            Ok(v) => Ok(LinearStatus {
                connected: true,
                user: Some(v.name),
                workspace: Some(v.workspace),
            }),
            Err(_) => Ok(disconnected()),
        }
    }

    /// Validates the token against Linear's `viewer` query before storing
    /// it, so a typo never silently replaces a working token (mirrors
    /// `set_host_token`). `req.token: None` disconnects unconditionally.
    pub async fn set_linear_token(&self, req: SetLinearTokenRequest) -> AppResult<LinearStatus> {
        let secrets = self.0.deps.secrets.clone();
        match req.token {
            Some(token) => {
                let viewer = LinearClient::new(token.clone())
                    .viewer()
                    .await
                    .map_err(linear_err)?;
                secrets
                    .set(theodore_secrets::LINEAR_TOKEN, &token)
                    .map_err(|e| AppError::Invalid(e.to_string()))?;
                self.0
                    .linear_cache
                    .lock()
                    .expect("linear cache lock")
                    .clear();
                Ok(LinearStatus {
                    connected: true,
                    user: Some(viewer.name),
                    workspace: Some(viewer.workspace),
                })
            }
            None => {
                secrets
                    .delete(theodore_secrets::LINEAR_TOKEN)
                    .map_err(|e| AppError::Invalid(e.to_string()))?;
                self.0
                    .linear_cache
                    .lock()
                    .expect("linear cache lock")
                    .clear();
                Ok(disconnected())
            }
        }
    }

    /// Issues linked to a PR by a key (`ABC-123`) found in its title, head
    /// branch or body. With no token stored, returns an empty list rather
    /// than an error — the UI treats "not connected" and "no linked issue"
    /// the same way here.
    pub async fn linear_issues(&self, req: LinearIssuesRequest) -> AppResult<Vec<LinearIssue>> {
        let Some(token) = self.linear_token()? else {
            return Ok(Vec::new());
        };

        let now = self.0.deps.clock.now();
        if let Some((fetched_at, issues)) = self
            .0
            .linear_cache
            .lock()
            .expect("linear cache lock")
            .get(&req.pr)
            && now - fetched_at < CACHE_TTL_MS
        {
            return Ok(issues.clone());
        }

        let Some(detail) = self.pr_detail_for_linear(&req.pr).await else {
            return Ok(Vec::new());
        };
        let keys = theodore_linear::find_issue_keys(
            &detail.summary.title,
            &detail.summary.head_ref,
            &detail.body,
        );

        let mut issues = Vec::new();
        if !keys.is_empty() {
            let client = LinearClient::new(token);
            for key in keys {
                // One bad lookup (a transient network error, an identifier
                // that no longer resolves) shouldn't blank out every other
                // issue already resolved for this PR.
                if let Ok(Some(i)) = client.issue(&key).await {
                    issues.push(LinearIssue {
                        identifier: i.identifier,
                        title: i.title,
                        state_name: i.state_name,
                        state_type: i.state_type,
                        assignee: i.assignee,
                        priority: i.priority,
                        url: i.url,
                        team_key: i.team_key,
                    });
                }
            }
        }

        self.0
            .linear_cache
            .lock()
            .expect("linear cache lock")
            .insert(req.pr.clone(), (now, issues.clone()));
        Ok(issues)
    }

    fn linear_token(&self) -> AppResult<Option<String>> {
        self.0
            .deps
            .secrets
            .get(theodore_secrets::LINEAR_TOKEN)
            .map_err(|e| AppError::Invalid(e.to_string()))
    }

    async fn pr_detail_for_linear(&self, pr: &PrId) -> Option<PrDetail> {
        let store = self.0.deps.store.clone();
        let id = pr.0.clone();
        let row = tokio::task::spawn_blocking(move || {
            store.get(theodore_contract::models::PR_DETAIL, &id)
        })
        .await
        .ok()?
        .ok()??;
        serde_json::from_value(row.data).ok()
    }
}

fn disconnected() -> LinearStatus {
    LinearStatus {
        connected: false,
        user: None,
        workspace: None,
    }
}

fn linear_err(e: LinearError) -> AppError {
    match e {
        LinearError::Auth => AppError::Invalid("linear rejected the token".into()),
        other => AppError::Invalid(other.to_string()),
    }
}
