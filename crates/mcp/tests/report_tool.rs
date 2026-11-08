//! `report_problem` (docs/telemetry.md "Report from a chat"): listed for a
//! chat run only — a space turn or an AI panel question, never a skill or
//! fix run — and it drafts, never sends.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rmcp::ServiceExt;
use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::service::RunningService;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use serde_json::{Value, json};
use theodore_domain::{AgentId, FindingId, PrId, RunId};
use theodore_mcp::{
    BackendError, CodeTools, GroupWithHunks, McpServer, NewFinding, NewPatch, NoSpaceTools,
    PrContext, REPORT_TOOL, ReportRequest, ReportScope, ReviewToolsBackend, RunContext, ToolSet,
};

/// Records each draft with the run that made it.
#[derive(Default)]
struct Drafts(Mutex<Vec<(String, ReportRequest)>>);

#[async_trait]
impl ReviewToolsBackend for Drafts {
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
    async fn report_problem(
        &self,
        run: &RunContext,
        req: ReportRequest,
    ) -> Result<String, BackendError> {
        self.0.lock().unwrap().push((run.run_id.0.clone(), req));
        Ok("d1".into())
    }
}

async fn connect(url: &str, token: &str) -> RunningService<rmcp::RoleClient, ()> {
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(url.to_string()).auth_header(token),
    );
    ().serve(transport).await.expect("connect")
}

async fn lists_report(client: &RunningService<rmcp::RoleClient, ()>) -> bool {
    client
        .list_all_tools()
        .await
        .expect("list tools")
        .iter()
        .any(|t| t.name == REPORT_TOOL)
}

async fn call(client: &RunningService<rmcp::RoleClient, ()>, args: Value) -> CallToolResult {
    let req =
        CallToolRequestParams::new(REPORT_TOOL).with_arguments(args.as_object().unwrap().clone());
    client.call_tool(req).await.expect("call")
}

fn space_run() -> RunContext {
    RunContext {
        run_id: RunId::new("space:s1:m1"),
        pr: PrId::new("space:s1"),
        agent: AgentId::Claude,
        space: Some("s1".into()),
        tools: ToolSet::Space,
        code: CodeTools::Off,
    }
}

#[tokio::test]
async fn chats_may_draft_a_report_and_other_runs_never_see_it() {
    let drafts = Arc::new(Drafts::default());
    let handle = McpServer::start_with_spaces(drafts.clone(), Arc::new(NoSpaceTools))
        .await
        .unwrap();
    let pr = PrId::new("github:o/r#1");
    let ask = RunContext::review(RunId::new("ask:q1"), pr.clone(), AgentId::Codex);
    let skill = RunContext::review(RunId::new("3f2a"), pr, AgentId::Claude);

    for (run, listed) in [(space_run(), true), (ask, true), (skill, false)] {
        let endpoint = handle.register_run(run.clone());
        let client = connect(&endpoint.url, &endpoint.token).await;
        assert_eq!(lists_report(&client).await, listed, "{run:?}");
        if !listed {
            let refused = client
                .call_tool(
                    CallToolRequestParams::new(REPORT_TOOL)
                        .with_arguments(json!({}).as_object().unwrap().clone()),
                )
                .await;
            assert!(refused.is_err(), "a skill run can't call it: {refused:?}");
        }
        drop(client);
    }
    handle.shutdown().await;
}

#[tokio::test]
async fn the_agent_drafts_and_hears_that_the_user_sends() {
    let drafts = Arc::new(Drafts::default());
    let handle = McpServer::start_with_spaces(drafts.clone(), Arc::new(NoSpaceTools))
        .await
        .unwrap();
    let endpoint = handle.register_run(space_run());
    let client = connect(&endpoint.url, &endpoint.token).await;

    let r = call(
        &client,
        json!({ "title": "Diff pane blank", "description": "It went blank after Undo.",
                "scope": "message", "include_logs": false }),
    )
    .await;
    assert_eq!(r.is_error, Some(false), "{r:?}");
    let body: Value =
        serde_json::from_str(&r.content[0].as_text().expect("text").text).expect("json");
    assert_eq!(body["draft"], "d1");
    assert!(
        body["note"]
            .as_str()
            .unwrap()
            .contains("you cannot send it"),
        "{body}"
    );
    // Nothing asked for: the defaults are the backend's (the run's turn).
    let r = call(&client, json!({})).await;
    assert_eq!(r.is_error, Some(false), "{r:?}");

    let seen = drafts.0.lock().unwrap().clone();
    assert_eq!(seen.len(), 2);
    assert_eq!(
        seen[0].0, "space:s1:m1",
        "the run is the token's, not the agent's"
    );
    assert_eq!(
        seen[0].1,
        ReportRequest {
            title: Some("Diff pane blank".into()),
            description: Some("It went blank after Undo.".into()),
            scope: Some(ReportScope::Message),
            include_logs: Some(false),
        }
    );
    assert_eq!(
        seen[1].1,
        ReportRequest {
            title: None,
            description: None,
            scope: None,
            include_logs: None,
        }
    );
    drop(client);
    handle.shutdown().await;
}
