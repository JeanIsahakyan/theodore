//! Shared test support: a controllable clock and a `GitlabAdapter` wired to
//! a wiremock server standing in for `gitlab.com/api/v4`.
//!
//! Each integration test binary links this module separately and uses a
//! different subset of it, so unused items here aren't a real dead-code
//! smell - allow it crate(/binary)-wide instead of per-item.
#![allow(dead_code)]

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use theodore_host_gitlab::GitlabAdapter;
use theodore_host_http::{StaticToken, TokenSource};
use theodore_ports::Clock;
use wiremock::MockServer;

pub struct FakeClock {
    now_ms: AtomicI64,
}

impl FakeClock {
    pub fn new(start_ms: i64) -> Arc<Self> {
        Arc::new(Self {
            now_ms: AtomicI64::new(start_ms),
        })
    }
}

#[async_trait]
impl Clock for FakeClock {
    fn now(&self) -> i64 {
        self.now_ms.load(Ordering::SeqCst)
    }

    async fn sleep(&self, d: Duration) {
        self.now_ms
            .fetch_add(d.as_millis() as i64, Ordering::SeqCst);
    }
}

pub struct Servers {
    pub api: MockServer,
    pub adapter: GitlabAdapter,
}

pub async fn servers() -> Servers {
    servers_with_token(Some("test-token")).await
}

pub async fn servers_with_token(token: Option<&str>) -> Servers {
    let api = MockServer::start().await;
    let clock = FakeClock::new(1_700_000_000_000);
    let token_source: Arc<dyn TokenSource> = Arc::new(StaticToken(token.map(str::to_string)));

    let base = url::Url::parse(&format!("{}/", api.uri())).expect("base url");
    let adapter = GitlabAdapter::with_base_url(base, token_source, clock);

    Servers { api, adapter }
}

pub fn fixture(name: &str) -> serde_json::Value {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read fixture {path}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse fixture {path}: {e}"))
}
