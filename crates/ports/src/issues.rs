//! Issues opened on the user's behalf: "Report a problem" posts one to
//! Theodore's own repository (docs/telemetry.md "Report a problem"). Not on
//! `HostAdapter`: it targets a fixed repo, not a PR's host, and only GitHub
//! implements it. Sandbox and fixture runs have none, so they can't post.

use async_trait::async_trait;

use crate::HostResult;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewIssue {
    pub title: String,
    pub body: String,
    /// Best effort: an adapter retries without them when the host refuses
    /// them (the poster can't label issues in that repo).
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedIssue {
    pub number: u64,
    /// The issue's web page.
    pub url: String,
}

#[async_trait]
pub trait IssueTracker: Send + Sync {
    /// Whether a token exists at all (no network): without one the UI says
    /// "sign in" instead of offering to post.
    fn has_token(&self) -> bool;
    /// The token's login (`@login` in "posted publicly as …").
    async fn login(&self) -> HostResult<String>;
    /// Opens an issue in `owner/name` as the token's user.
    async fn create_issue(
        &self,
        owner: &str,
        name: &str,
        issue: &NewIssue,
    ) -> HostResult<CreatedIssue>;
}
