//! Event-based snooze (plan §5.3 / M5).

use crate::model::{Millis, SnoozeUntil};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrEvent {
    Pushed,
    ChecksGreen,
    Tick(Millis),
}

/// Does `event` wake a PR snoozed with `until`? A `Time` snooze wakes on a
/// `Tick` at or after `until.at`; `NextPush`/`ChecksGreen` wake only on their
/// matching event — a tick never wakes them, and a push never wakes a
/// `ChecksGreen` snooze or vice versa.
pub fn wakes(until: &SnoozeUntil, event: &PrEvent) -> bool {
    match (until, event) {
        (SnoozeUntil::Time { at }, PrEvent::Tick(now)) => *now >= *at,
        (SnoozeUntil::NextPush, PrEvent::Pushed) => true,
        (SnoozeUntil::ChecksGreen, PrEvent::ChecksGreen) => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_wakes_exactly_at_the_deadline() {
        let until = SnoozeUntil::Time { at: 1000 };
        assert!(wakes(&until, &PrEvent::Tick(1000)));
    }

    #[test]
    fn time_wakes_after_the_deadline() {
        let until = SnoozeUntil::Time { at: 1000 };
        assert!(wakes(&until, &PrEvent::Tick(1001)));
    }

    #[test]
    fn time_does_not_wake_before_the_deadline() {
        let until = SnoozeUntil::Time { at: 1000 };
        assert!(!wakes(&until, &PrEvent::Tick(999)));
    }

    #[test]
    fn time_is_not_woken_by_push_or_checks() {
        let until = SnoozeUntil::Time { at: 1000 };
        assert!(!wakes(&until, &PrEvent::Pushed));
        assert!(!wakes(&until, &PrEvent::ChecksGreen));
    }

    #[test]
    fn next_push_wakes_on_push_only() {
        assert!(wakes(&SnoozeUntil::NextPush, &PrEvent::Pushed));
        assert!(!wakes(&SnoozeUntil::NextPush, &PrEvent::ChecksGreen));
        assert!(!wakes(&SnoozeUntil::NextPush, &PrEvent::Tick(i64::MAX)));
    }

    #[test]
    fn checks_green_wakes_on_checks_green_only() {
        assert!(wakes(&SnoozeUntil::ChecksGreen, &PrEvent::ChecksGreen));
        assert!(!wakes(&SnoozeUntil::ChecksGreen, &PrEvent::Pushed));
        assert!(!wakes(&SnoozeUntil::ChecksGreen, &PrEvent::Tick(i64::MAX)));
    }
}
