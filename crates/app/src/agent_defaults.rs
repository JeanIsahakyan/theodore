//! Per-agent model and effort defaults (`agents.<id>.model`,
//! `agents.<id>.effort`, `user` scope), filled into every run that doesn't
//! name its own. Wraps the `AgentPort` once, at the composition root, so
//! grouping, skills, chat, fixes and space turns all pick them up.

use std::sync::Arc;

use async_trait::async_trait;
use theodore_contract::models;
use theodore_domain::AgentId;
use theodore_ports::Store;
use theodore_ports::agent::{
    AgentAccountRef, AgentError, AgentEvent, AgentInfo, AgentPort, AgentRequest, AgentRun,
    DEFAULT_ACCOUNT, LimitSeen, ModelInfo, Steer,
};

use crate::settings::{SCOPE_USER, pick_setting};
use crate::usecases::agent_accounts;

pub fn model_key(agent: AgentId) -> String {
    format!("agents.{}.model", agent.as_str())
}

pub fn effort_key(agent: AgentId) -> String {
    format!("agents.{}.effort", agent.as_str())
}

/// `AgentPort` that fills `model` / `effort` from settings when a request
/// leaves them unset, and the agent account (docs/plan.md "Agent accounts
/// and limits"): the preferred one, else the next one signed in and not
/// limited. An explicit value (a space's pinned model, its own account)
/// wins.
pub struct AgentDefaults {
    inner: Arc<dyn AgentPort>,
    store: Arc<dyn Store>,
    /// The `Limit`s of runs whose account this layer picked.
    limits: tokio::sync::broadcast::Sender<LimitSeen>,
}

impl AgentDefaults {
    pub fn new(inner: Arc<dyn AgentPort>, store: Arc<dyn Store>) -> Self {
        let (limits, _) = tokio::sync::broadcast::channel(64);
        Self {
            inner,
            store,
            limits,
        }
    }

    /// Fills what `req` leaves unset; `true` when it picked the account.
    async fn fill(&self, req: &mut AgentRequest) -> bool {
        if req.model.is_none() {
            req.model = self.text(model_key(req.agent)).await;
        }
        if req.effort.is_none() {
            req.effort = self.text(effort_key(req.agent)).await;
        }
        if req.account.is_some() {
            return false;
        }
        let (store, inner, agent) = (self.store.clone(), self.inner.clone(), req.agent);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or_default();
        let picked = tokio::task::spawn_blocking(move || {
            agent_accounts::pick_from_store(&store, inner.as_ref(), agent, now)
        })
        .await
        .ok()
        .flatten();
        req.account = Some(
            picked
                .map(|a| agent_accounts::account_ref(&a))
                .unwrap_or_else(AgentAccountRef::default_account),
        );
        true
    }

    /// `run`'s events, passed through, its `Limit`s also told to
    /// `limits_seen`.
    fn watch(&self, mut run: AgentRun, agent: AgentId, account: String) -> AgentRun {
        let (tx, rx) = tokio::sync::mpsc::channel(256);
        let limits = self.limits.clone();
        tokio::spawn(async move {
            while let Some(ev) = run.events.recv().await {
                if let AgentEvent::Limit { limit } = &ev {
                    let _ = limits.send(LimitSeen {
                        agent,
                        account: account.clone(),
                        limit: limit.clone(),
                    });
                }
                if tx.send(ev).await.is_err() {
                    break;
                }
            }
        });
        AgentRun {
            events: rx,
            cancel: run.cancel,
        }
    }

    /// The extra accounts of `agent`, from the setting.
    fn extra_accounts(&self, agent: AgentId) -> Vec<theodore_contract::AgentAccount> {
        agent_accounts::accounts_of(self.store.as_ref(), agent)
            .into_iter()
            .filter(|a| !a.default)
            .collect()
    }

    async fn text(&self, key: String) -> Option<String> {
        setting_text(&self.store, key).await
    }
}

/// A non-empty string setting, `None` when unset, `null` or blank.
async fn setting_text(store: &Arc<dyn Store>, key: String) -> Option<String> {
    let store = store.clone();
    let rows = tokio::task::spawn_blocking(move || store.query(models::SETTING, "key", &key))
        .await
        .ok()?
        .ok()?;
    // User scope only: like `agents.<id>.enabled`, a machine preference.
    let rows = rows
        .into_iter()
        .filter(|r| r.data.get("scope").and_then(|s| s.as_str()) == Some(SCOPE_USER))
        .collect();
    pick_setting(rows, None)?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The model a run asking for `asked` gets: `asked`, else the
/// `agents.<id>.model` setting, else none (the CLI's default) — what
/// `AgentDefaults` would fill in. A caller that records which model ran
/// resolves it first and sends that, so the record is what ran.
pub(crate) async fn run_model(
    store: &Arc<dyn Store>,
    agent: AgentId,
    asked: Option<String>,
) -> Option<String> {
    match asked {
        Some(m) => Some(m),
        None => setting_text(store, model_key(agent)).await,
    }
}

/// `run_model` for the effort: a space pins it the same way.
pub(crate) async fn run_effort(
    store: &Arc<dyn Store>,
    agent: AgentId,
    asked: Option<String>,
) -> Option<String> {
    match asked {
        Some(e) => Some(e),
        None => setting_text(store, effort_key(agent)).await,
    }
}

#[async_trait]
impl AgentPort for AgentDefaults {
    /// An agent counts as signed in when any of its accounts is: what the
    /// pickers and the fleet go by.
    async fn detect(&self) -> Vec<AgentInfo> {
        let mut found = self.inner.detect().await;
        for info in found
            .iter_mut()
            .filter(|i| i.installed && i.signed_in != Some(true))
        {
            let store = self.store.clone();
            let agent = info.id;
            let extra = tokio::task::spawn_blocking(move || {
                agent_accounts::accounts_of(store.as_ref(), agent)
            })
            .await
            .unwrap_or_default();
            for a in extra.iter().filter(|a| !a.default) {
                let known = self
                    .inner
                    .account_sign_in(agent, &agent_accounts::account_ref(a), false)
                    .await;
                if known == Some(true) {
                    info.signed_in = Some(true);
                    break;
                }
            }
        }
        found
    }

    async fn run(&self, mut req: AgentRequest) -> Result<AgentRun, AgentError> {
        let picked = self.fill(&mut req).await;
        let (agent, account) = (req.agent, account_id(&req));
        let run = self.inner.run(req).await?;
        Ok(if picked {
            self.watch(run, agent, account)
        } else {
            run
        })
    }

    async fn run_steerable(
        &self,
        mut req: AgentRequest,
    ) -> Result<(AgentRun, Option<Steer>), AgentError> {
        let picked = self.fill(&mut req).await;
        let (agent, account) = (req.agent, account_id(&req));
        let (run, steer) = self.inner.run_steerable(req).await?;
        Ok(if picked {
            (self.watch(run, agent, account), steer)
        } else {
            (run, steer)
        })
    }

    /// The preferred account's models (its catalog, its `CODEX_HOME`).
    async fn models(&self, agent: AgentId) -> Vec<ModelInfo> {
        let store = self.store.clone();
        let preferred = tokio::task::spawn_blocking(move || {
            let id = agent_accounts::preferred_account(store.as_ref(), agent);
            agent_accounts::accounts_of(store.as_ref(), agent)
                .into_iter()
                .find(|a| a.id == id && !a.default)
        })
        .await
        .ok()
        .flatten();
        match preferred {
            Some(a) => {
                self.inner
                    .models_in(agent, Some(&agent_accounts::account_ref(&a)))
                    .await
            }
            None => self.inner.models(agent).await,
        }
    }

    async fn models_in(&self, agent: AgentId, account: Option<&AgentAccountRef>) -> Vec<ModelInfo> {
        self.inner.models_in(agent, account).await
    }

    async fn recheck_sign_in(&self) {
        self.inner.recheck_sign_in().await
    }

    /// Signed out only when every account is known signed out.
    fn known_sign_in(&self, agent: AgentId) -> Option<bool> {
        let own = self.inner.known_sign_in(agent);
        if own != Some(false) {
            return own;
        }
        let extra: Vec<Option<bool>> = self
            .extra_accounts(agent)
            .iter()
            .map(|a| {
                self.inner
                    .known_account_sign_in(agent, &agent_accounts::account_ref(a))
            })
            .collect();
        if extra.contains(&Some(true)) {
            Some(true)
        } else if extra.contains(&None) {
            None
        } else {
            Some(false)
        }
    }

    async fn account_sign_in(
        &self,
        agent: AgentId,
        account: &AgentAccountRef,
        recheck: bool,
    ) -> Option<bool> {
        self.inner.account_sign_in(agent, account, recheck).await
    }

    fn known_account_sign_in(&self, agent: AgentId, account: &AgentAccountRef) -> Option<bool> {
        self.inner.known_account_sign_in(agent, account)
    }

    fn limits_seen(&self) -> Option<tokio::sync::broadcast::Receiver<LimitSeen>> {
        Some(self.limits.subscribe())
    }

    async fn carry_session(
        &self,
        agent: AgentId,
        session: &str,
        cwd: &std::path::Path,
        from: &AgentAccountRef,
        to: &AgentAccountRef,
    ) -> bool {
        self.inner
            .carry_session(agent, session, cwd, from, to)
            .await
    }
}

/// The account id a filled request runs on.
fn account_id(req: &AgentRequest) -> String {
    req.account
        .as_ref()
        .map_or_else(|| DEFAULT_ACCOUNT.to_string(), |a| a.id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{FakeAgent, FakeStore};
    use theodore_ports::agent::AgentMode;
    use theodore_ports::{NewAction, SyncActionCode};

    fn set(store: &FakeStore, scope: &str, key: &str, value: serde_json::Value) {
        store
            .apply(vec![NewAction {
                model: models::SETTING.into(),
                model_id: format!("{scope}:{key}"),
                action: SyncActionCode::I,
                data: Some(serde_json::json!({ "key": key, "scope": scope, "value": value })),
            }])
            .unwrap();
    }

    fn req(agent: AgentId, model: Option<&str>) -> AgentRequest {
        AgentRequest {
            agent,
            prompt: "p".into(),
            system: None,
            cwd: "/tmp".into(),
            mode: AgentMode::ReadOnly,
            mcp: None,
            model: model.map(str::to_string),
            effort: None,
            stall_after_ms: 1000,
            env: Vec::new(),
            user_mcp: false,
            attachments: vec![],
            resume: None,
            // `true`: so `FakeAgent::last_request` (reserved for turn-like
            // calls, not one-shot utility ones) sees it.
            stream_text: true,
            fork_session: false,
            account: None,
        }
    }

    async fn sent(store: Arc<FakeStore>, r: AgentRequest) -> AgentRequest {
        let agent = FakeAgent::new();
        let port = AgentDefaults::new(agent.clone(), store);
        let _ = port.run(r).await;
        agent.last_request().expect("ran")
    }

    #[tokio::test]
    async fn a_steerable_run_stays_steerable_and_gets_the_defaults() {
        let store = FakeStore::new();
        set(&store, "user", "agents.claude.model", "opus".into());
        let agent = FakeAgent::new();
        agent.take_steering();
        let port = AgentDefaults::new(agent.clone(), store);
        let (_run, steer) = port
            .run_steerable(req(AgentId::Claude, None))
            .await
            .expect("runs");
        assert!(steer.is_some(), "Send now needs the runner's handle");
        assert_eq!(agent.last_request().unwrap().model.as_deref(), Some("opus"));
    }

    #[tokio::test]
    async fn settings_fill_an_unset_model_and_effort() {
        let store = FakeStore::new();
        set(&store, "user", "agents.claude.model", "opus".into());
        set(&store, "user", "agents.claude.effort", "high".into());
        let r = sent(store, req(AgentId::Claude, None)).await;
        assert_eq!(r.model.as_deref(), Some("opus"));
        assert_eq!(r.effort.as_deref(), Some("high"));
    }

    #[tokio::test]
    async fn an_explicit_model_wins() {
        let store = FakeStore::new();
        set(&store, "user", "agents.claude.model", "opus".into());
        let r = sent(store, req(AgentId::Claude, Some("haiku"))).await;
        assert_eq!(r.model.as_deref(), Some("haiku"));
    }

    #[tokio::test]
    async fn unset_null_or_blank_keeps_the_cli_default() {
        let store = FakeStore::new();
        set(
            &store,
            "user",
            "agents.claude.model",
            serde_json::Value::Null,
        );
        set(&store, "user", "agents.claude.effort", " ".into());
        let r = sent(store, req(AgentId::Claude, None)).await;
        assert_eq!(r.model, None);
        assert_eq!(r.effort, None);
    }

    #[tokio::test]
    async fn each_agent_reads_its_own_keys() {
        let store = FakeStore::new();
        set(&store, "user", "agents.claude.model", "opus".into());
        set(&store, "user", "agents.codex.model", "gpt-5".into());
        let r = sent(store, req(AgentId::Codex, None)).await;
        assert_eq!(r.model.as_deref(), Some("gpt-5"));
    }

    #[tokio::test]
    async fn codex_gets_its_effort_too() {
        let store = FakeStore::new();
        set(&store, "user", "agents.claude.effort", "max".into());
        set(&store, "user", "agents.codex.effort", "xhigh".into());
        let r = sent(store, req(AgentId::Codex, None)).await;
        assert_eq!(r.effort.as_deref(), Some("xhigh"));
    }

    #[tokio::test]
    async fn an_explicit_effort_wins() {
        let store = FakeStore::new();
        set(&store, "user", "agents.codex.effort", "xhigh".into());
        let mut r = req(AgentId::Codex, None);
        r.effort = Some("low".into());
        let r = sent(store, r).await;
        assert_eq!(r.effort.as_deref(), Some("low"));
    }

    #[tokio::test]
    async fn a_repo_scope_row_is_ignored() {
        let store = FakeStore::new();
        set(&store, "repo:o/r", "agents.claude.model", "opus".into());
        let r = sent(store, req(AgentId::Claude, None)).await;
        assert_eq!(r.model, None);
    }
}
