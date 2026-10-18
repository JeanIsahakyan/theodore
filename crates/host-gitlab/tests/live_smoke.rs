//! Live, opt-in smoke test against real GitLab. Not run by default.
//!
//! ```sh
//! GITLAB_TOKEN=glpat-... cargo test -p theodore-host-gitlab --test live_smoke -- --ignored
//! ```
//!
//! Read-only: fetches a well-known public merge request and asserts the
//! basic shape came back. Picks `gitlab-org/gitlab-runner!1` (merged long
//! ago, won't disappear or churn).

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
#[ignore = "hits real gitlab.com; run with --ignored and GITLAB_TOKEN set"]
async fn fetches_a_real_public_merge_request() {
    let token = std::env::var("GITLAB_TOKEN").expect("set GITLAB_TOKEN to run this test");
    let token_source: Arc<dyn TokenSource> = Arc::new(StaticToken::new(token));
    let adapter = theodore_host_gitlab::GitlabAdapter::new(token_source, Arc::new(SystemClock));

    let pr = PrRef {
        repo: RepoRef {
            host: HostKind::Gitlab,
            owner: "gitlab-org".into(),
            name: "gitlab-runner".into(),
        },
        number: 1,
        host_id: None,
    };

    let Fetched::Modified { value: detail, .. } =
        adapter.get_pr(&pr, None).await.expect("live get_pr")
    else {
        panic!("expected Modified on a first, uncached fetch");
    };

    assert!(!detail.summary.title.is_empty());
    assert_eq!(detail.summary.pr.number, 1);
}

#[tokio::test]
#[ignore = "hits real gitlab.com; run with --ignored and GITLAB_TOKEN set"]
async fn reads_merge_status_and_assignable_users() {
    // Read-only: never call a write method (merge, enable_auto_merge, ...)
    // against a real host.
    let token = std::env::var("GITLAB_TOKEN").expect("set GITLAB_TOKEN to run this test");
    let token_source: Arc<dyn TokenSource> = Arc::new(StaticToken::new(token));
    let adapter = theodore_host_gitlab::GitlabAdapter::new(token_source, Arc::new(SystemClock));

    let repo = RepoRef {
        host: HostKind::Gitlab,
        owner: "gitlab-org".into(),
        name: "gitlab-runner".into(),
    };
    let pr = PrRef {
        repo: repo.clone(),
        number: 1,
        host_id: None,
    };

    adapter.merge_status(&pr).await.expect("merge_status");
    adapter
        .assignable_users(&repo)
        .await
        .expect("assignable_users");
}
