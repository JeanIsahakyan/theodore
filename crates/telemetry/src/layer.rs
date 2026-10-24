//! The `tracing` layer: turns each event (and the fields of the spans it
//! happened in) into one `Record`, redacts it once, and hands it to the
//! sinks that accept it.
//!
//! ```text
//! tracing event ─▶ Record{fields ∪ span fields, op_id, kind} ─▶ Redactor::local
//!     ─┬─▶ local sinks (file, stderr)
//!      ├─▶ OTLP     if sink::otlp_accepts    (and "Send error reports" is on)
//!      └─▶ PostHog  if sink::posthog_accepts (and "Share usage data" is on)
//! ```

use std::sync::{Arc, RwLock};

use serde_json::{Map, Value};
use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::registry::LookupSpan;

use crate::otlp::{OtelSpan, OtlpSink};
use crate::posthog::PosthogSink;
use crate::record::{Kind, Record, TraceRef, now_ms};
use crate::redact::Redactor;
use crate::sink::{self, Sink};

/// Root spans exported as traces: an IPC command (`op`), and background
/// work that runs outside one. A span field `trace = false` opts out (the
/// chatty commands); children of an exported span are exported.
const TRACE_ROOTS: &[&str] = &["op", "grouping", "agent_run", "outbox_item", "space_turn"];

pub struct Shared {
    pub redactor: Redactor,
    pub local: Vec<Arc<dyn Sink>>,
    pub otlp: RwLock<Option<Arc<OtlpSink>>>,
    pub posthog: RwLock<Option<Arc<PosthogSink>>>,
}

impl Shared {
    pub fn new(redactor: Redactor, local: Vec<Arc<dyn Sink>>) -> Self {
        Self {
            redactor,
            local,
            otlp: RwLock::new(None),
            posthog: RwLock::new(None),
        }
    }

    pub fn otlp(&self) -> Option<Arc<OtlpSink>> {
        self.otlp.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn posthog(&self) -> Option<Arc<PosthogSink>> {
        self.posthog
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    pub fn dispatch(&self, r: &Record) {
        for s in &self.local {
            s.write(r);
        }
        if sink::otlp_accepts(r)
            && let Some(o) = self.otlp()
        {
            o.write(r);
        }
        if sink::posthog_accepts(r)
            && let Some(p) = self.posthog()
        {
            p.write(r);
        }
    }
}

pub struct TelemetryLayer {
    shared: Arc<Shared>,
}

impl TelemetryLayer {
    pub fn new(shared: Arc<Shared>) -> Self {
        Self { shared }
    }
}

/// A span's fields, as recorded.
struct SpanFields(Map<String, Value>);

#[derive(Default)]
struct JsonVisitor(Map<String, Value>);

impl Visit for JsonVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.0
            .insert(field.name().into(), Value::String(value.into()));
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.0.insert(field.name().into(), value.into());
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.0.insert(field.name().into(), value.into());
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.0.insert(field.name().into(), value.into());
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.0.insert(field.name().into(), value.into());
    }
    fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static)) {
        let mut s = value.to_string();
        let mut src = value.source();
        while let Some(e) = src {
            s.push_str(": ");
            s.push_str(&e.to_string());
            src = e.source();
        }
        self.0.insert(field.name().into(), Value::String(s));
    }
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.0
            .insert(field.name().into(), Value::String(format!("{value:?}")));
    }
}

fn exported_root(name: &str, target: &str, fields: &Map<String, Value>) -> bool {
    TRACE_ROOTS.contains(&name)
        && sink::is_own_target(target)
        && fields.get("trace").and_then(Value::as_bool) != Some(false)
}

impl<S> tracing_subscriber::Layer<S> for TelemetryLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(id) else { return };
        let mut v = JsonVisitor::default();
        attrs.record(&mut v);
        let fields = v.0;
        let otel = self.shared.otlp().and_then(|o| {
            let meta = span.metadata();
            if *meta.level() > tracing::Level::INFO {
                return None;
            }
            let parent = span
                .parent()
                .and_then(|p| p.extensions().get::<OtelSpan>().map(|s| s.cx.clone()));
            let export = parent.is_some() || exported_root(meta.name(), meta.target(), &fields);
            export.then(|| {
                let mut attrs = fields.clone();
                attrs.remove("trace");
                o.start_span(meta.name(), &attrs, parent.as_ref())
            })
        });
        let mut ext = span.extensions_mut();
        ext.insert(SpanFields(fields));
        if let Some(o) = otel {
            ext.insert(o);
        }
    }

    fn on_record(&self, id: &Id, values: &tracing::span::Record<'_>, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(id) else { return };
        let mut v = JsonVisitor::default();
        values.record(&mut v);
        let mut ext = span.extensions_mut();
        if let Some(o) = ext.get_mut::<OtelSpan>()
            && let Some(sink) = self.shared.otlp()
        {
            use opentelemetry::trace::Span as _;
            for kv in sink.attributes(&v.0) {
                o.span.set_attribute(kv);
            }
        }
        if let Some(f) = ext.get_mut::<SpanFields>() {
            f.0.extend(v.0);
        }
    }

    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        let meta = event.metadata();
        let mut v = JsonVisitor::default();
        event.record(&mut v);
        let mut own = v.0;
        let message = match own.remove("message") {
            Some(Value::String(s)) => s,
            Some(other) => other.to_string(),
            None => String::new(),
        };
        let kind = own
            .remove("kind")
            .and_then(|k| k.as_str().map(Kind::parse))
            .unwrap_or(Kind::Log);
        if kind == Kind::Product
            && let Some(Value::String(p)) = own.remove("props")
            && let Ok(Value::Object(m)) = serde_json::from_str::<Value>(&p)
        {
            own.extend(m);
        }

        let mut fields = Map::new();
        let mut spans = Vec::new();
        let mut trace = None;
        if let Some(scope) = ctx.event_scope(event) {
            for span in scope.from_root() {
                spans.push(span.name().to_string());
                let ext = span.extensions();
                if let Some(f) = ext.get::<SpanFields>() {
                    for (k, v) in &f.0 {
                        // A product event carries its own fields only (its
                        // span's PR, repo… never reach PostHog); the op id
                        // still ties it to the command in the local log.
                        if kind != Kind::Product || k == "op_id" {
                            fields.insert(k.clone(), v.clone());
                        }
                    }
                }
                if let Some(o) = ext.get::<OtelSpan>() {
                    trace = Some(TraceRef {
                        trace_id: o.cx.trace_id().to_bytes(),
                        span_id: o.cx.span_id().to_bytes(),
                    });
                }
            }
        }
        fields.remove("trace");
        fields.extend(own);

        let mut rec = Record {
            ts_ms: now_ms(),
            level: *meta.level(),
            target: meta.target().to_string(),
            kind,
            message,
            fields,
            spans,
            trace,
        };
        self.shared.redactor.local(&mut rec);
        self.shared.dispatch(&rec);
    }

    fn on_close(&self, id: Id, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(&id) else { return };
        if let Some(mut o) = span.extensions_mut().remove::<OtelSpan>() {
            use opentelemetry::trace::Span as _;
            o.span.end();
        }
    }
}

/// A sink that keeps every record it gets, for tests.
#[derive(Default)]
pub struct Capture(pub std::sync::Mutex<Vec<Record>>);

impl Capture {
    pub fn records(&self) -> Vec<Record> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

impl Sink for Capture {
    fn write(&self, record: &Record) {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(record.clone());
    }
    fn flush(&self, _timeout: std::time::Duration) {}
}

/// A subscriber over `Capture`, with a redactor whose home is `/Users/jo`.
pub fn capture() -> (Arc<Capture>, Arc<Shared>, impl Subscriber + Send + Sync) {
    use tracing_subscriber::layer::SubscriberExt as _;
    let cap = Arc::new(Capture::default());
    let shared = Arc::new(Shared::new(
        Redactor::new(Some("/Users/jo".into()), "test"),
        vec![cap.clone() as Arc<dyn Sink>],
    ));
    let sub = tracing_subscriber::registry().with(TelemetryLayer::new(shared.clone()));
    (cap, shared, sub)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product::ProductEvent;

    #[test]
    fn a_record_carries_its_spans_fields_and_the_op_id() {
        let (cap, _, sub) = capture();
        tracing::subscriber::with_default(sub, || {
            let op = tracing::info_span!("op", op_id = "op-123", cmd = "regroup");
            let _g = op.enter();
            let inner = tracing::info_span!("grouping", pr = "acme/app#1");
            let _i = inner.enter();
            tracing::warn!(
                error.code = "grouping.invalid_output",
                attempt = 2,
                "grouping failed"
            );
        });
        let recs = cap.records();
        assert_eq!(recs.len(), 1);
        let r = &recs[0];
        assert_eq!(r.op_id(), Some("op-123"));
        assert_eq!(r.field_str("cmd"), Some("regroup"));
        assert_eq!(r.field_str("pr"), Some("acme/app#1"));
        assert_eq!(r.field_str("error.code"), Some("grouping.invalid_output"));
        assert_eq!(r.fields["attempt"], 2);
        assert_eq!(r.spans, ["op", "grouping"]);
        assert_eq!(r.message, "grouping failed");
        assert_eq!(r.kind, Kind::Log);
    }

    #[test]
    fn records_are_redacted_before_any_sink() {
        let (cap, _, sub) = capture();
        tracing::subscriber::with_default(sub, || {
            tracing::error!(
                token = "anything",
                path = "/Users/jo/.theodore/x",
                "failed with ghp_abcdefghijklmnopqrstuvwxyz0123"
            );
        });
        let r = &cap.records()[0];
        assert_eq!(r.fields["token"], crate::redact::REDACTED);
        assert_eq!(r.fields["path"], "~/.theodore/x");
        assert_eq!(r.message, "failed with [redacted:github]");
    }

    #[test]
    fn product_events_carry_their_own_fields_only() {
        let (cap, _, sub) = capture();
        tracing::subscriber::with_default(sub, || {
            let op = tracing::info_span!("op", op_id = "op-9", pr = "acme/app#1");
            let _g = op.enter();
            ProductEvent::PrOpened {
                host: "github".into(),
            }
            .emit();
        });
        let r = &cap.records()[0];
        assert_eq!(r.kind, Kind::Product);
        assert_eq!(r.target, crate::product::TARGET);
        assert_eq!(r.field_str("event"), Some("pr_opened"));
        assert_eq!(r.field_str("host"), Some("github"));
        assert_eq!(r.op_id(), Some("op-9"));
        assert!(!r.fields.contains_key("pr"));
        assert!(!r.fields.contains_key("props"));
    }
}
