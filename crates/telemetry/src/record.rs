//! One log record: what the layer builds from a `tracing` event (plus the
//! fields of the spans around it) and hands, redacted, to every sink.

use serde_json::{Map, Value};
use tracing::Level;

/// What a record is, which decides the sinks it may reach.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// An ordinary log line.
    Log,
    /// A typed product event (`ProductEvent`): the only kind PostHog sees.
    Product,
    /// A Rust panic (`panic::install`).
    Panic,
    /// An error or event the UI forwarded (`log_client`).
    Client,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Log => "log",
            Kind::Product => "product",
            Kind::Panic => "panic",
            Kind::Client => "client",
        }
    }

    pub fn parse(s: &str) -> Kind {
        match s {
            "product" => Kind::Product,
            "panic" => Kind::Panic,
            "client" => Kind::Client,
            _ => Kind::Log,
        }
    }
}

/// The OTel span a record happened in, for log ↔ trace correlation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TraceRef {
    pub trace_id: [u8; 16],
    pub span_id: [u8; 8],
}

#[derive(Debug, Clone, PartialEq)]
pub struct Record {
    /// Unix milliseconds.
    pub ts_ms: i64,
    pub level: Level,
    pub target: String,
    pub kind: Kind,
    pub message: String,
    /// Event fields over the fields of its spans (root first, the event's
    /// own win). Never contains `message` or `kind`.
    pub fields: Map<String, Value>,
    /// Span names, root first.
    pub spans: Vec<String>,
    pub trace: Option<TraceRef>,
}

/// Keys the JSON line itself uses; a field with one of these names is
/// written as `field.<name>` instead.
const RESERVED: &[&str] = &["ts", "level", "target", "kind", "msg", "spans"];

pub fn level_str(level: Level) -> &'static str {
    match level {
        Level::ERROR => "error",
        Level::WARN => "warn",
        Level::INFO => "info",
        Level::DEBUG => "debug",
        Level::TRACE => "trace",
    }
}

pub fn parse_level(s: &str) -> Option<Level> {
    match s.trim().to_ascii_lowercase().as_str() {
        "error" => Some(Level::ERROR),
        "warn" | "warning" => Some(Level::WARN),
        "info" => Some(Level::INFO),
        "debug" => Some(Level::DEBUG),
        "trace" => Some(Level::TRACE),
        _ => None,
    }
}

impl Record {
    pub fn new(level: Level, target: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            ts_ms: now_ms(),
            level,
            target: target.into(),
            kind: Kind::Log,
            message: message.into(),
            fields: Map::new(),
            spans: Vec::new(),
            trace: None,
        }
    }

    pub fn with_kind(mut self, kind: Kind) -> Self {
        self.kind = kind;
        self
    }

    pub fn with_field(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.fields.insert(key.to_string(), value.into());
        self
    }

    pub fn field_str(&self, key: &str) -> Option<&str> {
        self.fields.get(key).and_then(Value::as_str)
    }

    /// The operation id (`op_id`) this record belongs to, if any.
    pub fn op_id(&self) -> Option<&str> {
        self.field_str("op_id")
    }

    /// ISO 8601 UTC with milliseconds.
    pub fn ts_iso(&self) -> String {
        chrono::DateTime::from_timestamp_millis(self.ts_ms)
            .unwrap_or_default()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string()
    }

    /// One JSON line (no trailing newline): `ts`, `level`, `target`,
    /// `kind`, `msg`, `spans`, then the fields flattened.
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("ts".into(), Value::String(self.ts_iso()));
        out.insert("level".into(), Value::String(level_str(self.level).into()));
        out.insert("target".into(), Value::String(self.target.clone()));
        out.insert("kind".into(), Value::String(self.kind.as_str().into()));
        out.insert("msg".into(), Value::String(self.message.clone()));
        if !self.spans.is_empty() {
            out.insert("spans".into(), Value::String(self.spans.join(">")));
        }
        for (k, v) in &self.fields {
            let key = if RESERVED.contains(&k.as_str()) {
                format!("field.{k}")
            } else {
                k.clone()
            };
            out.insert(key, v.clone());
        }
        Value::Object(out)
    }

    pub fn to_line(&self) -> String {
        self.to_json().to_string()
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_json_line_flattens_fields_and_keeps_reserved_keys() {
        let mut r = Record::new(Level::WARN, "theodore_app::outbox", "gave up")
            .with_field("error.code", "outbox.gave_up")
            .with_field("level", "shadowed");
        r.ts_ms = 0;
        r.spans = vec!["ipc".into(), "outbox".into()];
        let v = r.to_json();
        assert_eq!(v["ts"], "1970-01-01T00:00:00.000Z");
        assert_eq!(v["level"], "warn");
        assert_eq!(v["kind"], "log");
        assert_eq!(v["msg"], "gave up");
        assert_eq!(v["spans"], "ipc>outbox");
        assert_eq!(v["error.code"], "outbox.gave_up");
        assert_eq!(v["field.level"], "shadowed");
    }
}
