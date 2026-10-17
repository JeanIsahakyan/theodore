//! Wire types for the `review-tools` MCP tools: request params (schemars, for
//! the tool's `inputSchema`) and response bodies (plain serde, sent back as
//! JSON tool content).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use theodore_domain::{Commit, FileStatus, Hunk, LineKind, Severity};

use crate::backend::{FileSummary, GroupSummary, GroupWithHunks, NewFinding, NewPatch, PrContext};

// ── get_group ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetGroupParams {
    /// Group id, as returned by `get_pr_context`.
    pub id: String,
}

// ── get_base_file ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetBaseFileParams {
    /// Repo-relative path, as listed by `get_pr_context`.
    pub path: String,
}

// ── add_finding ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SeverityParam {
    Info,
    Warn,
    High,
}

impl From<SeverityParam> for Severity {
    fn from(s: SeverityParam) -> Self {
        match s {
            SeverityParam::Info => Severity::Info,
            SeverityParam::Warn => Severity::Warn,
            SeverityParam::High => Severity::High,
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AddFindingParams {
    /// Repo-relative path of the finding.
    pub file: String,
    /// 1-based line number on the new side of the diff.
    pub line: u32,
    pub severity: SeverityParam,
    pub title: String,
    pub body: String,
}

impl From<AddFindingParams> for NewFinding {
    fn from(p: AddFindingParams) -> Self {
        NewFinding {
            file: p.file,
            line: p.line,
            severity: p.severity.into(),
            title: p.title,
            body: p.body,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct AddFindingResult {
    pub finding_id: String,
}

// ── propose_patch ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ProposePatchParams {
    /// Id of the finding this patch fixes, as returned by `add_finding`.
    pub finding_id: String,
    pub file: String,
    /// Lines being replaced.
    pub before: Vec<String>,
    /// Replacement lines.
    pub after: Vec<String>,
    pub note: String,
}

impl ProposePatchParams {
    pub fn into_new_patch(self) -> NewPatch {
        NewPatch {
            finding_id: theodore_domain::FindingId::new(self.finding_id),
            file: self.file,
            before: self.before,
            after: self.after,
            note: self.note,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ProposePatchResult {
    pub ok: bool,
}

// ── get_pr_context response ─────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct CommitResponse {
    pub sha: String,
    pub title: String,
    pub author: String,
}

impl From<&Commit> for CommitResponse {
    fn from(c: &Commit) -> Self {
        CommitResponse {
            sha: c.sha.to_string(),
            title: c.title.clone(),
            author: c.author.login.clone(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct FileSummaryResponse {
    pub path: String,
    pub status: &'static str,
    pub additions: u32,
    pub deletions: u32,
}

fn status_str(s: FileStatus) -> &'static str {
    match s {
        FileStatus::Added => "added",
        FileStatus::Modified => "modified",
        FileStatus::Deleted => "deleted",
        FileStatus::Renamed => "renamed",
        FileStatus::Copied => "copied",
    }
}

impl From<&FileSummary> for FileSummaryResponse {
    fn from(f: &FileSummary) -> Self {
        FileSummaryResponse {
            path: f.path.clone(),
            status: status_str(f.status),
            additions: f.additions,
            deletions: f.deletions,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct GroupSummaryResponse {
    pub id: String,
    pub title: String,
    pub why: String,
    pub hunk_count: usize,
}

impl From<&GroupSummary> for GroupSummaryResponse {
    fn from(g: &GroupSummary) -> Self {
        GroupSummaryResponse {
            id: g.id.clone(),
            title: g.title.clone(),
            why: g.why.clone(),
            hunk_count: g.hunk_count,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct PrContextResult {
    pub title: String,
    pub body: String,
    pub commits: Vec<CommitResponse>,
    pub files: Vec<FileSummaryResponse>,
    pub groups: Vec<GroupSummaryResponse>,
}

impl From<&PrContext> for PrContextResult {
    fn from(ctx: &PrContext) -> Self {
        PrContextResult {
            title: ctx.title.clone(),
            body: ctx.body.clone(),
            commits: ctx.commits.iter().map(CommitResponse::from).collect(),
            files: ctx.files.iter().map(FileSummaryResponse::from).collect(),
            groups: ctx.groups.iter().map(GroupSummaryResponse::from).collect(),
        }
    }
}

// ── get_group response ──────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct GroupResult {
    pub id: String,
    pub title: String,
    pub why: String,
    pub kind: &'static str,
    pub risk: Option<String>,
    pub check: Vec<String>,
    /// The group's hunks, rendered as unified diff text.
    pub diff: String,
}

impl From<&GroupWithHunks> for GroupResult {
    fn from(g: &GroupWithHunks) -> Self {
        let kind = match g.group.kind {
            theodore_domain::GroupKind::Normal => "normal",
            theodore_domain::GroupKind::Skim => "skim",
            theodore_domain::GroupKind::Hidden => "hidden",
        };
        GroupResult {
            id: g.group.id.to_string(),
            title: g.group.title.clone(),
            why: g.group.why.clone(),
            kind,
            risk: g.group.risk.clone(),
            check: g.group.check.clone(),
            diff: render_unified_diff(&g.hunks),
        }
    }
}

/// Renders hunks as unified diff text, grouped under one `---`/`+++` header per
/// file. Presentation only: the hunks themselves already carry the diff.
pub fn render_unified_diff(hunks: &[Hunk]) -> String {
    let mut out = String::new();
    let mut current_path: Option<&str> = None;
    for h in hunks {
        if current_path != Some(h.path.as_str()) {
            out.push_str(&format!("--- a/{p}\n+++ b/{p}\n", p = h.path));
            current_path = Some(h.path.as_str());
        }
        out.push_str(&format!(
            "@@ -{os},{ol} +{ns},{nl} @@ {hdr}\n",
            os = h.old_start,
            ol = h.old_lines,
            ns = h.new_start,
            nl = h.new_lines,
            hdr = h.header,
        ));
        for line in &h.lines {
            let prefix = match line.kind {
                LineKind::Ctx => ' ',
                LineKind::Add => '+',
                LineKind::Del => '-',
            };
            out.push(prefix);
            out.push_str(&line.text);
            out.push('\n');
        }
    }
    out
}

// ── get_base_file response ──────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct BaseFileResult {
    pub path: String,
    pub exists: bool,
    pub content: String,
}
