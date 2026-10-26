//! Per-agent CLI configuration: binary override, extra args, default model.

use std::collections::HashMap;
use std::path::PathBuf;

use theodore_domain::AgentId;

/// One agent's local settings (plan §8.5: `agents.<id>.path`, `.model`).
#[derive(Debug, Clone, Default)]
pub struct AgentBinaryConfig {
    /// Explicit binary path. Skips PATH / common-dir detection when set.
    pub path: Option<PathBuf>,
    /// Appended after the flags this crate builds, before the prompt.
    pub extra_args: Vec<String>,
    /// Default model id, overridden per-request by `AgentRequest::model`.
    pub model: Option<String>,
}

/// Binary configs for all three agents, keyed by `AgentId`.
#[derive(Debug, Clone, Default)]
pub struct AgentCliConfig {
    configs: HashMap<AgentId, AgentBinaryConfig>,
}

impl AgentCliConfig {
    pub fn get(&self, id: AgentId) -> AgentBinaryConfig {
        self.configs.get(&id).cloned().unwrap_or_default()
    }

    pub fn set(&mut self, id: AgentId, cfg: AgentBinaryConfig) {
        self.configs.insert(id, cfg);
    }
}

/// Binary name each CLI installs under, before any override or PATH search.
pub fn default_binary_name(id: AgentId) -> &'static str {
    match id {
        AgentId::Claude => "claude",
        AgentId::Codex => "codex",
        AgentId::Gemini => "gemini",
    }
}

/// Common install dirs checked after `PATH`, in order (plan §8.1).
pub fn common_install_dirs() -> Vec<PathBuf> {
    let home = dirs::home_dir();
    let mut dirs = Vec::new();
    if let Some(home) = &home {
        dirs.push(home.join(".local/bin"));
    }
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    if let Some(home) = &home {
        dirs.push(home.join(".npm-global/bin"));
    }
    dirs
}
