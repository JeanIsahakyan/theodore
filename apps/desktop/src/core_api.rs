//! `CoreApi`: one async method per command in `.context/commands.md`. Tauri
//! commands (`commands.rs`) delegate to `State<Arc<dyn CoreApi>>`; the real
//! implementation (`theodore-app`) is wired in by the integration slice.

use async_trait::async_trait;
use theodore_contract::{
    AgentStatus, AppInfo, AskRequest, Bootstrap, BootstrapScope, CommandError, FileRequest,
    OpenPrRequest, OpenPrResponse, RevisionRequest, RunSkillRequest, SubmitReviewRequest,
    SyncFrame, Transaction, TransactionResult, UpdateInfo,
};
use theodore_domain::{PrId, Revision};

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

    /// `updates.channel` setting (`"stable"` or `"beta"`), used to pick the
    /// updater endpoint. Not a wire command; the shell calls it directly.
    async fn update_channel(&self) -> String {
        "stable".into()
    }

    /// Gates `install_update`'s restart: no agent running, outbox empty.
    async fn is_idle(&self) -> bool {
        true
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
