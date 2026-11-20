//! Agent accounts and their usage limits (docs/plan.md "Agent accounts and
//! limits"): several accounts of one agent CLI, the latest limit each one
//! reported, and which one a run starts on.
//!
//! ```text
//! accounts   agents.accounts (user setting): [{id, agent, label, config_dir}]
//!            + each agent's default account (the CLI's own config)
//! limits     agent_limit rows `<agent>:<account>`, and in memory
//! pick       preferred (agents.<id>.account) ─▶ the space's own ─▶ the rest,
//!            skipping signed-out ones and ones limited until later
//! ```

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use theodore_contract::{
    AddAgentAccountRequest, AgentAccount, AgentAccountRequest, AgentAccountStatus, AgentLimitRow,
    Setting, models,
};
use theodore_domain::{AgentId, AgentLimit, Millis};
use theodore_ports::agent::{AgentAccountRef, DEFAULT_ACCOUNT};
use theodore_ports::{NewAction, Store, SyncActionCode};

use crate::core::Core;
use crate::error::{AppError, AppResult};
use crate::settings::{SCOPE_USER, pick_setting};

/// The extra accounts (user scope): a list of [`StoredAccount`].
pub const ACCOUNTS_KEY: &str = "agents.accounts";
/// Other agents to continue on when every account of a space's agent is
/// limited, in order (user scope; default none).
pub const FALLBACK_KEY: &str = "agents.fallback_agents";
/// Continue a turn cut off by a usage limit on its own (user scope;
/// default on).
pub const AUTO_CONTINUE_KEY: &str = "agents.auto_continue";

/// `agents.<id>.account`: the account runs of that agent start on.
pub fn preferred_key(agent: AgentId) -> String {
    format!("agents.{}.account", agent.as_str())
}

/// What `agents.accounts` holds per extra account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredAccount {
    pub id: String,
    pub agent: AgentId,
    pub label: String,
    pub config_dir: String,
}

/// The agent's name as the UI writes it.
pub fn agent_name(agent: AgentId) -> &'static str {
    match agent {
        AgentId::Claude => "Claude",
        AgentId::Codex => "Codex",
        AgentId::Gemini => "Gemini",
    }
}

/// "Claude · work".
pub fn account_label(a: &AgentAccount) -> String {
    format!("{} · {}", agent_name(a.agent), a.label)
}

/// What a run of `a` needs: nothing overridden for a default account.
pub fn account_ref(a: &AgentAccount) -> AgentAccountRef {
    AgentAccountRef {
        id: a.id.clone(),
        dir: (!a.default).then(|| PathBuf::from(&a.config_dir)),
    }
}

/// The CLI's own account of `agent`.
pub fn default_account(agent: AgentId) -> AgentAccount {
    AgentAccount {
        id: DEFAULT_ACCOUNT.to_string(),
        agent,
        label: DEFAULT_ACCOUNT.to_string(),
        config_dir: theodore_ports::default_account_dir(agent)
            .map(|d| d.display().to_string())
            .unwrap_or_default(),
        default: true,
    }
}

/// `agent_limit`'s key of an account.
pub fn limit_key(agent: AgentId, account: &str) -> String {
    format!("{}:{account}", agent.as_str())
}

/// A user-scope setting's value, read straight off the store.
fn user_setting(store: &dyn Store, key: &str) -> Option<serde_json::Value> {
    let rows = store.query(models::SETTING, "key", key).ok()?;
    let rows = rows
        .into_iter()
        .filter(|r| r.data.get("scope").and_then(|s| s.as_str()) == Some(SCOPE_USER))
        .collect();
    pick_setting(rows, None)
}

/// The extra accounts, in the order they were added.
pub fn stored_accounts(store: &dyn Store) -> Vec<StoredAccount> {
    user_setting(store, ACCOUNTS_KEY)
        .and_then(|v| serde_json::from_value::<Vec<StoredAccount>>(v).ok())
        .unwrap_or_default()
}

/// Every account of `agent`: its default one first, then the extra ones.
pub fn accounts_of(store: &dyn Store, agent: AgentId) -> Vec<AgentAccount> {
    std::iter::once(default_account(agent))
        .chain(
            stored_accounts(store)
                .into_iter()
                .filter(|s| s.agent == agent)
                .map(|s| AgentAccount {
                    id: s.id,
                    agent: s.agent,
                    label: s.label,
                    config_dir: s.config_dir,
                    default: false,
                }),
        )
        .collect()
}

/// `agents.<id>.account`, `default` when unset.
pub fn preferred_account(store: &dyn Store, agent: AgentId) -> String {
    user_setting(store, &preferred_key(agent))
        .and_then(|v| v.as_str().map(str::to_string))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_ACCOUNT.to_string())
}

/// Every stored limit, by `limit_key`.
pub fn stored_limits(store: &dyn Store) -> HashMap<String, AgentLimitRow> {
    store
        .all(models::AGENT_LIMIT)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|r| Some((r.id, serde_json::from_value(r.data).ok()?)))
        .collect()
}

/// `accounts` in the order a run tries them: `first` (when it names one of
/// them), then the preferred one, then the rest as listed.
pub fn in_pick_order(
    accounts: Vec<AgentAccount>,
    preferred: &str,
    first: Option<&str>,
) -> Vec<AgentAccount> {
    let rank = |a: &AgentAccount| {
        if Some(a.id.as_str()) == first {
            0
        } else if a.id == preferred {
            1
        } else {
            2
        }
    };
    let mut out = accounts;
    out.sort_by_key(rank);
    out
}

/// Whether `row` still refuses runs at `now`.
pub fn is_blocked(row: Option<&AgentLimitRow>, now: Millis) -> bool {
    row.is_some_and(|r| r.limit.blocks_at(r.at, now))
}

/// The latest limit of each account, as last reported: in memory, loaded
/// from the `agent_limit` rows on first use.
#[derive(Default)]
pub struct LimitBook {
    rows: std::sync::Mutex<Option<HashMap<String, AgentLimitRow>>>,
}

impl LimitBook {
    fn with<T>(
        &self,
        store: &dyn Store,
        f: impl FnOnce(&mut HashMap<String, AgentLimitRow>) -> T,
    ) -> T {
        let mut g = self.rows.lock().unwrap_or_else(|p| p.into_inner());
        let rows = g.get_or_insert_with(|| stored_limits(store));
        f(rows)
    }
}

impl Core {
    /// Every account of `agent`, in the order runs try them; `first`: an
    /// account to try before the preferred one.
    async fn accounts_in_order(&self, agent: AgentId, first: Option<&str>) -> Vec<AgentAccount> {
        let store = self.0.deps.store.clone();
        let first = first.map(str::to_string);
        tokio::task::spawn_blocking(move || {
            let preferred = preferred_account(store.as_ref(), agent);
            in_pick_order(
                accounts_of(store.as_ref(), agent),
                &preferred,
                first.as_deref(),
            )
        })
        .await
        .unwrap_or_else(|_| vec![default_account(agent)])
    }

    /// The account `id` of `agent`, if it (still) exists.
    pub(crate) async fn agent_account(&self, agent: AgentId, id: &str) -> Option<AgentAccount> {
        self.accounts_in_order(agent, None)
            .await
            .into_iter()
            .find(|a| a.id == id)
    }

    /// The latest limit `account` reported, if any.
    pub(crate) fn account_limit(&self, agent: AgentId, account: &str) -> Option<AgentLimitRow> {
        let key = limit_key(agent, account);
        self.0
            .agent_limits
            .with(self.0.deps.store.as_ref(), |rows| rows.get(&key).cloned())
    }

    /// Keeps what `account` of `agent` just said about its limit: in memory
    /// and as its `agent_limit` row (unchanged news writes nothing).
    pub(crate) async fn note_agent_limit(&self, agent: AgentId, account: &str, limit: AgentLimit) {
        let key = limit_key(agent, account);
        let row = AgentLimitRow {
            agent,
            account: account.to_string(),
            limit,
            at: self.0.deps.clock.now(),
        };
        let changed = self
            .0
            .agent_limits
            .with(self.0.deps.store.as_ref(), |rows| {
                let same = rows.get(&key).is_some_and(|old| old.limit == row.limit);
                rows.insert(key.clone(), row.clone());
                !same
            });
        if !changed {
            return;
        }
        if row.limit.status == theodore_domain::LimitStatus::Limited {
            tracing::info!(
                agent = agent.as_str(),
                account,
                resets_at = row.limit.resets_at,
                "agent account hit its usage limit"
            );
        }
        let Ok(data) = serde_json::to_value(&row) else {
            return;
        };
        let _ = self
            .apply(vec![NewAction {
                model: models::AGENT_LIMIT.into(),
                model_id: key,
                action: SyncActionCode::U,
                data: Some(data),
            }])
            .await;
    }

    /// Whether `a` may take a run: not known signed out, not limited.
    async fn account_usable(&self, a: &AgentAccount, now: Millis) -> bool {
        if is_blocked(self.account_limit(a.agent, &a.id).as_ref(), now) {
            return false;
        }
        let agents = &self.0.deps.agents;
        let signed_in = if a.default {
            agents.known_sign_in(a.agent)
        } else {
            agents
                .account_sign_in(a.agent, &account_ref(a), false)
                .await
        };
        signed_in != Some(false)
    }

    /// The account a run of `agent` starts on: `first` (the space's own)
    /// or the preferred one, else the next one signed in and not limited;
    /// `skip`: accounts not to use. `None`: none can.
    pub(crate) async fn pick_account(
        &self,
        agent: AgentId,
        first: Option<&str>,
        skip: &[String],
    ) -> Option<AgentAccount> {
        let now = self.0.deps.clock.now();
        for a in self.accounts_in_order(agent, first).await {
            if !skip.contains(&a.id) && self.account_usable(&a, now).await {
                return Some(a);
            }
        }
        None
    }

    /// `pick_account`, else the preferred account all the same (its limit
    /// may be over already): a turn always has an account.
    pub(crate) async fn turn_account(&self, agent: AgentId, first: Option<&str>) -> AgentAccount {
        if let Some(a) = self.pick_account(agent, first, &[]).await {
            return a;
        }
        self.accounts_in_order(agent, None)
            .await
            .into_iter()
            .next()
            .unwrap_or_else(|| default_account(agent))
    }

    /// The earliest time one of `agents`' limited accounts resets.
    pub(crate) async fn earliest_reset(&self, agents: &[AgentId]) -> Option<Millis> {
        let now = self.0.deps.clock.now();
        let mut best: Option<Millis> = None;
        for &agent in agents {
            for a in self.accounts_in_order(agent, None).await {
                let Some(row) = self.account_limit(agent, &a.id) else {
                    continue;
                };
                let at = row.limit.resets_at.filter(|at| *at > now);
                if let Some(at) = at {
                    best = Some(best.map_or(at, |b| b.min(at)));
                }
            }
        }
        best
    }

    /// `agents.fallback_agents`, in order, without `agent` itself.
    pub(crate) async fn fallback_agents(&self, agent: AgentId) -> Vec<AgentId> {
        let list = self.setting_agents(FALLBACK_KEY, Vec::new()).await;
        let mut out = Vec::new();
        for a in list {
            if a != agent && !out.contains(&a) && self.agent_enabled(a).await {
                out.push(a);
            }
        }
        out
    }

    /// `agents.auto_continue`, on unless set to `false`.
    pub(crate) async fn auto_continue(&self) -> bool {
        let store = self.0.deps.store.clone();
        tokio::task::spawn_blocking(move || user_setting(store.as_ref(), AUTO_CONTINUE_KEY))
            .await
            .ok()
            .flatten()
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    }

    /// Every account of every agent with its sign-in and latest limit, for
    /// Settings → Agents.
    pub async fn agent_accounts(&self) -> AppResult<Vec<AgentAccountStatus>> {
        let mut out = Vec::new();
        for agent in AgentId::ALL {
            out.extend(self.agent_accounts_of(agent, false).await);
        }
        Ok(out)
    }

    async fn agent_accounts_of(&self, agent: AgentId, recheck: bool) -> Vec<AgentAccountStatus> {
        let store = self.0.deps.store.clone();
        let preferred =
            tokio::task::spawn_blocking(move || preferred_account(store.as_ref(), agent))
                .await
                .unwrap_or_else(|_| DEFAULT_ACCOUNT.to_string());
        let mut out = Vec::new();
        for a in self.accounts_in_order(agent, None).await {
            out.push(self.agent_account_status(a, &preferred, recheck).await);
        }
        // The order they were added, not the order runs try them.
        out.sort_by_key(|s| !s.account.default);
        out
    }

    async fn agent_account_status(
        &self,
        a: AgentAccount,
        preferred: &str,
        recheck: bool,
    ) -> AgentAccountStatus {
        let agents = &self.0.deps.agents;
        let signed_in = if a.default {
            if recheck {
                agents.recheck_sign_in().await;
            }
            match agents.known_sign_in(a.agent) {
                Some(known) => Some(known),
                None => agents
                    .detect()
                    .await
                    .into_iter()
                    .find(|i| i.id == a.agent)
                    .and_then(|i| i.signed_in),
            }
        } else {
            agents
                .account_sign_in(a.agent, &account_ref(&a), recheck)
                .await
        };
        let sign_in_command = (!a.default).then(|| {
            theodore_ports::account_sign_in_command(a.agent, std::path::Path::new(&a.config_dir))
        });
        AgentAccountStatus {
            limit: self.account_limit(a.agent, &a.id),
            preferred: a.id == preferred,
            signed_in,
            sign_in_command,
            account: a,
        }
    }

    /// Adds an account of `agent` with its own config dir under
    /// `<data>/agent-accounts/<id>` (created, empty: sign it in from a
    /// terminal with the command its row shows).
    pub async fn add_agent_account(
        &self,
        req: AddAgentAccountRequest,
    ) -> AppResult<AgentAccountStatus> {
        let label = req.label.trim().to_string();
        if label.is_empty() {
            return Err(AppError::Invalid("an account needs a name".into()));
        }
        let store = self.0.deps.store.clone();
        let mut list = tokio::task::spawn_blocking(move || stored_accounts(store.as_ref()))
            .await
            .map_err(AppError::join)?;
        if label == DEFAULT_ACCOUNT
            || list
                .iter()
                .any(|s| s.agent == req.agent && s.label.eq_ignore_ascii_case(&label))
        {
            return Err(AppError::Invalid(format!(
                "{} already has an account called {label}",
                agent_name(req.agent)
            )));
        }
        let id = format!(
            "{}-{}",
            req.agent.as_str(),
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        );
        let dir = self.0.deps.data_dir.join("agent-accounts").join(&id);
        std::fs::create_dir_all(&dir)
            .map_err(|e| AppError::Invalid(format!("couldn't create {}: {e}", dir.display())))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        }
        let stored = StoredAccount {
            id,
            agent: req.agent,
            label,
            config_dir: dir.display().to_string(),
        };
        list.push(stored.clone());
        self.save_user_setting(ACCOUNTS_KEY, to_json(&list)?)
            .await?;
        let account = AgentAccount {
            id: stored.id,
            agent: stored.agent,
            label: stored.label,
            config_dir: stored.config_dir,
            default: false,
        };
        let preferred = {
            let store = self.0.deps.store.clone();
            tokio::task::spawn_blocking(move || preferred_account(store.as_ref(), req.agent))
                .await
                .map_err(AppError::join)?
        };
        Ok(self.agent_account_status(account, &preferred, false).await)
    }

    /// Forgets an extra account: its row, its limit, its preference. Its
    /// directory (and the sign-in in it) stays where it is.
    pub async fn remove_agent_account(&self, req: AgentAccountRequest) -> AppResult<()> {
        if req.id == DEFAULT_ACCOUNT {
            return Err(AppError::Invalid(
                "the default account can't be removed".into(),
            ));
        }
        let store = self.0.deps.store.clone();
        let mut list = tokio::task::spawn_blocking(move || stored_accounts(store.as_ref()))
            .await
            .map_err(AppError::join)?;
        let before = list.len();
        list.retain(|s| !(s.id == req.id && s.agent == req.agent));
        if list.len() == before {
            return Err(AppError::NotFound(format!("account {}", req.id)));
        }
        self.save_user_setting(ACCOUNTS_KEY, to_json(&list)?)
            .await?;
        let store = self.0.deps.store.clone();
        let agent = req.agent;
        if tokio::task::spawn_blocking(move || preferred_account(store.as_ref(), agent))
            .await
            .map_err(AppError::join)?
            == req.id
        {
            self.save_user_setting(&preferred_key(agent), serde_json::json!(DEFAULT_ACCOUNT))
                .await?;
        }
        let key = limit_key(agent, &req.id);
        self.0
            .agent_limits
            .with(self.0.deps.store.as_ref(), |rows| rows.remove(&key));
        let _ = self
            .apply(vec![NewAction {
                model: models::AGENT_LIMIT.into(),
                model_id: key,
                action: SyncActionCode::D,
                data: None,
            }])
            .await;
        Ok(())
    }

    /// One account's row again, its sign-in checked anew when `recheck`
    /// ("Check again").
    pub async fn check_agent_account(
        &self,
        req: AgentAccountRequest,
    ) -> AppResult<AgentAccountStatus> {
        self.agent_accounts_of(req.agent, false)
            .await
            .into_iter()
            .find(|s| s.account.id == req.id)
            .ok_or_else(|| AppError::NotFound(format!("account {}", req.id)))?;
        let store = self.0.deps.store.clone();
        let agent = req.agent;
        let preferred =
            tokio::task::spawn_blocking(move || preferred_account(store.as_ref(), agent))
                .await
                .map_err(AppError::join)?;
        let account = self
            .agent_account(req.agent, &req.id)
            .await
            .ok_or_else(|| AppError::NotFound(format!("account {}", req.id)))?;
        Ok(self
            .agent_account_status(account, &preferred, req.recheck)
            .await)
    }

    /// Writes a user-scope setting as the UI does (`user:<key>`).
    pub(crate) async fn save_user_setting(
        &self,
        key: &str,
        value: serde_json::Value,
    ) -> AppResult<()> {
        let setting = Setting {
            key: key.to_string(),
            scope: SCOPE_USER.to_string(),
            value,
        };
        self.apply(vec![NewAction {
            model: models::SETTING.into(),
            model_id: format!("{SCOPE_USER}:{key}"),
            action: SyncActionCode::U,
            data: Some(to_json(&setting)?),
        }])
        .await?;
        Ok(())
    }
}

fn to_json<T: Serialize>(v: &T) -> AppResult<serde_json::Value> {
    serde_json::to_value(v).map_err(|e| AppError::Invalid(e.to_string()))
}

/// `Core::pick_account` for a caller without a `Core` (`AgentDefaults`): the
/// first account in pick order not limited and not known signed out, read off
/// `store` (sign-ins only as already known: nothing is checked here).
pub(crate) fn pick_from_store(
    store: &Arc<dyn Store>,
    agents: &dyn theodore_ports::AgentPort,
    agent: AgentId,
    now: Millis,
) -> Option<AgentAccount> {
    let preferred = preferred_account(store.as_ref(), agent);
    let accounts = in_pick_order(accounts_of(store.as_ref(), agent), &preferred, None);
    if accounts.len() == 1 {
        return accounts.into_iter().next();
    }
    let limits = stored_limits(store.as_ref());
    accounts.into_iter().find(|a| {
        !is_blocked(limits.get(&limit_key(agent, &a.id)), now)
            && agents.known_account_sign_in(agent, &account_ref(a)) != Some(false)
    })
}
