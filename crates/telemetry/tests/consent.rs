//! Remote sinks against mock servers: nothing leaves before a choice, each
//! choice gates only its own sink, and nothing ties a record to the
//! account (docs/telemetry.md "Consent").

use std::sync::Arc;
use std::time::Duration;

use theodore_telemetry::layer::{Shared, TelemetryLayer};
use theodore_telemetry::otlp::OtlpConfig;
use theodore_telemetry::posthog::PosthogConfig;
use theodore_telemetry::{AppMeta, Choice, ProductEvent, Redactor, RemoteConfig, Telemetry};
use tracing_subscriber::layer::SubscriberExt as _;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

const ACCOUNT_ID: &str = "user_01ACCOUNTIDXYZ";

struct Rig {
    t: Arc<Telemetry>,
    shared: Arc<Shared>,
    server: MockServer,
}

async fn rig() -> Rig {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let shared = Arc::new(Shared::new(Redactor::new(None, "install-1"), vec![]));
    let meta = AppMeta {
        version: "1.0.0".into(),
        channel: "stable".into(),
        os: "macos".into(),
        commit: "abc".into(),
        build_env: "dev".into(),
        install_id: "11111111-2222-4333-8444-555555555555".into(),
    };
    let t = Arc::new(Telemetry::detached(
        shared.clone(),
        meta,
        std::env::temp_dir(),
    ));
    Rig { t, shared, server }
}

fn config(server: &MockServer) -> RemoteConfig {
    let mut otlp = OtlpConfig::new(
        server.uri().parse().unwrap(),
        vec![("api-key".into(), "k".into())],
    );
    otlp.delay = Duration::from_millis(50);
    RemoteConfig {
        otlp: Some(otlp),
        posthog: Some(PosthogConfig {
            batch_size: 1,
            // Generous: the whole workspace's tests share the machine.
            timeout: Duration::from_secs(30),
            ..PosthogConfig::new(server.uri().parse().unwrap(), "phc_k")
        }),
    }
}

impl Rig {
    async fn apply(&self, choice: Choice) {
        let (t, cfg) = (self.t.clone(), config(&self.server));
        tokio::task::spawn_blocking(move || t.apply(cfg, choice))
            .await
            .unwrap();
    }

    /// One product event and one error, as the app would emit them, inside
    /// a span that carries the account id.
    async fn emit_and_flush(&self) {
        let sub = tracing_subscriber::registry().with(TelemetryLayer::new(self.shared.clone()));
        tracing::subscriber::with_default(sub, || {
            let span = tracing::info_span!("op", op_id = "op1", user_id = ACCOUNT_ID);
            let _g = span.enter();
            ProductEvent::SignedIn.emit();
            ProductEvent::PrOpened {
                host: "github".into(),
            }
            .emit();
            tracing::warn!(
                target: "theodore_app",
                code = "host.rate_limited",
                account_id = ACCOUNT_ID,
                "host refused"
            );
            tracing::debug!(target: "theodore_app", "debug stays local");
        });
        let t = self.t.clone();
        tokio::task::spawn_blocking(move || t.flush(Duration::from_secs(60)))
            .await
            .unwrap();
    }

    async fn paths(&self) -> Vec<String> {
        self.server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .map(|r| r.url.path().to_string())
            .collect()
    }

    async fn shutdown(self) {
        let t = self.t.clone();
        tokio::task::spawn_blocking(move || t.shutdown())
            .await
            .unwrap();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn nothing_is_sent_or_queued_before_a_choice() {
    let rig = rig().await;
    rig.apply(Choice::default()).await;
    assert!(rig.shared.posthog().is_none());
    assert!(rig.shared.otlp().is_none());
    rig.emit_and_flush().await;
    assert_eq!(rig.paths().await, Vec::<String>::new());
    // Choosing later doesn't send what happened before.
    rig.apply(Choice {
        usage: Some(true),
        errors: Some(true),
    })
    .await;
    let t = rig.t.clone();
    tokio::task::spawn_blocking(move || t.flush(Duration::from_secs(60)))
        .await
        .unwrap();
    assert_eq!(rig.paths().await, Vec::<String>::new());
    rig.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn usage_data_gates_only_posthog() {
    let rig = rig().await;
    rig.apply(Choice {
        usage: Some(true),
        errors: Some(false),
    })
    .await;
    rig.emit_and_flush().await;
    let paths = rig.paths().await;
    assert!(paths.iter().any(|p| p == "/batch/"), "{paths:?}");
    assert!(!paths.iter().any(|p| p.starts_with("/v1/")), "{paths:?}");
    rig.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn error_reports_gate_only_otlp() {
    let rig = rig().await;
    rig.apply(Choice {
        usage: Some(false),
        errors: Some(true),
    })
    .await;
    rig.emit_and_flush().await;
    let paths = rig.paths().await;
    assert!(paths.iter().any(|p| p == "/v1/logs"), "{paths:?}");
    assert!(!paths.iter().any(|p| p == "/batch/"), "{paths:?}");
    rig.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn payloads_use_the_install_id_and_never_the_account() {
    let rig = rig().await;
    rig.apply(Choice {
        usage: Some(true),
        errors: Some(true),
    })
    .await;
    rig.emit_and_flush().await;
    let reqs = rig.server.received_requests().await.unwrap();
    assert!(reqs.len() >= 2, "{reqs:?}");
    for r in &reqs {
        let body = String::from_utf8_lossy(&r.body);
        assert!(
            !body.contains(ACCOUNT_ID),
            "{} leaked the account id",
            r.url
        );
        assert!(!body.contains("debug stays local"), "{}", r.url);
    }
    let batches: Vec<serde_json::Value> = reqs
        .iter()
        .filter(|r| r.url.path() == "/batch/")
        .map(|r| serde_json::from_slice(&r.body).unwrap())
        .collect();
    let events: Vec<&serde_json::Value> = batches
        .iter()
        .flat_map(|b| b["batch"].as_array().unwrap())
        .collect();
    assert_eq!(events.len(), 2);
    for e in &events {
        assert_eq!(e["distinct_id"], "11111111-2222-4333-8444-555555555555");
        assert!(e["properties"].get("user_id").is_none());
    }
    rig.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn turning_a_choice_off_stops_its_sink() {
    let rig = rig().await;
    rig.apply(Choice {
        usage: Some(true),
        errors: Some(false),
    })
    .await;
    assert!(rig.shared.posthog().is_some());
    rig.apply(Choice {
        usage: Some(false),
        errors: Some(false),
    })
    .await;
    assert!(rig.shared.posthog().is_none());
    rig.emit_and_flush().await;
    assert_eq!(rig.paths().await, Vec::<String>::new());
    rig.shutdown().await;
}
