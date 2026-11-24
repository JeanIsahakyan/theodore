//! A restart with agents running (docs/releasing.md "Graceful update",
//! docs/spaces.md §7 "Restart with turns running"): every running turn is
//! paused and marked before the process exits, and the next launch
//! resumes it. Never a kill.
//!
//! ```text
//! Restart to update · theodore_update ──▶ restart_after_pausing
//!                                           └─▶ core.pause_for_restart ─▶ request_restart
//! ⌘Q / SIGTERM, turns running ──▶ ExitRequested ─▶ exit_after_pausing: prevent_exit
//!                                   └─▶ thread: pause (≤ PAUSE_BUDGET) ─▶ handle.exit
//!                                        ExitRequested again ─▶ paused: goes on
//! ```

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Runtime};
use theodore_app::PAUSE_BUDGET;
use theodore_contract::RestartReason;

use crate::core_api::CoreApi;

/// The pause happened (or nothing needed one): the next exit goes through.
static PAUSED: AtomicBool = AtomicBool::new(false);
/// `restart_after_pausing` was called: a second call (the UI asking again
/// while it waits) does nothing.
static RESTARTING: AtomicBool = AtomicBool::new(false);
/// Over the core's own budget: the thread then exits anyway.
const PAUSE_GRACE: Duration = Duration::from_secs(5);

/// Whether the running turns were paused already (or there were none).
pub fn paused() -> bool {
    PAUSED.load(Ordering::SeqCst)
}

/// Pauses every running turn, once per process.
pub async fn pause(core: &Arc<dyn CoreApi>, reason: RestartReason) {
    if PAUSED.swap(true, Ordering::SeqCst) {
        return;
    }
    match tokio::time::timeout(PAUSE_BUDGET + PAUSE_GRACE, core.pause_for_restart(reason)).await {
        Ok(report) => tracing::info!(
            paused = report.paused,
            killed = report.killed,
            "turns paused for the restart"
        ),
        Err(_) => tracing::warn!(
            error.code = "space.pause_timed_out",
            "pausing the turns didn't finish in time; restarting anyway"
        ),
    }
}

/// Restarts into the installed update: after `delay` (so a tool call's
/// answer reaches its agent first), the turns are paused, then the app
/// restarts. Once per process.
pub fn restart_after_pausing<R: Runtime>(
    app: AppHandle<R>,
    core: Arc<dyn CoreApi>,
    reason: RestartReason,
    delay: Duration,
) {
    if RESTARTING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        tracing::info!(?reason, "restarting after pausing the turns");
        pause(&core, reason).await;
        app.request_restart();
    });
}

/// `RunEvent::ExitRequested`: with turns running and not paused yet, the
/// exit waits: `true` means the caller prevents it, and the pause ends
/// with `handle.exit(code)`, which comes back here as paused. A
/// `request_restart` that was prevented still restarts then: its flag
/// stays set on the app.
pub fn exit_after_pausing(handle: AppHandle, core: Arc<dyn CoreApi>, code: Option<i32>) -> bool {
    if paused() {
        return false;
    }
    let running = tauri::async_runtime::block_on(core.running_turns());
    if running == 0 {
        PAUSED.store(true, Ordering::SeqCst);
        return false;
    }
    tracing::info!(running, "quitting with turns running: pausing them first");
    std::thread::spawn(move || {
        crate::quit::block_on_bounded(PAUSE_BUDGET + PAUSE_GRACE, async move {
            pause(&core, RestartReason::Quit).await;
        });
        PAUSED.store(true, Ordering::SeqCst);
        handle.exit(code.unwrap_or(0));
    });
    true
}
