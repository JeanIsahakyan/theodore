//! `theodore eval` against the real fixtures shipped in `apps/cli/fixtures/`
//! (derived from the code-review-tool mock PRs), with a fake agent that
//! answers correctly so the harness itself is exercised end to end.

use std::path::Path;

use theodore_cli::eval;
use theodore_domain::AgentId;
use theodore_grouping::testing::FakeAgentPort;
use theodore_grouping::{PromptBudget, prepass};

fn fixtures_dir() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

/// One valid response per fixture: every non-hidden hunk goes into a single
/// group. Exercises the harness's plumbing, not grouping quality — that
/// needs a real agent and real PRs (plan §5.4).
fn trivially_valid_response(rev: &theodore_domain::Revision) -> String {
    let pass = prepass::run(rev);
    let ids: Vec<String> = rev
        .files
        .iter()
        .filter(|f| !pass.is_hidden(&f.path))
        .flat_map(|f| f.hunks.iter().map(|h| h.id.as_str().to_string()))
        .collect();
    let hunks = ids
        .iter()
        .map(|id| format!("\"{id}\""))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        r#"{{"groups": [{{"id": "g1", "title": "Everything", "why": "one group",
            "kind": "normal", "check": [], "hunks": [{hunks}], "outliers": []}}]}}"#
    )
}

#[tokio::test]
async fn loads_all_shipped_fixtures() {
    let fixtures = eval::load_fixtures(&fixtures_dir()).unwrap();
    let names: Vec<&str> = fixtures.iter().map(|(n, _)| n.as_str()).collect();
    assert!(names.contains(&"pr482"));
    assert!(names.contains(&"pr211"));
    assert!(names.contains(&"pr479"));
    for (_, fx) in &fixtures {
        assert!(!fx.revision.files.is_empty());
    }
}

#[tokio::test]
async fn eval_runs_every_fixture_and_reports_valid_first_try() {
    let fixtures = eval::load_fixtures(&fixtures_dir()).unwrap();
    let responses: Vec<String> = fixtures
        .iter()
        .map(|(_, fx)| trivially_valid_response(&fx.revision))
        .collect();
    let agent = FakeAgentPort::new(responses);

    let rows = eval::run_eval(&agent, AgentId::Claude, &fixtures, Path::new(".")).await;
    assert_eq!(rows.len(), fixtures.len());
    for row in &rows {
        assert!(row.error.is_none(), "{}: {:?}", row.name, row.error);
        assert!(
            row.valid_first_try,
            "{} should be valid on the first try",
            row.name
        );
        assert!(row.groups >= 1);
    }
}

#[tokio::test]
async fn garbage_agent_still_yields_a_valid_grouping_for_every_fixture() {
    let fixtures = eval::load_fixtures(&fixtures_dir()).unwrap();
    // two garbage responses per fixture: the initial call and the repair call.
    let responses: Vec<String> =
        std::iter::repeat_n("not json, sorry".to_string(), fixtures.len() * 2).collect();
    let agent = FakeAgentPort::new(responses);

    let rows = eval::run_eval(&agent, AgentId::Claude, &fixtures, Path::new(".")).await;
    for row in &rows {
        assert!(row.error.is_none());
        assert!(!row.valid_first_try);
        assert!(
            row.valid_after_repair,
            "{} must still end up valid via the Other fallback",
            row.name
        );
    }
}

#[test]
fn prompt_budget_is_reasonable_for_the_shipped_fixtures() {
    // sanity check that these fixtures are small enough to be single-chunk
    // under the default budget, which is what the two tests above assume.
    let fixtures = eval::load_fixtures(&fixtures_dir()).unwrap();
    for (name, fx) in &fixtures {
        let pass = prepass::run(&fx.revision);
        let chunks = theodore_grouping::prompt::build_prompts(
            &theodore_grouping::PrMeta::default(),
            &fx.revision,
            &pass,
            &PromptBudget::default(),
        );
        assert_eq!(
            chunks.len(),
            1,
            "fixture {name} unexpectedly split into multiple chunks"
        );
    }
}
