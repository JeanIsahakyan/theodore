//! Spawn + supervise a CLI subprocess, lifecycle per plan §8.2:
//!
//! ```text
//! spawn (cwd = worktree) ─▶ stream ─▶ Done
//!    │                                      │
//!    ├─ cancel ─▶ SIGTERM ─▶ 5 s ─▶ SIGKILL │
//!    ├─ silent `stall_after_ms` ─▶ Stalled (keeps running)
//!    └─ exit ≠ 0 ─▶ Error with stderr tail
//! ```
//!
//! Stream parsing is CLI-specific (see `claude`, `codex`, `gemini`); this
//! module only owns the process, the channel, cancellation and stalls.

use std::path::PathBuf;
use std::time::Duration;

use theodore_ports::agent::{AgentError, AgentEvent, AgentRun};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const GRACE_PERIOD: Duration = Duration::from_secs(5);
const STDERR_TAIL_BYTES: usize = 4096;
const CHANNEL_CAPACITY: usize = 256;
/// Bound on draining stderr once the run loop is done. A dead agent's own
/// pipe closes immediately; this only guards against an orphaned grandchild
/// (e.g. a shell command the agent spawned and didn't wait on) that escaped
/// `terminate`'s process-group signal and is still holding the write end open.
const STDERR_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

/// Turns one stdout line into zero or more `AgentEvent`s. Each call is a pure
/// function of `(self, line)`: no I/O, deterministic, unit-testable directly
/// against recorded fixtures line by line.
pub trait LineParser: Send + 'static {
    fn on_line(&mut self, line: &str) -> Vec<AgentEvent>;
    /// The process exited and no terminal event (`Done`/`Error`) was seen yet.
    fn on_exit(&mut self, success: bool, stderr_tail: &str) -> AgentEvent;
}

pub struct SpawnSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    pub stall_after_ms: u64,
    /// Dropped only once the run loop ends (e.g. a Gemini temp settings file
    /// that must outlive the child process).
    pub guards: Vec<Box<dyn std::any::Any + Send>>,
}

fn is_terminal(e: &AgentEvent) -> bool {
    matches!(e, AgentEvent::Done { .. } | AgentEvent::Error { .. })
}

/// Spawn the process and start streaming. Returns once the child is running;
/// the returned `AgentRun::events` receiver carries everything from here on.
pub fn spawn_and_stream(
    spec: SpawnSpec,
    parser: Box<dyn LineParser>,
) -> Result<AgentRun, AgentError> {
    let stall_after = Duration::from_millis(spec.stall_after_ms.max(1));
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .current_dir(&spec.cwd)
        .env_clear()
        .envs(spec.env)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        // Own process group so `terminate` can signal the whole tree (an
        // agent's own shell-tool children included), not just this one pid.
        .process_group(0);

    let mut child = cmd.spawn().map_err(|e| AgentError::Spawn(e.to_string()))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let (tx, rx) = mpsc::channel(CHANNEL_CAPACITY);
    let cancel = CancellationToken::new();

    tokio::spawn(run_loop(
        child,
        stdout,
        stderr,
        tx,
        cancel.clone(),
        stall_after,
        parser,
        spec.guards,
    ));

    Ok(AgentRun { events: rx, cancel })
}

#[allow(clippy::too_many_arguments)]
async fn run_loop(
    mut child: Child,
    stdout: tokio::process::ChildStdout,
    mut stderr: tokio::process::ChildStderr,
    tx: mpsc::Sender<AgentEvent>,
    cancel: CancellationToken,
    stall_after: Duration,
    mut parser: Box<dyn LineParser>,
    _guards: Vec<Box<dyn std::any::Any + Send>>,
) {
    let mut lines = BufReader::new(stdout).lines();
    let mut terminal_sent = false;
    let mut stalled_notified = false;
    let mut exit_success: Option<bool> = None;

    // Drain stderr into a bounded tail buffer on its own task.
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf).await;
        if buf.len() > STDERR_TAIL_BYTES {
            buf.split_off(buf.len() - STDERR_TAIL_BYTES)
        } else {
            buf
        }
    });

    while !terminal_sent {
        tokio::select! {
            _ = cancel.cancelled() => {
                exit_success = Some(terminate(&mut child).await);
                break;
            }
            line = lines.next_line() => {
                match line {
                    Ok(Some(l)) => {
                        stalled_notified = false;
                        for ev in parser.on_line(&l) {
                            let terminal = is_terminal(&ev);
                            if terminal && terminal_sent {
                                continue;
                            }
                            terminal_sent |= terminal;
                            if tx.send(ev).await.is_err() {
                                return;
                            }
                        }
                    }
                    Ok(None) => break, // stdout closed; fall through to exit handling
                    Err(_) => break,
                }
            }
            _ = tokio::time::sleep(stall_after), if !stalled_notified => {
                stalled_notified = true;
                if tx.send(AgentEvent::Stalled).await.is_err() {
                    return;
                }
            }
        }
    }

    let stderr_tail = tokio::time::timeout(STDERR_DRAIN_TIMEOUT, stderr_task)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
    let tail_str = String::from_utf8_lossy(&stderr_tail).into_owned();

    if !terminal_sent {
        let success = match exit_success {
            Some(s) => s,
            None => child.wait().await.map(|s| s.success()).unwrap_or(false),
        };
        let ev = parser.on_exit(success, &tail_str);
        let _ = tx.send(ev).await;
    }
}

/// SIGTERM, then up to `GRACE_PERIOD` for a clean exit, else SIGKILL. Signals
/// the whole process group (`process_group(0)` at spawn made the child its
/// own group leader), so a shell command the agent spawned and didn't wait on
/// dies with it instead of lingering as an orphan.
async fn terminate(child: &mut Child) -> bool {
    if let Some(pid) = child.id() {
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(format!("-{pid}"))
            .status()
            .await;
    }
    match tokio::time::timeout(GRACE_PERIOD, child.wait()).await {
        Ok(status) => status.map(|s| s.success()).unwrap_or(false),
        Err(_) => {
            if let Some(pid) = child.id() {
                let _ = Command::new("kill")
                    .arg("-KILL")
                    .arg(format!("-{pid}"))
                    .status()
                    .await;
            }
            let _ = child.start_kill();
            child.wait().await.map(|s| s.success()).unwrap_or(false)
        }
    }
}
