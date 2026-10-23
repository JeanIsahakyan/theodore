//! Project config (docs/config.md): one YAML file in three layers, and a
//! space's commands (`setup`, `run`, `check`, `archive`) with their trust
//! prompt, logs and results.

use serde::{Deserialize, Serialize};
use specta::Type;
use theodore_domain::Millis;

/// Which file a config value came from. Later layers win, key by key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ConfigLayer {
    /// `~/.theodore/config.yaml`.
    Global,
    /// `<repo>/.theodore/config.yaml` (or the legacy `.review/config.yaml`):
    /// shared with the team, so its commands need your approval.
    Repo,
    /// `<repo>/.theodore/config.local.yaml`: personal, gitignored.
    Local,
}

/// One of the files behind a project's config.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct ConfigFile {
    pub layer: ConfigLayer,
    pub path: String,
    pub exists: bool,
    /// The deprecated `.review/config.yaml`, read because
    /// `.theodore/config.yaml` is absent.
    pub legacy: bool,
    /// Why the file was ignored (unreadable or invalid YAML).
    pub error: Option<String>,
}

/// One effective value and where it came from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct ConfigEntry {
    /// Dotted path: `spaces.run`, `spaces.env.API_URL`, `review.agents.chat`.
    pub key: String,
    /// Strings as they are, anything else as JSON.
    pub value: String,
    pub layer: ConfigLayer,
}

/// The repo layer's commands (and env, which can change what a command
/// runs) that are in effect: what "Run commands from this repo?" shows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct RepoCommands {
    /// sha256 of `items`; approval is stored per project against it.
    pub hash: String,
    /// You allowed exactly this set for this project.
    pub trusted: bool,
    pub items: Vec<ConfigEntry>,
}

/// A project's merged config, read-only (Settings → Labs).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct EffectiveConfig {
    pub files: Vec<ConfigFile>,
    pub entries: Vec<ConfigEntry>,
    /// Keys no Theodore version knows (typos, or a newer file).
    pub unknown: Vec<String>,
    /// `None` when the repo layer provides no command.
    pub repo_commands: Option<RepoCommands>,
}

/// `~/.theodore/config.yaml`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct GlobalConfigInfo {
    pub path: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SpaceCommandKind {
    Setup,
    Run,
    Check,
    Archive,
}

/// A space command as configured.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct ConfiguredCommand {
    pub kind: SpaceCommandKind,
    pub script: String,
    pub layer: ConfigLayer,
    /// `false`: from the repo and not approved, so it is skipped.
    pub allowed: bool,
}

/// What a space will run (`space_config`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SpaceConfigView {
    pub commands: Vec<ConfiguredCommand>,
    /// `$THEODORE_PORT`, `$THEODORE_PORT_1`, …
    pub ports: Vec<u16>,
    pub repo_commands: Option<RepoCommands>,
    /// "Not now" was chosen for this space: repo commands are skipped.
    pub denied: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SetupStatus {
    /// Waiting for "Run commands from this repo?".
    Waiting,
    Running,
    Done,
    Failed,
    /// Nothing ran: no setup, not allowed, or "continue without setup".
    Skipped,
}

/// The "Setting up…" stage after create, before the first turn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SpaceSetup {
    pub status: SetupStatus,
    /// The goal is sent as the first turn once setup ends.
    pub goal_pending: bool,
    #[serde(default)]
    pub error: Option<String>,
    /// Files not copied, commands skipped, …
    #[serde(default)]
    pub notes: Vec<String>,
    #[serde(default)]
    pub finished_at: Option<Millis>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ProcessStatus {
    Running,
    /// Ended by itself.
    Exited,
    /// Stopped from the UI, by archive, or because Theodore closed.
    Stopped,
    /// Could not start.
    Failed,
}

/// The space's long-running `run` command.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SpaceProcess {
    pub status: ProcessStatus,
    pub started_at: Millis,
    #[serde(default)]
    pub ended_at: Option<Millis>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Running,
    Passed,
    Failed,
}

/// `check` after a turn that changed files.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SpaceCheck {
    pub status: CheckStatus,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub timed_out: bool,
    /// The last lines of output.
    #[serde(default)]
    pub output: Vec<String>,
    pub started_at: Millis,
    #[serde(default)]
    pub finished_at: Option<Millis>,
}

/// One line of a space command's output (`space_logs`, `Ephemeral::SpaceLog`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SpaceLogLine {
    pub kind: SpaceCommandKind,
    pub line: String,
    pub stderr: bool,
    pub at: Millis,
}

/// "Run commands from this repo?" for a space's project.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SpaceTrustRequest {
    pub space: String,
    /// Allow (stored for the project) or Not now (this space only).
    pub allow: bool,
    /// `RepoCommands::hash` the user saw; refused if the commands changed.
    pub hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SetupAction {
    Retry,
    /// Continue without setup: the first turn starts.
    Skip,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SpaceSetupRequest {
    pub space: String,
    pub action: SetupAction,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SpaceRunRequest {
    pub space: String,
    /// Start (`true`) or stop the `run` command.
    pub start: bool,
}
