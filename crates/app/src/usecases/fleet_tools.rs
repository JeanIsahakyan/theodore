//! The fleet tools of `space-tools` (docs/fleet.md "Agents use it too"):
//! an agent in a space here starts, steers and reads spaces on the user's
//! other devices, with this device's authority. Listed only while the
//! fleet is on and connected.
//!
//! ```text
//! calling space hosted here for the fleet ─▶ parent = its rs_ id, depth + 1
//! calling space of this device's own      ─▶ no parent, depth 1
//! depth > MAX_DEPTH or > MAX_CHILDREN started by it ─▶ refused here first
//! ```

use std::time::Duration;

use theodore_contract::{FleetRemoteSpace, FleetSendRequest, FleetSpaceStatus, SpaceMode};
use theodore_fleet_protocol::{MAX_CHILDREN, MAX_DEPTH};
use theodore_ports::{
    FLEET_WAIT_MAX_MS, FleetToolDevice, FleetToolLine, FleetToolProject, FleetToolRead,
    FleetToolSpace, FleetToolWait, SpaceToolError,
};

use crate::core::Core;
use crate::error::AppError;
use crate::usecases::fleet::mode_str;
use crate::usecases::fleet_origin::settled;

/// How long `fleet_start_space` waits for the other device to say yes.
const START_WAIT: Duration = Duration::from_secs(20);

/// Told to the agent when its turn has the fleet tools.
pub(crate) const FLEET_TOOLS_PROMPT: &str = "The user's other devices are reachable \
     through the fleet tools: fleet_devices lists the ones that take remote spaces (their \
     projects and highest mode); fleet_start_space starts a space with a goal in one of \
     their projects; fleet_send sends it a message, fleet_wait waits until spaces settle, \
     fleet_read reads a space's replies and history, fleet_stop stops its turn. Use them \
     only when the user asks for work on another device, or to split work they asked for \
     across devices.";

fn unavailable(e: AppError) -> SpaceToolError {
    SpaceToolError::Unavailable(e.to_string())
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
        other => Err(SpaceToolError::Unavailable(format!(
            "unknown mode {other:?}: ask, plan, edit or run"
        ))),
    }
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
            Err(SpaceToolError::Unavailable(
                "the fleet isn't connected".into(),
            ))
        }
    }

    pub async fn fleet_tool_devices(&self) -> Result<Vec<FleetToolDevice>, SpaceToolError> {
        self.fleet_tools_check()?;
        let mem = self.fleet();
        let me = mem.device_id.clone();
        Ok(mem
            .devices
            .iter()
            .filter(|d| d.online && d.info.accepts_remote)
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

    /// `fleet_start_space` from the agent of `caller` (a local space id).
    pub async fn fleet_tool_start(
        &self,
        caller: &str,
        device: &str,
        project: &str,
        goal: &str,
        mode: &str,
    ) -> Result<FleetToolSpace, SpaceToolError> {
        self.fleet_tools_check()?;
        let mode = parse_mode(mode)?;
        let (device_id, project_id, parent, depth, children) = {
            let mem = self.fleet();
            let d = mem
                .devices
                .iter()
                .find(|d| d.device_id == device || d.info.name.eq_ignore_ascii_case(device))
                .ok_or_else(|| {
                    SpaceToolError::Unavailable(format!(
                        "no device {device:?} in the fleet; fleet_devices lists them"
                    ))
                })?;
            let p = d
                .info
                .projects
                .iter()
                .find(|p| p.id == project || p.name.eq_ignore_ascii_case(project))
                .ok_or_else(|| {
                    SpaceToolError::Unavailable(format!(
                        "{} has no project {project:?}; fleet_devices lists them",
                        d.info.name
                    ))
                })?;
            let (parent, depth) = match mem.hosted.values().find(|h| h.row.local_space == caller) {
                Some(h) => (Some(h.row.space.clone()), h.row.depth + 1),
                None => (None, 1),
            };
            let children = mem
                .outbound
                .values()
                .filter(|o| o.started_by.as_deref() == Some(caller))
                .count();
            (d.device_id.clone(), p.id.clone(), parent, depth, children)
        };
        if depth > MAX_DEPTH {
            return Err(SpaceToolError::Unavailable(format!(
                "spaces nest at most {MAX_DEPTH} deep: this space can't start another"
            )));
        }
        if children >= MAX_CHILDREN as usize {
            return Err(SpaceToolError::Unavailable(format!(
                "a space starts at most {MAX_CHILDREN} others"
            )));
        }
        let (view, rx) = self
            .fleet_start_remote(
                &device_id,
                &project_id,
                goal,
                mode,
                parent,
                depth,
                Some(caller.to_string()),
            )
            .await
            .map_err(unavailable)?;
        // A refusal is the agent's to hear; no word in time, it's starting.
        if let Err(AppError::Refused(why)) = Self::fleet_await(rx, START_WAIT).await {
            return Err(SpaceToolError::Unavailable(format!(
                "the other device refused: {why}"
            )));
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

    fn fleet_tool_known(&self, space: &str) -> Result<FleetToolSpace, SpaceToolError> {
        self.fleet_tool_view(space).ok_or_else(|| {
            SpaceToolError::Unavailable(format!("no fleet space {space} started from this device"))
        })
    }

    pub async fn fleet_tool_send(
        &self,
        space: &str,
        text: &str,
    ) -> Result<FleetToolSpace, SpaceToolError> {
        self.fleet_tools_check()?;
        self.fleet_tool_known(space)?;
        self.fleet_send(FleetSendRequest {
            space: space.to_string(),
            text: text.to_string(),
            mode: None,
        })
        .await
        .map_err(unavailable)?;
        self.fleet_tool_known(space)
    }

    pub async fn fleet_tool_stop(&self, space: &str) -> Result<FleetToolSpace, SpaceToolError> {
        self.fleet_tools_check()?;
        self.fleet_tool_known(space)?;
        self.fleet_stop(space).await.map_err(unavailable)?;
        self.fleet_tool_known(space)
    }

    /// Until every one of `spaces` is idle, waiting, stopped or failed, or
    /// `timeout_ms` (at most `FLEET_WAIT_MAX_MS`).
    pub async fn fleet_tool_wait(
        &self,
        spaces: &[String],
        timeout_ms: u64,
    ) -> Result<FleetToolWait, SpaceToolError> {
        self.fleet_tools_check()?;
        if spaces.is_empty() {
            return Err(SpaceToolError::Unavailable(
                "name at least one space".into(),
            ));
        }
        for s in spaces {
            self.fleet_tool_known(s)?;
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
                    return Err(SpaceToolError::Unavailable("Theodore is closing".into()));
                }
            }
        }
    }

    pub async fn fleet_tool_read(
        &self,
        space: &str,
        since: u64,
    ) -> Result<FleetToolRead, SpaceToolError> {
        self.fleet_tools_check()?;
        let view = self.fleet_tool_known(space)?;
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
