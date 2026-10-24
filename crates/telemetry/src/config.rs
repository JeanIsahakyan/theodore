//! Where the remote sinks point and whether they may send
//! (docs/telemetry.md "Settings").
//!
//! ```text
//! endpoint/key: env (THEODORE_*) ─▶ setting (telemetry.*) ─▶ built in (option_env!)
//!               first one set wins; none ─▶ that sink isn't available
//! may send:     the user's choice (telemetry.usage / telemetry.errors);
//!               no choice yet ─▶ nothing is sent, nothing is queued
//! ```

use crate::otlp::{OtlpConfig, parse_headers};
use crate::posthog::PosthogConfig;

pub const ENV_OTLP_ENDPOINT: &str = "THEODORE_OTLP_ENDPOINT";
pub const ENV_OTLP_HEADERS: &str = "THEODORE_OTLP_HEADERS";
pub const ENV_POSTHOG_HOST: &str = "THEODORE_POSTHOG_HOST";
pub const ENV_POSTHOG_KEY: &str = "THEODORE_POSTHOG_KEY";
/// Log level or `tracing` directives (`debug`, `info,theodore_app=debug`).
pub const ENV_LOG: &str = "THEODORE_LOG";
/// Mirror the log to stderr outside debug builds too.
pub const ENV_LOG_STDERR: &str = "THEODORE_LOG_STDERR";

pub const SETTING_USAGE: &str = "telemetry.usage";
pub const SETTING_ERRORS: &str = "telemetry.errors";
pub const SETTING_OTLP_ENDPOINT: &str = "telemetry.otlp.endpoint";
pub const SETTING_OTLP_HEADERS: &str = "telemetry.otlp.headers";
pub const SETTING_POSTHOG_HOST: &str = "telemetry.posthog.host";
pub const SETTING_POSTHOG_KEY: &str = "telemetry.posthog.key";
pub const SETTING_LOG_LEVEL: &str = "log.level";

pub const DEFAULT_POSTHOG_HOST: &str = "https://us.i.posthog.com";

/// Compiled in when the build ran with these set (nightly and release
/// builds); the lowest-priority source. None are committed.
pub const BUILT_IN: Sources = Sources {
    otlp_endpoint: option_env!("THEODORE_OTLP_ENDPOINT"),
    otlp_headers: option_env!("THEODORE_OTLP_HEADERS"),
    posthog_host: option_env!("THEODORE_POSTHOG_HOST"),
    posthog_key: option_env!("THEODORE_POSTHOG_KEY"),
};

/// One source of sink settings.
#[derive(Debug, Clone, Copy, Default)]
pub struct Sources<'a> {
    pub otlp_endpoint: Option<&'a str>,
    pub otlp_headers: Option<&'a str>,
    pub posthog_host: Option<&'a str>,
    pub posthog_key: Option<&'a str>,
}

/// Which remote sinks exist in this build/run.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RemoteConfig {
    pub otlp: Option<OtlpConfig>,
    pub posthog: Option<PosthogConfig>,
}

/// The user's sharing choices; `None` until they chose.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Choice {
    pub usage: Option<bool>,
    pub errors: Option<bool>,
}

fn set(v: Option<&str>) -> Option<&str> {
    v.map(str::trim).filter(|s| !s.is_empty())
}

fn http_url(s: &str) -> Option<url::Url> {
    url::Url::parse(s)
        .ok()
        .filter(|u| matches!(u.scheme(), "http" | "https") && u.host().is_some())
}

impl RemoteConfig {
    /// Resolves each sink from the first source that sets it (`sources`
    /// in priority order). A sink's endpoint and credentials come from
    /// the same source. A malformed URL disables that sink.
    pub fn resolve(sources: &[Sources<'_>]) -> RemoteConfig {
        let otlp = sources.iter().find_map(|s| {
            let endpoint = set(s.otlp_endpoint)?;
            Some(http_url(endpoint).map(|u| {
                OtlpConfig::new(
                    u,
                    set(s.otlp_headers).map(parse_headers).unwrap_or_default(),
                )
            }))
        });
        let posthog = sources.iter().find_map(|s| {
            let key = set(s.posthog_key)?;
            let host = set(s.posthog_host).unwrap_or(DEFAULT_POSTHOG_HOST);
            Some(http_url(host).map(|u| PosthogConfig::new(u, key)))
        });
        RemoteConfig {
            otlp: otlp.flatten(),
            posthog: posthog.flatten(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_source_that_sets_a_sink_wins_whole() {
        let env = Sources {
            otlp_endpoint: Some("https://otlp.nr-data.net"),
            otlp_headers: Some("api-key=env"),
            ..Default::default()
        };
        let setting = Sources {
            otlp_endpoint: Some("https://other.example"),
            otlp_headers: Some("api-key=setting"),
            posthog_key: Some("phc_setting"),
            ..Default::default()
        };
        let c = RemoteConfig::resolve(&[env, setting]);
        let o = c.otlp.unwrap();
        assert_eq!(o.endpoint.as_str(), "https://otlp.nr-data.net/");
        assert_eq!(o.headers, vec![("api-key".into(), "env".into())]);
        let p = c.posthog.unwrap();
        assert_eq!(p.key, "phc_setting");
        assert_eq!(p.host.as_str(), "https://us.i.posthog.com/");
    }

    #[test]
    fn nothing_configured_means_no_sinks() {
        assert_eq!(
            RemoteConfig::resolve(&[Sources::default()]),
            RemoteConfig::default()
        );
        // Blank values and bad URLs don't count.
        let bad = Sources {
            otlp_endpoint: Some("  "),
            posthog_key: Some("k"),
            posthog_host: Some("ftp://nope"),
            ..Default::default()
        };
        assert_eq!(RemoteConfig::resolve(&[bad]), RemoteConfig::default());
    }
}
