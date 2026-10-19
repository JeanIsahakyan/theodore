//! Control spool: how `theodore sandbox …` drives a running sandbox.
//!
//! ```text
//! CLI ── write requests/<id>.json ──▶ sandbox ticker (every 250 ms)
//!                                        │ apply the Action
//! CLI ◀── read responses/<id>.json ──────┘
//! ```
//!
//! A directory instead of a socket: no listening port (nothing else on the
//! machine can reach it, no firewall prompt, no port clash between several
//! sandboxes), same-user file permissions, and a request written while the
//! app is down simply runs on its next start. The ticker also writes
//! `alive.json` each second, so the CLI can tell "no sandbox running" from
//! "slow to answer".

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use theodore_contract::SandboxStatus;
use theodore_domain::Millis;

use crate::error::{SandboxError, SandboxResult};
use crate::scenario::Action;
use crate::world::now_ms;

/// `alive.json` older than this means no sandbox is running.
const ALIVE_STALE_MS: Millis = 5_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    pub id: String,
    pub action: Action,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response {
    pub id: String,
    pub ok: bool,
    pub message: String,
    pub status: Option<SandboxStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Alive {
    pub pid: u32,
    pub at: Millis,
    pub scenario: String,
}

fn dir(root: &Path) -> PathBuf {
    root.join("control")
}

fn requests(root: &Path) -> PathBuf {
    dir(root).join("requests")
}

fn responses(root: &Path) -> PathBuf {
    dir(root).join("responses")
}

fn io(path: &Path) -> impl FnOnce(std::io::Error) -> SandboxError + '_ {
    move |e| SandboxError::Io(path.to_path_buf(), e)
}

/// Write-then-rename, so a reader never sees half a file.
fn write_atomic(path: &Path, value: &impl Serialize) -> SandboxResult<()> {
    let parent = path.parent().unwrap_or(path);
    std::fs::create_dir_all(parent).map_err(io(parent))?;
    let tmp = path.with_extension("tmp");
    let text = serde_json::to_vec_pretty(value).map_err(|e| SandboxError::State(e.to_string()))?;
    std::fs::write(&tmp, text).map_err(io(&tmp))?;
    std::fs::rename(&tmp, path).map_err(io(path))
}

pub fn write_alive(root: &Path, scenario: &str) -> SandboxResult<()> {
    write_atomic(
        &dir(root).join("alive.json"),
        &Alive {
            pid: std::process::id(),
            at: now_ms(),
            scenario: scenario.to_string(),
        },
    )
}

/// The running sandbox's heartbeat, if it is fresh.
pub fn alive(root: &Path) -> Option<Alive> {
    let text = std::fs::read_to_string(dir(root).join("alive.json")).ok()?;
    let alive: Alive = serde_json::from_str(&text).ok()?;
    (now_ms() - alive.at < ALIVE_STALE_MS).then_some(alive)
}

/// Pending requests, oldest first; each is removed once read.
pub fn take_requests(root: &Path) -> Vec<Request> {
    let Ok(entries) = std::fs::read_dir(requests(root)) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .collect();
    paths.sort();
    let mut out = Vec::new();
    for p in paths {
        let parsed = std::fs::read_to_string(&p)
            .ok()
            .and_then(|t| serde_json::from_str::<Request>(&t).ok());
        let _ = std::fs::remove_file(&p);
        if let Some(r) = parsed {
            out.push(r);
        }
    }
    out
}

pub fn respond(root: &Path, response: &Response) -> SandboxResult<()> {
    write_atomic(
        &responses(root).join(format!("{}.json", response.id)),
        response,
    )
}

/// CLI side: queue `action` and wait for its answer.
pub fn send(root: &Path, action: Action, timeout: Duration) -> SandboxResult<Response> {
    if alive(root).is_none() {
        return Err(SandboxError::Invalid(format!(
            "no sandbox is running on {} — start Theodore with THEODORE_SANDBOX=<scenario dir> \
             (and the same THEODORE_DATA_DIR) first",
            root.display()
        )));
    }
    let id = format!("{:013}-{}", now_ms(), std::process::id());
    write_atomic(
        &requests(root).join(format!("{id}.json")),
        &Request {
            id: id.clone(),
            action,
        },
    )?;
    let answer = responses(root).join(format!("{id}.json"));
    let start = Instant::now();
    while start.elapsed() < timeout {
        if let Ok(text) = std::fs::read_to_string(&answer) {
            let _ = std::fs::remove_file(&answer);
            return serde_json::from_str(&text).map_err(|e| SandboxError::State(e.to_string()));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(SandboxError::Invalid(format!(
        "the sandbox didn't answer within {}s",
        timeout.as_secs()
    )))
}
