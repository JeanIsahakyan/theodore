//! The telemetry settings the shell applies to its sinks
//! (docs/telemetry.md "Settings"): the two sharing choices, the sink
//! endpoints set as settings, and the log level. The core stores them;
//! it never sends anything itself.

use theodore_contract::{Setting, models};
use theodore_ports::{NewAction, SyncActionCode};
use theodore_telemetry::config as keys;

use crate::core::Core;
use crate::error::{AppError, AppResult};
use crate::settings::SCOPE_USER;

/// What `telemetry.*` and `log.level` hold. `usage` / `errors` are `None`
/// until the user chose.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TelemetrySettings {
    pub usage: Option<bool>,
    pub errors: Option<bool>,
    pub otlp_endpoint: Option<String>,
    pub otlp_headers: Option<String>,
    pub posthog_host: Option<String>,
    pub posthog_key: Option<String>,
    pub log_level: Option<String>,
}

impl TelemetrySettings {
    /// As a sink source (env first, built-in last, are the shell's).
    pub fn sources(&self) -> theodore_telemetry::Sources<'_> {
        theodore_telemetry::Sources {
            otlp_endpoint: self.otlp_endpoint.as_deref(),
            otlp_headers: self.otlp_headers.as_deref(),
            posthog_host: self.posthog_host.as_deref(),
            posthog_key: self.posthog_key.as_deref(),
        }
    }

    pub fn choice(&self) -> theodore_telemetry::Choice {
        theodore_telemetry::Choice {
            usage: self.usage,
            errors: self.errors,
        }
    }
}

/// A unit enum's wire name (`approve`, `squash`), for product events.
pub(crate) fn wire_str<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

impl Core {
    async fn tel_setting(&self, key: &str) -> Option<serde_json::Value> {
        let store = self.0.deps.store.clone();
        let k = key.to_string();
        let rows = tokio::task::spawn_blocking(move || store.query(models::SETTING, "key", &k))
            .await
            .ok()?
            .ok()?;
        crate::settings::pick_setting(rows, None)
    }

    async fn tel_string(&self, key: &str) -> Option<String> {
        self.tel_setting(key)
            .await
            .and_then(|v| v.as_str().map(str::trim).map(str::to_string))
            .filter(|s| !s.is_empty())
    }

    pub async fn telemetry_settings(&self) -> TelemetrySettings {
        TelemetrySettings {
            usage: self
                .tel_setting(keys::SETTING_USAGE)
                .await
                .and_then(|v| v.as_bool()),
            errors: self
                .tel_setting(keys::SETTING_ERRORS)
                .await
                .and_then(|v| v.as_bool()),
            otlp_endpoint: self.tel_string(keys::SETTING_OTLP_ENDPOINT).await,
            otlp_headers: self.tel_string(keys::SETTING_OTLP_HEADERS).await,
            posthog_host: self.tel_string(keys::SETTING_POSTHOG_HOST).await,
            posthog_key: self.tel_string(keys::SETTING_POSTHOG_KEY).await,
            log_level: self.tel_string(keys::SETTING_LOG_LEVEL).await,
        }
    }

    /// Records both sharing choices (onboarding, Settings → About &
    /// updates). The shell applies them to its sinks right after.
    pub async fn set_telemetry_choice(&self, usage: bool, errors: bool) -> AppResult<()> {
        let mut actions = Vec::new();
        for (key, value) in [(keys::SETTING_USAGE, usage), (keys::SETTING_ERRORS, errors)] {
            let setting = Setting {
                key: key.into(),
                scope: SCOPE_USER.into(),
                value: serde_json::json!(value),
            };
            actions.push(NewAction {
                model: models::SETTING.into(),
                model_id: key.into(),
                action: SyncActionCode::U,
                data: Some(
                    serde_json::to_value(&setting).map_err(|e| AppError::Invalid(e.to_string()))?,
                ),
            });
        }
        self.apply(actions).await?;
        tracing::info!(usage, errors, "sharing choice recorded");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::Core;
    use crate::testkit::fixtures;

    #[tokio::test]
    async fn no_choice_until_one_is_recorded_then_each_is_kept() {
        let f = fixtures();
        let (core, _rx) = Core::start(f.deps());
        let s = core.telemetry_settings().await;
        assert_eq!((s.usage, s.errors), (None, None));
        core.set_telemetry_choice(true, false).await.unwrap();
        let s = core.telemetry_settings().await;
        assert_eq!((s.usage, s.errors), (Some(true), Some(false)));
        core.set_telemetry_choice(false, true).await.unwrap();
        let s = core.telemetry_settings().await;
        assert_eq!((s.usage, s.errors), (Some(false), Some(true)));
    }
}
