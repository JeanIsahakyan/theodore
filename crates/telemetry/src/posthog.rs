//! Product events to PostHog's `/batch/` endpoint (docs/telemetry.md).
//! Only `kind="product"` records arrive here (`sink::posthog_accepts`).
//!
//! ```text
//! write ─try_send─▶ [bounded queue] ─▶ worker thread: batch (size or tick)
//!   └ full: dropped                      └─▶ POST /batch/ ─5xx/429/network─▶ backoff, retry
//!                                                         └ 4xx, or out of attempts: dropped
//! ```
//!
//! `distinct_id` is the random install id, never the account id, and no
//! person profile is made (`$process_person_profile: false`).

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::AppMeta;
use crate::record::Record;
use crate::redact::Redactor;
use crate::sink::Sink;

#[derive(Debug, Clone, PartialEq)]
pub struct PosthogConfig {
    /// e.g. `https://eu.i.posthog.com`.
    pub host: url::Url,
    /// The project API key (public, write-only).
    pub key: String,
    pub batch_size: usize,
    pub flush_every: Duration,
    pub queue: usize,
    pub max_attempts: u32,
    pub backoff: Duration,
    pub timeout: Duration,
}

impl PosthogConfig {
    pub fn new(host: url::Url, key: impl Into<String>) -> Self {
        Self {
            host,
            key: key.into(),
            batch_size: 50,
            flush_every: Duration::from_secs(30),
            queue: 1000,
            max_attempts: 4,
            backoff: Duration::from_secs(1),
            timeout: Duration::from_secs(10),
        }
    }

    fn batch_url(&self) -> String {
        format!("{}/batch/", self.host.as_str().trim_end_matches('/'))
    }
}

#[derive(Debug, Default)]
pub struct Stats {
    pub sent: AtomicU64,
    pub dropped: AtomicU64,
}

enum Cmd {
    Event(Value),
    Flush(std::sync::mpsc::SyncSender<()>),
}

pub struct PosthogSink {
    tx: Mutex<Option<mpsc::Sender<Cmd>>>,
    stats: Arc<Stats>,
    /// Set when sharing is turned off: what's queued is thrown away.
    discard: Arc<AtomicBool>,
    redactor: Redactor,
    meta: AppMeta,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl PosthogSink {
    pub fn start(cfg: PosthogConfig, meta: AppMeta, redactor: Redactor) -> std::io::Result<Self> {
        let (tx, rx) = mpsc::channel(cfg.queue.max(1));
        let stats = Arc::new(Stats::default());
        let discard = Arc::new(AtomicBool::new(false));
        let (s, d) = (stats.clone(), discard.clone());
        let thread = std::thread::Builder::new()
            .name("theodore-posthog".into())
            .spawn(move || {
                let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                else {
                    return;
                };
                rt.block_on(worker(cfg, rx, s, d));
            })?;
        Ok(Self {
            tx: Mutex::new(Some(tx)),
            stats,
            discard,
            redactor,
            meta,
            thread: Mutex::new(Some(thread)),
        })
    }

    pub fn stats(&self) -> &Stats {
        &self.stats
    }

    /// Stops the worker. `send_pending`: send what's queued first (app
    /// exit); otherwise it's dropped (sharing turned off).
    pub fn shutdown(&self, send_pending: bool) {
        if !send_pending {
            self.discard.store(true, Ordering::SeqCst);
        }
        drop(self.tx.lock().unwrap_or_else(|p| p.into_inner()).take());
        if let Some(t) = self.thread.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = t.join();
        }
    }

    /// The PostHog event for a product record.
    pub fn event(&self, record: &Record) -> Option<Value> {
        let r = self.redactor.remote(record);
        let name = r.field_str("event")?.to_string();
        let mut props = r.fields.clone();
        props.remove("event");
        props.remove("op_id");
        props.insert("app_version".into(), json!(self.meta.version));
        props.insert("os".into(), json!(self.meta.os));
        props.insert("channel".into(), json!(self.meta.channel));
        props.insert("commit".into(), json!(self.meta.commit));
        props.insert("build_env".into(), json!(self.meta.build_env));
        props.insert("$lib".into(), json!("theodore"));
        props.insert("$process_person_profile".into(), json!(false));
        props.insert("$geoip_disable".into(), json!(true));
        Some(json!({
            "event": name,
            "distinct_id": self.meta.install_id,
            "timestamp": r.ts_iso(),
            "uuid": uuid::Uuid::now_v7().to_string(),
            "properties": props,
        }))
    }
}

impl Sink for PosthogSink {
    fn write(&self, record: &Record) {
        let Some(ev) = self.event(record) else { return };
        let guard = self.tx.lock().unwrap_or_else(|p| p.into_inner());
        let ok = guard
            .as_ref()
            .is_some_and(|tx| tx.try_send(Cmd::Event(ev)).is_ok());
        if !ok {
            self.stats.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn flush(&self, timeout: Duration) {
        let (ack_tx, ack_rx) = std::sync::mpsc::sync_channel(1);
        let sent = {
            let guard = self.tx.lock().unwrap_or_else(|p| p.into_inner());
            guard
                .as_ref()
                .is_some_and(|tx| tx.try_send(Cmd::Flush(ack_tx)).is_ok())
        };
        if sent {
            let _ = ack_rx.recv_timeout(timeout);
        }
    }
}

async fn worker(
    cfg: PosthogConfig,
    mut rx: mpsc::Receiver<Cmd>,
    stats: Arc<Stats>,
    discard: Arc<AtomicBool>,
) {
    let Ok(client) = reqwest::Client::builder().timeout(cfg.timeout).build() else {
        return;
    };
    let mut batch: Vec<Value> = Vec::new();
    let mut tick = tokio::time::interval(cfg.flush_every.max(Duration::from_millis(10)));
    tick.tick().await;
    loop {
        tokio::select! {
            cmd = rx.recv() => match cmd {
                Some(Cmd::Event(e)) => {
                    batch.push(e);
                    if batch.len() >= cfg.batch_size {
                        send(&client, &cfg, &mut batch, &stats, &discard).await;
                    }
                }
                Some(Cmd::Flush(ack)) => {
                    send(&client, &cfg, &mut batch, &stats, &discard).await;
                    let _ = ack.send(());
                }
                None => {
                    send(&client, &cfg, &mut batch, &stats, &discard).await;
                    break;
                }
            },
            _ = tick.tick() => send(&client, &cfg, &mut batch, &stats, &discard).await,
        }
    }
}

async fn send(
    client: &reqwest::Client,
    cfg: &PosthogConfig,
    batch: &mut Vec<Value>,
    stats: &Stats,
    discard: &AtomicBool,
) {
    if batch.is_empty() {
        return;
    }
    let events = std::mem::take(batch);
    let n = events.len() as u64;
    if discard.load(Ordering::SeqCst) {
        stats.dropped.fetch_add(n, Ordering::Relaxed);
        return;
    }
    let body = json!({ "api_key": cfg.key, "batch": events });
    let url = cfg.batch_url();
    for attempt in 1..=cfg.max_attempts.max(1) {
        let retry = match client.post(&url).json(&body).send().await {
            Ok(r) if r.status().is_success() => {
                stats.sent.fetch_add(n, Ordering::Relaxed);
                return;
            }
            // A rejected batch won't be accepted later either.
            Ok(r) => r.status().is_server_error() || r.status().as_u16() == 429,
            Err(_) => true,
        };
        if !retry || attempt == cfg.max_attempts || discard.load(Ordering::SeqCst) {
            break;
        }
        let exp = cfg.backoff.saturating_mul(1u32 << (attempt - 1).min(10));
        tokio::time::sleep(exp).await;
    }
    stats.dropped.fetch_add(n, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product::ProductEvent;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn meta() -> AppMeta {
        AppMeta {
            version: "1.2.3".into(),
            channel: "nightly".into(),
            os: "macos".into(),
            commit: "abc".into(),
            build_env: "staging".into(),
            install_id: "install-uuid".into(),
        }
    }

    fn product(e: ProductEvent) -> Record {
        let mut r = Record::new(tracing::Level::INFO, crate::product::TARGET, e.name())
            .with_kind(crate::record::Kind::Product)
            .with_field("event", e.name());
        r.fields.extend(e.props());
        r
    }

    fn cfg(server: &MockServer) -> PosthogConfig {
        PosthogConfig {
            batch_size: 3,
            flush_every: Duration::from_secs(3600),
            backoff: Duration::from_millis(5),
            max_attempts: 3,
            // Generous: the whole workspace's tests share the machine.
            timeout: Duration::from_secs(30),
            ..PosthogConfig::new(server.uri().parse().unwrap(), "phc_test")
        }
    }

    fn sink(cfg: PosthogConfig) -> PosthogSink {
        PosthogSink::start(cfg, meta(), Redactor::new(None, "salt")).unwrap()
    }

    fn pr_opened() -> Record {
        product(ProductEvent::PrOpened {
            host: "github".into(),
        })
    }

    #[test]
    fn the_event_is_anonymous_and_carries_app_info() {
        let server_less = PosthogConfig::new("http://127.0.0.1:9".parse().unwrap(), "k");
        let s = sink(server_less);
        let ev = s
            .event(&product(ProductEvent::GroupingDone {
                ms: 1200,
                valid_first_try: true,
                groups: 4,
                hunks: 20,
                agent: "claude".into(),
                chunks: 1,
            }))
            .unwrap();
        assert_eq!(ev["event"], "grouping_done");
        assert_eq!(ev["distinct_id"], "install-uuid");
        let p = &ev["properties"];
        assert_eq!(p["groups"], 4);
        assert_eq!(p["valid_first_try"], true);
        assert_eq!(p["app_version"], "1.2.3");
        assert_eq!(p["os"], "macos");
        assert_eq!(p["channel"], "nightly");
        assert_eq!(p["commit"], "abc");
        assert_eq!(p["build_env"], "staging");
        assert_eq!(p["$process_person_profile"], false);
        assert!(p.get("event").is_none());
        s.shutdown(false);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn events_are_sent_in_batches() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/batch/"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let s = sink(cfg(&server));
        for _ in 0..4 {
            s.write(&pr_opened());
        }
        s.flush(Duration::from_secs(60));
        let reqs = server.received_requests().await.unwrap();
        // 3 by size, then 1 on flush.
        assert_eq!(reqs.len(), 2);
        let body: Value = serde_json::from_slice(&reqs[0].body).unwrap();
        assert_eq!(body["api_key"], "phc_test");
        assert_eq!(body["batch"].as_array().unwrap().len(), 3);
        assert_eq!(body["batch"][0]["event"], "pr_opened");
        assert_eq!(body["batch"][0]["distinct_id"], "install-uuid");
        assert_eq!(s.stats().sent.load(Ordering::Relaxed), 4);
        s.shutdown(true);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn server_errors_are_retried_with_backoff() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(503))
            .up_to_n_times(2)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let s = sink(cfg(&server));
        s.write(&pr_opened());
        s.flush(Duration::from_secs(60));
        assert_eq!(server.received_requests().await.unwrap().len(), 3);
        assert_eq!(s.stats().sent.load(Ordering::Relaxed), 1);
        assert_eq!(s.stats().dropped.load(Ordering::Relaxed), 0);
        s.shutdown(true);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_batch_is_dropped_after_its_attempts_or_on_a_rejection() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        let s = sink(cfg(&server));
        s.write(&pr_opened());
        s.flush(Duration::from_secs(60));
        assert_eq!(server.received_requests().await.unwrap().len(), 3);
        assert_eq!(s.stats().dropped.load(Ordering::Relaxed), 1);
        s.shutdown(true);

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(400))
            .mount(&server)
            .await;
        let s = sink(cfg(&server));
        s.write(&pr_opened());
        s.flush(Duration::from_secs(60));
        // A 400 isn't retried.
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
        assert_eq!(s.stats().dropped.load(Ordering::Relaxed), 1);
        s.shutdown(true);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_full_queue_drops_instead_of_blocking() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(300)))
            .mount(&server)
            .await;
        let s = sink(PosthogConfig {
            queue: 2,
            batch_size: 1,
            ..cfg(&server)
        });
        let start = std::time::Instant::now();
        for _ in 0..50 {
            s.write(&pr_opened());
        }
        assert!(start.elapsed() < Duration::from_millis(250));
        assert!(s.stats().dropped.load(Ordering::Relaxed) > 0);
        s.shutdown(false);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn turning_sharing_off_discards_the_queue() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let s = sink(cfg(&server));
        s.write(&pr_opened());
        s.shutdown(false);
        assert_eq!(server.received_requests().await.unwrap().len(), 0);
    }
}
