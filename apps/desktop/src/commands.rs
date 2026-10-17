//! Tauri commands (`.context/commands.md`). Each is a thin wrapper around
//! `State<Arc<dyn CoreApi>>`; argument names match the contract exactly so
//! the generated TS bindings line up with `ui/src/core/transport.ts`.

use std::sync::Arc;

use tauri::{AppHandle, State};
use theodore_contract::{
    AgentStatus, AppInfo, AskRequest, Bootstrap, BootstrapScope, CommandError, FileRequest,
    OpenPrRequest, OpenPrResponse, RevisionRequest, RunSkillRequest, SubmitReviewRequest,
    SyncFrame, Transaction, TransactionResult, UpdateInfo,
};
use theodore_domain::{PrId, Revision};

use crate::core_api::CoreApi;
use crate::updater;

#[tauri::command]
#[specta::specta]
pub async fn bootstrap(
    scope: BootstrapScope,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<Bootstrap, CommandError> {
    core.bootstrap(scope).await
}

#[tauri::command]
#[specta::specta]
pub async fn catch_up(
    since: u64,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<SyncFrame, CommandError> {
    core.catch_up(since).await
}

#[tauri::command]
#[specta::specta]
pub async fn transact(
    tx: Transaction,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<TransactionResult, CommandError> {
    core.transact(tx).await
}

#[tauri::command]
#[specta::specta]
pub async fn open_pr(
    req: OpenPrRequest,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<OpenPrResponse, CommandError> {
    core.open_pr(req).await
}

#[tauri::command]
#[specta::specta]
pub async fn get_revision(
    req: RevisionRequest,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<Revision, CommandError> {
    core.get_revision(req).await
}

#[tauri::command]
#[specta::specta]
pub async fn get_file(
    req: FileRequest,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<Option<String>, CommandError> {
    core.get_file(req).await
}

#[tauri::command]
#[specta::specta]
pub async fn regroup(pr: PrId, core: State<'_, Arc<dyn CoreApi>>) -> Result<(), CommandError> {
    core.regroup(pr).await
}

#[tauri::command]
#[specta::specta]
pub async fn run_skill(
    req: RunSkillRequest,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<String, CommandError> {
    core.run_skill(req).await
}

#[tauri::command]
#[specta::specta]
pub async fn ask(
    req: AskRequest,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<String, CommandError> {
    core.ask(req).await
}

#[tauri::command]
#[specta::specta]
pub async fn cancel_run(
    run: String,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<(), CommandError> {
    core.cancel_run(run).await
}

#[tauri::command]
#[specta::specta]
pub async fn submit_review(
    req: SubmitReviewRequest,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<(), CommandError> {
    core.submit_review(req).await
}

#[tauri::command]
#[specta::specta]
pub async fn detect_agents(
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<Vec<AgentStatus>, CommandError> {
    core.detect_agents().await
}

/// The core doesn't know about updates the shell already downloaded in the
/// background, so this fills `AppInfo.update` from `UpdateState` itself
/// rather than trusting whatever `core.app_info()` returns there.
#[tauri::command]
#[specta::specta]
pub async fn app_info(
    core: State<'_, Arc<dyn CoreApi>>,
    update_state: State<'_, updater::UpdateState>,
) -> Result<AppInfo, CommandError> {
    let mut info = core.app_info().await?;
    if let Some(update) = update_state.get() {
        info.update = Some(update);
    }
    Ok(info)
}

/// Runs an immediate update check (download + install on disk; no restart).
/// Used for the launch check, the 6 h poll and Settings → About "Check now".
#[tauri::command]
#[specta::specta]
pub async fn check_update(
    app: AppHandle,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<Option<UpdateInfo>, CommandError> {
    let core: Arc<dyn CoreApi> = core.inner().clone();
    Ok(updater::check_and_install(&app, &core).await)
}

/// Restarts into the already-downloaded update, but only once the core is
/// idle (no agent running, outbox empty) — never forced.
#[tauri::command]
#[specta::specta]
pub async fn install_update(
    app: AppHandle,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<(), CommandError> {
    if core.is_idle().await {
        app.request_restart();
    }
    Ok(())
}
