//! Tauri commands (`.context/commands.md`). Each is a thin wrapper around
//! `State<Arc<dyn CoreApi>>`; argument names match the contract exactly so
//! the generated TS bindings line up with `ui/src/core/transport.ts`.

use std::sync::Arc;

use tauri::{AppHandle, State};
use theodore_contract::{
    AddProjectRequest, AgentStatus, AppInfo, AskRequest, Bootstrap, BootstrapScope, CommandError,
    CommitSuggestionsRequest, DelegateRequest, DraftStateRequest, EditCommentRequest, FileRequest,
    HostAuthStatus, InterdiffEntry, InterdiffRequest, LocalBranch, MergeInfo, MergeRequest,
    OpenBranchRequest, OpenPrRequest, OpenPrResponse, PrSpend, Project, ReactRequest, ReplyRequest,
    ResolveRequest, ReviewersRequest, RevisionRequest, RunSkillRequest, SaveSkillRequest,
    SetTokenRequest, SkillBody, SkillInfo, SubmitReviewRequest, SyncFrame, TaskDecision,
    Transaction, TransactionResult, UpdateInfo,
};
use theodore_domain::{Person, PrId, RepoRef, Revision};

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

#[tauri::command]
#[specta::specta]
pub async fn refresh_inbox(core: State<'_, Arc<dyn CoreApi>>) -> Result<(), CommandError> {
    core.refresh_inbox().await
}

#[tauri::command]
#[specta::specta]
pub async fn viewer(core: State<'_, Arc<dyn CoreApi>>) -> Result<Person, CommandError> {
    core.viewer().await
}

#[tauri::command]
#[specta::specta]
pub async fn host_status(
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<HostAuthStatus, CommandError> {
    core.host_status().await
}

#[tauri::command]
#[specta::specta]
pub async fn set_host_token(
    req: SetTokenRequest,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<HostAuthStatus, CommandError> {
    core.set_host_token(req).await
}

#[tauri::command]
#[specta::specta]
pub async fn reply_thread(
    req: ReplyRequest,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<(), CommandError> {
    core.reply_thread(req).await
}

#[tauri::command]
#[specta::specta]
pub async fn resolve_thread(
    req: ResolveRequest,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<(), CommandError> {
    core.resolve_thread(req).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_skills(
    pr: Option<PrId>,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<Vec<SkillInfo>, CommandError> {
    core.list_skills(pr).await
}

#[tauri::command]
#[specta::specta]
pub async fn delegate_task(
    req: DelegateRequest,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<String, CommandError> {
    core.delegate_task(req).await
}

#[tauri::command]
#[specta::specta]
pub async fn decide_task(
    req: TaskDecision,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<(), CommandError> {
    core.decide_task(req).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_host_repos(
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<Vec<RepoRef>, CommandError> {
    core.list_host_repos().await
}

#[tauri::command]
#[specta::specta]
pub async fn add_project(
    req: AddProjectRequest,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<Project, CommandError> {
    core.add_project(req).await
}

#[tauri::command]
#[specta::specta]
pub async fn remove_project(
    id: String,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<(), CommandError> {
    core.remove_project(id).await
}

#[tauri::command]
#[specta::specta]
pub async fn refresh_project(
    id: String,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<(), CommandError> {
    core.refresh_project(id).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_branches(
    project: String,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<Vec<LocalBranch>, CommandError> {
    core.list_branches(project).await
}

#[tauri::command]
#[specta::specta]
pub async fn open_branch(
    req: OpenBranchRequest,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<OpenPrResponse, CommandError> {
    core.open_branch(req).await
}

#[tauri::command]
#[specta::specta]
pub async fn merge_info(
    pr: PrId,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<MergeInfo, CommandError> {
    core.merge_info(pr).await
}

#[tauri::command]
#[specta::specta]
pub async fn merge_pr(
    req: MergeRequest,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<(), CommandError> {
    core.merge_pr(req).await
}

#[tauri::command]
#[specta::specta]
pub async fn assignable_users(
    pr: PrId,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<Vec<Person>, CommandError> {
    core.assignable_users(pr).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_reviewers(
    req: ReviewersRequest,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<(), CommandError> {
    core.set_reviewers(req).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_draft(
    req: DraftStateRequest,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<(), CommandError> {
    core.set_draft(req).await
}

#[tauri::command]
#[specta::specta]
pub async fn update_branch(
    pr: PrId,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<(), CommandError> {
    core.update_branch(pr).await
}

#[tauri::command]
#[specta::specta]
pub async fn react(
    req: ReactRequest,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<(), CommandError> {
    core.react(req).await
}

#[tauri::command]
#[specta::specta]
pub async fn edit_comment(
    req: EditCommentRequest,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<(), CommandError> {
    core.edit_comment(req).await
}

#[tauri::command]
#[specta::specta]
pub async fn commit_suggestions(
    req: CommitSuggestionsRequest,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<(), CommandError> {
    core.commit_suggestions(req).await
}

#[tauri::command]
#[specta::specta]
pub async fn get_skill(
    id: String,
    pr: Option<PrId>,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<SkillBody, CommandError> {
    core.get_skill(id, pr).await
}

#[tauri::command]
#[specta::specta]
pub async fn save_skill(
    req: SaveSkillRequest,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<SkillInfo, CommandError> {
    core.save_skill(req).await
}

#[tauri::command]
#[specta::specta]
pub async fn pr_spend(
    pr: PrId,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<PrSpend, CommandError> {
    core.pr_spend(pr).await
}

#[tauri::command]
#[specta::specta]
pub async fn interdiff(
    req: InterdiffRequest,
    core: State<'_, Arc<dyn CoreApi>>,
) -> Result<Vec<InterdiffEntry>, CommandError> {
    core.interdiff(req).await
}

/// Native folder picker for the Add project dialog. Runs on a background
/// thread: the dialog plugin's blocking call would otherwise stall the
/// async runtime until the user picks a folder or cancels.
#[tauri::command]
#[specta::specta]
pub async fn pick_folder(app: AppHandle) -> Result<Option<String>, CommandError> {
    use tauri_plugin_dialog::DialogExt;
    tokio::task::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
        .await
        .map(|picked| picked.map(|p| p.to_string()))
        .map_err(|e| CommandError {
            code: "internal".into(),
            message: e.to_string(),
        })
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
