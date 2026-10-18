//! Live, opt-in smoke test against real GitHub. Not run by default.
//!
//! ```sh
//! GITHUB_TOKEN=ghp_... cargo test -p theodore-host-github --test live_smoke -- --ignored
//! ```
//!
//! Read-only: fetches a well-known public PR and asserts the basic shape
//! came back. Picks `rust-lang/rust#1` (closed, won't disappear or churn).

use std::sync::Arc;

use theodore_domain::{HostKind, PrRef, RepoRef};
use theodore_host_http::{StaticToken, TokenSource};
use theodore_ports::{Fetched, HostAdapter};

struct SystemClock;

#[async_trait::async_trait]
impl theodore_ports::Clock for SystemClock {
    fn now(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or_default()
    }
    async fn sleep(&self, d: std::time::Duration) {
        tokio::time::sleep(d).await
    }
}

#[tokio::test]
#[ignore = "hits real github.com; run with --ignored and GITHUB_TOKEN set"]
async fn fetches_a_real_public_pr() {
    let token = std::env::var("GITHUB_TOKEN").expect("set GITHUB_TOKEN to run this test");
    let token_source: Arc<dyn TokenSource> = Arc::new(StaticToken::new(token));
    let adapter = theodore_host_github::GithubAdapter::new(token_source, Arc::new(SystemClock));

    // `THEODORE_LIVE_PR=owner/repo#n` picks another PR.
    let spec = std::env::var("THEODORE_LIVE_PR").unwrap_or_else(|_| "rust-lang/rust#1".into());
    let (slug, number) = spec.split_once('#').expect("owner/repo#n");
    let (owner, name) = slug.split_once('/').expect("owner/repo#n");
    let number: u64 = number.parse().expect("PR number");
    let pr = PrRef {
        repo: RepoRef {
            host: HostKind::Github,
            owner: owner.into(),
            name: name.into(),
        },
        number,
        host_id: None,
    };

    let Fetched::Modified { value: detail, .. } =
        adapter.get_pr(&pr, None).await.expect("live get_pr")
    else {
        panic!("expected Modified on a first, uncached fetch");
    };

    assert!(!detail.summary.title.is_empty());
    assert_eq!(detail.summary.pr.number, number);
}

#[tokio::test]
#[ignore = "hits real github.com; run with --ignored and GITHUB_TOKEN set"]
async fn runs_every_inbox_search_and_viewer() {
    let token = std::env::var("GITHUB_TOKEN").expect("set GITHUB_TOKEN to run this test");
    let token_source: Arc<dyn TokenSource> = Arc::new(StaticToken::new(token));
    let adapter = theodore_host_github::GithubAdapter::new(token_source, Arc::new(SystemClock));
    adapter.viewer().await.expect("viewer");
    for section in [
        theodore_ports::InboxSection::ReviewRequested,
        theodore_ports::InboxSection::Assigned,
        theodore_ports::InboxSection::Authored,
        theodore_ports::InboxSection::Mentioned,
    ] {
        adapter
            .search(&section)
            .await
            .unwrap_or_else(|e| panic!("{section:?}: {e}"));
    }
    adapter.list_repos().await.expect("list_repos");
    adapter.changed_since(None).await.expect("changed_since");
}

#[tokio::test]
#[ignore = "hits real github.com; run with --ignored and GITHUB_TOKEN set"]
async fn reads_merge_status_and_assignable_users() {
    // Read-only: never call a write method (merge, enable_auto_merge, ...)
    // against a real host.
    let token = std::env::var("GITHUB_TOKEN").expect("set GITHUB_TOKEN to run this test");
    let token_source: Arc<dyn TokenSource> = Arc::new(StaticToken::new(token));
    let adapter = theodore_host_github::GithubAdapter::new(token_source, Arc::new(SystemClock));

    let spec = std::env::var("THEODORE_LIVE_PR").unwrap_or_else(|_| "rust-lang/rust#1".into());
    let (slug, number) = spec.split_once('#').expect("owner/repo#n");
    let (owner, name) = slug.split_once('/').expect("owner/repo#n");
    let number: u64 = number.parse().expect("PR number");
    let repo = RepoRef {
        host: HostKind::Github,
        owner: owner.into(),
        name: name.into(),
    };
    let pr = PrRef {
        repo: repo.clone(),
        number,
        host_id: None,
    };

    adapter.merge_status(&pr).await.expect("merge_status");
    adapter
        .assignable_users(&repo)
        .await
        .expect("assignable_users");
}
