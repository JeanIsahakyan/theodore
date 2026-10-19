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

use crate::core_api::CoreApi;
use crate::events;

const STABLE_ENDPOINT: &str =
    "https://github.com/JeanIsahakyan/theodore/releases/latest/download/latest.json";
const BETA_ENDPOINT: &str =
    "https://github.com/JeanIsahakyan/theodore/releases/download/channel-beta/latest.json";
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

fn endpoint_for_channel(channel: &str) -> Url {
    let url = if channel == "beta" {
        BETA_ENDPOINT
    } else {
        STABLE_ENDPOINT
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
    let channel = core.update_channel().await;
    let endpoint = endpoint_for_channel(&channel);
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
        return Ok(None);
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| format!("download or signature check failed: {e}"))?;

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
}
