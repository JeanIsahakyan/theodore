//! `CoreApi`: one async method per command in `.context/commands.md`. Tauri
//! commands (`commands.rs`) delegate to `State<Arc<dyn CoreApi>>`; the real
//! implementation (`theodore-app`) is wired in by the integration slice.

use async_trait::async_trait;
use theodore_contract::{
    AddProjectRequest, AgentStatus, AppInfo, AskRequest, BlobResponse, Bootstrap, BootstrapScope,
    CommandError, CommitSuggestionsRequest, ConflictFile, DelegateRequest, DeviceLogin,
    DraftStateRequest, EditCommentRequest, FileRequest, FindSymbolRequest, GetBlobRequest,
    HostAuthStatus, InterdiffEntry, InterdiffRequest, LinearIssue, LinearIssuesRequest,
    LinearStatus, LocalBranch, LoginState, MergeInfo, MergeRequest, OpenBranchRequest,
    OpenPrRequest, OpenPrResponse, PrSpend, Project, ReactRequest, ReplyRequest, RerunCheckRequest,
    ResolveRequest, ReviewersRequest, RevisionRequest, RunSkillRequest, SaveSkillRequest,
    SetLinearTokenRequest, SetTokenRequest, SkillBody, SkillInfo, SubmitReviewRequest, SymbolHit,
    SyncFrame, TaskDecision, Transaction, TransactionResult, TriageRequest, UpdateInfo,
};
use theodore_contract::{SandboxFaultRequest, SandboxStatus};
use theodore_domain::{HostKind, HostRepo, Person, PrId, Revision};

fn not_ready() -> CommandError {
    CommandError {
        code: "not_ready".into(),
        message: "the core is not wired up yet".into(),
    }
}

/// One method per command. Implemented by `theodore-app` in the integration
/// slice; `NotReadyCoreApi` below stands in until then.
#[async_trait]
pub trait CoreApi: Send + Sync {
    async fn bootstrap(&self, scope: BootstrapScope) -> Result<Bootstrap, CommandError>;
    async fn catch_up(&self, since: u64) -> Result<SyncFrame, CommandError>;
    async fn transact(&self, tx: Transaction) -> Result<TransactionResult, CommandError>;
    async fn open_pr(&self, req: OpenPrRequest) -> Result<OpenPrResponse, CommandError>;
    async fn get_revision(&self, req: RevisionRequest) -> Result<Revision, CommandError>;
    async fn get_file(&self, req: FileRequest) -> Result<Option<String>, CommandError>;
    async fn regroup(&self, pr: PrId) -> Result<(), CommandError>;
    async fn run_skill(&self, req: RunSkillRequest) -> Result<String, CommandError>;
    async fn ask(&self, req: AskRequest) -> Result<String, CommandError>;
    async fn cancel_run(&self, run: String) -> Result<(), CommandError>;
    async fn submit_review(&self, req: SubmitReviewRequest) -> Result<(), CommandError>;
    async fn detect_agents(&self) -> Result<Vec<AgentStatus>, CommandError>;
    async fn app_info(&self) -> Result<AppInfo, CommandError>;
    async fn check_update(&self) -> Result<Option<UpdateInfo>, CommandError>;
    async fn install_update(&self) -> Result<(), CommandError>;
    async fn refresh_inbox(&self) -> Result<(), CommandError>;
    async fn viewer(&self) -> Result<Person, CommandError>;
    async fn host_status(&self) -> Result<HostAuthStatus, CommandError>;
    async fn host_status_for(&self, host: HostKind) -> Result<HostAuthStatus, CommandError>;
    async fn set_host_token(&self, req: SetTokenRequest) -> Result<HostAuthStatus, CommandError>;
    async fn reply_thread(&self, req: ReplyRequest) -> Result<(), CommandError>;
    async fn resolve_thread(&self, req: ResolveRequest) -> Result<(), CommandError>;
    async fn list_skills(&self, pr: Option<PrId>) -> Result<Vec<SkillInfo>, CommandError>;
    async fn delegate_task(&self, req: DelegateRequest) -> Result<String, CommandError>;
    async fn decide_task(&self, req: TaskDecision) -> Result<(), CommandError>;
    async fn list_host_repos(&self) -> Result<Vec<HostRepo>, CommandError>;
    async fn add_project(&self, req: AddProjectRequest) -> Result<Project, CommandError>;
    async fn remove_project(&self, id: String) -> Result<(), CommandError>;
    async fn refresh_project(&self, id: String) -> Result<(), CommandError>;
    async fn list_branches(&self, project: String) -> Result<Vec<LocalBranch>, CommandError>;
    async fn open_branch(&self, req: OpenBranchRequest) -> Result<OpenPrResponse, CommandError>;
    async fn merge_info(&self, pr: PrId) -> Result<MergeInfo, CommandError>;
    async fn merge_pr(&self, req: MergeRequest) -> Result<(), CommandError>;
    async fn assignable_users(&self, pr: PrId) -> Result<Vec<Person>, CommandError>;
    async fn set_reviewers(&self, req: ReviewersRequest) -> Result<(), CommandError>;
    async fn set_draft(&self, req: DraftStateRequest) -> Result<(), CommandError>;
    async fn update_branch(&self, pr: PrId) -> Result<(), CommandError>;
    async fn react(&self, req: ReactRequest) -> Result<(), CommandError>;
    async fn edit_comment(&self, req: EditCommentRequest) -> Result<(), CommandError>;
    async fn commit_suggestions(&self, req: CommitSuggestionsRequest) -> Result<(), CommandError>;
    async fn get_skill(&self, id: String, pr: Option<PrId>) -> Result<SkillBody, CommandError>;
    async fn save_skill(&self, req: SaveSkillRequest) -> Result<SkillInfo, CommandError>;
    async fn pr_spend(&self, pr: PrId) -> Result<PrSpend, CommandError>;
    async fn interdiff(&self, req: InterdiffRequest) -> Result<Vec<InterdiffEntry>, CommandError>;
    /// Starts a GitHub OAuth device-flow login (plan "login").
    async fn login_start(&self) -> Result<DeviceLogin, CommandError>;
    /// Polls once for that login's outcome.
    async fn login_poll(&self) -> Result<LoginState, CommandError>;
    async fn rerun_check(&self, req: RerunCheckRequest) -> Result<(), CommandError>;
    async fn triage(&self, req: TriageRequest) -> Result<(), CommandError>;
    /// Validates the token via Linear's `viewer` query, then stores it
    /// (`token: None` disconnects).
    async fn set_linear_token(
        &self,
        req: SetLinearTokenRequest,
    ) -> Result<LinearStatus, CommandError>;
    async fn linear_status(&self) -> Result<LinearStatus, CommandError>;
    /// Issues linked to a PR by a key found in its title, head branch or body.
    async fn linear_issues(
        &self,
        req: LinearIssuesRequest,
    ) -> Result<Vec<LinearIssue>, CommandError>;
    /// Go-to-definition / find-references for a ⌘-clicked identifier
    /// (plan "symbols").
    async fn find_symbol(&self, req: FindSymbolRequest) -> Result<Vec<SymbolHit>, CommandError>;
    /// Raw bytes of a changed file at `base`/`head`, base64'd (plan "image diff").
    async fn get_blob(&self, req: GetBlobRequest) -> Result<BlobResponse, CommandError>;
    /// Locally-detected conflicting paths (plan "conflicts"); `Unsupported`
    /// on a `git` older than 2.38 — the UI hides the list on that code.
    async fn conflicts(&self, pr: PrId) -> Result<Vec<ConflictFile>, CommandError>;
    /// A local folder project's checkout: current branch, uncommitted paths.
    async fn project_working_state(
        &self,
        project: String,
    ) -> Result<theodore_contract::ProjectWorkingState, CommandError>;
    /// Closes a branch review: its local rows and worktree. Rejects a host PR.
    async fn close_branch_review(&self, pr: PrId) -> Result<(), CommandError>;

    /// `updates.channel` setting (`"stable"` or `"beta"`), used to pick the
    /// updater endpoint. Not a wire command; the shell calls it directly.
    async fn update_channel(&self) -> String {
        "stable".into()
    }

    /// Gates `install_update`'s restart: no agent running, outbox empty.
    async fn is_idle(&self) -> bool {
        true
    }

    /// `false` in sandbox mode: no update checks (no network at all).
    async fn updates_enabled(&self) -> bool {
        true
    }

    /// Settings → Sandbox (docs/sandbox.md); `None` outside sandbox mode.
    async fn sandbox_status(&self) -> Result<Option<SandboxStatus>, CommandError> {
        Ok(None)
    }
    /// Turns one sandbox fault on or off.
    async fn sandbox_set_fault(
        &self,
        _req: SandboxFaultRequest,
    ) -> Result<SandboxStatus, CommandError> {
        Err(not_sandbox())
    }
    /// Fires one scripted sandbox timeline event now.
    async fn sandbox_fire_event(&self, _id: String) -> Result<SandboxStatus, CommandError> {
        Err(not_sandbox())
    }
}

fn not_sandbox() -> CommandError {
    CommandError {
        code: "invalid".into(),
        message: "not running in sandbox mode".into(),
    }
}

/// Placeholder `CoreApi` mounted before `theodore-app` is wired in. Every
/// command rejects with `{code: "not_ready"}`.
pub struct NotReadyCoreApi;

#[async_trait]
impl CoreApi for NotReadyCoreApi {
    async fn bootstrap(&self, _scope: BootstrapScope) -> Result<Bootstrap, CommandError> {
        Err(not_ready())
    }
    async fn catch_up(&self, _since: u64) -> Result<SyncFrame, CommandError> {
        Err(not_ready())
    }
    async fn transact(&self, _tx: Transaction) -> Result<TransactionResult, CommandError> {
        Err(not_ready())
    }
    async fn open_pr(&self, _req: OpenPrRequest) -> Result<OpenPrResponse, CommandError> {
        Err(not_ready())
    }
    async fn get_revision(&self, _req: RevisionRequest) -> Result<Revision, CommandError> {
        Err(not_ready())
    }
    async fn get_file(&self, _req: FileRequest) -> Result<Option<String>, CommandError> {
        Err(not_ready())
    }
    async fn regroup(&self, _pr: PrId) -> Result<(), CommandError> {
        Err(not_ready())
    }
    async fn run_skill(&self, _req: RunSkillRequest) -> Result<String, CommandError> {
        Err(not_ready())
    }
    async fn ask(&self, _req: AskRequest) -> Result<String, CommandError> {
        Err(not_ready())
    }
    async fn cancel_run(&self, _run: String) -> Result<(), CommandError> {
        Err(not_ready())
    }
    async fn submit_review(&self, _req: SubmitReviewRequest) -> Result<(), CommandError> {
        Err(not_ready())
    }
    async fn detect_agents(&self) -> Result<Vec<AgentStatus>, CommandError> {
        Err(not_ready())
    }
    async fn app_info(&self) -> Result<AppInfo, CommandError> {
        Err(not_ready())
    }
    async fn check_update(&self) -> Result<Option<UpdateInfo>, CommandError> {
        Err(not_ready())
    }
    async fn install_update(&self) -> Result<(), CommandError> {
        Err(not_ready())
    }
    async fn refresh_inbox(&self) -> Result<(), CommandError> {
        Err(not_ready())
    }
    async fn viewer(&self) -> Result<Person, CommandError> {
        Err(not_ready())
    }
    async fn host_status(&self) -> Result<HostAuthStatus, CommandError> {
        Err(not_ready())
    }
    async fn host_status_for(&self, _host: HostKind) -> Result<HostAuthStatus, CommandError> {
        Err(not_ready())
    }
    async fn set_host_token(&self, _req: SetTokenRequest) -> Result<HostAuthStatus, CommandError> {
        Err(not_ready())
    }
    async fn reply_thread(&self, _req: ReplyRequest) -> Result<(), CommandError> {
        Err(not_ready())
    }
    async fn resolve_thread(&self, _req: ResolveRequest) -> Result<(), CommandError> {
        Err(not_ready())
    }
    async fn list_skills(&self, _pr: Option<PrId>) -> Result<Vec<SkillInfo>, CommandError> {
        Err(not_ready())
    }
    async fn delegate_task(&self, _req: DelegateRequest) -> Result<String, CommandError> {
        Err(not_ready())
    }
    async fn decide_task(&self, _req: TaskDecision) -> Result<(), CommandError> {
        Err(not_ready())
    }
    async fn list_host_repos(&self) -> Result<Vec<HostRepo>, CommandError> {
        Err(not_ready())
    }
    async fn add_project(&self, _req: AddProjectRequest) -> Result<Project, CommandError> {
        Err(not_ready())
    }
    async fn remove_project(&self, _id: String) -> Result<(), CommandError> {
        Err(not_ready())
    }
    async fn refresh_project(&self, _id: String) -> Result<(), CommandError> {
        Err(not_ready())
    }
    async fn list_branches(&self, _project: String) -> Result<Vec<LocalBranch>, CommandError> {
        Err(not_ready())
    }
    async fn open_branch(&self, _req: OpenBranchRequest) -> Result<OpenPrResponse, CommandError> {
        Err(not_ready())
    }
    async fn merge_info(&self, _pr: PrId) -> Result<MergeInfo, CommandError> {
        Err(not_ready())
    }
    async fn merge_pr(&self, _req: MergeRequest) -> Result<(), CommandError> {
        Err(not_ready())
    }
    async fn assignable_users(&self, _pr: PrId) -> Result<Vec<Person>, CommandError> {
        Err(not_ready())
    }
    async fn set_reviewers(&self, _req: ReviewersRequest) -> Result<(), CommandError> {
        Err(not_ready())
    }
    async fn set_draft(&self, _req: DraftStateRequest) -> Result<(), CommandError> {
        Err(not_ready())
    }
    async fn update_branch(&self, _pr: PrId) -> Result<(), CommandError> {
        Err(not_ready())
    }
    async fn react(&self, _req: ReactRequest) -> Result<(), CommandError> {
        Err(not_ready())
    }
    async fn edit_comment(&self, _req: EditCommentRequest) -> Result<(), CommandError> {
        Err(not_ready())
    }
    async fn commit_suggestions(&self, _req: CommitSuggestionsRequest) -> Result<(), CommandError> {
        Err(not_ready())
    }
    async fn get_skill(&self, _id: String, _pr: Option<PrId>) -> Result<SkillBody, CommandError> {
        Err(not_ready())
    }
    async fn save_skill(&self, _req: SaveSkillRequest) -> Result<SkillInfo, CommandError> {
        Err(not_ready())
    }
    async fn pr_spend(&self, _pr: PrId) -> Result<PrSpend, CommandError> {
        Err(not_ready())
    }
    async fn interdiff(&self, _req: InterdiffRequest) -> Result<Vec<InterdiffEntry>, CommandError> {
        Err(not_ready())
    }
    async fn login_start(&self) -> Result<DeviceLogin, CommandError> {
        Err(not_ready())
    }
    async fn login_poll(&self) -> Result<LoginState, CommandError> {
        Err(not_ready())
    }
    async fn rerun_check(&self, _req: RerunCheckRequest) -> Result<(), CommandError> {
        Err(not_ready())
    }
    async fn triage(&self, _req: TriageRequest) -> Result<(), CommandError> {
        Err(not_ready())
    }
    async fn set_linear_token(
        &self,
        _req: SetLinearTokenRequest,
    ) -> Result<LinearStatus, CommandError> {
        Err(not_ready())
    }
    async fn linear_status(&self) -> Result<LinearStatus, CommandError> {
        Err(not_ready())
    }
    async fn linear_issues(
        &self,
        _req: LinearIssuesRequest,
    ) -> Result<Vec<LinearIssue>, CommandError> {
        Err(not_ready())
    }
    async fn find_symbol(&self, _req: FindSymbolRequest) -> Result<Vec<SymbolHit>, CommandError> {
        Err(not_ready())
    }
    async fn get_blob(&self, _req: GetBlobRequest) -> Result<BlobResponse, CommandError> {
        Err(not_ready())
    }
    async fn conflicts(&self, _pr: PrId) -> Result<Vec<ConflictFile>, CommandError> {
        Err(not_ready())
    }
    async fn project_working_state(
        &self,
        _project: String,
    ) -> Result<theodore_contract::ProjectWorkingState, CommandError> {
        Err(not_ready())
    }
    async fn close_branch_review(&self, _pr: PrId) -> Result<(), CommandError> {
        Err(not_ready())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn not_ready_rejects_with_the_expected_code() {
        let core = NotReadyCoreApi;
        let err = core.app_info().await.unwrap_err();
        assert_eq!(err.code, "not_ready");

        let err = core.bootstrap(BootstrapScope::Global).await.unwrap_err();
        assert_eq!(err.code, "not_ready");
    }

    #[tokio::test]
    async fn default_methods_are_safe_before_the_core_is_wired_up() {
        let core = NotReadyCoreApi;
        assert_eq!(core.update_channel().await, "stable");
        assert!(core.is_idle().await);
    }
}
