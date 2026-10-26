//! `crates/fixtures/data/sandbox` is `default_scenario::build()` written
//! out. Regenerate after changing the builder:
//! `UPDATE_SANDBOX_SCENARIO=1 cargo test -p theodore-sandbox --test default_scenario`.

use std::path::PathBuf;

use theodore_sandbox::{Scenario, default_scenario};

fn checked_in() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/data/sandbox")
}

#[test]
fn the_checked_in_scenario_matches_the_builder() {
    let dir = checked_in();
    if std::env::var_os("UPDATE_SANDBOX_SCENARIO").is_some() {
        default_scenario::write(&dir).unwrap();
    }
    let tmp = tempfile::tempdir().unwrap();
    default_scenario::write(tmp.path()).unwrap();
    let want = std::fs::read_to_string(tmp.path().join("scenario.json")).unwrap();
    let have = std::fs::read_to_string(dir.join("scenario.json")).unwrap();
    assert!(
        want == have,
        "crates/fixtures/data/sandbox/scenario.json is stale; rerun with UPDATE_SANDBOX_SCENARIO=1"
    );
    let (_, assets) = default_scenario::build();
    for (path, bytes) in assets {
        assert_eq!(
            std::fs::read(dir.join(path)).unwrap(),
            bytes,
            "{path} is stale"
        );
    }
    Scenario::load(&dir).unwrap();
}
