//! Synthetic agent adapter (`AgentPort`): computes every answer from the
//! prompt itself instead of replaying a recording, so it works for any PR
//! without spending a token.
//!
//! What a run does is decided by the prompt's shape (first match wins):
//!
//! | prompt                                  | answer                                  |
//! | --------------------------------------- | --------------------------------------- |
//! | `AgentMode::Edit` (fix task)            | appends a comment line to one file      |
//! | `# Files and hunks` (initial grouping)  | one group per top-level dir / skim / docs |
//! | `{"order"` (merge pass)                 | the listed order, unchanged             |
//! | `# Existing groups` (regroup + repair)  | each hunk into its directory's group    |
//! | `Known hunk ids` (grouping repair)      | every id in one `all-changes` group     |
//! | skill prompt (`get_pr_context` + `add_finding`) | one finding over MCP            |
//! | anything else (chat / ask)              | `Synthetic answer: <last line>`         |
//!
//! Every run streams one `Text` line, any tool calls, then exactly one
//! `Done` (or `Error { message: "cancelled" }`).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rmcp::RoleClient;
use rmcp::service::RunningService;
use serde_json::{Value, json};
use theodore_domain::{AgentId, Usage};
use theodore_ports::{
    AgentError, AgentEvent, AgentInfo, AgentMode, AgentPort, AgentRequest, AgentRun, McpEndpoint,
    ModelInfo,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::agent::{call_tool, connect_mcp};

/// Deterministic, token-free agent: answers grouping, merge, regroup and
/// repair prompts with a valid directory-based grouping, makes a real small
/// edit for fix tasks, reports one finding over MCP for skill runs, and
/// echoes chat questions.
#[derive(Debug, Clone, Default)]
pub struct SynthAgents {
    delay_ms: u64,
}

impl SynthAgents {
    pub fn new() -> Self {
        Self::default()
    }

    /// Wait this long (cancellably) after the first `Text` event before
    /// doing the work and sending `Done`, so a UI can show a run in progress.
    pub fn with_delay_ms(mut self, delay_ms: u64) -> Self {
        self.delay_ms = delay_ms;
        self
    }
}

fn synth_usage() -> Usage {
    Usage {
        input_tokens: 500,
        output_tokens: 100,
        usd: 0.002,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Job {
    Fix,
    Grouping,
    Merge,
    Regroup,
    Repair,
    Skill,
    Chat,
}

impl Job {
    fn label(self) -> &'static str {
        match self {
            Job::Fix => "fixing the task",
            Job::Grouping => "grouping hunks",
            Job::Merge => "ordering groups",
            Job::Regroup => "placing pushed hunks",
            Job::Repair => "repairing the grouping",
            Job::Skill => "reviewing over review-tools",
            Job::Chat => "answering",
        }
    }
}

/// `Edit` mode is checked first: only fix runs use it, and a task body is
/// free text that could quote any of the grouping markers below.
fn classify(req: &AgentRequest) -> Job {
    if matches!(req.mode, AgentMode::Edit | AgentMode::Run) {
        return Job::Fix;
    }
    let system = req.system.as_deref().unwrap_or("");
    let has = |needle: &str| req.prompt.contains(needle) || system.contains(needle);
    if has("# Files and hunks") {
        Job::Grouping
    } else if has("{\"order\"") {
        Job::Merge
    } else if has("# Existing groups") {
        // Also the incremental repair prompt: it embeds the original request.
        Job::Regroup
    } else if has("Known hunk ids") {
        Job::Repair
    } else if is_skill_prompt(&req.prompt) {
        Job::Skill
    } else {
        Job::Chat
    }
}

/// Skill prompts (`app::usecases::agents::skill_prompt`) always carry the
/// review-tools instructions; an ask/chat question does not.
fn is_skill_prompt(prompt: &str) -> bool {
    prompt.contains("get_pr_context") && prompt.contains("add_finding")
}

// ── shared helpers ───────────────────────────────────────────────────────────

/// kebab-case: lowercase ASCII alphanumerics, everything else one `-`.
fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() { "x".to_string() } else { out }
}

/// First path segment; `""` for a file in the repository root.
fn top_level_dir(path: &str) -> &str {
    path.split_once('/').map(|(d, _)| d).unwrap_or("")
}

fn is_markdown(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(".md")
}

/// The group id a hunk in `path` gets from the initial grouping (docs aside).
fn dir_group_id(dir: &str, skim: bool) -> String {
    let base = if dir.is_empty() {
        "root".to_string()
    } else {
        format!("dir-{}", slug(dir))
    };
    if skim { format!("{base}-skim") } else { base }
}

// ── initial grouping ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
struct PromptHunk {
    id: String,
    skim: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PromptFile {
    path: String,
    status: String,
    hunks: Vec<PromptHunk>,
}

/// Parses `## <path> (<Status>)` and `### hunk <id> — <header>[ [skim
/// candidate: …]]` lines from the `# Files and hunks` section. Excerpt lines
/// all start with `+`, `-`, ` ` or `…`, so they never look like headers.
fn parse_files_and_hunks(user: &str) -> Vec<PromptFile> {
    let Some(start) = user.rfind("# Files and hunks") else {
        return vec![];
    };
    let mut files: Vec<PromptFile> = Vec::new();
    for line in user[start..].lines().skip(1) {
        if let Some(rest) = line.strip_prefix("### hunk ") {
            let (id, tail) = rest.split_once(" — ").unwrap_or((rest, ""));
            let hunk = PromptHunk {
                id: id.trim().to_string(),
                skim: tail.contains("[skim candidate:"),
            };
            if let Some(file) = files.last_mut() {
                file.hunks.push(hunk);
            }
        } else if let Some(rest) = line.strip_prefix("## ")
            && let Some((path, status)) = rest.rsplit_once(" (")
            && let Some(status) = status.strip_suffix(')')
        {
            files.push(PromptFile {
                path: path.to_string(),
                status: status.to_string(),
                hunks: vec![],
            });
        }
    }
    files
}

/// `Some(label)` when the prompt is one directory chunk of a split PR.
fn part_label(system: &str) -> Option<&str> {
    let rest = system.split_once("You are reviewing one part (`")?.1;
    rest.split_once("`)").map(|(label, _)| label)
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Bucket {
    Dir { dir: String, skim: bool },
    Docs,
}

struct BucketAcc {
    bucket: Bucket,
    files: BTreeSet<String>,
    hunks: Vec<String>,
}

fn files_phrase(n: usize) -> String {
    if n == 1 {
        "1 file".to_string()
    } else {
        format!("{n} files")
    }
}

fn unique_id(base: String, used: &mut BTreeSet<String>) -> String {
    let mut id = base.clone();
    let mut n = 2;
    while used.contains(&id) {
        id = format!("{base}-{n}");
        n += 1;
    }
    used.insert(id.clone());
    id
}

/// Answer to an initial grouping prompt: `{"groups": [...]}`.
fn synth_grouping(system: &str, user: &str) -> String {
    let files = parse_files_and_hunks(user);
    let mut buckets: Vec<BucketAcc> = Vec::new();
    for file in &files {
        for hunk in &file.hunks {
            let bucket = if is_markdown(&file.path) {
                Bucket::Docs
            } else {
                Bucket::Dir {
                    dir: top_level_dir(&file.path).to_string(),
                    skim: hunk.skim,
                }
            };
            let idx = match buckets.iter().position(|b| b.bucket == bucket) {
                Some(i) => i,
                None => {
                    buckets.push(BucketAcc {
                        bucket,
                        files: BTreeSet::new(),
                        hunks: vec![],
                    });
                    buckets.len() - 1
                }
            };
            buckets[idx].files.insert(file.path.clone());
            buckets[idx].hunks.push(hunk.id.clone());
        }
    }

    // Reading order: code first, then docs, then mechanical edits.
    let rank = |b: &Bucket| match b {
        Bucket::Dir { skim: false, .. } => 0,
        Bucket::Docs => 1,
        Bucket::Dir { skim: true, .. } => 2,
    };
    buckets.sort_by_key(|b| rank(&b.bucket));

    // Docs of different chunks of a split PR must not share one id.
    let docs_id = match part_label(system) {
        Some(label) => format!("docs-{}", slug(label)),
        None => "docs".to_string(),
    };

    let mut used = BTreeSet::new();
    let groups: Vec<Value> = buckets
        .into_iter()
        .map(|acc| {
            let n = files_phrase(acc.files.len());
            let (base, title, kind, why, check) = match &acc.bucket {
                Bucket::Docs => (
                    docs_id.clone(),
                    "Docs".to_string(),
                    "normal",
                    format!("Updates {n} of Markdown documentation."),
                    "The docs describe what the code now does".to_string(),
                ),
                Bucket::Dir { dir, skim } => {
                    let place = if dir.is_empty() {
                        "the repository root".to_string()
                    } else {
                        format!("{dir}/")
                    };
                    if *skim {
                        (
                            dir_group_id(dir, true),
                            format!("Mechanical edits in {place}"),
                            "skim",
                            format!(
                                "Mechanical-looking edits (renames, formatting, imports) \
                                 across {n} in {place}."
                            ),
                            "Nothing beyond the mechanical edit hides in here".to_string(),
                        )
                    } else {
                        let title = if dir.is_empty() {
                            "Repository root".to_string()
                        } else {
                            format!("Changes in {place}")
                        };
                        (
                            dir_group_id(dir, false),
                            title,
                            "normal",
                            format!("Changes {n} in {place}."),
                            format!("The changes in {place} match the PR description"),
                        )
                    }
                }
            };
            json!({
                "id": unique_id(base, &mut used),
                "title": title,
                "why": why,
                "kind": kind,
                "check": [check],
                "hunks": acc.hunks,
                "outliers": [],
            })
        })
        .collect();
    json!({ "groups": groups }).to_string()
}

// ── merge pass ───────────────────────────────────────────────────────────────

/// `- <group id> — "<title>" …` lines of a merge prompt, in order.
fn parse_group_list(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|l| l.strip_prefix("- "))
        .filter_map(|l| l.split_once(" — \"").map(|(id, _)| id.trim().to_string()))
        .collect()
}

fn synth_merge(user: &str) -> String {
    let body = user
        .split_once("Below are the groups")
        .map(|(_, rest)| rest)
        .unwrap_or(user);
    json!({ "order": parse_group_list(body) }).to_string()
}

// ── regroup after a push ─────────────────────────────────────────────────────

/// Answer to an incremental regroup prompt (or its repair, which embeds the
/// original request after `Original request:`).
fn synth_regroup(prompt: &str) -> String {
    let body = prompt
        .split_once("Original request:")
        .map(|(_, rest)| rest)
        .unwrap_or(prompt);
    let existing: Vec<String> = match body.split_once("# Existing groups") {
        Some((_, rest)) => {
            let section = rest
                .split_once("\n# New / changed hunks")
                .map(|(s, _)| s)
                .unwrap_or(rest);
            parse_group_list(section)
        }
        None => vec![],
    };
    let hunks: Vec<(String, String)> = body
        .lines()
        .filter_map(|l| l.strip_prefix("## hunk "))
        .map(|rest| {
            let (id, tail) = rest.split_once(" — ").unwrap_or((rest, ""));
            let path = tail.split_once(" (").map(|(p, _)| p).unwrap_or(tail);
            (id.trim().to_string(), path.trim().to_string())
        })
        .collect();

    let mut new_groups = vec![];
    let fallback = match existing.first() {
        Some(first) => first.clone(),
        None => {
            new_groups.push(json!({
                "id": "pushed",
                "title": "Pushed changes",
                "why": "Hunks added or changed by the latest push.",
                "kind": "normal",
                "check": ["The pushed changes fit the rest of the PR"],
            }));
            "pushed".to_string()
        }
    };
    let assignments: Vec<Value> = hunks
        .iter()
        .map(|(id, path)| {
            let wanted = if is_markdown(path) {
                existing
                    .iter()
                    .find(|g| *g == "docs" || g.starts_with("docs-"))
                    .cloned()
            } else {
                let dir_id = dir_group_id(top_level_dir(path), false);
                existing.iter().find(|g| **g == dir_id).cloned()
            };
            json!({ "hunk": id, "group": wanted.unwrap_or_else(|| fallback.clone()) })
        })
        .collect();
    json!({ "assignments": assignments, "new_groups": new_groups }).to_string()
}

// ── grouping repair ──────────────────────────────────────────────────────────

fn synth_repair(user: &str) -> String {
    let ids: Vec<String> = match user.split_once("Known hunk ids") {
        Some((_, rest)) => rest
            .lines()
            .skip(1)
            .take_while(|l| !l.trim().is_empty())
            .filter_map(|l| l.strip_prefix("- "))
            .map(|id| id.trim().to_string())
            .collect(),
        None => vec![],
    };
    json!({
        "groups": [{
            "id": "all-changes",
            "title": "All changes",
            "why": format!("Every one of the {} hunk(s) in one group.", ids.len()),
            "kind": "normal",
            "check": ["The PR does what its title says"],
            "hunks": ids,
            "outliers": [],
        }]
    })
    .to_string()
}

// ── chat ─────────────────────────────────────────────────────────────────────

fn synth_chat(prompt: &str) -> String {
    let last = prompt
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let cut: String = last.chars().take(80).collect();
    format!("Synthetic answer: {cut}")
}

// ── MCP tool calls ───────────────────────────────────────────────────────────

/// Places one tool call, streaming its `ToolCall` / `ToolResult` events.
/// `Some(json)` when the call succeeded and returned JSON.
async fn tool(
    client: &RunningService<RoleClient, ()>,
    tx: &mpsc::Sender<AgentEvent>,
    seq: &mut u32,
    name: &str,
    input: Value,
) -> Option<Value> {
    *seq += 1;
    let id = format!("synth-{seq}");
    let _ = tx
        .send(AgentEvent::ToolCall {
            id: id.clone(),
            name: name.to_string(),
            input: input.clone(),
        })
        .await;
    let (ok, output) = call_tool(client, name, &input).await;
    let parsed = if ok {
        serde_json::from_str(&output).ok()
    } else {
        None
    };
    let _ = tx.send(AgentEvent::ToolResult { id, ok, output }).await;
    parsed
}

/// `(path, status)` of every file in a `get_pr_context` result.
fn context_files(ctx: &Value) -> Vec<(String, String)> {
    ctx.get("files")
        .and_then(Value::as_array)
        .map(|files| {
            files
                .iter()
                .filter_map(|f| {
                    Some((
                        f.get("path")?.as_str()?.to_string(),
                        f.get("status")?.as_str().unwrap_or("").to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// First added (`+`) line of a unified diff as `(path, new-side line)`.
/// Hunk bodies are walked by their `@@ -a,b +c,d @@` counts, so `---` /
/// `+++` file headers between hunks are never mistaken for diff lines.
fn first_added_line(diff: &str) -> Option<(String, u32)> {
    let mut file: Option<&str> = None;
    let mut new_no = 0u32;
    let mut old_left = 0u32;
    let mut new_left = 0u32;
    for line in diff.lines() {
        if old_left == 0 && new_left == 0 {
            if let Some(p) = line.strip_prefix("+++ b/") {
                file = Some(p);
            } else if let Some(h) = line.strip_prefix("@@ -") {
                let mut parts = h.split_whitespace();
                let old = parts.next().unwrap_or("");
                let new = parts.next().unwrap_or("").trim_start_matches('+');
                let range = |s: &str| -> (u32, u32) {
                    let (start, len) = s.split_once(',').unwrap_or((s, "1"));
                    (start.parse().unwrap_or(1), len.parse().unwrap_or(1))
                };
                let (_, ol) = range(old);
                let (ns, nl) = range(new);
                new_no = ns;
                old_left = ol;
                new_left = nl;
            }
            continue;
        }
        match line.chars().next() {
            Some('+') => {
                if let Some(f) = file {
                    return Some((f.to_string(), new_no.max(1)));
                }
                new_no += 1;
                new_left = new_left.saturating_sub(1);
            }
            Some('-') => old_left = old_left.saturating_sub(1),
            _ => {
                new_no += 1;
                old_left = old_left.saturating_sub(1);
                new_left = new_left.saturating_sub(1);
            }
        }
    }
    None
}

// ── skill run ────────────────────────────────────────────────────────────────

async fn run_skill(
    endpoint: Option<&McpEndpoint>,
    tx: &mpsc::Sender<AgentEvent>,
    cancel: &CancellationToken,
) -> Option<String> {
    let Some(endpoint) = endpoint else {
        return Some(
            "Synthetic skill run: no review-tools MCP endpoint was given, so no findings \
             were reported."
                .to_string(),
        );
    };
    let client = match connect_mcp(endpoint).await {
        Ok(c) => c,
        Err(e) => {
            return Some(format!(
                "Synthetic skill run: review-tools MCP is unreachable ({e}); no findings \
                 were reported."
            ));
        }
    };
    let summary = skill_with(&client, tx, cancel).await;
    // Close the session while this run's token is still valid; a dropped
    // client deletes it after the run ends and gets a 401.
    let _ = client.cancel().await;
    summary
}

async fn skill_with(
    client: &RunningService<RoleClient, ()>,
    tx: &mpsc::Sender<AgentEvent>,
    cancel: &CancellationToken,
) -> Option<String> {
    let mut seq = 0;
    let Some(ctx) = tool(client, tx, &mut seq, "get_pr_context", json!({})).await else {
        return Some("Synthetic skill run: get_pr_context failed; no findings.".to_string());
    };

    let mut target = None;
    let first_group = ctx
        .get("groups")
        .and_then(Value::as_array)
        .and_then(|g| g.first())
        .and_then(|g| g.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    if let Some(group) = first_group
        && let Some(g) = tool(client, tx, &mut seq, "get_group", json!({ "id": group })).await
    {
        target = g
            .get("diff")
            .and_then(Value::as_str)
            .and_then(first_added_line);
    }
    let target = target.or_else(|| {
        context_files(&ctx)
            .into_iter()
            .find(|(_, status)| status != "deleted")
            .map(|(path, _)| (path, 1))
    });
    let Some((file, line)) = target else {
        return Some("Synthetic skill run: the PR has no files to review.".to_string());
    };

    if cancel.is_cancelled() || tx.is_closed() {
        return None;
    }
    let input = json!({
        "file": file,
        "line": line,
        "severity": "warn",
        "title": "Synthetic finding",
        "body": format!("Deterministic sandbox finding on {file}:{line}."),
    });
    match tool(client, tx, &mut seq, "add_finding", input).await {
        Some(_) => Some("reported 1 finding".to_string()),
        None => Some("Synthetic skill run: add_finding failed; no findings.".to_string()),
    }
}

// ── fix task (Edit mode) ─────────────────────────────────────────────────────

fn fix_title(prompt: &str) -> String {
    prompt
        .lines()
        .find_map(|l| l.strip_prefix("Title: "))
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "review task".to_string())
}

/// Repo-relative path-looking tokens in the prompt, in order of appearance:
/// contain `/` or `.`, no absolute paths, no `..`, `:line[:col]` stripped.
fn path_candidates(prompt: &str) -> Vec<String> {
    let mut out = Vec::new();
    for raw in prompt.split(|c: char| c.is_whitespace() || c == '`') {
        let mut t = raw.trim_matches(|c: char| "\"'()[]{}<>,;!?".contains(c));
        t = t.trim_end_matches(['.', ':']);
        t = t.strip_prefix("./").unwrap_or(t);
        // `path:12` or `path:12:3`
        while let Some((head, tail)) = t.rsplit_once(':') {
            if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) {
                t = head;
            } else {
                break;
            }
        }
        if t.is_empty()
            || !(t.contains('/') || t.contains('.'))
            || t.starts_with('/')
            || t.contains("..")
            || t.contains("://")
        {
            continue;
        }
        if !out.iter().any(|o| o == t) {
            out.push(t.to_string());
        }
    }
    out
}

/// `cwd/rel` if it is a regular file that really lives inside `cwd` (no
/// symlink escape) and outside `.git`.
fn resolve_in_cwd(cwd: &Path, rel: &str) -> Option<PathBuf> {
    let path = cwd.join(rel);
    if !path.is_file() {
        return None;
    }
    let root = cwd.canonicalize().ok()?;
    let real = path.canonicalize().ok()?;
    let inside = real.starts_with(&root)
        && !real
            .strip_prefix(&root)
            .ok()?
            .components()
            .any(|c| c.as_os_str() == ".git");
    inside.then_some(real)
}

fn is_text_file(path: &Path) -> bool {
    match std::fs::read(path) {
        Ok(bytes) => !bytes.contains(&0) && std::str::from_utf8(&bytes).is_ok(),
        Err(_) => false,
    }
}

/// First text file under `cwd` in sorted depth-first order, skipping `.git`.
fn first_text_file(cwd: &Path) -> Option<PathBuf> {
    fn walk(dir: &Path, budget: &mut usize) -> Option<PathBuf> {
        let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
            .ok()?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .collect();
        entries.sort();
        for path in entries {
            if *budget == 0 {
                return None;
            }
            *budget -= 1;
            // `.git` is a directory in a clone but a file in a worktree.
            if path.file_name().is_some_and(|n| n == ".git") {
                continue;
            }
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.is_dir() {
                if let Some(found) = walk(&path, budget) {
                    return Some(found);
                }
            } else if meta.is_file() && is_text_file(&path) {
                return Some(path);
            }
        }
        None
    }
    let mut budget = 10_000;
    walk(cwd, &mut budget)
}

fn comment_line(path: &Path, title: &str) -> String {
    let title = title.lines().next().unwrap_or("").trim();
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "py" | "sh" | "rb" | "yml" | "yaml" | "toml" => format!("# sandbox fix: {title}"),
        "md" | "html" => format!("<!-- sandbox fix: {} -->", title.replace("--", "-")),
        _ => format!("// sandbox fix: {title}"),
    }
}

fn append_line(path: &Path, line: &str) -> std::io::Result<()> {
    let mut content = std::fs::read_to_string(path)?;
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(line);
    content.push('\n');
    std::fs::write(path, content)
}

async fn run_fix(
    req: &AgentRequest,
    tx: &mpsc::Sender<AgentEvent>,
    cancel: &CancellationToken,
) -> Option<String> {
    let title = fix_title(&req.prompt);
    let cwd = req.cwd.as_path();

    let mut target = path_candidates(&req.prompt)
        .iter()
        .find_map(|rel| resolve_in_cwd(cwd, rel));
    // Only a PR's fix run has `get_pr_context`; a space turn's server is
    // `space-tools`.
    if target.is_none()
        && let Some(endpoint) = &req.mcp
        && endpoint.name == theodore_ports::REVIEW_TOOLS
        && let Ok(client) = connect_mcp(endpoint).await
    {
        let mut seq = 0;
        if let Some(ctx) = tool(&client, tx, &mut seq, "get_pr_context", json!({})).await {
            target = context_files(&ctx)
                .into_iter()
                .filter(|(_, status)| status != "deleted")
                .find_map(|(path, _)| resolve_in_cwd(cwd, &path));
        }
        let _ = client.cancel().await;
    }
    let target = target.or_else(|| first_text_file(cwd).and_then(|p| p.canonicalize().ok()));
    let Some(target) = target else {
        return Some(format!(
            "Synthetic fix for \"{title}\": no file to edit in {}.",
            cwd.display()
        ));
    };

    if cancel.is_cancelled() || tx.is_closed() {
        return None;
    }
    let line = comment_line(&target, &title);
    let shown = cwd
        .canonicalize()
        .ok()
        .and_then(|root| target.strip_prefix(&root).ok().map(Path::to_path_buf))
        .unwrap_or_else(|| target.clone());
    Some(match append_line(&target, &line) {
        Ok(()) => format!(
            "Synthetic fix for \"{title}\": appended `{line}` to {}.",
            shown.display()
        ),
        Err(e) => format!(
            "Synthetic fix for \"{title}\": could not edit {}: {e}",
            shown.display()
        ),
    })
}

// ── the port ─────────────────────────────────────────────────────────────────

async fn send_cancelled(tx: &mpsc::Sender<AgentEvent>) {
    let _ = tx
        .send(AgentEvent::Error {
            message: "cancelled".to_string(),
            stderr_tail: String::new(),
        })
        .await;
}

async fn drive(
    req: AgentRequest,
    delay_ms: u64,
    tx: mpsc::Sender<AgentEvent>,
    cancel: CancellationToken,
) {
    let job = classify(&req);
    let text = format!("synthetic agent: {}", job.label());
    if tx.send(AgentEvent::Text { text }).await.is_err() {
        return;
    }
    if delay_ms > 0 {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(delay_ms)) => {}
            _ = cancel.cancelled() => {
                send_cancelled(&tx).await;
                return;
            }
        }
    }
    if cancel.is_cancelled() {
        send_cancelled(&tx).await;
        return;
    }

    let system = req.system.as_deref().unwrap_or("");
    let final_text = match job {
        Job::Grouping => Some(synth_grouping(system, &req.prompt)),
        Job::Merge => Some(synth_merge(&req.prompt)),
        Job::Regroup => Some(synth_regroup(&req.prompt)),
        Job::Repair => Some(synth_repair(&req.prompt)),
        Job::Chat => Some(synth_chat(&req.prompt)),
        Job::Fix => run_fix(&req, &tx, &cancel).await,
        Job::Skill => run_skill(req.mcp.as_ref(), &tx, &cancel).await,
    };

    match final_text {
        Some(final_text) if !cancel.is_cancelled() => {
            let _ = tx
                .send(AgentEvent::Done {
                    final_text,
                    usage: synth_usage(),
                })
                .await;
        }
        _ => send_cancelled(&tx).await,
    }
}

#[async_trait::async_trait]
impl AgentPort for SynthAgents {
    async fn detect(&self) -> Vec<AgentInfo> {
        AgentId::ALL
            .into_iter()
            .map(|id| AgentInfo {
                id,
                path: None,
                version: Some("synthetic".to_string()),
                installed: true,
            })
            .collect()
    }

    /// A demo catalog shaped like the real CLIs' (current models, earlier
    /// versions, per-model effort levels), so the sandbox shows the picker.
    async fn models(&self, agent: AgentId) -> Vec<ModelInfo> {
        let m = |id: &str, label: &str, efforts: &[&str], default: &str, older: bool| ModelInfo {
            id: id.into(),
            label: label.into(),
            description: None,
            efforts: efforts.iter().map(|e| e.to_string()).collect(),
            default_effort: Some(default.into()),
            older,
        };
        const CLAUDE: &[&str] = &["low", "medium", "high", "xhigh", "max"];
        const CODEX: &[&str] = &["low", "medium", "high", "xhigh", "max", "ultra"];
        match agent {
            AgentId::Claude => vec![
                m("claude-opus-5-5", "Opus 5.5", CLAUDE, "medium", false),
                m("claude-fable-5-1", "Fable 5.1", CLAUDE, "high", false),
                m("claude-sonnet-5-5", "Sonnet 5.5", CLAUDE, "medium", false),
                m("claude-haiku-5-5", "Haiku 5.5", CLAUDE, "medium", false),
                m("claude-opus-5", "Opus 5", CLAUDE, "high", true),
                m(
                    "claude-opus-4-6",
                    "Opus 4.6",
                    &["low", "medium", "high", "max"],
                    "high",
                    true,
                ),
            ],
            AgentId::Codex => vec![
                m("gpt-6-astra", "GPT-6-Astra", CODEX, "low", false),
                m("gpt-6-sol", "GPT-6-Sol", CODEX, "medium", false),
                m("gpt-6-luna", "GPT-6-Luna", &CODEX[..5], "medium", false),
            ],
            AgentId::Gemini => vec![],
        }
    }

    async fn run(&self, req: AgentRequest) -> Result<AgentRun, AgentError> {
        let (tx, rx) = mpsc::channel(32);
        let cancel = CancellationToken::new();
        tokio::spawn(drive(req, self.delay_ms, tx, cancel.clone()));
        Ok(AgentRun { events: rx, cancel })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::sync::Arc;

    use async_trait::async_trait;
    use theodore_domain::{
        DiffLine, FileDiff, FileStatus, FindingId, Group, GroupId, GroupKind, Grouping, Hunk,
        HunkId, LineKind, PrId, Revision, RunId, Sha, grouping,
    };
    use theodore_grouping::prompt::{PromptBudget, build_prompts, merge_prompt, repair_prompt};
    use theodore_grouping::{GroupingOptions, PrMeta, group_revision, prepass, regroup};
    use theodore_mcp::{
        BackendError, FileSummary, GroupSummary, GroupWithHunks, McpServer, NewFinding, NewPatch,
        PrContext, ReviewToolsBackend, RunContext,
    };

    use super::*;

    fn line(kind: LineKind, text: &str) -> DiffLine {
        DiffLine {
            kind,
            text: text.into(),
            old_no: None,
            new_no: None,
        }
    }

    fn hunk(id: &str, path: &str, new_start: u32, lines: Vec<DiffLine>) -> Hunk {
        let old = lines.iter().filter(|l| l.kind != LineKind::Add).count() as u32;
        let new = lines.iter().filter(|l| l.kind != LineKind::Del).count() as u32;
        Hunk {
            id: HunkId::new(id),
            path: path.into(),
            old_start: new_start,
            old_lines: old,
            new_start,
            new_lines: new,
            header: "fn thing()".into(),
            lines,
        }
    }

    fn code_hunk(id: &str, path: &str, new_start: u32) -> Hunk {
        hunk(
            id,
            path,
            new_start,
            vec![
                line(LineKind::Ctx, "fn thing() {"),
                line(LineKind::Del, &format!("    old_{id}();")),
                line(LineKind::Add, &format!("    new_{id}();")),
            ],
        )
    }

    fn file(path: &str, hunks: Vec<Hunk>) -> FileDiff {
        FileDiff {
            path: path.into(),
            old_path: None,
            status: FileStatus::Modified,
            similarity: None,
            old_mode: None,
            new_mode: None,
            flags: vec![],
            additions: 1,
            deletions: 1,
            hunks,
        }
    }

    /// Three directories, a root file, Markdown in the root and in `docs/`,
    /// and one import-only hunk the pre-pass flags as a skim candidate.
    fn sample_rev() -> Revision {
        Revision {
            base: Sha::new("base"),
            head: Sha::new("head"),
            files: vec![
                file(
                    "src/lib.rs",
                    vec![
                        code_hunk("h-src-1", "src/lib.rs", 1),
                        code_hunk("h-src-2", "src/lib.rs", 40),
                    ],
                ),
                file(
                    "src/imports.rs",
                    vec![hunk(
                        "h-src-imp",
                        "src/imports.rs",
                        1,
                        vec![
                            line(LineKind::Del, "use std::io;"),
                            line(LineKind::Add, "use std::fmt;"),
                        ],
                    )],
                ),
                file("web/app.ts", vec![code_hunk("h-web-1", "web/app.ts", 3)]),
                file(
                    "crates/core/mod.rs",
                    vec![code_hunk("h-crates-1", "crates/core/mod.rs", 9)],
                ),
                file("Cargo.toml", vec![code_hunk("h-root-1", "Cargo.toml", 2)]),
                file("README.md", vec![code_hunk("h-docs-1", "README.md", 5)]),
                file(
                    "docs/guide.md",
                    vec![code_hunk("h-docs-2", "docs/guide.md", 7)],
                ),
            ],
        }
    }

    fn pr() -> PrMeta {
        PrMeta {
            title: "Rework the widget pipeline".into(),
            body: "Moves things around.".into(),
            commits: vec!["rework widgets".into()],
        }
    }

    fn parse_groups(text: &str) -> Vec<Group> {
        let v: Value = serde_json::from_str(text).expect("answer is bare JSON");
        serde_json::from_value(v["groups"].clone()).expect("groups match the domain shape")
    }

    fn ids(groups: &[Group]) -> Vec<&str> {
        groups.iter().map(|g| g.id.as_str()).collect()
    }

    fn request(
        prompt: &str,
        mode: AgentMode,
        cwd: &Path,
        mcp: Option<McpEndpoint>,
    ) -> AgentRequest {
        AgentRequest {
            agent: AgentId::Claude,
            prompt: prompt.to_string(),
            system: None,
            cwd: cwd.to_path_buf(),
            mode,
            mcp,
            model: None,
            effort: None,
            stall_after_ms: 90_000,
            env: Vec::new(),
            user_mcp: false,
            attachments: vec![],
        }
    }

    async fn drain(mut run: AgentRun) -> Vec<AgentEvent> {
        let mut events = Vec::new();
        while let Some(ev) = run.events.recv().await {
            events.push(ev);
        }
        events
    }

    fn final_text(events: &[AgentEvent]) -> &str {
        let dones: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::Done { final_text, .. } => Some(final_text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(dones.len(), 1, "exactly one Done: {events:?}");
        assert!(
            matches!(events.last(), Some(AgentEvent::Done { .. })),
            "Done is last: {events:?}"
        );
        dones[0]
    }

    const SKILL_PROMPT: &str = "Review this pull request with the `x` skill. Start with the \
        review-tools `get_pr_context` tool. Report every issue you find with `add_finding`.";

    // ── pure parsing ────────────────────────────────────────────────────────

    #[test]
    fn parses_files_and_hunks_from_a_real_prompt() {
        let rev = sample_rev();
        let chunks = build_prompts(&pr(), &rev, &prepass::run(&rev), &PromptBudget::default());
        assert_eq!(chunks.len(), 1);
        let files = parse_files_and_hunks(&chunks[0].prompt.user);
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "src/lib.rs",
                "src/imports.rs",
                "web/app.ts",
                "crates/core/mod.rs",
                "Cargo.toml",
                "README.md",
                "docs/guide.md"
            ]
        );
        assert!(files.iter().all(|f| f.status == "Modified"));
        let skim: Vec<&str> = files
            .iter()
            .flat_map(|f| &f.hunks)
            .filter(|h| h.skim)
            .map(|h| h.id.as_str())
            .collect();
        assert_eq!(skim, ["h-src-imp"]);
    }

    #[test]
    fn initial_grouping_is_a_valid_partition() {
        let rev = sample_rev();
        let chunks = build_prompts(&pr(), &rev, &prepass::run(&rev), &PromptBudget::default());
        let prompt = &chunks[0].prompt;
        let groups = parse_groups(&synth_grouping(&prompt.system, &prompt.user));
        assert_eq!(
            ids(&groups),
            [
                "dir-src",
                "dir-web",
                "dir-crates",
                "root",
                "docs",
                "dir-src-skim"
            ]
        );
        let skim = groups
            .iter()
            .find(|g| g.id.as_str() == "dir-src-skim")
            .unwrap();
        assert_eq!(skim.kind, GroupKind::Skim);
        assert_eq!(skim.title, "Mechanical edits in src/");
        let docs = groups.iter().find(|g| g.id.as_str() == "docs").unwrap();
        assert_eq!(
            docs.hunks,
            [HunkId::new("h-docs-1"), HunkId::new("h-docs-2")]
        );
        assert!(
            groups
                .iter()
                .all(|g| g.risk.is_none() && g.check.len() == 1)
        );
        let grouping = Grouping {
            rev: rev.head.clone(),
            groups,
        };
        assert_eq!(grouping::validate(&rev, &grouping), Ok(()));
    }

    #[test]
    fn chunked_grouping_ids_stay_unique_across_chunks() {
        let rev = sample_rev();
        let tiny = PromptBudget {
            max_chars: 10,
            ..PromptBudget::default()
        };
        let chunks = build_prompts(&pr(), &rev, &prepass::run(&rev), &tiny);
        assert!(chunks.len() > 1);
        let groups: Vec<Group> = chunks
            .iter()
            .flat_map(|c| parse_groups(&synth_grouping(&c.prompt.system, &c.prompt.user)))
            .collect();
        let grouping = Grouping {
            rev: rev.head.clone(),
            groups,
        };
        assert_eq!(grouping::validate(&rev, &grouping), Ok(()));
    }

    #[test]
    fn merge_answer_lists_every_group_in_order() {
        let rev = sample_rev();
        let chunks = build_prompts(&pr(), &rev, &prepass::run(&rev), &PromptBudget::default());
        let groups = parse_groups(&synth_grouping(
            &chunks[0].prompt.system,
            &chunks[0].prompt.user,
        ));
        let prompt = merge_prompt(&pr(), &groups);
        let v: Value = serde_json::from_str(&synth_merge(&prompt.user)).unwrap();
        let order: Vec<&str> = v["order"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap())
            .collect();
        assert_eq!(order, ids(&groups));
    }

    #[test]
    fn repair_answer_puts_every_known_id_in_one_group() {
        let known = [HunkId::new("a1"), HunkId::new("b2"), HunkId::new("c3")];
        let prompt = repair_prompt(
            &known,
            "{\"groups\": []}",
            &["hunk a1 is in no group".into()],
        );
        let groups = parse_groups(&synth_repair(&prompt.user));
        assert_eq!(ids(&groups), ["all-changes"]);
        assert_eq!(groups[0].hunks, known);
    }

    #[test]
    fn regroup_without_existing_groups_declares_pushed() {
        let prompt = "# PR\nTitle: t\n\n# Existing groups\n\n# New / changed hunks to place\n\n\
                      ## hunk n1 — src/a.rs (fn a(x: u32))\n+x\n\n## hunk n2 — b.md ()\n+y\n";
        let v: Value = serde_json::from_str(&synth_regroup(prompt)).unwrap();
        assert_eq!(v["new_groups"][0]["id"], "pushed");
        assert_eq!(
            v["assignments"],
            json!([{"hunk": "n1", "group": "pushed"}, {"hunk": "n2", "group": "pushed"}])
        );
    }

    #[test]
    fn regroup_prefers_the_matching_directory_group() {
        let prompt = "# PR\nTitle: t\n\n# Existing groups\n- other — \"Other\" (Normal, 1 hunks)\n\
                      - dir-src — \"Changes in src/\" (Normal, 2 hunks)\n\
                      - docs — \"Docs\" (Normal, 1 hunks)\n\n# New / changed hunks to place\n\n\
                      ## hunk n1 — src/a.rs (fn a)\n+x\n\n## hunk n2 — web/b.ts ()\n+y\n\n\
                      ## hunk n3 — README.md ()\n+z\n";
        let v: Value = serde_json::from_str(&synth_regroup(prompt)).unwrap();
        assert_eq!(v["new_groups"], json!([]));
        assert_eq!(
            v["assignments"],
            json!([
                {"hunk": "n1", "group": "dir-src"},
                {"hunk": "n2", "group": "other"},
                {"hunk": "n3", "group": "docs"},
            ])
        );
    }

    #[test]
    fn first_added_line_uses_new_side_numbers() {
        let hunks = vec![
            hunk(
                "x",
                "src/a.rs",
                10,
                vec![
                    line(LineKind::Ctx, "a"),
                    line(LineKind::Del, "b"),
                    line(LineKind::Ctx, "c"),
                    line(LineKind::Add, "d"),
                ],
            ),
            hunk("y", "src/b.rs", 1, vec![line(LineKind::Add, "e")]),
        ];
        let diff = theodore_mcp::tools::render_unified_diff(&hunks);
        assert_eq!(first_added_line(&diff), Some(("src/a.rs".into(), 12)));
        let only_dels = theodore_mcp::tools::render_unified_diff(&[hunk(
            "z",
            "src/c.rs",
            3,
            vec![line(LineKind::Del, "gone")],
        )]);
        assert_eq!(first_added_line(&only_dels), None);
    }

    #[test]
    fn path_candidates_strip_line_suffixes_and_reject_escapes() {
        let got = path_candidates(
            "Fix `src/lib.rs:42` and (web/app.ts), not /etc/passwd or ../x.rs or https://a.b/c.",
        );
        assert_eq!(got, ["src/lib.rs", "web/app.ts"]);
    }

    #[test]
    fn chat_answer_echoes_the_last_line() {
        assert_eq!(
            synth_chat("context\n\n  what does this do?  \n\n"),
            "Synthetic answer: what does this do?"
        );
        let long = "x".repeat(200);
        assert_eq!(synth_chat(&long).len(), "Synthetic answer: ".len() + 80);
    }

    // ── the port ────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn detect_reports_every_agent_as_synthetic() {
        let infos = SynthAgents::new().detect().await;
        assert_eq!(infos.len(), AgentId::ALL.len());
        assert!(
            infos
                .iter()
                .all(|i| i.installed && i.version.as_deref() == Some("synthetic"))
        );
    }

    #[test]
    fn first_text_file_skips_a_worktree_git_file() {
        let cwd = tempfile::tempdir().unwrap();
        std::fs::write(cwd.path().join(".git"), "gitdir: /elsewhere\n").unwrap();
        std::fs::write(cwd.path().join("main.rs"), "fn main() {}\n").unwrap();
        let found = super::first_text_file(cwd.path()).unwrap();
        assert_eq!(found.file_name().unwrap(), "main.rs");
    }

    #[tokio::test]
    async fn group_revision_is_valid_first_try() {
        let rev = sample_rev();
        let cwd = tempfile::tempdir().unwrap();
        let report = group_revision(
            &SynthAgents::new(),
            &pr(),
            &rev,
            cwd.path(),
            &GroupingOptions::default(),
        )
        .await
        .unwrap();
        assert!(report.valid_first_try, "{report:?}");
        assert_eq!(report.attempts, 1);
        assert_eq!(report.usage.input_tokens, 500);
    }

    #[tokio::test]
    async fn chunked_group_revision_with_merge_pass_is_valid_first_try() {
        let rev = sample_rev();
        let cwd = tempfile::tempdir().unwrap();
        let opts = GroupingOptions {
            budget: PromptBudget {
                max_chars: 10,
                ..PromptBudget::default()
            },
            ..GroupingOptions::default()
        };
        let report = group_revision(&SynthAgents::new(), &pr(), &rev, cwd.path(), &opts)
            .await
            .unwrap();
        assert!(report.valid_first_try, "{report:?}");
        assert!(
            report.attempts > 2,
            "chunks + merge pass: {}",
            report.attempts
        );
    }

    #[tokio::test]
    async fn regroup_after_push_is_valid_first_try() {
        let agents = SynthAgents::new();
        let cwd = tempfile::tempdir().unwrap();
        let opts = GroupingOptions::default();
        let old = sample_rev();
        let previous = group_revision(&agents, &pr(), &old, cwd.path(), &opts)
            .await
            .unwrap()
            .grouping;

        let mut new = old.clone();
        new.head = Sha::new("head2");
        new.files[0]
            .hunks
            .push(code_hunk("h-src-new", "src/lib.rs", 500));
        new.files.push(file(
            "tests/it.rs",
            vec![code_hunk("h-tests-new", "tests/it.rs", 1)],
        ));
        let changes = theodore_domain::interdiff::classify(&old, &new);

        let report = regroup(&agents, &pr(), &previous, &new, &changes, cwd.path(), &opts)
            .await
            .unwrap();
        assert!(report.valid_first_try, "{report:?}");
        let owner = |hunk: &str| {
            report
                .grouping
                .groups
                .iter()
                .find(|g| g.hunks.contains(&HunkId::new(hunk)))
                .map(|g| g.id.clone())
        };
        let previous_ids: BTreeSet<&GroupId> = previous.groups.iter().map(|g| &g.id).collect();
        let src_owner = owner("h-src-new").unwrap();
        assert!(previous_ids.contains(&src_owner));
        if previous_ids.contains(&GroupId::new("dir-src")) {
            assert_eq!(src_owner, GroupId::new("dir-src"));
        }
        assert_eq!(owner("h-tests-new"), Some(previous.groups[0].id.clone()));
    }

    #[tokio::test]
    async fn fix_appends_a_comment_to_the_mentioned_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("a.txt"), "first\n").unwrap();
        std::fs::write(dir.path().join("src/lib.rs"), "fn main() {}").unwrap();
        let prompt = "Fix this review task in the pull request.\n\nTitle: Handle the empty case\n\n\
                      The loop in `src/lib.rs:1` panics on empty input.\n\n\
                      Make the necessary code changes directly in this worktree. Do not commit or push.";
        let run = SynthAgents::new()
            .run(request(prompt, AgentMode::Edit, dir.path(), None))
            .await
            .unwrap();
        let events = drain(run).await;
        let text = final_text(&events);
        assert!(text.contains("src/lib.rs"), "{text}");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("src/lib.rs")).unwrap(),
            "fn main() {}\n// sandbox fix: Handle the empty case\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "first\n"
        );
    }

    #[tokio::test]
    async fn fix_without_a_path_edits_the_first_text_file_outside_dot_git() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join(".git/config"), "[core]\n").unwrap();
        std::fs::write(dir.path().join("a.bin"), [0u8, 1, 2]).unwrap();
        std::fs::write(dir.path().join("b.py"), "print(1)\n").unwrap();
        let prompt = "Fix this review task in the pull request.\n\nTitle: Tidy up\n\nMake it nicer";
        let run = SynthAgents::new()
            .run(request(prompt, AgentMode::Edit, dir.path(), None))
            .await
            .unwrap();
        final_text(&drain(run).await);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("b.py")).unwrap(),
            "print(1)\n# sandbox fix: Tidy up\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".git/config")).unwrap(),
            "[core]\n"
        );
    }

    #[tokio::test]
    async fn chat_run_streams_text_then_done() {
        let dir = tempfile::tempdir().unwrap();
        let run = SynthAgents::new()
            .run(request(
                "Why is this here?",
                AgentMode::ReadOnly,
                dir.path(),
                None,
            ))
            .await
            .unwrap();
        let events = drain(run).await;
        assert!(matches!(events[0], AgentEvent::Text { .. }));
        assert_eq!(final_text(&events), "Synthetic answer: Why is this here?");
        assert_eq!(events.len(), 2);
    }

    #[tokio::test]
    async fn cancel_during_delay_ends_in_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        let mut run = SynthAgents::new()
            .with_delay_ms(60_000)
            .run(request("hello", AgentMode::ReadOnly, dir.path(), None))
            .await
            .unwrap();
        assert!(matches!(
            run.events.recv().await,
            Some(AgentEvent::Text { .. })
        ));
        run.cancel.cancel();
        let rest = drain(run).await;
        assert!(
            matches!(rest.as_slice(), [AgentEvent::Error { message, .. }] if message == "cancelled"),
            "{rest:?}"
        );
    }

    #[tokio::test]
    async fn skill_run_without_mcp_still_finishes() {
        let dir = tempfile::tempdir().unwrap();
        let run = SynthAgents::new()
            .run(request(SKILL_PROMPT, AgentMode::ReadOnly, dir.path(), None))
            .await
            .unwrap();
        let events = drain(run).await;
        assert!(final_text(&events).contains("no review-tools MCP endpoint"));
    }

    #[derive(Default)]
    struct FakeBackend {
        findings: tokio::sync::Mutex<Vec<NewFinding>>,
    }

    #[async_trait]
    impl ReviewToolsBackend for FakeBackend {
        async fn get_pr_context(&self, _run: &RunContext) -> Result<PrContext, BackendError> {
            Ok(PrContext {
                title: "t".into(),
                body: String::new(),
                commits: vec![],
                files: vec![FileSummary {
                    path: "src/lib.rs".into(),
                    status: FileStatus::Modified,
                    additions: 1,
                    deletions: 0,
                }],
                groups: vec![GroupSummary {
                    id: "g1".into(),
                    title: "G".into(),
                    why: "w".into(),
                    hunk_count: 1,
                }],
            })
        }

        async fn get_group(
            &self,
            _run: &RunContext,
            _group_id: &str,
        ) -> Result<GroupWithHunks, BackendError> {
            let h = hunk(
                "h1",
                "src/lib.rs",
                7,
                vec![
                    line(LineKind::Ctx, "fn run() {"),
                    line(LineKind::Add, "retry();"),
                ],
            );
            Ok(GroupWithHunks {
                group: Group {
                    id: GroupId::new("g1"),
                    title: "G".into(),
                    why: "w".into(),
                    kind: GroupKind::Normal,
                    risk: None,
                    check: vec![],
                    hunks: vec![h.id.clone()],
                    outliers: vec![],
                },
                hunks: vec![h],
            })
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
            finding: NewFinding,
        ) -> Result<FindingId, BackendError> {
            self.findings.lock().await.push(finding);
            Ok(FindingId::new("finding-1"))
        }

        async fn propose_patch(
            &self,
            _run: &RunContext,
            _patch: NewPatch,
        ) -> Result<(), BackendError> {
            Ok(())
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn skill_run_reports_one_finding_over_mcp() {
        let backend = Arc::new(FakeBackend::default());
        let handle = McpServer::start(backend.clone()).await.unwrap();
        let endpoint = handle.register_run(RunContext::review(
            RunId::new("run-1"),
            PrId::new("github:acme/widgets#42"),
            AgentId::Claude,
        ));
        let dir = tempfile::tempdir().unwrap();
        let run = SynthAgents::new()
            .run(request(
                SKILL_PROMPT,
                AgentMode::ReadOnly,
                dir.path(),
                Some(endpoint),
            ))
            .await
            .unwrap();
        let events = drain(run).await;
        assert_eq!(final_text(&events), "reported 1 finding");
        let calls: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::ToolCall { name, .. } => Some(name.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(calls, ["get_pr_context", "get_group", "add_finding"]);
        assert!(
            events
                .iter()
                .filter(|e| matches!(e, AgentEvent::ToolResult { .. }))
                .all(|e| matches!(e, AgentEvent::ToolResult { ok: true, .. })),
            "{events:?}"
        );
        {
            let findings = backend.findings.lock().await;
            assert_eq!(findings.len(), 1);
            assert_eq!(findings[0].file, "src/lib.rs");
            assert_eq!(findings[0].line, 8);
            assert_eq!(findings[0].title, "Synthetic finding");
            assert_eq!(
                findings[0].body,
                "Deterministic sandbox finding on src/lib.rs:8."
            );
        }
        handle.shutdown().await;
    }
}
