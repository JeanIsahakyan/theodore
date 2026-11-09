//! The telemetry settings the shell applies to its sinks
//! (docs/telemetry.md "Settings"): the two sharing choices, the sink
//! endpoints set as settings, and the log level. The core stores them;
//! it never sends anything itself.

use theodore_contract::{Setting, TelemetryChoice, models};
use theodore_ports::{NewAction, SyncActionCode};
use theodore_telemetry::config as keys;

use crate::core::Core;
use crate::error::{AppError, AppResult};
use crate::settings::SCOPE_USER;

/// What `telemetry.*` and `log.level` hold. `usage` / `errors` are `None`
/// until the user chose; `*_consent` is 0 when absent (the old terms).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TelemetrySettings {
    pub usage: Option<bool>,
    pub errors: Option<bool>,
    pub usage_consent: u32,
    pub errors_consent: u32,
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
            usage_consent: self.usage_consent,
            errors_consent: self.errors_consent,
        }
    }
}

/// The consent version a switch has after a choice. Off holds none. Left on
/// without being asked it stays what it was: an update to Settings' other
/// switch isn't agreement to anything.
fn consent_after(was_on: Option<bool>, on: bool, agreed: bool, consent: u32) -> u32 {
    if !on {
        0
    } else if agreed || was_on != Some(true) {
        keys::CONSENT_LINKED
    } else {
        consent
    }
}

/// A unit enum's wire name (`approve`, `squash`), for product events.
pub(crate) fn wire_str<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// What a space was started from, for `space_created`. The value it was
/// started from (an issue, a branch's name) stays out of it.
pub(crate) fn start_label(start: Option<&theodore_contract::SpaceStart>) -> &'static str {
    use theodore_contract::SpaceStart;
    match start {
        None => "blank",
        Some(SpaceStart::Issue(_)) => "issue",
        Some(SpaceStart::Branch(_)) => "branch",
        Some(SpaceStart::Pr(_)) => "pr",
    }
}

/// Tool calls among a turn's steps.
pub(crate) fn tool_calls(steps: &[theodore_contract::TurnStep]) -> u32 {
    steps
        .iter()
        .filter(|s| matches!(s, theodore_contract::TurnStep::Tool { .. }))
        .count() as u32
}

/// You stepped in on an agent; the list is on `ProductEvent::SpaceAction`.
pub(crate) fn space_action(action: &str) {
    theodore_telemetry::product(theodore_telemetry::ProductEvent::SpaceAction {
        action: action.to_string(),
    });
}

/// `messages` queued messages of `space` now wait for you, because of
/// `reason`. Nothing happened if there were none.
pub(crate) fn queue_held(space: &str, reason: &str, messages: usize) {
    if messages == 0 {
        return;
    }
    tracing::info!(space, reason, messages, "queue held");
    theodore_telemetry::product(theodore_telemetry::ProductEvent::QueueHeld {
        reason: reason.to_string(),
        messages: messages as u32,
    });
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

    async fn tel_consent(&self, key: &str) -> u32 {
        self.tel_setting(key)
            .await
            .and_then(|v| v.as_u64())
            .map_or(0, |v| u32::try_from(v).unwrap_or(0))
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
            usage_consent: self.tel_consent(keys::SETTING_USAGE_CONSENT).await,
            errors_consent: self.tel_consent(keys::SETTING_ERRORS_CONSENT).await,
            otlp_endpoint: self.tel_string(keys::SETTING_OTLP_ENDPOINT).await,
            otlp_headers: self.tel_string(keys::SETTING_OTLP_HEADERS).await,
            posthog_host: self.tel_string(keys::SETTING_POSTHOG_HOST).await,
            posthog_key: self.tel_string(keys::SETTING_POSTHOG_KEY).await,
            log_level: self.tel_string(keys::SETTING_LOG_LEVEL).await,
        }
    }

    /// Records both sharing choices and the terms each was made under
    /// (onboarding, Settings → About & updates, the consent prompt). The
    /// shell applies them to its sinks right after.
    pub async fn set_telemetry_choice(&self, req: &TelemetryChoice) -> AppResult<()> {
        let before = self.telemetry_settings().await;
        let TelemetryChoice { usage, errors, .. } = *req;
        let after = theodore_telemetry::Choice {
            usage: Some(usage),
            errors: Some(errors),
            usage_consent: consent_after(
                before.usage,
                usage,
                req.usage_consent,
                before.usage_consent,
            ),
            errors_consent: consent_after(
                before.errors,
                errors,
                req.errors_consent,
                before.errors_consent,
            ),
        };
        let mut rows = vec![
            (keys::SETTING_USAGE, serde_json::json!(usage)),
            (keys::SETTING_ERRORS, serde_json::json!(errors)),
        ];
        if after.usage_consent != before.usage_consent {
            rows.push((
                keys::SETTING_USAGE_CONSENT,
                serde_json::json!(after.usage_consent),
            ));
        }
        if after.errors_consent != before.errors_consent {
            rows.push((
                keys::SETTING_ERRORS_CONSENT,
                serde_json::json!(after.errors_consent),
            ));
        }
        let mut actions = Vec::new();
        for (key, value) in rows {
            let setting = Setting {
                key: key.into(),
                scope: SCOPE_USER.into(),
                value,
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
        // Before the shell applies this: `$identify` names the anon id, and
        // what it sent so far was promised to stay unlinked.
        if after.links_usage() && !before.choice().links_usage() {
            theodore_telemetry::renew_anon();
        }
        tracing::info!(usage, errors, "sharing choice recorded");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::Core;
    use crate::testkit::fixtures;
    use theodore_contract::{Setting, TelemetryChoice, models};
    use theodore_ports::{NewAction, SyncActionCode};
    use theodore_telemetry::config::{CONSENT_LINKED, SETTING_USAGE, SETTING_USAGE_CONSENT};

    fn choice(usage: bool, errors: bool) -> TelemetryChoice {
        TelemetryChoice {
            usage,
            errors,
            usage_consent: false,
            errors_consent: false,
        }
    }

    /// An install that said yes before the terms changed: the switch is
    /// recorded, the consent version isn't.
    async fn old_consent(core: &Core) {
        let setting = Setting {
            key: SETTING_USAGE.into(),
            scope: crate::settings::SCOPE_USER.into(),
            value: serde_json::json!(true),
        };
        core.apply(vec![NewAction {
            model: models::SETTING.into(),
            model_id: SETTING_USAGE.into(),
            action: SyncActionCode::U,
            data: Some(serde_json::to_value(&setting).unwrap()),
        }])
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn no_choice_until_one_is_recorded_then_each_is_kept() {
        let f = fixtures();
        let (core, _rx) = Core::start(f.deps());
        let s = core.telemetry_settings().await;
        assert_eq!((s.usage, s.errors), (None, None));
        core.set_telemetry_choice(&choice(true, false))
            .await
            .unwrap();
        let s = core.telemetry_settings().await;
        assert_eq!((s.usage, s.errors), (Some(true), Some(false)));
        core.set_telemetry_choice(&choice(false, true))
            .await
            .unwrap();
        let s = core.telemetry_settings().await;
        assert_eq!((s.usage, s.errors), (Some(false), Some(true)));
    }

    #[tokio::test]
    async fn a_new_yes_is_at_the_new_terms_and_a_no_holds_none() {
        let (core, _rx) = Core::start(fixtures().deps());
        core.set_telemetry_choice(&choice(true, false))
            .await
            .unwrap();
        let s = core.telemetry_settings().await;
        assert_eq!(s.usage_consent, CONSENT_LINKED);
        assert_eq!(s.errors_consent, 0);
        assert!(s.choice().links_usage());
        assert!(!s.choice().usage_needs_consent());
    }

    #[tokio::test]
    async fn a_yes_before_the_terms_changed_is_anonymous_and_needs_asking() {
        let (core, _rx) = Core::start(fixtures().deps());
        old_consent(&core).await;
        let s = core.telemetry_settings().await;
        assert_eq!(s.usage, Some(true));
        assert_eq!(s.usage_consent, 0);
        assert!(!s.choice().links_usage());
        assert!(s.choice().usage_needs_consent());
    }

    #[tokio::test]
    async fn agreeing_in_the_prompt_moves_it_to_the_new_terms() {
        let (core, _rx) = Core::start(fixtures().deps());
        old_consent(&core).await;
        core.set_telemetry_choice(&TelemetryChoice {
            usage_consent: true,
            ..choice(true, false)
        })
        .await
        .unwrap();
        let s = core.telemetry_settings().await;
        assert!(s.choice().links_usage());
        assert!(!s.choice().usage_needs_consent());
    }

    #[tokio::test]
    async fn a_switch_left_on_without_being_asked_stays_at_the_old_terms() {
        let (core, _rx) = Core::start(fixtures().deps());
        old_consent(&core).await;
        // Settings: errors flipped on, usage just comes along.
        core.set_telemetry_choice(&choice(true, true))
            .await
            .unwrap();
        let s = core.telemetry_settings().await;
        assert!(!s.choice().links_usage(), "usage wasn't touched");
        assert!(s.choice().links_errors(), "errors were turned on");
    }

    #[tokio::test]
    async fn stopping_clears_the_terms_and_turning_on_again_is_the_new_ones() {
        let (core, _rx) = Core::start(fixtures().deps());
        old_consent(&core).await;
        core.set_telemetry_choice(&choice(false, false))
            .await
            .unwrap();
        let s = core.telemetry_settings().await;
        assert_eq!((s.usage, s.usage_consent), (Some(false), 0));
        assert!(!s.choice().usage_needs_consent(), "a no isn't asked again");

        // Settings → Privacy: on again counts as agreeing to the new terms.
        core.set_telemetry_choice(&choice(true, false))
            .await
            .unwrap();
        let s = core.telemetry_settings().await;
        assert!(s.choice().links_usage());

        core.set_telemetry_choice(&choice(false, false))
            .await
            .unwrap();
        let rows = core
            .0
            .deps
            .store
            .query(models::SETTING, "key", SETTING_USAGE_CONSENT)
            .unwrap();
        let stored = crate::settings::pick_setting(rows, None);
        assert_eq!(stored, Some(serde_json::json!(0)));
    }
}
