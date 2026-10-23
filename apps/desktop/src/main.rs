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
/// `THEODORE_SANDBOX=<dir>` or `--sandbox <dir>` runs against the sandbox
/// host (docs/sandbox.md); `THEODORE_DATA_DIR` overrides `~/.theodore`
/// (`~/.theodore-sandbox` in sandbox mode).
fn main() {
    if std::env::args().any(|a| a == "--export-bindings") {
        let out = "ui/src/gen/bindings.ts";
        export_bindings(out).expect("export TS bindings");
        println!("wrote {out}");
        return;
    }

    theodore_desktop::shell_path::inherit_login_path();
    tracing_subscriber::fmt::init();
    let cfg = match sandbox_arg(std::env::args().skip(1)) {
        Some(dir) => theodore_runtime::RuntimeConfig::sandbox(dir),
        None => theodore_runtime::RuntimeConfig::from_env(),
    };
    let rt = tauri::async_runtime::block_on(theodore_runtime::start(&cfg))
        .expect("starting the Theodore core");
    let theodore_runtime::Runtime {
        core,
        receivers,
        sandbox,
        ..
    } = rt;
    let is_sandbox = sandbox.is_some();
    // An app bundle receives `theodore://`: the account sign-in returns
    // there instead of the loopback (unless a redirect is configured).
    core.set_account_app_redirect(theodore_desktop::deep_link::app_redirect());
    let api = Arc::new(AppCore::new(core).with_sandbox(sandbox));

    run(api, is_sandbox, move |events| {
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

/// `--sandbox <dir>` or `--sandbox=<dir>`.
fn sandbox_arg(mut args: impl Iterator<Item = String>) -> Option<std::path::PathBuf> {
    while let Some(a) = args.next() {
        if a == "--sandbox" {
            return args.next().map(Into::into);
        }
        if let Some(dir) = a.strip_prefix("--sandbox=") {
            return Some(dir.into());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::sandbox_arg;

    #[test]
    fn sandbox_flag_takes_a_directory_both_ways() {
        let args = |v: &[&str]| {
            v.iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
                .into_iter()
        };
        assert_eq!(sandbox_arg(args(&["--sandbox", "s"])), Some("s".into()));
        assert_eq!(
            sandbox_arg(args(&["x", "--sandbox=d/s"])),
            Some("d/s".into())
        );
        assert_eq!(sandbox_arg(args(&["--other"])), None);
    }
}
