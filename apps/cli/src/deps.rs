//! Real adapters, wired in one place. Git, GitHub and the agent CLIs are
//! built by other slices in parallel; everything else in this crate is
//! tested against `--diff-file` plus a fake or real `AgentPort` passed in
//! directly, never through here.

use std::sync::Arc;

use theodore_domain::AgentId;
use theodore_ports::{AgentPort, GitPort, HostAdapter};

/// The adapters a real (non-`--diff-file`, non-test) run needs.
pub struct Deps {
    pub git: Arc<dyn GitPort>,
    pub host: Arc<dyn HostAdapter>,
    pub agent: Arc<dyn AgentPort>,
}

/// Build the real `Deps` for `agent`. Not callable yet: `git`, `host-github`
/// and `agents` are placeholders until their slices land (docs/plan.md).
/// Wire this up by constructing each adapter and its `Arc`, once those
/// crates export something to construct.
pub fn real_deps(_agent: AgentId) -> Deps {
    todo!("integration: wire real git / GitHub / agent-CLI adapters once those slices land")
}
