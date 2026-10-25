//! Error reports over OTLP/HTTP (protobuf): warn/error logs and traces,
//! e.g. to New Relic (`https://otlp.nr-data.net`, header `api-key`).
//!
//! Spans are bridged by `layer` rather than `tracing-opentelemetry`, which
//! would export span fields as they are: here every attribute goes
//! through the same redaction as the logs. The SDK's batch processors run
//! on their own threads with bounded queues (a full queue drops), so
//! nothing here blocks a caller.

use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use opentelemetry::logs::{AnyValue, LogRecord as _, Logger as _, LoggerProvider as _, Severity};
use opentelemetry::trace::{
    Span as _, SpanContext, SpanKind, TraceContextExt as _, TraceFlags, Tracer as _,
    TracerProvider as _,
};
use opentelemetry::{Context, KeyValue};
use opentelemetry_otlp::{Protocol, WithExportConfig as _, WithHttpConfig as _};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::logs::{BatchLogProcessor, SdkLogger, SdkLoggerProvider};
use opentelemetry_sdk::trace::{BatchSpanProcessor, SdkTracer, SdkTracerProvider};
use serde_json::{Map, Value};
use tracing::Level;

use crate::AppMeta;
use crate::record::Record;
use crate::redact::Redactor;
use crate::sink::Sink;

#[derive(Debug, Clone, PartialEq)]
pub struct OtlpConfig {
    /// The OTLP/HTTP base URL; `/v1/logs` and `/v1/traces` are appended.
    pub endpoint: url::Url,
    /// Sent with every export, e.g. `api-key`.
    pub headers: Vec<(String, String)>,
    pub timeout: Duration,
    pub queue: usize,
    pub delay: Duration,
}

impl OtlpConfig {
    pub fn new(endpoint: url::Url, headers: Vec<(String, String)>) -> Self {
        Self {
            endpoint,
            headers,
            timeout: Duration::from_secs(10),
            queue: 2048,
            delay: Duration::from_secs(5),
        }
    }

    fn signal(&self, path: &str) -> String {
        format!("{}/v1/{path}", self.endpoint.as_str().trim_end_matches('/'))
    }
}

/// `k=v,k2=v2` (the `OTEL_EXPORTER_OTLP_HEADERS` format).
pub fn parse_headers(s: &str) -> Vec<(String, String)> {
    s.split(',')
        .filter_map(|kv| {
            let (k, v) = kv.split_once('=')?;
            let (k, v) = (k.trim(), v.trim());
            (!k.is_empty()).then(|| (k.to_string(), v.to_string()))
        })
        .collect()
}

pub struct OtlpSink {
    logs: SdkLoggerProvider,
    logger: SdkLogger,
    traces: SdkTracerProvider,
    tracer: SdkTracer,
    redactor: Redactor,
}

/// An exported span, kept in the `tracing` span's extensions until it
/// closes.
pub struct OtelSpan {
    pub span: opentelemetry_sdk::trace::Span,
    pub cx: SpanContext,
}

fn resource(meta: &AppMeta) -> Resource {
    Resource::builder_empty()
        .with_service_name("theodore")
        .with_attributes([
            KeyValue::new("service.version", meta.version.clone()),
            KeyValue::new("service.instance.id", meta.install_id.clone()),
            KeyValue::new("deployment.environment.name", meta.build_env.clone()),
            KeyValue::new("theodore.update_channel", meta.channel.clone()),
            KeyValue::new("os.type", meta.os.clone()),
            KeyValue::new("vcs.ref.head.revision", meta.commit.clone()),
        ])
        .build()
}

impl OtlpSink {
    pub fn start(cfg: &OtlpConfig, meta: &AppMeta, redactor: Redactor) -> Result<Self, String> {
        let headers: HashMap<String, String> = cfg.headers.iter().cloned().collect();
        let log_exporter = opentelemetry_otlp::LogExporter::builder()
            .with_http()
            .with_protocol(Protocol::HttpBinary)
            .with_endpoint(cfg.signal("logs"))
            .with_timeout(cfg.timeout)
            .with_headers(headers.clone())
            .build()
            .map_err(|e| e.to_string())?;
        let span_exporter = opentelemetry_otlp::SpanExporter::builder()
            .with_http()
            .with_protocol(Protocol::HttpBinary)
            .with_endpoint(cfg.signal("traces"))
            .with_timeout(cfg.timeout)
            .with_headers(headers)
            .build()
            .map_err(|e| e.to_string())?;
        let logs = SdkLoggerProvider::builder()
            .with_resource(resource(meta))
            .with_log_processor(
                BatchLogProcessor::builder(log_exporter)
                    .with_batch_config(
                        opentelemetry_sdk::logs::BatchConfigBuilder::default()
                            .with_max_queue_size(cfg.queue)
                            .with_scheduled_delay(cfg.delay)
                            .build(),
                    )
                    .build(),
            )
            .build();
        let traces = SdkTracerProvider::builder()
            .with_resource(resource(meta))
            .with_span_processor(
                BatchSpanProcessor::builder(span_exporter)
                    .with_batch_config(
                        opentelemetry_sdk::trace::BatchConfigBuilder::default()
                            .with_max_queue_size(cfg.queue)
                            .with_scheduled_delay(cfg.delay)
                            .build(),
                    )
                    .build(),
            )
            .build();
        Ok(Self {
            logger: logs.logger("theodore"),
            logs,
            tracer: traces.tracer("theodore"),
            traces,
            redactor,
        })
    }

    /// Starts an exported span with redacted attributes, under `parent`.
    pub fn start_span(
        &self,
        name: &'static str,
        fields: &Map<String, Value>,
        parent: Option<&SpanContext>,
    ) -> OtelSpan {
        let parent_cx = match parent {
            Some(p) => Context::new().with_remote_span_context(p.clone()),
            None => Context::new(),
        };
        let builder = self
            .tracer
            .span_builder(name)
            .with_kind(SpanKind::Internal)
            .with_start_time(SystemTime::now())
            .with_attributes(self.attributes(fields));
        let span = self.tracer.build_with_context(builder, &parent_cx);
        let cx = span.span_context().clone();
        OtelSpan { span, cx }
    }

    /// Redacted for remote, as OTel attributes.
    pub fn attributes(&self, fields: &Map<String, Value>) -> Vec<KeyValue> {
        let mut r = Record::new(Level::INFO, "", "");
        r.fields = fields.clone();
        self.redactor.local(&mut r);
        let r = self.redactor.remote(&r);
        r.fields
            .iter()
            .map(|(k, v)| KeyValue::new(k.clone(), otel_value(v)))
            .collect()
    }

    pub fn shutdown(&self) {
        let _ = self.logs.shutdown_with_timeout(Duration::from_secs(3));
        let _ = self.traces.shutdown_with_timeout(Duration::from_secs(3));
    }
}

fn otel_value(v: &Value) -> opentelemetry::Value {
    match v {
        Value::Bool(b) => (*b).into(),
        Value::Number(n) => match n.as_i64() {
            Some(i) => i.into(),
            None => n.as_f64().unwrap_or_default().into(),
        },
        Value::String(s) => s.clone().into(),
        other => other.to_string().into(),
    }
}

fn any_value(v: &Value) -> AnyValue {
    match v {
        Value::Bool(b) => AnyValue::Boolean(*b),
        Value::Number(n) => match n.as_i64() {
            Some(i) => AnyValue::Int(i),
            None => AnyValue::Double(n.as_f64().unwrap_or_default()),
        },
        Value::String(s) => AnyValue::String(s.clone().into()),
        other => AnyValue::String(other.to_string().into()),
    }
}

fn severity(level: Level) -> (Severity, &'static str) {
    match level {
        Level::ERROR => (Severity::Error, "ERROR"),
        Level::WARN => (Severity::Warn, "WARN"),
        Level::INFO => (Severity::Info, "INFO"),
        Level::DEBUG => (Severity::Debug, "DEBUG"),
        Level::TRACE => (Severity::Trace, "TRACE"),
    }
}

impl Sink for OtlpSink {
    fn write(&self, record: &Record) {
        let r = self.redactor.remote(record);
        let mut lr = self.logger.create_log_record();
        lr.set_timestamp(UNIX_EPOCH + Duration::from_millis(r.ts_ms.max(0) as u64));
        lr.set_observed_timestamp(SystemTime::now());
        let (sev, text) = severity(r.level);
        lr.set_severity_number(sev);
        lr.set_severity_text(text);
        lr.set_body(AnyValue::String(r.message.clone().into()));
        lr.set_target(r.target.clone());
        lr.add_attribute("kind", r.kind.as_str());
        if !r.spans.is_empty() {
            lr.add_attribute("spans", r.spans.join(">"));
        }
        for (k, v) in &r.fields {
            lr.add_attribute(k.clone(), any_value(v));
        }
        if let Some(t) = r.trace {
            lr.set_trace_context(
                opentelemetry::trace::TraceId::from_bytes(t.trace_id),
                opentelemetry::trace::SpanId::from_bytes(t.span_id),
                Some(TraceFlags::SAMPLED),
            );
        }
        self.logger.emit(lr);
    }

    fn flush(&self, _timeout: Duration) {
        let _ = self.logs.force_flush();
        let _ = self.traces.force_flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn meta() -> AppMeta {
        AppMeta {
            version: "1.0.0".into(),
            channel: "stable".into(),
            os: "macos".into(),
            commit: "abc".into(),
            build_env: "staging".into(),
            install_id: "install-1".into(),
        }
    }

    #[test]
    fn the_resource_names_version_commit_and_build_env() {
        let r = resource(&meta());
        let get = |k: &'static str| r.get(&opentelemetry::Key::from_static_str(k));
        assert_eq!(get("service.version"), Some("1.0.0".into()));
        assert_eq!(get("vcs.ref.head.revision"), Some("abc".into()));
        assert_eq!(get("deployment.environment.name"), Some("staging".into()));
        assert_eq!(get("theodore.update_channel"), Some("stable".into()));
    }

    #[test]
    fn headers_parse_from_the_otel_format() {
        assert_eq!(
            parse_headers("api-key=abc, x-other = 1,broken,=nokey"),
            vec![
                ("api-key".to_string(), "abc".to_string()),
                ("x-other".to_string(), "1".to_string())
            ]
        );
    }

    #[test]
    fn signal_urls_append_to_the_base() {
        let c = OtlpConfig::new("https://otlp.nr-data.net".parse().unwrap(), vec![]);
        assert_eq!(c.signal("logs"), "https://otlp.nr-data.net/v1/logs");
        let c = OtlpConfig::new("http://localhost:4318/".parse().unwrap(), vec![]);
        assert_eq!(c.signal("traces"), "http://localhost:4318/v1/traces");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn logs_and_spans_export_to_the_configured_endpoint_with_its_headers() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/logs"))
            .and(header("api-key", "nr-test"))
            .and(header("content-type", "application/x-protobuf"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/traces"))
            .and(header("api-key", "nr-test"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let cfg = OtlpConfig::new(
            server.uri().parse().unwrap(),
            parse_headers("api-key=nr-test"),
        );
        let sink = tokio::task::spawn_blocking(move || {
            let sink = OtlpSink::start(&cfg, &meta(), Redactor::new(None, "s")).unwrap();
            let mut fields = Map::new();
            fields.insert("repo".into(), "acme/app".into());
            let span = sink.start_span("op", &fields, None);
            let mut rec = Record::new(Level::WARN, "theodore_app", "host failed")
                .with_field("error.code", "host.rate_limited")
                .with_field("repo", "acme/app");
            rec.trace = Some(crate::record::TraceRef {
                trace_id: span.cx.trace_id().to_bytes(),
                span_id: span.cx.span_id().to_bytes(),
            });
            sink.write(&rec);
            let mut s = span.span;
            s.end();
            sink.flush(Duration::from_secs(5));
            sink
        })
        .await
        .unwrap();
        let reqs = server.received_requests().await.unwrap();
        let logs: Vec<_> = reqs.iter().filter(|r| r.url.path() == "/v1/logs").collect();
        let traces: Vec<_> = reqs
            .iter()
            .filter(|r| r.url.path() == "/v1/traces")
            .collect();
        assert_eq!(logs.len(), 1, "{reqs:?}");
        assert_eq!(traces.len(), 1);
        // Protobuf, but strings are visible: the code went, the repo name didn't.
        let body = String::from_utf8_lossy(&logs[0].body);
        assert!(body.contains("host.rate_limited"));
        assert!(body.contains("install-1"));
        assert!(!body.contains("acme/app"));
        assert!(!String::from_utf8_lossy(&traces[0].body).contains("acme/app"));
        tokio::task::spawn_blocking(move || sink.shutdown())
            .await
            .unwrap();
    }
}
