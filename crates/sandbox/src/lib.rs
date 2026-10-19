#![forbid(unsafe_code)]

//! Sandbox host (docs/sandbox.md): Theodore's whole review flow against a
//! simulated, GitHub-like host with no network and no real repos at risk.
//!
//! ```text
//! scenario.json ──first run──▶ <data>/sandbox/remotes/<o>/<r>.git  (real bare repos)
//!                          └──▶ <data>/sandbox/state.json           (host state)
//!
//! Theodore ── HostAdapter ──▶ SandboxHost ──▶ World ◀── ticker (CI, auto-merge,
//!          ── GitCli (file://) ───────────────▲          queue, timeline, control)
//!                                             └── theodore sandbox … (control spool)
//! ```

pub mod control;
pub mod default_scenario;
pub mod error;
pub mod gitops;
pub mod host;
pub mod materialize;
pub mod scenario;
pub mod state;
pub mod world;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use theodore_contract::{SandboxEvent, SandboxFault, SandboxInfo, SandboxStatus};
use theodore_domain::{PrState, RepoRef};
use theodore_ports::MergeMethod;

pub use error::{SandboxError, SandboxResult};
pub use host::SandboxHost;
pub use scenario::{Action, AgentsMode, PrSel, Scenario};

use crate::materialize::side;
use crate::scenario::{ProjectSpec, ReviewerStateSpec, parse_duration};
use crate::state::{ReviewState, State};
use crate::world::{Locked, Refusal, World, now_ms};

/// Ticker period: CI transitions, timeline events and control requests are
/// noticed this fast.
const TICK_MS: u64 = 250;

/// Every fault name `set_fault` accepts, in display order.
pub const FAULTS: [&str; 9] = [
    "latency",
    "offline",
    "auth",
    "rate_limit",
    "server_errors",
    "not_found",
    "slow_merge_status",
    "merge_queue",
    "required_approvals",
];

/// A project to add to Theodore on the sandbox's first start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SeedProject {
    Host(RepoRef),
    Local(PathBuf),
}

/// Same shape as `theodore_git::RemoteUrls`.
pub type RemoteUrls = Arc<dyn Fn(&RepoRef) -> Option<String> + Send + Sync>;

#[derive(Clone)]
pub struct Sandbox {
    world: Arc<World>,
}

fn refusal(r: Refusal) -> SandboxError {
    match r {
        Refusal::NotFound(m) => SandboxError::Invalid(format!("not found: {m}")),
        Refusal::Validation(m) | Refusal::Conflict(m) | Refusal::Internal(m) => {
            SandboxError::Invalid(m)
        }
    }
}

/// `<data dir>/sandbox`: everything the sandbox owns.
pub fn root_of(data_dir: &Path) -> PathBuf {
    data_dir.join("sandbox")
}

impl Sandbox {
    /// Opens the sandbox for `scenario_dir` under `data_dir`, building the
    /// bare repos and the initial state on the first run.
    pub fn open(scenario_dir: &Path, data_dir: &Path) -> SandboxResult<Self> {
        let scenario = Scenario::load(scenario_dir)?;
        let scenario_dir = scenario_dir
            .canonicalize()
            .map_err(|e| SandboxError::Io(scenario_dir.to_path_buf(), e))?;
        let root = root_of(data_dir);
        std::fs::create_dir_all(&root).map_err(|e| SandboxError::Io(root.clone(), e))?;
        let state = match State::load(&root)? {
            Some(s) => s,
            None => {
                let epoch = now_ms();
                materialize::repos(&scenario, &scenario_dir, &root, epoch)?;
                let s = materialize::initial_state(&scenario, &root, epoch)?;
                s.save(&root)?;
                s
            }
        };
        // Repos/folders added to the scenario after the first run.
        materialize::repos(&scenario, &scenario_dir, &root, state.epoch)?;
        materialize::local_folders(&scenario, &root)?;
        Ok(Self {
            world: Arc::new(World::new(scenario, scenario_dir, root, state)),
        })
    }

    pub fn world(&self) -> &Arc<World> {
        &self.world
    }

    pub fn root(&self) -> &Path {
        &self.world.root
    }

    pub fn host(&self) -> Arc<SandboxHost> {
        Arc::new(SandboxHost::new(self.world.clone()))
    }

    /// For `GitCli::with_remote_urls`: every hosted repo maps to its bare
    /// repo; while the `offline` fault is on, to a path that doesn't exist.
    pub fn remote_urls(&self) -> RemoteUrls {
        let world = self.world.clone();
        Arc::new(move |repo: &RepoRef| {
            if !world.hosted_repo(&repo.owner, &repo.name) {
                return None;
            }
            if world.lock().st.faults.offline {
                return Some(format!(
                    "file://{}/offline/{}/{}.git",
                    world.root.display(),
                    repo.owner,
                    repo.name
                ));
            }
            Some(world.bare(&repo.owner, &repo.name).url())
        })
    }

    pub fn agents(&self) -> AgentsMode {
        self.world.scenario.agents
    }

    /// Projects to add on the first start; empty once `mark_projects_seeded`.
    pub fn projects_to_seed(&self) -> Vec<SeedProject> {
        if self.world.lock().st.projects_seeded {
            return Vec::new();
        }
        self.world
            .scenario
            .projects
            .iter()
            .filter_map(|p| match p {
                ProjectSpec::Host { repo } => {
                    let (owner, name) = repo.split_once('/')?;
                    Some(SeedProject::Host(RepoRef {
                        host: theodore_domain::HostKind::Github,
                        owner: owner.into(),
                        name: name.into(),
                    }))
                }
                ProjectSpec::Local { local, .. } => Some(SeedProject::Local(
                    materialize::local_dir(&self.world.root, local),
                )),
            })
            .collect()
    }

    pub fn mark_projects_seeded(&self) {
        let mut l = self.world.lock();
        l.st.projects_seeded = true;
        l.save();
    }

    pub fn info(&self) -> SandboxInfo {
        SandboxInfo {
            scenario: self.world.scenario.name.clone(),
            scenario_dir: self.world.scenario_dir.display().to_string(),
            data_dir: self
                .world
                .root
                .parent()
                .unwrap_or(&self.world.root)
                .display()
                .to_string(),
        }
    }

    pub fn status(&self) -> SandboxStatus {
        let l = self.world.lock();
        status_of(&l, self.info())
    }

    pub fn set_fault(
        &self,
        name: &str,
        on: bool,
        value: Option<f64>,
    ) -> SandboxResult<SandboxStatus> {
        let mut l = self.world.lock();
        set_fault(&mut l, name, on, value)?;
        l.save();
        Ok(status_of(&l, self.info()))
    }

    /// Fires a timeline event now (again, if it already fired).
    pub fn fire(&self, id: &str) -> SandboxResult<String> {
        let action = self
            .world
            .scenario
            .timeline
            .iter()
            .find(|e| e.id == id)
            .map(|e| e.action.clone())
            .ok_or_else(|| SandboxError::Invalid(format!("no timeline event {id}")))?;
        let msg = self.apply(&action)?;
        let mut l = self.world.lock();
        l.st.fired.insert(id.to_string());
        l.save();
        Ok(msg)
    }

    /// Applies one host event; returns a one-line description.
    pub fn apply(&self, action: &Action) -> SandboxResult<String> {
        if let Action::Fire { event } = action {
            return self.fire(event);
        }
        let mut l = self.world.lock();
        let out = apply(&mut l, action);
        l.save();
        out
    }

    /// One ticker step: CI and merge timers, due timeline events, control
    /// requests, heartbeat.
    pub fn tick(&self) {
        {
            let mut l = self.world.lock();
            let before = l.st.version;
            l.tick(now_ms());
            if l.st.version != before {
                l.save();
            }
        }
        let started = *self.world.started_at.lock().unwrap();
        let elapsed = now_ms() - started;
        // Claimed (marked fired) under the lock before running, so a manual
        // `fire` racing the ticker can't run a due event twice.
        let due: Vec<scenario::EventSpec> = {
            let mut l = self.world.lock();
            let due: Vec<scenario::EventSpec> = self
                .world
                .scenario
                .timeline
                .iter()
                .filter(|e| !l.st.fired.contains(&e.id))
                .filter(|e| {
                    e.at.as_deref()
                        .and_then(|a| parse_duration(a).ok())
                        .is_some_and(|at| elapsed >= at)
                })
                .cloned()
                .collect();
            for e in &due {
                l.st.fired.insert(e.id.clone());
            }
            if !due.is_empty() {
                l.save();
            }
            due
        };
        for e in due {
            match self.apply(&e.action) {
                Ok(m) => tracing::info!("sandbox timeline {}: {m}", e.id),
                Err(err) => tracing::warn!("sandbox timeline {} failed: {err}", e.id),
            }
        }
        let root = self.world.root.clone();
        for req in control::take_requests(&root) {
            let result = self.apply(&req.action);
            let (ok, message) = match result {
                Ok(m) => (true, m),
                Err(e) => (false, e.to_string()),
            };
            let _ = control::respond(
                &root,
                &control::Response {
                    id: req.id,
                    ok,
                    message,
                    status: Some(self.status()),
                },
            );
        }
        let _ = control::write_alive(&root, &self.world.scenario.name);
    }

    /// Starts the ticker. Timeline `at` offsets count from this call.
    pub fn spawn(&self) -> tokio::task::JoinHandle<()> {
        *self.world.started_at.lock().unwrap() = now_ms();
        let sandbox = self.clone();
        tokio::spawn(async move {
            loop {
                let s = sandbox.clone();
                let _ = tokio::task::spawn_blocking(move || s.tick()).await;
                tokio::time::sleep(Duration::from_millis(TICK_MS)).await;
            }
        })
    }
}

fn resolve(l: &Locked<'_>, sel: &PrSel) -> SandboxResult<usize> {
    match sel {
        PrSel::Number(n) => {
            let hits: Vec<usize> = (0..l.st.prs.len())
                .filter(|&i| l.st.prs[i].number == *n)
                .collect();
            match hits.as_slice() {
                [i] => Ok(*i),
                [] => Err(SandboxError::Invalid(format!("no PR #{n}"))),
                _ => Err(SandboxError::Invalid(format!(
                    "#{n} is ambiguous; use owner/repo#{n}"
                ))),
            }
        }
        PrSel::Ref(r) => {
            let r = r.trim_start_matches('#');
            if let Ok(n) = r.parse::<u64>() {
                return resolve(l, &PrSel::Number(n));
            }
            let (slug, n) = r
                .rsplit_once('#')
                .ok_or_else(|| SandboxError::Invalid(format!("bad PR {r}: use owner/repo#n")))?;
            let (owner, name) = slug
                .split_once('/')
                .ok_or_else(|| SandboxError::Invalid(format!("bad PR {r}: use owner/repo#n")))?;
            let n: u64 = n
                .parse()
                .map_err(|_| SandboxError::Invalid(format!("bad PR number in {r}")))?;
            l.find(owner, name, n).map_err(refusal)
        }
    }
}

fn apply(l: &mut Locked<'_>, action: &Action) -> SandboxResult<String> {
    let now = now_ms();
    let teammate = l.world.teammate();
    match action {
        Action::Push {
            pr,
            files,
            message,
            author,
        } => {
            let idx = resolve(l, pr)?;
            let sha = l
                .push(idx, files, message.as_deref(), author.as_deref(), now)
                .map_err(refusal)?;
            Ok(format!(
                "pushed {} to {}",
                &sha[..7.min(sha.len())],
                l.st.prs[idx].key()
            ))
        }
        Action::Comment {
            pr,
            path,
            line,
            side: s,
            body,
            author,
        } => {
            let idx = resolve(l, pr)?;
            let who = author.clone().unwrap_or(teammate);
            let (thread, _) =
                l.new_thread(idx, path, *line, side(*s), None, body.clone(), &who, now);
            Ok(format!(
                "{who} commented on {path}:{line} (thread {thread})"
            ))
        }
        Action::Reply {
            pr,
            thread,
            body,
            author,
        } => {
            let idx = resolve(l, pr)?;
            let who = author.clone().unwrap_or(teammate);
            l.reply(idx, thread.as_deref(), body.clone(), &who, now)
                .map_err(refusal)?;
            Ok(format!("{who} replied on {}", l.st.prs[idx].key()))
        }
        Action::Review {
            pr,
            author,
            state,
            body,
        } => {
            let idx = resolve(l, pr)?;
            let st = match state {
                ReviewerStateSpec::Requested => {
                    l.request_review(idx, std::slice::from_ref(author), &[], now)
                        .map_err(refusal)?;
                    return Ok(format!("review requested from {author}"));
                }
                ReviewerStateSpec::Approved => ReviewState::Approved,
                ReviewerStateSpec::ChangesRequested => ReviewState::ChangesRequested,
                ReviewerStateSpec::Commented => ReviewState::Commented,
            };
            l.add_review(idx, author, st, body.clone(), now);
            Ok(format!(
                "{author} reviewed {} ({st:?})",
                l.st.prs[idx].key()
            ))
        }
        Action::RequestReview { pr, user, team } => {
            let idx = resolve(l, pr)?;
            let users: Vec<String> = match (user, team) {
                (Some(u), _) => vec![u.clone()],
                (None, None) => vec![l.world.viewer().to_string()],
                (None, Some(_)) => vec![],
            };
            let teams: Vec<String> = team.iter().cloned().collect();
            l.request_review(idx, &users, &teams, now)
                .map_err(refusal)?;
            Ok(format!("review of {} requested", l.st.prs[idx].key()))
        }
        Action::Merge { pr, author } => {
            let idx = resolve(l, pr)?;
            let who = author
                .clone()
                .unwrap_or_else(|| l.st.prs[idx].author.clone());
            let sha = l
                .merge(idx, MergeMethod::Merge, &who, true, now)
                .map_err(refusal)?;
            Ok(format!(
                "{} merged by {who} ({})",
                l.st.prs[idx].key(),
                &sha[..7.min(sha.len())]
            ))
        }
        Action::Close { pr } => {
            let idx = resolve(l, pr)?;
            if !l.st.prs[idx].is_open() {
                return Err(SandboxError::Invalid("PR is not open".into()));
            }
            let frozen = l.base_head(idx);
            let p = &mut l.st.prs[idx];
            p.state = PrState::Closed;
            p.frozen = Some(frozen);
            p.auto_merge = None;
            p.queued_at = None;
            l.st.touch(idx, now);
            Ok(format!("{} closed", l.st.prs[idx].key()))
        }
        Action::Check { pr, name, status } => {
            let idx = resolve(l, pr)?;
            l.set_check(idx, name, *status);
            Ok(format!("{name} on {} is {status:?}", l.st.prs[idx].key()))
        }
        Action::Fault { name, on, value } => {
            set_fault(l, name, *on, *value)?;
            Ok(format!("fault {name} {}", if *on { "on" } else { "off" }))
        }
        Action::Fire { .. } => unreachable!("handled by Sandbox::apply"),
        Action::Status => Ok("ok".into()),
    }
}

fn set_fault(l: &mut Locked<'_>, name: &str, on: bool, value: Option<f64>) -> SandboxResult<()> {
    let f = &mut l.st.faults;
    let ms = |v: f64| v.max(0.0) as u64;
    match name {
        "latency" => {
            f.latency = on;
            if let Some(v) = value {
                f.latency_ms = ms(v);
            }
        }
        "offline" => f.offline = on,
        "auth" => f.auth = on,
        "rate_limit" => {
            f.rate_limit = on;
            if let Some(v) = value {
                f.rate_limit_reset_ms = ms(v * 1000.0);
            }
            l.st.rate_limit_reset_at = None;
        }
        "server_errors" => {
            f.server_errors = on;
            if let Some(v) = value {
                f.server_error_rate = v.clamp(0.0, 1.0);
            }
        }
        "not_found" => {
            f.not_found = on;
            if let Some(v) = value {
                let n = v as u64;
                if !f.not_found_prs.contains(&n) {
                    f.not_found_prs.push(n);
                }
            }
        }
        "slow_merge_status" => {
            f.slow_merge_status = on;
            if let Some(v) = value {
                f.slow_merge_status_ms = ms(v);
            }
        }
        "merge_queue" => f.merge_queue = on,
        "required_approvals" => {
            f.required_approvals = on;
            if let Some(v) = value {
                f.required_approvals_count = v.max(1.0) as u32;
            }
        }
        other => {
            return Err(SandboxError::Invalid(format!(
                "unknown fault {other}; one of {}",
                FAULTS.join(", ")
            )));
        }
    }
    // Merge gates read these: every open PR gets a new ETag.
    for i in 0..l.st.prs.len() {
        if l.st.prs[i].is_open() {
            l.st.bump(i);
        }
    }
    l.st.version += 1;
    Ok(())
}

fn status_of(l: &Locked<'_>, info: SandboxInfo) -> SandboxStatus {
    let f = &l.st.faults;
    let fault = |name: &str, on: bool, detail: String| SandboxFault {
        name: name.into(),
        on,
        detail,
    };
    let reset = match l.st.rate_limit_reset_at {
        Some(at) => format!("lifts in {}s", ((at - now_ms()).max(0) + 999) / 1000),
        None => format!(
            "lifts {}s after the first call",
            f.rate_limit_reset_ms / 1000
        ),
    };
    let faults = vec![
        fault(
            "latency",
            f.latency,
            format!("{} ms on every host call", f.latency_ms),
        ),
        fault(
            "offline",
            f.offline,
            "host and git calls fail to connect".into(),
        ),
        fault(
            "auth",
            f.auth,
            "every call answers 401 (token expired)".into(),
        ),
        fault(
            "rate_limit",
            f.rate_limit,
            format!("403 rate limited; {reset}"),
        ),
        fault(
            "server_errors",
            f.server_errors,
            format!("{:.0}% of calls answer 502", f.server_error_rate * 100.0),
        ),
        fault(
            "not_found",
            f.not_found,
            if f.not_found_prs.is_empty() {
                "no PRs listed".into()
            } else {
                format!(
                    "404 for {}",
                    f.not_found_prs
                        .iter()
                        .map(|n| format!("#{n}"))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            },
        ),
        fault(
            "slow_merge_status",
            f.slow_merge_status,
            format!("merge status takes {} ms", f.slow_merge_status_ms),
        ),
        fault(
            "merge_queue",
            f.merge_queue,
            "direct merges are refused; PRs merge through the queue".into(),
        ),
        fault(
            "required_approvals",
            f.required_approvals,
            format!("{} approvals required to merge", f.required_approvals_count),
        ),
    ];
    let events = l
        .world
        .scenario
        .timeline
        .iter()
        .map(|e| SandboxEvent {
            id: e.id.clone(),
            at_ms: e.at.as_deref().and_then(|a| parse_duration(a).ok()),
            label: e.label.clone().unwrap_or_else(|| e.action.label()),
            fired: l.st.fired.contains(&e.id),
        })
        .collect();
    SandboxStatus {
        info,
        faults,
        events,
        viewer: l.world.viewer().to_string(),
        prs: l.st.prs.len() as u32,
    }
}
