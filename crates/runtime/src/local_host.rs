//! `HostAdapter` for `HostKind::Local` PRs (plan "projects" `open_branch`):
//! there is no host behind a local branch review, so reads come from the
//! project's mirror + the stored `pr` row, writes are all `Unsupported`
//! (the UI hides them via `capabilities()`), and a new branch head is
//! reported as a `Modified` fetch so the poller treats it like a push.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use theodore_contract::models;
use theodore_domain::{CommentId, HostKind, PrDetail, PrRef, PrSummary, RepoRef, ThreadId};
use theodore_ports::{
    Capabilities, Changes, Fetched, GitError, GitPort, HostAdapter, HostError, HostResult,
    InboxSection, ReviewSubmission, Store, SubmittedReview,
};

pub struct LocalHostAdapter {
    store: Arc<dyn Store>,
    git: Arc<dyn GitPort>,
}

impl LocalHostAdapter {
    pub fn new(store: Arc<dyn Store>, git: Arc<dyn GitPort>) -> Self {
        Self { store, git }
    }

    fn project_path(&self, repo: &RepoRef) -> HostResult<String> {
        let id = format!("local:{}", repo.name);
        let row = self
            .store
            .get(models::PROJECT, &id)
            .map_err(|e| HostError::Network(e.to_string()))?
            .ok_or_else(|| HostError::NotFound(format!("project {id}")))?;
        row.data
            .get("path")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| HostError::NotFound(format!("project {id} has no local path")))
    }

    /// The branch review's base, from the `pr` row written when it was
    /// opened — kept stable across polls instead of re-deriving it.
    fn stored_base_ref(&self, pr: &PrRef) -> Option<String> {
        let row = self.store.get(models::PR, &pr.id().0).ok()??;
        row.data
            .get("base_ref")
            .and_then(|v| v.as_str())
            .map(str::to_string)
    }
}

#[async_trait]
impl HostAdapter for LocalHostAdapter {
    fn kind(&self) -> HostKind {
        HostKind::Local
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }

    async fn changed_since(&self, _cursor: Option<&str>) -> HostResult<Changes> {
        Err(HostError::Unsupported("changed_since"))
    }

    async fn search(&self, _section: &InboxSection) -> HostResult<Vec<PrSummary>> {
        Err(HostError::Unsupported("search"))
    }

    async fn list_repos(&self) -> HostResult<Vec<RepoRef>> {
        Err(HostError::Unsupported("list_repos"))
    }

    async fn get_pr(&self, pr: &PrRef, etag: Option<&str>) -> HostResult<Fetched<PrDetail>> {
        let branch = pr
            .host_id
            .as_deref()
            .ok_or_else(|| HostError::NotFound("local PR is missing its branch".into()))?;
        let source = self.project_path(&pr.repo)?;
        let repo_path = self
            .git
            .ensure_local_mirror(Path::new(&source), &pr.repo)
            .await
            .map_err(to_host_err)?;
        let head = self
            .git
            .resolve_ref(&repo_path, branch)
            .await
            .map_err(to_host_err)?;
        if etag == Some(head.as_str()) {
            return Ok(Fetched::NotModified);
        }
        let base = self.stored_base_ref(pr).unwrap_or_else(|| "HEAD".into());
        let (detail, _revision) = self
            .git
            .describe_branch(&repo_path, &pr.repo, pr.number, branch, &base)
            .await
            .map_err(to_host_err)?;
        Ok(Fetched::Modified {
            etag: Some(head.0.clone()),
            value: detail,
        })
    }

    async fn set_viewed(&self, _pr: &PrRef, _path: &str, _viewed: bool) -> HostResult<()> {
        Err(HostError::Unsupported("set_viewed"))
    }

    async fn submit_review(
        &self,
        _pr: &PrRef,
        _review: &ReviewSubmission,
    ) -> HostResult<SubmittedReview> {
        Err(HostError::Unsupported("submit_review"))
    }

    async fn find_marker(&self, _pr: &PrRef, _marker: &str) -> HostResult<Option<CommentId>> {
        Err(HostError::Unsupported("find_marker"))
    }

    async fn reply(&self, _pr: &PrRef, _thread: &ThreadId, _body: &str) -> HostResult<CommentId> {
        Err(HostError::Unsupported("reply"))
    }

    async fn resolve(&self, _pr: &PrRef, _thread: &ThreadId, _resolved: bool) -> HostResult<()> {
        Err(HostError::Unsupported("resolve"))
    }

    async fn edit_comment(&self, _pr: &PrRef, _comment: &CommentId, _body: &str) -> HostResult<()> {
        Err(HostError::Unsupported("edit_comment"))
    }

    async fn delete_comment(&self, _pr: &PrRef, _comment: &CommentId) -> HostResult<()> {
        Err(HostError::Unsupported("delete_comment"))
    }
}

fn to_host_err(e: GitError) -> HostError {
    match e {
        GitError::Unsupported(m) => HostError::Unsupported(m),
        other => HostError::Network(other.to_string()),
    }
}
