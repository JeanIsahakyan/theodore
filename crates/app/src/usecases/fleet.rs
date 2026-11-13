//! Fleet (docs/fleet.md): spaces across the user's devices, relayed by the
//! Theodore cloud. This file holds the state, the settings, the link's
//! lifecycle and the inbound dispatch; `fleet_host` is this device as a
//! target (trust gate, hosted spaces, journal), `fleet_origin` this device
//! as an origin (remote spaces started here, questions routed here),
//! `fleet_tools` the agent's tools.
//!
//! ```text
//! enabled + signed in + cloud URL + org ─▶ FleetPort::start ─▶ link
//!   account refresh ─▶ Reauth(token)       org switch ─▶ Close, new link
//!   sign-out / disable ─▶ Close            Fatal ─▶ error, no redial until
//!                                            sign-in, org or settings change
//! link ─▶ Connected | Message | Disconnected | Fatal ─▶ fleet_inbound
//! ```

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use theodore_contract::{
    Ephemeral, FleetDevice, FleetOs, FleetProject, FleetQuestion, FleetRemoteSpace,
    FleetSettingsRequest, FleetSpaceLine, FleetStatus, FleetTrustRequest, Project, ProjectStatus,
    SpaceMode, models,
};
use theodore_domain::HostKind;
use theodore_fleet_protocol::{
    ClientMessage, DeviceInfo, DeviceKey, DeviceKind, DeviceOs, DeviceSummary, FleetMode,
    ProjectRef, REPLAY_MEMORY_MS, RemoteRequest, ServerMessage, SpaceCursor, codes, fingerprint,
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

/// A pinned device (`fleet.trusted_devices`): the key the user compared
/// when trust was given here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct TrustedDevice {
    pub device_id: String,
    pub public_key: String,
    pub name: String,
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
}

impl Default for FleetSettings {
    fn default() -> Self {
        FleetSettings {
            enabled: false,
            accept_remote: false,
            max_mode: default_max_mode(),
            name: None,
            trusted_devices: Vec::new(),
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

/// A verified request waiting for its claim result, with the origin key
/// it verified against (checked again right before it runs).
pub(crate) struct Claimed {
    pub req: RemoteRequest,
    pub key: String,
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
    /// Starts past the gate, not hosted yet, by remote id.
    pub reserved: HashMap<String, Reserved>,
    /// By remote id.
    pub hosted: HashMap<String, Hosted>,
    /// Local spaces being made for another device, not mapped yet.
    pub hosting: std::collections::HashSet<String>,
    pub outbound: HashMap<String, Outbound>,
    pub replies: HashMap<String, PendingReply>,
    /// Questions from elsewhere routed here, by ask id, with the (pinned,
    /// verified) device that asked.
    pub asks: HashMap<String, (FleetQuestion, String)>,
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
    settings_lock: tokio::sync::Mutex<()>,
    pub(crate) hosted_loaded: tokio::sync::OnceCell<()>,
    /// The persisted seen requests, read once.
    pub(crate) seen_loaded: tokio::sync::OnceCell<()>,
    pub(crate) observer:
        std::sync::OnceLock<mpsc::UnboundedSender<crate::usecases::fleet_host::ObserverCmd>>,
    /// Wakes `fleet_wait` on any change to a remote space.
    pub(crate) changed: tokio::sync::Notify,
    /// Enabled and connected: the agent's fleet tools are listed.
    pub(crate) tools_on: AtomicBool,
    next_link: AtomicU64,
}

/// Wanted link: everything a reconcile needs.
struct Wanted {
    org: String,
    cloud_url: String,
    token: String,
    generation: u64,
}

impl Core {
    pub(crate) fn fleet(&self) -> std::sync::MutexGuard<'_, FleetMem> {
        self.0.fleet.mem.lock().unwrap_or_else(|p| p.into_inner())
    }

    // ── settings ────────────────────────────────────────────────────────

    pub(crate) async fn fleet_settings(&self) -> FleetSettings {
        let store = self.0.deps.store.clone();
        tokio::task::spawn_blocking(move || store.kv_get(SETTINGS_KEY))
            .await
            .ok()
            .and_then(Result::ok)
            .flatten()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    }

    async fn fleet_save_settings(&self, s: &FleetSettings) -> AppResult<()> {
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
        DeviceInfo {
            name: self.fleet_name(s).await,
            os: if cfg!(target_os = "macos") {
                DeviceOs::Macos
            } else {
                DeviceOs::Linux
            },
            kind: DeviceKind::Desktop,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            projects: if s.accept_remote {
                self.fleet_projects().await
            } else {
                Vec::new()
            },
            accepts_remote: s.accept_remote,
            max_mode: s.max_mode,
        }
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
        {
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
                Some(TrustedDevice {
                    device_id: listed.device_id,
                    public_key: compared.to_string(),
                    name: listed.info.name,
                })
            } else {
                None
            };
            s.trusted_devices.retain(|t| t.device_id != req.device_id);
            s.trusted_devices.extend(pin);
            self.fleet_save_settings(&s).await?;
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
        {
            let _g = self.0.fleet.settings_lock.lock().await;
            let mut s = self.fleet_settings().await;
            s.trusted_devices.retain(|t| t.device_id != device_id);
            self.fleet_save_settings(&s).await?;
        }
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

    /// The pin of `device`, if this device trusts it.
    pub(crate) async fn fleet_pinned(&self, device: &str) -> Option<TrustedDevice> {
        self.fleet_settings()
            .await
            .trusted_devices
            .into_iter()
            .find(|t| t.device_id == device)
    }

    /// Whether `local` is a space hosted here for another device.
    pub(crate) async fn fleet_hosts_local(&self, local: &str) -> bool {
        {
            let mem = self.fleet();
            if mem.hosting.contains(local)
                || mem.hosted.values().any(|h| h.row.local_space == local)
            {
                return true;
            }
        }
        let store = self.0.deps.store.clone();
        tokio::task::spawn_blocking(move || store.fleet_hosted_all())
            .await
            .ok()
            .and_then(Result::ok)
            .is_some_and(|rows| rows.iter().any(|r| r.local_space == local))
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
                },
                kind: match d.info.kind {
                    DeviceKind::Desktop => "desktop".into(),
                    DeviceKind::Daemon => "daemon".into(),
                },
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
        // The refresh may have moved the session along: read it again.
        let org = self
            .account_session()
            .and_then(|s| s.organization_id)
            .unwrap_or(org);
        Some(Wanted {
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
                (Some(w), Some(link)) if link.org == w.org && link.cloud_url == w.cloud_url => {
                    if link.token != w.token {
                        let _ = link.commands.send(FleetCommand::Reauth(w.token.clone()));
                        link.token = w.token;
                    }
                    Step::Nothing
                }
                (Some(w), Some(_)) => {
                    // Another organization or cloud: a new hub.
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
        mem.error = None;
        self.0.fleet.tools_on.store(false, Ordering::SeqCst);
    }

    async fn fleet_start_link(&self, w: Wanted) -> AppResult<()> {
        self.fleet_load_hosted().await;
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
            ServerMessage::Devices { devices } => {
                self.fleet().devices = devices;
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
            // Challenge and welcome are the adapter's.
            ServerMessage::Challenge { .. } | ServerMessage::Welcome { .. } => {}
            ServerMessage::Error { code, message } => {
                tracing::warn!(error.code = %code, error = %message, "the fleet cloud reported an error");
                // The cloud's text is unsigned: the user hears our words.
                // `fleet.invalid` after the welcome is a refused removal (an
                // online device); `fleet.busy` an event over the budget,
                // replayed from the journal on the next welcome.
                if code == codes::INVALID {
                    self.emit(Ephemeral::Toast {
                        level: theodore_contract::ToastLevel::Warn,
                        text: "The fleet refused that (fleet.invalid): a device can be removed \
                               only while it's offline"
                            .into(),
                    });
                }
            }
        }
    }

    /// After a welcome: hosted spaces replay what the cloud lacks, remote
    /// ones are subscribed again from the last seq seen here.
    fn fleet_on_connected(&self, resume: BTreeMap<String, u64>) {
        let subs: Vec<(String, u64)> = self
            .fleet()
            .outbound
            .iter()
            .map(|(id, o)| (id.clone(), o.last_seq))
            .collect();
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
