//! Which models each CLI can run, and the effort levels each takes, for the
//! model picker (`AgentPort::models`).
//!
//! ```text
//! claude ─▶ static: Claude Code's `--model` aliases × `--effort` levels
//! codex  ─▶ `codex debug models` (JSON) ─▶ visibility "list", by priority
//! gemini ─▶ []
//! ```

use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use theodore_ports::agent::ModelInfo;

use crate::claude::EFFORT_LEVELS;

/// `codex debug models` is a few hundred ms; a hung one must not hold the
/// picker forever.
const CODEX_MODELS_TIMEOUT: Duration = Duration::from_secs(15);

/// Claude Code's `--model` aliases (each the latest of its family), newest
/// family first.
pub fn claude_models() -> Vec<ModelInfo> {
    [
        ("fable", "Fable", "Newest"),
        ("opus", "Opus", "Deep reasoning"),
        ("sonnet", "Sonnet", "Balanced"),
        ("haiku", "Haiku", "Fastest, cheapest"),
    ]
    .into_iter()
    .map(|(id, label, description)| ModelInfo {
        id: id.to_string(),
        label: label.to_string(),
        description: Some(description.to_string()),
        efforts: EFFORT_LEVELS.iter().map(|e| e.to_string()).collect(),
        default_effort: None,
    })
    .collect()
}

#[derive(Deserialize)]
struct CodexModels {
    models: Vec<CodexModel>,
}

#[derive(Deserialize)]
struct CodexModel {
    slug: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    default_reasoning_level: Option<String>,
    #[serde(default)]
    supported_reasoning_levels: Vec<CodexReasoningLevel>,
    #[serde(default)]
    visibility: Option<String>,
    #[serde(default)]
    priority: i64,
}

#[derive(Deserialize)]
struct CodexReasoningLevel {
    effort: String,
}

/// Pure: `codex debug models` stdout → the models the picker lists. Only
/// `visibility: "list"` (the ones Codex's own picker shows), by `priority`
/// ascending; ties keep Codex's order.
pub fn parse_codex_models(json: &str) -> Result<Vec<ModelInfo>, serde_json::Error> {
    let parsed: CodexModels = serde_json::from_str(json)?;
    let mut listed: Vec<CodexModel> = parsed
        .models
        .into_iter()
        .filter(|m| m.visibility.as_deref() == Some("list"))
        .collect();
    listed.sort_by_key(|m| m.priority);
    Ok(listed
        .into_iter()
        .map(|m| ModelInfo {
            label: m
                .display_name
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| m.slug.clone()),
            id: m.slug,
            description: m.description.filter(|s| !s.trim().is_empty()),
            efforts: m
                .supported_reasoning_levels
                .into_iter()
                .map(|l| l.effort)
                .collect(),
            default_effort: m.default_reasoning_level,
        })
        .collect())
}

/// Run `<codex> debug models` and parse it. `Err` carries a one-line reason
/// for the log.
pub async fn codex_models(program: &Path) -> Result<Vec<ModelInfo>, String> {
    let fut = tokio::process::Command::new(program)
        .args(["debug", "models"])
        .env_clear()
        .envs(crate::env::filtered_env())
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(CODEX_MODELS_TIMEOUT, fut)
        .await
        .map_err(|_| format!("timed out after {}s", CODEX_MODELS_TIMEOUT.as_secs()))?
        .map_err(|e| format!("spawn failed: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr.trim().chars().rev().take(300).collect();
        let tail: String = tail.chars().rev().collect();
        return Err(format!("exited with {}: {tail}", output.status));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_codex_models(&stdout).map_err(|e| format!("bad JSON: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    const SAMPLE: &str = r#"{
      "models": [
        {
          "slug": "gpt-b",
          "display_name": "GPT-B",
          "description": "Second.",
          "default_reasoning_level": "low",
          "supported_reasoning_levels": [
            {"effort": "low", "description": "Fast"},
            {"effort": "high", "description": "Deep"}
          ],
          "visibility": "list",
          "priority": 5,
          "context_window": 272000
        },
        {
          "slug": "gpt-hidden",
          "display_name": "Hidden",
          "description": "Not in the picker.",
          "default_reasoning_level": "medium",
          "supported_reasoning_levels": [{"effort": "medium", "description": ""}],
          "visibility": "hide",
          "priority": 0
        },
        {
          "slug": "gpt-a",
          "display_name": "GPT-A",
          "description": "First.",
          "default_reasoning_level": "medium",
          "supported_reasoning_levels": [
            {"effort": "low", "description": ""},
            {"effort": "medium", "description": ""},
            {"effort": "xhigh", "description": ""}
          ],
          "visibility": "list",
          "priority": 1
        }
      ]
    }"#;

    #[test]
    fn codex_lists_visible_models_by_priority() {
        let models = parse_codex_models(SAMPLE).unwrap();
        assert_eq!(
            models,
            vec![
                ModelInfo {
                    id: "gpt-a".into(),
                    label: "GPT-A".into(),
                    description: Some("First.".into()),
                    efforts: vec!["low".into(), "medium".into(), "xhigh".into()],
                    default_effort: Some("medium".into()),
                },
                ModelInfo {
                    id: "gpt-b".into(),
                    label: "GPT-B".into(),
                    description: Some("Second.".into()),
                    efforts: vec!["low".into(), "high".into()],
                    default_effort: Some("low".into()),
                },
            ]
        );
    }

    #[test]
    fn codex_missing_fields_fall_back() {
        let models =
            parse_codex_models(r#"{"models":[{"slug":"bare","visibility":"list"}]}"#).unwrap();
        assert_eq!(
            models,
            vec![ModelInfo {
                id: "bare".into(),
                label: "bare".into(),
                description: None,
                efforts: vec![],
                default_effort: None,
            }]
        );
    }

    #[test]
    fn codex_bad_json_is_an_error() {
        assert!(parse_codex_models("not json").is_err());
        assert!(parse_codex_models(r#"{"other":[]}"#).is_err());
    }

    #[test]
    fn claude_aliases_in_order_with_every_effort() {
        let models = claude_models();
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["fable", "opus", "sonnet", "haiku"]);
        for m in &models {
            assert_eq!(m.efforts, ["low", "medium", "high", "xhigh", "max"]);
            assert_eq!(m.default_effort, None);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn codex_models_runs_the_binary() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let ok = dir.path().join("codex");
        std::fs::write(
            &ok,
            "#!/bin/sh\n[ \"$1 $2\" = \"debug models\" ] || exit 2\n\
             echo '{\"models\":[{\"slug\":\"m\",\"visibility\":\"list\"}]}'\n",
        )
        .unwrap();
        std::fs::set_permissions(&ok, std::fs::Permissions::from_mode(0o755)).unwrap();
        let models = codex_models(&ok).await.unwrap();
        assert_eq!(models.len(), 1);

        let bad = dir.path().join("codex-fails");
        std::fs::write(&bad, "#!/bin/sh\necho nope >&2\nexit 1\n").unwrap();
        std::fs::set_permissions(&bad, std::fs::Permissions::from_mode(0o755)).unwrap();
        let err = codex_models(&bad).await.unwrap_err();
        assert!(err.contains("nope"), "{err}");
    }
}
