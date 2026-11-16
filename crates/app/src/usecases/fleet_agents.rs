//! Fleet, the agents this device runs for others (docs/fleet.md "Agent,
//! model and effort"): what it lists in `DeviceInfo::agents`, and the check
//! a remote start or send's picks must pass.
//!
//! ```text
//! detect + models (cached CATALOG_TTL_MS: detecting spawns the CLIs)
//!   ─▶ installed ∩ agents.<id>.enabled ─▶ agents.chat first
//!   ─▶ per agent: models (current, then earlier), default model / effort
//!      from agents.<id>.model / .effort   ─▶ DeviceInfo.agents (fit_agents)
//! start / send naming agent, model or effort ─▶ each one listed here?
//!   no ─▶ fleet.agent_unavailable          yes ─▶ runs as a local pick
//! a setting under agents.* changes ─▶ announce again
//! ```

use theodore_contract::{AgentModel, FleetAgent};
use theodore_domain::AgentId;
use theodore_fleet_protocol::{FleetAgentInfo, FleetModelInfo, codes};
use theodore_ports::agent::ModelInfo;

use crate::core::Core;
use crate::usecases::fleet_host::Refusal;

/// How long a detected catalog is reused.
pub(crate) const CATALOG_TTL_MS: i64 = 10 * 60 * 1000;

/// Claude Code's multi-agent effort, past its levels: spaces only
/// (`spaces.rs`), offered wherever a Claude model takes an effort.
const ULTRACODE: &str = "ultracode";

/// Installed agents and the models each lists, as last detected.
pub(crate) type Catalog = Vec<(AgentId, Vec<ModelInfo>)>;

fn agent_label(id: AgentId) -> &'static str {
    match id {
        AgentId::Claude => "Claude",
        AgentId::Codex => "Codex",
        AgentId::Gemini => "Gemini",
    }
}

pub(crate) fn agent_of(id: &str) -> Option<AgentId> {
    AgentId::ALL.into_iter().find(|a| a.as_str() == id)
}

/// The listed model `id` names: itself, else the newest of the family an
/// alias names (`opus`), as the model chip reads it.
fn listed<'a>(models: &'a [FleetModelInfo], id: &str) -> Option<&'a FleetModelInfo> {
    models
        .iter()
        .find(|m| m.id == id)
        .or_else(|| models.iter().find(|m| m.id.contains(id)))
}

/// Whether `effort` is one `agent` takes with `efforts` (a model's levels).
fn takes(agent: AgentId, efforts: &[String], effort: &str) -> bool {
    efforts.iter().any(|e| e == effort)
        || (agent == AgentId::Claude && effort == ULTRACODE && !efforts.is_empty())
}

/// One agent as listed: models current first, the default model the
/// setting's (else the first current), the default effort the setting's
/// when that model takes it, else the model's own, else `medium`, else
/// its first level.
pub(crate) fn agent_info(
    id: AgentId,
    models: &[ModelInfo],
    set_model: Option<String>,
    set_effort: Option<String>,
) -> FleetAgentInfo {
    let to_info = |m: &ModelInfo| FleetModelInfo {
        id: m.id.clone(),
        label: m.label.clone(),
        efforts: m.efforts.clone(),
        default_effort: m.default_effort.clone(),
    };
    let list: Vec<FleetModelInfo> = models
        .iter()
        .filter(|m| !m.older)
        .chain(models.iter().filter(|m| m.older))
        .map(to_info)
        .collect();
    let default_model = set_model.or_else(|| {
        models
            .iter()
            .find(|m| !m.older)
            .or(models.first())
            .map(|m| m.id.clone())
    });
    let model = default_model.as_deref().and_then(|d| listed(&list, d));
    let efforts = model.map(|m| m.efforts.as_slice()).unwrap_or_default();
    let default_effort = match set_effort {
        Some(e) if takes(id, efforts, &e) => Some(e),
        _ => model
            .and_then(|m| m.default_effort.clone())
            .filter(|e| efforts.contains(e))
            .or_else(|| efforts.iter().find(|e| *e == "medium").cloned())
            .or_else(|| efforts.first().cloned()),
    };
    FleetAgentInfo {
        id: id.as_str().to_string(),
        label: agent_label(id).to_string(),
        default_model,
        default_effort,
        models: list,
    }
}

/// What a request picked, checked against `agents` (what this device
/// lists): `agent` and `model` must be listed; `effort` must be one of the
/// model in effect's levels (`model`, else `current` — the space's own
/// when its agent stays — else the agent's default), or of any of its
/// models when that one isn't listed. `in_effect`: the agent the picks
/// apply to when none is named (the space's, or the default).
pub(crate) fn check_pick(
    agents: &[FleetAgentInfo],
    agent: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    in_effect: Option<AgentId>,
    current_model: Option<&str>,
) -> Result<(), Refusal> {
    let unavailable = |m: String| -> Refusal { (codes::AGENT_UNAVAILABLE, m) };
    if agent.is_none() && model.is_none() && effort.is_none() {
        return Ok(());
    }
    let id = match agent {
        Some(a) => a.to_string(),
        None => match in_effect {
            Some(a) => a.as_str().to_string(),
            None => {
                return Err(unavailable(
                    "this device lists no agent to pick a model or effort for".into(),
                ));
            }
        },
    };
    let Some(info) = agents.iter().find(|a| a.id == id) else {
        return Err(unavailable(format!(
            "{} isn't installed or is turned off on this device",
            if id.chars().count() <= 32 {
                &id
            } else {
                "that agent"
            }
        )));
    };
    let Some(parsed) = agent_of(&info.id) else {
        return Err(unavailable("an agent this device can't run".into()));
    };
    if let Some(m) = model
        && !info.models.iter().any(|x| x.id == m)
    {
        return Err(unavailable(format!(
            "{} has no such model on this device",
            info.label
        )));
    }
    let Some(e) = effort else {
        return Ok(());
    };
    // A send that keeps the space's agent keeps its model too.
    let same = agent.is_none() || in_effect == Some(parsed);
    let wanted = model
        .or(if same { current_model } else { None })
        .or(info.default_model.as_deref());
    let ok = match wanted.and_then(|w| listed(&info.models, w)) {
        Some(m) => takes(parsed, &m.efforts, e),
        None => info.models.iter().any(|m| takes(parsed, &m.efforts, e)),
    };
    if ok {
        Ok(())
    } else {
        Err(unavailable(format!(
            "{} doesn't take that effort on this device",
            info.label
        )))
    }
}

/// Another device's agents as the UI picks from them: agents this build
/// doesn't know are left out.
pub(crate) fn ui_agents(list: &[FleetAgentInfo]) -> Vec<FleetAgent> {
    list.iter()
        .filter_map(|a| {
            Some(FleetAgent {
                id: agent_of(&a.id)?,
                label: a.label.clone(),
                default_model: a.default_model.clone(),
                default_effort: a.default_effort.clone(),
                models: a
                    .models
                    .iter()
                    .map(|m| AgentModel {
                        id: m.id.clone(),
                        label: m.label.clone(),
                        description: None,
                        efforts: m.efforts.clone(),
                        default_effort: m.default_effort.clone(),
                        older: false,
                    })
                    .collect(),
            })
        })
        .collect()
}

impl Core {
    /// Installed agents and their models, detected at most once per
    /// [`CATALOG_TTL_MS`]: an announce or a request never spawns the CLIs
    /// itself after the first.
    async fn fleet_agent_catalog(&self) -> Catalog {
        let now = self.0.deps.clock.now();
        if let Some((at, c)) = &self.fleet().agent_catalog
            && now - at < CATALOG_TTL_MS
        {
            return c.clone();
        }
        let agents = &self.0.deps.agents;
        let mut out = Vec::new();
        for a in agents.detect().await {
            if a.installed {
                out.push((a.id, agents.models(a.id).await));
            }
        }
        self.fleet().agent_catalog = Some((now, out.clone()));
        out
    }

    /// What this device lists in `DeviceInfo::agents`: installed and
    /// enabled agents, `agents.chat` first.
    pub(crate) async fn fleet_agents(&self) -> Vec<FleetAgentInfo> {
        let catalog = self.fleet_agent_catalog().await;
        let store = &self.0.deps.store;
        let mut out = Vec::new();
        for (id, models) in catalog {
            if !self.agent_enabled(id).await {
                continue;
            }
            let set_model = crate::agent_defaults::run_model(store, id, None).await;
            let set_effort = crate::agent_defaults::run_effort(store, id, None).await;
            out.push(agent_info(id, &models, set_model, set_effort));
        }
        let first = self
            .setting_agent_scoped("agents.chat", None, AgentId::Claude)
            .await;
        out.sort_by_key(|a| a.id != first.as_str());
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str, efforts: &[&str], older: bool) -> ModelInfo {
        ModelInfo {
            id: id.into(),
            label: id.into(),
            description: None,
            efforts: efforts.iter().map(|e| e.to_string()).collect(),
            default_effort: None,
            older,
        }
    }

    fn claude() -> FleetAgentInfo {
        agent_info(
            AgentId::Claude,
            &[
                model("claude-opus-4", &["low", "high"], true),
                model("claude-opus-5", &["low", "medium", "high", "max"], false),
                model("claude-haiku", &[], false),
            ],
            None,
            None,
        )
    }

    #[test]
    fn defaults_follow_the_model_chip() {
        let a = claude();
        assert_eq!(a.default_model.as_deref(), Some("claude-opus-5"));
        assert_eq!(a.default_effort.as_deref(), Some("medium"));
        assert_eq!(a.models.last().unwrap().id, "claude-opus-4");
        // The setting's, when the model takes it; an alias reads as the
        // newest of its family.
        let set = agent_info(
            AgentId::Claude,
            &[model("claude-opus-5", &["low", "max"], false)],
            Some("opus".into()),
            Some("max".into()),
        );
        assert_eq!(
            (set.default_model.as_deref(), set.default_effort.as_deref()),
            (Some("opus"), Some("max"))
        );
        let unknown = agent_info(
            AgentId::Claude,
            &[model("claude-opus-5", &["low", "high"], false)],
            None,
            Some("max".into()),
        );
        assert_eq!(unknown.default_effort.as_deref(), Some("low"));
    }

    #[test]
    fn picks_must_be_listed() {
        let list = [claude()];
        let check = |agent, model, effort, current| {
            check_pick(&list, agent, model, effort, Some(AgentId::Claude), current)
                .map_err(|(code, _)| code)
        };
        assert_eq!(check(None, None, None, None), Ok(()));
        assert_eq!(
            check(Some("claude"), Some("claude-haiku"), None, None),
            Ok(())
        );
        assert_eq!(
            check(Some("codex"), None, None, None),
            Err(codes::AGENT_UNAVAILABLE)
        );
        assert_eq!(
            check(None, Some("gpt"), None, None),
            Err(codes::AGENT_UNAVAILABLE)
        );
        // The effort goes with the model in effect: named, the space's,
        // else the default.
        assert_eq!(check(None, None, Some("max"), None), Ok(()));
        assert_eq!(
            check(None, None, Some("max"), Some("claude-opus-4")),
            Err(codes::AGENT_UNAVAILABLE)
        );
        assert_eq!(
            check(None, Some("claude-haiku"), Some("low"), None),
            Err(codes::AGENT_UNAVAILABLE)
        );
        // Ultracode, past Claude's levels, wherever a model takes one.
        assert_eq!(check(None, None, Some(ULTRACODE), None), Ok(()));
        assert_eq!(
            check(None, Some("claude-haiku"), Some(ULTRACODE), None),
            Err(codes::AGENT_UNAVAILABLE)
        );
        // A model typed in Settings, not listed: any listed level.
        assert_eq!(check(None, None, Some("max"), Some("custom")), Ok(()));
        assert_eq!(
            check(None, None, Some("huge"), Some("custom")),
            Err(codes::AGENT_UNAVAILABLE)
        );
    }
}
