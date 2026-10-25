//! Tests for every fixture adapter and trigger, against the checked-in
//! `data/demo` fixture set plus a couple of minimal ad-hoc sets for
//! edge cases (cancellation, missing terminal event) that `data/demo`
//! has no reason to carry.

use std::path::{Path, PathBuf};
use std::time::Duration;

use theodore_domain::{
    AgentId, CheckRollup, CheckStatus, FileDiff, Grouping, Person, PrDetail, PrRef, PrState,
    PrSummary, RepoRef, Revision, Sha,
};
use theodore_ports::{
    AgentEvent, AgentMode, AgentPort, AgentRequest, Clock, DiffOptions, GitPort, HostAdapter,
};

use crate::FixtureSet;
use crate::agent::{RecordedEvent, ScriptRule};

fn demo_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("data/demo")
}

async fn drain(run: &mut theodore_ports::AgentRun) -> Vec<AgentEvent> {
    let mut events = Vec::new();
    while let Some(ev) = run.events.recv().await {
        events.push(ev);
    }
    events
}

fn agent_request(prompt: &str) -> AgentRequest {
    AgentRequest {
        agent: AgentId::Claude,
        prompt: prompt.to_string(),
        system: None,
        cwd: PathBuf::from("."),
        mode: AgentMode::ReadOnly,
        mcp: None,
        model: None,
        stall_after_ms: 90_000,
        env: Vec::new(),
        user_mcp: false,
    }
}

async fn pr_by_number(host: &crate::FixtureHost, number: u64) -> PrRef {
    host.changed_since(None)
        .await
        .unwrap()
        .prs
        .into_iter()
        .find(|p| p.number == number)
        .expect("demo pr present")
}

// ── clock ────────────────────────────────────────────────────────────────

#[test]
fn clock_now_and_advance() {
    let clock = crate::ManualClock::new(1_000);
    assert_eq!(clock.now(), 1_000);
    clock.advance(500);
    assert_eq!(clock.now(), 1_500);
}

#[tokio::test]
async fn clock_sleep_resolves_only_after_advance() {
    let clock = crate::ManualClock::new(0);
    let waiter = clock.clone();
    let task = tokio::spawn(async move { waiter.sleep(Duration::from_millis(100)).await });

    tokio::time::sleep(Duration::from_millis(10)).await;
    assert!(!task.is_finished());
    clock.advance(100);
    tokio::time::sleep(Duration::from_millis(10)).await;
    assert!(task.is_finished());
}

// ── FixtureSet / host ───────────────────────────────────────────────────

#[tokio::test]
async fn load_demo_set_lists_both_prs() {
    let (host, _git, _agents, _clock, _triggers) = FixtureSet::load(demo_dir()).unwrap();
    let changes = host.changed_since(None).await.unwrap();
    assert_eq!(changes.prs.len(), 2);
}

#[tokio::test]
async fn get_pr_etag_is_stable_until_something_changes() {
    let (host, _git, _agents, _clock, triggers) = FixtureSet::load(demo_dir()).unwrap();
    let pr = pr_by_number(&host, 101).await;

    let first = host.get_pr(&pr, None).await.unwrap();
    let etag = match first {
        theodore_ports::Fetched::Modified { etag, .. } => etag.unwrap(),
        theodore_ports::Fetched::NotModified => panic!("expected Modified on first fetch"),
    };

    // Same etag, nothing changed: NotModified.
    let second = host.get_pr(&pr, Some(&etag)).await.unwrap();
    assert!(matches!(second, theodore_ports::Fetched::NotModified));

    // checks_green mutates the PR: the etag must change.
    triggers.checks_green(&pr).unwrap();
    let third = host.get_pr(&pr, Some(&etag)).await.unwrap();
    assert!(matches!(third, theodore_ports::Fetched::Modified { .. }));
}

#[tokio::test]
async fn changed_since_cursor_only_reports_new_changes() {
    let (host, _git, _agents, _clock, triggers) = FixtureSet::load(demo_dir()).unwrap();
    let pr = pr_by_number(&host, 101).await;

    let baseline = host.changed_since(None).await.unwrap();
    assert_eq!(baseline.prs.len(), 2);

    // Nothing changed since the baseline cursor: empty.
    let quiet = host.changed_since(Some(&baseline.cursor)).await.unwrap();
    assert!(quiet.prs.is_empty());

    triggers.checks_green(&pr).unwrap();
    let after = host.changed_since(Some(&baseline.cursor)).await.unwrap();
    assert_eq!(after.prs, vec![pr]);
}

#[tokio::test]
async fn host_write_methods_round_trip() {
    let (host, _git, _agents, _clock, _triggers) = FixtureSet::load(demo_dir()).unwrap();
    let pr = pr_by_number(&host, 101).await;

    host.set_viewed(&pr, "src/webhooks/deliver.ts", true)
        .await
        .unwrap();

    let detail = match host.get_pr(&pr, None).await.unwrap() {
        theodore_ports::Fetched::Modified { value, .. } => value,
        _ => unreachable!(),
    };
    assert_eq!(
        detail
            .viewed
            .iter()
            .find(|v| v.path == "src/webhooks/deliver.ts")
            .map(|v| v.state),
        Some(theodore_domain::ViewedState::Viewed)
    );

    let submission = theodore_ports::ReviewSubmission {
        event: theodore_domain::ReviewEvent::Comment,
        body: "lgtm with one note".to_string(),
        comments: vec![theodore_ports::ReviewComment {
            anchor: theodore_domain::Anchor {
                rev: Sha::new("head-479-1"),
                path: "src/webhooks/deliver.ts".to_string(),
                side: theodore_domain::Side::New,
                line: 5,
                start_line: None,
                start_side: None,
            },
            body: "consider capping backoff".to_string(),
            marker: "m1".to_string(),
        }],
        commit: Sha::new("head-479-1"),
    };
    let submitted = host.submit_review(&pr, &submission).await.unwrap();
    assert_eq!(submitted.threads.len(), 1);
    let (marker, thread_id) = &submitted.threads[0];
    assert_eq!(marker, "m1");

    let comment_id = host.reply(&pr, thread_id, "thanks, done").await.unwrap();
    host.edit_comment(&pr, &comment_id, "thanks, done!")
        .await
        .unwrap();
    host.resolve(&pr, thread_id, true).await.unwrap();
    host.delete_comment(&pr, &comment_id).await.unwrap();
}

#[tokio::test]
async fn create_pr_is_found_by_head_and_served_by_search_and_get_pr() {
    let (host, _git, _agents, _clock, _triggers) = FixtureSet::load(demo_dir()).unwrap();
    let repo = RepoRef {
        host: theodore_domain::HostKind::Github,
        owner: "octo".into(),
        name: "webhooks".into(),
    };
    assert_eq!(
        host.find_open_pr(&repo, "demo/space-1").await.unwrap(),
        None
    );

    let new_pr = theodore_ports::NewPr {
        head: "demo/space-1".into(),
        base: "main".into(),
        title: "Space one".into(),
        body: "Opened from a space.".into(),
        draft: true,
    };
    let created = host.create_pr(&repo, &new_pr).await.unwrap();
    assert_eq!(created.repo, repo);
    assert_eq!(created.number, 102, "next number after the demo's #101");

    assert_eq!(
        host.find_open_pr(&repo, "demo/space-1").await.unwrap(),
        Some(created.clone())
    );

    let listed = host
        .search(&theodore_ports::InboxSection::Authored)
        .await
        .unwrap();
    let row = listed
        .iter()
        .find(|s| s.pr == created)
        .expect("created PR is searchable");
    assert_eq!(row.state, PrState::Draft);
    assert_eq!(row.head_ref, "demo/space-1");
    assert_eq!(row.base_ref, "main");
    assert_eq!(row.author.login, "demo");

    let detail = match host.get_pr(&created, None).await.unwrap() {
        theodore_ports::Fetched::Modified { value, .. } => value,
        theodore_ports::Fetched::NotModified => unreachable!(),
    };
    assert_eq!(detail.summary.title, "Space one");
    assert_eq!(detail.body, "Opened from a space.");
    assert_eq!(detail.summary.pr, created);

    let again = host.create_pr(&repo, &new_pr).await.unwrap_err();
    assert!(
        matches!(again, theodore_ports::HostError::Conflict(_)),
        "got {again:?}"
    );
}

// ── git ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn git_diff_and_show_read_the_recorded_revision() {
    let (host, git, _agents, _clock, _triggers) = FixtureSet::load(demo_dir()).unwrap();
    let pr = pr_by_number(&host, 101).await;
    let head = git.fetch_pr(&pr).await.unwrap();

    let revision = git
        .diff(
            Path::new("unused"),
            &Sha::new("unused"),
            &head,
            &DiffOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(revision.files.len(), 3);
    assert!(revision.hunks().count() >= 3);

    let content = git
        .show(Path::new("unused"), &head, "src/webhooks/deliver.ts")
        .await
        .unwrap()
        .expect("file recorded for this head");
    assert!(String::from_utf8(content).unwrap().contains("MAX_ATTEMPTS"));

    assert!(
        git.show(Path::new("unused"), &head, "no/such/file.ts")
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn worktree_is_populated_with_the_heads_files() {
    let (host, git, _agents, _clock, _triggers) = FixtureSet::load(demo_dir()).unwrap();
    let pr = pr_by_number(&host, 101).await;
    let head = git.fetch_pr(&pr).await.unwrap();

    let wt = git.worktree(&pr, &head).await.unwrap();
    let file = std::fs::read_to_string(wt.path.join("src/webhooks/backoff.ts")).unwrap();
    assert!(file.contains("MAX_ATTEMPTS"));

    git.remove_worktree(&pr).await.unwrap();
    let removed = git.gc_worktrees(&[]).await.unwrap();
    assert_eq!(removed, 0, "already removed by remove_worktree");
}

// ── triggers mutate the state FixtureHost / FixtureGit read ────────────

#[tokio::test]
async fn author_push_moves_the_head_everyone_reads() {
    let (host, git, _agents, _clock, triggers) = FixtureSet::load(demo_dir()).unwrap();
    let pr = pr_by_number(&host, 101).await;

    let before = git.fetch_pr(&pr).await.unwrap();
    let new_head = Sha::new("head-479-2");
    triggers.author_push(&pr, new_head.clone()).unwrap();

    let after = git.fetch_pr(&pr).await.unwrap();
    assert_ne!(before, after);
    assert_eq!(after, new_head);

    // FixtureGit can now diff the new head.
    let revision = git
        .diff(
            Path::new("u"),
            &Sha::new("u"),
            &new_head,
            &DiffOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(revision.head, new_head);

    // FixtureHost reports the PR's new head too.
    let detail = match host.get_pr(&pr, None).await.unwrap() {
        theodore_ports::Fetched::Modified { value, .. } => value,
        _ => unreachable!(),
    };
    assert_eq!(detail.summary.head_sha, new_head);
}

#[tokio::test]
async fn author_push_rejects_unknown_pr_or_head() {
    let (host, _git, _agents, _clock, triggers) = FixtureSet::load(demo_dir()).unwrap();
    let pr = pr_by_number(&host, 101).await;

    let err = triggers
        .author_push(&pr, Sha::new("no-such-head"))
        .unwrap_err();
    assert!(matches!(err, crate::triggers::TriggerError::UnknownHead(_)));

    let unknown_pr = PrRef {
        repo: RepoRef {
            host: theodore_domain::HostKind::Github,
            owner: "nope".to_string(),
            name: "nope".to_string(),
        },
        number: 999,
        host_id: None,
    };
    let err = triggers
        .author_push(&unknown_pr, Sha::new("head-479-2"))
        .unwrap_err();
    assert!(matches!(err, crate::triggers::TriggerError::UnknownPr(_)));
}

#[tokio::test]
async fn checks_green_sets_check_rollup_and_each_check() {
    let (host, _git, _agents, _clock, triggers) = FixtureSet::load(demo_dir()).unwrap();
    let pr = pr_by_number(&host, 101).await;

    triggers.checks_green(&pr).unwrap();

    let detail = match host.get_pr(&pr, None).await.unwrap() {
        theodore_ports::Fetched::Modified { value, .. } => value,
        _ => unreachable!(),
    };
    assert_eq!(detail.summary.checks, CheckRollup::Pass);
    assert!(detail.checks.iter().all(|c| c.status == CheckStatus::Pass));
}

// ── agents: rules, scripts, cancellation, crash ─────────────────────────

#[tokio::test]
async fn grouping_script_final_text_validates_against_the_demo_revision() {
    let (host, git, agents, _clock, _triggers) = FixtureSet::load(demo_dir()).unwrap();
    let pr = pr_by_number(&host, 101).await;
    let head = git.fetch_pr(&pr).await.unwrap();
    let revision = git
        .diff(
            Path::new("u"),
            &Sha::new("u"),
            &head,
            &DiffOptions::default(),
        )
        .await
        .unwrap();

    let mut run = agents
        .run(agent_request("run the grouping task for this PR"))
        .await
        .unwrap();
    let events = drain(&mut run).await;

    let final_text = events
        .iter()
        .find_map(|e| match e {
            AgentEvent::Done { final_text, .. } => Some(final_text.clone()),
            _ => None,
        })
        .expect("grouping script ends in Done");
    let grouping: Grouping = serde_json::from_str(&final_text).unwrap();
    theodore_domain::grouping::validate(&revision, &grouping).unwrap();
}

#[tokio::test]
async fn both_claude_and_codex_have_a_grouping_script() {
    let (_host, _git, agents, _clock, _triggers) = FixtureSet::load(demo_dir()).unwrap();
    for agent in [AgentId::Claude, AgentId::Codex] {
        let mut req = agent_request("grouping, please");
        req.agent = agent;
        let mut run = agents.run(req).await.unwrap();
        let events = drain(&mut run).await;
        assert!(matches!(events.last(), Some(AgentEvent::Done { .. })));
    }
}

#[tokio::test]
async fn skill_script_reports_a_tool_call() {
    let (_host, _git, agents, _clock, _triggers) = FixtureSet::load(demo_dir()).unwrap();
    let mut run = agents
        .run(agent_request("run the skill now"))
        .await
        .unwrap();
    let events = drain(&mut run).await;
    assert!(events.iter().any(|e| matches!(
        e,
        AgentEvent::ToolCall { name, .. } if name == "add_finding"
    )));
    assert!(matches!(events.last(), Some(AgentEvent::Done { .. })));
}

#[tokio::test]
async fn unmatched_prompt_falls_back_to_the_default_chat_script() {
    let (_host, _git, agents, _clock, _triggers) = FixtureSet::load(demo_dir()).unwrap();
    let mut run = agents
        .run(agent_request("what does this function do?"))
        .await
        .unwrap();
    let events = drain(&mut run).await;
    assert!(matches!(events.last(), Some(AgentEvent::Done { .. })));
    assert!(events.len() >= 2, "chat script has more than just Done");
}

#[tokio::test]
async fn exit_error_script_ends_in_error_not_done() {
    let (_host, _git, agents, _clock, _triggers) = FixtureSet::load(demo_dir()).unwrap();
    let agents = agents.with_rules(vec![ScriptRule::new("trigger-error", "exit_error")]);
    let mut run = agents
        .run(agent_request("trigger-error please"))
        .await
        .unwrap();
    let events = drain(&mut run).await;
    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], AgentEvent::Error { .. }));
}

#[tokio::test]
async fn agent_crash_trigger_fails_only_the_next_run() {
    let (_host, _git, agents, _clock, triggers) = FixtureSet::load(demo_dir()).unwrap();
    triggers.agent_crash(AgentId::Claude);

    let mut run = agents
        .run(agent_request("what does this do?"))
        .await
        .unwrap();
    let events = drain(&mut run).await;
    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], AgentEvent::Error { .. }));

    // The crash only applies once; the next run plays its script normally.
    let mut run = agents
        .run(agent_request("what does this do?"))
        .await
        .unwrap();
    let events = drain(&mut run).await;
    assert!(matches!(events.last(), Some(AgentEvent::Done { .. })));
}

#[tokio::test]
async fn cancellation_stops_the_stream_with_a_cancelled_error() {
    let dir = minimal_fixture_dir(vec![RecordedEvent {
        event: AgentEvent::Text {
            text: "slow step".to_string(),
        },
        delay_ms: 60_000,
    }]);
    let (_host, _git, agents, _clock, _triggers) = FixtureSet::load(dir.path()).unwrap();

    let mut run = agents.run(agent_request("anything")).await.unwrap();
    run.cancel.cancel();
    let events = drain(&mut run).await;

    assert_eq!(events.len(), 1);
    match &events[0] {
        AgentEvent::Error { message, .. } => assert_eq!(message, "cancelled"),
        other => panic!("expected a cancelled error, got {other:?}"),
    }
}

#[tokio::test]
async fn a_script_with_no_terminal_event_still_ends_in_exactly_one() {
    let dir = minimal_fixture_dir(vec![RecordedEvent {
        event: AgentEvent::Text {
            text: "only this".to_string(),
        },
        delay_ms: 0,
    }]);
    let (_host, _git, agents, _clock, _triggers) = FixtureSet::load(dir.path()).unwrap();

    let mut run = agents.run(agent_request("anything")).await.unwrap();
    let events = drain(&mut run).await;

    let terminal: Vec<_> = events
        .iter()
        .filter(|e| matches!(e, AgentEvent::Done { .. } | AgentEvent::Error { .. }))
        .collect();
    assert_eq!(terminal.len(), 1);
    assert!(matches!(events.last(), Some(AgentEvent::Done { .. })));
}

#[tokio::test]
async fn missing_script_is_a_spawn_error() {
    let (_host, _git, agents, _clock, _triggers) = FixtureSet::load(demo_dir()).unwrap();
    let agents = agents.with_default(AgentId::Gemini, "nonexistent");
    let mut req = agent_request("anything");
    req.agent = AgentId::Gemini;
    match agents.run(req).await {
        Err(theodore_ports::AgentError::Spawn(_)) => {}
        other => panic!("expected a spawn error, got {}", other.is_ok()),
    }
}

#[tokio::test]
async fn detect_reports_every_agent_id() {
    let (_host, _git, agents, _clock, _triggers) = FixtureSet::load(demo_dir()).unwrap();
    let detected = agents.detect().await;
    assert_eq!(detected.len(), AgentId::ALL.len());
    assert!(detected.iter().all(|a| a.installed));
}

// ── FixtureSet error path ───────────────────────────────────────────────

#[test]
fn load_rejects_malformed_json() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("host")).unwrap();
    std::fs::write(dir.path().join("host").join("prs.json"), "not json").unwrap();
    let err = FixtureSet::load(dir.path()).unwrap_err();
    assert!(matches!(err, crate::FixtureError::Json { .. }));
}

#[tokio::test]
async fn load_tolerates_a_directory_with_no_host_or_git_data() {
    let dir = tempfile::tempdir().unwrap();
    let (host, _git, _agents, _clock, _triggers) = FixtureSet::load(dir.path()).unwrap();
    let changes = host.changed_since(None).await.unwrap();
    assert!(changes.prs.is_empty());
}

// ── helpers for the ad-hoc minimal fixture sets above ──────────────────

fn minimal_fixture_dir(claude_script: Vec<RecordedEvent>) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();

    let pr = PrRef {
        repo: RepoRef {
            host: theodore_domain::HostKind::Github,
            owner: "t".to_string(),
            name: "r".to_string(),
        },
        number: 1,
        host_id: None,
    };
    let head = Sha::new("h1");
    let detail = PrDetail {
        summary: PrSummary {
            pr: pr.clone(),
            title: "minimal".to_string(),
            author: Person {
                login: "me".to_string(),
                name: None,
                avatar_url: None,
            },
            state: PrState::Open,
            base_ref: "main".to_string(),
            head_ref: "feature".to_string(),
            head_sha: head.clone(),
            additions: 0,
            deletions: 0,
            changed_files: 0,
            reasons: vec![],
            checks: CheckRollup::None,
            approvals: 0,
            required_approvals: None,
            updated_at: 0,
            url: String::new(),
            review_decision: None,
            conflicts: false,
            created_at: None,
            stack: None,
        },
        body: String::new(),
        base_sha: Sha::new("base"),
        commits: vec![],
        checks: vec![],
        reviewers: vec![],
        assignees: vec![],
        labels: vec![],
        threads: vec![],
        viewed: vec![],
    };

    let host_dir = dir.path().join("host");
    std::fs::create_dir_all(&host_dir).unwrap();
    std::fs::write(
        host_dir.join("prs.json"),
        serde_json::to_string(&vec![detail]).unwrap(),
    )
    .unwrap();

    let git_dir = dir.path().join("git").join("t_r_1");
    std::fs::create_dir_all(&git_dir).unwrap();
    let revision = Revision {
        base: Sha::new("base"),
        head: head.clone(),
        files: Vec::<FileDiff>::new(),
    };
    std::fs::write(
        git_dir.join(format!("{}.json", head.as_str())),
        serde_json::to_string(&revision).unwrap(),
    )
    .unwrap();

    let agents_dir = dir.path().join("agents").join("claude");
    std::fs::create_dir_all(&agents_dir).unwrap();
    let mut lines = String::new();
    for event in &claude_script {
        lines.push_str(&serde_json::to_string(event).unwrap());
        lines.push('\n');
    }
    std::fs::write(agents_dir.join("chat.jsonl"), lines).unwrap();

    dir
}
