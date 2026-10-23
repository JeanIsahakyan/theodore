//! The app's own URL scheme (`theodore://`), registered in the bundle's
//! `Info.plist` from `tauri.conf.json` (`plugins.deep-link`). Today it
//! carries one thing: the Theodore account sign-in redirect.
//!
//! ```text
//! browser ─▶ theodore://callback?code=…&state=… ─▶ macOS "Open Theodore?"
//!   ─▶ on_open_url ─▶ core.account_sign_in_callback ─▶ state check, exchange
//!        └─ handled ─▶ main window to the front
//! ```
//!
//! Only an app bundle can receive the scheme; a dev run or a bare binary
//! keeps the loopback redirect (`app_redirect`).

use std::path::Path;
use std::sync::Arc;

use tauri::{AppHandle, Runtime};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

use crate::CoreApi;

/// Must match `plugins.deep-link.desktop.schemes` in `tauri.conf.json`.
pub const SCHEME: &str = "theodore";

/// The account redirect for this process: the app URL scheme when running
/// from an app bundle (the only place macOS routes the scheme to), else
/// `None` (the core uses the loopback).
pub fn app_redirect() -> Option<&'static str> {
    let exe = std::env::current_exe().ok()?;
    (cfg!(target_os = "macos") && in_app_bundle(&exe)).then_some(theodore_app::APP_REDIRECT_URI)
}

/// `…/Name.app/Contents/MacOS/<exe>`.
pub fn in_app_bundle(exe: &Path) -> bool {
    let Some(macos) = exe.parent() else {
        return false;
    };
    let Some(contents) = macos.parent() else {
        return false;
    };
    let Some(bundle) = contents.parent() else {
        return false;
    };
    macos.file_name().is_some_and(|n| n == "MacOS")
        && contents.file_name().is_some_and(|n| n == "Contents")
        && bundle.extension().is_some_and(|e| e == "app")
}

/// Routes URLs the OS opens with the app: while running (`on_open_url`)
/// and the one it was launched with, if any (`get_current`).
pub fn listen<R: Runtime>(app: &AppHandle<R>, core: Arc<dyn CoreApi>) {
    let handle = app.clone();
    let on_open_core = core.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            open(&handle, on_open_core.clone(), url);
        }
    });
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            open(app, core.clone(), url);
        }
    }
}

fn open<R: Runtime>(app: &AppHandle<R>, core: Arc<dyn CoreApi>, url: Url) {
    if url.scheme() != SCHEME {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Never log the URL: it carries the authorization code.
        if core.account_sign_in_callback(url.into()).await {
            tracing::info!("account sign-in redirect handled");
            let _ = crate::commands::focus_main(&app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_executable_inside_an_app_bundle_counts() {
        assert!(in_app_bundle(Path::new(
            "/Applications/Theodore.app/Contents/MacOS/Theodore"
        )));
        for bare in [
            "/repo/target/release/Theodore",
            "/repo/target/debug/Theodore",
            "/x/Contents/MacOS/Theodore",
            "/x/Theodore.app/MacOS/Theodore",
            "Theodore",
        ] {
            assert!(!in_app_bundle(Path::new(bare)), "{bare}");
        }
    }

    #[test]
    fn the_registered_scheme_is_the_account_redirect_scheme() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let schemes = &conf["plugins"]["deep-link"]["desktop"]["schemes"];
        assert_eq!(schemes, &serde_json::json!([SCHEME]));
        let redirect = Url::parse(theodore_app::APP_REDIRECT_URI).unwrap();
        assert_eq!(redirect.scheme(), SCHEME);
    }
}
