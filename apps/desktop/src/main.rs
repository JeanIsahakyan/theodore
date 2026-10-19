#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;

use theodore_desktop::app_core::AppCore;
use theodore_desktop::{export_bindings, run};
use tokio::sync::broadcast::error::RecvError;

/// `cargo run -p theodore-desktop -- --export-bindings` writes
/// `ui/src/gen/bindings.ts` without opening a window (used by CI and by hand
/// after changing a command signature); otherwise launches the app.
///
/// `THEODORE_FIXTURES=<dir>` runs on fixture adapters (plan §12.1);
/// `THEODORE_DATA_DIR` overrides `~/.theodore`.
fn main() {
    if std::env::args().any(|a| a == "--export-bindings") {
        let out = "ui/src/gen/bindings.ts";
        export_bindings(out).expect("export TS bindings");
        println!("wrote {out}");
        return;
    }

    theodore_desktop::shell_path::inherit_login_path();
    tracing_subscriber::fmt::init();
    let cfg = theodore_runtime::RuntimeConfig::from_env();
    let rt = tauri::async_runtime::block_on(theodore_runtime::start(&cfg))
        .expect("starting the Theodore core");
    let theodore_runtime::Runtime {
        core, receivers, ..
    } = rt;
    let api = Arc::new(AppCore::new(core));

    run(api, move |events| {
        let mut sync = receivers.sync;
        let mut ephemeral = receivers.ephemeral;
        let ev = events.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                match sync.recv().await {
                    Ok(frame) => ev.sync(frame),
                    // The UI notices the gap from frame ids and calls catch_up.
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => break,
                }
            }
        });
        tauri::async_runtime::spawn(async move {
            loop {
                match ephemeral.recv().await {
                    Ok(e) => events.ephemeral(e),
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => break,
                }
            }
        });
    });
}
