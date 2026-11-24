//! Agent accounts and their usage limits (docs/plan.md "Agent accounts and
//! limits").

use serde::{Deserialize, Serialize};
use specta::Type;
use theodore_domain::{AgentId, AgentLimit, Millis};

/// One account of an agent CLI. Each agent has its default account (the
/// CLI's own config); extra ones live in Theodore's data dir.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct AgentAccount {
    /// `default`, or the extra account's own id.
    pub id: String,
    pub agent: AgentId,
    pub label: String,
    /// Its config directory (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, a Gemini key
    /// file's folder); the CLI's default one for the default account.
    pub config_dir: String,
    /// The CLI's own config: nothing is overridden for its runs.
    pub default: bool,
}

/// The latest usage limit an account reported (`agent_limit` rows, keyed
/// `<agent>:<account>`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct AgentLimitRow {
    pub agent: AgentId,
    pub account: String,
    pub limit: AgentLimit,
    /// When it was reported.
    pub at: Millis,
}

/// One account as Settings → Agents shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct AgentAccountStatus {
    pub account: AgentAccount,
    /// `null`: unknown (not checked yet, the CLI isn't installed, or the
    /// check couldn't tell).
    pub signed_in: Option<bool>,
    /// The terminal command that signs it in (extra accounts).
    pub sign_in_command: Option<String>,
    pub limit: Option<AgentLimitRow>,
    /// Runs of this agent start on it while it isn't limited.
    pub preferred: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct AddAgentAccountRequest {
    pub agent: AgentId,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct AgentAccountRequest {
    /// `AgentAccount::id`; with `agent` for a default account.
    pub id: String,
    pub agent: AgentId,
    /// Check its sign-in again rather than read the cache.
    #[serde(default)]
    pub recheck: bool,
}

/// A small system row in a space's chat (docs/spaces.md "Usage limits").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChatNotice {
    /// `from` hit its limit; the conversation goes on with `to`
    /// ("Claude · personal hit its limit (resets 18:00): continuing on
    /// Claude · work"). `continued`: an automatic message continued it.
    AccountSwitch {
        from: String,
        to: String,
        resets_at: Option<Millis>,
        continued: bool,
    },
    /// `account` hit its limit and nothing else could take over.
    LimitHit {
        account: String,
        resets_at: Option<Millis>,
    },
    /// A message another device queued here was dropped before it ran:
    /// that device's trust, or the mode it may use, changed meanwhile
    /// (docs/fleet.md "Sends queue"). `from`: the device's name as pinned.
    RemoteDropped { from: String, reason: String },
    /// A message sent to a space whose PR had merged continued it first
    /// (docs/spaces.md §7 "Continue after merge"): "Continued on `branch`
    /// from the updated `base`". `pr`: the merged PR, as `#123`.
    Continued {
        pr: String,
        branch: String,
        base: String,
    },
}

/// A space waiting for usage limits to reset (docs/spaces.md "Usage
/// limits"): it continues on its own at `until`, unless cancelled.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SpacePause {
    /// The earliest reset of the accounts that could continue; `null` when
    /// none said: only "Continue now" continues it.
    pub until: Option<Millis>,
    pub agent: AgentId,
    pub since: Millis,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SpacePauseRequest {
    pub space: String,
}
