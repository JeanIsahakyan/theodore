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
/// A single stdout "line" (between two `\n`s) longer than this is truncated
/// rather than buffered in full — a misbehaving or malicious agent CLI must
/// not be able to grow this process's memory without bound just by never
/// emitting a newline.
pub const MAX_STDOUT_LINE_BYTES: usize = 1024 * 1024;
/// Hard ceiling on one run's wall-clock time, independent of the stall
/// detector (which only catches *silence*, not a run that keeps talking
/// forever). `0` disables it. `AgentCli` sets this to `DEFAULT_MAX_RUNTIME_MS`
/// unless a future config wires up something else.
pub const DEFAULT_MAX_RUNTIME_MS: u64 = 30 * 60 * 1000;

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
    /// Hard cap on total run time; `0` disables it. See `DEFAULT_MAX_RUNTIME_MS`.
    pub max_runtime_ms: u64,
    /// Dropped only once the run loop ends (e.g. a Gemini temp settings file
    /// that must outlive the child process).
    pub guards: Vec<Box<dyn std::any::Any + Send>>,
    /// Where to record the child's pid while it runs, so a later process can
    /// reap it if Theodore dies without cleaning up (`reap_orphans`).
    pub pid_dir: Option<PathBuf>,
    /// For the log: `claude`, `codex`, `gemini`, and the CLI's version
    /// when known.
    pub agent: String,
    pub version: Option<String>,
}

/// What the log says about a run (docs/telemetry.md "Error codes").
#[derive(Clone)]
struct RunLog {
    agent: String,
    version: String,
    started: tokio::time::Instant,
}

impl RunLog {
    fn ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
}

/// The stderr tail sent with an `agent.crashed` record.
pub const LOGGED_STDERR_TAIL: usize = 2048;

/// Deletes the pid marker once the run loop ends.
struct PidMarker(PathBuf);

impl Drop for PidMarker {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Kill agent process groups recorded in `dir` by a previous Theodore process
/// that died without cleaning up. Only pids whose command is still an agent
/// CLI are signalled (pids get reused). Async (`tokio::process`, not
/// `std::process`) so a caller can run it without blocking the executing
/// worker thread; `AgentCli::with_pid_dir` spawns it instead of awaiting it
/// directly, so it never blocks startup either.
pub async fn reap_orphans(dir: &std::path::Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut killed = 0;
    for e in entries.flatten() {
        let path = e.path();
        let Some(pid) = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.parse::<u32>().ok())
        else {
            continue;
        };
        let comm = tokio::process::Command::new("ps")
            .args(["-o", "command=", "-p", &pid.to_string()])
            .output()
            .await
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        if ["claude", "codex", "gemini"]
            .iter()
            .any(|a| comm.contains(a))
        {
            let _ = tokio::process::Command::new("kill")
                .args(["-TERM", &format!("-{pid}")])
                .status()
                .await;
            killed += 1;
        }
        let _ = std::fs::remove_file(&path);
    }
    killed
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

    let log = RunLog {
        agent: spec.agent.clone(),
        version: spec.version.clone().unwrap_or_default(),
        started: tokio::time::Instant::now(),
    };
    let mut child = cmd.spawn().map_err(|e| {
        tracing::warn!(
            error.code = "agent.spawn_failed",
            agent = %log.agent,
            agent_version = %log.version,
            error = %e,
            "agent CLI failed to start"
        );
        AgentError::Spawn(e.to_string())
    })?;
    tracing::info!(agent = %log.agent, agent_version = %log.version, "agent run started");
    let mut guards = spec.guards;
    if let (Some(dir), Some(pid)) = (&spec.pid_dir, child.id())
        && std::fs::create_dir_all(dir).is_ok()
    {
        let marker = dir.join(pid.to_string());
        if std::fs::write(&marker, spec.program.display().to_string()).is_ok() {
            guards.push(Box::new(PidMarker(marker)));
        }
    }
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let (tx, rx) = mpsc::channel(CHANNEL_CAPACITY);
    let cancel = CancellationToken::new();

    let run_deadline = (spec.max_runtime_ms > 0)
        .then(|| tokio::time::Instant::now() + Duration::from_millis(spec.max_runtime_ms));

    // In the caller's span: the run's records keep the command's `op_id`.
    let span = tracing::info_span!("agent_run", agent = %log.agent, agent_version = %log.version);
    tokio::spawn(tracing::Instrument::instrument(
        run_loop(
            child,
            stdout,
            stderr,
            tx,
            cancel.clone(),
            stall_after,
            spec.max_runtime_ms,
            run_deadline,
            parser,
            guards,
            log,
        ),
        span,
    ));

    Ok(AgentRun { events: rx, cancel })
}

/// `deadline`'s `Sleep`, or a future that never resolves if there is none —
/// lets the runtime cap live as one more `tokio::select!` branch instead of
/// an `if`/`else` around the whole loop.
async fn sleep_until_or_pending(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(d) => tokio::time::sleep_until(d).await,
        None => std::future::pending().await,
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_loop(
    mut child: Child,
    stdout: tokio::process::ChildStdout,
    mut stderr: tokio::process::ChildStderr,
    tx: mpsc::Sender<AgentEvent>,
    cancel: CancellationToken,
    stall_after: Duration,
    max_runtime_ms: u64,
    run_deadline: Option<tokio::time::Instant>,
    mut parser: Box<dyn LineParser>,
    _guards: Vec<Box<dyn std::any::Any + Send>>,
    log: RunLog,
) {
    let mut reader = BufReader::new(stdout);
    let mut terminal_sent = false;
    let mut stalled_notified = false;
    let mut exit_success: Option<bool> = None;

    // Drain stderr into a bounded tail buffer on its own task, trimming as
    // it goes (never buffering the whole stream before trimming).
    let stderr_task = tokio::spawn(async move {
        let mut tail: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            match stderr.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => push_capped_tail(&mut tail, &chunk[..n], STDERR_TAIL_BYTES),
            }
        }
        tail
    });

    while !terminal_sent {
        tokio::select! {
            _ = cancel.cancelled() => {
                exit_success = Some(terminate(&mut child).await);
                tracing::info!(agent = %log.agent, duration_ms = log.ms(), "agent run cancelled");
                break;
            }
            _ = sleep_until_or_pending(run_deadline) => {
                let _ = terminate(&mut child).await;
                tracing::warn!(
                    error.code = "agent.timed_out",
                    agent = %log.agent,
                    agent_version = %log.version,
                    duration_ms = log.ms(),
                    max_runtime_ms,
                    "agent run hit its runtime cap and was stopped"
                );
                terminal_sent = true;
                let ev = AgentEvent::Error {
                    message: format!(
                        "agent run exceeded its {max_runtime_ms}ms runtime cap and was terminated"
                    ),
                    stderr_tail: String::new(),
                };
                let _ = tx.send(ev).await;
                break;
            }
            line = read_line_capped(&mut reader, MAX_STDOUT_LINE_BYTES) => {
                match line {
                    Ok(Some((l, truncated))) => {
                        if truncated {
                            tracing::warn!(
                                len = l.len(),
                                "agent stdout line exceeded the {}-byte cap; truncated",
                                MAX_STDOUT_LINE_BYTES
                            );
                        }
                        stalled_notified = false;
                        for ev in parser.on_line(&l) {
                            let terminal = is_terminal(&ev);
                            if terminal && terminal_sent {
                                continue;
                            }
                            terminal_sent |= terminal;
                            log_terminal(&log, &ev, None);
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
                tracing::warn!(
                    error.code = "agent.stalled",
                    agent = %log.agent,
                    agent_version = %log.version,
                    duration_ms = log.ms(),
                    silent_ms = stall_after.as_millis() as u64,
                    "agent went quiet"
                );
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
        let cancelled = exit_success.is_some();
        let (success, code) = match exit_success {
            Some(s) => (s, None),
            None => match child.wait().await {
                Ok(s) => (s.success(), s.code()),
                Err(_) => (false, None),
            },
        };
        let ev = parser.on_exit(success, &tail_str);
        if !cancelled {
            log_terminal(&log, &ev, Some((code, &tail_str)));
        }
        let _ = tx.send(ev).await;
    }
}

/// Logs how a run ended: `info` when done, `agent.crashed` with the exit
/// code and the end of stderr when it failed.
fn log_terminal(log: &RunLog, ev: &AgentEvent, exit: Option<(Option<i32>, &str)>) {
    match ev {
        AgentEvent::Done { .. } => {
            tracing::info!(agent = %log.agent, duration_ms = log.ms(), "agent run done");
        }
        AgentEvent::Error {
            message,
            stderr_tail,
        } => {
            let (code, tail) = match exit {
                Some((code, tail)) => (code, tail),
                None => (None, stderr_tail.as_str()),
            };
            let tail = tail_of(tail, LOGGED_STDERR_TAIL);
            tracing::warn!(
                error.code = "agent.crashed",
                agent = %log.agent,
                agent_version = %log.version,
                duration_ms = log.ms(),
                exit_code = code,
                stderr_tail = tail,
                error = %message,
                "agent run failed"
            );
        }
        _ => {}
    }
}

/// The last `max` bytes of `s`, on a char boundary.
fn tail_of(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut i = s.len() - max;
    while !s.is_char_boundary(i) {
        i += 1;
    }
    &s[i..]
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

/// Appends `chunk` to `tail`, keeping at most `max` trailing bytes —
/// trims as it goes instead of accumulating the whole stream first (the
/// difference between a bounded tail and an unbounded buffer that happens
/// to get truncated at the end).
fn push_capped_tail(tail: &mut Vec<u8>, chunk: &[u8], max: usize) {
    tail.extend_from_slice(chunk);
    if tail.len() > max {
        let excess = tail.len() - max;
        tail.drain(0..excess);
    }
}

/// Reads one `\n`-delimited line, capped at `max` bytes. Operates directly
/// on `reader`'s own buffer (`fill_buf`/`consume`) so a line with no
/// newline in sight is never copied into an ever-growing `Vec` the way
/// `AsyncBufReadExt::lines()` would: bytes beyond `max` are counted (to set
/// `truncated`) and discarded, never stored. Returns `Ok(None)` only at a
/// clean EOF with nothing left to return (including the trailing partial
/// line at EOF, which is still returned once).
async fn read_line_capped<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    max: usize,
) -> std::io::Result<Option<(String, bool)>> {
    let mut buf: Vec<u8> = Vec::new();
    let mut truncated = false;
    let mut any_bytes = false;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            break; // EOF
        }
        any_bytes = true;
        let newline_at = available.iter().position(|&b| b == b'\n');
        let take = newline_at.map_or(available.len(), |p| p + 1);
        let content = &available[..newline_at.unwrap_or(available.len())];
        if buf.len() < max {
            let room = max - buf.len();
            let n = room.min(content.len());
            buf.extend_from_slice(&content[..n]);
            truncated |= content.len() > n;
        } else {
            truncated |= !content.is_empty();
        }
        reader.consume(take);
        if newline_at.is_some() {
            break;
        }
    }
    if !any_bytes {
        return Ok(None);
    }
    Ok(Some((
        String::from_utf8_lossy(&buf).into_owned(),
        truncated,
    )))
}

#[cfg(test)]
mod bounded_io_tests {
    use super::*;
    use tokio::io::BufReader;

    #[test]
    fn capped_tail_never_grows_past_max() {
        let mut tail = Vec::new();
        for _ in 0..1000 {
            push_capped_tail(&mut tail, b"0123456789", 10);
            assert!(tail.len() <= 10);
        }
        assert_eq!(tail, b"0123456789");
    }

    #[tokio::test]
    async fn capped_line_under_the_limit_is_returned_whole() {
        let mut reader = BufReader::new(std::io::Cursor::new(b"hello\nworld\n".to_vec()));
        let (line, truncated) = read_line_capped(&mut reader, 1024).await.unwrap().unwrap();
        assert_eq!(line, "hello");
        assert!(!truncated);
        let (line, truncated) = read_line_capped(&mut reader, 1024).await.unwrap().unwrap();
        assert_eq!(line, "world");
        assert!(!truncated);
        assert!(read_line_capped(&mut reader, 1024).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn capped_line_over_the_limit_is_truncated_and_resyncs_on_the_next_line() {
        let input = format!("{}\nsecond\n", "a".repeat(50));
        let mut reader = BufReader::new(std::io::Cursor::new(input.into_bytes()));
        let (line, truncated) = read_line_capped(&mut reader, 10).await.unwrap().unwrap();
        assert_eq!(line, "a".repeat(10));
        assert!(truncated);
        // The overflow is discarded, not buffered — the next call picks up
        // cleanly at the next line rather than returning leftover "a"s.
        let (line, truncated) = read_line_capped(&mut reader, 10).await.unwrap().unwrap();
        assert_eq!(line, "second");
        assert!(!truncated);
    }

    #[tokio::test]
    async fn trailing_line_without_a_newline_at_eof_is_still_returned_once() {
        let mut reader = BufReader::new(std::io::Cursor::new(b"no newline".to_vec()));
        let (line, truncated) = read_line_capped(&mut reader, 1024).await.unwrap().unwrap();
        assert_eq!(line, "no newline");
        assert!(!truncated);
        assert!(read_line_capped(&mut reader, 1024).await.unwrap().is_none());
    }
}
