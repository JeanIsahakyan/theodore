//! Settings (plan §8.5): `agents.grouping`, `agents.chat`, `agents.skills`,
//! `agents.fix`, `updates.channel`, `budget.per_pr_usd`, each with a
//! default. Layered scopes: `user` is the baseline, a repo's own
//! `.review/config.yaml` (loaded by `load_repo_settings`) overrides it when
//! present — keeping it simple, the repo value always wins over `user`.

use std::path::Path;

use theodore_contract::{Ephemeral, Setting, ToastLevel, models};
use theodore_domain::{AgentId, PrId, RepoRef};
use theodore_ports::NewAction;

use crate::core::Core;
use crate::error::AppResult;

pub const SCOPE_USER: &str = "user";

/// Relative to a PR/project worktree (plan §8.5).
const REPO_CONFIG_PATH: &str = ".review/config.yaml";

pub fn defaults() -> Vec<Setting> {
    vec![
        Setting {
            key: "agents.grouping".into(),
            scope: SCOPE_USER.into(),
            value: serde_json::json!(AgentId::Claude),
        },
        Setting {
            key: "agents.chat".into(),
            scope: SCOPE_USER.into(),
            value: serde_json::json!(AgentId::Claude),
        },
        Setting {
            key: "agents.skills".into(),
            scope: SCOPE_USER.into(),
            value: serde_json::json!([AgentId::Claude]),
        },
        Setting {
            key: "agents.fix".into(),
            scope: SCOPE_USER.into(),
            value: serde_json::json!(AgentId::Claude),
        },
        Setting {
            key: "updates.channel".into(),
            scope: SCOPE_USER.into(),
            value: serde_json::json!("stable"),
        },
    ]
}

impl Core {
    /// Seeds any default setting not already present. Idempotent; the shell
    /// calls this once after `Core::start` (not done automatically there,
    /// so bootstrapping stays deterministic for tests).
    pub async fn ensure_default_settings(&self) -> AppResult<()> {
        let mut actions = Vec::new();
        for setting in defaults() {
            let store = self.0.deps.store.clone();
            let key = setting.key.clone();
            let existing = tokio::task::spawn_blocking(move || store.get(models::SETTING, &key))
                .await
                .ok()
                .and_then(|r| r.ok())
                .flatten();
            if existing.is_none() {
                let data = serde_json::to_value(&setting).expect("serializable");
                actions.push(NewAction {
                    model: models::SETTING.into(),
                    model_id: setting.key.clone(),
                    action: theodore_ports::SyncActionCode::I,
                    data: Some(data),
                });
            }
        }
        self.apply(actions).await?;
        Ok(())
    }

    pub async fn setting_agent(&self, key: &str, default: AgentId) -> AgentId {
        self.setting_agent_scoped(key, None, default).await
    }

    pub async fn setting_agents(&self, key: &str, default: Vec<AgentId>) -> Vec<AgentId> {
        self.setting_agents_scoped(key, None, default).await
    }

    pub async fn setting_string(&self, key: &str, default: &str) -> String {
        self.setting_value_scoped(key, None)
            .await
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_else(|| default.to_string())
    }

    /// `repo_scope` is a repo slug (`owner/name`), not the full `repo:<slug>`
    /// setting scope string — the repo value wins over `user` when present.
    pub async fn setting_agent_scoped(
        &self,
        key: &str,
        repo_scope: Option<&str>,
        default: AgentId,
    ) -> AgentId {
        self.setting_value_scoped(key, repo_scope)
            .await
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or(default)
    }

    pub async fn setting_agents_scoped(
        &self,
        key: &str,
        repo_scope: Option<&str>,
        default: Vec<AgentId>,
    ) -> Vec<AgentId> {
        self.setting_value_scoped(key, repo_scope)
            .await
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or(default)
    }

    /// `budget.per_pr_usd`: `None` when unset or not a number (no budget).
    pub async fn setting_f64_scoped(&self, key: &str, repo_scope: Option<&str>) -> Option<f64> {
        self.setting_value_scoped(key, repo_scope)
            .await
            .and_then(|v| v.as_f64())
    }

    /// The repo slug of an open PR, for scoped setting lookups. `None` for a
    /// PR not open in this session (falls back to the `user` scope).
    pub(crate) async fn repo_scope_of(&self, pr: &PrId) -> Option<String> {
        self.pr_ref(pr).await.map(|r| r.repo.slug())
    }

    /// No agent run in flight and no host write still queued — the shell
    /// may restart for an update.
    pub async fn is_idle(&self) -> bool {
        if !self.0.runs.read().await.is_empty() {
            return false;
        }
        let store = self.0.deps.store.clone();
        let pending = tokio::task::spawn_blocking(move || store.outbox_pending_count())
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or(0);
        pending == 0
    }

    async fn setting_value_scoped(
        &self,
        key: &str,
        repo_scope: Option<&str>,
    ) -> Option<serde_json::Value> {
        let store = self.0.deps.store.clone();
        let key_owned = key.to_string();
        let rows =
            tokio::task::spawn_blocking(move || store.query(models::SETTING, "key", &key_owned))
                .await
                .ok()?
                .ok()?;
        let settings: Vec<Setting> = rows
            .into_iter()
            .filter_map(|r| serde_json::from_value(r.data).ok())
            .collect();
        if let Some(scope) = repo_scope {
            let repo_scope_key = format!("repo:{scope}");
            if let Some(s) = settings.iter().find(|s| s.scope == repo_scope_key) {
                return Some(s.value.clone());
            }
        }
        settings
            .iter()
            .find(|s| s.scope == SCOPE_USER)
            .or_else(|| settings.first())
            .map(|s| s.value.clone())
    }

    /// Loads `worktree`'s `.review/config.yaml` into `setting` rows scoped
    /// to `repo` (plan §8.5): any key the file sets — `agents.grouping`,
    /// `agents.skills`, `budget.per_pr_usd`, `grouping.hide`, … — overrides
    /// the `user` scope for this repo from then on. Best-effort: a missing
    /// file is normal (most repos have none); an unparsable one is a toast,
    /// not a hard failure.
    pub(crate) async fn load_repo_settings(&self, worktree: &Path, repo: &RepoRef) {
        let path = worktree.join(REPO_CONFIG_PATH);
        let Ok(text) = tokio::fs::read_to_string(&path).await else {
            return;
        };
        let value = match serde_yaml::from_str::<serde_json::Value>(&text) {
            Ok(v) => v,
            Err(e) => {
                self.emit(Ephemeral::Toast {
                    level: ToastLevel::Warn,
                    text: format!("{}: invalid .review/config.yaml ({e})", repo.slug()),
                });
                return;
            }
        };
        let mut leaves = Vec::new();
        flatten_yaml(String::new(), &value, &mut leaves);
        if leaves.is_empty() {
            return;
        }
        let scope = format!("repo:{}", repo.slug());
        let mut actions = Vec::with_capacity(leaves.len());
        for (key, value) in leaves {
            let setting = Setting {
                key: key.clone(),
                scope: scope.clone(),
                value,
            };
            let Ok(data) = serde_json::to_value(&setting) else {
                continue;
            };
            actions.push(NewAction {
                model: models::SETTING.into(),
                model_id: format!("{scope}:{key}"),
                action: theodore_ports::SyncActionCode::U,
                data: Some(data),
            });
        }
        let _ = self.apply(actions).await;
    }
}

/// Recursively flattens a YAML/JSON object into dotted keys (`agents.grouping`).
/// A leaf — scalar, array, or an empty object — stops the recursion, so a
/// glob list like `grouping.hide: [a, b]` stays one setting, not several.
fn flatten_yaml(
    prefix: String,
    value: &serde_json::Value,
    out: &mut Vec<(String, serde_json::Value)>,
) {
    match value {
        serde_json::Value::Object(map) if !map.is_empty() => {
            for (k, v) in map {
                let key = if prefix.is_empty() {
                    k.clone()
                } else {
                    format!("{prefix}.{k}")
                };
                flatten_yaml(key, v, out);
            }
        }
        _ => {
            if !prefix.is_empty() {
                out.push((prefix, value.clone()));
            }
        }
    }
}

#[cfg(test)]
mod flatten_tests {
    use super::flatten_yaml;

    #[test]
    fn flattens_nested_keys_and_keeps_lists_as_one_leaf() {
        let value: serde_json::Value = serde_json::from_str(
            r#"{"agents":{"grouping":"codex","skills":["claude","codex"]},"budget":{"per_pr_usd":5.0}}"#,
        )
        .unwrap();
        let mut out = Vec::new();
        flatten_yaml(String::new(), &value, &mut out);
        out.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            out,
            vec![
                ("agents.grouping".to_string(), serde_json::json!("codex")),
                (
                    "agents.skills".to_string(),
                    serde_json::json!(["claude", "codex"])
                ),
                ("budget.per_pr_usd".to_string(), serde_json::json!(5.0)),
            ]
        );
    }
}
