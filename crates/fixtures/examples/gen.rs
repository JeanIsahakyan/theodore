//! Regenerates `crates/fixtures/data/demo/`.
//!
//! Hunk ids depend on `theodore_domain::interdiff::hunk_id`, so the fixture
//! JSON is generated here rather than hand-written: run
//! `cargo run -p theodore-fixtures --example gen` after changing any of the
//! content below, then commit the regenerated files.

use std::path::{Path, PathBuf};

use theodore_domain::{
    AgentId, Check, CheckRollup, CheckStatus, Commit, DiffLine, FileDiff, FileStatus, Group,
    GroupId, GroupKind, Grouping, Hunk, InboxReason, LineKind, Person, PrDetail, PrRef, PrState,
    PrSummary, RepoRef, Reviewer, ReviewerState, Revision, Sha, Usage,
};
use theodore_fixtures::agent::RecordedEvent;
use theodore_ports::AgentEvent;

const DATA_DIR: &str = env!("CARGO_MANIFEST_DIR");

fn demo_dir() -> PathBuf {
    Path::new(DATA_DIR).join("data/demo")
}

/// Builds one hunk from unified-diff-style text: each line starts with
/// `' '`, `'+'` or `'-'`. Mirrors the reviewed tool's own hunk builder.
fn build_hunk(path: &str, old_start: u32, new_start: u32, header: &str, text: &str) -> Hunk {
    let mut o = old_start;
    let mut n = new_start;
    let mut lines = Vec::new();
    for raw in text.trim_matches('\n').split('\n') {
        let mut chars = raw.chars();
        let sign = chars.next();
        let rest = chars.as_str().to_string();
        let (kind, old_no, new_no) = match sign {
            Some('+') => {
                let r = (LineKind::Add, None, Some(n));
                n += 1;
                r
            }
            Some('-') => {
                let r = (LineKind::Del, Some(o), None);
                o += 1;
                r
            }
            _ => {
                let r = (LineKind::Ctx, Some(o), Some(n));
                o += 1;
                n += 1;
                r
            }
        };
        lines.push(DiffLine {
            kind,
            text: rest,
            old_no,
            new_no,
        });
    }
    let old_lines = lines.iter().filter(|l| l.kind != LineKind::Add).count() as u32;
    let new_lines = lines.iter().filter(|l| l.kind != LineKind::Del).count() as u32;
    let id = theodore_domain::interdiff::hunk_id(path, &lines);
    Hunk {
        id,
        path: path.to_string(),
        old_start,
        old_lines,
        new_start,
        new_lines,
        header: header.to_string(),
        lines,
    }
}

fn file_diff(path: &str, status: FileStatus, hunks: Vec<Hunk>) -> FileDiff {
    let additions = hunks
        .iter()
        .flat_map(|h| &h.lines)
        .filter(|l| l.kind == LineKind::Add)
        .count() as u32;
    let deletions = hunks
        .iter()
        .flat_map(|h| &h.lines)
        .filter(|l| l.kind == LineKind::Del)
        .count() as u32;
    FileDiff {
        path: path.to_string(),
        old_path: None,
        status,
        similarity: None,
        old_mode: None,
        new_mode: None,
        flags: vec![],
        additions,
        deletions,
        hunks,
    }
}

fn person(login: &str, name: &str) -> Person {
    Person {
        login: login.to_string(),
        name: Some(name.to_string()),
        avatar_url: None,
    }
}

fn pr_ref(owner: &str, name: &str, number: u64, host_id: &str) -> PrRef {
    PrRef {
        repo: RepoRef {
            host: theodore_domain::HostKind::Github,
            owner: owner.to_string(),
            name: name.to_string(),
        },
        number,
        host_id: Some(host_id.to_string()),
    }
}

fn main() {
    let dir = demo_dir();

    // ── PR #101: webhook retry with backoff ─────────────────────────────
    let pr1 = pr_ref("octo", "webhooks", 101, "gh_101");
    let base1 = Sha::new("base-main");
    let head1 = Sha::new("head-479-1");
    let head2 = Sha::new("head-479-2");
    let author1 = person("dana", "Dana Reyes");

    // No `\` after the opening quote: a leading context line needs its
    // leading space preserved, which a line-continuation would eat.
    let deliver_text_v1 = "
 export async function deliver(hook: Webhook, event: Event) {
-  const res = await fetch(hook.url, { method: 'POST', body: JSON.stringify(event) });
-  if (!res.ok) throw new Error(`webhook ${hook.id}: ${res.status}`);
+  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
+    const res = await fetch(hook.url, { method: 'POST', body: JSON.stringify(event) });
+    if (res.ok) return;
+    if (res.status < 500 && res.status !== 429) break;
+    await sleep(backoff(attempt));
+  }
+  await deadLetter.push(hook, event);
 }";
    let backoff_text_v1 = "\
+export const MAX_ATTEMPTS = 5;
+
+export function backoff(attempt: number) {
+  const base = 500 * 2 ** attempt;
+  return base + Math.random() * base * 0.2;
+}";
    let test_text = "\
+import { it, expect } from 'vitest';
+import { deliver } from '../../src/webhooks/deliver';
+
+it('retries 5xx and dead-letters after MAX_ATTEMPTS', async () => {
+  const fetch = mockFetch([503, 503, 503, 503, 503]);
+  await deliver(hook, event);
+  expect(fetch).toHaveBeenCalledTimes(5);
+});";
    let backoff_text_v2 = "\
+export const MAX_ATTEMPTS = 5;
+export const MAX_BACKOFF_MS = 30_000;
+
+export function backoff(attempt: number) {
+  const base = 500 * 2 ** attempt;
+  const capped = Math.min(base, MAX_BACKOFF_MS);
+  return capped + Math.random() * capped * 0.2;
+}";

    let deliver_hunk = build_hunk(
        "src/webhooks/deliver.ts",
        1,
        1,
        "function deliver",
        deliver_text_v1,
    );
    let backoff_hunk_v1 = build_hunk("src/webhooks/backoff.ts", 0, 1, "", backoff_text_v1);
    let test_hunk = build_hunk("test/webhooks/deliver.test.ts", 0, 1, "", test_text);
    let backoff_hunk_v2 = build_hunk("src/webhooks/backoff.ts", 0, 1, "", backoff_text_v2);

    let rev1 = Revision {
        base: base1.clone(),
        head: head1.clone(),
        files: vec![
            file_diff(
                "src/webhooks/deliver.ts",
                FileStatus::Modified,
                vec![deliver_hunk.clone()],
            ),
            file_diff(
                "src/webhooks/backoff.ts",
                FileStatus::Added,
                vec![backoff_hunk_v1.clone()],
            ),
            file_diff(
                "test/webhooks/deliver.test.ts",
                FileStatus::Added,
                vec![test_hunk.clone()],
            ),
        ],
    };
    let rev2 = Revision {
        base: base1.clone(),
        head: head2.clone(),
        files: vec![
            file_diff(
                "src/webhooks/deliver.ts",
                FileStatus::Modified,
                vec![deliver_hunk.clone()],
            ),
            file_diff(
                "src/webhooks/backoff.ts",
                FileStatus::Added,
                vec![backoff_hunk_v2.clone()],
            ),
            file_diff(
                "test/webhooks/deliver.test.ts",
                FileStatus::Added,
                vec![test_hunk.clone()],
            ),
        ],
    };

    let grouping = Grouping {
        rev: head1.clone(),
        groups: vec![
            Group {
                id: GroupId::new("g1"),
                title: "Retry with backoff".to_string(),
                why: "deliver() retries 5xx and 429 up to 5 times with exponential backoff, \
                      then moves the event to dead-letter."
                    .to_string(),
                kind: GroupKind::Normal,
                risk: None,
                check: vec!["4xx other than 429 is not retried".to_string()],
                hunks: vec![deliver_hunk.id.clone(), backoff_hunk_v1.id.clone()],
                outliers: vec![],
            },
            Group {
                id: GroupId::new("g2"),
                title: "Tests".to_string(),
                why: "Covers the dead-letter path after five consecutive 503s.".to_string(),
                kind: GroupKind::Normal,
                risk: None,
                check: vec![],
                hunks: vec![test_hunk.id.clone()],
                outliers: vec![],
            },
        ],
    };
    theodore_domain::grouping::validate(&rev1, &grouping)
        .expect("demo grouping must validate against revision 1");

    let additions1: u32 = rev1.files.iter().map(|f| f.additions).sum();
    let deletions1: u32 = rev1.files.iter().map(|f| f.deletions).sum();

    let pr1_detail = PrDetail {
        summary: PrSummary {
            pr: pr1.clone(),
            title: "Add retry with backoff for webhook delivery".to_string(),
            author: author1.clone(),
            state: PrState::Open,
            base_ref: "main".to_string(),
            head_ref: "dana/webhook-retry".to_string(),
            head_sha: head1.clone(),
            additions: additions1,
            deletions: deletions1,
            changed_files: rev1.files.len() as u32,
            reasons: vec![InboxReason::ReviewRequested],
            checks: CheckRollup::Pending,
            approvals: 0,
            required_approvals: Some(1),
            updated_at: 1_700_000_000_000,
            url: "https://example.com/octo/webhooks/pull/101".to_string(),
            review_decision: Some(theodore_domain::ReviewDecision::ReviewRequired),
            conflicts: false,
            // Opened 3 days before the last update, for a plausible demo age.
            created_at: Some(1_700_000_000_000 - 3 * 86_400_000),
            stack: None,
        },
        body: "Retries webhook delivery with exponential backoff, dead-letters after 5 attempts."
            .to_string(),
        base_sha: base1.clone(),
        commits: vec![Commit {
            sha: head1.clone(),
            title: "webhook retry with backoff".to_string(),
            author: author1.clone(),
            at: 1_700_000_000_000,
            // Demo data for the "new since you last looked" divider.
            after_my_review: true,
        }],
        checks: vec![
            Check {
                id: "build".to_string(),
                name: "build".to_string(),
                status: CheckStatus::Pass,
                url: None,
                duration_ms: Some(70_000),
            },
            Check {
                id: "unit".to_string(),
                name: "unit".to_string(),
                status: CheckStatus::Pending,
                url: None,
                duration_ms: None,
            },
        ],
        reviewers: vec![Reviewer {
            person: person("max", "Max Oyelaran"),
            state: ReviewerState::Requested,
            team: None,
        }],
        assignees: vec![author1.clone()],
        labels: vec!["webhooks".to_string()],
        threads: vec![],
        viewed: vec![],
    };

    // ── PR #7: pagination off-by-one fix ─────────────────────────────────
    let pr2 = pr_ref("octo", "api", 7, "gh_7");
    let base2 = Sha::new("base-main-api");
    let head3 = Sha::new("head-211-1");
    let author2 = person("priya", "Priya Shah");

    let paginate_text = "
 export function paginate(items: Item[], cursor: number, limit: number) {
-  const page = items.slice(cursor, cursor + limit);
-  return { page, next: cursor + limit };
+  const page = items.slice(cursor, cursor + limit);
+  const next = cursor + limit;
+  return { page, next: next < items.length ? next : null };
 }";
    let paginate_hunk = build_hunk(
        "src/api/paginate.ts",
        1,
        1,
        "function paginate",
        paginate_text,
    );
    let rev3 = Revision {
        base: base2.clone(),
        head: head3.clone(),
        files: vec![file_diff(
            "src/api/paginate.ts",
            FileStatus::Modified,
            vec![paginate_hunk.clone()],
        )],
    };
    let additions2: u32 = rev3.files.iter().map(|f| f.additions).sum();
    let deletions2: u32 = rev3.files.iter().map(|f| f.deletions).sum();

    let pr2_detail = PrDetail {
        summary: PrSummary {
            pr: pr2.clone(),
            title: "Fix off-by-one in pagination cursor".to_string(),
            author: author2.clone(),
            state: PrState::Open,
            base_ref: "main".to_string(),
            head_ref: "priya/paginate-fix".to_string(),
            head_sha: head3.clone(),
            additions: additions2,
            deletions: deletions2,
            changed_files: rev3.files.len() as u32,
            reasons: vec![InboxReason::Assigned],
            checks: CheckRollup::Pass,
            approvals: 1,
            required_approvals: Some(1),
            updated_at: 1_700_100_000_000,
            url: "https://example.com/octo/api/pull/7".to_string(),
            review_decision: Some(theodore_domain::ReviewDecision::Approved),
            conflicts: false,
            created_at: Some(1_700_100_000_000 - 2 * 86_400_000),
            stack: None,
        },
        body: "`next` leaked past the last page; return `null` once the cursor runs out."
            .to_string(),
        base_sha: base2.clone(),
        commits: vec![Commit {
            sha: head3.clone(),
            title: "fix pagination cursor".to_string(),
            author: author2.clone(),
            at: 1_700_100_000_000,
            after_my_review: false,
        }],
        checks: vec![Check {
            id: "unit".to_string(),
            name: "unit".to_string(),
            status: CheckStatus::Pass,
            url: None,
            duration_ms: Some(32_000),
        }],
        reviewers: vec![Reviewer {
            person: person("max", "Max Oyelaran"),
            state: ReviewerState::Commented,
            team: None,
        }],
        assignees: vec![author2.clone()],
        labels: vec!["api".to_string()],
        threads: vec![],
        viewed: vec![],
    };

    // ── write host/prs.json ──────────────────────────────────────────────
    let host_dir = dir.join("host");
    std::fs::create_dir_all(&host_dir).unwrap();
    write_json(&host_dir.join("prs.json"), &vec![pr1_detail, pr2_detail]);

    // ── write git/<sanitized-pr-id>/<head>.json + files/<head>/<path> ───
    write_revision(&dir, "octo_webhooks_101", &rev1);
    write_revision(&dir, "octo_webhooks_101", &rev2);
    write_revision(&dir, "octo_api_7", &rev3);

    write_file(
        &dir,
        "octo_webhooks_101",
        &head1,
        "src/webhooks/deliver.ts",
        DELIVER_FILE_V1,
    );
    write_file(
        &dir,
        "octo_webhooks_101",
        &head1,
        "src/webhooks/backoff.ts",
        BACKOFF_FILE_V1,
    );
    write_file(
        &dir,
        "octo_webhooks_101",
        &head1,
        "test/webhooks/deliver.test.ts",
        TEST_FILE,
    );
    write_file(
        &dir,
        "octo_webhooks_101",
        &head2,
        "src/webhooks/deliver.ts",
        DELIVER_FILE_V1,
    );
    write_file(
        &dir,
        "octo_webhooks_101",
        &head2,
        "src/webhooks/backoff.ts",
        BACKOFF_FILE_V2,
    );
    write_file(
        &dir,
        "octo_webhooks_101",
        &head2,
        "test/webhooks/deliver.test.ts",
        TEST_FILE,
    );
    write_file(
        &dir,
        "octo_api_7",
        &head3,
        "src/api/paginate.ts",
        PAGINATE_FILE,
    );

    // ── write agent scripts ──────────────────────────────────────────────
    let usage = |input: u64, output: u64| Usage {
        input_tokens: input,
        output_tokens: output,
        usd: (input + output) as f64 * 0.000_003,
    };

    for (agent, prefix) in [(AgentId::Claude, "claude"), (AgentId::Codex, "codex")] {
        write_script(
            &dir,
            agent,
            "grouping",
            vec![
                RecordedEvent {
                    event: AgentEvent::Text {
                        text: format!("{prefix}: reading the PR diff and hunk list..."),
                    },
                    delay_ms: 60,
                },
                RecordedEvent {
                    event: AgentEvent::Thinking {
                        text: "Group by behaviour: retry+backoff, then its test.".to_string(),
                    },
                    delay_ms: 120,
                },
                RecordedEvent {
                    event: AgentEvent::Done {
                        final_text: serde_json::to_string(&grouping).unwrap(),
                        usage: usage(1200, 300),
                    },
                    delay_ms: 0,
                },
            ],
        );

        write_script(
            &dir,
            agent,
            "skill",
            vec![
                RecordedEvent {
                    event: AgentEvent::ToolCall {
                        id: "call-1".to_string(),
                        // Flat shape matching the real `add_finding` MCP tool
                        // (`crates/mcp/src/tools.rs::AddFindingParams`): the
                        // fixture agent actually calls this tool over MCP
                        // (see `ReplayAgents`), so the input must validate.
                        name: "add_finding".to_string(),
                        input: serde_json::json!({
                            "file": "src/webhooks/deliver.ts",
                            "line": 5,
                            "severity": "warn",
                            "title": "Backoff has no upper bound",
                            "body": "500 * 2^attempt grows without a cap; consider MAX_BACKOFF_MS.",
                        }),
                    },
                    delay_ms: 80,
                },
                // The recorded result is a placeholder: `ReplayAgents`
                // replaces it with the real MCP response when `AgentRequest.mcp`
                // is set, so this line only plays back when there is no MCP
                // endpoint (e.g. a direct `AgentPort::run` call in a test).
                RecordedEvent {
                    event: AgentEvent::ToolResult {
                        id: "call-1".to_string(),
                        ok: true,
                        output: "{\"finding_id\":\"f1\"}".to_string(),
                    },
                    delay_ms: 40,
                },
                RecordedEvent {
                    event: AgentEvent::Done {
                        final_text: format!("{prefix}: reported 1 finding."),
                        usage: usage(800, 120),
                    },
                    delay_ms: 0,
                },
            ],
        );

        // Regroup after a push (plan §5.3): reassigns the one changed hunk
        // (`backoff.ts`, whose content changed from rev1 to rev2) back to
        // its original group. Matched by the incremental regroup prompt
        // (`# Existing groups`), not by a hand-typed substring.
        write_script(
            &dir,
            agent,
            "regroup",
            vec![
                RecordedEvent {
                    event: AgentEvent::Text {
                        text: format!("{prefix}: placing the changed backoff hunk..."),
                    },
                    delay_ms: 40,
                },
                RecordedEvent {
                    event: AgentEvent::Done {
                        final_text: serde_json::json!({
                            "assignments": [
                                {"hunk": backoff_hunk_v2.id.as_str(), "group": "g1"},
                            ],
                            "new_groups": [],
                        })
                        .to_string(),
                        usage: usage(300, 60),
                    },
                    delay_ms: 0,
                },
            ],
        );

        // A deliberately slow script for e2e cancellation tests: matched by
        // `ScriptRule::new("`slow-skill`", "slow")`, ahead of the generic
        // "skill" rule, when `run_skill` is called with `skill: "slow-skill"`.
        write_script(
            &dir,
            agent,
            "slow",
            vec![RecordedEvent {
                event: AgentEvent::Text {
                    text: "...".to_string(),
                },
                delay_ms: 5_000,
            }],
        );

        write_script(
            &dir,
            agent,
            "chat",
            vec![
                RecordedEvent {
                    event: AgentEvent::Text {
                        text: format!(
                            "{prefix}: the retry loop stops on the first 2xx or a \
                             non-retryable 4xx."
                        ),
                    },
                    delay_ms: 50,
                },
                RecordedEvent {
                    event: AgentEvent::Done {
                        final_text: "The retry loop stops on the first 2xx or a \
                                      non-retryable 4xx."
                            .to_string(),
                        usage: usage(300, 80),
                    },
                    delay_ms: 0,
                },
            ],
        );

        write_script(
            &dir,
            agent,
            "exit_error",
            vec![RecordedEvent {
                event: AgentEvent::Error {
                    message: "agent exited with status 1".to_string(),
                    stderr_tail: "panic: fixture failure".to_string(),
                },
                delay_ms: 50,
            }],
        );
    }

    println!("wrote fixture demo data to {}", dir.display());
}

const DELIVER_FILE_V1: &str = "\
export async function deliver(hook: Webhook, event: Event) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetch(hook.url, { method: 'POST', body: JSON.stringify(event) });
    if (res.ok) return;
    if (res.status < 500 && res.status !== 429) break;
    await sleep(backoff(attempt));
  }
  await deadLetter.push(hook, event);
}
";
const BACKOFF_FILE_V1: &str = "\
export const MAX_ATTEMPTS = 5;

export function backoff(attempt: number) {
  const base = 500 * 2 ** attempt;
  return base + Math.random() * base * 0.2;
}
";
const BACKOFF_FILE_V2: &str = "\
export const MAX_ATTEMPTS = 5;
export const MAX_BACKOFF_MS = 30_000;

export function backoff(attempt: number) {
  const base = 500 * 2 ** attempt;
  const capped = Math.min(base, MAX_BACKOFF_MS);
  return capped + Math.random() * capped * 0.2;
}
";
const TEST_FILE: &str = "\
import { it, expect } from 'vitest';
import { deliver } from '../../src/webhooks/deliver';

it('retries 5xx and dead-letters after MAX_ATTEMPTS', async () => {
  const fetch = mockFetch([503, 503, 503, 503, 503]);
  await deliver(hook, event);
  expect(fetch).toHaveBeenCalledTimes(5);
});
";
const PAGINATE_FILE: &str = "\
export function paginate(items: Item[], cursor: number, limit: number) {
  const page = items.slice(cursor, cursor + limit);
  const next = cursor + limit;
  return { page, next: next < items.length ? next : null };
}
";

fn write_json<T: serde::Serialize>(path: &Path, value: &T) {
    let json = serde_json::to_string_pretty(value).unwrap();
    std::fs::write(path, json).unwrap();
}

fn write_revision(dir: &Path, sanitized_pr_id: &str, revision: &Revision) {
    let pr_dir = dir.join("git").join(sanitized_pr_id);
    std::fs::create_dir_all(&pr_dir).unwrap();
    write_json(
        &pr_dir.join(format!("{}.json", revision.head.as_str())),
        revision,
    );
}

fn write_file(dir: &Path, sanitized_pr_id: &str, head: &Sha, path: &str, content: &str) {
    let dest = dir
        .join("git")
        .join(sanitized_pr_id)
        .join("files")
        .join(head.as_str())
        .join(path);
    std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
    std::fs::write(dest, content).unwrap();
}

fn write_script(dir: &Path, agent: AgentId, script: &str, events: Vec<RecordedEvent>) {
    let agent_dir = dir.join("agents").join(agent.as_str());
    std::fs::create_dir_all(&agent_dir).unwrap();
    let mut out = String::new();
    for event in &events {
        out.push_str(&serde_json::to_string(event).unwrap());
        out.push('\n');
    }
    std::fs::write(agent_dir.join(format!("{script}.jsonl")), out).unwrap();
}
