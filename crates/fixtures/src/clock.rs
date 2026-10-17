//! Manual clock for controlled time in tests.

use async_trait::async_trait;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use theodore_domain::Millis;
use theodore_ports::Clock;

/// Controlled clock: `now()` returns a value, `advance()` moves time forward.
/// `sleep()` resolves when advanced past its target.
#[derive(Debug, Clone)]
pub struct ManualClock {
    state: Arc<Mutex<ClockState>>,
}

#[derive(Debug)]
struct ClockState {
    now_ms: Millis,
    sleepers: Vec<(Millis, tokio::sync::mpsc::Sender<()>)>,
}

impl ManualClock {
    /// Create a new clock at the given milliseconds since epoch.
    pub fn new(now_ms: Millis) -> Self {
        Self {
            state: Arc::new(Mutex::new(ClockState {
                now_ms,
                sleepers: Vec::new(),
            })),
        }
    }

    /// Advance time by `delta_ms` milliseconds. Wakes all sleepers whose deadline passed.
    pub fn advance(&self, delta_ms: Millis) {
        let mut state = self.state.lock().unwrap();
        state.now_ms += delta_ms;
        let now = state.now_ms;
        state.sleepers.retain(|(deadline, tx)| {
            if now >= *deadline {
                let _ = tx.try_send(());
                false
            } else {
                true
            }
        });
    }

    /// Return current time as milliseconds since epoch.
    pub fn now_ms(&self) -> Millis {
        self.state.lock().unwrap().now_ms
    }
}

#[async_trait]
impl Clock for ManualClock {
    fn now(&self) -> Millis {
        self.state.lock().unwrap().now_ms
    }

    async fn sleep(&self, d: Duration) {
        let deadline = self.now() + d.as_millis() as Millis;
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);

        {
            let mut state = self.state.lock().unwrap();
            if state.now_ms >= deadline {
                return;
            }
            state.sleepers.push((deadline, tx));
        }

        let _ = rx.recv().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clock_now() {
        let clock = ManualClock::new(1000);
        assert_eq!(clock.now(), 1000);
    }

    #[test]
    fn test_clock_advance() {
        let clock = ManualClock::new(1000);
        clock.advance(500);
        assert_eq!(clock.now(), 1500);
    }

    #[tokio::test]
    async fn test_clock_sleep_resolves_when_advanced() {
        let clock = ManualClock::new(0);
        let clock_advance = clock.clone();

        let sleep_task = tokio::spawn(async move {
            clock.sleep(Duration::from_millis(100)).await;
        });

        tokio::time::sleep(Duration::from_millis(10)).await;
        clock_advance.advance(50);
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(!sleep_task.is_finished());

        clock_advance.advance(50);
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(sleep_task.is_finished());
    }

    #[tokio::test]
    async fn test_clock_sleep_completes_immediately_if_time_passed() {
        // `sleep` computes `deadline = now() + d`, so the only way the
        // deadline is already due is `d == 0`. This must resolve without
        // registering a sleeper that nothing will ever wake.
        let clock = ManualClock::new(100);
        clock.sleep(Duration::from_millis(0)).await;
    }
}
