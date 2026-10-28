//! Orchestration (plan §5.1): pre-pass → relatedness graph → prompt →
//! agent → validate → one repair call → `repair_with_other` fallback.
//! Large PRs run one chunk per group of related files, then a merge pass
//! over the group summaries.
//!
//! With `GroupingOptions::stream`, each group is published the moment the
//! agent has written it, so a reviewer can start reading before the run
//! ends (docs/eval/streamed-groups.md):
//!
//! ```text
//! delta ─▶ GroupStream ─▶ group closed ─▶ publish (Stage::Streamed)
//! chunk lands (validated, repaired) ─▶ replaces its previews ─▶ publish (Stage::Chunk)
//! all chunks ─▶ merge pass orders them ─▶ returned report (final)
//! ```
//!
//! Every publication is `in_progress`; only the returned grouping is final.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

use futures::stream::{self, StreamExt};
use theodore_domain::grouping::{self, GroupingError, RepoContext};
use theodore_domain::{AgentId, Group, GroupId, Grouping, Hunk, HunkId, Revision, Sha, Usage};
use theodore_ports::{AgentEvent, AgentMode, AgentPort, AgentRequest};

use crate::coarsen;
use crate::graph::RelGraph;
use crate::prepass::{self, HiddenReason, PrePass};
use crate::prompt::{self, PromptBudget, PromptChunk, PromptPart};
use crate::schema;
use crate::target;

/// Chunk prompts run concurrently, capped at this many in flight at once —
/// enough to cut wall time on a large, multi-directory PR without hammering
/// the agent CLI with dozens of simultaneous processes.
const DEFAULT_CHUNK_CONCURRENCY: usize = 3;

/// Everything the prompt needs about the PR beyond the diff itself. Empty
/// when grouping a bare diff file with no host context.
#[derive(Debug, Clone, Default)]
pub struct PrMeta {
    pub title: String,
    pub body: String,
    /// Commit titles, oldest first.
    pub commits: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct GroupingOptions {
    pub agent: AgentId,
    /// Overrides the agent CLI's own default model (e.g. `"sonnet"`,
    /// `"haiku"`) — forwarded to `AgentRequest::model`. `None` keeps
    /// whatever the agent CLI defaults to.
    pub model: Option<String>,
    pub budget: PromptBudget,
    /// Forwarded to `AgentRequest::stall_after_ms`.
    pub stall_after_ms: u64,
    /// Max number of chunk prompts run concurrently, for large PRs split
    /// into several per-directory prompts (plan §5.2).
    pub chunk_concurrency: usize,
    /// Forwarded to `AgentRequest::user_mcp` (the `agents.user_mcp`
    /// setting). Off by default, so evals don't depend on a machine's MCP
    /// servers.
    pub user_mcp: bool,
    /// Publish each group the moment the agent has written it
    /// (`Stage::Streamed`), parsed from the answer as it streams in, and
    /// each chunk's final groups as it lands (`Stage::Chunk`). The final
    /// grouping is still made from the whole answers, validated and
    /// repaired as without it. Only Claude Code streams text: the app
    /// turns this on for Claude runs, the CLI eval with `--stream`.
    pub stream: bool,
}

impl Default for GroupingOptions {
    fn default() -> Self {
        Self {
            agent: AgentId::Claude,
            model: None,
            budget: PromptBudget::default(),
            stall_after_ms: 90_000,
            chunk_concurrency: DEFAULT_CHUNK_CONCURRENCY,
            user_mcp: false,
            stream: false,
        }
    }
}

/// Where a streaming run is when it publishes a grouping (`OnProgress`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// Chunk `chunk`'s answer, still being written, has `groups` groups so
    /// far. They are previews: the chunk's final groups replace them when
    /// it lands.
    Streamed { chunk: usize, groups: usize },
    /// `done` of `of` chunks have landed (validated, repaired if needed).
    /// Multi-chunk PRs only: a single chunk landing is the final grouping.
    Chunk { done: usize, of: usize },
}

/// A grouping published mid-run. Always `in_progress`: its groups are
/// provisional and some hunks may be in none yet.
#[derive(Debug, Clone, Copy)]
pub struct Progress<'a> {
    pub stage: Stage,
    pub grouping: &'a Grouping,
    pub elapsed_ms: u64,
}

/// Called with each grouping a streaming run publishes, in order.
pub type OnProgress<'a> = &'a (dyn Fn(Progress<'_>) + Send + Sync);

/// When a streaming run's groups came out of the answers, from its start.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StreamTimings {
    /// Each streamed group, in arrival order across chunks.
    pub group_ms: Vec<u64>,
    /// When each chunk's first answer ended, in chunk order.
    pub answer_ms: Vec<u64>,
}

#[derive(Debug, Clone)]
pub struct GroupingReport {
    pub grouping: Grouping,
    /// Total agent calls made (initial + repairs + merge pass).
    pub attempts: u32,
    /// No repair and no "Other" fallback was needed anywhere.
    pub valid_first_try: bool,
    pub usage: Usage,
    pub duration_ms: u64,
    /// When the first group was shown: the first publication of a
    /// streaming run; `duration_ms` for a run that published nothing.
    pub first_group_ms: u64,
    /// Agent calls the diff was split into (0: no agent call was needed).
    pub chunks: u32,
    /// Empty unless `GroupingOptions::stream`.
    pub stream: StreamTimings,
}

#[derive(Debug, thiserror::Error)]
pub enum GroupingPipelineError {
    #[error("agent: {0}")]
    Agent(#[from] theodore_ports::AgentError),
    #[error("agent run ended without Done or Error")]
    NoDone,
    #[error("agent run failed: {0}")]
    AgentRun(String),
    /// `theodore_domain::interdiff::hunk_id` identifies a hunk by `(path,
    /// normalized added/deleted line text)` — deliberately not by line
    /// position, so the id survives context shifts across pushes (plan §4).
    /// That means two *different* physical hunks in the same file collide
    /// to one `HunkId` whenever a PR repeats a mechanically-identical
    /// one-line edit more than once in it — seen on real PRs (tokio#8587,
    /// rust-analyzer#23173: the same find/replace line applied at several
    /// call sites in one file). `grouping::validate`'s known-id set is a
    /// `BTreeSet<&HunkId>`, so it can't tell those apart either: without
    /// this check it would report "valid" while silently dropping every
    /// occurrence but one from the grouping. Caught here instead, before
    /// any agent call, rather than producing that misleadingly "valid"
    /// result.
    #[error(
        "revision has {} hunk id(s) shared by more than one physical hunk — \
         a mechanically-identical edit repeated in one file, which the \
         (path, content) hunk id can't distinguish (not a grouping bug): {}",
        .0.len(),
        display_ids(.0)
    )]
    DuplicateHunkIds(Vec<HunkId>),
}

fn display_ids(ids: &[HunkId]) -> String {
    ids.iter()
        .map(HunkId::as_str)
        .collect::<Vec<_>>()
        .join(", ")
}

/// Hunk ids that label more than one physical hunk in `rev`. Should always
/// be empty — `HunkId` is meant to be unique per physical hunk — but nothing
/// upstream of this pipeline currently guarantees it.
fn duplicate_hunk_ids(rev: &Revision) -> Vec<HunkId> {
    let mut counts: BTreeMap<&HunkId, u32> = BTreeMap::new();
    for h in rev.hunks() {
        *counts.entry(&h.id).or_default() += 1;
    }
    counts
        .into_iter()
        .filter(|(_, n)| *n > 1)
        .map(|(id, _)| id.clone())
        .collect()
}

/// Run the full grouping pipeline against one revision, from the diff alone.
pub async fn group_revision(
    agent: &dyn AgentPort,
    pr: &PrMeta,
    rev: &Revision,
    cwd: &Path,
    opts: &GroupingOptions,
) -> Result<GroupingReport, GroupingPipelineError> {
    group_revision_with(agent, pr, rev, &RepoContext::default(), cwd, opts).await
}

/// Run the full grouping pipeline against one revision, with whatever
/// repository context the caller has (head file contents, co-change
/// history) to sharpen the relatedness graph.
pub async fn group_revision_with(
    agent: &dyn AgentPort,
    pr: &PrMeta,
    rev: &Revision,
    ctx: &RepoContext,
    cwd: &Path,
    opts: &GroupingOptions,
) -> Result<GroupingReport, GroupingPipelineError> {
    group_revision_progress(agent, pr, rev, ctx, cwd, opts, &|_| {}).await
}

/// [`group_revision_with`], publishing each grouping a streaming run
/// (`GroupingOptions::stream`) has so far through `on`. A run that doesn't
/// stream publishes nothing: its result is the returned report.
#[allow(clippy::too_many_arguments)]
pub async fn group_revision_progress(
    agent: &dyn AgentPort,
    pr: &PrMeta,
    rev: &Revision,
    ctx: &RepoContext,
    cwd: &Path,
    opts: &GroupingOptions,
    on: OnProgress<'_>,
) -> Result<GroupingReport, GroupingPipelineError> {
    let start = Instant::now();
    let dupes = duplicate_hunk_ids(rev);
    if !dupes.is_empty() {
        return Err(GroupingPipelineError::DuplicateHunkIds(dupes));
    }
    let prepass = prepass::run_with(rev, &ctx.review);
    let graph = RelGraph::build(rev, &prepass, ctx);
    let note = ctx.review.system_note();
    let note = note.as_deref();
    let chunks = prompt::build_prompts_with(pr, rev, &prepass, &graph, ctx, &opts.budget);
    let total_visible_hunks: usize = chunks.iter().map(|c| c.hunk_ids.len()).sum();
    let n = chunks.len();
    let hidden = hidden_groups(&prepass, rev);
    let has_hidden_group = !hidden.is_empty();
    let board = Board::new(
        opts.stream.then_some(on),
        start,
        rev.head.clone(),
        hidden,
        &chunks,
    );
    let board = &board;
    let targets: Vec<(usize, usize)> = chunks.iter().map(|c| c.target).collect();

    // Run every chunk's agent call concurrently, capped at
    // `chunk_concurrency` in flight, each landing as soon as it is back
    // (`buffer_unordered`): a streaming run shows it then. Chunks are
    // consumed by value (not borrowed) so each future owns its own data
    // instead of tying its type to a borrowed-iterator-item lifetime, which
    // `rustc` otherwise rejects once this `async fn` is itself boxed by a
    // caller (`#[async_trait]` in `crates/runtime`).
    let concurrency = opts.chunk_concurrency.max(1);
    let mut results = stream::iter(chunks.into_iter().enumerate().map(|(i, chunk)| {
        let sub_rev = sub_revision(rev, &chunk.hunk_ids);
        async move {
            let r = run_chunk(agent, opts, cwd, note, &sub_rev, &chunk.prompt, board, i).await;
            (i, r)
        }
    }))
    .buffer_unordered(concurrency);

    let mut usage = Usage::default();
    let mut attempts: u32 = 0;
    let mut any_repair = false;
    let mut landed = 0;
    while let Some((i, r)) = results.next().await {
        let (grouping, att, repaired, u) = r?;
        usage += u;
        attempts += att;
        any_repair |= repaired;
        landed += 1;
        let mut groups = grouping.groups;
        // Streaming: coarsened within the chunk, to its share of the PR's
        // target (the whole target for a single chunk), so a group once
        // shown is never merged away by a later chunk. Otherwise across
        // the whole PR below, once every chunk is in.
        if opts.stream && groups.len() > targets[i].1 {
            groups = coarsen::merge_tiny_groups(rev, groups, targets[i].1, &graph);
        }
        board.land(
            i,
            groups,
            Stage::Chunk {
                done: landed,
                of: n,
            },
        );
    }
    drop(results);

    let (mut groups, chunk_groups) = board.landed();
    if chunk_groups.len() <= 1 {
        groups.extend(chunk_groups.into_iter().flatten());
    } else {
        let all: Vec<Group> = chunk_groups.into_iter().flatten().collect();
        attempts += 1;
        match merge_pass(agent, opts, cwd, note, pr, &all).await {
            Some(order) => {
                let mut by_id: BTreeMap<GroupId, Group> =
                    all.into_iter().map(|g| (g.id.clone(), g)).collect();
                for id in order {
                    if let Some(g) = by_id.remove(&id) {
                        groups.push(g);
                    }
                }
                groups.extend(by_id.into_values());
            }
            None => {
                any_repair = true;
                groups.extend(all);
            }
        }
    }

    // Coarser-groups goal: if the model (across however many chunks) still
    // produced more groups than this PR's size warrants, deterministically
    // merge the tiniest ones into their most related same-kind group. Free
    // (no agent call) and exact — it only moves hunks between groups that
    // already exist, so it can't break the partition invariant checked
    // just below. A streaming run did it per chunk instead.
    let (_, target_hi) = target::target_group_count(total_visible_hunks);
    let target_max = target_hi + usize::from(has_hidden_group);
    if !opts.stream && groups.len() > target_max {
        groups = coarsen::merge_tiny_groups(rev, groups, target_max, &graph);
    }

    let grouping = Grouping::new(rev.head.clone(), groups);
    let (grouping, attempts) = match grouping::validate(rev, &grouping) {
        Ok(()) => (grouping, attempts),
        Err(_) => {
            any_repair = true;
            (grouping::repair_with_other(rev, grouping), attempts + 1)
        }
    };

    let duration_ms = start.elapsed().as_millis() as u64;
    let (first_shown, stream) = board.timings();
    Ok(GroupingReport {
        grouping,
        attempts: attempts.max(1),
        valid_first_try: !any_repair,
        usage,
        duration_ms,
        first_group_ms: first_shown.unwrap_or(duration_ms),
        chunks: n as u32,
        stream,
    })
}

/// Which id each group is shown under: the agent's own slug, made unique
/// across the run (`slug-2`, …) — chunks are prompted apart, so two can
/// pick the same one. Keyed by where a group came from (chunk, slug, its
/// rank among that chunk's groups with that slug), so a streamed group and
/// the same group in its chunk's final answer get the same id, and a UI
/// keying groups by id keeps the one the user opened.
#[derive(Debug, Default)]
struct Ids {
    taken: BTreeSet<GroupId>,
    by_origin: BTreeMap<(usize, GroupId, usize), GroupId>,
}

impl Ids {
    fn reserve(&mut self, id: &GroupId) {
        self.taken.insert(id.clone());
    }

    /// The id the `rank`-th group slugged `raw` in chunk `chunk` is shown
    /// under: the same every time it is asked.
    fn id_for(&mut self, chunk: usize, raw: &GroupId, rank: usize) -> GroupId {
        let key = (chunk, raw.clone(), rank);
        if let Some(id) = self.by_origin.get(&key) {
            return id.clone();
        }
        let mut id = raw.clone();
        let mut k = 2;
        while self.taken.contains(&id) {
            id = GroupId(format!("{}-{k}", raw.0));
            k += 1;
        }
        self.taken.insert(id.clone());
        self.by_origin.insert(key, id.clone());
        id
    }

    /// Renames `groups` (chunk `chunk`'s, in its answer's order) to the
    /// ids they are shown under.
    fn assign(&mut self, chunk: usize, groups: &mut [Group]) {
        let mut seen: BTreeMap<GroupId, usize> = BTreeMap::new();
        for g in groups {
            let rank = seen.entry(g.id.clone()).or_default();
            g.id = self.id_for(chunk, &g.id, *rank);
            *rank += 1;
        }
    }
}

/// What a run has shown so far, and every publication of a streaming one:
/// the hidden group, then each chunk in chunk order — its final groups once
/// it has landed, the groups its answer has written until then. A chunk
/// needing a repair keeps its streamed groups up until the repaired answer
/// lands. A chunk's place never moves, so groups only ever append within
/// it while the rest stay put.
///
/// ```text
/// delta ─▶ GroupStream ─▶ group closed ─▶ streamed[chunk] ─▶ publish
/// chunk lands ─▶ finals[chunk] replaces streamed[chunk] ─▶ publish
/// ```
struct Board<'a> {
    /// `None`: not streaming, nothing is published.
    on: Option<OnProgress<'a>>,
    start: Instant,
    state: Mutex<BoardState>,
}

struct BoardState {
    rev: Sha,
    hidden: Vec<Group>,
    /// Each chunk's streamed groups, as written (ids as shown).
    streamed: Vec<Vec<Group>>,
    /// The agent's own ids of those groups.
    streamed_raw: Vec<Vec<GroupId>>,
    /// Each chunk's final groups, once it has landed.
    finals: Vec<Option<Vec<Group>>>,
    /// Each chunk's hunk ids: a preview keeps only its own chunk's.
    known: Vec<BTreeSet<HunkId>>,
    ids: Ids,
    first_shown_ms: Option<u64>,
    timings: StreamTimings,
}

impl<'a> Board<'a> {
    fn new(
        on: Option<OnProgress<'a>>,
        start: Instant,
        rev: Sha,
        hidden: Vec<Group>,
        chunks: &[PromptChunk],
    ) -> Self {
        let n = chunks.len();
        let mut ids = Ids::default();
        for g in &hidden {
            ids.reserve(&g.id);
        }
        let streaming = on.is_some();
        Self {
            on,
            start,
            state: Mutex::new(BoardState {
                rev,
                hidden,
                streamed: vec![Vec::new(); n],
                streamed_raw: vec![Vec::new(); n],
                finals: vec![None; n],
                known: chunks
                    .iter()
                    .map(|c| c.hunk_ids.iter().cloned().collect())
                    .collect(),
                ids,
                first_shown_ms: None,
                timings: StreamTimings {
                    answer_ms: if streaming { vec![0; n] } else { vec![] },
                    ..Default::default()
                },
            }),
        }
    }

    fn streaming(&self) -> bool {
        self.on.is_some()
    }

    fn ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BoardState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Publishes what the board shows, under the lock: publications go out
    /// in the order they were made.
    fn publish(&self, st: &mut BoardState, stage: Stage) {
        let Some(on) = self.on else { return };
        let ms = self.ms();
        let now = st.compose();
        if now.groups.iter().all(|g| st.hidden.contains(g)) {
            return;
        }
        st.first_shown_ms.get_or_insert(ms);
        on(Progress {
            stage,
            grouping: &now,
            elapsed_ms: ms,
        });
    }

    /// A group chunk `chunk`'s answer just closed.
    fn streamed(&self, chunk: usize, raw: schema::RawGroup) {
        let ms = self.ms();
        let mut st = self.lock();
        if st.finals[chunk].is_some() {
            return;
        }
        let mut g = raw.into_domain();
        let rank = st.streamed_raw[chunk]
            .iter()
            .filter(|id| **id == g.id)
            .count();
        st.streamed_raw[chunk].push(g.id.clone());
        g.id = st.ids.id_for(chunk, &g.id, rank);
        st.streamed[chunk].push(g);
        let groups = st.streamed[chunk].len();
        st.timings.group_ms.push(ms);
        self.publish(&mut st, Stage::Streamed { chunk, groups });
    }

    /// Chunk `chunk`'s first answer ended.
    fn answered(&self, chunk: usize) {
        let ms = self.ms();
        if let Some(t) = self.lock().timings.answer_ms.get_mut(chunk) {
            *t = ms;
        }
    }

    /// Chunk `chunk` landed with `groups` (validated, maybe repaired): they
    /// replace its previews. Published when it isn't the PR's only chunk.
    fn land(&self, chunk: usize, mut groups: Vec<Group>, stage: Stage) {
        let mut st = self.lock();
        st.ids.assign(chunk, &mut groups);
        st.finals[chunk] = Some(groups);
        if st.finals.len() > 1 {
            self.publish(&mut st, stage);
        }
    }

    /// The hidden group(s), and each chunk's final groups in chunk order.
    fn landed(&self) -> (Vec<Group>, Vec<Vec<Group>>) {
        let st = self.lock();
        let finals = st.finals.iter().map(|f| f.clone().unwrap_or_default());
        (st.hidden.clone(), finals.collect())
    }

    /// When the first group was shown, and the streamed groups' timings.
    fn timings(&self) -> (Option<u64>, StreamTimings) {
        let st = self.lock();
        (st.first_shown_ms, st.timings.clone())
    }
}

impl BoardState {
    /// The hidden group, then each chunk's final or streamed groups in
    /// chunk order. A preview keeps only hunks of its own chunk not already
    /// shown, and is dropped if none are left.
    fn compose(&self) -> Grouping {
        let mut groups = self.hidden.clone();
        let mut shown: BTreeSet<HunkId> = groups
            .iter()
            .flat_map(|g| g.hunks.iter().cloned())
            .collect();
        for (i, streamed) in self.streamed.iter().enumerate() {
            if let Some(finals) = &self.finals[i] {
                shown.extend(finals.iter().flat_map(|g| g.hunks.iter().cloned()));
                groups.extend(finals.iter().cloned());
                continue;
            }
            for g in streamed {
                let hunks: Vec<HunkId> = g
                    .hunks
                    .iter()
                    .filter(|h| self.known[i].contains(*h) && shown.insert((*h).clone()))
                    .cloned()
                    .collect();
                if hunks.is_empty() {
                    continue;
                }
                let mut g = g.clone();
                g.outliers.retain(|h| hunks.contains(h));
                g.hunks = hunks;
                groups.push(g);
            }
        }
        Grouping {
            rev: self.rev.clone(),
            groups,
            in_progress: true,
        }
    }
}

/// A view of `rev` restricted to the given hunk ids, for per-chunk validation.
fn sub_revision(rev: &Revision, ids: &[HunkId]) -> Revision {
    let wanted: std::collections::BTreeSet<&HunkId> = ids.iter().collect();
    let files = rev
        .files
        .iter()
        .filter_map(|f| {
            let hunks: Vec<Hunk> = f
                .hunks
                .iter()
                .filter(|h| wanted.contains(&h.id))
                .cloned()
                .collect();
            if hunks.is_empty() {
                None
            } else {
                let mut f = f.clone();
                f.hunks = hunks;
                Some(f)
            }
        })
        .collect();
    Revision {
        base: rev.base.clone(),
        head: rev.head.clone(),
        files,
    }
}

fn hidden_groups(prepass: &PrePass, rev: &Revision) -> Vec<Group> {
    if prepass.hidden.is_empty() {
        return vec![];
    }
    let hunks: Vec<HunkId> = rev
        .files
        .iter()
        .filter(|f| prepass.is_hidden(&f.path))
        .flat_map(|f| f.hunks.iter().map(|h| h.id.clone()))
        .collect();
    if hunks.is_empty() {
        return vec![];
    }
    let mut reasons: Vec<&str> = prepass.hidden.values().map(HiddenReason::label).collect();
    reasons.sort_unstable();
    reasons.dedup();
    vec![Group {
        id: GroupId::new("hidden"),
        title: if reasons.iter().all(|r| *r == HiddenReason::Config.label()) {
            "Hidden by the repo's config".into()
        } else {
            "Lockfiles, generated and vendored files".into()
        },
        why: format!("Not reviewed in detail: {}.", reasons.join(", ")),
        kind: theodore_domain::GroupKind::Hidden,
        risk: None,
        check: vec![],
        hunks,
        outliers: vec![],
    }]
}

/// Run one chunk: initial call, one repair call on validation failure, then
/// `repair_with_other` as the final safety net. On a streaming board, the
/// initial answer's groups go to it as they are written (chunk `chunk`); a
/// repair call's don't, so the streamed ones stay up until it lands.
#[allow(clippy::too_many_arguments)]
async fn run_chunk(
    agent: &dyn AgentPort,
    opts: &GroupingOptions,
    cwd: &Path,
    note: Option<&str>,
    sub_rev: &Revision,
    prompt: &PromptPart,
    board: &Board<'_>,
    chunk: usize,
) -> Result<(Grouping, u32, bool, Usage), GroupingPipelineError> {
    let mut usage = Usage::default();
    let (text, u) = if board.streaming() {
        let mut parser = crate::stream::GroupStream::new();
        let mut on_delta = |delta: &str| {
            for g in parser.push(delta) {
                board.streamed(chunk, g);
            }
        };
        let r = call_agent_streaming(
            agent,
            opts,
            cwd,
            note,
            &prompt.system,
            &prompt.user,
            Some(&mut on_delta),
        )
        .await?;
        board.answered(chunk);
        r
    } else {
        call_agent(agent, opts, cwd, note, &prompt.system, &prompt.user).await?
    };
    usage += u;
    let grouping = schema::parse_grouping(&text, sub_rev.head.clone());

    let errors = match grouping::validate(sub_rev, &grouping) {
        Ok(()) => return Ok((grouping, 1, false, usage)),
        Err(errors) => errors,
    };
    debug_log_validation_failure(&errors, &text);
    let known: Vec<HunkId> = sub_rev.hunks().map(|h| h.id.clone()).collect();
    let repair = prompt::repair_prompt(&known, &text, &display_errors(&errors));
    let (text2, u2) = call_agent(agent, opts, cwd, note, &repair.system, &repair.user).await?;
    usage += u2;
    let grouping2 = schema::parse_grouping(&text2, sub_rev.head.clone());

    match grouping::validate(sub_rev, &grouping2) {
        Ok(()) => Ok((grouping2, 2, true, usage)),
        Err(_) => Ok((
            grouping::repair_with_other(sub_rev, grouping2),
            2,
            true,
            usage,
        )),
    }
}

fn display_errors(errors: &[GroupingError]) -> Vec<String> {
    errors.iter().map(|e| e.to_string()).collect()
}

/// Opt-in diagnostic for why a first attempt needed repair (set
/// `THEODORE_GROUPING_DEBUG=1`). Off by default: never fires in tests or
/// normal runs, so it adds no noise and no dependency on a logging crate.
fn debug_log_validation_failure(errors: &[GroupingError], raw_response: &str) {
    if std::env::var_os("THEODORE_GROUPING_DEBUG").is_none() {
        return;
    }
    eprintln!("[grouping] first attempt failed validation:");
    for e in errors {
        eprintln!("  - {e}");
    }
    eprintln!("[grouping] raw response:\n{raw_response}");
}

/// Ask the agent for the final reading order across chunk group summaries.
/// Returns `None` on any failure (agent error, unparseable, incomplete) —
/// the caller falls back to the chunks' natural order, which is still a
/// valid (if less polished) grouping.
async fn merge_pass(
    agent: &dyn AgentPort,
    opts: &GroupingOptions,
    cwd: &Path,
    note: Option<&str>,
    pr: &PrMeta,
    groups: &[Group],
) -> Option<Vec<GroupId>> {
    let prompt = prompt::merge_prompt(pr, groups);
    let (text, _usage) = call_agent(agent, opts, cwd, note, &prompt.system, &prompt.user)
        .await
        .ok()?;
    let value = crate::parse::extract_json(&text)?;
    let raw: prompt::RawOrder = serde_json::from_value(value).ok()?;
    let order = raw.into_ids();
    let known: std::collections::BTreeSet<&GroupId> = groups.iter().map(|g| &g.id).collect();
    if order.len() != known.len() || !order.iter().all(|id| known.contains(id)) {
        return None;
    }
    Some(order)
}

/// One agent call; `note` (the repo's review config,
/// `ReviewRules::system_note`) is appended to the system prompt.
/// The effort every grouping, regroup and merge run goes at, whatever the
/// agent's own setting (`call_agent`).
pub const GROUPING_EFFORT: &str = "low";

/// The model a grouping runs on when the caller names none: Claude's
/// `sonnet` alias (the latest Sonnet); the other CLIs keep their setting.
pub fn grouping_model(agent: AgentId) -> Option<String> {
    (agent == AgentId::Claude).then(|| "sonnet".to_string())
}

pub(crate) async fn call_agent(
    agent: &dyn AgentPort,
    opts: &GroupingOptions,
    cwd: &Path,
    note: Option<&str>,
    system: &str,
    prompt: &str,
) -> Result<(String, Usage), GroupingPipelineError> {
    call_agent_streaming(agent, opts, cwd, note, system, prompt, None).await
}

/// [`call_agent`]; with `on_delta`, the answer's text also goes to it
/// piece by piece as the agent writes it (`AgentRequest::stream_text`).
async fn call_agent_streaming(
    agent: &dyn AgentPort,
    opts: &GroupingOptions,
    cwd: &Path,
    note: Option<&str>,
    system: &str,
    prompt: &str,
    mut on_delta: Option<&mut (dyn FnMut(&str) + Send)>,
) -> Result<(String, Usage), GroupingPipelineError> {
    let system = match note {
        Some(note) => format!("{system}\n\n{note}"),
        None => system.to_string(),
    };
    let req = AgentRequest {
        agent: opts.agent,
        prompt: prompt.to_string(),
        system: Some(system),
        cwd: cwd.to_path_buf(),
        mode: AgentMode::ReadOnly,
        mcp: None,
        // Never the chat's model either: a grouping is a classification of
        // the diff in the prompt, where Sonnet matches Opus (13/13 valid,
        // same groups on kdb#83) and is faster on big PRs (36 s vs 55 s);
        // Haiku needs repair calls and fragments, so it's slower overall.
        model: opts.model.clone().or_else(|| grouping_model(opts.agent)),
        // Never the chat's effort: at high/max Claude stops grouping the
        // diff in the prompt and explores the repo with Grep and Read — a
        // 28k-line PR took 65 s at low, 75 s at the CLI default and over
        // 11 min at max (40+ turns, ~30 tool calls per chunk).
        effort: Some(GROUPING_EFFORT.to_string()),
        stall_after_ms: opts.stall_after_ms,
        env: Vec::new(),
        user_mcp: opts.user_mcp,
        attachments: vec![],
        resume: None,
        stream_text: on_delta.is_some(),
    };
    let mut run = agent.run(req).await?;
    let mut usage = Usage::default();
    loop {
        match run.events.recv().await {
            Some(AgentEvent::TextDelta { text }) => {
                if let Some(f) = on_delta.as_deref_mut() {
                    f(&text);
                }
            }
            Some(AgentEvent::Usage { usage: u }) => usage += u,
            Some(AgentEvent::Done {
                final_text,
                usage: u,
            }) => {
                usage += u;
                return Ok((final_text, usage));
            }
            Some(AgentEvent::Error {
                message,
                stderr_tail,
            }) => {
                return Err(GroupingPipelineError::AgentRun(format!(
                    "{message}: {stderr_tail}"
                )));
            }
            Some(_) => continue,
            None => return Err(GroupingPipelineError::NoDone),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::FakeAgentPort;
    use theodore_domain::{DiffLine, FileDiff, FileStatus, LineKind, Sha};

    fn line(kind: LineKind, text: &str) -> DiffLine {
        DiffLine {
            kind,
            text: text.into(),
            old_no: None,
            new_no: None,
        }
    }

    fn mk_hunk(id: &str) -> Hunk {
        Hunk {
            id: HunkId::new(id),
            path: String::new(),
            old_start: 1,
            old_lines: 1,
            new_start: 1,
            new_lines: 1,
            header: String::new(),
            lines: vec![line(LineKind::Add, "x")],
        }
    }

    fn small_revision() -> Revision {
        Revision {
            base: Sha::new("base"),
            head: Sha::new("head"),
            files: vec![FileDiff {
                path: "src/a.ts".into(),
                old_path: None,
                status: FileStatus::Modified,
                similarity: None,
                old_mode: None,
                new_mode: None,
                flags: vec![],
                additions: 2,
                deletions: 0,
                hunks: vec![mk_hunk("h1"), mk_hunk("h2")],
            }],
        }
    }

    fn valid_json() -> &'static str {
        r#"{"groups": [{"id": "g1", "title": "Change", "why": "does a thing",
            "kind": "normal", "check": [], "hunks": ["h1", "h2"], "outliers": []}]}"#
    }

    fn file(path: &str, hunks: Vec<Hunk>) -> FileDiff {
        FileDiff {
            path: path.into(),
            old_path: None,
            status: FileStatus::Modified,
            similarity: None,
            old_mode: None,
            new_mode: None,
            flags: vec![],
            additions: 1,
            deletions: 0,
            hunks,
        }
    }

    /// Regression: two real PRs (tokio#8587, rust-analyzer#23173) each
    /// repeat a mechanically-identical one-line edit several times in the
    /// same file, which collides to the same `HunkId` under
    /// `theodore_domain::interdiff::hunk_id` (identity is `(path, content)`,
    /// not position, by design — plan §4). `grouping::validate`'s
    /// `BTreeSet<&HunkId>` can't tell the colliding hunks apart either, so
    /// it would have reported "valid" while quietly dropping all but one of
    /// them. The pipeline must refuse to run rather than produce that
    /// misleadingly "valid" result.
    #[tokio::test]
    async fn duplicate_hunk_ids_across_files_are_rejected_before_calling_the_agent() {
        let rev = Revision {
            base: Sha::new("base"),
            head: Sha::new("head"),
            files: vec![
                file("a.rs", vec![mk_hunk("dup")]),
                file("b.rs", vec![mk_hunk("dup")]),
                file("c.rs", vec![mk_hunk("unique")]),
            ],
        };
        let agent = FakeAgentPort::new([valid_json()]);
        let err = group_revision(
            &agent,
            &PrMeta::default(),
            &rev,
            Path::new("."),
            &GroupingOptions::default(),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(err, GroupingPipelineError::DuplicateHunkIds(ref ids) if ids == &[HunkId::new("dup")])
        );
        assert_eq!(
            agent.calls_made(),
            0,
            "must not spend an agent call on bad input"
        );
    }

    #[test]
    fn duplicate_hunk_ids_is_empty_for_well_formed_input() {
        let rev = small_revision();
        assert!(duplicate_hunk_ids(&rev).is_empty());
    }

    #[tokio::test]
    async fn valid_first_try() {
        let agent = FakeAgentPort::new([valid_json()]);
        let rev = small_revision();
        let report = group_revision(
            &agent,
            &PrMeta::default(),
            &rev,
            Path::new("."),
            &GroupingOptions::default(),
        )
        .await
        .unwrap();
        assert!(report.valid_first_try);
        assert_eq!(report.attempts, 1);
        assert!(grouping::validate(&rev, &report.grouping).is_ok());
    }

    #[tokio::test]
    async fn invalid_then_repaired() {
        // first answer is missing h2 entirely.
        let bad = r#"{"groups": [{"id": "g1", "title": "Change", "why": "w",
            "kind": "normal", "hunks": ["h1"]}]}"#;
        let agent = FakeAgentPort::new([bad, valid_json()]);
        let rev = small_revision();
        let report = group_revision(
            &agent,
            &PrMeta::default(),
            &rev,
            Path::new("."),
            &GroupingOptions::default(),
        )
        .await
        .unwrap();
        assert!(!report.valid_first_try);
        assert_eq!(report.attempts, 2);
        assert!(grouping::validate(&rev, &report.grouping).is_ok());
        assert_eq!(agent.calls_made(), 2);
    }

    #[tokio::test]
    async fn garbage_falls_back_to_other() {
        let agent = FakeAgentPort::new(["I cannot help with that.", "still nothing useful here"]);
        let rev = small_revision();
        let report = group_revision(
            &agent,
            &PrMeta::default(),
            &rev,
            Path::new("."),
            &GroupingOptions::default(),
        )
        .await
        .unwrap();
        assert!(!report.valid_first_try);
        assert!(grouping::validate(&rev, &report.grouping).is_ok());
        let other = report
            .grouping
            .groups
            .iter()
            .find(|g| g.id == GroupId::new("other"));
        assert!(other.is_some());
        assert_eq!(
            other.unwrap().hunks.len(),
            2,
            "both hunks should land in the Other fallback group"
        );
    }

    #[tokio::test]
    async fn tolerates_fenced_json() {
        let fenced = format!(
            "Sure, here is the grouping:\n```json\n{}\n```",
            valid_json()
        );
        let agent = FakeAgentPort::new([fenced]);
        let rev = small_revision();
        let report = group_revision(
            &agent,
            &PrMeta::default(),
            &rev,
            Path::new("."),
            &GroupingOptions::default(),
        )
        .await
        .unwrap();
        assert!(report.valid_first_try);
        assert_eq!(report.attempts, 1);
    }

    #[tokio::test]
    async fn hidden_files_bypass_the_agent() {
        let mut rev = small_revision();
        rev.files.push(FileDiff {
            path: "pnpm-lock.yaml".into(),
            old_path: None,
            status: FileStatus::Modified,
            similarity: None,
            old_mode: None,
            new_mode: None,
            flags: vec![],
            additions: 1,
            deletions: 1,
            hunks: vec![mk_hunk("lock1")],
        });
        let agent = FakeAgentPort::new([valid_json()]);
        let report = group_revision(
            &agent,
            &PrMeta::default(),
            &rev,
            Path::new("."),
            &GroupingOptions::default(),
        )
        .await
        .unwrap();
        assert!(grouping::validate(&rev, &report.grouping).is_ok());
        // the lockfile hunk must be in the deterministic hidden group, and
        // the prompt sent to the agent must never mention it.
        let hidden = report
            .grouping
            .groups
            .iter()
            .find(|g| g.kind == theodore_domain::GroupKind::Hidden)
            .expect("hidden group present");
        assert!(hidden.hunks.contains(&HunkId::new("lock1")));
        let reqs = agent.requests();
        assert_eq!(reqs.len(), 1);
        assert!(!reqs[0].prompt.contains("lock1"));
        // Low effort, never the chat's: high effort explores the repo.
        assert_eq!(reqs[0].effort.as_deref(), Some(GROUPING_EFFORT));
        // Sonnet unless the caller names a model.
        assert_eq!(reqs[0].model.as_deref(), Some("sonnet"));
    }

    #[tokio::test]
    async fn config_hide_skim_and_instructions_reach_the_pipeline() {
        let mut rev = small_revision();
        rev.files.push(file("gen/client.ts", vec![mk_hunk("gen1")]));
        let ctx = RepoContext {
            review: theodore_domain::review_rules::ReviewRules {
                instructions: Some("Flag any new dependency.".into()),
                context: vec!["docs/architecture.md".into()],
                hide: vec!["gen/**".into()],
                skim: vec!["src/a.ts".into()],
                ..Default::default()
            },
            ..RepoContext::default()
        };
        let agent = FakeAgentPort::new([valid_json()]);
        let report = group_revision_with(
            &agent,
            &PrMeta::default(),
            &rev,
            &ctx,
            Path::new("."),
            &GroupingOptions::default(),
        )
        .await
        .unwrap();
        assert!(grouping::validate(&rev, &report.grouping).is_ok());
        let hidden = report
            .grouping
            .groups
            .iter()
            .find(|g| g.kind == theodore_domain::GroupKind::Hidden)
            .expect("hidden group present");
        assert_eq!(hidden.hunks, vec![HunkId::new("gen1")]);
        assert_eq!(hidden.title, "Hidden by the repo's config");
        let reqs = agent.requests();
        assert_eq!(reqs.len(), 1);
        assert!(!reqs[0].prompt.contains("gen1"));
        assert!(
            reqs[0]
                .prompt
                .contains("skim candidate: marked skim in repo config")
        );
        let system = reqs[0].system.as_deref().unwrap();
        assert!(system.contains("Flag any new dependency."));
        assert!(system.contains("- docs/architecture.md"));
    }

    /// Speed goal: chunk prompts run concurrently (`buffer_unordered`), but
    /// the rest of the pipeline must see them in their original
    /// (alphabetical top-level-dir) order regardless. Pinned down via the natural-order
    /// fallback path: the merge-pass call is scripted to fail, so the final
    /// group order is exactly the chunk submission order.
    #[tokio::test]
    async fn chunk_concurrency_preserves_submission_order() {
        let rev = Revision {
            base: Sha::new("base"),
            head: Sha::new("head"),
            files: vec![
                file("a/one.ts", vec![mk_hunk("a1")]),
                file("b/two.ts", vec![mk_hunk("b1")]),
            ],
        };
        let tiny_budget = PromptBudget {
            max_chars: 10,
            ..PromptBudget::default()
        };
        let opts = GroupingOptions {
            budget: tiny_budget,
            ..GroupingOptions::default()
        };
        let a_response = r#"{"groups": [{"id": "ga", "title": "A", "why": "w",
            "kind": "normal", "hunks": ["a1"], "outliers": []}]}"#;
        let b_response = r#"{"groups": [{"id": "gb", "title": "B", "why": "w",
            "kind": "normal", "hunks": ["b1"], "outliers": []}]}"#;
        // The merge-pass call (3rd) is garbage, forcing the natural-order
        // fallback — exactly what pins the chunk order down for this test.
        let agent = FakeAgentPort::new([a_response, b_response, "not json"]);

        let report = group_revision(&agent, &PrMeta::default(), &rev, Path::new("."), &opts)
            .await
            .unwrap();

        assert!(grouping::validate(&rev, &report.grouping).is_ok());
        let ids: Vec<&str> = report
            .grouping
            .groups
            .iter()
            .map(|g| g.id.as_str())
            .collect();
        assert_eq!(ids, vec!["ga", "gb"]);
    }

    /// Coarser-groups goal: a real large PR (migratro#77-shaped) got one
    /// group per small, related file (`.env`, CI, docker, docs) that should
    /// have stayed with the change they supported. Simulate the same
    /// over-fragmentation on a small PR and check the deterministic
    /// post-pass brings it back down to the PR-size target without another
    /// agent call.
    #[tokio::test]
    async fn fragmented_response_is_coarsened_down_to_the_pr_size_target() {
        let rev = Revision {
            base: Sha::new("base"),
            head: Sha::new("head"),
            files: vec![
                file("a/one.rs", vec![mk_hunk("a1")]),
                file("a/two.rs", vec![mk_hunk("a2")]),
                file("a/three.rs", vec![mk_hunk("a3")]),
                file("b/one.rs", vec![mk_hunk("b1")]),
                file("b/two.rs", vec![mk_hunk("b2")]),
                file("b/three.rs", vec![mk_hunk("b3")]),
            ],
        };
        let fragmented = r#"{"groups": [
            {"id": "a1g", "title": "a1", "why": "w", "kind": "normal", "hunks": ["a1"], "outliers": []},
            {"id": "a2g", "title": "a2", "why": "w", "kind": "normal", "hunks": ["a2"], "outliers": []},
            {"id": "a3g", "title": "a3", "why": "w", "kind": "normal", "hunks": ["a3"], "outliers": []},
            {"id": "b1g", "title": "b1", "why": "w", "kind": "normal", "hunks": ["b1"], "outliers": []},
            {"id": "b2g", "title": "b2", "why": "w", "kind": "normal", "hunks": ["b2"], "outliers": []},
            {"id": "b3g", "title": "b3", "why": "w", "kind": "normal", "hunks": ["b3"], "outliers": []}
        ]}"#;
        let agent = FakeAgentPort::new([fragmented]);

        let report = group_revision(
            &agent,
            &PrMeta::default(),
            &rev,
            Path::new("."),
            &GroupingOptions::default(),
        )
        .await
        .unwrap();

        assert!(grouping::validate(&rev, &report.grouping).is_ok());
        assert!(
            report.grouping.groups.len() <= 4,
            "expected coarsening down to the 6-hunk PR's target (2-4), got {} groups",
            report.grouping.groups.len()
        );
        assert_eq!(
            agent.calls_made(),
            1,
            "coarsening is a deterministic post-pass, not another agent call"
        );
    }

    // ── streaming ───────────────────────────────────────────────────────

    /// Records every published grouping with its stage.
    #[derive(Default)]
    struct Published(Mutex<Vec<(Stage, Grouping)>>);

    impl Published {
        fn take(&self) -> Vec<(Stage, Grouping)> {
            std::mem::take(&mut self.0.lock().unwrap())
        }
    }

    fn streaming() -> GroupingOptions {
        GroupingOptions {
            stream: true,
            ..GroupingOptions::default()
        }
    }

    fn tiny_budget() -> PromptBudget {
        PromptBudget {
            max_chars: 10,
            ..PromptBudget::default()
        }
    }

    /// Two top-level dirs: with `tiny_budget`, chunk 0 is `a/`, chunk 1 `b/`.
    fn two_dir_revision() -> Revision {
        Revision {
            base: Sha::new("base"),
            head: Sha::new("head"),
            files: vec![
                file("a/one.ts", vec![mk_hunk("a1"), mk_hunk("a2")]),
                file("b/two.ts", vec![mk_hunk("b1")]),
            ],
        }
    }

    fn ids(g: &Grouping) -> Vec<&str> {
        g.groups.iter().map(|g| g.id.as_str()).collect()
    }

    fn hunks_of<'g>(g: &'g Grouping, id: &str) -> Option<Vec<&'g str>> {
        g.groups
            .iter()
            .find(|x| x.id.as_str() == id)
            .map(|x| x.hunks.iter().map(HunkId::as_str).collect())
    }

    async fn run_streamed(
        agent: &FakeAgentPort,
        rev: &Revision,
        opts: &GroupingOptions,
        published: &Published,
    ) -> Result<GroupingReport, GroupingPipelineError> {
        let on = |p: Progress<'_>| {
            published
                .0
                .lock()
                .unwrap()
                .push((p.stage, p.grouping.clone()));
        };
        group_revision_progress(
            agent,
            &PrMeta::default(),
            rev,
            &RepoContext::default(),
            Path::new("."),
            opts,
            &on,
        )
        .await
    }

    /// Every publication is provisional and never shows a hunk twice.
    fn assert_provisional(steps: &[(Stage, Grouping)]) {
        for (k, (stage, g)) in steps.iter().enumerate() {
            assert!(g.in_progress, "step {k} ({stage:?}) looks final");
            let mut seen = BTreeSet::new();
            for h in g.groups.iter().flat_map(|g| &g.hunks) {
                assert!(seen.insert(h.clone()), "{h} twice in step {k}");
            }
        }
    }

    /// One chunk, streamed: each group is published as it is written; the
    /// final grouping is the one the whole answer makes, same as without
    /// streaming.
    #[tokio::test]
    async fn single_chunk_streams_each_group_then_returns_the_same_grouping() {
        let rev = small_revision();
        let answer = r#"Sure:
```json
{"groups": [
  {"id": "g1", "title": "One", "why": "first {step}", "hunks": ["h1"]},
  {"id": "g2", "title": "Two", "why": "second", "hunks": ["h2"]}
]}
```"#;
        let published = Published::default();
        let agent = FakeAgentPort::new([answer]);
        let report = run_streamed(&agent, &rev, &streaming(), &published)
            .await
            .unwrap();
        assert!(agent.requests()[0].stream_text);

        let steps = published.take();
        let stages: Vec<Stage> = steps.iter().map(|(s, _)| *s).collect();
        assert_eq!(
            stages,
            vec![
                Stage::Streamed {
                    chunk: 0,
                    groups: 1
                },
                Stage::Streamed {
                    chunk: 0,
                    groups: 2
                },
            ]
        );
        assert_eq!(ids(&steps[0].1), ["g1"]);
        assert_eq!(ids(&steps[1].1), ["g1", "g2"]);
        assert_eq!(steps[0].1.groups[0].why, "first {step}");
        assert_provisional(&steps);

        let t = &report.stream;
        assert_eq!(t.group_ms.len(), 2);
        assert_eq!(report.first_group_ms, t.group_ms[0]);
        assert!(report.first_group_ms <= report.duration_ms);
        assert_eq!(t.answer_ms.len(), 1);
        assert!(t.group_ms[1] <= t.answer_ms[0]);
        assert!(!report.grouping.in_progress);

        let plain_agent = FakeAgentPort::new([answer]);
        let plain = group_revision(
            &plain_agent,
            &PrMeta::default(),
            &rev,
            Path::new("."),
            &GroupingOptions::default(),
        )
        .await
        .unwrap();
        assert!(!plain_agent.requests()[0].stream_text);
        assert_eq!(report.grouping, plain.grouping);
        assert_eq!(report.valid_first_try, plain.valid_first_try);
        assert_eq!(plain.stream, StreamTimings::default());
        assert_eq!(plain.first_group_ms, plain.duration_ms);
    }

    /// A preview shows only hunks its chunk has, each once, under an id
    /// unique in the run; the repair call that fixes the answer doesn't
    /// stream, and the streamed groups stay up until it lands.
    #[tokio::test]
    async fn previews_drop_unknown_and_repeated_hunks_and_stay_up_through_a_repair() {
        let rev = small_revision();
        let agent = FakeAgentPort::new([
            r#"{"groups": [{"id": "g1", "hunks": ["h1", "zz"]},
                {"id": "g1", "hunks": ["h1", "h2"]}, {"id": "g3", "hunks": ["h1"]}]}"#,
            valid_json(),
        ]);
        let published = Published::default();
        let report = run_streamed(&agent, &rev, &streaming(), &published)
            .await
            .unwrap();
        let steps = published.take();
        // g3 has no hunk left to show: published, but adds nothing.
        assert_eq!(steps.len(), 3, "the repair answer published nothing");
        assert_provisional(&steps);
        let shown: Vec<(&str, Vec<&str>)> = steps[2]
            .1
            .groups
            .iter()
            .map(|g| (g.id.as_str(), g.hunks.iter().map(HunkId::as_str).collect()))
            .collect();
        assert_eq!(shown, [("g1", vec!["h1"]), ("g1-2", vec!["h2"])]);
        let reqs = agent.requests();
        assert!(reqs[0].stream_text && !reqs[1].stream_text);
        assert!(!report.valid_first_try);
        assert!(grouping::validate(&rev, &report.grouping).is_ok());
        assert_eq!(ids(&report.grouping), ["g1"]);
    }

    /// Several chunks, streamed one after the other: a chunk's previews,
    /// then its final groups, then the next chunk's — each chunk keeping
    /// its place — then the merge pass's order in the returned grouping.
    /// Two chunks picking the same slug get unique ids, and a group keeps
    /// its id from preview to final.
    #[tokio::test]
    async fn chunks_publish_previews_then_final_groups_with_ids_unique_across_chunks() {
        let rev = two_dir_revision();
        let opts = GroupingOptions {
            budget: tiny_budget(),
            chunk_concurrency: 1,
            ..streaming()
        };
        let agent = FakeAgentPort::routed([
            (
                "Decide the final reading order",
                r#"{"order": ["core-2", "core"]}"#,
            ),
            (
                "### hunk a1",
                r#"{"groups": [{"id": "core", "title": "A", "why": "a", "hunks": ["a1", "a2"]}]}"#,
            ),
            (
                "### hunk b1",
                r#"{"groups": [{"id": "core", "title": "B", "why": "b", "hunks": ["b1"]}]}"#,
            ),
        ]);
        let published = Published::default();
        let report = run_streamed(&agent, &rev, &opts, &published).await.unwrap();
        let steps = published.take();
        let stages: Vec<Stage> = steps.iter().map(|(s, _)| *s).collect();
        assert_eq!(
            stages,
            vec![
                Stage::Streamed {
                    chunk: 0,
                    groups: 1
                },
                Stage::Chunk { done: 1, of: 2 },
                Stage::Streamed {
                    chunk: 1,
                    groups: 1
                },
                Stage::Chunk { done: 2, of: 2 },
            ]
        );
        assert_provisional(&steps);
        assert_eq!(ids(&steps[0].1), ["core"]);
        assert_eq!(ids(&steps[2].1), ["core", "core-2"]);
        assert_eq!(hunks_of(&steps[2].1, "core-2").unwrap(), ["b1"]);
        // The merge pass's order, ids as shown.
        assert_eq!(ids(&report.grouping), ["core-2", "core"]);
        assert!(!report.grouping.in_progress);
        assert!(report.valid_first_try);
        assert!(grouping::validate(&rev, &report.grouping).is_ok());
        // A group shown once a chunk landed is in the final grouping as it
        // was shown: per-chunk coarsening never merges it away later.
        for (stage, g) in &steps {
            if !matches!(stage, Stage::Chunk { .. }) {
                continue;
            }
            for grp in &g.groups {
                let last = report.grouping.groups.iter().find(|x| x.id == grp.id);
                assert_eq!(last.map(|x| &x.hunks), Some(&grp.hunks), "{}", grp.id);
            }
        }
        assert_eq!(report.first_group_ms, report.stream.group_ms[0]);
        assert_eq!(report.stream.answer_ms.len(), 2);
    }

    /// A chunk whose first answer needs a repair keeps its streamed groups
    /// in every publication — also those of the other chunk landing — until
    /// its repaired answer lands: no flash of empty.
    #[tokio::test]
    async fn a_repaired_chunk_keeps_its_streamed_groups_until_replaced() {
        let rev = two_dir_revision();
        let opts = GroupingOptions {
            budget: tiny_budget(),
            ..streaming()
        };
        let agent = FakeAgentPort::routed([
            (
                "Problems found",
                r#"{"groups": [{"id": "ga", "title": "A", "why": "a", "hunks": ["a1", "a2"]}]}"#,
            ),
            (
                "Decide the final reading order",
                r#"{"order": ["ga", "gb"]}"#,
            ),
            (
                "### hunk a1",
                r#"{"groups": [{"id": "ga", "title": "A", "why": "a", "hunks": ["a1"]}]}"#,
            ),
            (
                "### hunk b1",
                r#"{"groups": [{"id": "gb", "title": "B", "why": "b", "hunks": ["b1"]}]}"#,
            ),
        ]);
        let published = Published::default();
        let report = run_streamed(&agent, &rev, &opts, &published).await.unwrap();
        let steps = published.take();
        assert_provisional(&steps);
        let first = steps
            .iter()
            .position(|(_, g)| hunks_of(g, "ga").is_some())
            .expect("ga streamed");
        let landed = steps
            .iter()
            .position(|(_, g)| hunks_of(g, "ga") == Some(vec!["a1", "a2"]))
            .expect("the repaired ga landed");
        assert!(first < landed);
        for (k, (_, g)) in steps.iter().enumerate().skip(first) {
            let want: &[&str] = if k < landed { &["a1"] } else { &["a1", "a2"] };
            assert_eq!(hunks_of(g, "ga").as_deref(), Some(want), "step {k}");
        }
        assert!(!report.valid_first_try);
        assert_eq!(ids(&report.grouping), ["ga", "gb"]);
        let repair = agent
            .requests()
            .into_iter()
            .find(|r| r.prompt.contains("Problems found"))
            .unwrap();
        assert!(!repair.stream_text);
    }

    /// A run whose agent fails part-way returns the error; whatever it
    /// published before was marked in progress, so it never looks final.
    #[tokio::test]
    async fn a_failed_run_published_only_provisional_groupings() {
        let rev = two_dir_revision();
        let opts = GroupingOptions {
            budget: tiny_budget(),
            chunk_concurrency: 1,
            ..streaming()
        };
        let fail = format!("{}rate limited", crate::testing::FAIL);
        let agent = FakeAgentPort::routed([
            (
                "### hunk a1",
                r#"{"groups": [{"id": "ga", "title": "A", "why": "a", "hunks": ["a1", "a2"]}]}"#,
            ),
            ("### hunk b1", fail.as_str()),
        ]);
        let published = Published::default();
        let err = run_streamed(&agent, &rev, &opts, &published)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("rate limited"), "{err}");
        let steps = published.take();
        assert!(!steps.is_empty(), "chunk a was shown before b failed");
        assert_provisional(&steps);
    }

    /// Streamed groups keep their ids into the final grouping, also when
    /// coarsening merges some on landing (into a group that was shown).
    #[tokio::test]
    async fn coarsening_on_landing_keeps_the_shown_ids() {
        let rev = Revision {
            base: Sha::new("base"),
            head: Sha::new("head"),
            files: vec![
                file("a/one.rs", vec![mk_hunk("a1")]),
                file("a/two.rs", vec![mk_hunk("a2")]),
                file("a/three.rs", vec![mk_hunk("a3")]),
                file("b/one.rs", vec![mk_hunk("b1")]),
                file("b/two.rs", vec![mk_hunk("b2")]),
                file("b/three.rs", vec![mk_hunk("b3")]),
            ],
        };
        let fragmented = r#"{"groups": [
            {"id": "a1g", "title": "a1", "why": "w", "hunks": ["a1"]},
            {"id": "a2g", "title": "a2", "why": "w", "hunks": ["a2"]},
            {"id": "a3g", "title": "a3", "why": "w", "hunks": ["a3"]},
            {"id": "b1g", "title": "b1", "why": "w", "hunks": ["b1"]},
            {"id": "b2g", "title": "b2", "why": "w", "hunks": ["b2"]},
            {"id": "b3g", "title": "b3", "why": "w", "hunks": ["b3"]}
        ]}"#;
        let agent = FakeAgentPort::new([fragmented]);
        let published = Published::default();
        let report = run_streamed(&agent, &rev, &streaming(), &published)
            .await
            .unwrap();
        let steps = published.take();
        assert_eq!(steps.len(), 6);
        assert!(report.grouping.groups.len() <= 4);
        let shown: BTreeSet<&str> = ids(&steps[5].1).into_iter().collect();
        for id in ids(&report.grouping) {
            assert!(shown.contains(id), "{id} was never shown");
        }
        assert!(grouping::validate(&rev, &report.grouping).is_ok());
    }

    /// Without `stream`, a run publishes nothing and asks for no deltas,
    /// whatever the callback.
    #[tokio::test]
    async fn a_run_that_does_not_stream_publishes_nothing() {
        let rev = two_dir_revision();
        let opts = GroupingOptions {
            budget: tiny_budget(),
            ..GroupingOptions::default()
        };
        let agent = FakeAgentPort::routed([
            (
                "Decide the final reading order",
                r#"{"order": ["ga", "gb"]}"#,
            ),
            (
                "### hunk a1",
                r#"{"groups": [{"id": "ga", "title": "A", "why": "a", "hunks": ["a1", "a2"]}]}"#,
            ),
            (
                "### hunk b1",
                r#"{"groups": [{"id": "gb", "title": "B", "why": "b", "hunks": ["b1"]}]}"#,
            ),
        ]);
        let published = Published::default();
        let report = run_streamed(&agent, &rev, &opts, &published).await.unwrap();
        assert!(published.take().is_empty());
        assert!(agent.requests().iter().all(|r| !r.stream_text));
        assert_eq!(report.first_group_ms, report.duration_ms);
        assert_eq!(ids(&report.grouping), ["ga", "gb"]);
    }
}
