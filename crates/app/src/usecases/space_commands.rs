//! A space's commands (docs/config.md): `copy` and `ports` on create,
//! `setup` before the first turn, `run` on demand, `check` after a turn,
//! `archive` before the worktree goes; repo-provided ones only once
//! allowed.

use theodore_contract::{
    EffectiveConfig, GlobalConfigInfo, Space, SpaceConfigView, SpaceLogLine, SpaceRunRequest,
    SpaceSetupRequest, SpaceTrustRequest,
};

use crate::core::Core;
use crate::error::{AppError, AppResult};

/// In-memory per space: its commands' last lines and those in flight.
#[derive(Default)]
pub(crate) struct SpaceRuntime {
    pub logs: std::collections::VecDeque<SpaceLogLine>,
}

impl Core {
    /// What the space will run, where each command comes from, and
    /// whether the repo's commands are allowed.
    pub async fn space_config(&self, space: &str) -> AppResult<SpaceConfigView> {
        let _ = space;
        Err(AppError::Invalid("not built yet".into()))
    }

    /// "Run commands from this repo?": Allow (stored for the project
    /// against `hash`) or Not now (skipped in this space).
    pub async fn space_trust(&self, req: SpaceTrustRequest) -> AppResult<Space> {
        let _ = req;
        Err(AppError::Invalid("not built yet".into()))
    }

    /// Retry a failed setup, or continue without it.
    pub async fn space_setup(&self, req: SpaceSetupRequest) -> AppResult<Space> {
        let _ = req;
        Err(AppError::Invalid("not built yet".into()))
    }

    /// Starts or stops the space's `run` command.
    pub async fn space_run(&self, req: SpaceRunRequest) -> AppResult<Space> {
        let _ = req;
        Err(AppError::Invalid("not built yet".into()))
    }

    /// The last lines of every command of the space, oldest first.
    pub async fn space_logs(&self, space: &str) -> AppResult<Vec<SpaceLogLine>> {
        let _ = space;
        Err(AppError::Invalid("not built yet".into()))
    }

    /// A project's merged config with each value's file.
    pub async fn project_config(&self, project: &str) -> AppResult<EffectiveConfig> {
        let _ = project;
        Err(AppError::Invalid("not built yet".into()))
    }

    /// Where `~/.theodore/config.yaml` is, and whether it exists.
    pub async fn global_config(&self) -> AppResult<GlobalConfigInfo> {
        Err(AppError::Invalid("not built yet".into()))
    }

    /// Same, creating the file from a commented template when missing.
    pub async fn ensure_global_config(&self) -> AppResult<GlobalConfigInfo> {
        Err(AppError::Invalid("not built yet".into()))
    }
}
