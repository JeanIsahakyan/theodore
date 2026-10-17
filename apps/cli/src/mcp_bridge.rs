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

/// Run the bridge. Delegates to `theodore_mcp::run_stdio_bridge`, which is
/// built by the `mcp` slice in parallel and not public yet — the real call
/// is:
///
/// ```ignore
/// theodore_mcp::run_stdio_bridge(&args.url, &args.token).await?;
/// ```
///
/// Until that function exists, this is a clearly marked stub so `theodore
/// mcp-bridge` fails loudly instead of doing nothing silently.
pub async fn run(args: &McpBridgeArgs) -> Result<()> {
    let _ = (&args.url, &args.token);
    anyhow::bail!(
        "mcp-bridge: `theodore_mcp::run_stdio_bridge` doesn't exist yet — \
         `theodore-mcp` is still the scaffold placeholder. Swap in that call \
         here once the mcp slice lands."
    )
}
