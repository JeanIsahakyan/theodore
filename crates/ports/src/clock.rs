//! Clock port: real in the app, controlled in fixtures and tests.

use std::time::Duration;

use async_trait::async_trait;
use theodore_domain::Millis;

#[async_trait]
pub trait Clock: Send + Sync {
    fn now(&self) -> Millis;
    async fn sleep(&self, d: Duration);
}

pub struct SystemClock;

#[async_trait]
impl Clock for SystemClock {
    fn now(&self) -> Millis {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or_default()
    }
    async fn sleep(&self, d: Duration) {
        tokio::time::sleep(d).await
    }
}
