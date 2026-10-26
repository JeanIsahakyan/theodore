//! Shared test support: a controllable clock so retry/rate-limit tests don't
//! sleep in real time, and a client wired to a wiremock server.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use theodore_ports::Clock;

/// Advances on every `sleep` call instead of actually waiting, and lets tests
/// read "now" deterministically.
pub struct FakeClock {
    now_ms: AtomicI64,
}

impl FakeClock {
    pub fn new(start_ms: i64) -> Arc<Self> {
        Arc::new(Self {
            now_ms: AtomicI64::new(start_ms),
        })
    }

    pub fn set(&self, ms: i64) {
        self.now_ms.store(ms, Ordering::SeqCst);
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
