//! Updater (plan §11.1): `tauri-plugin-updater` + `tauri-plugin-process`.
//! Checks on launch and every 6 h, downloads and installs in the background,
//! emits `update`. The actual restart is gated by `CoreApi::is_idle` and only
//! happens when the UI calls the `install_update` command.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::UpdaterExt;
use theodore_contract::UpdateInfo;
use url::Url;

use crate::build_info;
use crate::core_api::CoreApi;
use crate::events;

const STABLE_ENDPOINT: &str =
    "https://github.com/JeanIsahakyan/theodore/releases/latest/download/latest.json";
const BETA_ENDPOINT: &str =
    "https://github.com/JeanIsahakyan/theodore/releases/download/channel-beta/latest.json";
const STAGING_ENDPOINT: &str =
    "https://github.com/JeanIsahakyan/theodore/releases/download/channel-staging/latest.json";
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// Last update this process downloaded and installed on disk (macOS/Linux
/// need a relaunch to run it; see `CoreApi::install_update`).
#[derive(Default)]
pub struct UpdateState(pub Mutex<Option<UpdateInfo>>);

impl UpdateState {
    pub fn get(&self) -> Option<UpdateInfo> {
        self.0.lock().expect("UpdateState lock").clone()
    }
}

/// The channel a build updates from: a staging build only ever from
/// `staging`, whatever the setting says; any other build from the
/// `updates.channel` setting, `stable` or `beta`, never `staging`
/// (docs/releasing.md "Staging channel").
pub fn effective_channel(build_env: &str, setting: &str) -> &'static str {
    match (build_env, setting) {
        ("staging", _) => "staging",
        (_, "beta") => "beta",
        _ => "stable",
    }
}

fn endpoint_for_channel(channel: &str) -> Url {
    let url = match channel {
        "beta" => BETA_ENDPOINT,
        "staging" => STAGING_ENDPOINT,
        _ => STABLE_ENDPOINT,
    };
    Url::parse(url).expect("static updater endpoint is valid")
}

/// Checks for an update, and if one exists downloads and installs it (does
/// not restart). Updates `UpdateState` and emits `update` on success.
pub async fn check_and_install<R: Runtime>(
    app: &AppHandle<R>,
    core: &Arc<dyn CoreApi>,
) -> Option<UpdateInfo> {
    match check(app, core).await {
        Ok(info) => info,
        Err(err) => {
            tracing::warn!(%err, "updater: keeping current version");
            None
        }
    }
}

/// Like `check_and_install`, but says why a check failed (unreachable
/// endpoint, no release yet, bad signature) instead of reading as "no
/// update" — for the Settings "Check now" button.
pub async fn check<R: Runtime>(
    app: &AppHandle<R>,
    core: &Arc<dyn CoreApi>,
) -> Result<Option<UpdateInfo>, String> {
    // A sandbox window never reaches the network (docs/sandbox.md).
    if !core.updates_enabled().await {
        return Ok(None);
    }
    // Resolved again here, so no `CoreApi` can point a build at another
    // environment's releases.
    let channel = effective_channel(build_info::BUILD_ENV, &core.update_channel().await);
    let endpoint = endpoint_for_channel(channel);
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| format!("bad update endpoint: {e}"))?
        .build()
        .map_err(|e| format!("updater unavailable: {e}"))?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|e| format!("couldn't check for updates: {e}"))?
    else {
        tracing::info!(channel, "updater: up to date");
        return Ok(None);
    };
    tracing::info!(channel, version = %update.version, "updater: downloading");
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| format!("download or signature check failed: {e}"))?;
    // On disk now; this process keeps running the old build until a restart.
    tracing::info!(version = %update.version, "updater: installed, restart to apply");
    notify_installed(app, core, &update.version);

    let info = UpdateInfo {
        version: update.version.clone(),
        notes: update.body.clone().unwrap_or_default(),
        downloaded: true,
    };
    app.state::<UpdateState>()
        .0
        .lock()
        .expect("UpdateState lock")
        .replace(info.clone());
    events::emitter(app.clone()).update(info.clone());
    Ok(Some(info))
}

/// A system notification for an installed update, only while the window is
/// in the background: in front, the "Restart to update" pill says it.
fn notify_installed<R: Runtime>(app: &AppHandle<R>, core: &Arc<dyn CoreApi>, version: &str) {
    let focused = app
        .get_webview_window("main")
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false);
    if focused {
        return;
    }
    let Some(notifier) = app.try_state::<Arc<dyn crate::notify::Notifier>>() else {
        return;
    };
    crate::notify::notify_update(
        notifier.inner().as_ref(),
        UpdateWindow {
            app: app.clone(),
            core: core.clone(),
        },
        version,
    );
}

struct UpdateWindow<R: Runtime> {
    app: AppHandle<R>,
    core: Arc<dyn CoreApi>,
}

impl<R: Runtime> crate::notify::UpdateWindow for UpdateWindow<R> {
    fn focus(&self) {
        if let Err(err) = crate::commands::focus_main(&self.app) {
            tracing::warn!(?err, "failed to focus the window after an update click");
        }
    }

    fn restart_when_idle(&self) {
        let (app, core) = (self.app.clone(), self.core.clone());
        tauri::async_runtime::spawn(async move {
            if core.is_idle().await {
                app.request_restart();
            }
        });
    }
}

/// Runs `check_and_install` on launch and every 6 hours for the app's lifetime.
pub fn spawn_periodic_check<R: Runtime>(app: AppHandle<R>, core: Arc<dyn CoreApi>) {
    tauri::async_runtime::spawn(async move {
        loop {
            check_and_install(&app, &core).await;
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_and_beta_resolve_to_different_github_releases() {
        let stable = endpoint_for_channel("stable");
        let beta = endpoint_for_channel("beta");
        assert_ne!(stable, beta);
        assert!(stable.as_str().ends_with("latest.json"));
        assert!(beta.as_str().contains("channel-beta"));
    }

    #[test]
    fn unknown_channel_falls_back_to_stable() {
        assert_eq!(endpoint_for_channel("nope"), endpoint_for_channel("stable"));
    }

    #[test]
    fn a_staging_build_updates_from_staging_only() {
        for setting in ["stable", "beta", "staging", ""] {
            let channel = effective_channel("staging", setting);
            assert_eq!(channel, "staging");
            assert!(
                endpoint_for_channel(channel)
                    .as_str()
                    .ends_with("/releases/download/channel-staging/latest.json")
            );
        }
    }

    #[test]
    fn other_builds_never_see_the_staging_channel() {
        for env in ["production", "nightly", "dev"] {
            assert_eq!(effective_channel(env, "stable"), "stable");
            assert_eq!(effective_channel(env, "beta"), "beta");
            assert_eq!(effective_channel(env, "staging"), "stable");
            assert_eq!(effective_channel(env, "nope"), "stable");
            for setting in ["stable", "beta", "staging", ""] {
                let url = endpoint_for_channel(effective_channel(env, setting));
                assert!(!url.as_str().contains("channel-staging"), "{env}/{setting}");
            }
        }
    }
}
