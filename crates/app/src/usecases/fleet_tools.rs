//! The fleet tools of `space-tools` (docs/fleet.md "Agents use it too"):
//! an agent in a space here starts, steers and reads spaces on the user's
//! other devices, with this device's authority. Listed only while the
//! fleet is on and connected.
//!
//! ```text
//! caller hosted here for the fleet ─▶ fleet_devices / read / wait only:
//!                                     no trust passes through it
//! caller of this device's own, turn in Edit or Run
//!   ─▶ fleet_start_space on a device pinned here, mode ≤ the turn's,
//!      parent = the caller's stable fleet id, depth 1, ≤ MAX_CHILDREN
//!   ─▶ fleet_send (mode ≤ the turn's) / fleet_stop / fleet_read /
//!      fleet_wait on spaces it (or its children) started, nothing else
//! ```

use std::time::Duration;

use theodore_contract::{FleetRemoteSpace, FleetSendRequest, FleetSpaceStatus, SpaceMode};
use theodore_fleet_protocol::{DeviceSummary, MAX_CHILDREN, MAX_DEPTH};
use theodore_ports::{
    FLEET_WAIT_MAX_MS, FleetToolDevice, FleetToolLine, FleetToolProject, FleetToolRead,
    FleetToolSpace, FleetToolWait, SpaceToolError,
};

use crate::core::Core;
use crate::error::AppError;
use crate::usecases::fleet::{FleetMem, FleetSettings, mode_str};
use crate::usecases::fleet_origin::settled;

/// How long `fleet_start_space` waits for the other device to say yes.
const START_WAIT: Duration = Duration::from_secs(20);

/// Told to the agent when its turn has the fleet tools.
pub(crate) const FLEET_TOOLS_PROMPT: &str = "The user's other devices are reachable \
     through the fleet tools: fleet_devices lists the trusted ones that take remote spaces \
     (their projects and highest mode); fleet_start_space starts a space with a goal in one \
     of their projects; fleet_send sends it a message, fleet_wait waits until spaces settle, \
     fleet_read reads a space's replies and history, fleet_stop stops its turn. Use them \
     only when the user asks for work on another device, or to split work they asked for \
     across devices.";

fn unavailable(e: AppError) -> SpaceToolError {
    SpaceToolError::Unavailable(e.to_string())
}

fn refused(why: impl Into<String>) -> SpaceToolError {
    SpaceToolError::Unavailable(why.into())
}

fn status_word(s: FleetSpaceStatus) -> &'static str {
    match s {
        FleetSpaceStatus::Starting => "starting",
        FleetSpaceStatus::Running => "running",
        FleetSpaceStatus::Idle => "idle",
        FleetSpaceStatus::Waiting => "waiting",
        FleetSpaceStatus::Stopped => "stopped",
        FleetSpaceStatus::Failed => "failed",
    }
}

pub(crate) fn tool_space(v: &FleetRemoteSpace) -> FleetToolSpace {
    FleetToolSpace {
        space: v.space.clone(),
        device: v.host_name.clone(),
        name: v.name.clone(),
        branch: v.branch.clone(),
        status: status_word(v.status).into(),
        last_reply: v.last_reply.clone(),
        question: v.question.as_ref().map(|q| {
            q.questions
                .iter()
                .map(|i| i.question.clone())
                .collect::<Vec<_>>()
                .join(" / ")
        }),
        error: v.error.clone(),
    }
}

fn parse_mode(mode: &str) -> Result<SpaceMode, SpaceToolError> {
    match mode.trim().to_ascii_lowercase().as_str() {
        "ask" => Ok(SpaceMode::Ask),
        "plan" => Ok(SpaceMode::Plan),
        "edit" | "" => Ok(SpaceMode::Edit),
        "run" => Ok(SpaceMode::Run),
        other => Err(refused(format!(
            "unknown mode {other:?}: ask, plan, edit or run"
        ))),
    }
}

fn rank(m: SpaceMode) -> u8 {
    match m {
        SpaceMode::Ask => 0,
        SpaceMode::Plan => 1,
        SpaceMode::Edit => 2,
        SpaceMode::Run => 3,
    }
}

fn mode_word(m: SpaceMode) -> &'static str {
    mode_str(crate::usecases::fleet::fleet_mode(m))
}

/// Pinned here with the key the cloud lists now.
fn trusted(d: &DeviceSummary, s: &FleetSettings) -> bool {
    s.trusted_devices
        .iter()
        .any(|t| t.device_id == d.device_id && t.public_key == d.public_key)
}

/// Whether `space` (followed here) was started by `caller`'s agent, or by
/// a space that was.
fn started_by(mem: &FleetMem, space: &str, caller: &str) -> bool {
    let mut at = space.to_string();
    // A chain is at most MAX_DEPTH long; a few more steps end any loop.
    for _ in 0..=(MAX_DEPTH + 2) {
        let Some(o) = mem.outbound.get(&at) else {
            return false;
        };
        if o.started_by.as_deref() == Some(caller) {
            return true;
        }
        match &o.view.parent {
            Some(p) => at = p.clone(),
            None => return false,
        }
    }
    false
}

impl Core {
    /// The fleet tools are listed: the fleet is on and connected.
    pub fn fleet_tools_available(&self) -> bool {
        self.0
            .fleet
            .tools_on
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    fn fleet_tools_check(&self) -> Result<(), SpaceToolError> {
        if self.fleet_tools_available() {
            Ok(())
        } else {
            Err(refused("the fleet isn't connected"))
        }
    }

    /// Start, send and stop: never from a space hosted here for another
    /// device (that device's trust doesn't reach this one's), and only
    /// from a turn that may change things.
    async fn fleet_tools_steer(&self, caller: &str, turn: SpaceMode) -> Result<(), SpaceToolError> {
        if self.fleet_hosts_local(caller).await {
            return Err(refused(
                "this space runs here for another device: it can't start or steer spaces \
                 on other devices",
            ));
        }
        if rank(turn) < rank(SpaceMode::Edit) {
            return Err(refused(format!(
                "this turn is in {} mode: starting or steering spaces on other devices needs \
                 Edit or Run",
                mode_word(turn)
            )));
        }
        Ok(())
    }

    /// Other devices that are online, take remote spaces and are trusted
    /// here.
    pub async fn fleet_tool_devices(&self) -> Result<Vec<FleetToolDevice>, SpaceToolError> {
        self.fleet_tools_check()?;
        let s = self.fleet_settings().await;
        let mem = self.fleet();
        let me = mem.device_id.clone();
        Ok(mem
            .devices
            .iter()
            .filter(|d| d.online && d.info.accepts_remote && trusted(d, &s))
            .filter(|d| me.as_deref() != Some(d.device_id.as_str()))
            .map(|d| FleetToolDevice {
                device_id: d.device_id.clone(),
                name: d.info.name.clone(),
                projects: d
                    .info
                    .projects
                    .iter()
                    .map(|p| FleetToolProject {
                        id: p.id.clone(),
                        name: p.name.clone(),
                    })
                    .collect(),
                max_mode: mode_str(d.info.max_mode).into(),
            })
            .collect())
    }

    /// `fleet_start_space` from the agent of `caller` (a local space id),
    /// whose turn runs in `turn`.
    pub async fn fleet_tool_start(
        &self,
        caller: &str,
        turn: SpaceMode,
        device: &str,
        project: &str,
        goal: &str,
        mode: &str,
    ) -> Result<FleetToolSpace, SpaceToolError> {
        self.fleet_tools_check()?;
        self.fleet_tools_steer(caller, turn).await?;
        let mode = parse_mode(mode)?;
        if rank(mode) > rank(turn) {
            return Err(refused(format!(
                "{} is above this turn's mode ({}): a space starts others at most in its own",
                mode_word(mode),
                mode_word(turn)
            )));
        }
        let s = self.fleet_settings().await;
        let (device_id, project_id, children) = {
            let mem = self.fleet();
            let me = mem.device_id.clone();
            let candidates: Vec<&DeviceSummary> = mem
                .devices
                .iter()
                .filter(|d| me.as_deref() != Some(d.device_id.as_str()) && trusted(d, &s))
                .collect();
            // By id; else by a name no other trusted device has.
            let d = match candidates.iter().find(|d| d.device_id == device) {
                Some(d) => *d,
                None => {
                    let named: Vec<&&DeviceSummary> = candidates
                        .iter()
                        .filter(|d| d.info.name.eq_ignore_ascii_case(device))
                        .collect();
                    match named.as_slice() {
                        [d] => **d,
                        [] => {
                            return Err(refused(format!(
                                "no trusted device {device:?} in the fleet; fleet_devices lists them"
                            )));
                        }
                        _ => {
                            return Err(refused(format!(
                                "several trusted devices are named {device:?}: use its device_id \
                                 from fleet_devices"
                            )));
                        }
                    }
                }
            };
            let p = d
                .info
                .projects
                .iter()
                .find(|p| p.id == project || p.name.eq_ignore_ascii_case(project))
                .ok_or_else(|| {
                    refused(format!(
                        "{} has no project {project:?}; fleet_devices lists them",
                        d.info.name
                    ))
                })?;
            let children = mem
                .outbound
                .values()
                .filter(|o| o.started_by.as_deref() == Some(caller))
                .count();
            (d.device_id.clone(), p.id.clone(), children)
        };
        if children >= MAX_CHILDREN as usize {
            return Err(refused(format!(
                "a space starts at most {MAX_CHILDREN} others"
            )));
        }
        // A stable parent id, so the cloud counts this space's children
        // across restarts.
        let parent = self.fleet_parent_id(caller).await;
        let (view, rx) = self
            .fleet_start_remote(
                &device_id,
                &project_id,
                goal,
                mode,
                Some(parent),
                1,
                Some(caller.to_string()),
            )
            .await
            .map_err(unavailable)?;
        // A refusal is the agent's to hear; no word in time, it's starting.
        if let Err(AppError::Refused(why)) = Self::fleet_await(rx, START_WAIT).await {
            return Err(refused(format!("the other device refused: {why}")));
        }
        Ok(self
            .fleet_tool_view(&view.space)
            .unwrap_or_else(|| tool_space(&view)))
    }

    fn fleet_tool_view(&self, space: &str) -> Option<FleetToolSpace> {
        self.fleet()
            .outbound
            .get(space)
            .map(|o| tool_space(&o.view))
    }

    /// `space` as `caller`'s agent may see it: only one it started (or
    /// one of those did). Spaces the user started aren't the agent's.
    fn fleet_tool_known(
        &self,
        caller: &str,
        space: &str,
    ) -> Result<FleetToolSpace, SpaceToolError> {
        let mem = self.fleet();
        match mem.outbound.get(space) {
            Some(o) if started_by(&mem, space, caller) => Ok(tool_space(&o.view)),
            _ => Err(refused(format!(
                "no fleet space {space} started by this space"
            ))),
        }
    }

    pub async fn fleet_tool_send(
        &self,
        caller: &str,
        turn: SpaceMode,
        space: &str,
        text: &str,
    ) -> Result<FleetToolSpace, SpaceToolError> {
        self.fleet_tools_check()?;
        self.fleet_tools_steer(caller, turn).await?;
        self.fleet_tool_known(caller, space)?;
        // At most the turn's mode, and never above the space's own.
        let own = self
            .fleet()
            .outbound
            .get(space)
            .map_or(turn, |o| o.view.mode);
        let mode = if rank(own) <= rank(turn) { own } else { turn };
        self.fleet_send(FleetSendRequest {
            space: space.to_string(),
            text: text.to_string(),
            mode: Some(mode),
        })
        .await
        .map_err(unavailable)?;
        self.fleet_tool_known(caller, space)
    }

    pub async fn fleet_tool_stop(
        &self,
        caller: &str,
        space: &str,
    ) -> Result<FleetToolSpace, SpaceToolError> {
        self.fleet_tools_check()?;
        // Stopping changes nothing but the other space's turn; still not
        // from a space hosted here for another device.
        if self.fleet_hosts_local(caller).await {
            return Err(refused(
                "this space runs here for another device: it can't steer spaces on other devices",
            ));
        }
        self.fleet_tool_known(caller, space)?;
        self.fleet_stop(space).await.map_err(unavailable)?;
        self.fleet_tool_known(caller, space)
    }

    /// Until every one of `spaces` is idle, waiting, stopped or failed, or
    /// `timeout_ms` (at most `FLEET_WAIT_MAX_MS`).
    pub async fn fleet_tool_wait(
        &self,
        caller: &str,
        spaces: &[String],
        timeout_ms: u64,
    ) -> Result<FleetToolWait, SpaceToolError> {
        self.fleet_tools_check()?;
        if spaces.is_empty() {
            return Err(refused("name at least one space"));
        }
        for s in spaces {
            self.fleet_tool_known(caller, s)?;
        }
        let deadline =
            tokio::time::Instant::now() + Duration::from_millis(timeout_ms.min(FLEET_WAIT_MAX_MS));
        loop {
            // Registered before the look, so a change in between still wakes.
            let changed = self.0.fleet.changed.notified();
            let (all, views) = {
                let mem = self.fleet();
                let views: Vec<FleetRemoteSpace> = spaces
                    .iter()
                    .filter_map(|s| mem.outbound.get(s).map(|o| o.view.clone()))
                    .collect();
                (views.iter().all(|v| settled(v.status)), views)
            };
            if all || tokio::time::Instant::now() >= deadline {
                return Ok(FleetToolWait {
                    settled: all,
                    spaces: views.iter().map(tool_space).collect(),
                });
            }
            tokio::select! {
                _ = changed => {}
                _ = tokio::time::sleep_until(deadline) => {}
                _ = self.0.shutdown.cancelled() => {
                    return Err(refused("Theodore is closing"));
                }
            }
        }
    }

    pub async fn fleet_tool_read(
        &self,
        caller: &str,
        space: &str,
        since: u64,
    ) -> Result<FleetToolRead, SpaceToolError> {
        self.fleet_tools_check()?;
        let view = self.fleet_tool_known(caller, space)?;
        let lines = self
            .fleet_space_lines(space, since)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(|l| FleetToolLine {
                seq: l.seq,
                kind: serde_json::to_value(l.kind)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_default(),
                text: l.text,
            })
            .collect();
        Ok(FleetToolRead { space: view, lines })
    }
}
