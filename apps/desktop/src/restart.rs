//! A restart or a quit with agents running (docs/releasing.md "Graceful
//! update", docs/spaces.md §7 "Restart with turns running"): every running
//! turn is paused and marked before the process exits, and the next launch
//! resumes it. Never a kill.
//!
//! ```text
//! Restart to update · theodore_update ──▶ restart_after_pausing
//!                                           └─▶ pause ─▶ request_restart
//! handle.exit · request_restart ──▶ ExitRequested ─▶ exit_after_pausing: prevent_exit
//!                                     └─▶ thread: pause ─▶ handle.exit ─▶ ExitRequested: paused
//! ⌘Q · Dock Quit · AppleEvent quit · log out (macOS: NSApp terminate:)
//!                              ──▶ applicationShouldTerminate ─▶ terminate_after_pausing
//!                                     └─▶ NSTerminateLater; thread: pause ─▶ reply YES
//! SIGTERM / SIGINT ──▶ pause ─▶ stop spaces ─▶ telemetry ─▶ handle.exit
//! Exit, not paused yet (a path the above missed) ──▶ pause on the spot
//! ```
//!
//! Every path funnels into [`pause_then`]: nothing stops a space's commands
//! or tears the agents down before the pause has had its say.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use tauri::{AppHandle, Runtime};
use theodore_app::{PAUSE_BUDGET, RestartPaused};
use theodore_contract::RestartReason;

use crate::core_api::CoreApi;

/// What the quit paths need of the core: the two calls of the pause.
/// `Arc<dyn CoreApi>` is the one in the app; tests use a fake.
#[async_trait]
pub trait Pausable: Send + Sync + 'static {
    /// Space turns in flight.
    async fn running_turns(&self) -> usize;
    /// Pauses them all and marks each to resume on the next launch.
    async fn pause_for_restart(&self, reason: RestartReason) -> RestartPaused;
}

#[async_trait]
impl Pausable for Arc<dyn CoreApi> {
    async fn running_turns(&self) -> usize {
        CoreApi::running_turns(&**self).await
    }
    async fn pause_for_restart(&self, reason: RestartReason) -> RestartPaused {
        CoreApi::pause_for_restart(&**self, reason).await
    }
}

/// A pause began (or nothing needed one): a second path joins it.
static STARTED: AtomicBool = AtomicBool::new(false);
/// The pause ended (or nothing needed one): the next exit goes through.
static PAUSED: AtomicBool = AtomicBool::new(false);
/// `restart_after_pausing` was called: a second call (the UI asking again
/// while it waits) does nothing.
static RESTARTING: AtomicBool = AtomicBool::new(false);
/// Over the core's own budget: the thread then exits anyway.
const PAUSE_GRACE: Duration = Duration::from_secs(5);
/// The most any quit path waits for the pause, in all.
pub const PAUSE_DEADLINE: Duration = Duration::from_secs(PAUSE_BUDGET.as_secs() + 5);

/// Whether the running turns were paused already (or there were none).
pub fn paused() -> bool {
    PAUSED.load(Ordering::SeqCst)
}

/// Whether a pause is under way: a quit that comes now waits for it
/// instead of starting another or going through.
pub fn pausing() -> bool {
    STARTED.load(Ordering::SeqCst) && !paused()
}

/// Pauses every running turn, once per process. A second caller while the
/// first pauses waits for it (the callers bound their own wait).
pub async fn pause(core: &impl Pausable, reason: RestartReason) {
    if STARTED.swap(true, Ordering::SeqCst) {
        while !paused() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
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
    PAUSED.store(true, Ordering::SeqCst);
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

/// How a quit path waits for the pause ([`pause_then`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wait {
    /// On a thread of its own; `then` runs there when the pause is done.
    /// The caller returns at once and the exit comes back through `then`.
    Deferred,
    /// On the calling thread: the caller is already past the point where
    /// the exit can wait, so it blocks (≤ [`PAUSE_DEADLINE`]).
    Blocking,
}

/// A quit's one question: with turns running and not paused yet, pause
/// them, then run `then` (the exit itself). Returns `false` when nothing
/// needs pausing (`then` doesn't run: the caller exits as it was going
/// to) and `true` when the pause was started or done.
///
/// `running_turns` is asked off the async runtime: every caller is on the
/// main thread or a signal thread, never inside a tokio task.
pub fn pause_then(core: impl Pausable, wait: Wait, then: impl FnOnce() + Send + 'static) -> bool {
    if paused() {
        return false;
    }
    if pausing() {
        tracing::info!(
            ?wait,
            "quitting while the turns are being paused: waiting for that"
        );
    } else {
        let running = tauri::async_runtime::block_on(core.running_turns());
        if running == 0 {
            STARTED.store(true, Ordering::SeqCst);
            PAUSED.store(true, Ordering::SeqCst);
            return false;
        }
        tracing::info!(
            running,
            ?wait,
            "quitting with turns running: pausing them first"
        );
    }
    let work = move || {
        // Joins a pause under way, or starts the one.
        crate::quit::block_on_bounded(PAUSE_DEADLINE, async move {
            pause(&core, RestartReason::Quit).await;
        });
        // Over the deadline: the exit goes on anyway, nothing waits again.
        STARTED.store(true, Ordering::SeqCst);
        PAUSED.store(true, Ordering::SeqCst);
        then();
    };
    match wait {
        Wait::Deferred => {
            std::thread::spawn(work);
        }
        Wait::Blocking => work(),
    }
    true
}

/// `RunEvent::ExitRequested`: with turns running and not paused yet, the
/// exit waits: `true` means the caller prevents it, and the pause ends
/// with `handle.exit(code)`, which comes back here as paused. A
/// `request_restart` that was prevented still restarts then: its flag
/// stays set on the app.
pub fn exit_after_pausing(handle: AppHandle, core: Arc<dyn CoreApi>, code: Option<i32>) -> bool {
    pause_then(core, Wait::Deferred, move || {
        handle.exit(code.unwrap_or(0));
    })
}

/// `RunEvent::Exit`: the last stop before the process goes. A quit that
/// reached it without the pause (a path the hooks above missed) pauses on
/// the spot, blocking, so the agents are still marked and resumed rather
/// than killed by the teardown that follows.
pub fn pause_before_teardown(core: impl Pausable) {
    if pause_then(core, Wait::Blocking, || {}) {
        tracing::warn!(
            error.code = "quit.unhooked",
            "the exit came without a pause first: paused the turns at the last moment"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::sync::atomic::AtomicUsize;

    /// A core with `running` turns: `pause_for_restart` records its
    /// calls and ends them.
    struct Turns {
        running: AtomicUsize,
        pauses: Mutex<Vec<RestartReason>>,
        /// How long the agents take to stop.
        takes: Duration,
    }

    #[async_trait]
    impl Pausable for Arc<Turns> {
        async fn running_turns(&self) -> usize {
            self.running.load(Ordering::SeqCst)
        }
        async fn pause_for_restart(&self, reason: RestartReason) -> RestartPaused {
            tokio::time::sleep(self.takes).await;
            let paused = self.running.swap(0, Ordering::SeqCst);
            self.pauses.lock().unwrap().push(reason);
            RestartPaused { paused, killed: 0 }
        }
    }

    /// The process-wide flags, reset for a test and restored after. Tests
    /// of this module run one at a time for it.
    struct Flags(#[allow(dead_code)] std::sync::MutexGuard<'static, ()>);

    impl Flags {
        fn take() -> Self {
            static ONE: Mutex<()> = Mutex::new(());
            let guard = ONE.lock().unwrap_or_else(|p| p.into_inner());
            Self::reset();
            Self(guard)
        }

        fn reset() {
            STARTED.store(false, Ordering::SeqCst);
            PAUSED.store(false, Ordering::SeqCst);
        }
    }

    impl Drop for Flags {
        fn drop(&mut self) {
            Self::reset();
        }
    }

    fn turns(running: usize) -> Arc<Turns> {
        Arc::new(Turns {
            running: AtomicUsize::new(running),
            pauses: Mutex::new(Vec::new()),
            takes: Duration::ZERO,
        })
    }

    #[test]
    fn the_deadline_covers_the_budget_and_the_grace() {
        assert_eq!(PAUSE_DEADLINE, PAUSE_BUDGET + PAUSE_GRACE);
    }

    #[test]
    fn nothing_running_lets_the_exit_through_and_counts_as_paused() {
        let _flags = Flags::take();
        let core = turns(0);
        let ran = Arc::new(AtomicBool::new(false));
        let then = ran.clone();
        assert!(!pause_then(core.clone(), Wait::Blocking, move || {
            then.store(true, Ordering::SeqCst)
        }));
        assert!(!ran.load(Ordering::SeqCst), "the caller exits on its own");
        assert!(paused());
        assert!(core.pauses.lock().unwrap().is_empty());
    }

    #[test]
    fn turns_running_are_paused_as_a_quit_before_the_exit_runs() {
        let _flags = Flags::take();
        let core = turns(2);
        let order = Arc::new(Mutex::new(Vec::<&'static str>::new()));
        let seen = order.clone();
        assert!(pause_then(core.clone(), Wait::Blocking, move || {
            seen.lock().unwrap().push("exit");
        }));
        assert_eq!(
            core.pauses.lock().unwrap().as_slice(),
            &[RestartReason::Quit]
        );
        assert_eq!(order.lock().unwrap().as_slice(), &["exit"]);
        assert!(paused());
        assert_eq!(core.running.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_deferred_pause_returns_at_once_and_exits_from_its_thread() {
        let _flags = Flags::take();
        let core = turns(1);
        let (tx, rx) = std::sync::mpsc::channel();
        assert!(pause_then(core.clone(), Wait::Deferred, move || {
            let _ = tx.send(std::thread::current().id());
        }));
        let exit_thread = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the exit ran");
        assert_ne!(exit_thread, std::thread::current().id());
        assert!(paused());
        assert_eq!(core.pauses.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_second_quit_after_the_pause_goes_straight_through() {
        let _flags = Flags::take();
        let core = turns(1);
        assert!(pause_then(core.clone(), Wait::Blocking, || {}));
        // The exit that follows (ExitRequested, applicationShouldTerminate
        // again): no second pause, nothing prevented.
        assert!(!pause_then(core.clone(), Wait::Blocking, || {
            panic!("no exit of its own")
        }));
        assert_eq!(core.pauses.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_quit_during_a_pause_waits_for_it_instead_of_slipping_through() {
        let _flags = Flags::take();
        let core = Arc::new(Turns {
            running: AtomicUsize::new(1),
            pauses: Mutex::new(Vec::new()),
            takes: Duration::from_millis(300),
        });
        let (tx, rx) = std::sync::mpsc::channel();
        assert!(pause_then(core.clone(), Wait::Deferred, move || {
            let _ = tx.send(());
        }));
        std::thread::sleep(Duration::from_millis(50));
        assert!(pausing());
        assert!(!paused());
        // ⌘Q again, or the signal, meanwhile: it waits for the pause under
        // way, and runs its exit only once the turns are paused.
        let start = std::time::Instant::now();
        assert!(pause_then(core.clone(), Wait::Blocking, || {}));
        assert!(paused());
        assert!(
            start.elapsed() >= Duration::from_millis(150),
            "{:?}",
            start.elapsed()
        );
        rx.recv_timeout(Duration::from_secs(10))
            .expect("the first exit ran too");
        assert_eq!(core.pauses.lock().unwrap().len(), 1, "one pause, not two");
    }

    #[test]
    fn the_last_moment_pause_runs_only_when_the_hooks_missed() {
        let _flags = Flags::take();
        let core = turns(1);
        pause_before_teardown(core.clone());
        assert_eq!(core.pauses.lock().unwrap().len(), 1);
        pause_before_teardown(core.clone());
        assert_eq!(core.pauses.lock().unwrap().len(), 1);
    }
}
