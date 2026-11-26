//! The agent, model and effort a space started by another space runs on
//! (docs/spaces.md "Sub-spaces"): a sub-space, a space started for another
//! device, and the pick a `fleet_start_space` sends. Never "the default":
//! the model is a concrete id from the start.
//!
//! ```text
//! agent   asked ──▶ else the parent's ──▶ else agents.chat (the project's)
//! model   asked (checked against the agent's models, an alias made concrete)
//!           ──▶ else the parent's, when the agent is the parent's
//!           ──▶ else agents.<id>.model ──▶ else its first current model
//! effort  asked ──▶ else the parent's, when the agent is the parent's and
//!           the model takes it ──▶ else agents.<id>.effort when the model
//!           takes it ──▶ else the model's own
//! ```
//!
//! An agent that lists no models (Gemini) can't be checked or made
//! concrete: its model stays what was asked or set, else none.

use theodore_contract::Space;
use theodore_domain::AgentId;
use theodore_ports::agent::ModelInfo;

use crate::core::Core;
use crate::usecases::fleet_agents::{agent_info, takes};

/// What a new space runs on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Pick {
    pub agent: AgentId,
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// The model of `models` that `id` names: itself, else the current one
/// (then an earlier one) an alias names as a whole part of its id
/// (`opus` ─▶ `claude-opus-5-5`).
fn listed<'a>(models: &'a [ModelInfo], id: &str) -> Option<&'a ModelInfo> {
    let alias = |m: &&ModelInfo| m.id.split(['-', '.', '_']).any(|p| p == id);
    models.iter().find(|m| m.id == id).or_else(|| {
        models
            .iter()
            .filter(|m| !m.older)
            .find(alias)
            .or_else(|| models.iter().filter(|m| m.older).find(alias))
    })
}

/// Pure: what a space runs on, its `agent` already chosen. `asked_*`: what
/// the start names; `parent`: the parent's model and effort when it runs
/// `agent` too; `models`: `agent`'s, as the model picker lists them;
/// `set_*`: `agents.<id>.model` / `.effort`. `Err`: an asked model the
/// agent doesn't list, with the ids it does.
pub(crate) fn pick(
    agent: AgentId,
    asked_model: Option<&str>,
    asked_effort: Option<&str>,
    parent: Option<(Option<&str>, Option<&str>)>,
    models: &[ModelInfo],
    set_model: Option<String>,
    set_effort: Option<String>,
) -> Result<Pick, String> {
    let concrete = |m: &str| listed(models, m).map_or_else(|| m.to_string(), |l| l.id.clone());
    let model = match asked_model {
        Some(m) if !models.is_empty() => match listed(models, m) {
            Some(l) => Some(l.id.clone()),
            None => {
                let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
                return Err(format!(
                    "{agent} has no model {m:?}; pick one of: {}",
                    ids.join(", "),
                    agent = agent.as_str()
                ));
            }
        },
        Some(m) => Some(m.to_string()),
        None => match parent.and_then(|(m, _)| m) {
            Some(m) => Some(m.to_string()),
            None => agent_info(agent, models, set_model, None)
                .default_model
                .map(|m| concrete(&m)),
        },
    };
    let effort = match asked_effort {
        Some(e) => Some(e.to_string()),
        None => {
            // The model's levels, when it's listed; unknown, any goes.
            let fits = |e: &str| match model.as_deref().and_then(|m| listed(models, m)) {
                Some(l) => takes(agent, &l.efforts, e),
                None => true,
            };
            parent
                .and_then(|(_, e)| e)
                .filter(|e| fits(e))
                .map(str::to_string)
                .or_else(|| agent_info(agent, models, model.clone(), set_effort).default_effort)
        }
    };
    Ok(Pick {
        agent,
        model,
        effort,
    })
}

impl Core {
    /// `agents.chat` for `project` (its repo's, else the user's), or the
    /// agent standing in for it when it's off or signed out.
    pub(crate) async fn chat_agent_for(&self, project: &str) -> AgentId {
        let repo = match self.project_row(project).await {
            Ok(Some(p)) => Some(p.repo.slug()),
            _ => None,
        };
        let configured = self
            .setting_agent_scoped("agents.chat", repo.as_deref(), AgentId::Claude)
            .await;
        self.effective_agent(configured).await
    }

    /// What a space started in `project` by `parent` (if any) runs on,
    /// given what the start names ([`pick`]).
    pub(crate) async fn space_pick(
        &self,
        project: &str,
        parent: Option<&Space>,
        agent: Option<AgentId>,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Result<Pick, String> {
        let agent = match agent.or(parent.map(|p| p.agent)) {
            Some(a) => a,
            None => self.chat_agent_for(project).await,
        };
        let from = parent
            .filter(|p| p.agent == agent)
            .map(|p| (p.model.as_deref(), p.effort.as_deref()));
        let store = &self.0.deps.store;
        let models = self.0.deps.agents.models(agent).await;
        let set_model = crate::agent_defaults::run_model(store, agent, None).await;
        let set_effort = crate::agent_defaults::run_effort(store, agent, None).await;
        pick(agent, model, effort, from, &models, set_model, set_effort)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn m(id: &str, efforts: &[&str], default_effort: Option<&str>, older: bool) -> ModelInfo {
        ModelInfo {
            id: id.into(),
            label: id.into(),
            description: None,
            efforts: efforts.iter().map(|e| e.to_string()).collect(),
            default_effort: default_effort.map(str::to_string),
            older,
        }
    }

    fn claude() -> Vec<ModelInfo> {
        vec![
            m(
                "claude-opus-5-5",
                &["low", "medium", "high"],
                Some("high"),
                false,
            ),
            m("claude-haiku-5-5", &["low", "medium"], Some("low"), false),
            m("claude-opus-4-6", &["low", "max"], None, true),
        ]
    }

    fn p(agent: AgentId, model: Option<&str>, effort: Option<&str>) -> Pick {
        Pick {
            agent,
            model: model.map(str::to_string),
            effort: effort.map(str::to_string),
        }
    }

    #[test]
    fn the_parents_model_and_effort_are_inherited() {
        let got = pick(
            AgentId::Claude,
            None,
            None,
            Some((Some("claude-haiku-5-5"), Some("medium"))),
            &claude(),
            Some("claude-opus-5-5".into()),
            Some("high".into()),
        );
        assert_eq!(
            got,
            Ok(p(AgentId::Claude, Some("claude-haiku-5-5"), Some("medium")))
        );
    }

    #[test]
    fn what_the_start_names_wins_and_an_alias_is_made_concrete() {
        let got = pick(
            AgentId::Claude,
            Some("opus"),
            Some("low"),
            Some((Some("claude-haiku-5-5"), Some("medium"))),
            &claude(),
            None,
            None,
        );
        assert_eq!(
            got,
            Ok(p(AgentId::Claude, Some("claude-opus-5-5"), Some("low")))
        );
        // An earlier version by its id.
        let got = pick(
            AgentId::Claude,
            Some("claude-opus-4-6"),
            None,
            None,
            &claude(),
            None,
            None,
        );
        assert_eq!(got.unwrap().model.as_deref(), Some("claude-opus-4-6"));
    }

    #[test]
    fn a_new_model_keeps_the_parents_effort_only_when_it_takes_it() {
        let got = pick(
            AgentId::Claude,
            Some("claude-haiku-5-5"),
            None,
            Some((Some("claude-opus-5-5"), Some("high"))),
            &claude(),
            None,
            None,
        );
        assert_eq!(
            got,
            Ok(p(AgentId::Claude, Some("claude-haiku-5-5"), Some("low")))
        );
    }

    #[test]
    fn no_parent_model_falls_to_the_setting_then_the_first_current_model() {
        let set = pick(
            AgentId::Claude,
            None,
            None,
            Some((None, None)),
            &claude(),
            Some("haiku".into()),
            None,
        );
        assert_eq!(
            set,
            Ok(p(AgentId::Claude, Some("claude-haiku-5-5"), Some("low")))
        );
        let first = pick(AgentId::Claude, None, None, None, &claude(), None, None);
        assert_eq!(
            first,
            Ok(p(AgentId::Claude, Some("claude-opus-5-5"), Some("high")))
        );
    }

    #[test]
    fn an_unknown_model_is_refused_with_the_valid_ids() {
        let err = pick(
            AgentId::Claude,
            Some("gpt-9"),
            None,
            None,
            &claude(),
            None,
            None,
        )
        .unwrap_err();
        assert!(err.contains("\"gpt-9\""), "{err}");
        assert!(
            err.contains("claude-opus-5-5, claude-haiku-5-5, claude-opus-4-6"),
            "{err}"
        );
        // A part of an id isn't an alias.
        assert!(
            pick(
                AgentId::Claude,
                Some("o"),
                None,
                None,
                &claude(),
                None,
                None
            )
            .is_err()
        );
    }

    #[test]
    fn an_agent_without_a_model_list_keeps_what_was_asked_or_set() {
        let asked = pick(
            AgentId::Gemini,
            Some("gemini-x"),
            None,
            None,
            &[],
            None,
            None,
        );
        assert_eq!(asked, Ok(p(AgentId::Gemini, Some("gemini-x"), None)));
        let set = pick(
            AgentId::Gemini,
            None,
            None,
            None,
            &[],
            Some("g".into()),
            None,
        );
        assert_eq!(set, Ok(p(AgentId::Gemini, Some("g"), None)));
    }
}
