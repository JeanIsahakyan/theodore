//! A panic hook: logs the panic (message, location, backtrace — all
//! redacted like any record) to the file and, when error reports are on,
//! to OTLP, flushes, then runs the previous hook.

use std::time::Duration;

pub const TARGET: &str = "theodore::panic";

static INSTALLED: std::sync::Once = std::sync::Once::new();

/// Installs the hook once per process.
pub fn install() {
    INSTALLED.call_once(|| {
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            record(info);
            if let Some(t) = crate::global() {
                t.flush(Duration::from_secs(2));
            }
            prev(info);
        }));
    });
}

fn record(info: &std::panic::PanicHookInfo<'_>) {
    let message = info
        .payload()
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| info.payload().downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "panic".to_string());
    let location = info
        .location()
        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
        .unwrap_or_default();
    let thread = std::thread::current()
        .name()
        .unwrap_or("unnamed")
        .to_string();
    let backtrace = std::backtrace::Backtrace::force_capture().to_string();
    tracing::error!(
        target: TARGET,
        kind = "panic",
        error.code = "panic",
        location,
        thread,
        backtrace,
        "panic: {message}"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_panic_writes_a_record_with_its_location() {
        install();
        let (cap, _, sub) = crate::layer::capture();
        tracing::subscriber::with_default(sub, || {
            let r = std::panic::catch_unwind(|| panic!("boom at ghp_abcdefghijklmnopqrstuvwxyz"));
            assert!(r.is_err());
        });
        let recs = cap.records();
        let r = recs
            .iter()
            .find(|r| r.target == TARGET)
            .expect("a panic record");
        assert_eq!(r.kind, crate::record::Kind::Panic);
        assert_eq!(r.level, tracing::Level::ERROR);
        assert_eq!(r.field_str("error.code"), Some("panic"));
        assert!(r.message.starts_with("panic: boom at [redacted:github]"));
        assert!(
            r.field_str("location").unwrap().contains("panic.rs"),
            "{:?}",
            r.fields
        );
        assert!(r.fields.contains_key("backtrace"));
        assert!(crate::sink::otlp_accepts(r));
    }
}
