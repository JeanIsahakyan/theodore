//! The local-space tools of `space-tools` over a real server and client:
//! reading for every turn of a space of this device's own, the sub-space
//! tools only while `spaces.sub_spaces` is on, steering only in Edit or
//! Run, nothing for a space hosted for another device or a review run,
//! and always for the run's own space. The rules themselves are tested in
//! `app`.

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
    AppStatus, BackendError, CheckOutcome, FleetTools, GroupWithHunks, LOCAL_SPACE_READ_TOOL_NAMES,
    LogTail, McpServer, NewFinding, NewPatch, PrContext, ReviewToolsBackend, RunContext,
    SUB_SPACE_STEER_TOOL_NAMES, SUB_SPACE_TOOL_NAMES, SpaceCommandName, SpaceInfo, SpaceToolError,
    SpaceToolsBackend, TerminalTail, ToolSet, TurnMode,
};
use theodore_ports::{
    LocalAnswer, LocalMergedFile, LocalSpaceAsk, LocalSpaceItem, LocalSpaceList, LocalSpaceMerge,
    LocalSpaceRead, LocalSpaceStart, LocalSpaceWait, OTHER_SPACE_NOTE,
};

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

/// Only the local-space tools; `on` is `spaces.sub_spaces`.
struct FakeLocal {
    on: AtomicBool,
    calls: Mutex<Vec<String>>,
}

fn nope() -> SpaceToolError {
    SpaceToolError::Unavailable("not here".into())
}

fn item(id: &str, status: &str) -> LocalSpaceItem {
    LocalSpaceItem {
        space: id.into(),
        name: "port-it".into(),
        title: "Port it".into(),
        project: "local:app".into(),
        status: status.into(),
        mode: "edit".into(),
        agent: "claude".into(),
        turns: 0,
        parent: None,
        relation: Some("child".into()),
        remote: false,
        done: false,
        updated_at: 0,
    }
}

impl FakeLocal {
    fn log(&self, s: String) {
        self.calls.lock().unwrap().push(s);
    }
}

#[async_trait]
impl SpaceToolsBackend for FakeLocal {
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

    async fn sub_spaces_enabled(&self) -> bool {
        self.on.load(Ordering::SeqCst)
    }
    async fn local_list(
        &self,
        space: &str,
        project: Option<&str>,
        include_done: bool,
    ) -> Result<LocalSpaceList, SpaceToolError> {
        self.log(format!("list {space} {project:?} {include_done}"));
        Ok(LocalSpaceList {
            note: OTHER_SPACE_NOTE,
            spaces: vec![item("s2", "idle")],
            truncated: false,
        })
    }
    async fn local_read(
        &self,
        space: &str,
        target: &str,
        messages: usize,
    ) -> Result<LocalSpaceRead, SpaceToolError> {
        self.log(format!("read {space} {target} {messages}"));
        Ok(LocalSpaceRead {
            note: OTHER_SPACE_NOTE,
            space: item(target, "idle"),
            goal: "Port it".into(),
            branch: "ada/port-it".into(),
            base: "main".into(),
            progress: vec![],
            progress_note: None,
            messages: vec![],
            live: None,
            question: None,
            diff: None,
            error: None,
        })
    }
    async fn local_ask(
        &self,
        space: &str,
        target: &str,
        question: &str,
    ) -> Result<LocalSpaceAsk, SpaceToolError> {
        self.log(format!("ask {space} {target} {question}"));
        Ok(LocalSpaceAsk {
            note: OTHER_SPACE_NOTE,
            space: item(target, "running"),
            answer: "SQLite.".into(),
            agent: "claude".into(),
            model: Some("opus".into()),
            how: "fork",
        })
    }
    async fn local_start(
        &self,
        space: &str,
        turn: TurnMode,
        req: LocalSpaceStart,
    ) -> Result<LocalSpaceItem, SpaceToolError> {
        self.log(format!(
            "start {space} {turn:?} {} {:?} {:?}",
            req.goal, req.mode, req.project
        ));
        Ok(item("s3", "running"))
    }
    async fn local_send(
        &self,
        space: &str,
        turn: TurnMode,
        target: &str,
        message: &str,
        mode: Option<&str>,
    ) -> Result<LocalSpaceItem, SpaceToolError> {
        self.log(format!("send {space} {turn:?} {target} {message} {mode:?}"));
        Ok(item(target, "running"))
    }
    async fn local_wait(
        &self,
        space: &str,
        targets: &[String],
        timeout_ms: u64,
    ) -> Result<LocalSpaceWait, SpaceToolError> {
        self.log(format!("wait {space} {} {timeout_ms}", targets.join(",")));
        Ok(LocalSpaceWait {
            settled: targets.to_vec(),
            spaces: targets.iter().map(|t| item(t, "idle")).collect(),
        })
    }
    async fn local_stop(
        &self,
        space: &str,
        turn: TurnMode,
        target: &str,
    ) -> Result<LocalSpaceItem, SpaceToolError> {
        self.log(format!("stop {space} {turn:?} {target}"));
        Ok(item(target, "idle"))
    }
    async fn local_answer(
        &self,
        space: &str,
        turn: TurnMode,
        target: &str,
        ask: &str,
        answers: Vec<LocalAnswer>,
    ) -> Result<LocalSpaceItem, SpaceToolError> {
        self.log(format!(
            "answer {space} {turn:?} {target} {ask} {:?}",
            answers
                .iter()
                .map(|a| a.selected.join("+"))
                .collect::<Vec<_>>()
        ));
        Ok(item(target, "running"))
    }
    async fn local_merge(
        &self,
        space: &str,
        turn: TurnMode,
        target: &str,
    ) -> Result<LocalSpaceMerge, SpaceToolError> {
        self.log(format!("merge {space} {turn:?} {target}"));
        if target == "busy" {
            return Err(SpaceToolError::Unavailable(
                "sub_spaces.running: busy is still running; space_wait for it, then merge".into(),
            ));
        }
        Ok(LocalSpaceMerge {
            space: LocalSpaceItem {
                done: true,
                ..item(target, "idle")
            },
            from: "base1".into(),
            to: "head1".into(),
            files: vec![LocalMergedFile {
                path: "src/a.rs".into(),
                additions: 3,
                deletions: 1,
            }],
            additions: 3,
            deletions: 1,
            conflicts: vec!["src/a.rs".into()],
            note: "resolve them".into(),
        })
    }
    async fn local_archive(
        &self,
        space: &str,
        turn: TurnMode,
        target: &str,
        force: bool,
    ) -> Result<LocalSpaceItem, SpaceToolError> {
        self.log(format!("archive {space} {turn:?} {target} {force}"));
        Ok(item(target, "archived"))
    }
    async fn local_unarchive(
        &self,
        space: &str,
        turn: TurnMode,
        target: &str,
    ) -> Result<LocalSpaceItem, SpaceToolError> {
        self.log(format!("unarchive {space} {turn:?} {target}"));
        Ok(item(target, "idle"))
    }
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

fn ours(name: &str) -> bool {
    LOCAL_SPACE_READ_TOOL_NAMES.contains(&name) || SUB_SPACE_TOOL_NAMES.contains(&name)
}

async fn local_names(client: &RunningService<rmcp::RoleClient, ()>) -> Vec<String> {
    let mut names: Vec<String> = client
        .list_all_tools()
        .await
        .expect("list tools")
        .iter()
        .map(|t| t.name.to_string())
        .filter(|n| ours(n))
        .collect();
    names.sort();
    names
}

fn sorted(names: impl IntoIterator<Item = &'static str>) -> Vec<String> {
    let mut v: Vec<String> = names.into_iter().map(str::to_string).collect();
    v.sort();
    v
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

fn args() -> Value {
    json!({"space": "s2", "spaces": ["s2"], "goal": "x", "message": "go", "ask": "q1", "answer": []})
}

#[tokio::test]
async fn local_space_tools_follow_the_turn_the_setting_and_the_host() {
    let local = Arc::new(FakeLocal {
        on: AtomicBool::new(true),
        calls: Mutex::new(Vec::new()),
    });
    let handle = McpServer::start_with_spaces(Arc::new(EmptyReview), local.clone())
        .await
        .unwrap();

    // An Edit turn of a space of this device's own: all of them.
    let edit = handle.register_run(turn(ToolSet::Space, TurnMode::Edit, FleetTools::Steer));
    let client = connect(&edit.url, &edit.token).await;
    let all = sorted(
        LOCAL_SPACE_READ_TOOL_NAMES
            .iter()
            .chain(SUB_SPACE_TOOL_NAMES)
            .copied(),
    );
    assert_eq!(local_names(&client).await, all);

    let list = call(&client, "spaces_list", json!({"include_done": true})).await;
    assert_eq!(list["note"], json!(OTHER_SPACE_NOTE));
    assert_eq!(list["spaces"][0]["space"], json!("s2"));
    // Bounded to 50 messages.
    call(
        &client,
        "space_read",
        json!({"space": "s2", "messages": 500}),
    )
    .await;
    call(&client, "space_read", json!({"space": "s2"})).await;
    let started = call(
        &client,
        "space_start",
        json!({"goal": "Port it", "mode": "plan"}),
    )
    .await;
    assert_eq!(started["space"], json!("s3"));
    call(
        &client,
        "space_send",
        json!({"space": "s3", "message": "more"}),
    )
    .await;
    // Bounded to ten minutes.
    let waited = call(
        &client,
        "space_wait",
        json!({"spaces": ["s3"], "timeout_ms": 9_999_999}),
    )
    .await;
    assert_eq!(waited["settled"], json!(["s3"]));
    call(
        &client,
        "space_answer",
        json!({"space": "s3", "ask": "q1", "answer": [{"selected": ["SQLite"]}]}),
    )
    .await;
    call(&client, "space_stop", json!({"space": "s3"})).await;
    let archived = call(
        &client,
        "space_archive",
        json!({"space": "s3", "force": true}),
    )
    .await;
    assert_eq!(archived["status"], json!("archived"));
    call(&client, "space_archive", json!({"space": "s3"})).await;
    call(&client, "space_unarchive", json!({"space": "s3"})).await;
    let merged = call(&client, "space_merge", json!({"space": "s3"})).await;
    assert_eq!(merged["space"]["done"], json!(true));
    assert_eq!(
        merged["files"],
        json!([{"path": "src/a.rs", "additions": 3, "deletions": 1}])
    );
    assert_eq!(merged["conflicts"], json!(["src/a.rs"]));
    assert_eq!(
        (&merged["from"], &merged["to"]),
        (&json!("base1"), &json!("head1"))
    );
    // A refusal comes back as the tool's error, its code first.
    let refused = client
        .call_tool(
            CallToolRequestParams::new("space_merge")
                .with_arguments(json!({"space": "busy"}).as_object().unwrap().clone()),
        )
        .await
        .expect("call");
    assert_eq!(refused.is_error, Some(true));
    let text = &refused.content[0].as_text().expect("text").text;
    assert!(text.starts_with("sub_spaces.running: "), "{text}");
    assert_eq!(
        *local.calls.lock().unwrap(),
        [
            "list s1 None true",
            "read s1 s2 50",
            "read s1 s2 10",
            "start s1 Edit Port it Some(\"plan\") None",
            "send s1 Edit s3 more None",
            "wait s1 s3 600000",
            "answer s1 Edit s3 q1 [\"SQLite\"]",
            "stop s1 Edit s3",
            "archive s1 Edit s3 true",
            "archive s1 Edit s3 false",
            "unarchive s1 Edit s3",
            "merge s1 Edit s3",
            "merge s1 Edit busy",
        ]
    );
    drop(client);
    let before = local.calls.lock().unwrap().len();

    // An Ask or Plan turn reads and waits; it starts and steers nothing.
    let reads_and_waits = sorted(
        LOCAL_SPACE_READ_TOOL_NAMES
            .iter()
            .chain(&["space_wait"])
            .copied(),
    );
    for mode in [TurnMode::Ask, TurnMode::Plan] {
        let ep = handle.register_run(turn(ToolSet::Space, mode, FleetTools::Steer));
        let client = connect(&ep.url, &ep.token).await;
        assert_eq!(local_names(&client).await, reads_and_waits, "{mode:?}");
        for tool in SUB_SPACE_STEER_TOOL_NAMES {
            let mut req = CallToolRequestParams::new(tool.to_string());
            if let Value::Object(map) = args() {
                req = req.with_arguments(map);
            }
            assert!(client.call_tool(req).await.is_err(), "{tool} in {mode:?}");
        }
        drop(client);
    }

    // `spaces.sub_spaces` off: reading only, whatever the mode.
    local.on.store(false, Ordering::SeqCst);
    let client = connect(&edit.url, &edit.token).await;
    assert_eq!(
        local_names(&client).await,
        sorted(LOCAL_SPACE_READ_TOOL_NAMES.iter().copied())
    );
    let refused = client
        .call_tool(
            CallToolRequestParams::new("space_wait")
                .with_arguments(args().as_object().unwrap().clone()),
        )
        .await;
    assert!(refused.is_err(), "{refused:?}");
    drop(client);
    local.on.store(true, Ordering::SeqCst);

    // A space hosted here for another device: all of them too (the core
    // keeps it to what that device may do here).
    let hosted = handle.register_run(turn(ToolSet::Space, TurnMode::Edit, FleetTools::Hosted));
    let client = connect(&hosted.url, &hosted.token).await;
    assert_eq!(local_names(&client).await, all);
    drop(client);

    // A review run: none.
    for ctx in [turn(ToolSet::Review, TurnMode::Run, FleetTools::Steer)] {
        let ep = handle.register_run(ctx.clone());
        let client = connect(&ep.url, &ep.token).await;
        assert!(local_names(&client).await.is_empty(), "{ctx:?}");
        let refused = client
            .call_tool(
                CallToolRequestParams::new("spaces_list").with_arguments(serde_json::Map::new()),
            )
            .await;
        assert!(refused.is_err(), "{ctx:?}: {refused:?}");
        drop(client);
    }
    assert_eq!(
        local.calls.lock().unwrap().len(),
        before,
        "nothing refused reached the backend"
    );
    handle.shutdown().await;
}

/// `space_ask` only reads: every space turn gets it (a hosted space's
/// too), whatever its mode and `spaces.sub_spaces`; a review run doesn't.
#[tokio::test]
async fn space_ask_is_for_every_space_turn() {
    let local = Arc::new(FakeLocal {
        on: AtomicBool::new(false),
        calls: Mutex::new(Vec::new()),
    });
    let handle = McpServer::start_with_spaces(Arc::new(EmptyReview), local.clone())
        .await
        .unwrap();
    for mode in [TurnMode::Ask, TurnMode::Plan, TurnMode::Edit, TurnMode::Run] {
        let ep = handle.register_run(turn(ToolSet::Space, mode, FleetTools::Steer));
        let client = connect(&ep.url, &ep.token).await;
        assert!(
            local_names(&client)
                .await
                .contains(&"space_ask".to_string()),
            "{mode:?}"
        );
        drop(client);
    }
    let ep = handle.register_run(turn(ToolSet::Space, TurnMode::Ask, FleetTools::Steer));
    let client = connect(&ep.url, &ep.token).await;
    let answer = call(
        &client,
        "space_ask",
        json!({"space": "s2", "question": "Which store?"}),
    )
    .await;
    assert_eq!(answer["answer"], json!("SQLite."));
    assert_eq!(answer["note"], json!(OTHER_SPACE_NOTE));
    assert_eq!(
        (&answer["agent"], &answer["model"], &answer["how"]),
        (&json!("claude"), &json!("opus"), &json!("fork"))
    );
    assert_eq!(answer["space"]["space"], json!("s2"));
    drop(client);
    assert_eq!(*local.calls.lock().unwrap(), ["ask s1 s2 Which store?"]);

    for ctx in [turn(ToolSet::Review, TurnMode::Run, FleetTools::Steer)] {
        let ep = handle.register_run(ctx.clone());
        let client = connect(&ep.url, &ep.token).await;
        let refused = client
            .call_tool(
                CallToolRequestParams::new("space_ask").with_arguments(
                    json!({"space": "s2", "question": "?"})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            )
            .await;
        assert!(refused.is_err(), "{ctx:?}: {refused:?}");
        drop(client);
    }
    assert_eq!(local.calls.lock().unwrap().len(), 1);
    handle.shutdown().await;
}
