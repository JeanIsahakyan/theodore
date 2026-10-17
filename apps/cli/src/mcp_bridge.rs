//! `theodore mcp-bridge`: stdio↔HTTP proxy so agent CLIs that only speak
//! stdio MCP can reach core's `review-tools` server over localhost HTTP
//! (plan §8.1, D9).

use anyhow::Result;

#[derive(Debug, Clone, clap::Args)]
pub struct McpBridgeArgs {
    /// The `review-tools` server's localhost URL.
    #[arg(long)]
    pub url: String,
    /// Per-run bearer token.
    #[arg(long)]
    pub token: String,
}

/// Run the bridge until stdin closes.
pub async fn run(args: &McpBridgeArgs) -> Result<()> {
    theodore_mcp::run_stdio_bridge(args.url.clone(), args.token.clone()).await?;
    Ok(())
}
