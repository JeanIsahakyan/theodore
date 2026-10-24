//! Sinks and what each may receive (docs/telemetry.md "Where records go"):
//!
//! | sink    | levels           | kinds                      |
//! |---------|------------------|----------------------------|
//! | file    | what the filter lets through (default info+) | all |
//! | stderr  | same as the file | all                        |
//! | OTLP    | warn, error      | log, panic, client         |
//! | PostHog | info             | product only               |
//!
//! Debug and trace never leave the machine.

use std::time::Duration;

use tracing::Level;

use crate::record::{Kind, Record};

pub trait Sink: Send + Sync {
    /// Takes an already-redacted record. Must not block: a full queue
    /// drops the record.
    fn write(&self, record: &Record);
    /// Sends or writes what's queued, waiting at most `timeout`.
    fn flush(&self, timeout: Duration);
}

/// Our own crates, the panic hook, the UI and product events. Third-party
/// targets (the HTTP stack, the exporter itself) never go remote: an
/// exporter logging its own failures must not feed itself.
pub fn is_own_target(target: &str) -> bool {
    target.starts_with("theodore")
}

pub fn otlp_accepts(r: &Record) -> bool {
    r.level <= Level::WARN
        && matches!(r.kind, Kind::Log | Kind::Panic | Kind::Client)
        && is_own_target(&r.target)
}

pub fn posthog_accepts(r: &Record) -> bool {
    r.kind == Kind::Product && r.level <= Level::INFO && r.target == crate::product::TARGET
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(level: Level, kind: Kind, target: &str) -> Record {
        Record::new(level, target, "m").with_kind(kind)
    }

    #[test]
    fn debug_never_reaches_a_remote_sink() {
        for kind in [Kind::Log, Kind::Product, Kind::Panic, Kind::Client] {
            for level in [Level::DEBUG, Level::TRACE] {
                let r = rec(level, kind, crate::product::TARGET);
                assert!(
                    !otlp_accepts(&r) && !posthog_accepts(&r),
                    "{level} {kind:?}"
                );
            }
        }
    }

    #[test]
    fn product_events_go_only_to_posthog() {
        let p = rec(Level::INFO, Kind::Product, crate::product::TARGET);
        assert!(posthog_accepts(&p));
        assert!(!otlp_accepts(&p));
        // A warn-level product record still isn't an error report.
        assert!(!otlp_accepts(&rec(
            Level::WARN,
            Kind::Product,
            crate::product::TARGET
        )));
        // An ordinary record never becomes a product event.
        assert!(!posthog_accepts(&rec(
            Level::INFO,
            Kind::Log,
            crate::product::TARGET
        )));
        assert!(!posthog_accepts(&rec(
            Level::INFO,
            Kind::Product,
            "theodore_app"
        )));
    }

    #[test]
    fn warnings_and_errors_go_to_otlp() {
        for kind in [Kind::Log, Kind::Panic, Kind::Client] {
            assert!(otlp_accepts(&rec(
                Level::WARN,
                kind,
                "theodore_app::outbox"
            )));
            assert!(otlp_accepts(&rec(Level::ERROR, kind, "theodore::panic")));
            assert!(!otlp_accepts(&rec(Level::INFO, kind, "theodore_app")));
            assert!(!posthog_accepts(&rec(Level::ERROR, kind, "theodore_app")));
        }
        // Third-party crates stay local.
        assert!(!otlp_accepts(&rec(
            Level::ERROR,
            Kind::Log,
            "opentelemetry_sdk"
        )));
        assert!(!otlp_accepts(&rec(
            Level::WARN,
            Kind::Log,
            "hyper_util::client"
        )));
    }
}
