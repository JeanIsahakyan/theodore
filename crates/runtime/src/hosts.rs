//! Routes host calls by the PR's host (plan §6.2). Account-wide calls (inbox,
//! viewer, repos) go to the primary host — GitHub.

use std::sync::Arc;

use async_trait::async_trait;
use theodore_domain::{CommentId, HostKind, Person, PrDetail, PrRef, PrSummary, RepoRef, ThreadId};
use theodore_ports::{
    Capabilities, Changes, Fetched, HostAdapter, HostError, HostResult, InboxSection,
    ReviewSubmission, SubmittedReview,
};

pub struct Hosts {
    primary: Arc<dyn HostAdapter>,
    gitlab: Option<Arc<dyn HostAdapter>>,
}

impl Hosts {
    pub fn new(primary: Arc<dyn HostAdapter>, gitlab: Option<Arc<dyn HostAdapter>>) -> Self {
        Self { primary, gitlab }
    }

    fn for_pr(&self, pr: &PrRef) -> HostResult<&Arc<dyn HostAdapter>> {
        match pr.repo.host {
            HostKind::Gitlab => self.gitlab.as_ref().ok_or(HostError::Unsupported("gitlab")),
            _ => Ok(&self.primary),
        }
    }
}

#[async_trait]
impl HostAdapter for Hosts {
    fn kind(&self) -> HostKind {
        self.primary.kind()
    }
    fn capabilities(&self) -> Capabilities {
        self.primary.capabilities()
    }
    async fn viewer(&self) -> HostResult<Person> {
        self.primary.viewer().await
    }
    async fn changed_since(&self, cursor: Option<&str>) -> HostResult<Changes> {
        self.primary.changed_since(cursor).await
    }
    async fn search(&self, section: &InboxSection) -> HostResult<Vec<PrSummary>> {
        self.primary.search(section).await
    }
    async fn list_repos(&self) -> HostResult<Vec<RepoRef>> {
        self.primary.list_repos().await
    }
    async fn get_pr(&self, pr: &PrRef, etag: Option<&str>) -> HostResult<Fetched<PrDetail>> {
        self.for_pr(pr)?.get_pr(pr, etag).await
    }
    async fn set_viewed(&self, pr: &PrRef, path: &str, viewed: bool) -> HostResult<()> {
        self.for_pr(pr)?.set_viewed(pr, path, viewed).await
    }
    async fn submit_review(
        &self,
        pr: &PrRef,
        review: &ReviewSubmission,
    ) -> HostResult<SubmittedReview> {
        self.for_pr(pr)?.submit_review(pr, review).await
    }
    async fn find_marker(&self, pr: &PrRef, marker: &str) -> HostResult<Option<CommentId>> {
        self.for_pr(pr)?.find_marker(pr, marker).await
    }
    async fn reply(&self, pr: &PrRef, thread: &ThreadId, body: &str) -> HostResult<CommentId> {
        self.for_pr(pr)?.reply(pr, thread, body).await
    }
    async fn resolve(&self, pr: &PrRef, thread: &ThreadId, resolved: bool) -> HostResult<()> {
        self.for_pr(pr)?.resolve(pr, thread, resolved).await
    }
    async fn edit_comment(&self, pr: &PrRef, comment: &CommentId, body: &str) -> HostResult<()> {
        self.for_pr(pr)?.edit_comment(pr, comment, body).await
    }
    async fn delete_comment(&self, pr: &PrRef, comment: &CommentId) -> HostResult<()> {
        self.for_pr(pr)?.delete_comment(pr, comment).await
    }
}
