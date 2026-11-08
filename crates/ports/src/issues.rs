//! Issues opened on the user's behalf: "Report a problem" posts one to
//! Theodore's own repository (docs/telemetry.md "Report a problem"). Not on
//! `HostAdapter`: it targets a fixed repo, not a PR's host, and only GitHub
//! implements it. Sandbox and fixture runs have none, so they can't post.
//! The same tracker follows the issues reports opened ("My reports"): their
//! state, replies, and the release that shipped the fix.

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

/// Where a report issue stands (`IssueTracker::issue_status`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueStatus {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub open: bool,
    /// Why it was closed, as GitHub says it (`completed`, `not_planned`,
    /// `duplicate`); `None` while open or when it didn't say.
    pub close_reason: Option<String>,
    /// Who opened it: a comment by anyone else is a reply.
    pub author: Option<String>,
    pub comments: u32,
    /// Who wrote the newest comment.
    pub last_commenter: Option<String>,
    /// The issue's own last activity (unix millis).
    pub updated_at: i64,
    pub closed_at: Option<i64>,
    /// The PR or commit whose merge closed it, when one did.
    pub closed_by: Option<IssueCloser>,
}

/// What closed an issue: a merged PR (its number and merge commit) or a
/// commit pushed with a closing keyword (no PR).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueCloser {
    pub pr: Option<u64>,
    pub pr_url: Option<String>,
    /// The commit that landed the fix: what a release must contain.
    pub sha: Option<String>,
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
    /// The state of issue `number` in `owner/name` ("My reports").
    async fn issue_status(&self, owner: &str, name: &str, number: u64) -> HostResult<IssueStatus> {
        let _ = (owner, name, number);
        Err(crate::HostError::Unsupported("issue_status"))
    }
    /// The tag of the first published `v*` release of `owner/name` that
    /// contains `sha` (`v0.1.7`), or `None` while none does.
    async fn first_release_with(
        &self,
        owner: &str,
        name: &str,
        sha: &str,
    ) -> HostResult<Option<String>> {
        let _ = (owner, name, sha);
        Err(crate::HostError::Unsupported("first_release_with"))
    }
}
