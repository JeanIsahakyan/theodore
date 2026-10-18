//! Settings (plan §8.5): `agents.grouping`, `agents.chat`, `agents.skills`,
//! `agents.fix`, `updates.channel`, each with a default. Layered scopes
//! (user → repo → org) are a later milestone; this reads `user` first and
//! otherwise the first row found.

use theodore_contract::{Setting, models};
use theodore_domain::AgentId;
use theodore_ports::NewAction;

use crate::core::Core;
use crate::error::AppResult;

pub const SCOPE_USER: &str = "user";

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
        self.setting_value(key)
            .await
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or(default)
    }

    pub async fn setting_agents(&self, key: &str, default: Vec<AgentId>) -> Vec<AgentId> {
        self.setting_value(key)
            .await
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or(default)
    }

    pub async fn setting_string(&self, key: &str, default: &str) -> String {
        self.setting_value(key)
            .await
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_else(|| default.to_string())
    }

    /// No agent run in flight — the shell may restart for an update.
    pub async fn is_idle(&self) -> bool {
        self.0.runs.read().await.is_empty()
    }

    async fn setting_value(&self, key: &str) -> Option<serde_json::Value> {
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
        settings
            .iter()
            .find(|s| s.scope == SCOPE_USER)
            .or_else(|| settings.first())
            .map(|s| s.value.clone())
    }
}
