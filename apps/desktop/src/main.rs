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
    let cfg = match sandbox_arg(std::env::args().skip(1)) {
        Some(dir) => theodore_runtime::RuntimeConfig::sandbox(dir),
        None => theodore_runtime::RuntimeConfig::from_env(),
    };
    // Before anything else logs: the file sink under the data dir, stderr
    // in dev, the panic hook. Remote sinks wait for settings and consent.
    let telemetry = theodore_telemetry::init(theodore_telemetry::InitConfig {
        data_dir: cfg.data_dir.clone(),
        level: std::env::var(theodore_telemetry::config::ENV_LOG)
            .ok()
            .filter(|l| !l.trim().is_empty()),
        stderr: cfg!(debug_assertions)
            || std::env::var_os(theodore_telemetry::config::ENV_LOG_STDERR).is_some(),
        version: env!("CARGO_PKG_VERSION").into(),
        channel: String::new(),
        commit: env!("THEODORE_COMMIT").into(),
    });
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        commit = env!("THEODORE_COMMIT"),
        sandbox = cfg.sandbox.is_some(),
        fixtures = cfg.fixtures.is_some(),
        "Theodore starting"
    );
    let rt = match tauri::async_runtime::block_on(theodore_runtime::start(&cfg)) {
        Ok(rt) => rt,
        Err(e) => {
            tracing::error!(error.code = "app.start_failed", error = %format!("{e:#}"), "the core didn't start");
            telemetry.shutdown();
            panic!("starting the Theodore core: {e:#}");
        }
    };
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
    // No remote sinks in sandbox or fixture runs, whatever is configured.
    let remote = !is_sandbox && cfg.fixtures.is_none();
    let app_core = AppCore::new(core)
        .with_sandbox(sandbox)
        .with_remote_telemetry(remote);
    tauri::async_runtime::block_on(app_core.apply_telemetry());
    theodore_telemetry::product(theodore_telemetry::ProductEvent::AppStarted {
        version: env!("CARGO_PKG_VERSION").into(),
        channel: telemetry.meta().channel,
    });
    let api = Arc::new(app_core);

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
