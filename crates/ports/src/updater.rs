//! The app's updater, as a space's agent sees it (docs/releasing.md
//! "Graceful update"): the running version and where an update stands,
//! and the one action, "update now". Implemented by the desktop shell over
//! Tauri's updater; `NoUpdater` where there is none (the CLI, tests).
//!
//! ```text
//! theodore_version ─▶ version · channel · commit · state
//! theodore_update ──▶ ready ─────▶ pause the turns, restart into the update
//!                     available ─▶ download starts; ask again once it's ready
//!                     up to date ▶ says so (a check runs first)
//! ```

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// Where the updater stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum UpdaterState {
    /// Never checked yet in this process.
    Unknown,
    /// The last check found nothing newer.
    UpToDate,
    /// A newer version is published and not downloaded yet.
    Available { version: String },
    /// Downloading `version`; `percent` when the size is known.
    Downloading {
        version: String,
        percent: Option<u8>,
    },
    /// `version` is installed on disk; a restart runs it.
    Ready { version: String },
    /// This build doesn't update itself (a nightly, the sandbox), or the
    /// last check failed: why.
    Unavailable { reason: String },
}

/// `theodore_version`: the running build and the updater's state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TheodoreVersion {
    pub version: String,
    /// `stable` · `beta` · `staging`.
    pub channel: String,
    /// The build's commit.
    pub commit: String,
    /// `production` · `staging` · `nightly` · `dev`.
    pub build_env: String,
    pub updater: UpdaterState,
}

/// `theodore_update`: what it started.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum UpdateStart {
    /// The update is on disk: Theodore pauses every running turn and
    /// restarts into `version`; the paused turns resume after it.
    Restarting { version: String },
    /// The download of `version` is running (or was started now).
    Downloading { version: String },
    /// A check ran and found nothing newer.
    UpToDate,
    /// Nothing can be done: why.
    Unavailable { reason: String },
}

/// The shell's updater, for the agent tools.
#[async_trait]
pub trait UpdaterPort: Send + Sync {
    async fn version(&self) -> TheodoreVersion;
    /// Acts on the updater's state (see [`UpdateStart`]). A restart it
    /// starts happens after this returns, so the caller hears the answer.
    async fn update(&self) -> UpdateStart;
}

/// No updater here (the CLI, fixtures, tests).
pub struct NoUpdater;

pub const NO_UPDATER: &str = "this build has no updater";

#[async_trait]
impl UpdaterPort for NoUpdater {
    async fn version(&self) -> TheodoreVersion {
        TheodoreVersion {
            version: env!("CARGO_PKG_VERSION").into(),
            channel: String::new(),
            commit: String::new(),
            build_env: String::new(),
            updater: UpdaterState::Unavailable {
                reason: NO_UPDATER.into(),
            },
        }
    }

    async fn update(&self) -> UpdateStart {
        UpdateStart::Unavailable {
            reason: NO_UPDATER.into(),
        }
    }
}
