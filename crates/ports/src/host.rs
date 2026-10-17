//! Code host port (plan §6).

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use theodore_domain::{
    Anchor, CommentId, Millis, PrDetail, PrRef, PrSummary, RepoRef, ReviewEvent, ThreadId,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Capabilities {
    /// Server-side Viewed per file.
    pub viewed: bool,
    /// Drafts can be submitted as one batched review.
    pub pending_review: bool,
    pub suggestions: bool,
    pub resolve_threads: bool,
    pub merge_queue: bool,
    pub auto_merge: bool,
    pub reactions: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("not authenticated or token rejected")]
    Auth,
    #[error("rate limited until {reset_at}")]
    RateLimited { reset_at: Millis },
    #[error("not found: {0}")]
    NotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("rejected by host: {0}")]
    Validation(String),
    #[error("network: {0}")]
    Network(String),
    #[error("not supported by this host: {0}")]
    Unsupported(&'static str),
    #[error("unexpected response: {0}")]
    Protocol(String),
}

pub type HostResult<T> = Result<T, HostError>;

/// Conditional fetch result (ETag).
#[derive(Debug, Clone)]
pub enum Fetched<T> {
    NotModified,
    Modified { etag: Option<String>, value: T },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum InboxSection {
    ReviewRequested,
    Assigned,
    Authored,
    Mentioned,
    /// Raw host search query, e.g. `is:pr is:open repo:o/r`.
    Query(String),
}

/// Cheap "did anything change" probe (GitHub notifications, GitLab
/// `updated_after`, …). `cursor` is opaque to callers.
#[derive(Debug, Clone)]
pub struct Changes {
    pub prs: Vec<PrRef>,
    pub cursor: String,
    /// Host-requested minimum delay before the next probe.
    pub poll_after_ms: Option<i64>,
}

/// One comment of a batched review.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewComment {
    pub anchor: Anchor,
    pub body: String,
    /// Idempotency marker, embedded invisibly in the body by the adapter
    /// (`<!-- theodore:<marker> -->`).
    pub marker: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewSubmission {
    pub event: ReviewEvent,
    pub body: String,
    pub comments: Vec<ReviewComment>,
    /// Head sha the review is made against.
    pub commit: theodore_domain::Sha,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmittedReview {
    pub review_id: String,
    /// marker → created thread id
    pub threads: Vec<(String, ThreadId)>,
}

#[async_trait]
pub trait HostAdapter: Send + Sync {
    fn kind(&self) -> theodore_domain::HostKind;
    fn capabilities(&self) -> Capabilities;

    // inbox
    async fn changed_since(&self, cursor: Option<&str>) -> HostResult<Changes>;
    async fn search(&self, section: &InboxSection) -> HostResult<Vec<PrSummary>>;
    async fn list_repos(&self) -> HostResult<Vec<RepoRef>>;

    // pulls
    async fn get_pr(&self, pr: &PrRef, etag: Option<&str>) -> HostResult<Fetched<PrDetail>>;

    // reviews
    async fn set_viewed(&self, pr: &PrRef, path: &str, viewed: bool) -> HostResult<()>;
    async fn submit_review(
        &self,
        pr: &PrRef,
        review: &ReviewSubmission,
    ) -> HostResult<SubmittedReview>;
    /// Find a comment previously posted with `marker` (outbox retry after timeout).
    async fn find_marker(&self, pr: &PrRef, marker: &str) -> HostResult<Option<CommentId>>;

    // threads
    async fn reply(&self, pr: &PrRef, thread: &ThreadId, body: &str) -> HostResult<CommentId>;
    async fn resolve(&self, pr: &PrRef, thread: &ThreadId, resolved: bool) -> HostResult<()>;
    async fn edit_comment(&self, pr: &PrRef, comment: &CommentId, body: &str) -> HostResult<()>;
    async fn delete_comment(&self, pr: &PrRef, comment: &CommentId) -> HostResult<()>;
}
