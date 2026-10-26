//! Readable stderr output for development (`cargo run`, `THEODORE_LOG_STDERR=1`):
//! the same redacted records as the file, one line each.

use std::io::Write;
use std::time::Duration;

use crate::record::{Kind, Record, level_str};
use crate::sink::Sink;

pub struct StderrSink;

pub fn format(r: &Record) -> String {
    let time = chrono::DateTime::from_timestamp_millis(r.ts_ms)
        .unwrap_or_default()
        .format("%H:%M:%S%.3f");
    let mut line = format!(
        "{time} {:>5} {}: {}",
        level_str(r.level).to_ascii_uppercase(),
        r.target,
        r.message
    );
    if r.kind != Kind::Log {
        line.push_str(&format!(" kind={}", r.kind.as_str()));
    }
    for (k, v) in &r.fields {
        match v {
            serde_json::Value::String(s) => line.push_str(&format!(" {k}={s}")),
            other => line.push_str(&format!(" {k}={other}")),
        }
    }
    line
}

impl Sink for StderrSink {
    fn write(&self, record: &Record) {
        let _ = writeln!(std::io::stderr().lock(), "{}", format(record));
    }

    fn flush(&self, _timeout: Duration) {
        let _ = std::io::stderr().flush();
    }
}
