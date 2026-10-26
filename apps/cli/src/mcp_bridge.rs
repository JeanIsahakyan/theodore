//! `theodore mcp-bridge`: stdio↔HTTP proxy so agent CLIs that only speak
//! stdio MCP can reach core's `review-tools` server over localhost HTTP
//! (plan §8.1, D9).

use anyhow::{Context, Result};

/// The bearer token comes from this env var, never from argv — argv is
/// visible to any process on the host via `ps`/`/proc/<pid>/cmdline`, an
/// env var only to the same user (and only while this process is alive).
/// Same var `theodore_agents::codex::MCP_TOKEN_ENV_VAR` sets when it
/// configures Codex's own HTTP MCP override, so a caller spawning this
/// bridge for a stdio-only CLI can set it the same way.
pub const TOKEN_ENV_VAR: &str = theodore_agents::codex::MCP_TOKEN_ENV_VAR;

#[derive(Debug, Clone, clap::Args)]
pub struct McpBridgeArgs {
    /// The `review-tools` server's localhost URL.
    #[arg(long)]
    pub url: String,
}

/// Pure half of the env lookup, so the "must be set" error is testable
/// without mutating the real process environment (`std::env::var` itself
/// isn't, since tests can run concurrently and share it).
fn resolve_token(env_value: Option<String>) -> Result<String> {
    env_value.with_context(|| format!("{TOKEN_ENV_VAR} must be set (never passed as --token)"))
}

/// Run the bridge until stdin closes. The bearer token is read from
/// `REVIEW_TOOLS_TOKEN` (never a `--token` flag: that would put it on
/// argv, readable by any process on the host).
pub async fn run(args: &McpBridgeArgs) -> Result<()> {
    let token = resolve_token(std::env::var(TOKEN_ENV_VAR).ok())?;
    theodore_mcp::run_stdio_bridge(args.url.clone(), token).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_token_env_var_is_a_clear_error_not_a_panic() {
        let err = resolve_token(None).unwrap_err();
        assert!(err.to_string().contains(TOKEN_ENV_VAR));
    }

    #[test]
    fn present_token_env_var_is_used_verbatim() {
        assert_eq!(resolve_token(Some("t".to_string())).unwrap(), "t");
    }
}
