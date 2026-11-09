//! Remote sinks against mock servers: nothing leaves before a choice, each
//! choice gates only its own sink, and the only thing that ties a record to
//! the account is the account's id, set on purpose (docs/telemetry.md
//! "Who a record is from").

use std::sync::Arc;
use std::time::Duration;

use theodore_telemetry::layer::{Shared, TelemetryLayer};
use theodore_telemetry::otlp::OtlpConfig;
use theodore_telemetry::posthog::PosthogConfig;
use theodore_telemetry::sink::Sink;
use theodore_telemetry::{
    AppMeta, Choice, ProductEvent, Record, Redactor, RemoteConfig, Telemetry,
};
use tracing_subscriber::layer::SubscriberExt as _;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

const ACCOUNT_ID: &str = "user_01ACCOUNTIDXYZ";
/// Who `set_account` says is signed in; `ACCOUNT_ID` is only ever a field.
const SIGNED_IN: &str = "user_01SIGNEDINUSER";
const INSTALL_ID: &str = "11111111-2222-4333-8444-555555555555";

/// Keeps what reaches a local sink, as the log file would.
#[derive(Default)]
struct LocalLog(std::sync::Mutex<Vec<String>>);

impl Sink for LocalLog {
    fn write(&self, record: &Record) {
        let line = format!("{record:?}");
        self.0.lock().unwrap().push(line);
    }

    fn flush(&self, _timeout: Duration) {}
}

struct Rig {
    t: Arc<Telemetry>,
    shared: Arc<Shared>,
    server: MockServer,
}

async fn rig() -> Rig {
    rig_with(vec![]).await
}

async fn rig_with(local: Vec<Arc<dyn Sink>>) -> Rig {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let shared = Arc::new(Shared::new(Redactor::new(None, "install-1"), local));
    let meta = AppMeta {
        version: "1.0.0".into(),
        channel: "stable".into(),
        os: "macos".into(),
        arch: "aarch64".into(),
        commit: "abc".into(),
        build_env: "dev".into(),
        install_id: INSTALL_ID.into(),
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

    async fn posthog_events(&self) -> Vec<serde_json::Value> {
        let reqs = self.server.received_requests().await.unwrap();
        reqs.iter()
            .filter(|r| r.url.path() == "/batch/")
            .flat_map(|r| {
                let body: serde_json::Value = serde_json::from_slice(&r.body).unwrap();
                body["batch"].as_array().unwrap().clone()
            })
            .collect()
    }

    /// Everything that went over OTLP, protobuf read as text.
    async fn otlp_bodies(&self) -> String {
        let reqs = self.server.received_requests().await.unwrap();
        reqs.iter()
            .filter(|r| r.url.path().starts_with("/v1/"))
            .map(|r| String::from_utf8_lossy(&r.body).into_owned())
            .collect()
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
        assert_eq!(e["distinct_id"], INSTALL_ID);
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

const USAGE_ONLY: Choice = Choice {
    usage: Some(true),
    errors: Some(false),
};
const ERRORS_ONLY: Choice = Choice {
    usage: Some(false),
    errors: Some(true),
};

fn named<'a>(events: &'a [serde_json::Value], name: &str) -> Vec<&'a serde_json::Value> {
    events.iter().filter(|e| e["event"] == name).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn signed_in_events_are_the_accounts_and_the_install_id_is_linked_to_it() {
    let rig = rig().await;
    rig.apply(USAGE_ONLY).await;
    rig.t.set_account(Some(SIGNED_IN));
    rig.emit_and_flush().await;
    let events = rig.posthog_events().await;
    let identify = named(&events, "$identify");
    assert_eq!(identify.len(), 1, "{events:?}");
    assert_eq!(identify[0]["distinct_id"], SIGNED_IN);
    let props = &identify[0]["properties"];
    assert_eq!(props["$anon_distinct_id"], INSTALL_ID);
    assert_eq!(props["$set"]["app_version"], "1.0.0");
    assert_eq!(props["$set"]["channel"], "stable");
    assert_eq!(props["$set"]["os"], "macos");
    assert_eq!(props["$set"]["arch"], "aarch64");
    let opened = named(&events, "pr_opened");
    assert_eq!(opened.len(), 1);
    assert_eq!(opened[0]["distinct_id"], SIGNED_IN);
    assert_eq!(opened[0]["properties"]["$process_person_profile"], true);
    assert_eq!(opened[0]["properties"]["arch"], "aarch64");
    rig.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn signed_out_events_keep_the_install_id_and_identify_nobody() {
    let rig = rig().await;
    rig.apply(USAGE_ONLY).await;
    rig.emit_and_flush().await;
    let events = rig.posthog_events().await;
    assert_eq!(named(&events, "$identify").len(), 0, "{events:?}");
    let opened = named(&events, "pr_opened");
    assert_eq!(opened[0]["distinct_id"], INSTALL_ID);
    assert_eq!(opened[0]["properties"]["$process_person_profile"], false);
    rig.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn signing_out_starts_a_new_anonymous_id() {
    let rig = rig().await;
    rig.apply(USAGE_ONLY).await;
    rig.t.set_account(Some(SIGNED_IN));
    rig.t.set_account(None);
    rig.emit_and_flush().await;
    let events = rig.posthog_events().await;
    let opened = named(&events, "pr_opened");
    let id = opened[0]["distinct_id"].as_str().unwrap();
    assert_ne!(id, SIGNED_IN);
    assert_ne!(id, INSTALL_ID, "the install id is linked to the account");
    assert!(uuid::Uuid::parse_str(id).is_ok());
    assert_eq!(opened[0]["properties"]["$process_person_profile"], false);
    // The hashing key and the instance id don't move with it.
    assert_eq!(rig.t.meta().install_id, INSTALL_ID);
    rig.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn with_sharing_off_the_account_id_goes_nowhere() {
    let rig = rig().await;
    rig.apply(Choice {
        usage: Some(false),
        errors: Some(false),
    })
    .await;
    rig.t.set_account(Some(SIGNED_IN));
    rig.emit_and_flush().await;
    assert_eq!(rig.paths().await, Vec::<String>::new());
    rig.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn sharing_turned_on_after_sign_in_links_the_account_then() {
    let rig = rig().await;
    rig.t.set_account(Some(SIGNED_IN));
    rig.apply(USAGE_ONLY).await;
    rig.emit_and_flush().await;
    let events = rig.posthog_events().await;
    assert_eq!(named(&events, "$identify").len(), 1, "{events:?}");
    rig.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn error_reports_carry_the_account_id_only_while_signed_in() {
    let rig = rig().await;
    rig.apply(ERRORS_ONLY).await;
    rig.emit_and_flush().await;
    assert!(!rig.otlp_bodies().await.contains(SIGNED_IN));

    rig.t.set_account(Some(SIGNED_IN));
    rig.emit_and_flush().await;
    let t = rig.t.clone();
    tokio::task::spawn_blocking(move || t.flush(Duration::from_secs(60)))
        .await
        .unwrap();
    let bodies = rig.otlp_bodies().await;
    assert!(bodies.contains(SIGNED_IN));
    assert!(bodies.contains("enduser.id"));
    assert!(!bodies.contains(ACCOUNT_ID), "fields stay hashed");
    // Error reports alone don't start PostHog.
    assert_eq!(rig.posthog_events().await.len(), 0);
    rig.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_email_is_never_taken_for_the_account_id() {
    let rig = rig().await;
    rig.apply(USAGE_ONLY).await;
    rig.t.set_account(Some("me@example.com"));
    rig.emit_and_flush().await;
    let events = rig.posthog_events().await;
    assert_eq!(named(&events, "$identify").len(), 0, "{events:?}");
    assert_eq!(named(&events, "pr_opened")[0]["distinct_id"], INSTALL_ID);
    rig.shutdown().await;
}

/// A problem report is built from the local log: what isn't there can't
/// reach one.
#[tokio::test(flavor = "multi_thread")]
async fn the_local_log_never_gets_the_account_id() {
    let log = Arc::new(LocalLog::default());
    let rig = rig_with(vec![log.clone()]).await;
    rig.apply(Choice {
        usage: Some(true),
        errors: Some(true),
    })
    .await;
    rig.t.set_account(Some(SIGNED_IN));
    rig.emit_and_flush().await;
    let lines = log.0.lock().unwrap().clone();
    assert!(!lines.is_empty());
    assert!(!lines.iter().any(|l| l.contains(SIGNED_IN)), "{lines:?}");
    rig.shutdown().await;
}
