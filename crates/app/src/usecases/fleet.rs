//! Fleet (docs/fleet.md): spaces across the user's devices, relayed by the
//! Theodore cloud. This file holds the state, the settings, the link's
//! lifecycle and the inbound dispatch; `fleet_host` is this device as a
//! target (trust gate, hosted spaces, journal), `fleet_origin` this device
//! as an origin (remote spaces started here, questions routed here),
//! `fleet_delegate` the phones and web apps this device sends its spaces'
//! questions to, `fleet_tools` the agent's tools.
//!
//! ```text
//! enabled + signed in + cloud URL + org ─▶ FleetPort::start ─▶ link
//!   account refresh ─▶ Reauth(token)       org or account switch ─▶ Close,
//!   sign-out / disable ─▶ Close              new link (that org's device)
//!                                          Fatal ─▶ error, no redial until
//!                                            sign-in, org or settings change,
//!                                            or a new access token
//! link ─▶ Connected | Message | Disconnected | Fatal ─▶ fleet_inbound
//! ```

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use theodore_contract::{
    Ephemeral, FleetAuto, FleetAutoOn, FleetDevice, FleetMcpAuto, FleetOs, FleetProject,
    FleetQuestion, FleetRemoteSpace, FleetSettingsRequest, FleetSpaceLine, FleetStatus,
    FleetTrustRequest, Project, ProjectStatus, SpaceMode, models,
};
use theodore_domain::HostKind;
use theodore_fleet_protocol::{
    ClientMessage, Delegation, DeviceInfo, DeviceKey, DeviceKind, DeviceOs, DeviceSummary,
    FleetMode, McpAuto, ProjectRef, REPLAY_MEMORY_MS, RemoteRequest, ServerMessage, SpaceCursor,
    codes, fingerprint,
};
use theodore_ports::{FleetCommand, FleetConnect, FleetHostedRow, FleetInbound};
use tokio::sync::{mpsc, oneshot};

use crate::core::Core;
use crate::error::{AppError, AppResult};

/// Where the fleet settings live: the local store, not synced `setting`
/// rows, so only `fleet_set_settings` / `fleet_trust_device` change them.
const SETTINGS_KEY: &str = "fleet.settings";
/// The cloud-assigned device id, per organization (one hub per org).
fn device_id_key(org: &str) -> String {
    format!("fleet.device_id:{org}")
}

/// The fleet id a local space's agent starts children under: stable per
/// space (kept in kv), so the cloud counts them across restarts.
fn parent_id_key(local: &str) -> String {
    format!("fleet.parent:{local}")
}

/// A device id as the cloud issues it (`dev_` + a UUID,
/// cloud/src/fleet/hub.ts): `^dev_[0-9a-f-]{36}$`. Ids are unsigned and
/// reach agents, so a listed device with any other id is dropped.
pub(crate) fn valid_device_id(id: &str) -> bool {
    id.strip_prefix("dev_").is_some_and(|rest| {
        rest.len() == 36
            && rest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
    })
}

/// Longest pinned device name.
const PIN_NAME_MAX: usize = 40;

/// A device name as pinned here: only `[A-Za-z0-9 ._()-]` kept, at most 40
/// characters, `device` when nothing is left. The name comes from the
/// cloud's unsigned listing and reaches agents.
pub(crate) fn pin_name(name: &str) -> String {
    let kept: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || " ._()-".contains(*c))
        .take(PIN_NAME_MAX)
        .collect();
    let kept = kept.trim();
    if kept.is_empty() {
        "device".to_string()
    } else {
        kept.to_string()
    }
}

/// A pinned device (`fleet.trusted_devices`): the key the user compared
/// when trust was given here, its name as `pin_name` left it, and its kind
/// as listed then.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct TrustedDevice {
    pub device_id: String,
    pub public_key: String,
    pub name: String,
    /// `kind_str` of the device when it was pinned (`None`: pinned before
    /// kinds were kept). Kept so a cloud listing the same key under another
    /// kind later can't lift the cap on an `mcp` one (`fleet_origin_mcp`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// An `mcp` device only: this computer's auto mode for it
    /// (docs/fleet.md "Auto mode"). Read through [`TrustedDevice::auto_at`]:
    /// past `auto_until_ms` it's off.
    #[serde(default, skip_serializing_if = "is_off")]
    pub auto: McpAuto,
    /// Unix ms the auto mode ends; `None`: until turned off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_until_ms: Option<u64>,
}

fn is_off(a: &McpAuto) -> bool {
    *a == McpAuto::Off
}

impl TrustedDevice {
    /// The auto mode in force at `now`: off once `auto_until_ms` passed.
    pub(crate) fn auto_at(&self, now: u64) -> McpAuto {
        match self.auto_until_ms {
            Some(until) if until <= now => McpAuto::Off,
            _ => self.auto,
        }
    }

    /// Its end, while it's on at `now`.
    pub(crate) fn auto_until_at(&self, now: u64) -> Option<u64> {
        if self.auto_at(now) == McpAuto::Off {
            None
        } else {
            self.auto_until_ms
        }
    }
}

pub(crate) fn ui_auto(a: McpAuto) -> FleetAuto {
    match a {
        McpAuto::Off => FleetAuto::Off,
        McpAuto::Edit => FleetAuto::Edit,
        McpAuto::Full => FleetAuto::Full,
    }
}

pub(crate) fn wire_auto(a: FleetAuto) -> McpAuto {
    match a {
        FleetAuto::Off => McpAuto::Off,
        FleetAuto::Edit => McpAuto::Edit,
        FleetAuto::Full => McpAuto::Full,
    }
}

/// Most `mcp` devices whose auto mode a computer lists.
const MCP_AUTO_LISTED: usize = 8;

/// A device kind as the UI and the pins name it.
pub(crate) fn kind_str(k: DeviceKind) -> &'static str {
    match k {
        DeviceKind::Desktop => "desktop",
        DeviceKind::Daemon => "daemon",
        DeviceKind::Mobile => "mobile",
        DeviceKind::Web => "web",
        DeviceKind::Mcp => "mcp",
    }
}

/// Whether a device of kind `k` may follow this device's spaces and get
/// its Claude via cloud prompts (`fleet_delegate`): a phone, the web app or
/// another desktop computer; never a daemon (nobody there) or Claude via
/// cloud itself.
pub(crate) fn follows(k: DeviceKind) -> bool {
    matches!(
        k,
        DeviceKind::Mobile | DeviceKind::Web | DeviceKind::Desktop
    )
}

fn default_max_mode() -> FleetMode {
    FleetMode::Edit
}

/// docs/fleet.md "Settings".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct FleetSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub accept_remote: bool,
    #[serde(default = "default_max_mode")]
    pub max_mode: FleetMode,
    /// `None`: the machine's name.
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub trusted_devices: Vec<TrustedDevice>,
    /// Phones and web apps this device sends its spaces' questions to
    /// (`fleet_delegate`), by device id: what the user asked for, signed
    /// again for the cloud after every welcome.
    #[serde(default)]
    pub delegates: Vec<String>,
}

impl Default for FleetSettings {
    fn default() -> Self {
        FleetSettings {
            enabled: false,
            accept_remote: false,
            max_mode: default_max_mode(),
            name: None,
            trusted_devices: Vec::new(),
            delegates: Vec::new(),
        }
    }
}

pub(crate) fn fleet_mode(m: SpaceMode) -> FleetMode {
    match m {
        SpaceMode::Ask => FleetMode::Ask,
        SpaceMode::Plan => FleetMode::Plan,
        SpaceMode::Edit => FleetMode::Edit,
        SpaceMode::Run => FleetMode::Run,
    }
}

pub(crate) fn space_mode(m: FleetMode) -> SpaceMode {
    match m {
        FleetMode::Ask => SpaceMode::Ask,
        FleetMode::Plan => SpaceMode::Plan,
        FleetMode::Edit => SpaceMode::Edit,
        FleetMode::Run => SpaceMode::Run,
    }
}

pub(crate) fn mode_str(m: FleetMode) -> &'static str {
    match m {
        FleetMode::Ask => "ask",
        FleetMode::Plan => "plan",
        FleetMode::Edit => "edit",
        FleetMode::Run => "run",
    }
}

/// The open link to the cloud.
pub(crate) struct Link {
    pub id: u64,
    pub commands: mpsc::UnboundedSender<FleetCommand>,
    /// The account (user id) whose token the link carries: another
    /// account's token is never sent as a `reauth` on this link, even in
    /// the same organization (the cloud ties a device to its user).
    pub user: String,
    pub org: String,
    pub cloud_url: String,
    pub token: String,
}

/// A request seen from another device, kept `REPLAY_MEMORY_MS` after its
/// `issued_at` (in the store too, so a restart doesn't forget it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Seen {
    /// Verified and claimed, no claim result yet: a re-delivery (after a
    /// reconnect) is claimed again rather than refused.
    Claiming,
    /// Run, refused or lost its claim: a re-delivery is a replay.
    Done,
}

/// A request this device sent, waiting for its reply.
pub(crate) struct PendingReply {
    pub space: String,
    pub start: bool,
    /// The target, and its key as pinned here when the request was signed
    /// (the request's `target_key`): only a reply that verifies against
    /// exactly this key counts.
    pub target: String,
    pub target_key: String,
    pub tx: Option<oneshot::Sender<Answer>>,
}

/// What came back for a request sent from here. Only `Ok` and `Err` were
/// signed by the target; of a `Refused` nothing but its code is kept.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Answer {
    /// The target's verified reply.
    Ok(serde_json::Value),
    /// The target's verified refusal: its code (`safe_code`) and its
    /// words, at most [`ERROR_TEXT_MAX`] characters.
    Err { code: String, message: String },
    /// The cloud's own unsigned refusal (`refused`): its code only.
    Refused { code: String },
}

/// Most characters of a verified refusal's words that reach the UI or an
/// agent.
pub(crate) const ERROR_TEXT_MAX: usize = 200;

/// A refusal code as it may be shown: `fleet.offline`-like, else
/// `fleet.unknown` (an unsigned `refused` carries the cloud's free text).
pub(crate) fn safe_code(code: &str) -> String {
    let ok = !code.is_empty()
        && code.len() <= 64
        && code
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'.');
    if ok {
        code.to_string()
    } else {
        "fleet.unknown".to_string()
    }
}

/// A start past the gate and not hosted yet: counted with the hosted
/// spaces (children cap, duplicate id) so concurrent starts can't all
/// pass. Released when the start ends, either way.
pub(crate) struct Reserved {
    pub req_id: String,
    pub parent: Option<String>,
}

/// A space this device hosts for the fleet: the stored row plus what the
/// UI and the trust gate read.
pub(crate) struct Hosted {
    pub row: FleetHostedRow,
    pub data: crate::usecases::fleet_host::HostedData,
    pub view: FleetRemoteSpace,
}

/// Where a walk up a space's parents met the fleet.
enum HostedAt {
    Row(FleetHostedRow),
    /// Being made for this device, not mapped yet.
    Making(String),
}

/// A verified request waiting for its claim result, with the origin key
/// it verified against (checked again right before it runs).
pub(crate) struct Claimed {
    pub req: RemoteRequest,
    pub key: String,
    /// The mode it runs in, as the gate resolved it (a send without one:
    /// the space's; `send_to`: the target's own; `merge_child`: Edit;
    /// reading: Ask); `None` for what runs in no mode (stop, answers).
    /// What `max_mode`, the person's yes and auto mode are checked against.
    pub mode: Option<FleetMode>,
    /// From an `mcp` device, and it edits or runs: a person here says yes
    /// before it runs (`fleet_confirm_wait`).
    pub confirm: bool,
}

/// A request waiting for a person here (`FleetMem::confirms`).
pub(crate) struct PendingConfirm {
    pub view: theodore_contract::FleetConfirm,
    pub tx: Option<oneshot::Sender<bool>>,
}

/// A space on another device, started from here (or by an agent here).
/// `view.host_device` is the start's target and never changes.
pub(crate) struct Outbound {
    pub view: FleetRemoteSpace,
    /// Its name as the host's signed `started` event gives it.
    pub started_name: Option<String>,
    pub lines: VecDeque<FleetSpaceLine>,
    pub last_seq: u64,
    /// The local space whose agent started it (`fleet_start_space` tool).
    pub started_by: Option<String>,
    /// Why it failed, as an agent may read it: the refusal's code alone
    /// (`view.error`, with the target's words, is the UI's).
    pub agent_error: Option<String>,
    /// Its host's space row is kept here (docs/fleet.md "One space UI:
    /// mirrored rows"): followed again after a restart.
    pub mirrored: bool,
    /// The live steps of its current run seen so far, by mirrored step id:
    /// a step seen again is an update (a tool call's end, more text).
    pub live: HashMap<String, LiveStep>,
}

/// A live step of a followed space's run, as last shown here.
pub(crate) enum LiveStep {
    Other,
    /// A tool call, by its call id.
    Tool(Option<String>),
    /// The run's own text: how much of it was shown.
    Text(String),
}

#[derive(Default)]
pub(crate) struct FleetMem {
    pub link: Option<Link>,
    pub connected: bool,
    pub device_id: Option<String>,
    pub generation: u64,
    pub devices: Vec<DeviceSummary>,
    pub error: Option<String>,
    /// A `Fatal` for (account generation, org): no new link for those.
    pub fatal_at: Option<(u64, String)>,
    /// By `req_id`: `(issued_at, state)`.
    pub seen: HashMap<String, (i64, Seen)>,
    /// Verified requests waiting for their claim result.
    pub claims: HashMap<String, Claimed>,
    /// Claimed requests waiting for a person here, by `req_id`. Memory
    /// only: a restart forgets them (their requests are out of time then).
    pub confirms: HashMap<String, PendingConfirm>,
    /// Prompts waiting on another computer that sends its approvals here
    /// (this device is its delegate), by `req_id`. Memory only.
    pub remote_confirms: HashMap<String, theodore_contract::FleetConfirm>,
    /// Starts past the gate, not hosted yet, by remote id.
    pub reserved: HashMap<String, Reserved>,
    /// By remote id.
    pub hosted: HashMap<String, Hosted>,
    /// Local spaces being made for another device, not mapped yet: the
    /// device each runs for.
    pub hosting: HashMap<String, String>,
    pub outbound: HashMap<String, Outbound>,
    pub replies: HashMap<String, PendingReply>,
    /// Questions from elsewhere routed here, by ask id, with the (pinned,
    /// verified) device that asked.
    pub asks: HashMap<String, (FleetQuestion, String)>,
    /// The cloud's live delegations naming this device, each verified
    /// (`fleet_on_delegations`).
    pub delegations: Vec<Delegation>,
    /// A welcome came and the wanted delegations weren't signed again yet:
    /// done once the device list says which delegates are in this org.
    pub delegations_due: bool,
    /// Delegates a revocation went to on this connection: one each, so a
    /// cloud that keeps listing one can't make this device loop.
    pub revoked: HashSet<String>,
    /// Installed agents and their models, with when they were detected
    /// (`fleet_agents`).
    pub agent_catalog: Option<(i64, crate::usecases::fleet_agents::Catalog)>,
}

impl FleetMem {
    /// Forgets the claims still waiting for their result (the connection
    /// went), and the slots they reserved.
    pub(crate) fn drop_claims(&mut self) {
        let claims = std::mem::take(&mut self.claims);
        self.reserved.retain(|_, r| !claims.contains_key(&r.req_id));
    }

    /// Releases `space`'s slot, if `req_id` reserved it.
    pub(crate) fn release(&mut self, space: &str, req_id: &str) {
        if self.reserved.get(space).is_some_and(|r| r.req_id == req_id) {
            self.reserved.remove(space);
        }
    }
}

/// One per `Core`.
#[derive(Default)]
pub struct FleetState {
    pub(crate) mem: std::sync::Mutex<FleetMem>,
    key: tokio::sync::OnceCell<Arc<DeviceKey>>,
    machine_name: tokio::sync::OnceCell<String>,
    /// One reconcile at a time.
    reconcile_lock: tokio::sync::Mutex<()>,
    /// Read-modify-write of the settings.
    pub(crate) settings_lock: tokio::sync::Mutex<()>,
    pub(crate) hosted_loaded: tokio::sync::OnceCell<()>,
    /// Files another device sent with a `start_space`, by the local space
    /// id, until its worktree exists (`fleet_files`).
    pub(crate) pending_context: std::sync::Mutex<
        std::collections::HashMap<String, Vec<crate::usecases::fleet_files::ReceivedFile>>,
    >,
    /// `.context/` files written for a space, waiting to ride with its
    /// next message (`fleet_files`).
    pub(crate) pending_attachments:
        std::sync::Mutex<std::collections::HashMap<String, Vec<theodore_contract::Attachment>>>,
    /// The persisted seen requests, read once.
    pub(crate) seen_loaded: tokio::sync::OnceCell<()>,
    /// The mirrored spaces in the store, followed again once.
    pub(crate) followed_loaded: tokio::sync::OnceCell<()>,
    pub(crate) observer:
        std::sync::OnceLock<mpsc::UnboundedSender<crate::usecases::fleet_host::ObserverCmd>>,
    /// Wakes `fleet_wait` on any change to a remote space.
    pub(crate) changed: tokio::sync::Notify,
    /// Enabled and connected: the agent's fleet tools are listed.
    pub(crate) tools_on: AtomicBool,
    /// `theodore daemon`: nobody sits at this device (`DeviceKind::Daemon`).
    daemon: AtomicBool,
    next_link: AtomicU64,
}

/// Wanted link: everything a reconcile needs.
struct Wanted {
    user: String,
    org: String,
    cloud_url: String,
    token: String,
    generation: u64,
}

impl Core {
    pub(crate) fn fleet(&self) -> std::sync::MutexGuard<'_, FleetMem> {
        self.0.fleet.mem.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Runs this core as `theodore daemon` (`DeviceKind::Daemon`): nobody
    /// sits here, so a request that needs a person's yes is refused
    /// outright (`fleet.denied`). Set before the fleet connects.
    pub fn set_fleet_daemon(&self, daemon: bool) {
        self.0.fleet.daemon.store(daemon, Ordering::SeqCst);
    }

    /// What this device is to the fleet.
    pub(crate) fn fleet_kind(&self) -> DeviceKind {
        if self.0.fleet.daemon.load(Ordering::SeqCst) {
            DeviceKind::Daemon
        } else {
            DeviceKind::Desktop
        }
    }

    // ── settings ────────────────────────────────────────────────────────

    pub(crate) async fn fleet_settings(&self) -> FleetSettings {
        let store = self.0.deps.store.clone();
        let mut s: FleetSettings = tokio::task::spawn_blocking(move || store.kv_get(SETTINGS_KEY))
            .await
            .ok()
            .and_then(Result::ok)
            .flatten()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        // Pins made before names were sanitized at pinning.
        for t in &mut s.trusted_devices {
            t.name = pin_name(&t.name);
        }
        s
    }

    pub(crate) async fn fleet_save_settings(&self, s: &FleetSettings) -> AppResult<()> {
        let store = self.0.deps.store.clone();
        let value = serde_json::to_value(s)
            .map_err(|e| AppError::Invalid(format!("fleet settings: {e}")))?;
        tokio::task::spawn_blocking(move || store.kv_set(SETTINGS_KEY, &value))
            .await
            .map_err(AppError::join)??;
        Ok(())
    }

    /// This device's name as others see it.
    pub(crate) async fn fleet_name(&self, s: &FleetSettings) -> String {
        if let Some(n) = s.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
            return n.to_string();
        }
        self.0
            .fleet
            .machine_name
            .get_or_init(|| async {
                tokio::task::spawn_blocking(machine_name)
                    .await
                    .unwrap_or_else(|_| "Theodore device".into())
            })
            .await
            .clone()
    }

    /// The device key, made and stored in the keychain on first use. An
    /// unreadable stored key is an error, never silently replaced: a new
    /// key is a new device to the cloud and to every device that trusts
    /// this one.
    pub(crate) async fn fleet_key(&self) -> AppResult<Arc<DeviceKey>> {
        self.0
            .fleet
            .key
            .get_or_try_init(|| async {
                let secrets = self.0.deps.secrets.clone();
                tokio::task::spawn_blocking(move || -> AppResult<Arc<DeviceKey>> {
                    let stored = secrets
                        .get(theodore_secrets::FLEET_DEVICE_KEY)
                        .map_err(|e| AppError::Invalid(e.to_string()))?;
                    if let Some(s) = stored {
                        return DeviceKey::from_secret(&s)
                            .map(Arc::new)
                            .map_err(|e| AppError::Invalid(format!("the fleet device key: {e}")));
                    }
                    let key = DeviceKey::generate()
                        .map_err(|e| AppError::Invalid(format!("the fleet device key: {e}")))?;
                    secrets
                        .set(theodore_secrets::FLEET_DEVICE_KEY, key.to_secret())
                        .map_err(|e| AppError::Invalid(e.to_string()))?;
                    tracing::info!("made this device's fleet key");
                    Ok(Arc::new(key))
                })
                .await
                .map_err(AppError::join)?
            })
            .await
            .cloned()
    }

    /// Projects a remote request may start a space in: every ready one.
    pub(crate) async fn fleet_projects(&self) -> Vec<ProjectRef> {
        let store = self.0.deps.store.clone();
        let rows = tokio::task::spawn_blocking(move || store.all(models::PROJECT))
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();
        let mut out: Vec<ProjectRef> = rows
            .into_iter()
            .filter(|r| !r.archived)
            .filter_map(|r| serde_json::from_value::<Project>(r.data).ok())
            .filter(|p| p.status == ProjectStatus::Ready)
            .map(|p| ProjectRef {
                name: if p.repo.host == HostKind::Local {
                    p.repo.name.clone()
                } else {
                    p.repo.slug()
                },
                id: p.id,
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    pub(crate) async fn fleet_info(&self, s: &FleetSettings) -> DeviceInfo {
        let mut info = DeviceInfo {
            name: self.fleet_name(s).await,
            os: if cfg!(target_os = "macos") {
                DeviceOs::Macos
            } else if cfg!(target_os = "windows") {
                DeviceOs::Windows
            } else {
                DeviceOs::Linux
            },
            kind: self.fleet_kind(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            projects: if s.accept_remote {
                self.fleet_projects().await
            } else {
                Vec::new()
            },
            accepts_remote: s.accept_remote,
            max_mode: s.max_mode,
            agents: if s.accept_remote {
                self.fleet_agents().await
            } else {
                Vec::new()
            },
            mcp_auto: self.fleet_mcp_autos(s),
        };
        info.fit_agents();
        info
    }

    pub(crate) fn fleet_cursors(&self) -> Vec<SpaceCursor> {
        let mut out: Vec<SpaceCursor> = self
            .fleet()
            .hosted
            .values()
            .map(|h| SpaceCursor {
                space: h.row.space.clone(),
                seq: h.data.track.seq,
            })
            .collect();
        out.sort_by(|a, b| a.space.cmp(&b.space));
        out
    }

    /// Tells the cloud what changed about this device (projects, settings,
    /// hosted spaces); also what the next hello says.
    pub(crate) async fn fleet_announce(&self) {
        // Nothing to tell without a link (fleet off, or not connected yet:
        // the next hello carries the info anyway).
        if self.fleet().link.is_none() {
            return;
        }
        let s = self.fleet_settings().await;
        let info = self.fleet_info(&s).await;
        let spaces = self.fleet_cursors();
        if let Some(link) = &self.fleet().link {
            let _ = link.commands.send(FleetCommand::Update { info, spaces });
        }
    }

    pub async fn fleet_set_settings(&self, req: FleetSettingsRequest) -> AppResult<FleetStatus> {
        {
            let _g = self.0.fleet.settings_lock.lock().await;
            let mut after = self.fleet_settings().await;
            if let Some(v) = req.enabled {
                after.enabled = v;
            }
            if let Some(v) = req.accept_remote {
                after.accept_remote = v;
            }
            if let Some(m) = req.max_mode {
                after.max_mode = fleet_mode(m);
            }
            if let Some(n) = req.name {
                let n = n.trim();
                if n.chars().count() > 64 {
                    return Err(AppError::Invalid(
                        "a device name is at most 64 characters".into(),
                    ));
                }
                after.name = (!n.is_empty()).then(|| n.to_string());
            }
            self.fleet_save_settings(&after).await?;
        }
        // Settings changed: a link that failed for good may try again; one
        // that stays hears the new info.
        self.fleet().fatal_at = None;
        self.fleet_reconcile().await;
        self.fleet_announce().await;
        let status = self.fleet_status().await?;
        self.emit(Ephemeral::FleetStatus {
            status: status.clone(),
        });
        Ok(status)
    }

    /// Pins (or unpins) a device's key. Trusting pins exactly the key the
    /// user compared (`req.public_key`), and only while the cloud still
    /// lists that key for the device.
    pub async fn fleet_trust_device(&self, req: FleetTrustRequest) -> AppResult<FleetStatus> {
        let asked = {
            let _g = self.0.fleet.settings_lock.lock().await;
            let mut s = self.fleet_settings().await;
            let pin = if req.trusted {
                let compared = req.public_key.as_deref().ok_or_else(|| {
                    AppError::Invalid("trusting a device needs the key you compared".into())
                })?;
                let listed = self
                    .fleet()
                    .devices
                    .iter()
                    .find(|d| d.device_id == req.device_id)
                    .cloned()
                    .ok_or_else(|| {
                        AppError::NotFound(format!(
                            "device {} isn't in this organization's fleet",
                            req.device_id
                        ))
                    })?;
                if listed.public_key != compared {
                    return Err(AppError::Invalid(format!(
                        "{}'s key changed since you compared its fingerprint: compare it again",
                        listed.info.name
                    )));
                }
                if theodore_fleet_protocol::unb64(compared).is_none_or(|k| k.len() != 32) {
                    return Err(AppError::Invalid("that device's key is malformed".into()));
                }
                // Trusted again: auto mode starts off.
                Some(TrustedDevice {
                    device_id: listed.device_id,
                    public_key: compared.to_string(),
                    name: pin_name(&listed.info.name),
                    kind: Some(kind_str(listed.info.kind).to_string()),
                    auto: McpAuto::Off,
                    auto_until_ms: None,
                })
            } else {
                None
            };
            s.trusted_devices.retain(|t| t.device_id != req.device_id);
            s.trusted_devices.extend(pin);
            // Untrusted: it follows this device's spaces no more either.
            let asked = !req.trusted && s.delegates.contains(&req.device_id);
            if !req.trusted {
                s.delegates.retain(|d| *d != req.device_id);
            }
            self.fleet_save_settings(&s).await?;
            asked
        };
        if !req.trusted {
            self.fleet_revoke_if_held(&req.device_id, asked).await;
        }
        tracing::info!(device = %req.device_id, trusted = req.trusted, "fleet trust changed");
        let status = self.fleet_status().await?;
        self.emit(Ephemeral::FleetStatus {
            status: status.clone(),
        });
        Ok(status)
    }

    /// Forgets another of the user's devices (lost, replaced): the cloud
    /// drops it, and it's no longer trusted here. Only an offline one: the
    /// cloud refuses an online device (`fleet.invalid`), so it's refused
    /// here first, saying why.
    pub async fn fleet_remove_device(&self, device_id: &str) -> AppResult<FleetStatus> {
        let me = self.fleet_ready()?;
        if me == device_id {
            return Err(AppError::Invalid(
                "this device can't remove itself: turn the fleet off instead".into(),
            ));
        }
        let listed = self
            .fleet()
            .devices
            .iter()
            .find(|d| d.device_id == device_id)
            .cloned()
            .ok_or_else(|| {
                AppError::NotFound(format!(
                    "device {device_id} isn't in this organization's fleet"
                ))
            })?;
        if listed.online {
            return Err(AppError::Invalid(format!(
                "{} is online: only an offline device can be removed (quit Theodore on it, or \
                 turn its fleet off, first)",
                listed.info.name
            )));
        }
        let asked = {
            let _g = self.0.fleet.settings_lock.lock().await;
            let mut s = self.fleet_settings().await;
            s.trusted_devices.retain(|t| t.device_id != device_id);
            let asked = s.delegates.iter().any(|d| d == device_id);
            s.delegates.retain(|d| d != device_id);
            self.fleet_save_settings(&s).await?;
            asked
        };
        self.fleet_revoke_if_held(device_id, asked).await;
        if !self.fleet_send_msg(ClientMessage::RemoveDevice {
            device_id: device_id.to_string(),
        }) {
            return Err(AppError::Invalid("not connected to the fleet".into()));
        }
        tracing::info!(device = %device_id, "asked the fleet to remove a device");
        let status = self.fleet_status().await?;
        self.emit(Ephemeral::FleetStatus {
            status: status.clone(),
        });
        Ok(status)
    }

    /// `device_adopted{device, previous}` (protocol 11, docs/fleet.md "A
    /// device id changes"): one of the user's devices took over an earlier
    /// id of its own. On the cloud's word, and bounded by what the cloud
    /// already decides (it assigns ids and routes): the spaces hosted here
    /// for `previous` are `device`'s now, which lets it steer them only once
    /// it is pinned here like any origin. The pin and the delegation follow
    /// only when `device` lists the very same key `previous` was pinned
    /// with: the key is the trust, the id is the cloud's.
    pub(crate) async fn fleet_on_device_adopted(&self, device: &str, previous: &str) {
        if !valid_device_id(device) || !valid_device_id(previous) || device == previous {
            tracing::warn!("dropped a device_adopted that doesn't name two device ids");
            return;
        }
        let me = self.fleet().device_id.clone();
        if me.as_deref() == Some(device) || me.as_deref() == Some(previous) {
            return;
        }
        let moved: Vec<FleetHostedRow> = {
            let mut mem = self.fleet();
            let mut rows = Vec::new();
            for h in mem.hosted.values_mut() {
                if h.row.origin_device == previous {
                    h.row.origin_device = device.to_string();
                    h.view.origin_device = device.to_string();
                    rows.push(h.row.clone());
                }
            }
            for origin in mem.hosting.values_mut() {
                if origin == previous {
                    *origin = device.to_string();
                }
            }
            rows
        };
        for row in &moved {
            self.fleet_put_hosted(row).await;
        }
        let (pinned, delegated) = {
            let _g = self.0.fleet.settings_lock.lock().await;
            let mut s = self.fleet_settings().await;
            let listed_key = self
                .fleet()
                .devices
                .iter()
                .find(|d| d.device_id == device)
                .map(|d| d.public_key.clone());
            let same_key = s
                .trusted_devices
                .iter()
                .find(|t| t.device_id == previous)
                .is_some_and(|t| listed_key.as_deref() == Some(t.public_key.as_str()));
            let delegated = same_key && s.delegates.iter().any(|d| d == previous);
            if same_key {
                // The pin moves as it is (auto mode included: the same key).
                s.trusted_devices.retain(|t| t.device_id != device);
                for t in &mut s.trusted_devices {
                    if t.device_id == previous {
                        t.device_id = device.to_string();
                    }
                }
                s.delegates.retain(|d| d != previous && d != device);
                if delegated {
                    s.delegates.push(device.to_string());
                }
                if let Err(e) = self.fleet_save_settings(&s).await {
                    tracing::warn!(error.code = e.code(), error = %e, "couldn't move a pin to an adopted device id");
                }
            }
            (same_key, delegated)
        };
        if delegated {
            self.fleet_send_delegation(previous, true).await;
            self.fleet_send_delegation(device, false).await;
        }
        tracing::info!(
            device,
            previous,
            spaces = moved.len(),
            pinned,
            delegated,
            "a fleet device took over an earlier id of its own"
        );
        if !moved.is_empty() || pinned {
            self.fleet_emit_status().await;
        }
    }

    /// The pin of `device`, if this device trusts it.
    pub(crate) async fn fleet_pinned(&self, device: &str) -> Option<TrustedDevice> {
        self.fleet_settings()
            .await
            .trusted_devices
            .into_iter()
            .find(|t| t.device_id == device)
    }

    /// Whether `local` runs here for another device: hosted for it, or a
    /// sub-space of a space that is (its children are the origin's too,
    /// with the same limits).
    pub(crate) async fn fleet_hosts_local(&self, local: &str) -> bool {
        self.fleet_hosted_origin(local).await.is_some()
    }

    /// The hosted row `local` is, or sits under (its nearest ancestor
    /// hosted here for another device), once mapped.
    pub(crate) async fn fleet_hosted_root(&self, local: &str) -> Option<FleetHostedRow> {
        match self.fleet_hosted_walk(local).await? {
            HostedAt::Row(r) => Some(r),
            HostedAt::Making(_) => None,
        }
    }

    /// The device `local` runs here for ([`Self::fleet_hosts_local`]):
    /// hosted for it (or being made for it), or under such a space.
    pub(crate) async fn fleet_hosted_origin(&self, local: &str) -> Option<String> {
        Some(match self.fleet_hosted_walk(local).await? {
            HostedAt::Row(r) => r.origin_device,
            HostedAt::Making(origin) => origin,
        })
    }

    /// From `local` up its parents to the first space hosted here (or
    /// being made) for another device.
    async fn fleet_hosted_walk(&self, local: &str) -> Option<HostedAt> {
        let (rows, making): (Vec<FleetHostedRow>, HashMap<String, String>) = {
            let mem = self.fleet();
            (
                mem.hosted.values().map(|h| h.row.clone()).collect(),
                mem.hosting.clone(),
            )
        };
        let rows = if rows.is_empty() {
            let store = self.0.deps.store.clone();
            tokio::task::spawn_blocking(move || store.fleet_hosted_all())
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default()
        } else {
            rows
        };
        if rows.is_empty() && making.is_empty() {
            return None;
        }
        let mut at = local.to_string();
        // A tree is a few levels deep; a few more steps end any loop.
        for _ in 0..8 {
            if let Some(origin) = making.get(&at) {
                return Some(HostedAt::Making(origin.clone()));
            }
            if let Some(r) = rows.iter().find(|r| r.local_space == at) {
                return Some(HostedAt::Row(r.clone()));
            }
            let parent = self.space_row_any(&at).await.ok()?.parent?;
            at = parent.space;
        }
        None
    }

    /// The stable fleet id spaces started by local space `local`'s agent
    /// have as their parent (made once, then kept).
    pub(crate) async fn fleet_parent_id(&self, local: &str) -> String {
        let store = self.0.deps.store.clone();
        let key = parent_id_key(local);
        tokio::task::spawn_blocking(move || {
            if let Ok(Some(v)) = store.kv_get(&key)
                && let Some(id) = v.as_str()
            {
                return id.to_string();
            }
            let id = format!("rs_{}", uuid::Uuid::new_v4().simple());
            if let Err(e) = store.kv_set(&key, &serde_json::json!(id)) {
                tracing::warn!(error.code = e.code(), error = %e, "couldn't keep a fleet parent id");
            }
            id
        })
        .await
        .unwrap_or_else(|_| format!("rs_{}", uuid::Uuid::new_v4().simple()))
    }

    // ── replays ─────────────────────────────────────────────────────────

    /// Reads the persisted seen requests once per process.
    pub(crate) async fn fleet_load_seen(&self) {
        self.0
            .fleet
            .seen_loaded
            .get_or_init(|| async {
                let store = self.0.deps.store.clone();
                let rows = tokio::task::spawn_blocking(move || store.fleet_seen_all())
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .unwrap_or_default();
                let mut mem = self.fleet();
                for (req_id, at, done) in rows {
                    let state = if done { Seen::Done } else { Seen::Claiming };
                    mem.seen.entry(req_id).or_insert((at, state));
                }
            })
            .await;
    }

    /// Records `req_id` as `state`, here and in the store; `false` when
    /// the store didn't keep it (then nothing may run on it).
    #[must_use]
    pub(crate) async fn fleet_mark_seen(&self, req_id: &str, issued_at: i64, state: Seen) -> bool {
        let now = self.0.deps.clock.now();
        let forget_before = now.saturating_sub(REPLAY_MEMORY_MS as i64);
        {
            let mut mem = self.fleet();
            mem.seen.retain(|_, (at, _)| *at >= forget_before);
            let e = mem
                .seen
                .entry(req_id.to_string())
                .or_insert((issued_at, state));
            if state == Seen::Done {
                e.1 = Seen::Done;
            }
        }
        let store = self.0.deps.store.clone();
        let id = req_id.to_string();
        let done = state == Seen::Done;
        let kept = tokio::task::spawn_blocking(move || {
            store.fleet_seen_put(&id, issued_at, done, forget_before)
        })
        .await;
        match kept {
            Ok(Ok(())) => true,
            Ok(Err(e)) => {
                tracing::warn!(error.code = e.code(), error = %e, "couldn't keep a seen fleet request");
                false
            }
            Err(e) => {
                tracing::warn!(error.code = "app.internal", error = %e, "couldn't keep a seen fleet request");
                false
            }
        }
    }

    // ── status ──────────────────────────────────────────────────────────

    /// A cloud and an account are configured, and this build has a fleet.
    async fn fleet_available(&self) -> bool {
        self.0.deps.fleet.enabled()
            && self
                .account_config()
                .await
                .is_some_and(|c| c.cloud_url.is_some())
    }

    pub async fn fleet_status(&self) -> AppResult<FleetStatus> {
        let s = self.fleet_settings().await;
        let available = self.fleet_available().await;
        let fp = if available {
            match self.fleet_key().await {
                Ok(k) => fingerprint(&k.public_key()),
                Err(e) => {
                    tracing::warn!(error.code = e.code(), error = %e, "no fleet device key");
                    String::new()
                }
            }
        } else {
            String::new()
        };
        let name = self.fleet_name(&s).await;
        let now = self.0.deps.clock.now().max(0) as u64;
        // The pin of a listed `mcp` device, for its auto mode.
        let pin_of = |d: &DeviceSummary| {
            s.trusted_devices
                .iter()
                .find(|t| t.device_id == d.device_id && t.public_key == d.public_key)
                .filter(|t| {
                    d.info.kind == DeviceKind::Mcp
                        || t.kind.as_deref() == Some(kind_str(DeviceKind::Mcp))
                })
        };
        let mem = self.fleet();
        let devices = mem
            .devices
            .iter()
            .map(|d| FleetDevice {
                device_id: d.device_id.clone(),
                name: d.info.name.clone(),
                os: match d.info.os {
                    DeviceOs::Macos => FleetOs::Macos,
                    DeviceOs::Linux => FleetOs::Linux,
                    DeviceOs::Windows => FleetOs::Windows,
                    DeviceOs::Ios => FleetOs::Ios,
                    DeviceOs::Android => FleetOs::Android,
                    DeviceOs::Other => FleetOs::Other,
                },
                kind: kind_str(d.info.kind).into(),
                online: d.online,
                last_seen_ms: d.last_seen_ms,
                projects: d
                    .info
                    .projects
                    .iter()
                    .map(|p| FleetProject {
                        id: p.id.clone(),
                        name: p.name.clone(),
                    })
                    .collect(),
                accepts_remote: d.info.accepts_remote,
                max_mode: space_mode(d.info.max_mode),
                fingerprint: fingerprint(&d.public_key),
                public_key: d.public_key.clone(),
                trusted: s
                    .trusted_devices
                    .iter()
                    .any(|t| t.device_id == d.device_id && t.public_key == d.public_key),
                this_device: mem.device_id.as_deref() == Some(d.device_id.as_str()),
                delegated: wants_delegate(&s, d),
                delegation_live: mem.device_id.as_deref().is_some_and(|me| {
                    mem.delegations
                        .iter()
                        .any(|g| g.origin_device == me && g.delegate_device == d.device_id)
                }),
                agents: crate::usecases::fleet_agents::ui_agents(&d.info.agents),
                auto: pin_of(d).map_or(FleetAuto::Off, |p| ui_auto(p.auto_at(now))),
                auto_until_ms: pin_of(d).and_then(|p| p.auto_until_at(now)),
                mcp_auto: if d.info.kind.hosts() {
                    d.info
                        .mcp_auto
                        .iter()
                        .take(MCP_AUTO_LISTED)
                        .map(|a| FleetMcpAuto {
                            device_id: a.device_id.clone(),
                            name: mem
                                .devices
                                .iter()
                                .find(|x| x.device_id == a.device_id)
                                .map_or_else(|| a.device_id.clone(), |x| pin_name(&x.info.name)),
                            auto: if a.until_ms.is_some_and(|u| u <= now) {
                                FleetAuto::Off
                            } else {
                                ui_auto(a.auto)
                            },
                            until_ms: a.until_ms.filter(|u| *u > now),
                        })
                        .collect()
                } else {
                    Vec::new()
                },
            })
            .collect();
        let autos = s
            .trusted_devices
            .iter()
            .filter(|p| p.auto_at(now) != McpAuto::Off)
            .map(|p| FleetAutoOn {
                device_id: p.device_id.clone(),
                device_name: p.name.clone(),
                auto: ui_auto(p.auto_at(now)),
                until_ms: p.auto_until_at(now),
            })
            .collect();
        Ok(FleetStatus {
            available,
            enabled: s.enabled,
            connected: mem.connected,
            device_id: mem.device_id.clone(),
            name,
            fingerprint: fp,
            accept_remote: s.accept_remote,
            max_mode: space_mode(s.max_mode),
            devices,
            error: if s.enabled && !mem.connected {
                mem.error.clone()
            } else {
                None
            },
            autos,
        })
    }

    pub(crate) async fn fleet_emit_status(&self) {
        if let Ok(status) = self.fleet_status().await {
            self.emit(Ephemeral::FleetStatus { status });
        }
    }

    // ── lifecycle ───────────────────────────────────────────────────────

    /// Spawned by `Core::start`: picks up hosted spaces and connects when
    /// the fleet is on.
    pub(crate) async fn fleet_resume(&self) {
        self.fleet_auto_resume().await;
        if !self.fleet_settings().await.enabled {
            return;
        }
        self.fleet_load_hosted().await;
        self.fleet_reconcile().await;
    }

    /// The account signed in, out, refreshed or moved organization.
    pub(crate) fn fleet_account_changed(&self) {
        let core = self.clone();
        tokio::spawn(async move { core.fleet_reconcile().await });
    }

    async fn fleet_wanted(&self) -> Option<Wanted> {
        if !self.0.deps.fleet.enabled() || !self.fleet_settings().await.enabled {
            return None;
        }
        let cloud_url = self.account_config().await?.cloud_url?;
        let session = self.account_session()?;
        let org = session.organization_id.clone()?;
        // Refreshed first when about to expire, like any other caller.
        let token = self.account_access_token().await.ok().flatten()?;
        // The refresh may have moved the session along, or a switch made
        // another account active: read it again.
        let session = self.account_session()?;
        let org = session.organization_id.unwrap_or(org);
        Some(Wanted {
            user: session.user.id,
            org,
            cloud_url,
            token,
            generation: self.account_generation(),
        })
    }

    /// Brings the link in line with the settings and the account.
    pub(crate) async fn fleet_reconcile(&self) {
        let _one = self.0.fleet.reconcile_lock.lock().await;
        let wanted = self.fleet_wanted().await;
        enum Step {
            Nothing,
            Close,
            Start(Wanted),
        }
        let step = {
            let mut mem = self.fleet();
            match (wanted, mem.link.as_mut()) {
                (None, Some(_)) => Step::Close,
                (None, None) => Step::Nothing,
                (Some(w), Some(link))
                    if link.user == w.user
                        && link.org == w.org
                        && link.cloud_url == w.cloud_url =>
                {
                    if link.token != w.token {
                        let _ = link.commands.send(FleetCommand::Reauth(w.token.clone()));
                        link.token = w.token;
                    }
                    Step::Nothing
                }
                (Some(w), Some(_)) => {
                    // Another account, organization or cloud: a new hub,
                    // or the same hub as another user.
                    if let Some(old) = mem.link.take() {
                        let _ = old.commands.send(FleetCommand::Close);
                    }
                    Step::Start(w)
                }
                (Some(w), None) => {
                    if mem.fatal_at.as_ref() == Some(&(w.generation, w.org.clone())) {
                        Step::Nothing
                    } else {
                        Step::Start(w)
                    }
                }
            }
        };
        match step {
            Step::Nothing => {}
            Step::Close => {
                self.fleet_close_link();
                self.fleet_emit_status().await;
            }
            Step::Start(w) => {
                self.fleet_close_link();
                if let Err(e) = self.fleet_start_link(w).await {
                    tracing::warn!(error.code = e.code(), error = %e, "couldn't start the fleet link");
                    self.fleet().error = Some(e.to_string());
                }
                self.fleet_emit_status().await;
            }
        }
    }

    /// Ends the link (if any) and forgets the connection's state.
    fn fleet_close_link(&self) {
        let mut mem = self.fleet();
        if let Some(link) = mem.link.take() {
            let _ = link.commands.send(FleetCommand::Close);
        }
        mem.connected = false;
        // Another organization's hub gives another id.
        mem.device_id = None;
        mem.devices.clear();
        mem.drop_claims();
        mem.delegations.clear();
        mem.delegations_due = false;
        mem.revoked.clear();
        mem.error = None;
        self.0.fleet.tools_on.store(false, Ordering::SeqCst);
    }

    async fn fleet_start_link(&self, w: Wanted) -> AppResult<()> {
        self.fleet_load_hosted().await;
        // Subscribed again on the welcome.
        self.fleet_load_followed().await;
        let key = self.fleet_key().await?;
        let s = self.fleet_settings().await;
        let info = self.fleet_info(&s).await;
        let store = self.0.deps.store.clone();
        let id_key = device_id_key(&w.org);
        let device_id = tokio::task::spawn_blocking(move || store.kv_get(&id_key))
            .await
            .ok()
            .and_then(Result::ok)
            .flatten()
            .and_then(|v| v.as_str().map(str::to_string));
        let cfg = FleetConnect {
            cloud_url: w.cloud_url.clone(),
            access_token: w.token.clone(),
            device_id,
            key,
            info,
            spaces: self.fleet_cursors(),
        };
        let link = self.0.deps.fleet.start(cfg);
        let id = self.0.fleet.next_link.fetch_add(1, Ordering::SeqCst) + 1;
        {
            let mut mem = self.fleet();
            mem.link = Some(Link {
                id,
                commands: link.commands,
                user: w.user.clone(),
                org: w.org.clone(),
                cloud_url: w.cloud_url,
                token: w.token,
            });
            mem.error = None;
        }
        tracing::info!(organization = %w.org, "fleet link started");
        let core = self.clone();
        let mut inbound = link.inbound;
        tokio::spawn(async move {
            loop {
                let ev = tokio::select! {
                    _ = core.0.shutdown.cancelled() => return,
                    ev = inbound.recv() => ev,
                };
                let Some(ev) = ev else { return };
                if !core.fleet_inbound(id, &w.org, w.generation, ev).await {
                    return;
                }
            }
        });
        // An agent signed in or out in a terminal reaches the other
        // devices: what this one offers is checked again while it's linked.
        let core = self.clone();
        tokio::spawn(async move {
            let every = std::time::Duration::from_millis(
                crate::usecases::fleet_agents::CATALOG_TTL_MS as u64,
            );
            let clock = core.0.deps.clock.clone();
            loop {
                tokio::select! {
                    _ = core.0.shutdown.cancelled() => return,
                    _ = clock.sleep(every) => {}
                }
                if core.fleet().link.as_ref().map(|l| l.id) != Some(id) {
                    return;
                }
                if core.fleet_settings().await.accept_remote {
                    core.fleet_recheck_agents().await;
                }
            }
        });
        Ok(())
    }

    /// Sends `msg` on the link, if there is one; the adapter keeps replies
    /// and `ask_resolved` for after a reconnect and drops the rest.
    pub(crate) fn fleet_send_msg(&self, msg: ClientMessage) -> bool {
        match &self.fleet().link {
            Some(link) => link.commands.send(FleetCommand::Send(msg)).is_ok(),
            None => false,
        }
    }

    /// One event of link `id`; `false` once the link is over.
    async fn fleet_inbound(&self, id: u64, org: &str, generation: u64, ev: FleetInbound) -> bool {
        if self.fleet().link.as_ref().map(|l| l.id) != Some(id) {
            return false;
        }
        match ev {
            FleetInbound::Connected {
                device_id,
                generation: conn_generation,
                resume,
            } => {
                {
                    let mut mem = self.fleet();
                    mem.connected = true;
                    mem.device_id = Some(device_id.clone());
                    mem.generation = conn_generation;
                    mem.error = None;
                    // The cloud may have lost them: signed again once the
                    // device list comes.
                    mem.delegations_due = true;
                    mem.revoked.clear();
                }
                self.0.fleet.tools_on.store(true, Ordering::SeqCst);
                let store = self.0.deps.store.clone();
                let key = device_id_key(org);
                let value = serde_json::json!(device_id);
                let _ = tokio::task::spawn_blocking(move || store.kv_set(&key, &value)).await;
                tracing::info!(device = %device_id, "fleet connected");
                self.fleet_on_connected(resume);
                self.fleet_emit_status().await;
            }
            FleetInbound::Disconnected { reason, .. } => {
                {
                    let mut mem = self.fleet();
                    mem.connected = false;
                    mem.drop_claims();
                    mem.error = Some(reason);
                }
                self.0.fleet.tools_on.store(false, Ordering::SeqCst);
                self.fleet_emit_status().await;
            }
            FleetInbound::Fatal { code, message } => {
                tracing::warn!(error.code = %code, error = %message, "the fleet refused this device");
                let message = if code == codes::REMOVED {
                    // Gone from the cloud: the next link joins as a new device.
                    let store = self.0.deps.store.clone();
                    let key = device_id_key(org);
                    let _ = tokio::task::spawn_blocking(move || {
                        store.kv_set(&key, &serde_json::Value::Null)
                    })
                    .await;
                    "another of your devices removed this one from the fleet: turn the fleet \
                     off and on to join again as a new device"
                        .to_string()
                } else {
                    message
                };
                {
                    let mut mem = self.fleet();
                    mem.link = None;
                    mem.connected = false;
                    mem.drop_claims();
                    mem.error = Some(if message.is_empty() {
                        code
                    } else {
                        format!("{message} ({code})")
                    });
                    mem.fatal_at = Some((generation, org.to_string()));
                }
                self.0.fleet.tools_on.store(false, Ordering::SeqCst);
                self.fleet_emit_status().await;
                return false;
            }
            FleetInbound::Message(m) => self.fleet_message(m).await,
        }
        true
    }

    async fn fleet_message(&self, m: ServerMessage) {
        match m {
            ServerMessage::Devices { mut devices } => {
                let listed = devices.len();
                devices.retain(|d| valid_device_id(&d.device_id));
                if devices.len() < listed {
                    tracing::warn!(
                        dropped = listed - devices.len(),
                        "dropped fleet devices whose id isn't one the cloud issues"
                    );
                }
                self.fleet().devices = devices;
                self.fleet_resend_delegations().await;
                self.fleet_emit_status().await;
            }
            ServerMessage::Request { envelope, .. } => self.fleet_on_request(envelope).await,
            ServerMessage::ClaimResult {
                req_id,
                claimed,
                rejection,
            } => self.fleet_on_claim(&req_id, claimed, rejection),
            ServerMessage::Reply { envelope } => self.fleet_on_reply(envelope).await,
            ServerMessage::Refused { req_id, code, .. } => self.fleet_on_refused(&req_id, &code),
            ServerMessage::SpaceEvent { envelope } => self.fleet_on_event(envelope).await,
            ServerMessage::SpaceGap { space, from, to } => self.fleet_on_gap(&space, from, to),
            ServerMessage::Ask { envelope, via } => self.fleet_on_ask(envelope, via).await,
            ServerMessage::Dismiss { ask_id, .. } => {
                self.fleet().asks.remove(&ask_id);
                self.emit(Ephemeral::FleetAskDismissed { ask_id });
            }
            ServerMessage::Delegations { list } => self.fleet_on_delegations(list).await,
            ServerMessage::Confirm { envelope } => self.fleet_on_remote_confirm(envelope).await,
            ServerMessage::ConfirmDismissed { confirm_id } => {
                self.fleet_on_confirm_dismissed(&confirm_id)
            }
            ServerMessage::DeviceAdopted { device, previous } => {
                self.fleet_on_device_adopted(&device, &previous).await
            }
            // Challenge and welcome are the adapter's.
            ServerMessage::Challenge { .. } | ServerMessage::Welcome { .. } => {}
            ServerMessage::Error { code, message } => {
                tracing::warn!(error.code = %code, error = %message, "the fleet cloud reported an error");
                // The cloud's text is unsigned: the user hears our words.
                // `fleet.invalid` after the welcome: a refused removal (an
                // online device) or delegation; `fleet.busy` an event over the
                // budget, replayed from the journal on the next welcome.
                if code == codes::INVALID {
                    self.emit(Ephemeral::Toast {
                        level: theodore_contract::ToastLevel::Warn,
                        text: "The fleet refused that (fleet.invalid). Removing a device works \
                               only while it's offline; sending questions to a device needs \
                               it trusted here"
                            .into(),
                    });
                }
            }
        }
    }

    /// After a welcome: hosted spaces replay what the cloud lacks, remote
    /// ones are subscribed again from the last seq seen here.
    fn fleet_on_connected(&self, resume: BTreeMap<String, u64>) {
        self.fleet_clear_remote_confirms();
        let subs: Vec<(String, u64)> = {
            let mut mem = self.fleet();
            let me = mem.device_id.clone().unwrap_or_default();
            mem.outbound
                .iter_mut()
                .map(|(id, o)| {
                    // Followed again from the store before this device
                    // knew its id.
                    if o.view.origin_device.is_empty() {
                        o.view.origin_device = me.clone();
                    }
                    (id.clone(), o.last_seq)
                })
                .collect()
        };
        for (space, since) in subs {
            self.fleet_send_msg(ClientMessage::Subscribe { space, since });
        }
        self.fleet_observe(crate::usecases::fleet_host::ObserverCmd::Replay(resume));
    }

    pub async fn fleet_presence(
        &self,
        req: theodore_contract::FleetPresenceRequest,
    ) -> AppResult<()> {
        self.fleet_send_msg(ClientMessage::Presence {
            focused: req.focused,
            locked: false,
            idle_ms: req.idle_ms,
        });
        Ok(())
    }
}

/// Whether this device should be sending its spaces' questions to `d`:
/// asked for here, `d` is a phone, the web app or a desktop, and it's pinned with
/// the key the cloud lists now.
pub(crate) fn wants_delegate(s: &FleetSettings, d: &DeviceSummary) -> bool {
    follows(d.info.kind)
        && s.delegates.contains(&d.device_id)
        && s.trusted_devices
            .iter()
            .any(|t| t.device_id == d.device_id && t.public_key == d.public_key)
}

/// The machine's name: the Mac's computer name, else the host name.
fn machine_name() -> String {
    let run = |cmd: &str, args: &[&str]| -> Option<String> {
        let out = std::process::Command::new(cmd).args(args).output().ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!s.is_empty()).then_some(s)
    };
    if cfg!(target_os = "macos")
        && let Some(n) = run("/usr/sbin/scutil", &["--get", "ComputerName"])
    {
        return n;
    }
    run("hostname", &[])
        .map(|h| h.trim_end_matches(".local").to_string())
        .unwrap_or_else(|| "Theodore device".into())
}
