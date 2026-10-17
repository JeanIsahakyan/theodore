//! Event-based snooze (plan §5.3 / M5).

use crate::model::{Millis, SnoozeUntil};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrEvent {
    Pushed,
    ChecksGreen,
    Tick(Millis),
}

/// Does `event` wake a PR snoozed with `until`?
pub fn wakes(until: &SnoozeUntil, event: &PrEvent) -> bool {
    let _ = (until, event);
    todo!("domain slice")
}
