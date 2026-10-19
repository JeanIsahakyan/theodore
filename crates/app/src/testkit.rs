//! In-memory fakes for every port, plus small fixture builders, so `app`
//! can be tested without any adapter crate.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use theodore_contract::TokenSource;
use theodore_domain::{
    AgentId, Anchor, CheckRollup, FileDiff, FileStatus, Group, GroupId, GroupKind, Grouping, Hunk,
    HunkId, LineKind, Millis, Person, PrDetail, PrRef, PrState, PrSummary, RepoRef, Revision, Sha,
    Side,
};
use theodore_ports::{
    AgentError, AgentEvent, AgentInfo, AgentPort, AgentRequest, AgentRun, BranchInfo, Capabilities,
    Changes, Clock, CommitLog, DeviceCodeStart, DeviceLoginPort, DevicePoll, DiffOptions, Fetched,
    GitError, GitPort, GitResult, HostAdapter, HostError, HostResult, InboxSection, MergeMethod,
    MergeStatus, ModelRow, NewAction, OutboxItem, OutboxStatus, ReviewSubmission, Secrets,
    SecretsError, Store, StoreError, StoreResult, SubmittedReview, SyncAction, SyncActionCode,
    Worktree,
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::deps::{Deps, Grouper, TokenStatus};
use crate::error::GrouperError;

// ── clock ─────────────────────────────────────────────────────────────────

pub struct FakeClock {
    now: Mutex<Millis>,
    notify: Notify,
}

impl FakeClock {
    pub fn new(start: Millis) -> Arc<Self> {
        Arc::new(Self {
            now: Mutex::new(start),
            notify: Notify::new(),
        })
    }

    pub fn advance(&self, by_ms: i64) {
        {
            let mut g = self.now.lock().unwrap();
            *g += by_ms;
        }
        self.notify.notify_waiters();
    }
}

#[async_trait]
impl Clock for FakeClock {
    fn now(&self) -> Millis {
        *self.now.lock().unwrap()
    }

    async fn sleep(&self, d: Duration) {
        let target = self.now() + d.as_millis() as i64;
        loop {
            let notified = self.notify.notified();
            if self.now() >= target {
                return;
            }
            notified.await;
        }
    }
}

// ── store ─────────────────────────────────────────────────────────────────

#[derive(Default)]
struct StoreState {
    next_id: u64,
    log: Vec<SyncAction>,
    models: HashMap<(String, String), ModelRow>,
    outbox: Vec<OutboxItem>,
    next_outbox_id: u64,
    kv: HashMap<String, serde_json::Value>,
}

pub struct FakeStore(Mutex<StoreState>);

impl FakeStore {
    pub fn new() -> Arc<Self> {
        Arc::new(Self(Mutex::new(StoreState::default())))
    }

    /// Test-only inspection, not part of `Store`.
    pub fn outbox_snapshot(&self) -> Vec<OutboxItem> {
        self.0.lock().unwrap().outbox.clone()
    }
}

impl Store for FakeStore {
    fn apply(&self, actions: Vec<NewAction>) -> StoreResult<Vec<SyncAction>> {
        let mut s = self.0.lock().unwrap();
        let mut out = Vec::new();
        for a in actions {
            let key = (a.model.clone(), a.model_id.clone());
            let logged = match a.action {
                SyncActionCode::I => {
                    if s.models.contains_key(&key) {
                        // Retried create whose first attempt committed.
                        continue;
                    }
                    let data = a.data.unwrap_or(serde_json::Value::Null);
                    s.models.insert(
                        key,
                        ModelRow {
                            model: a.model.clone(),
                            id: a.model_id.clone(),
                            data: data.clone(),
                            archived: false,
                        },
                    );
                    Some(data)
                }
                SyncActionCode::U => {
                    let archived = s.models.get(&key).map(|r| r.archived).unwrap_or(false);
                    let data = a.data.unwrap_or(serde_json::Value::Null);
                    s.models.insert(
                        key,
                        ModelRow {
                            model: a.model.clone(),
                            id: a.model_id.clone(),
                            data: data.clone(),
                            archived,
                        },
                    );
                    Some(data)
                }
                SyncActionCode::C => {
                    let Some(existing) = s.models.get(&key).cloned() else {
                        return Err(StoreError::Db(format!(
                            "{}/{} not found",
                            a.model, a.model_id
                        )));
                    };
                    let mut merged = existing.data;
                    if let Some(patch) = a.data.as_ref().and_then(|d| d.as_object()) {
                        if let Some(obj) = merged.as_object_mut() {
                            for (k, v) in patch {
                                obj.insert(k.clone(), v.clone());
                            }
                        } else {
                            merged = a.data.clone().unwrap_or(serde_json::Value::Null);
                        }
                    }
                    s.models.insert(
                        key,
                        ModelRow {
                            model: a.model.clone(),
                            id: a.model_id.clone(),
                            data: merged.clone(),
                            archived: existing.archived,
                        },
                    );
                    Some(merged)
                }
                SyncActionCode::A => {
                    let Some(existing) = s.models.get_mut(&key) else {
                        continue;
                    };
                    existing.archived = true;
                    None
                }
                SyncActionCode::D => {
                    if s.models.remove(&key).is_none() {
                        continue;
                    }
                    None
                }
            };
            s.next_id += 1;
            let action = SyncAction {
                id: s.next_id,
                model: a.model,
                model_id: a.model_id,
                action: a.action,
                data: logged,
            };
            s.log.push(action.clone());
            out.push(action);
        }
        Ok(out)
    }

    fn last_sync_id(&self) -> StoreResult<u64> {
        Ok(self.0.lock().unwrap().next_id)
    }

    fn since(&self, sync_id: u64, limit: u32) -> StoreResult<Vec<SyncAction>> {
        let s = self.0.lock().unwrap();
        Ok(s.log
            .iter()
            .filter(|a| a.id > sync_id)
            .take(limit as usize)
            .cloned()
            .collect())
    }

    fn get(&self, model: &str, id: &str) -> StoreResult<Option<ModelRow>> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .models
            .get(&(model.to_string(), id.to_string()))
            .cloned())
    }

    fn query(&self, model: &str, field: &str, value: &str) -> StoreResult<Vec<ModelRow>> {
        let s = self.0.lock().unwrap();
        Ok(s.models
            .values()
            .filter(|r| {
                r.model == model && r.data.get(field).and_then(|v| v.as_str()) == Some(value)
            })
            .cloned()
            .collect())
    }

    fn all(&self, model: &str) -> StoreResult<Vec<ModelRow>> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .models
            .values()
            .filter(|r| r.model == model)
            .cloned()
            .collect())
    }

    fn outbox_push(&self, op: &str, payload: serde_json::Value) -> StoreResult<u64> {
        let mut s = self.0.lock().unwrap();
        s.next_outbox_id += 1;
        let id = s.next_outbox_id;
        s.outbox.push(OutboxItem {
            id,
            op: op.to_string(),
            payload,
            attempts: 0,
            status: OutboxStatus::Pending,
            not_before: 0,
        });
        Ok(id)
    }

    fn outbox_take(&self, now: i64) -> StoreResult<Option<OutboxItem>> {
        let mut s = self.0.lock().unwrap();
        if let Some(item) = s
            .outbox
            .iter_mut()
            .find(|i| i.status == OutboxStatus::Pending && i.not_before <= now)
        {
            item.status = OutboxStatus::InFlight;
            return Ok(Some(item.clone()));
        }
        Ok(None)
    }

    fn outbox_done(&self, id: u64) -> StoreResult<()> {
        let mut s = self.0.lock().unwrap();
        if let Some(item) = s.outbox.iter_mut().find(|i| i.id == id) {
            item.status = OutboxStatus::Done;
        }
        Ok(())
    }

    fn outbox_retry(&self, id: u64, not_before: i64) -> StoreResult<()> {
        let mut s = self.0.lock().unwrap();
        if let Some(item) = s.outbox.iter_mut().find(|i| i.id == id) {
            item.attempts += 1;
            item.not_before = not_before;
            item.status = OutboxStatus::Pending;
        }
        Ok(())
    }

    fn outbox_fail(&self, id: u64) -> StoreResult<()> {
        let mut s = self.0.lock().unwrap();
        if let Some(item) = s.outbox.iter_mut().find(|i| i.id == id) {
            item.status = OutboxStatus::Failed;
        }
        Ok(())
    }

    fn kv_get(&self, key: &str) -> StoreResult<Option<serde_json::Value>> {
        Ok(self.0.lock().unwrap().kv.get(key).cloned())
    }

    fn kv_set(&self, key: &str, value: &serde_json::Value) -> StoreResult<()> {
        self.0
            .lock()
            .unwrap()
            .kv
            .insert(key.to_string(), value.clone());
        Ok(())
    }

    fn outbox_pending_count(&self) -> StoreResult<u64> {
        let s = self.0.lock().unwrap();
        Ok(s.outbox
            .iter()
            .filter(|i| matches!(i.status, OutboxStatus::Pending | OutboxStatus::InFlight))
            .count() as u64)
    }
}

// ── secrets ───────────────────────────────────────────────────────────────

pub struct FakeSecrets(Mutex<HashMap<String, String>>);

impl FakeSecrets {
    pub fn new() -> Arc<Self> {
        Arc::new(Self(Mutex::new(HashMap::new())))
    }
}

impl Secrets for FakeSecrets {
    fn get(&self, key: &str) -> Result<Option<String>, SecretsError> {
        Ok(self.0.lock().unwrap().get(key).cloned())
    }
    fn set(&self, key: &str, value: &str) -> Result<(), SecretsError> {
        self.0
            .lock()
            .unwrap()
            .insert(key.to_string(), value.to_string());
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<(), SecretsError> {
        self.0.lock().unwrap().remove(key);
        Ok(())
    }
}

// ── git ───────────────────────────────────────────────────────────────────

pub struct FakeGit {
    pub repo_path: PathBuf,
    head: Mutex<Sha>,
    revision: Mutex<Revision>,
    files: Mutex<HashMap<(String, String), Vec<u8>>>,
    /// Last `(branch, message)` passed to `commit_and_push`, for assertions.
    pub last_push: Mutex<Option<(String, String)>>,
    push_responses: Mutex<VecDeque<GitResult<Sha>>>,

    // ── projects (plan "projects") ───────────────────────────────────────
    mirror_path: PathBuf,
    mirror_calls: Mutex<Vec<(PathBuf, RepoRef)>>,
    is_repo_value: Mutex<bool>,
    default_branch_value: Mutex<Option<String>>,
    branches_value: Mutex<Vec<BranchInfo>>,
    resolve_refs: Mutex<HashMap<String, Sha>>,
    commits: Mutex<HashMap<String, CommitLog>>,
    commit_log_value: Mutex<Vec<CommitLog>>,
    removed_repos: Mutex<Vec<RepoRef>>,
}

impl FakeGit {
    pub fn new(head: Sha, revision: Revision) -> Arc<Self> {
        Arc::new(Self {
            repo_path: PathBuf::from("/tmp/theodore-fake-repo"),
            head: Mutex::new(head),
            revision: Mutex::new(revision),
            files: Mutex::new(HashMap::new()),
            last_push: Mutex::new(None),
            push_responses: Mutex::new(VecDeque::new()),
            mirror_path: PathBuf::from("/tmp/theodore-fake-mirror"),
            mirror_calls: Mutex::new(Vec::new()),
            is_repo_value: Mutex::new(true),
            default_branch_value: Mutex::new(Some("main".into())),
            branches_value: Mutex::new(Vec::new()),
            resolve_refs: Mutex::new(HashMap::new()),
            commits: Mutex::new(HashMap::new()),
            commit_log_value: Mutex::new(Vec::new()),
            removed_repos: Mutex::new(Vec::new()),
        })
    }

    pub fn push_commit_and_push(&self, r: GitResult<Sha>) {
        self.push_responses.lock().unwrap().push_back(r);
    }

    pub fn set_head(&self, head: Sha) {
        *self.head.lock().unwrap() = head;
    }

    pub fn set_revision(&self, revision: Revision) {
        *self.revision.lock().unwrap() = revision;
    }

    pub fn put_file(&self, rev: &Sha, path: &str, content: &[u8]) {
        self.files
            .lock()
            .unwrap()
            .insert((rev.0.clone(), path.to_string()), content.to_vec());
    }

    pub fn set_is_repo(&self, value: bool) {
        *self.is_repo_value.lock().unwrap() = value;
    }

    pub fn set_default_branch(&self, value: Option<&str>) {
        *self.default_branch_value.lock().unwrap() = value.map(str::to_string);
    }

    pub fn set_branches(&self, branches: Vec<BranchInfo>) {
        *self.branches_value.lock().unwrap() = branches;
    }

    /// Makes `resolve_ref(_, name)` return `sha` (branch names and base refs
    /// alike — a local branch review resolves both through the same call).
    pub fn set_resolve(&self, name: &str, sha: Sha) {
        self.resolve_refs
            .lock()
            .unwrap()
            .insert(name.to_string(), sha);
    }

    pub fn set_commit(&self, sha: Sha, commit: CommitLog) {
        self.commits.lock().unwrap().insert(sha.0.clone(), commit);
    }

    pub fn set_commit_log(&self, commits: Vec<CommitLog>) {
        *self.commit_log_value.lock().unwrap() = commits;
    }

    pub fn mirror_calls(&self) -> Vec<(PathBuf, RepoRef)> {
        self.mirror_calls.lock().unwrap().clone()
    }

    pub fn removed_repos(&self) -> Vec<RepoRef> {
        self.removed_repos.lock().unwrap().clone()
    }
}

#[async_trait]
impl GitPort for FakeGit {
    async fn ensure_repo(&self, _repo: &theodore_domain::RepoRef) -> GitResult<PathBuf> {
        Ok(self.repo_path.clone())
    }
    async fn fetch_pr(&self, _pr: &PrRef) -> GitResult<Sha> {
        Ok(self.head.lock().unwrap().clone())
    }
    async fn worktree(&self, _pr: &PrRef, head: &Sha) -> GitResult<Worktree> {
        Ok(Worktree {
            path: PathBuf::from(format!("/tmp/theodore-fake-wt-{}", head.0)),
            head: head.clone(),
        })
    }
    async fn remove_worktree(&self, _pr: &PrRef) -> GitResult<()> {
        Ok(())
    }
    async fn gc_worktrees(&self, _keep: &[PrRef]) -> GitResult<u32> {
        Ok(0)
    }
    async fn merge_base(&self, _repo: &Path, a: &Sha, _b: &Sha) -> GitResult<Sha> {
        Ok(a.clone())
    }
    async fn diff(
        &self,
        _repo: &Path,
        _base: &Sha,
        _head: &Sha,
        _opts: &DiffOptions,
    ) -> GitResult<Revision> {
        Ok(self.revision.lock().unwrap().clone())
    }
    async fn show(&self, _repo: &Path, rev: &Sha, path: &str) -> GitResult<Option<Vec<u8>>> {
        Ok(self
            .files
            .lock()
            .unwrap()
            .get(&(rev.0.clone(), path.to_string()))
            .cloned())
    }
    async fn commit_and_push(
        &self,
        _worktree: &Path,
        _repo: &theodore_domain::RepoRef,
        branch: &str,
        message: &str,
    ) -> GitResult<Sha> {
        *self.last_push.lock().unwrap() = Some((branch.to_string(), message.to_string()));
        self.push_responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(Sha::new("pushed-sha")))
    }

    async fn ensure_local_mirror(&self, source: &Path, repo: &RepoRef) -> GitResult<PathBuf> {
        self.mirror_calls
            .lock()
            .unwrap()
            .push((source.to_path_buf(), repo.clone()));
        Ok(self.mirror_path.clone())
    }

    async fn is_repo(&self, _path: &Path) -> GitResult<bool> {
        Ok(*self.is_repo_value.lock().unwrap())
    }

    async fn default_branch(&self, _repo: &Path) -> GitResult<Option<String>> {
        Ok(self.default_branch_value.lock().unwrap().clone())
    }

    async fn list_branches(
        &self,
        _repo: &Path,
        _default_branch: &str,
    ) -> GitResult<Vec<BranchInfo>> {
        Ok(self.branches_value.lock().unwrap().clone())
    }

    async fn resolve_ref(&self, _repo: &Path, refname: &str) -> GitResult<Sha> {
        self.resolve_refs
            .lock()
            .unwrap()
            .get(refname)
            .cloned()
            .ok_or_else(|| GitError::Parse(format!("no fixture ref {refname}")))
    }

    async fn commit(&self, _repo: &Path, sha: &Sha) -> GitResult<CommitLog> {
        self.commits
            .lock()
            .unwrap()
            .get(sha.as_str())
            .cloned()
            .ok_or_else(|| GitError::Parse(format!("no fixture commit {sha}")))
    }

    async fn commit_log(
        &self,
        _repo: &Path,
        _base: &Sha,
        _head: &Sha,
    ) -> GitResult<Vec<CommitLog>> {
        Ok(self.commit_log_value.lock().unwrap().clone())
    }

    async fn remove_repo(&self, repo: &RepoRef) -> GitResult<()> {
        self.removed_repos.lock().unwrap().push(repo.clone());
        Ok(())
    }
}

// ── host ──────────────────────────────────────────────────────────────────

/// `(method, title, body)` of one `FakeHost::merge` call.
pub type MergeCall = (MergeMethod, Option<String>, Option<String>);

#[derive(Default)]
pub struct FakeHost {
    pub get_pr_responses: Mutex<VecDeque<HostResult<Fetched<PrDetail>>>>,
    pub set_viewed_responses: Mutex<VecDeque<HostResult<()>>>,
    pub submit_review_responses: Mutex<VecDeque<HostResult<SubmittedReview>>>,
    pub find_marker_responses: Mutex<VecDeque<HostResult<Option<theodore_domain::CommentId>>>>,
    pub changed_since_responses: Mutex<VecDeque<HostResult<Changes>>>,
    pub search_responses: Mutex<VecDeque<HostResult<Vec<PrSummary>>>>,
    pub viewer_responses: Mutex<VecDeque<HostResult<Person>>>,
    pub reply_responses: Mutex<VecDeque<HostResult<theodore_domain::CommentId>>>,
    /// Every `(thread, body)` a `reply`/`reply_with_marker` call was made
    /// with, for duplicate-post assertions.
    pub reply_calls: Mutex<Vec<(theodore_domain::ThreadId, String)>>,
    pub resolve_responses: Mutex<VecDeque<HostResult<()>>>,
    pub merge_status_responses: Mutex<VecDeque<HostResult<MergeStatus>>>,
    pub merge_responses: Mutex<VecDeque<HostResult<theodore_domain::Sha>>>,
    pub enable_auto_merge_responses: Mutex<VecDeque<HostResult<()>>>,
    pub enqueue_responses: Mutex<VecDeque<HostResult<()>>>,
    pub assignable_users_responses: Mutex<VecDeque<HostResult<Vec<Person>>>>,
    pub request_reviewers_responses: Mutex<VecDeque<HostResult<()>>>,
    pub remove_reviewer_responses: Mutex<VecDeque<HostResult<()>>>,
    pub mark_ready_responses: Mutex<VecDeque<HostResult<()>>>,
    pub convert_to_draft_responses: Mutex<VecDeque<HostResult<()>>>,
    pub update_branch_responses: Mutex<VecDeque<HostResult<()>>>,
    pub add_reaction_responses: Mutex<VecDeque<HostResult<()>>>,
    pub remove_reaction_responses: Mutex<VecDeque<HostResult<()>>>,
    /// Every `(method, title, body)` a `merge` call was made with, for assertions.
    pub merge_calls: Mutex<Vec<MergeCall>>,
    /// Every `(add, add_teams, remove)` reviewer write, for assertions.
    pub reviewer_calls: Mutex<Vec<(Vec<String>, Vec<String>)>>,
    pub remove_reviewer_calls: Mutex<Vec<String>>,
}

impl FakeHost {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    pub fn push_get_pr(&self, r: HostResult<Fetched<PrDetail>>) {
        self.get_pr_responses.lock().unwrap().push_back(r);
    }
    pub fn push_set_viewed(&self, r: HostResult<()>) {
        self.set_viewed_responses.lock().unwrap().push_back(r);
    }
    pub fn push_submit_review(&self, r: HostResult<SubmittedReview>) {
        self.submit_review_responses.lock().unwrap().push_back(r);
    }
    pub fn push_find_marker(&self, r: HostResult<Option<theodore_domain::CommentId>>) {
        self.find_marker_responses.lock().unwrap().push_back(r);
    }
    pub fn push_changed_since(&self, r: HostResult<Changes>) {
        self.changed_since_responses.lock().unwrap().push_back(r);
    }
    pub fn push_search(&self, r: HostResult<Vec<PrSummary>>) {
        self.search_responses.lock().unwrap().push_back(r);
    }
    pub fn push_viewer(&self, r: HostResult<Person>) {
        self.viewer_responses.lock().unwrap().push_back(r);
    }
    pub fn push_reply(&self, r: HostResult<theodore_domain::CommentId>) {
        self.reply_responses.lock().unwrap().push_back(r);
    }
    pub fn push_resolve(&self, r: HostResult<()>) {
        self.resolve_responses.lock().unwrap().push_back(r);
    }
    pub fn push_merge_status(&self, r: HostResult<MergeStatus>) {
        self.merge_status_responses.lock().unwrap().push_back(r);
    }
    pub fn push_merge(&self, r: HostResult<theodore_domain::Sha>) {
        self.merge_responses.lock().unwrap().push_back(r);
    }
    pub fn push_enable_auto_merge(&self, r: HostResult<()>) {
        self.enable_auto_merge_responses
            .lock()
            .unwrap()
            .push_back(r);
    }
    pub fn push_enqueue(&self, r: HostResult<()>) {
        self.enqueue_responses.lock().unwrap().push_back(r);
    }
    pub fn push_assignable_users(&self, r: HostResult<Vec<Person>>) {
        self.assignable_users_responses.lock().unwrap().push_back(r);
    }
    pub fn push_request_reviewers(&self, r: HostResult<()>) {
        self.request_reviewers_responses
            .lock()
            .unwrap()
            .push_back(r);
    }
    pub fn push_remove_reviewer(&self, r: HostResult<()>) {
        self.remove_reviewer_responses.lock().unwrap().push_back(r);
    }
    pub fn push_mark_ready(&self, r: HostResult<()>) {
        self.mark_ready_responses.lock().unwrap().push_back(r);
    }
    pub fn push_convert_to_draft(&self, r: HostResult<()>) {
        self.convert_to_draft_responses.lock().unwrap().push_back(r);
    }
    pub fn push_update_branch(&self, r: HostResult<()>) {
        self.update_branch_responses.lock().unwrap().push_back(r);
    }
    pub fn push_add_reaction(&self, r: HostResult<()>) {
        self.add_reaction_responses.lock().unwrap().push_back(r);
    }
    pub fn push_remove_reaction(&self, r: HostResult<()>) {
        self.remove_reaction_responses.lock().unwrap().push_back(r);
    }
    pub fn merge_calls(&self) -> Vec<MergeCall> {
        self.merge_calls.lock().unwrap().clone()
    }
    pub fn reviewer_calls(&self) -> Vec<(Vec<String>, Vec<String>)> {
        self.reviewer_calls.lock().unwrap().clone()
    }
    pub fn reply_calls(&self) -> Vec<(theodore_domain::ThreadId, String)> {
        self.reply_calls.lock().unwrap().clone()
    }
    pub fn remove_reviewer_calls(&self) -> Vec<String> {
        self.remove_reviewer_calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl HostAdapter for FakeHost {
    fn kind(&self) -> theodore_domain::HostKind {
        theodore_domain::HostKind::Github
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            viewed: true,
            pending_review: true,
            suggestions: true,
            resolve_threads: true,
            merge_queue: false,
            auto_merge: false,
            reactions: true,
        }
    }
    async fn changed_since(&self, _cursor: Option<&str>) -> HostResult<Changes> {
        self.changed_since_responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(Changes {
                prs: vec![],
                cursor: "0".into(),
                poll_after_ms: Some(60_000),
            }))
    }
    async fn viewer(&self) -> HostResult<Person> {
        self.viewer_responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Ok(sample_person("me")))
    }
    async fn search(&self, _section: &InboxSection) -> HostResult<Vec<PrSummary>> {
        self.search_responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(vec![]))
    }
    async fn list_repos(&self) -> HostResult<Vec<theodore_domain::RepoRef>> {
        Ok(vec![])
    }
    async fn get_pr(&self, _pr: &PrRef, _etag: Option<&str>) -> HostResult<Fetched<PrDetail>> {
        self.get_pr_responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Err(HostError::NotFound("no fixture queued".into())))
    }
    async fn set_viewed(&self, _pr: &PrRef, _path: &str, _viewed: bool) -> HostResult<()> {
        self.set_viewed_responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(()))
    }
    async fn submit_review(
        &self,
        _pr: &PrRef,
        _review: &ReviewSubmission,
    ) -> HostResult<SubmittedReview> {
        self.submit_review_responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(SubmittedReview {
                review_id: "r1".into(),
                threads: vec![],
            }))
    }
    async fn find_marker(
        &self,
        _pr: &PrRef,
        _marker: &str,
    ) -> HostResult<Option<theodore_domain::CommentId>> {
        self.find_marker_responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(None))
    }
    async fn reply(
        &self,
        _pr: &PrRef,
        thread: &theodore_domain::ThreadId,
        body: &str,
    ) -> HostResult<theodore_domain::CommentId> {
        self.reply_calls
            .lock()
            .unwrap()
            .push((thread.clone(), body.to_string()));
        self.reply_responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(theodore_domain::CommentId::new("c1")))
    }
    async fn resolve(
        &self,
        _pr: &PrRef,
        _thread: &theodore_domain::ThreadId,
        _resolved: bool,
    ) -> HostResult<()> {
        self.resolve_responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(()))
    }
    async fn edit_comment(
        &self,
        _pr: &PrRef,
        _comment: &theodore_domain::CommentId,
        _body: &str,
    ) -> HostResult<()> {
        Ok(())
    }
    async fn delete_comment(
        &self,
        _pr: &PrRef,
        _comment: &theodore_domain::CommentId,
    ) -> HostResult<()> {
        Ok(())
    }
    async fn add_reaction(
        &self,
        _pr: &PrRef,
        _comment: &theodore_domain::CommentId,
        _emoji: &str,
    ) -> HostResult<()> {
        self.add_reaction_responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(()))
    }
    async fn remove_reaction(
        &self,
        _pr: &PrRef,
        _comment: &theodore_domain::CommentId,
        _emoji: &str,
    ) -> HostResult<()> {
        self.remove_reaction_responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(()))
    }
    async fn assignable_users(&self, _repo: &RepoRef) -> HostResult<Vec<Person>> {
        self.assignable_users_responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(vec![]))
    }
    async fn request_reviewers(
        &self,
        _pr: &PrRef,
        users: &[String],
        teams: &[String],
    ) -> HostResult<()> {
        self.reviewer_calls
            .lock()
            .unwrap()
            .push((users.to_vec(), teams.to_vec()));
        self.request_reviewers_responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(()))
    }
    async fn remove_reviewer(&self, _pr: &PrRef, user: &str) -> HostResult<()> {
        self.remove_reviewer_calls
            .lock()
            .unwrap()
            .push(user.to_string());
        self.remove_reviewer_responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(()))
    }
    async fn mark_ready(&self, _pr: &PrRef) -> HostResult<()> {
        self.mark_ready_responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(()))
    }
    async fn convert_to_draft(&self, _pr: &PrRef) -> HostResult<()> {
        self.convert_to_draft_responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(()))
    }
    async fn merge_status(&self, _pr: &PrRef) -> HostResult<MergeStatus> {
        self.merge_status_responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Err(HostError::NotFound("no fixture queued".into())))
    }
    async fn merge(
        &self,
        _pr: &PrRef,
        method: MergeMethod,
        title: Option<String>,
        body: Option<String>,
    ) -> HostResult<theodore_domain::Sha> {
        self.merge_calls
            .lock()
            .unwrap()
            .push((method, title.clone(), body.clone()));
        self.merge_responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Ok(theodore_domain::Sha::new("merged-sha")))
    }
    async fn enable_auto_merge(&self, _pr: &PrRef, _method: MergeMethod) -> HostResult<()> {
        self.enable_auto_merge_responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(()))
    }
    async fn enqueue(&self, _pr: &PrRef) -> HostResult<()> {
        self.enqueue_responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(()))
    }
    async fn update_branch(&self, _pr: &PrRef) -> HostResult<()> {
        self.update_branch_responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(()))
    }
}

// ── agents ────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct FakeAgent {
    scripts: Mutex<VecDeque<Vec<AgentEvent>>>,
    hang_next: Mutex<bool>,
    /// Keeps a run's sender alive forever so its `events.recv()` never
    /// resolves (used to test cancellation deterministically).
    kept_alive: Mutex<Vec<tokio::sync::mpsc::Sender<AgentEvent>>>,
    /// Every request `run()` was called with, in order (assertions on the
    /// prompt, mode, or agent a use case picked).
    requests: Mutex<Vec<AgentRequest>>,
}

impl FakeAgent {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    pub fn push_script(&self, events: Vec<AgentEvent>) {
        self.scripts.lock().unwrap().push_back(events);
    }
    /// The next `run()` call never emits anything and never closes, until
    /// the whole fake is dropped.
    pub fn hang_next_run(&self) {
        *self.hang_next.lock().unwrap() = true;
    }
    pub fn last_request(&self) -> Option<AgentRequest> {
        self.requests.lock().unwrap().last().cloned()
    }
}

#[async_trait]
impl AgentPort for FakeAgent {
    async fn detect(&self) -> Vec<AgentInfo> {
        theodore_domain::AgentId::ALL
            .into_iter()
            .map(|id| AgentInfo {
                id,
                path: None,
                version: None,
                installed: true,
            })
            .collect()
    }
    async fn run(&self, req: AgentRequest) -> Result<AgentRun, AgentError> {
        self.requests.lock().unwrap().push(req);
        let (tx, rx) = tokio::sync::mpsc::channel(64);
        let hang = std::mem::take(&mut *self.hang_next.lock().unwrap());
        if hang {
            self.kept_alive.lock().unwrap().push(tx);
        } else {
            let events = self.scripts.lock().unwrap().pop_front().unwrap_or_else(|| {
                vec![AgentEvent::Done {
                    final_text: "ok".into(),
                    usage: theodore_domain::Usage::default(),
                }]
            });
            tokio::spawn(async move {
                for e in events {
                    if tx.send(e).await.is_err() {
                        break;
                    }
                }
            });
        }
        Ok(AgentRun {
            events: rx,
            cancel: CancellationToken::new(),
        })
    }
}

// ── grouper ───────────────────────────────────────────────────────────────

pub struct FakeGrouper {
    grouping: Mutex<Grouping>,
    last_agent: Mutex<Option<AgentId>>,
}

impl FakeGrouper {
    pub fn new(grouping: Grouping) -> Arc<Self> {
        Arc::new(Self {
            grouping: Mutex::new(grouping),
            last_agent: Mutex::new(None),
        })
    }
    pub fn set(&self, grouping: Grouping) {
        *self.grouping.lock().unwrap() = grouping;
    }
    /// The `agent` the last `group`/`regroup` call was made with (plan
    /// §8.5: `agents.grouping` must reach the grouper).
    pub fn last_agent(&self) -> Option<AgentId> {
        *self.last_agent.lock().unwrap()
    }
}

#[async_trait]
impl Grouper for FakeGrouper {
    async fn group(
        &self,
        _rev: &Revision,
        _pr: &PrDetail,
        _worktree: &Path,
        agent: AgentId,
    ) -> Result<Grouping, GrouperError> {
        *self.last_agent.lock().unwrap() = Some(agent);
        Ok(self.grouping.lock().unwrap().clone())
    }
    async fn regroup(
        &self,
        prev: &Grouping,
        _rev: &Revision,
        _pr: &PrDetail,
        _worktree: &Path,
        agent: AgentId,
    ) -> Result<Grouping, GrouperError> {
        let _ = prev;
        *self.last_agent.lock().unwrap() = Some(agent);
        Ok(self.grouping.lock().unwrap().clone())
    }
}

// ── worktree lease ───────────────────────────────────────────────────────

/// Records every `acquire` call (and whether it's still held) so a test can
/// assert a run held its PR's lease for the run's duration, not just at the
/// start.
#[derive(Default)]
pub struct FakeWorktreeLease {
    acquired: Mutex<Vec<PrRef>>,
    held: Arc<Mutex<HashMap<PrRef, u32>>>,
}

struct FakeLeaseGuard {
    held: Arc<Mutex<HashMap<PrRef, u32>>>,
    pr: PrRef,
}

impl Drop for FakeLeaseGuard {
    fn drop(&mut self) {
        let mut held = self.held.lock().unwrap();
        if let Some(n) = held.get_mut(&self.pr) {
            *n -= 1;
            if *n == 0 {
                held.remove(&self.pr);
            }
        }
    }
}

impl FakeWorktreeLease {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Every PR `acquire` was called with, in order.
    pub fn acquired(&self) -> Vec<PrRef> {
        self.acquired.lock().unwrap().clone()
    }

    /// Whether `pr` has at least one outstanding (not yet dropped) guard.
    pub fn is_held(&self, pr: &PrRef) -> bool {
        self.held.lock().unwrap().contains_key(pr)
    }
}

impl theodore_ports::WorktreeLease for FakeWorktreeLease {
    fn acquire(&self, pr: PrRef) -> Box<dyn std::any::Any + Send> {
        self.acquired.lock().unwrap().push(pr.clone());
        *self.held.lock().unwrap().entry(pr.clone()).or_insert(0) += 1;
        Box::new(FakeLeaseGuard {
            held: self.held.clone(),
            pr,
        })
    }
}

// ── token status ────────────────────────────────────────────────────────

pub struct FakeTokenStatus {
    source: Mutex<TokenSource>,
    invalidations: Mutex<u32>,
}

impl FakeTokenStatus {
    pub fn new(source: TokenSource) -> Arc<Self> {
        Arc::new(Self {
            source: Mutex::new(source),
            invalidations: Mutex::new(0),
        })
    }
    pub fn set(&self, source: TokenSource) {
        *self.source.lock().unwrap() = source;
    }
    pub fn invalidations(&self) -> u32 {
        *self.invalidations.lock().unwrap()
    }
}

impl TokenStatus for FakeTokenStatus {
    fn source(&self) -> TokenSource {
        self.source.lock().unwrap().clone()
    }
    fn invalidate(&self) {
        *self.invalidations.lock().unwrap() += 1;
    }
}

// ── device login ────────────────────────────────────────────────────────

/// Controllable fake for GitHub's device flow (plan "login"): a canned
/// `start` response, a queue of `poll` outcomes (defaulting to `Pending`
/// once drained), and an optional one-shot failure for either call.
pub struct FakeDeviceLogin {
    start: Mutex<DeviceCodeStart>,
    polls: Mutex<VecDeque<DevicePoll>>,
    fail_next: Mutex<bool>,
    calls: Mutex<Vec<&'static str>>,
}

impl FakeDeviceLogin {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            start: Mutex::new(DeviceCodeStart {
                device_code: "dc-1".into(),
                user_code: "ABCD-1234".into(),
                verification_uri: "https://github.com/login/device".into(),
                expires_in: 900,
                interval: 5,
            }),
            polls: Mutex::new(VecDeque::new()),
            fail_next: Mutex::new(false),
            calls: Mutex::new(Vec::new()),
        })
    }

    pub fn set_start(&self, start: DeviceCodeStart) {
        *self.start.lock().unwrap() = start;
    }

    pub fn push_poll(&self, outcome: DevicePoll) {
        self.polls.lock().unwrap().push_back(outcome);
    }

    pub fn fail_next_call(&self) {
        *self.fail_next.lock().unwrap() = true;
    }

    pub fn calls(&self) -> Vec<&'static str> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl DeviceLoginPort for FakeDeviceLogin {
    async fn start(&self, _client_id: &str, _scope: &str) -> HostResult<DeviceCodeStart> {
        self.calls.lock().unwrap().push("start");
        if std::mem::take(&mut *self.fail_next.lock().unwrap()) {
            return Err(HostError::Network("fake device login failure".into()));
        }
        Ok(self.start.lock().unwrap().clone())
    }

    async fn poll(
        &self,
        _client_id: &str,
        _device_code: &str,
        _current_interval: u32,
    ) -> HostResult<DevicePoll> {
        self.calls.lock().unwrap().push("poll");
        if std::mem::take(&mut *self.fail_next.lock().unwrap()) {
            return Err(HostError::Network("fake device login failure".into()));
        }
        Ok(self
            .polls
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(DevicePoll::Pending))
    }
}

// ── fixtures ──────────────────────────────────────────────────────────────

pub struct Fixtures {
    pub clock: Arc<FakeClock>,
    pub store: Arc<FakeStore>,
    pub host: Arc<FakeHost>,
    pub git: Arc<FakeGit>,
    pub agents: Arc<FakeAgent>,
    pub secrets: Arc<FakeSecrets>,
    pub grouper: Arc<FakeGrouper>,
    pub token_status: Arc<FakeTokenStatus>,
    pub device_login: Arc<FakeDeviceLogin>,
    pub worktree_lease: Arc<FakeWorktreeLease>,
    /// A throwaway `~/.claude/skills` stand-in (plan §8.4): kept alive for
    /// the fixture's lifetime, deleted on drop. Never the real home dir.
    pub claude_home: Arc<tempfile::TempDir>,
}

impl Fixtures {
    pub fn deps(&self) -> Deps {
        Deps {
            host: self.host.clone(),
            git: self.git.clone(),
            agents: self.agents.clone(),
            store: self.store.clone(),
            secrets: self.secrets.clone(),
            clock: self.clock.clone(),
            grouper: self.grouper.clone(),
            tools: None,
            claude_home: self.claude_home.path().to_path_buf(),
            token_status: Some(self.token_status.clone()),
            device_login: self.device_login.clone(),
            worktree_lease: self.worktree_lease.clone(),
        }
    }
}

/// A fresh set of fakes wired to one sample PR: one file, two hunks (so
/// "viewed" only flips once both are read).
pub fn fixtures() -> Fixtures {
    let base = Sha::new("base000");
    let head = Sha::new("head111");
    let revision = two_hunk_revision(&base, &head, "src/lib.rs");
    Fixtures {
        clock: FakeClock::new(1_000_000),
        store: FakeStore::new(),
        host: FakeHost::new(),
        git: FakeGit::new(head, revision),
        agents: FakeAgent::new(),
        secrets: FakeSecrets::new(),
        grouper: FakeGrouper::new(Grouping {
            rev: Sha::new("head111"),
            groups: vec![],
        }),
        token_status: FakeTokenStatus::new(TokenSource::Keychain),
        device_login: FakeDeviceLogin::new(),
        worktree_lease: FakeWorktreeLease::new(),
        claude_home: Arc::new(tempfile::tempdir().expect("tempdir")),
    }
}

pub fn line_ctx(old_no: u32, new_no: u32, text: &str) -> theodore_domain::DiffLine {
    theodore_domain::DiffLine {
        kind: LineKind::Ctx,
        text: text.into(),
        old_no: Some(old_no),
        new_no: Some(new_no),
    }
}

pub fn line_add(new_no: u32, text: &str) -> theodore_domain::DiffLine {
    theodore_domain::DiffLine {
        kind: LineKind::Add,
        text: text.into(),
        old_no: None,
        new_no: Some(new_no),
    }
}

pub fn make_hunk(
    path: &str,
    old_start: u32,
    old_lines: u32,
    new_start: u32,
    new_lines: u32,
    lines: Vec<theodore_domain::DiffLine>,
) -> Hunk {
    let id = theodore_domain::interdiff::hunk_id(path, &lines);
    Hunk {
        id,
        path: path.into(),
        old_start,
        old_lines,
        new_start,
        new_lines,
        header: String::new(),
        lines,
    }
}

/// One file with two independent hunks.
pub fn two_hunk_revision(base: &Sha, head: &Sha, path: &str) -> Revision {
    let h1 = make_hunk(
        path,
        1,
        1,
        1,
        2,
        vec![line_ctx(1, 1, "a"), line_add(2, "b1")],
    );
    let h2 = make_hunk(
        path,
        10,
        1,
        11,
        2,
        vec![line_ctx(10, 11, "z"), line_add(12, "b2")],
    );
    let file = FileDiff {
        path: path.into(),
        old_path: None,
        status: FileStatus::Modified,
        similarity: None,
        old_mode: None,
        new_mode: None,
        flags: vec![],
        additions: 2,
        deletions: 0,
        hunks: vec![h1, h2],
    };
    Revision {
        base: base.clone(),
        head: head.clone(),
        files: vec![file],
    }
}

pub fn hunk_ids(rev: &Revision) -> Vec<HunkId> {
    rev.hunks().map(|h| h.id.clone()).collect()
}

pub fn sample_pr_ref(owner: &str, repo: &str, number: u64) -> PrRef {
    PrRef {
        repo: theodore_domain::RepoRef {
            host: theodore_domain::HostKind::Github,
            owner: owner.into(),
            name: repo.into(),
        },
        number,
        host_id: Some(format!("node-{number}")),
    }
}

pub fn sample_person(login: &str) -> Person {
    Person {
        login: login.into(),
        name: None,
        avatar_url: None,
    }
}

pub fn sample_pr_summary(pr_ref: &PrRef, head: &Sha) -> PrSummary {
    PrSummary {
        pr: pr_ref.clone(),
        title: "Sample PR".into(),
        author: sample_person("author"),
        state: PrState::Open,
        base_ref: "main".into(),
        head_ref: "feature".into(),
        head_sha: head.clone(),
        additions: 2,
        deletions: 0,
        changed_files: 1,
        reasons: vec![],
        checks: CheckRollup::None,
        approvals: 0,
        required_approvals: Some(1),
        updated_at: 0,
        url: format!(
            "https://github.com/{}/{}/pull/{}",
            pr_ref.repo.owner, pr_ref.repo.name, pr_ref.number
        ),
    }
}

pub fn sample_pr_detail(pr_ref: &PrRef, base: &Sha, head: &Sha) -> PrDetail {
    PrDetail {
        summary: sample_pr_summary(pr_ref, head),
        body: "body".into(),
        base_sha: base.clone(),
        commits: vec![],
        checks: vec![],
        reviewers: vec![],
        assignees: vec![],
        labels: vec![],
        threads: vec![],
        viewed: vec![],
    }
}

pub fn sample_grouping(rev: &Sha, revision: &Revision) -> Grouping {
    Grouping {
        rev: rev.clone(),
        groups: vec![Group {
            id: GroupId::new("g1"),
            title: "All changes".into(),
            why: "sample".into(),
            kind: GroupKind::Normal,
            risk: None,
            check: vec![],
            hunks: hunk_ids(revision),
            outliers: vec![],
        }],
    }
}

pub fn sample_anchor(path: &str, line: u32) -> Anchor {
    Anchor {
        rev: Sha::new("head111"),
        path: path.into(),
        side: Side::New,
        line,
        start_line: None,
        start_side: None,
    }
}
