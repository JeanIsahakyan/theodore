//! End-to-end test of the `review-tools` MCP server: a fake backend, a real
//! server over Streamable HTTP, a real rmcp client. Covers every tool plus
//! auth rejection (docs/plan.md §8.3, §9).

use std::sync::Arc;

use async_trait::async_trait;
use rmcp::ServiceExt;
use rmcp::model::CallToolRequestParams;
use rmcp::service::RunningService;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use serde_json::json;
use theodore_domain::{
    AgentId, DiffLine, FileStatus, FindingId, Group, GroupId, GroupKind, Hunk, HunkId, LineKind,
    PrId, RunId,
};
use theodore_mcp::{
    BackendError, FileSummary, GroupSummary, GroupWithHunks, McpServer, NewFinding, NewPatch,
    PrContext, ReviewToolsBackend, RunContext,
};
use tokio::sync::Mutex;

#[derive(Default)]
struct FakeBackend {
    findings: Mutex<Vec<NewFinding>>,
}

#[async_trait]
impl ReviewToolsBackend for FakeBackend {
    async fn get_pr_context(&self, _run: &RunContext) -> Result<PrContext, BackendError> {
        Ok(PrContext {
            title: "Add retries".into(),
            body: "Retries flaky network calls.".into(),
            commits: vec![],
            files: vec![FileSummary {
                path: "src/lib.rs".into(),
                status: FileStatus::Modified,
                additions: 5,
                deletions: 1,
            }],
            groups: vec![GroupSummary {
                id: "g1".into(),
                title: "Retry logic".into(),
                why: "groups the new retry loop".into(),
                hunk_count: 1,
            }],
        })
    }

    async fn get_group(
        &self,
        _run: &RunContext,
        group_id: &str,
    ) -> Result<GroupWithHunks, BackendError> {
        if group_id != "g1" {
            return Err(BackendError::NotFound(format!("no group {group_id}")));
        }
        let hunk = Hunk {
            id: HunkId::new("h1"),
            path: "src/lib.rs".into(),
            old_start: 1,
            old_lines: 1,
            new_start: 1,
            new_lines: 2,
            header: "fn run()".into(),
            lines: vec![
                DiffLine {
                    kind: LineKind::Ctx,
                    text: "fn run() {".into(),
                    old_no: Some(1),
                    new_no: Some(1),
                },
                DiffLine {
                    kind: LineKind::Add,
                    text: "    retry();".into(),
                    old_no: None,
                    new_no: Some(2),
                },
            ],
        };
        let group = Group {
            id: GroupId::new("g1"),
            title: "Retry logic".into(),
            why: "groups the new retry loop".into(),
            kind: GroupKind::Normal,
            risk: None,
            check: vec!["does retry respect backoff?".into()],
            hunks: vec![hunk.id.clone()],
            outliers: vec![],
        };
        Ok(GroupWithHunks {
            group,
            hunks: vec![hunk],
        })
    }

    async fn get_base_file(
        &self,
        _run: &RunContext,
        path: &str,
    ) -> Result<Option<String>, BackendError> {
        Ok((path == "src/lib.rs").then(|| "fn run() {}\n".to_string()))
    }

    async fn add_finding(
        &self,
        _run: &RunContext,
        finding: NewFinding,
    ) -> Result<FindingId, BackendError> {
        let mut findings = self.findings.lock().await;
        let id = FindingId::new(format!("finding-{}", findings.len() + 1));
        findings.push(finding);
        Ok(id)
    }

    async fn propose_patch(&self, _run: &RunContext, _patch: NewPatch) -> Result<(), BackendError> {
        Ok(())
    }
}

fn run_context() -> RunContext {
    RunContext::review(
        RunId::new("run-1"),
        PrId::new("github:acme/widgets#42"),
        AgentId::Claude,
    )
}

fn args(value: serde_json::Value) -> rmcp::model::JsonObject {
    match value {
        serde_json::Value::Object(map) => map,
        other => panic!("expected a JSON object, got {other}"),
    }
}

async fn connect(url: &str, token: &str) -> RunningService<rmcp::RoleClient, ()> {
    let config = StreamableHttpClientTransportConfig::with_uri(url).auth_header(token);
    let transport = StreamableHttpClientTransport::from_config(config);
    ().serve(transport).await.expect("connect to review-tools")
}

#[tokio::test]
async fn lists_and_calls_every_tool() {
    let backend = Arc::new(FakeBackend::default());
    let handle = McpServer::start(backend).await.expect("start server");
    let endpoint = handle.register_run(run_context());

    let client = connect(&endpoint.url, &endpoint.token).await;

    let tools = client.list_all_tools().await.expect("list tools");
    let names: Vec<String> = tools.iter().map(|t| t.name.to_string()).collect();
    for expected in [
        "get_pr_context",
        "get_group",
        "get_base_file",
        "add_finding",
        "propose_patch",
    ] {
        assert!(
            names.contains(&expected.to_string()),
            "missing tool {expected}, have {names:?}"
        );
    }

    let ctx = client
        .call_tool(CallToolRequestParams::new("get_pr_context"))
        .await
        .expect("get_pr_context");
    assert_eq!(ctx.is_error, Some(false));
    assert!(
        ctx.content[0]
            .as_text()
            .expect("text content")
            .text
            .contains("Retry logic")
    );

    let group = client
        .call_tool(
            CallToolRequestParams::new("get_group").with_arguments(args(json!({ "id": "g1" }))),
        )
        .await
        .expect("get_group");
    assert_eq!(group.is_error, Some(false));
    assert!(
        group.content[0]
            .as_text()
            .expect("text content")
            .text
            .contains("retry();")
    );

    let missing_group = client
        .call_tool(
            CallToolRequestParams::new("get_group").with_arguments(args(json!({ "id": "nope" }))),
        )
        .await
        .expect("get_group (missing)");
    assert_eq!(missing_group.is_error, Some(true));

    let base_file = client
        .call_tool(
            CallToolRequestParams::new("get_base_file")
                .with_arguments(args(json!({ "path": "src/lib.rs" }))),
        )
        .await
        .expect("get_base_file");
    assert_eq!(base_file.is_error, Some(false));

    let finding = client
        .call_tool(
            CallToolRequestParams::new("add_finding").with_arguments(args(json!({
                "file": "src/lib.rs",
                "line": 2,
                "severity": "warn",
                "title": "missing backoff",
                "body": "retry() has no backoff between attempts",
            }))),
        )
        .await
        .expect("add_finding");
    assert_eq!(finding.is_error, Some(false));
    let finding_json: serde_json::Value =
        serde_json::from_str(&finding.content[0].as_text().unwrap().text).unwrap();
    let finding_id = finding_json["finding_id"].as_str().unwrap().to_string();
    assert_eq!(finding_id, "finding-1");

    let patch = client
        .call_tool(
            CallToolRequestParams::new("propose_patch").with_arguments(args(json!({
                "finding_id": finding_id,
                "file": "src/lib.rs",
                "before": ["    retry();"],
                "after": ["    retry_with_backoff();"],
                "note": "adds exponential backoff",
            }))),
        )
        .await
        .expect("propose_patch");
    assert_eq!(patch.is_error, Some(false));

    drop(client);
    handle.shutdown().await;
}

#[tokio::test]
async fn rejects_missing_and_unknown_tokens() {
    let backend = Arc::new(FakeBackend::default());
    let handle = McpServer::start(backend).await.expect("start server");
    let url = format!("http://{}/mcp", handle.addr());
    let http = reqwest::Client::new();

    let init_body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": { "name": "test-client", "version": "1.0.0" }
        }
    });

    let no_token = http
        .post(&url)
        .header("Accept", "application/json, text/event-stream")
        .json(&init_body)
        .send()
        .await
        .expect("send");
    assert_eq!(no_token.status(), 401);

    let bad_token = http
        .post(&url)
        .header("Accept", "application/json, text/event-stream")
        .header("Authorization", "Bearer not-a-real-token")
        .json(&init_body)
        .send()
        .await
        .expect("send");
    assert_eq!(bad_token.status(), 401);

    let endpoint = handle.register_run(run_context());
    let good_token = http
        .post(&url)
        .header("Accept", "application/json, text/event-stream")
        .header("Authorization", format!("Bearer {}", endpoint.token))
        .json(&init_body)
        .send()
        .await
        .expect("send");
    assert_eq!(good_token.status(), 200);

    handle.unregister_run(&endpoint.token);
    let revoked = http
        .post(&url)
        .header("Accept", "application/json, text/event-stream")
        .header("Authorization", format!("Bearer {}", endpoint.token))
        .json(&init_body)
        .send()
        .await
        .expect("send");
    assert_eq!(revoked.status(), 401);

    handle.shutdown().await;
}
