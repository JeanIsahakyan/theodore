//! Integration tests for `theodore group`'s testable core: parsing a diff
//! file and running the grouping pipeline with a fake agent, no `main` or
//! `deps::real_deps` involved.

use std::io::Write;
use std::path::Path;

use theodore_cli::{difffile, group};
use theodore_domain::{AgentId, grouping};
use theodore_grouping::PrMeta;
use theodore_grouping::testing::FakeAgentPort;

const DIFF: &str = r#"diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 line one
+line two
 line three
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index 3333333..4444444 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -1,1 +1,1 @@
-old
+new
"#;

fn write_temp_diff() -> tempfile::NamedTempFile {
    let mut f = tempfile::Builder::new()
        .suffix(".patch")
        .tempfile()
        .unwrap();
    f.write_all(DIFF.as_bytes()).unwrap();
    f
}

#[tokio::test]
async fn diff_file_round_trips_through_the_pipeline() {
    let file = write_temp_diff();
    let args = group::GroupArgs {
        pr_url: None,
        diff_file: Some(file.path().to_path_buf()),
        agent: group::AgentChoice::Claude,
        json: false,
        save: None,
    };
    let (rev, pr, _cwd) = group::load_input(&args).unwrap();
    assert_eq!(rev.files.len(), 2);

    let json = r#"{"groups": [{"id": "g1", "title": "Add a line", "why": "adds line two",
        "kind": "normal", "hunks": ["__ID__"], "outliers": []}]}"#;
    let real_id = rev.files[0].hunks[0].id.clone();
    let scripted = json.replace("__ID__", real_id.as_str());

    let agent = FakeAgentPort::new([scripted]);
    let report = group::run(&agent, AgentId::Claude, &pr, &rev, Path::new("."))
        .await
        .unwrap();

    assert!(grouping::validate(&rev, &report.grouping).is_ok());
    // the lockfile hunk must have landed in the deterministic hidden group,
    // without ever being sent to the agent.
    let hidden = report
        .grouping
        .groups
        .iter()
        .find(|g| g.kind == theodore_domain::GroupKind::Hidden)
        .expect("hidden group");
    assert_eq!(hidden.hunks.len(), 1);
    assert_eq!(agent.calls_made(), 1);
    // the file is named in the hidden summary, but its hunk content never is.
    assert!(
        !agent.requests()[0]
            .prompt
            .contains(hidden.hunks[0].as_str())
    );
}

#[tokio::test]
async fn missing_input_is_a_clear_error() {
    let args = group::GroupArgs {
        pr_url: None,
        diff_file: None,
        agent: group::AgentChoice::Claude,
        json: false,
        save: None,
    };
    let err = group::load_input(&args).unwrap_err();
    assert!(err.to_string().contains("--diff-file"));
}

#[tokio::test]
async fn pr_urls_are_not_loaded_offline() {
    let args = group::GroupArgs {
        pr_url: Some("https://github.com/o/r/pull/1".into()),
        diff_file: None,
        agent: group::AgentChoice::Claude,
        json: false,
        save: None,
    };
    let err = group::load_input(&args).unwrap_err();
    assert!(err.to_string().contains("load_pr"));
}

#[tokio::test]
async fn emit_saves_grouping_json() {
    let rev = difffile::parse(DIFF, "base", "head").unwrap();
    // garbage twice (initial + repair) still ends in a valid grouping via
    // the "Other" fallback — emit() only cares that it can serialize it.
    let agent = FakeAgentPort::new(["not json", "still not json"]);
    let report = group::run(
        &agent,
        AgentId::Claude,
        &PrMeta::default(),
        &rev,
        Path::new("."),
    )
    .await
    .unwrap();

    let dir = tempfile::tempdir().unwrap();
    group::emit(&report, &rev, true, Some(dir.path())).unwrap();
    let saved = dir.path().join(format!("{}.json", rev.head));
    assert!(saved.exists());
    let text = std::fs::read_to_string(saved).unwrap();
    assert!(text.contains("\"groups\""));
}
