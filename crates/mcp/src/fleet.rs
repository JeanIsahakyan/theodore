//! The fleet tools of `space-tools` (docs/fleet.md "Agents use it too"):
//! `fleet_devices`, `fleet_start_space`, `fleet_send`, `fleet_wait`,
//! `fleet_read`, `fleet_stop`. Listed only while the fleet is connected
//! (`SpaceToolsBackend::fleet_available`); the calling space is always the
//! run's own, never one the agent names.

use rmcp::ErrorData;
use rmcp::handler::server::tool::Extension;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::{tool, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use theodore_ports::FLEET_WAIT_MAX_MS;

use crate::backend::TurnMode;
use crate::server::{ReviewToolsServer, run_space, space_result};

/// The calling turn's mode; a run without one never gets here
/// (`RunContext::fleet_steers`).
fn turn_mode(run: &crate::RunContext) -> Result<TurnMode, ErrorData> {
    run.mode
        .ok_or_else(|| ErrorData::invalid_params("this run has no mode", None))
}

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FleetModeParam {
    Ask,
    Plan,
    Edit,
    Run,
}

impl FleetModeParam {
    fn as_str(self) -> &'static str {
        match self {
            FleetModeParam::Ask => "ask",
            FleetModeParam::Plan => "plan",
            FleetModeParam::Edit => "edit",
            FleetModeParam::Run => "run",
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct FleetStartParams {
    /// The device's id or name, as `fleet_devices` lists it.
    pub device: String,
    /// One of that device's projects: id or name.
    pub project: String,
    /// What the new space should do: its first message.
    pub goal: String,
    /// At most the device's `max_mode`. Default edit.
    #[serde(default)]
    pub mode: Option<FleetModeParam>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct FleetSendParams {
    /// The space's fleet id (`rs_…`).
    pub space: String,
    pub text: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct FleetWaitParams {
    /// Fleet ids (`rs_…`) to wait for.
    pub spaces: Vec<String>,
    /// At most 600000 (10 minutes). Default 300000.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct FleetReadParams {
    pub space: String,
    /// Only history after this seq; 0 for all of it.
    #[serde(default)]
    pub since: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct FleetSpaceParam {
    pub space: String,
}

#[derive(Debug, Serialize)]
pub struct FleetDevicesResult {
    pub devices: Vec<theodore_ports::FleetToolDevice>,
}

const DEFAULT_WAIT_MS: u64 = 300_000;

#[tool_router(router = fleet_router, vis = "pub(crate)")]
impl ReviewToolsServer {
    #[tool(
        description = "The user's other devices that take spaces from this one right now: id, name, their projects and the highest mode they allow (ask, plan, edit, run)."
    )]
    async fn fleet_devices(
        &self,
        Extension(parts): Extension<http::request::Parts>,
    ) -> Result<CallToolResult, ErrorData> {
        let (_, space) = run_space(&parts)?;
        space_result(
            self.spaces
                .fleet_devices(&space)
                .await
                .map(|devices| FleetDevicesResult { devices }),
        )
    }

    #[tool(
        description = "Start a space on another of the user's devices that this one trusts, in one of its projects, with a goal; this space becomes its parent. Returns the new space's fleet id (rs_…) and status. Its mode is at most this turn's and the device's limit; a space starts at most 5. The device may refuse; the error says why."
    )]
    async fn fleet_start_space(
        &self,
        Extension(parts): Extension<http::request::Parts>,
        Parameters(p): Parameters<FleetStartParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let (run, space) = run_space(&parts)?;
        let turn = turn_mode(&run)?;
        let mode = p.mode.unwrap_or(FleetModeParam::Edit).as_str();
        space_result(
            self.spaces
                .fleet_start_space(&space, turn, &p.device, &p.project, &p.goal, mode)
                .await,
        )
    }

    #[tool(
        description = "Send a message to a space this one started on another device (it runs as that space's next turn, at most in this turn's mode). Returns its status."
    )]
    async fn fleet_send(
        &self,
        Extension(parts): Extension<http::request::Parts>,
        Parameters(p): Parameters<FleetSendParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let (run, space) = run_space(&parts)?;
        let turn = turn_mode(&run)?;
        space_result(
            self.spaces
                .fleet_send(&space, turn, &p.space, &p.text)
                .await,
        )
    }

    #[tool(
        description = "Wait until each of the spaces (started by this one) is idle, waiting for the user, stopped or failed, or the timeout (at most 10 minutes). Returns whether all settled and each one's status and last reply."
    )]
    async fn fleet_wait(
        &self,
        Extension(parts): Extension<http::request::Parts>,
        Parameters(p): Parameters<FleetWaitParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let (_, space) = run_space(&parts)?;
        let timeout = p
            .timeout_ms
            .unwrap_or(DEFAULT_WAIT_MS)
            .min(FLEET_WAIT_MAX_MS);
        space_result(self.spaces.fleet_wait(&space, &p.spaces, timeout).await)
    }

    #[tool(
        description = "A space this one started on another device: its status, last reply, a waiting question, and its history (turns, tools, replies) after `since`."
    )]
    async fn fleet_read(
        &self,
        Extension(parts): Extension<http::request::Parts>,
        Parameters(p): Parameters<FleetReadParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let (_, space) = run_space(&parts)?;
        space_result(
            self.spaces
                .fleet_read(&space, &p.space, p.since.unwrap_or(0))
                .await,
        )
    }

    #[tool(description = "Stop the turn running in a space this one started on another device.")]
    async fn fleet_stop(
        &self,
        Extension(parts): Extension<http::request::Parts>,
        Parameters(p): Parameters<FleetSpaceParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let (_, space) = run_space(&parts)?;
        space_result(self.spaces.fleet_stop(&space, &p.space).await)
    }
}
