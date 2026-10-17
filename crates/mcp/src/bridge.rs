//! Stdio→HTTP MCP bridge: serves MCP over our own stdin/stdout and proxies
//! every request to a `review-tools` HTTP endpoint. For agent CLIs that only
//! speak stdio MCP (plan §8.1, §8.3). The CLI subcommand that spawns this is
//! wired elsewhere; this is the library function it calls.

use std::sync::Arc;

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, ListToolsResult, PaginatedRequestParams,
    ServerCapabilities, ServerConfig,
};
use rmcp::service::{RequestContext, RunningService};
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::{ErrorData, RoleClient, RoleServer, ServerHandler, ServiceExt};

#[derive(Debug, thiserror::Error)]
pub enum BridgeError {
    #[error("connecting to review-tools endpoint: {0}")]
    Connect(String),
    #[error("serving the stdio bridge: {0}")]
    Serve(String),
}

/// Forwards every `tools/list` / `tools/call` it receives to a single upstream
/// MCP connection, unchanged. No tool knowledge of its own. Holds the whole
/// `RunningService`, not just its `Peer`: dropping the service would close
/// the upstream HTTP connection out from under the peer.
#[derive(Clone)]
struct BridgeHandler {
    upstream: Arc<RunningService<RoleClient, ()>>,
}

impl ServerHandler for BridgeHandler {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let tools = self
            .upstream
            .list_all_tools()
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(ListToolsResult::with_all_items(tools))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        self.upstream
            .call_tool_once(request)
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))
    }
}

/// Connects to the `review-tools` HTTP endpoint at `url` with bearer `token`,
/// then serves MCP over this process's own stdin/stdout, proxying every
/// request. Runs until stdin closes.
pub async fn run_stdio_bridge(
    url: impl Into<String>,
    token: impl Into<String>,
) -> Result<(), BridgeError> {
    let peer = connect_upstream(url, token).await?;
    serve_bridge(peer, rmcp::transport::stdio()).await
}

async fn connect_upstream(
    url: impl Into<String>,
    token: impl Into<String>,
) -> Result<RunningService<RoleClient, ()>, BridgeError> {
    let config =
        StreamableHttpClientTransportConfig::with_uri(url.into()).auth_header(token.into());
    let transport = StreamableHttpClientTransport::from_config(config);
    ().serve(transport)
        .await
        .map_err(|e| BridgeError::Connect(e.to_string()))
}

/// Serves the bridge handler over `transport` (stdio in production; an
/// in-process duplex pipe in tests). Returns once the transport closes.
async fn serve_bridge<T, E, A>(
    upstream: RunningService<RoleClient, ()>,
    transport: T,
) -> Result<(), BridgeError>
where
    T: rmcp::transport::IntoTransport<RoleServer, E, A>,
    E: std::error::Error + Send + Sync + 'static,
{
    let handler = BridgeHandler {
        upstream: Arc::new(upstream),
    };
    let running = handler
        .serve(transport)
        .await
        .map_err(|e| BridgeError::Serve(e.to_string()))?;
    running
        .waiting()
        .await
        .map_err(|e| BridgeError::Serve(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use async_trait::async_trait;
    use rmcp::model::CallToolRequestParams;
    use theodore_domain::{AgentId, PrId, RunId};

    use super::*;
    use crate::backend::{
        BackendError, GroupWithHunks, NewFinding, NewPatch, PrContext, ReviewToolsBackend,
        RunContext,
    };
    use crate::server::McpServer;

    #[derive(Default)]
    struct EmptyBackend;

    #[async_trait]
    impl ReviewToolsBackend for EmptyBackend {
        async fn get_pr_context(&self, _run: &RunContext) -> Result<PrContext, BackendError> {
            Ok(PrContext {
                title: "t".into(),
                body: "b".into(),
                commits: vec![],
                files: vec![],
                groups: vec![],
            })
        }
        async fn get_group(
            &self,
            _run: &RunContext,
            _group_id: &str,
        ) -> Result<GroupWithHunks, BackendError> {
            Err(BackendError::NotFound("no groups".into()))
        }
        async fn get_base_file(
            &self,
            _run: &RunContext,
            _path: &str,
        ) -> Result<Option<String>, BackendError> {
            Ok(None)
        }
        async fn add_finding(
            &self,
            _run: &RunContext,
            _finding: NewFinding,
        ) -> Result<theodore_domain::FindingId, BackendError> {
            Ok(theodore_domain::FindingId::new("f1"))
        }
        async fn propose_patch(
            &self,
            _run: &RunContext,
            _patch: NewPatch,
        ) -> Result<(), BackendError> {
            Ok(())
        }
    }

    fn run_context() -> RunContext {
        RunContext {
            run_id: RunId::new("run-1"),
            pr: PrId::new("github:o/r#1"),
            agent: AgentId::Claude,
        }
    }

    /// Bridge over in-process pipes: a real `McpServer` is the upstream, a
    /// duplex pipe stands in for stdio on the bridge's local side, and a
    /// plain rmcp client drives the other end of that pipe.
    #[tokio::test]
    async fn proxies_list_and_call_over_duplex_pipe() {
        let backend = Arc::new(EmptyBackend);
        let handle = McpServer::start(backend).await.expect("start server");
        let endpoint = handle.register_run(run_context());

        let upstream = connect_upstream(endpoint.url.clone(), endpoint.token.clone())
            .await
            .expect("connect upstream");

        let (bridge_side, client_side) = tokio::io::duplex(64 * 1024);
        let bridge_task = tokio::spawn(serve_bridge(upstream, bridge_side));

        let client = ().serve(client_side).await.expect("connect to bridge");

        let tools = client.list_all_tools().await.expect("list tools");
        assert!(tools.iter().any(|t| t.name == "get_pr_context"));

        let result = client
            .call_tool(CallToolRequestParams::new("get_pr_context"))
            .await
            .expect("call tool");
        assert_eq!(result.is_error, Some(false));

        drop(client);
        let _ = bridge_task.await;
        handle.shutdown().await;
    }
}
