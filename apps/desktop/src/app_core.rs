//! `CoreApi` over the real core (`theodore-app`).

use async_trait::async_trait;
use theodore_app::{AppError, Core};
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
use theodore_domain::{HostKind, HostRepo, Person, PrId, Revision};

use crate::core_api::CoreApi;

pub struct AppCore {
    core: Core,
    sandbox: Option<theodore_sandbox::Sandbox>,
}

impl AppCore {
    pub fn new(core: Core) -> Self {
        Self {
            core,
            sandbox: None,
        }
    }

    /// Sandbox mode (docs/sandbox.md): `app_info` carries the badge info
    /// and the `sandbox_*` commands work.
    pub fn with_sandbox(mut self, sandbox: Option<theodore_sandbox::Sandbox>) -> Self {
        self.sandbox = sandbox;
        self
    }

    fn sandbox(&self) -> Result<theodore_sandbox::Sandbox, CommandError> {
        self.sandbox.clone().ok_or_else(|| CommandError {
            code: "invalid".into(),
            message: "not running in sandbox mode".into(),
        })
    }
}

/// Sandbox calls shell out to git under a lock: keep them off the runtime.
async fn sandbox_call<T: Send + 'static>(
    sb: theodore_sandbox::Sandbox,
    f: impl FnOnce(&theodore_sandbox::Sandbox) -> theodore_sandbox::SandboxResult<T> + Send + 'static,
) -> Result<T, CommandError> {
    tokio::task::spawn_blocking(move || f(&sb))
        .await
        .map_err(|e| CommandError {
            code: "internal".into(),
            message: e.to_string(),
        })?
        .map_err(|e| CommandError {
            code: "invalid".into(),
            message: e.to_string(),
        })
}

fn err(e: AppError) -> CommandError {
    let code = match &e {
        AppError::Store(_) => "store",
        // An old local `git` lacking `merge-tree --write-tree` (`conflicts`):
        // the UI hides the conflicts list on this code instead of toasting it.
        AppError::Git(theodore_ports::GitError::Unsupported(_)) => "unsupported",
        AppError::Git(_) => "git",
        AppError::Host(theodore_ports::HostError::Auth) => "auth",
        AppError::Host(_) => "host",
        AppError::Grouper(_) => "grouping",
        AppError::NotFound(_) => "not_found",
        AppError::Invalid(_) => "invalid",
        AppError::Join(_) => "internal",
    };
    CommandError {
        code: code.into(),
        message: e.to_string(),
    }
}

#[async_trait]
impl CoreApi for AppCore {
    async fn bootstrap(&self, scope: BootstrapScope) -> Result<Bootstrap, CommandError> {
        self.core.bootstrap(scope).await.map_err(err)
    }
    async fn catch_up(&self, since: u64) -> Result<SyncFrame, CommandError> {
        self.core.catch_up(since).await.map_err(err)
    }
    async fn transact(&self, tx: Transaction) -> Result<TransactionResult, CommandError> {
        Ok(self.core.transact(tx).await)
    }
    async fn open_pr(&self, req: OpenPrRequest) -> Result<OpenPrResponse, CommandError> {
        self.core.open_pr(req).await.map_err(err)
    }
    async fn get_revision(&self, req: RevisionRequest) -> Result<Revision, CommandError> {
        self.core.get_revision(req).await.map_err(err)
    }
    async fn get_file(&self, req: FileRequest) -> Result<Option<String>, CommandError> {
        self.core.get_file(req).await.map_err(err)
    }
    async fn regroup(&self, pr: PrId) -> Result<(), CommandError> {
        self.core.regroup(pr).await.map_err(err)
    }
    async fn run_skill(&self, req: RunSkillRequest) -> Result<String, CommandError> {
        self.core.run_skill(req).await.map_err(err)
    }
    async fn ask(&self, req: AskRequest) -> Result<String, CommandError> {
        self.core.ask(req).await.map_err(err)
    }
    async fn cancel_run(&self, run: String) -> Result<(), CommandError> {
        self.core.cancel_run(run).await.map_err(err)
    }
    async fn submit_review(&self, req: SubmitReviewRequest) -> Result<(), CommandError> {
        self.core.submit_review(req).await.map_err(err)
    }
    async fn detect_agents(&self) -> Result<Vec<AgentStatus>, CommandError> {
        Ok(self
            .core
            .deps()
            .agents
            .detect()
            .await
            .into_iter()
            .map(|a| AgentStatus {
                id: a.id,
                installed: a.installed,
                version: a.version,
                path: a.path.map(|p| p.display().to_string()),
            })
            .collect())
    }
    async fn app_info(&self) -> Result<AppInfo, CommandError> {
        Ok(AppInfo {
            version: env!("CARGO_PKG_VERSION").into(),
            channel: self.update_channel().await,
            update: None,
            sandbox: self.sandbox.as_ref().map(|s| s.info()),
        })
    }
    async fn check_update(&self) -> Result<Option<UpdateInfo>, CommandError> {
        // The shell's updater owns checks; the command never reaches here.
        Ok(None)
    }
    async fn install_update(&self) -> Result<(), CommandError> {
        Ok(())
    }
    async fn refresh_inbox(&self) -> Result<(), CommandError> {
        self.core.refresh_inbox().await.map_err(err)
    }
    async fn viewer(&self) -> Result<Person, CommandError> {
        self.core.viewer().await.map_err(err)
    }
    async fn host_status(&self) -> Result<HostAuthStatus, CommandError> {
        self.core.host_status().await.map_err(err)
    }
    async fn host_status_for(&self, host: HostKind) -> Result<HostAuthStatus, CommandError> {
        self.core.host_status_for(host).await.map_err(err)
    }
    async fn set_host_token(&self, req: SetTokenRequest) -> Result<HostAuthStatus, CommandError> {
        self.core.set_host_token(req).await.map_err(err)
    }
    async fn reply_thread(&self, req: ReplyRequest) -> Result<(), CommandError> {
        self.core.reply_thread(req).await.map_err(err)
    }
    async fn resolve_thread(&self, req: ResolveRequest) -> Result<(), CommandError> {
        self.core.resolve_thread(req).await.map_err(err)
    }
    async fn list_skills(&self, pr: Option<PrId>) -> Result<Vec<SkillInfo>, CommandError> {
        self.core.list_skills(pr).await.map_err(err)
    }
    async fn delegate_task(&self, req: DelegateRequest) -> Result<String, CommandError> {
        self.core.delegate_task(req).await.map_err(err)
    }
    async fn decide_task(&self, req: TaskDecision) -> Result<(), CommandError> {
        self.core.decide_task(req).await.map_err(err)
    }
    async fn list_host_repos(&self) -> Result<Vec<HostRepo>, CommandError> {
        self.core.list_host_repos().await.map_err(err)
    }
    async fn add_project(&self, req: AddProjectRequest) -> Result<Project, CommandError> {
        self.core.add_project(req).await.map_err(err)
    }
    async fn remove_project(&self, id: String) -> Result<(), CommandError> {
        self.core.remove_project(&id).await.map_err(err)
    }
    async fn refresh_project(&self, id: String) -> Result<(), CommandError> {
        self.core.refresh_project(&id).await.map_err(err)
    }
    async fn list_branches(&self, project: String) -> Result<Vec<LocalBranch>, CommandError> {
        self.core.list_branches(&project).await.map_err(err)
    }
    async fn open_branch(&self, req: OpenBranchRequest) -> Result<OpenPrResponse, CommandError> {
        self.core.open_branch(req).await.map_err(err)
    }
    async fn merge_info(&self, pr: PrId) -> Result<MergeInfo, CommandError> {
        self.core.merge_info(pr).await.map_err(err)
    }
    async fn merge_pr(&self, req: MergeRequest) -> Result<(), CommandError> {
        self.core.merge_pr(req).await.map_err(err)
    }
    async fn assignable_users(&self, pr: PrId) -> Result<Vec<Person>, CommandError> {
        self.core.assignable_users(pr).await.map_err(err)
    }
    async fn set_reviewers(&self, req: ReviewersRequest) -> Result<(), CommandError> {
        self.core.set_reviewers(req).await.map_err(err)
    }
    async fn set_draft(&self, req: DraftStateRequest) -> Result<(), CommandError> {
        self.core.set_draft(req).await.map_err(err)
    }
    async fn update_branch(&self, pr: PrId) -> Result<(), CommandError> {
        self.core.update_branch(pr).await.map_err(err)
    }
    async fn react(&self, req: ReactRequest) -> Result<(), CommandError> {
        self.core.react(req).await.map_err(err)
    }
    async fn edit_comment(&self, req: EditCommentRequest) -> Result<(), CommandError> {
        self.core.edit_comment(req).await.map_err(err)
    }
    async fn commit_suggestions(&self, req: CommitSuggestionsRequest) -> Result<(), CommandError> {
        self.core.commit_suggestions(req).await.map_err(err)
    }
    async fn get_skill(&self, id: String, pr: Option<PrId>) -> Result<SkillBody, CommandError> {
        self.core.get_skill(&id, pr).await.map_err(err)
    }
    async fn save_skill(&self, req: SaveSkillRequest) -> Result<SkillInfo, CommandError> {
        self.core.save_skill(req).await.map_err(err)
    }
    async fn pr_spend(&self, pr: PrId) -> Result<PrSpend, CommandError> {
        self.core.pr_spend(pr).await.map_err(err)
    }
    async fn interdiff(&self, req: InterdiffRequest) -> Result<Vec<InterdiffEntry>, CommandError> {
        self.core.interdiff(req).await.map_err(err)
    }
    async fn login_start(&self) -> Result<DeviceLogin, CommandError> {
        self.core.login_start().await.map_err(err)
    }
    async fn login_poll(&self) -> Result<LoginState, CommandError> {
        self.core.login_poll().await.map_err(err)
    }
    async fn rerun_check(&self, req: RerunCheckRequest) -> Result<(), CommandError> {
        self.core.rerun_check(req).await.map_err(err)
    }
    async fn triage(&self, req: TriageRequest) -> Result<(), CommandError> {
        self.core.triage(req).await.map_err(err)
    }
    async fn set_linear_token(
        &self,
        req: SetLinearTokenRequest,
    ) -> Result<LinearStatus, CommandError> {
        self.core.set_linear_token(req).await.map_err(err)
    }
    async fn linear_status(&self) -> Result<LinearStatus, CommandError> {
        self.core.linear_status().await.map_err(err)
    }
    async fn linear_issues(
        &self,
        req: LinearIssuesRequest,
    ) -> Result<Vec<LinearIssue>, CommandError> {
        self.core.linear_issues(req).await.map_err(err)
    }
    async fn find_symbol(&self, req: FindSymbolRequest) -> Result<Vec<SymbolHit>, CommandError> {
        self.core.find_symbol(req).await.map_err(err)
    }
    async fn get_blob(&self, req: GetBlobRequest) -> Result<BlobResponse, CommandError> {
        self.core.get_blob(req).await.map_err(err)
    }
    async fn conflicts(&self, pr: PrId) -> Result<Vec<ConflictFile>, CommandError> {
        self.core.conflicts(pr).await.map_err(err)
    }
    async fn project_working_state(
        &self,
        project: String,
    ) -> Result<theodore_contract::ProjectWorkingState, CommandError> {
        self.core.project_working_state(&project).await.map_err(err)
    }
    async fn update_channel(&self) -> String {
        self.core.setting_string("updates.channel", "stable").await
    }
    async fn is_idle(&self) -> bool {
        self.core.is_idle().await
    }
    async fn updates_enabled(&self) -> bool {
        self.sandbox.is_none()
    }
    async fn sandbox_status(
        &self,
    ) -> Result<Option<theodore_contract::SandboxStatus>, CommandError> {
        match self.sandbox.clone() {
            Some(sb) => sandbox_call(sb, |s| Ok(s.status())).await.map(Some),
            None => Ok(None),
        }
    }
    async fn sandbox_set_fault(
        &self,
        req: theodore_contract::SandboxFaultRequest,
    ) -> Result<theodore_contract::SandboxStatus, CommandError> {
        sandbox_call(self.sandbox()?, move |s| {
            s.set_fault(&req.name, req.on, None)
        })
        .await
    }
    async fn sandbox_fire_event(
        &self,
        id: String,
    ) -> Result<theodore_contract::SandboxStatus, CommandError> {
        sandbox_call(self.sandbox()?, move |s| {
            s.fire(&id)?;
            Ok(s.status())
        })
        .await
    }
}
