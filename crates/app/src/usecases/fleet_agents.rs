//! Fleet, the agents this device runs for others (docs/fleet.md "Agent,
//! model and effort"): what it lists in `DeviceInfo::agents`, and the check
//! a remote start or send's picks must pass.
//!
//! ```text
//! detect + models (cached CATALOG_TTL_MS: detecting spawns the CLIs)
//!   ─▶ installed ∩ agents.<id>.enabled ∩ not signed out ─▶ agents.chat first
//!   ─▶ per agent: models (current, then earlier), default model / effort
//!      from agents.<id>.model / .effort   ─▶ DeviceInfo.agents (fit_agents)
//! start / send naming agent, model or effort ─▶ each one listed here?
//!   no ─▶ fleet.agent_unavailable          yes ─▶ runs as a local pick
//!   (signed out: says so, and how to sign in)
//! a setting under agents.* changes ─▶ announce again
//! a sign-in changes (detect_agents, a run failed signed out, the
//!   CATALOG_TTL_MS re-check while linked) ─▶ announce again
//! ```

use theodore_contract::{AgentModel, FleetAgent};
use theodore_domain::AgentId;
use theodore_fleet_protocol::{FleetAgentInfo, FleetModelInfo, codes};
use theodore_ports::agent::{AgentInfo, ModelInfo};

use crate::core::Core;
use crate::usecases::fleet_host::Refusal;

/// How long a detected catalog is reused.
pub(crate) const CATALOG_TTL_MS: i64 = 10 * 60 * 1000;

/// Claude Code's multi-agent effort, past its levels: spaces only
/// (`spaces.rs`), offered wherever a Claude model takes an effort.
const ULTRACODE: &str = "ultracode";

/// One installed agent as last detected: its sign-in and its models.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CatalogAgent {
    pub id: AgentId,
    /// `Some(false)`: known signed out, so not offered.
    pub signed_in: Option<bool>,
    pub models: Vec<ModelInfo>,
}

/// Installed agents, as last detected.
pub(crate) type Catalog = Vec<CatalogAgent>;

/// What this device offers others: the agents it lists, and the enabled
/// ones it leaves out because they aren't signed in (a pick naming one is
/// told so).
#[derive(Debug, Clone, Default)]
pub(crate) struct Offer {
    pub agents: Vec<FleetAgentInfo>,
    pub signed_out: Vec<AgentId>,
}

/// The refusal of a pick naming `id`, signed out on this device.
fn signed_out_refusal(id: AgentId) -> Refusal {
    let fix = theodore_ports::sign_in_fix(id.as_str()).unwrap_or_default();
    (
        codes::AGENT_UNAVAILABLE,
        format!("{} isn't signed in on this device. {fix}", agent_label(id))
            .trim_end()
            .to_string(),
    )
}

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
pub(crate) fn takes(agent: AgentId, efforts: &[String], effort: &str) -> bool {
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

/// What a space here asks another device to start a space on, its own
/// agent, model and effort, as far as `agents` (what that device lists)
/// takes them: all three, else the agent and model, else the agent, else
/// nothing (that device's defaults, made concrete there).
pub(crate) fn inherited_pick(
    agents: &[FleetAgentInfo],
    agent: AgentId,
    model: Option<&str>,
    effort: Option<&str>,
) -> (Option<AgentId>, Option<String>, Option<String>) {
    let offer = Offer {
        agents: agents.to_vec(),
        signed_out: Vec::new(),
    };
    let id = Some(agent.as_str());
    [(model, effort), (model, None), (None, None)]
        .into_iter()
        .find(|(m, e)| check_pick(&offer, id, *m, *e, None, None).is_ok())
        .map_or((None, None, None), |(m, e)| {
            (Some(agent), m.map(str::to_string), e.map(str::to_string))
        })
}

/// What a request picked, checked against `agents` (what this device
/// lists): `agent` and `model` must be listed; `effort` must be one of the
/// model in effect's levels (`model`, else `current` — the space's own
/// when its agent stays — else the agent's default), or of any of its
/// models when that one isn't listed. `in_effect`: the agent the picks
/// apply to when none is named (the space's, or the default).
pub(crate) fn check_pick(
    offer: &Offer,
    agent: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    in_effect: Option<AgentId>,
    current_model: Option<&str>,
) -> Result<(), Refusal> {
    let unavailable = |m: String| -> Refusal { (codes::AGENT_UNAVAILABLE, m) };
    let agents = &offer.agents;
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
        if let Some(out) = offer.signed_out.iter().find(|a| a.as_str() == id) {
            return Err(signed_out_refusal(*out));
        }
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
        let out = self.fleet_detect_catalog().await;
        self.fleet().agent_catalog = Some((now, out.clone()));
        out
    }

    /// Detects the installed agents and lists their models now.
    async fn fleet_detect_catalog(&self) -> Catalog {
        let agents = &self.0.deps.agents;
        let mut out = Vec::new();
        for a in agents.detect().await {
            if a.installed {
                out.push(CatalogAgent {
                    id: a.id,
                    signed_in: a.signed_in,
                    models: agents.models(a.id).await,
                });
            }
        }
        out
    }

    /// What this device lists in `DeviceInfo::agents`: installed, enabled
    /// and not signed out, `agents.chat` first.
    pub(crate) async fn fleet_agents(&self) -> Vec<FleetAgentInfo> {
        self.fleet_offer().await.agents
    }

    /// [`fleet_agents`](Self::fleet_agents), and the enabled agents left
    /// out for being signed out.
    pub(crate) async fn fleet_offer(&self) -> Offer {
        let catalog = self.fleet_agent_catalog().await;
        let store = &self.0.deps.store;
        let mut offer = Offer::default();
        for a in catalog {
            if !self.agent_enabled(a.id).await {
                continue;
            }
            if a.signed_in == Some(false) {
                offer.signed_out.push(a.id);
                continue;
            }
            let set_model = crate::agent_defaults::run_model(store, a.id, None).await;
            let set_effort = crate::agent_defaults::run_effort(store, a.id, None).await;
            offer
                .agents
                .push(agent_info(a.id, &a.models, set_model, set_effort));
        }
        let first = self
            .setting_agent_scoped("agents.chat", None, AgentId::Claude)
            .await;
        offer.agents.sort_by_key(|a| a.id != first.as_str());
        offer
    }

    /// A fresh detection's sign-ins against the catalog's: a change is
    /// announced (an agent signed in or out, one installed or removed).
    pub(crate) async fn fleet_note_detected(&self, detected: &[AgentInfo]) {
        let changed = {
            let mut mem = self.fleet();
            let Some((_, catalog)) = &mut mem.agent_catalog else {
                return;
            };
            let installed: Vec<AgentId> = detected
                .iter()
                .filter(|a| a.installed)
                .map(|a| a.id)
                .collect();
            if !catalog.iter().map(|c| c.id).eq(installed.iter().copied()) {
                // The models of a new one aren't known: detected again.
                mem.agent_catalog = None;
                true
            } else {
                let mut changed = false;
                for c in catalog.iter_mut() {
                    let now = detected
                        .iter()
                        .find(|d| d.id == c.id)
                        .and_then(|d| d.signed_in);
                    if now != c.signed_in {
                        c.signed_in = now;
                        changed = true;
                    }
                }
                changed
            }
        };
        if changed {
            self.fleet_announce().await;
        }
    }

    /// A run of `agent` failed signed out: no longer offered, announced.
    pub(crate) async fn fleet_agent_signed_out(&self, agent: AgentId) {
        let changed = {
            let mut mem = self.fleet();
            match mem
                .agent_catalog
                .as_mut()
                .and_then(|(_, c)| c.iter_mut().find(|c| c.id == agent))
            {
                Some(c) if c.signed_in != Some(false) => {
                    c.signed_in = Some(false);
                    true
                }
                _ => false,
            }
        };
        if changed {
            self.fleet_announce().await;
        }
    }

    /// While linked, every [`CATALOG_TTL_MS`]: sign-ins checked again and
    /// the catalog rebuilt, announced when it changed (`codex login` in a
    /// terminal reaches the other devices without a click here).
    pub(crate) async fn fleet_recheck_agents(&self) {
        self.0.deps.agents.recheck_sign_in().await;
        let fresh = self.fleet_detect_catalog().await;
        let now = self.0.deps.clock.now();
        let before = self.fleet().agent_catalog.replace((now, fresh.clone()));
        if before.is_some_and(|(_, c)| c != fresh) {
            self.fleet_announce().await;
        }
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
        let offer = Offer {
            agents: vec![claude()],
            signed_out: vec![],
        };
        let check = |agent, model, effort, current| {
            check_pick(&offer, agent, model, effort, Some(AgentId::Claude), current)
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

    #[test]
    fn a_signed_out_agent_is_refused_saying_so() {
        let offer = Offer {
            agents: vec![claude()],
            signed_out: vec![AgentId::Codex],
        };
        let (code, message) =
            check_pick(&offer, Some("codex"), None, None, None, None).unwrap_err();
        assert_eq!(code, codes::AGENT_UNAVAILABLE);
        assert_eq!(
            message,
            "Codex isn't signed in on this device. Run `codex login` in a terminal."
        );
        let (_, gemini) = check_pick(&offer, Some("gemini"), None, None, None, None).unwrap_err();
        assert!(gemini.contains("isn't installed"), "{gemini}");
    }
}
