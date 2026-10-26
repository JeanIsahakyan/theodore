//! Telemetry (docs/telemetry.md): one structured stream (`tracing`), one
//! redaction step, several sinks picked by settings.
//!
//! ```text
//! core tracing ─────────────┐
//! UI errors (log_client) ───┼─▶ layer: Record ─▶ redact ─┬─▶ file: everything (always on)
//! panics (panic hook) ──────┘                            ├─▶ stderr (dev)
//!                                                        ├─▶ OTLP: warn/error, panics, traces
//!                                                        │         (only with "Send error reports")
//!                                                        └─▶ PostHog: product events only
//!                                                                  (only with "Share usage data")
//! ```
//!
//! Remote sinks are off by default: they need an endpoint (env, setting or
//! built in) AND the user's recorded choice. Tests and the CLI never call
//! `init`, so nothing is ever sent from them.

pub mod client;
pub mod config;
pub mod console;
pub mod file;
pub mod issue;
pub mod layer;
pub mod otlp;
pub mod panic;
pub mod posthog;
pub mod product;
pub mod record;
pub mod redact;
pub mod report;
pub mod sink;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tracing_subscriber::EnvFilter;
use tracing_subscriber::layer::SubscriberExt as _;
use tracing_subscriber::reload;
use tracing_subscriber::util::SubscriberInitExt as _;

pub use config::{Choice, RemoteConfig, Sources};
pub use product::{ProductEvent, product};
pub use record::{Kind, Record};
pub use redact::Redactor;

use crate::layer::{Shared, TelemetryLayer};
use crate::sink::Sink;

/// What every remote record says about the app (and nothing about the
/// person): version, channel, OS, commit, build environment, and the
/// random install id.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AppMeta {
    pub version: String,
    pub channel: String,
    pub os: String,
    pub commit: String,
    /// `production` | `staging` | `nightly` | `dev` (the build stamp).
    pub build_env: String,
    /// A random UUID kept in the data dir: the only id remote sinks see.
    pub install_id: String,
}

pub struct InitConfig {
    pub data_dir: PathBuf,
    /// `THEODORE_LOG` (a level or `tracing` directives); `None`: `info`
    /// (or the `log.level` setting, applied later by `set_level`).
    pub level: Option<String>,
    /// Mirror records to stderr (debug builds, `THEODORE_LOG_STDERR=1`).
    pub stderr: bool,
    pub version: String,
    pub channel: String,
    pub commit: String,
    pub build_env: String,
}

type FilterHandle = reload::Handle<EnvFilter, tracing_subscriber::Registry>;

pub struct Telemetry {
    shared: Arc<Shared>,
    file: Option<Arc<file::FileSink>>,
    filter: Option<FilterHandle>,
    /// `THEODORE_LOG` was set: it wins over the setting.
    env_level: bool,
    logs_dir: PathBuf,
    meta: Mutex<AppMeta>,
    /// What `apply` last set up, and the meta its sinks were started with.
    state: Mutex<(RemoteConfig, Choice, AppMeta)>,
}

static GLOBAL: OnceLock<Telemetry> = OnceLock::new();

/// The process-wide telemetry, once `init` ran (the desktop app only).
pub fn global() -> Option<&'static Telemetry> {
    GLOBAL.get()
}

/// The install id in `<data_dir>/telemetry/install_id`, created on first
/// use. Not derived from anything about the user or machine.
pub fn install_id(data_dir: &Path) -> String {
    let path = data_dir.join("telemetry").join("install_id");
    if let Ok(s) = std::fs::read_to_string(&path) {
        let s = s.trim();
        if uuid::Uuid::parse_str(s).is_ok() {
            return s.to_string();
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&path, &id);
    id
}

/// Filter directives: third-party chatter capped at info, the user's
/// level or directives, and product/panic/UI records always let through.
pub fn filter_directives(level: Option<&str>) -> String {
    let user = level
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("info");
    format!(
        "info,hyper=info,hyper_util=info,h2=info,rustls=info,reqwest=info,tao=info,wry=info,{user},{p}=info,{c}=info,{x}=error",
        p = product::TARGET,
        c = client::TARGET,
        x = panic::TARGET,
    )
}

fn env_filter(level: Option<&str>) -> EnvFilter {
    EnvFilter::try_new(filter_directives(level))
        .unwrap_or_else(|_| EnvFilter::new(filter_directives(None)))
}

/// Sets up the global subscriber (file + optional stderr), the panic
/// hook and the global handle. Remote sinks start off; `apply` turns them
/// on. Call once, early in `main`.
pub fn init(cfg: InitConfig) -> &'static Telemetry {
    if let Some(t) = GLOBAL.get() {
        return t;
    }
    let install = install_id(&cfg.data_dir);
    let meta = AppMeta {
        version: cfg.version,
        channel: cfg.channel,
        os: std::env::consts::OS.to_string(),
        commit: cfg.commit,
        build_env: cfg.build_env,
        install_id: install.clone(),
    };
    let logs_dir = cfg.data_dir.join("logs");
    let file = file::RotatingFile::open(&logs_dir, file::Rotation::default())
        .ok()
        .map(|f| Arc::new(file::FileSink::start(f)));
    let mut local: Vec<Arc<dyn Sink>> = Vec::new();
    if let Some(f) = &file {
        local.push(f.clone());
    }
    if cfg.stderr {
        local.push(Arc::new(console::StderrSink));
    }
    let shared = Arc::new(Shared::new(Redactor::new(dirs::home_dir(), install), local));
    let (filter, handle) = reload::Layer::new(env_filter(cfg.level.as_deref()));
    let installed = tracing_subscriber::registry()
        .with(filter)
        .with(TelemetryLayer::new(shared.clone()))
        .try_init()
        .is_ok();
    let mut t = Telemetry::detached(shared, meta, logs_dir);
    t.file = file;
    t.filter = installed.then_some(handle);
    t.env_level = cfg.level.is_some();
    let t = GLOBAL.get_or_init(|| t);
    panic::install();
    t
}

impl Telemetry {
    /// A handle over `shared` that installs nothing globally: `init` builds
    /// on it, tests drive it with their own subscriber
    /// (`TelemetryLayer::new(t.shared())`).
    pub fn detached(shared: Arc<Shared>, meta: AppMeta, logs_dir: PathBuf) -> Self {
        Telemetry {
            shared,
            file: None,
            filter: None,
            env_level: false,
            logs_dir,
            meta: Mutex::new(meta),
            state: Mutex::new(Default::default()),
        }
    }

    pub fn shared(&self) -> Arc<Shared> {
        self.shared.clone()
    }

    pub fn meta(&self) -> AppMeta {
        self.meta.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// The update channel, known once settings are read (after `init`);
    /// sinks started from here on report it.
    pub fn set_channel(&self, channel: &str) {
        self.meta.lock().unwrap_or_else(|p| p.into_inner()).channel = channel.to_string();
    }

    pub fn logs_dir(&self) -> &Path {
        &self.logs_dir
    }

    pub fn redactor(&self) -> &Redactor {
        &self.shared.redactor
    }

    /// The `log.level` setting; ignored when `THEODORE_LOG` is set.
    pub fn set_level(&self, level: Option<&str>) {
        if self.env_level {
            return;
        }
        if let Some(h) = &self.filter {
            let _ = h.reload(env_filter(level));
        }
    }

    /// Which remote sinks exist, and the current choice.
    pub fn status(&self) -> (bool, bool, Choice) {
        let s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        (s.0.posthog.is_some(), s.0.otlp.is_some(), s.1)
    }

    /// Points the remote sinks at `config` and lets each send only when
    /// its choice is `Some(true)`. Starts, stops or restarts sinks as
    /// needed; a sink turned off drops what it had queued. Without a
    /// choice nothing is started, so nothing is queued either.
    pub fn apply(&self, config: RemoteConfig, choice: Choice) {
        let meta = self.meta();
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let usage_on =
            |c: &RemoteConfig, ch: &Choice| c.posthog.is_some() && ch.usage == Some(true);
        let errors_on = |c: &RemoteConfig, ch: &Choice| c.otlp.is_some() && ch.errors == Some(true);
        let (old_cfg, old_choice, old_meta) = (&state.0, &state.1, &state.2);
        let meta_changed = *old_meta != meta;

        let posthog_changed = usage_on(old_cfg, old_choice) != usage_on(&config, &choice)
            || old_cfg.posthog != config.posthog
            || meta_changed;
        if posthog_changed {
            let old = self
                .shared
                .posthog
                .write()
                .unwrap_or_else(|p| p.into_inner())
                .take();
            if let Some(old) = old {
                old.shutdown(false);
            }
            if usage_on(&config, &choice)
                && let Some(c) = &config.posthog
            {
                match posthog::PosthogSink::start(
                    c.clone(),
                    meta.clone(),
                    self.shared.redactor.clone(),
                ) {
                    Ok(s) => {
                        *self
                            .shared
                            .posthog
                            .write()
                            .unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(s))
                    }
                    Err(e) => tracing::warn!(error = %e, "usage data sink didn't start"),
                }
            }
        }

        let otlp_changed = errors_on(old_cfg, old_choice) != errors_on(&config, &choice)
            || old_cfg.otlp != config.otlp
            || meta_changed;
        if otlp_changed {
            let old = self
                .shared
                .otlp
                .write()
                .unwrap_or_else(|p| p.into_inner())
                .take();
            if let Some(old) = old {
                old.shutdown();
            }
            if errors_on(&config, &choice)
                && let Some(c) = &config.otlp
            {
                match otlp::OtlpSink::start(c, &meta, self.shared.redactor.clone()) {
                    Ok(s) => {
                        *self.shared.otlp.write().unwrap_or_else(|p| p.into_inner()) =
                            Some(Arc::new(s))
                    }
                    Err(e) => tracing::warn!(error = %e, "error report sink didn't start"),
                }
            }
        }
        *state = (config, choice, meta);
    }

    /// Writes/sends what's queued, waiting at most about `timeout` per sink.
    pub fn flush(&self, timeout: Duration) {
        for s in &self.shared.local {
            s.flush(timeout);
        }
        if let Some(o) = self.shared.otlp() {
            o.flush(timeout);
        }
        if let Some(p) = self.shared.posthog() {
            p.flush(timeout);
        }
    }

    /// App exit: sends what's queued, then stops every sink.
    pub fn shutdown(&self) {
        if let Some(p) = self
            .shared
            .posthog
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .take()
        {
            p.flush(Duration::from_secs(2));
            p.shutdown(true);
        }
        if let Some(o) = self
            .shared
            .otlp
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .take()
        {
            o.shutdown();
        }
        if let Some(f) = &self.file {
            f.flush(Duration::from_secs(2));
        }
    }
}

/// A UI error or event (`log_client`), deduped and rate-limited.
pub fn client_log(entry: &theodore_contract::ClientLog) {
    client::log(entry);
}

/// A UI product event (`track_ui`); unknown values are dropped.
pub fn track_ui(event: &theodore_contract::UiEvent) {
    if let Some(e) = product::from_ui(event) {
        e.emit();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_install_id_is_random_and_stable_across_restarts() {
        let dir = tempfile::tempdir().unwrap();
        let a = install_id(dir.path());
        assert!(uuid::Uuid::parse_str(&a).is_ok());
        assert_eq!(install_id(dir.path()), a);
        let other = tempfile::tempdir().unwrap();
        assert_ne!(install_id(other.path()), a);
        // A damaged file is replaced, not trusted.
        std::fs::write(dir.path().join("telemetry/install_id"), "user@example.com").unwrap();
        let b = install_id(dir.path());
        assert_ne!(b, "user@example.com");
        assert_eq!(install_id(dir.path()), b);
    }

    #[test]
    fn directives_always_let_product_and_panic_records_through() {
        let d = filter_directives(Some("error"));
        assert!(d.contains(",error,"));
        assert!(d.ends_with("theodore::product=info,theodore::client=info,theodore::panic=error"));
        assert!(EnvFilter::try_new(filter_directives(Some("debug,theodore_app=trace"))).is_ok());
    }
}
