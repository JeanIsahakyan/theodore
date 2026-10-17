//! Integration tests for fixture adapters.

use crate::agent::ReplayAgents;
use crate::clock::ManualClock;
use crate::git::FixtureGit;
use crate::host::FixtureHost;
use crate::triggers::Triggers;
use std::time::Duration;
use theodore_ports::{AgentPort, Clock, HostAdapter};

#[test]
fn test_manual_clock_creation() {
    let clock = ManualClock::new(1000);
    assert_eq!(clock.now(), 1000);
}

#[tokio::test]
async fn test_fixture_host_creation() {
    let temp_dir = tempfile::tempdir().unwrap();
    let host = FixtureHost::new(temp_dir.path()).await.unwrap();
    assert_eq!(host.kind(), theodore_domain::HostKind::Github);
    let caps = host.capabilities();
    assert!(caps.viewed);
    assert!(caps.pending_review);
}

#[test]
fn test_fixture_git_creation() {
    let temp_dir = tempfile::tempdir().unwrap();
    let _git = FixtureGit::new(temp_dir.path());
}

#[tokio::test]
async fn test_replay_agents_detect() {
    let temp_dir = tempfile::tempdir().unwrap();
    let agents = ReplayAgents::new(temp_dir.path());
    let detected = agents.detect().await;
    assert_eq!(detected.len(), 3);
    assert_eq!(detected[0].id, theodore_domain::AgentId::Claude);
}

#[test]
fn test_triggers_author_push() {
    let triggers = Triggers::new();
    let pr = theodore_domain::PrRef {
        repo: theodore_domain::RepoRef {
            host: theodore_domain::HostKind::Github,
            owner: "test".to_string(),
            name: "repo".to_string(),
        },
        number: 1,
        host_id: None,
    };
    let new_head = theodore_domain::Sha::new("new_sha");

    triggers.author_push(pr.clone(), new_head.clone());
    let pending = triggers.pending();
    assert_eq!(pending.len(), 1);

    let event = triggers.pop();
    assert!(event.is_some());
    assert_eq!(triggers.pending().len(), 0);
}

#[tokio::test]
async fn test_clock_sleep_integration() {
    let clock = ManualClock::new(0);
    let clock_clone = clock.clone();

    let handle = tokio::spawn(async move {
        clock_clone.sleep(Duration::from_millis(100)).await;
        clock_clone.now()
    });

    // Give the task time to start sleeping
    tokio::time::sleep(Duration::from_millis(10)).await;

    // Advance past the sleep duration
    clock.advance(100);

    let result = handle.await.unwrap();
    assert_eq!(result, 100);
}

#[tokio::test]
async fn test_clock_sleep_completes_immediately_if_time_passed() {
    let clock = ManualClock::new(100);
    clock.sleep(Duration::from_millis(50)).await;
}

#[tokio::test]
async fn test_fixture_host_calls_logged() {
    let temp_dir = tempfile::tempdir().unwrap();
    let host = FixtureHost::new(temp_dir.path()).await.unwrap();

    // Make some calls
    let _ = host.list_repos().await;
    let _ = host.changed_since(None).await;

    let calls = host.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].method, "list_repos");
    assert_eq!(calls[1].method, "changed_since");
}
