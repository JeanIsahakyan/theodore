//! UI errors and events forwarded by `log_client`: deduped and
//! rate-limited here too (the UI does the same), then logged as
//! `kind="client"` records on `theodore::client`.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use theodore_contract::{ClientLog, ClientLogLevel};

pub const TARGET: &str = "theodore::client";
/// The same entry again within this window is counted, not logged.
pub const DEDUPE_WINDOW: Duration = Duration::from_secs(60);
/// At most this many entries per minute.
pub const PER_MINUTE: usize = 30;

/// Dedupe + rate limit, on an injectable clock.
pub struct Limiter {
    seen: HashMap<String, (Instant, u64)>,
    recent: std::collections::VecDeque<Instant>,
}

/// What to do with one entry.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Log it; `repeats` earlier copies were dropped since the last one.
    Log {
        repeats: u64,
    },
    Drop,
}

impl Default for Limiter {
    fn default() -> Self {
        Self::new()
    }
}

impl Limiter {
    pub fn new() -> Self {
        Self {
            seen: HashMap::new(),
            recent: Default::default(),
        }
    }

    pub fn check(&mut self, key: &str, now: Instant) -> Verdict {
        self.seen
            .retain(|_, (at, _)| now.duration_since(*at) < DEDUPE_WINDOW * 2);
        if let Some((at, repeats)) = self.seen.get_mut(key)
            && now.duration_since(*at) < DEDUPE_WINDOW
        {
            *repeats += 1;
            return Verdict::Drop;
        }
        while self
            .recent
            .front()
            .is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(60))
        {
            self.recent.pop_front();
        }
        if self.recent.len() >= PER_MINUTE {
            return Verdict::Drop;
        }
        self.recent.push_back(now);
        let repeats = self.seen.get(key).map(|(_, r)| *r).unwrap_or(0);
        self.seen.insert(key.to_string(), (now, 0));
        Verdict::Log { repeats }
    }
}

static LIMITER: LazyLock<Mutex<Limiter>> = LazyLock::new(|| Mutex::new(Limiter::new()));

/// The error code for a UI error by where it came from.
pub fn code_for(source: &str) -> &'static str {
    match source {
        "onerror" => "ui.uncaught",
        "unhandledrejection" => "ui.unhandled_rejection",
        "boundary" => "ui.render_crash",
        _ => "ui.error",
    }
}

fn key(e: &ClientLog) -> String {
    let msg: String = e.message.chars().take(200).collect();
    format!("{:?}\0{}\0{msg}", e.level, e.source)
}

/// Logs `entry` unless it's a repeat or over the rate limit.
pub fn log(entry: &ClientLog) {
    let verdict = LIMITER
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .check(&key(entry), Instant::now());
    if let Verdict::Log { repeats } = verdict {
        emit(entry, repeats);
    }
}

/// Emits `entry` as a record (no limiting).
pub fn emit(e: &ClientLog, repeats: u64) {
    let source: &str = match e.source.as_str() {
        s @ ("onerror" | "unhandledrejection" | "boundary" | "console") => s,
        _ => "other",
    };
    // `None` records nothing, so the `log_client` command's own op id (from
    // its span) stays unless the UI names the failed command's.
    let stack = e.stack.as_deref();
    let component_stack = e.component_stack.as_deref();
    let op_id = e.op_id.as_deref().filter(|s| !s.is_empty());
    let route = e.route.as_deref();
    macro_rules! ev {
        ($lvl:ident, $code:expr) => {
            tracing::$lvl!(
                target: TARGET,
                kind = "client",
                error.code = $code,
                client.source = source,
                stack,
                component_stack,
                op_id,
                route,
                repeats,
                "{}",
                e.message
            )
        };
    }
    match e.level {
        ClientLogLevel::Error => ev!(error, code_for(source)),
        ClientLogLevel::Warn => ev!(warn, code_for(source)),
        ClientLogLevel::Info => ev!(info, ""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(msg: &str) -> ClientLog {
        ClientLog {
            level: ClientLogLevel::Error,
            source: "onerror".into(),
            message: msg.into(),
            stack: Some("at App (index.js:1:2)".into()),
            component_stack: None,
            op_id: Some("op-1".into()),
            route: Some("review".into()),
        }
    }

    #[test]
    fn repeats_are_dropped_then_counted_on_the_next_one() {
        let mut l = Limiter::new();
        let t0 = Instant::now();
        assert_eq!(l.check("a", t0), Verdict::Log { repeats: 0 });
        assert_eq!(l.check("a", t0 + Duration::from_secs(1)), Verdict::Drop);
        assert_eq!(l.check("a", t0 + Duration::from_secs(2)), Verdict::Drop);
        assert_eq!(
            l.check("b", t0 + Duration::from_secs(2)),
            Verdict::Log { repeats: 0 }
        );
        assert_eq!(
            l.check("a", t0 + DEDUPE_WINDOW + Duration::from_secs(1)),
            Verdict::Log { repeats: 2 }
        );
    }

    #[test]
    fn at_most_thirty_a_minute() {
        let mut l = Limiter::new();
        let t0 = Instant::now();
        let logged = (0..100)
            .filter(|i| l.check(&format!("k{i}"), t0) != Verdict::Drop)
            .count();
        assert_eq!(logged, PER_MINUTE);
        assert_ne!(
            l.check("later", t0 + Duration::from_secs(61)),
            Verdict::Drop
        );
    }

    #[test]
    fn a_ui_error_becomes_a_client_record_with_a_code() {
        let (cap, _, sub) = crate::layer::capture();
        tracing::subscriber::with_default(sub, || emit(&entry("x is undefined"), 3));
        let r = &cap.records()[0];
        assert_eq!(r.kind, crate::record::Kind::Client);
        assert_eq!(r.level, tracing::Level::ERROR);
        assert_eq!(r.field_str("error.code"), Some("ui.uncaught"));
        assert_eq!(r.op_id(), Some("op-1"));
        assert_eq!(r.field_str("route"), Some("review"));
        assert_eq!(r.fields["repeats"], 3);
        assert_eq!(r.message, "x is undefined");
    }
}
