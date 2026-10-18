//! `CoreApi` over the real core (`theodore-app`).

use async_trait::async_trait;
use theodore_app::{AppError, Core};
use theodore_contract::{
    AgentStatus, AppInfo, AskRequest, Bootstrap, BootstrapScope, CommandError, DelegateRequest,
    FileRequest, HostAuthStatus, OpenPrRequest, OpenPrResponse, ReplyRequest, ResolveRequest,
    RevisionRequest, RunSkillRequest, SetTokenRequest, SkillInfo, SubmitReviewRequest, SyncFrame,
    TaskDecision, Transaction, TransactionResult, UpdateInfo,
};
use theodore_domain::{Person, PrId, Revision};

use crate::core_api::CoreApi;

pub struct AppCore {
    core: Core,
}

impl AppCore {
    pub fn new(core: Core) -> Self {
        Self { core }
    }
}

fn err(e: AppError) -> CommandError {
    let code = match &e {
        AppError::Store(_) => "store",
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
    async fn update_channel(&self) -> String {
        self.core.setting_string("updates.channel", "stable").await
    }
    async fn is_idle(&self) -> bool {
        self.core.is_idle().await
    }
}
