//! The project config's `review:` keys (docs/config.md §1) against `Core`
//! and the testkit fakes. The fixture PR's worktree is a fixed fake path,
//! so most rules come from the global layer (the fixture's own data dir).

use std::time::Duration;

use theodore_contract::{OpenPrRequest, models};
use theodore_domain::{Group, GroupId, GroupKind, Grouping, PrId, Sha};
use theodore_ports::{Fetched, Store};

use crate::testkit::{self, Fixtures, fixtures};
use crate::{Core, Receivers};

async fn wait_until(mut cond: impl FnMut() -> bool) {
    for _ in 0..400 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("condition not met in time");
}

fn pr_ref() -> theodore_domain::PrRef {
    theodore_domain::PrRef {
        repo: theodore_domain::RepoRef {
            host: theodore_domain::HostKind::Github,
            owner: "acme".into(),
            name: "widgets".into(),
        },
        number: 7,
        host_id: Some("node-7".into()),
    }
}

/// Starts a core on `f` and opens the fixture PR (`head111`).
async fn open(f: &Fixtures) -> (Core, Receivers, PrId) {
    let detail = testkit::sample_pr_detail(&pr_ref(), &Sha::new("base000"), &Sha::new("head111"));
    f.host.push_get_pr(Ok(Fetched::Modified {
        etag: Some("etag-1".into()),
        value: detail,
    }));
    let (core, recv) = Core::start(f.deps());
    let resp = core
        .open_pr(OpenPrRequest {
            url: "https://github.com/acme/widgets/pull/7".into(),
        })
        .await
        .expect("open_pr");
    (core, recv, resp.pr)
}

fn global(f: &Fixtures, yaml: &str) {
    std::fs::write(f.data_dir.path().join("config.yaml"), yaml).unwrap();
}

fn grouping_row(f: &Fixtures, pr: &PrId) -> Option<serde_json::Value> {
    f.store
        .get(models::GROUPING, &pr.0)
        .ok()
        .flatten()
        .map(|r| r.data)
}

/// Two groups over the fixture's two hunks of `src/lib.rs`.
fn two_groups(f: &Fixtures) -> Grouping {
    let rev = testkit::two_hunk_revision(&Sha::new("base000"), &Sha::new("head111"), "src/lib.rs");
    let ids = testkit::hunk_ids(&rev);
    let group = |id: &str, hunk| Group {
        id: GroupId::new(id),
        title: id.into(),
        why: "w".into(),
        kind: GroupKind::Normal,
        risk: None,
        check: vec!["From the agent".into()],
        hunks: vec![hunk],
        outliers: vec![],
    };
    let g = Grouping {
        rev: Sha::new("head111"),
        groups: vec![group("a", ids[0].clone()), group("b", ids[1].clone())],
    };
    f.grouper.set(g.clone());
    g
}

#[tokio::test]
async fn hide_skim_reach_the_grouper_and_checklist_items_land_on_matching_groups() {
    let f = fixtures();
    two_groups(&f);
    global(
        &f,
        r#"
review:
  hide: ["gen/**"]
  skim: ["**/*.snap"]
  checklist:
    "src/**": [Is the error path tested?, From the agent]
    "docs/**": Are the docs current?
"#,
    );
    let (_core, _recv, pr) = open(&f).await;
    wait_until(|| grouping_row(&f, &pr).is_some()).await;

    let ctx = f.grouper.last_ctx().expect("grouper called");
    assert_eq!(ctx.review.hide, vec!["gen/**".to_string()]);
    assert_eq!(ctx.review.skim, vec!["**/*.snap".to_string()]);

    let row = grouping_row(&f, &pr).unwrap();
    let stored: Grouping = serde_json::from_value(row.clone()).unwrap();
    for g in &stored.groups {
        // Appended after the agent's own items, deduplicated, and nothing
        // for a glob no file of the group matches.
        assert_eq!(g.check, vec!["From the agent", "Is the error path tested?"]);
    }
    assert_eq!(
        theodore_domain::grouping::row_review_hash(&row),
        ctx.review.grouping_hash().as_deref()
    );
    assert!(ctx.review.grouping_hash().is_some());
}

#[tokio::test]
async fn a_changed_review_config_regroups_a_stored_grouping_of_the_same_head() {
    let f = fixtures();
    two_groups(&f);
    let (core, _recv, pr) = open(&f).await;
    wait_until(|| grouping_row(&f, &pr).is_some()).await;
    wait_until(|| core.0.grouping_inflight.lock().unwrap().is_empty()).await;
    assert_eq!(f.grouper.calls(), 1);
    assert_eq!(
        theodore_domain::grouping::row_review_hash(&grouping_row(&f, &pr).unwrap()),
        None
    );
    core.shutdown();

    // Same head, same (empty) config: the stored grouping is reused.
    let (core, _recv, _) = open(&f).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(f.grouper.calls(), 1);
    core.shutdown();

    // `hide` changes what the grouping is made of: regrouped on open.
    global(&f, "review:\n  hide: [\"gen/**\"]\n");
    let (core, _recv, _) = open(&f).await;
    wait_until(|| {
        grouping_row(&f, &pr)
            .is_some_and(|r| theodore_domain::grouping::row_review_hash(&r).is_some())
    })
    .await;
    assert_eq!(f.grouper.calls(), 2);
    core.shutdown();

    // `instructions` don't change a grouping: no regroup for them.
    global(
        &f,
        "review:\n  hide: [\"gen/**\"]\n  instructions: Be brief.\n",
    );
    let (core, _recv, _) = open(&f).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(f.grouper.calls(), 2);
    core.shutdown();
}

#[tokio::test]
async fn an_explicit_regroup_under_new_rules_starts_fresh() {
    let f = fixtures();
    two_groups(&f);
    let (core, _recv, pr) = open(&f).await;
    wait_until(|| grouping_row(&f, &pr).is_some()).await;
    wait_until(|| core.0.grouping_inflight.lock().unwrap().is_empty()).await;
    global(&f, "review:\n  checklist:\n    \"src/**\": Tested?\n");
    core.regroup(pr.clone()).await.expect("regroup");
    let row = grouping_row(&f, &pr).unwrap();
    let stored: Grouping = serde_json::from_value(row.clone()).unwrap();
    assert!(
        stored
            .groups
            .iter()
            .all(|g| g.check.contains(&"Tested?".to_string()))
    );
    assert!(theodore_domain::grouping::row_review_hash(&row).is_some());
}

#[tokio::test]
async fn context_files_resolve_against_the_pr_checkout() {
    let f = fixtures();
    let (core, _recv, _pr) = open(&f).await;
    let wt = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(wt.path().join(".theodore")).unwrap();
    std::fs::create_dir_all(wt.path().join("docs")).unwrap();
    std::fs::write(wt.path().join("docs/architecture.md"), "# arch").unwrap();
    std::fs::write(
        wt.path().join(".theodore/config.yaml"),
        "review:\n  instructions: Flag any new dependency.\n  context: [docs/architecture.md, docs/missing.md]\n",
    )
    .unwrap();
    let rules = core.review_rules_at(wt.path(), &pr_ref().repo).await;
    assert_eq!(rules.context, vec!["docs/architecture.md".to_string()]);
    assert_eq!(
        rules.instructions.as_deref(),
        Some("Flag any new dependency.")
    );

    // Read fresh: an edit to the file shows on the next run.
    std::fs::write(
        wt.path().join(".theodore/config.yaml"),
        "review:\n  instructions: Be brief.\n",
    )
    .unwrap();
    let rules = core.review_rules_at(wt.path(), &pr_ref().repo).await;
    assert_eq!(rules.instructions.as_deref(), Some("Be brief."));
    assert!(rules.context.is_empty());
}

// ── instructions in every agent run ─────────────────────────────────────

const INSTRUCTIONS: &str = "review:\n  instructions: Unique repo instruction marker.\n";

fn done() -> Vec<theodore_ports::AgentEvent> {
    vec![theodore_ports::AgentEvent::Done {
        final_text: "ok".into(),
        usage: theodore_domain::Usage::default(),
    }]
}

#[tokio::test]
async fn chat_and_skill_runs_carry_the_repo_instructions() {
    let f = fixtures();
    global(&f, INSTRUCTIONS);
    let (core, _recv, pr) = open(&f).await;

    f.agents.push_script(done());
    core.ask(theodore_contract::AskRequest {
        pr: pr.clone(),
        question: "why?".into(),
        about: None,
        group: None,
        agent: Some(theodore_domain::AgentId::Claude),
    })
    .await
    .expect("ask");
    wait_until(|| f.agents.last_request().is_some()).await;
    let system = f.agents.last_request().unwrap().system.unwrap();
    assert!(
        system.contains("get_pr_context"),
        "the chat's own prompt stays"
    );
    assert!(system.contains("Unique repo instruction marker."));

    f.agents.push_script(done());
    core.run_skill(theodore_contract::RunSkillRequest {
        pr,
        skill: "demo".into(),
        agents: vec![theodore_domain::AgentId::Claude],
    })
    .await
    .expect("run_skill");
    wait_until(|| f.agents.requests().len() == 2).await;
    let system = f.agents.last_request().unwrap().system.unwrap();
    assert!(system.contains("Unique repo instruction marker."));
}

#[tokio::test]
async fn no_review_config_leaves_the_prompts_alone() {
    let f = fixtures();
    let (core, _recv, pr) = open(&f).await;
    f.agents.push_script(done());
    core.run_skill(theodore_contract::RunSkillRequest {
        pr,
        skill: "demo".into(),
        agents: vec![theodore_domain::AgentId::Claude],
    })
    .await
    .expect("run_skill");
    wait_until(|| f.agents.last_request().is_some()).await;
    assert_eq!(f.agents.last_request().unwrap().system, None);
}

#[tokio::test]
async fn space_turns_carry_the_repo_instructions() {
    let f = fixtures();
    global(&f, INSTRUCTIONS);
    let (core, _recv) = Core::start(f.deps());
    tokio::time::sleep(Duration::from_millis(30)).await;
    let project = core
        .add_project(theodore_contract::AddProjectRequest {
            repo: None,
            path: Some("/tmp/my-folder".into()),
        })
        .await
        .expect("add_project");
    wait_until(|| {
        f.store
            .get(models::PROJECT, &project.id)
            .unwrap()
            .is_some_and(|r| r.data["status"] == serde_json::json!("ready"))
    })
    .await;
    f.git.set_resolve("main", Sha::new("base000"));
    f.agents.push_script(done());
    f.git.push_checkpoint(Sha::new("turn111"));
    core.create_space(theodore_contract::CreateSpaceRequest {
        project: project.id.clone(),
        goal: "Fix the login redirect".into(),
        name: None,
        branch: None,
        base: None,
        agent: None,
        model: None,
    })
    .await
    .expect("create_space");
    wait_until(|| f.agents.last_request().is_some()).await;
    let system = f.agents.last_request().unwrap().system.unwrap();
    assert!(
        system.contains("Do not push"),
        "the space's own prompt stays"
    );
    assert!(system.contains("Unique repo instruction marker."));
}
