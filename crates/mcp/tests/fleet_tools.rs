//! The fleet tools of `space-tools` over a real server and client: listed
//! and callable only while the backend says the fleet is connected, never
//! on a review run, and always for the run's own space. The fleet logic
//! itself is tested in `app`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rmcp::ServiceExt;
use rmcp::model::CallToolRequestParams;
use rmcp::service::RunningService;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use serde_json::{Value, json};
use theodore_domain::{AgentId, FindingId, PrId, RunId};
use theodore_mcp::{
    AppStatus, BackendError, CheckOutcome, FLEET_STEER_TOOL_NAMES, FLEET_TOOL_NAMES, FleetTools,
    GroupWithHunks, LogTail, McpServer, NewFinding, NewPatch, PrContext, ReviewToolsBackend,
    RunContext, SpaceCommandName, SpaceInfo, SpaceToolError, SpaceToolsBackend, TerminalTail,
    ToolSet, TurnMode,
};
use theodore_ports::{FleetToolDevice, FleetToolSpace, FleetToolWait};

struct EmptyReview;

#[async_trait]
impl ReviewToolsBackend for EmptyReview {
    async fn get_pr_context(&self, _: &RunContext) -> Result<PrContext, BackendError> {
        Err(BackendError::NotFound("none".into()))
    }
    async fn get_group(&self, _: &RunContext, _: &str) -> Result<GroupWithHunks, BackendError> {
        Err(BackendError::NotFound("none".into()))
    }
    async fn get_base_file(&self, _: &RunContext, _: &str) -> Result<Option<String>, BackendError> {
        Ok(None)
    }
    async fn add_finding(&self, _: &RunContext, _: NewFinding) -> Result<FindingId, BackendError> {
        Ok(FindingId::new("f"))
    }
    async fn propose_patch(&self, _: &RunContext, _: NewPatch) -> Result<(), BackendError> {
        Ok(())
    }
}

/// Only the fleet tools; `on` is the connection.
struct FakeFleet {
    on: AtomicBool,
    calls: Mutex<Vec<String>>,
}

fn nope() -> SpaceToolError {
    SpaceToolError::Unavailable("not here".into())
}

fn tool_space(id: &str, status: &str) -> FleetToolSpace {
    FleetToolSpace {
        space: id.into(),
        device: "mac1".into(),
        name: "port-it".into(),
        branch: "ada/port-it".into(),
        status: status.into(),
        last_reply: None,
        question: None,
        error: None,
    }
}

#[async_trait]
impl SpaceToolsBackend for FakeFleet {
    async fn run_check(&self, _: &str, _: &RunId) -> Result<CheckOutcome, SpaceToolError> {
        Err(nope())
    }
    async fn start_app(&self, _: &str) -> Result<AppStatus, SpaceToolError> {
        Err(nope())
    }
    async fn stop_app(&self, _: &str) -> Result<AppStatus, SpaceToolError> {
        Err(nope())
    }
    async fn app_status(&self, _: &str) -> Result<AppStatus, SpaceToolError> {
        Err(nope())
    }
    async fn read_logs(
        &self,
        _: &str,
        _: SpaceCommandName,
        _: usize,
    ) -> Result<LogTail, SpaceToolError> {
        Err(nope())
    }
    async fn read_terminal(
        &self,
        _: &str,
        _: Option<&str>,
        _: usize,
    ) -> Result<TerminalTail, SpaceToolError> {
        Err(nope())
    }
    async fn space_info(&self, _: &str) -> Result<SpaceInfo, SpaceToolError> {
        Err(nope())
    }

    fn fleet_available(&self) -> bool {
        self.on.load(Ordering::SeqCst)
    }
    async fn fleet_devices(&self, space: &str) -> Result<Vec<FleetToolDevice>, SpaceToolError> {
        self.calls.lock().unwrap().push(format!("devices {space}"));
        Ok(vec![FleetToolDevice {
            device_id: "dev_t".into(),
            name: "mac1".into(),
            projects: vec![],
            max_mode: "edit".into(),
        }])
    }
    async fn fleet_start_space(
        &self,
        space: &str,
        turn: TurnMode,
        device: &str,
        project: &str,
        goal: &str,
        mode: &str,
    ) -> Result<FleetToolSpace, SpaceToolError> {
        self.calls.lock().unwrap().push(format!(
            "start {space} {turn:?} {device} {project} {goal} {mode}"
        ));
        Ok(tool_space("rs_1", "starting"))
    }
    async fn fleet_wait(
        &self,
        space: &str,
        targets: &[String],
        timeout_ms: u64,
    ) -> Result<FleetToolWait, SpaceToolError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("wait {space} {} {timeout_ms}", targets.join(",")));
        Ok(FleetToolWait {
            settled: true,
            spaces: vec![tool_space("rs_1", "idle")],
        })
    }
}

fn run(tools: ToolSet) -> RunContext {
    turn(tools, TurnMode::Edit, FleetTools::Steer)
}

fn turn(tools: ToolSet, mode: TurnMode, fleet: FleetTools) -> RunContext {
    RunContext {
        run_id: RunId::new("space:s1:m1"),
        pr: PrId::new("space:s1"),
        agent: AgentId::Claude,
        space: Some("s1".into()),
        tools,
        code: theodore_mcp::CodeTools::Off,
        mode: Some(mode),
        fleet,
    }
}

async fn connect(url: &str, token: &str) -> RunningService<rmcp::RoleClient, ()> {
    let config = StreamableHttpClientTransportConfig::with_uri(url).auth_header(token);
    ().serve(StreamableHttpClientTransport::from_config(config))
        .await
        .expect("connect")
}

async fn fleet_names(client: &RunningService<rmcp::RoleClient, ()>) -> Vec<String> {
    let mut names: Vec<String> = client
        .list_all_tools()
        .await
        .expect("list tools")
        .iter()
        .map(|t| t.name.to_string())
        .filter(|n| n.starts_with("fleet_"))
        .collect();
    names.sort();
    names
}

async fn call(client: &RunningService<rmcp::RoleClient, ()>, tool: &str, args: Value) -> Value {
    let mut req = CallToolRequestParams::new(tool.to_string());
    if let Value::Object(map) = args {
        req = req.with_arguments(map);
    }
    let result = client.call_tool(req).await.expect("call");
    assert_eq!(result.is_error, Some(false), "{result:?}");
    serde_json::from_str(&result.content[0].as_text().expect("text").text).expect("json")
}

#[tokio::test]
async fn fleet_tools_are_listed_only_while_connected() {
    let fleet = Arc::new(FakeFleet {
        on: AtomicBool::new(false),
        calls: Mutex::new(Vec::new()),
    });
    let handle = McpServer::start_with_spaces(Arc::new(EmptyReview), fleet.clone())
        .await
        .unwrap();
    let endpoint = handle.register_run(run(ToolSet::Space));
    let client = connect(&endpoint.url, &endpoint.token).await;

    assert!(fleet_names(&client).await.is_empty());
    let refused = client
        .call_tool(CallToolRequestParams::new("fleet_devices"))
        .await;
    assert!(refused.is_err(), "not callable while off: {refused:?}");

    fleet.on.store(true, Ordering::SeqCst);
    let mut all: Vec<String> = FLEET_TOOL_NAMES.iter().map(|s| s.to_string()).collect();
    all.sort();
    assert_eq!(fleet_names(&client).await, all);

    let devices = call(&client, "fleet_devices", json!({})).await;
    assert_eq!(devices["devices"][0]["name"], json!("mac1"));
    let started = call(
        &client,
        "fleet_start_space",
        json!({"device": "mac1", "project": "app", "goal": "Port it", "mode": "plan"}),
    )
    .await;
    assert_eq!(started["space"], json!("rs_1"));
    assert_eq!(started["status"], json!("starting"));
    // Bounded to ten minutes.
    let waited = call(
        &client,
        "fleet_wait",
        json!({"spaces": ["rs_1"], "timeout_ms": 9_999_999}),
    )
    .await;
    assert_eq!(waited["settled"], json!(true));
    assert_eq!(
        *fleet.calls.lock().unwrap(),
        [
            "devices s1",
            "start s1 Edit mac1 app Port it plan",
            "wait s1 rs_1 600000",
        ]
    );
    drop(client);

    // An Ask or Plan turn, or a space hosted here for another device, only
    // reads: start, send and stop are neither listed nor callable.
    let read_only: Vec<String> = {
        let mut v: Vec<String> = FLEET_TOOL_NAMES
            .iter()
            .filter(|t| !FLEET_STEER_TOOL_NAMES.contains(t))
            .map(|s| s.to_string())
            .collect();
        v.sort();
        v
    };
    for ctx in [
        turn(ToolSet::Space, TurnMode::Ask, FleetTools::Steer),
        turn(ToolSet::Space, TurnMode::Plan, FleetTools::Steer),
        turn(ToolSet::Space, TurnMode::Run, FleetTools::Read),
    ] {
        let endpoint = handle.register_run(ctx.clone());
        let client = connect(&endpoint.url, &endpoint.token).await;
        assert_eq!(fleet_names(&client).await, read_only, "{ctx:?}");
        for tool in FLEET_STEER_TOOL_NAMES {
            let mut req = CallToolRequestParams::new(tool.to_string());
            if let Value::Object(map) = json!({"device": "mac1", "project": "app", "goal": "x", "space": "rs_1", "text": "go"})
            {
                req = req.with_arguments(map);
            }
            let refused = client.call_tool(req).await;
            assert!(refused.is_err(), "{tool} for {ctx:?}: {refused:?}");
        }
        drop(client);
    }
    assert_eq!(
        fleet.calls.lock().unwrap().len(),
        3,
        "nothing reached the backend"
    );

    // A review run never gets them.
    let review = handle.register_run(run(ToolSet::Review));
    let client = connect(&review.url, &review.token).await;
    assert!(fleet_names(&client).await.is_empty());
    drop(client);
    handle.shutdown().await;
}
