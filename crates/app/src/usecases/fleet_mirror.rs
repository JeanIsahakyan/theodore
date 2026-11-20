//! Fleet, mirrored rows (docs/fleet.md "One space UI: mirrored rows"): a
//! hosted space's own `space` and `chat_message` rows, and its live run
//! steps, sent to the space's followers so they render it like a local one.
//!
//! ```text
//! hosting starts / PassAll / lagged ─▶ resync: the space row + its chat
//! sync frame: the space row, a chat_message of space:<local>  ─▶ touch
//! touch ─▶ sent < 1 s ago? ─▶ held until due (the latest goes then)
//!       └▶ read the row ─▶ rewrite (ids, blanks) ─▶ fit ≤ 48 KiB
//!          ─▶ same as last sent? nothing
//!          ─▶ mirror{model,id,data}, seq+1 ─▶ journal (latest per row) ─▶ send
//! run step ─▶ mirror{turn_step, <run>:<n>}, seq+1 ─▶ send only
//! ```
//!
//! Runs on the observer task only, like the rest of what it reports: the
//! space's seq is never written by two at once.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::{DefaultHasher, Hash, Hasher};

use serde_json::Value;
use theodore_contract::{SyncCode, SyncFrame, TurnStep, models};
use theodore_fleet_protocol::{
    DEVICE_JOURNAL, MIRROR_ROW_MAX_BYTES, MirroredSubSpace, RemoteSpaceEvent, SUB_SPACE_MODEL,
};

use crate::core::Core;
use crate::usecases::spaces::space_chat_key;

/// A row goes out at most this often; the latest value goes when it's due.
pub(crate) const MIRROR_EVERY_MS: i64 = 1000;
pub(crate) const TURN_STEP: &str = "turn_step";

/// `(remote space, model, id)`.
type Key = (String, String, String);

/// What the observer has mirrored. Memory only: after a restart the journal
/// says what went out last.
#[derive(Default)]
pub(crate) struct Mirror {
    /// When each row last went out.
    sent_at: HashMap<Key, i64>,
    /// Rows changed while held: when they may go.
    due: BTreeMap<Key, i64>,
    /// What each row last went out as (its JSON's hash; `None`: deleted).
    sent: HashMap<Key, Option<u64>>,
    /// Chat message id → its hosted space: a delete doesn't say.
    chat: HashMap<String, String>,
    /// Hosted spaces whose journal seeded `sent`.
    seeded: HashSet<String>,
    /// Local run → its steps so far (the next step's `n`). One run per space.
    steps: HashMap<String, u32>,
    /// The current runs' steps by mirrored id, with their local run: what a
    /// tool call's end or more text updates and sends again.
    live: HashMap<String, (String, TurnStep)>,
    /// `(local run, tool call id)` → its step's mirrored id.
    tools: HashMap<(String, String), String>,
    /// Local run → the mirrored id of the text row being written.
    text: HashMap<String, String>,
    /// Sub-space (local id) → the hosted space at the top of its tree:
    /// its `sub_space` rows go there.
    subs: HashMap<String, String>,
}

impl Mirror {
    /// When the next held row is due.
    pub(crate) fn next_due(&self) -> Option<i64> {
        self.due.values().min().copied()
    }

    /// `true`: `key` may go now. Else it's held until a second after it
    /// last went (and goes then with whatever it is by then).
    fn may_send(&mut self, key: &Key, now: i64) -> bool {
        match self.sent_at.get(key) {
            Some(&at) if now - at < MIRROR_EVERY_MS => {
                self.due.entry(key.clone()).or_insert(at + MIRROR_EVERY_MS);
                false
            }
            _ => true,
        }
    }

    /// Held rows due by `now`, taken.
    fn take_due(&mut self, now: i64) -> Vec<Key> {
        let keys: Vec<Key> = self
            .due
            .iter()
            .filter(|(_, at)| **at <= now)
            .map(|(k, _)| k.clone())
            .collect();
        for k in &keys {
            self.due.remove(k);
        }
        keys
    }

    /// `n` of the next step of local run `run`, forgetting the space's
    /// earlier runs.
    fn next_step(&mut self, run: &str, local: &str) -> u32 {
        if !self.steps.contains_key(run) {
            let prefix = format!("space:{local}:");
            self.steps.retain(|r, _| !r.starts_with(&prefix));
            self.live.retain(|_, (r, _)| !r.starts_with(&prefix));
            self.tools.retain(|(r, _), _| !r.starts_with(&prefix));
            self.text.retain(|r, _| !r.starts_with(&prefix));
        }
        let n = self.steps.entry(run.to_string()).or_insert(0);
        let at = *n;
        *n += 1;
        at
    }
}

fn hash_of(data: &Option<Value>) -> Option<u64> {
    data.as_ref().map(|v| {
        let mut h = DefaultHasher::new();
        v.to_string().hash(&mut h);
        h.finish()
    })
}

/// Every `space:<local>` (exactly, or as a prefix up to `:`) in `value`'s
/// strings becomes `space:<remote>`: a chat's `pr`, a run id.
pub(crate) fn rewrite_ids(value: &mut Value, local: &str, remote: &str) {
    let from = format!("space:{local}");
    let to = format!("space:{remote}");
    fn walk(v: &mut Value, from: &str, to: &str) {
        match v {
            Value::String(s) => {
                if let Some(rest) = s.strip_prefix(from)
                    && (rest.is_empty() || rest.starts_with(':'))
                {
                    *s = format!("{to}{rest}");
                }
            }
            Value::Array(a) => a.iter_mut().for_each(|x| walk(x, from, to)),
            Value::Object(o) => o.values_mut().for_each(|x| walk(x, from, to)),
            _ => {}
        }
    }
    walk(value, &from, &to);
}

/// The space row as followers get it: the fleet id, ids rewritten, the
/// parts that only mean something on this machine blanked, `remote` never
/// set (the follower sets it).
pub(crate) fn mirror_space(mut v: Value, local: &str, remote: &str) -> Value {
    rewrite_ids(&mut v, local, remote);
    if let Some(o) = v.as_object_mut() {
        o.insert("id".into(), Value::String(remote.into()));
        o.insert("worktree".into(), Value::String(String::new()));
        o.insert("ports".into(), Value::Array(vec![]));
        o.insert("agent_session".into(), Value::Null);
        o.insert("sent_feedback".into(), Value::Array(vec![]));
        o.insert("review_pr".into(), Value::Null);
        // The local folder it mirrors into, and the run command's process.
        o.insert("mirror".into(), Value::Null);
        if let Some(p) = o.get_mut("process").and_then(Value::as_object_mut) {
            p.remove("pgid");
            p.remove("script");
        }
        o.remove("remote");
    }
    v
}

/// The JSON length of `mirror{model, id, data}` (laid out as
/// `RemoteSpaceEvent::Mirror`, without copying `data`).
fn event_len(model: &str, id: &str, data: Option<&Value>) -> usize {
    #[derive(serde::Serialize)]
    struct Ev<'a> {
        kind: &'static str,
        model: &'a str,
        id: &'a str,
        data: Option<&'a Value>,
    }
    serde_json::to_vec(&Ev {
        kind: "mirror",
        model,
        id,
        data,
    })
    .map_or(usize::MAX, |b| b.len())
}

/// JSON pointer of the longest string in `v`, and its length.
pub(crate) fn longest_string(v: &Value, at: &str, best: &mut Option<(String, usize)>) {
    match v {
        Value::String(s) if best.as_ref().is_none_or(|(_, n)| s.len() > *n) => {
            *best = Some((at.to_string(), s.len()));
        }
        Value::Array(a) => {
            for (i, x) in a.iter().enumerate() {
                longest_string(x, &format!("{at}/{i}"), best);
            }
        }
        Value::Object(o) => {
            for (k, x) in o {
                let k = k.replace('~', "~0").replace('/', "~1");
                longest_string(x, &format!("{at}/{k}"), best);
            }
        }
        _ => {}
    }
}

/// JSON pointer of the array with the most items in `v`, and its length.
fn longest_array(v: &Value, at: &str, best: &mut Option<(String, usize)>) {
    match v {
        Value::Array(a) => {
            if best.as_ref().is_none_or(|(_, n)| a.len() > *n) {
                *best = Some((at.to_string(), a.len()));
            }
            for (i, x) in a.iter().enumerate() {
                longest_array(x, &format!("{at}/{i}"), best);
            }
        }
        Value::Object(o) => {
            for (k, x) in o {
                let k = k.replace('~', "~0").replace('/', "~1");
                longest_array(x, &format!("{at}/{k}"), best);
            }
        }
        _ => {}
    }
}

pub(crate) fn floor_boundary(s: &str, mut at: usize) -> usize {
    at = at.min(s.len());
    while !s.is_char_boundary(at) {
        at -= 1;
    }
    at
}

/// `data` cut until its `mirror` event's JSON fits [`MIRROR_ROW_MAX_BYTES`]:
/// the longest text first, ending in a note that says so; when no text is
/// long enough to cut, the oldest half of the longest list goes. `None`
/// when it can't be made to fit (never sent oversize).
pub(crate) fn fit(model: &str, id: &str, data: Option<Value>, host: &str) -> Option<Option<Value>> {
    let Some(mut v) = data else {
        return (event_len(model, id, None) <= MIRROR_ROW_MAX_BYTES).then_some(None);
    };
    let note = format!("… (cut, full text on {host})");
    loop {
        let len = event_len(model, id, Some(&v));
        if len <= MIRROR_ROW_MAX_BYTES {
            return Some(Some(v));
        }
        let over = len - MIRROR_ROW_MAX_BYTES;
        let mut best = None;
        longest_string(&v, "", &mut best);
        if let Some((at, n)) = best
            && n > note.len() + 64
            && let Some(Value::String(s)) = v.pointer_mut(&at)
        {
            let base = s.strip_suffix(note.as_str()).unwrap_or(s);
            let keep = floor_boundary(base, base.len().saturating_sub(over + note.len() + 16));
            *s = format!("{}{note}", &base[..keep]);
            continue;
        }
        let mut best = None;
        longest_array(&v, "", &mut best);
        match best {
            Some((at, n)) if n > 0 => {
                if let Some(Value::Array(a)) = v.pointer_mut(&at) {
                    a.drain(..n.div_ceil(2));
                }
            }
            _ => return None,
        }
    }
}

impl Core {
    /// Reads what went out last for `remote` from its journal, once per
    /// process: a restart doesn't send every row again.
    async fn fleet_mirror_seed(&self, m: &mut Mirror, remote: &str) {
        if !m.seeded.insert(remote.to_string()) {
            return;
        }
        let store = self.0.deps.store.clone();
        let space = remote.to_string();
        let journal = tokio::task::spawn_blocking(move || {
            store.fleet_journal_since(&space, 0, DEVICE_JOURNAL)
        })
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
        for (_, value) in journal {
            let Ok(RemoteSpaceEvent::Mirror { model, id, data }) = serde_json::from_value(value)
            else {
                continue;
            };
            if model == models::CHAT_MESSAGE {
                if data.is_some() {
                    m.chat.insert(id.clone(), remote.to_string());
                } else {
                    m.chat.remove(&id);
                }
            }
            if model == SUB_SPACE_MODEL {
                if data.is_some() {
                    m.subs.insert(id.clone(), remote.to_string());
                } else {
                    m.subs.remove(&id);
                }
            }
            m.sent
                .insert((remote.to_string(), model, id), hash_of(&data));
        }
    }

    /// Row `(model, id)` of hosted space `remote` (local `local`) as
    /// followers get it; `None`: it's gone.
    async fn fleet_mirror_row(
        &self,
        local: &str,
        remote: &str,
        model: &str,
        id: &str,
    ) -> Option<Value> {
        let store = self.0.deps.store.clone();
        let (mdl, key) = (
            // A sub-space's row is a space row.
            if model == SUB_SPACE_MODEL {
                models::SPACE.to_string()
            } else {
                model.to_string()
            },
            if model == models::SPACE {
                local.to_string()
            } else {
                id.to_string()
            },
        );
        let row = tokio::task::spawn_blocking(move || store.get(&mdl, &key))
            .await
            .ok()
            .and_then(Result::ok)
            .flatten()?;
        match model {
            models::SPACE => Some(mirror_space(row.data, local, remote)),
            SUB_SPACE_MODEL => {
                let s: theodore_contract::Space = serde_json::from_value(row.data).ok()?;
                let parent = s.parent.as_ref()?.space.clone();
                let sub = MirroredSubSpace {
                    space: s.id.clone(),
                    parent: if parent == local {
                        remote.to_string()
                    } else {
                        parent
                    },
                    title: crate::usecases::space_children::title_of(&s),
                    status: crate::usecases::space_children::status_word(&s).to_string(),
                    mode: crate::usecases::fleet::fleet_mode(s.mode),
                    done: s.done_at.is_some(),
                };
                serde_json::to_value(sub).ok()
            }
            models::CHAT_MESSAGE => {
                let mine = row.data.get("pr").and_then(Value::as_str)
                    == Some(space_chat_key(local).0.as_str());
                if row.archived || !mine {
                    return None;
                }
                let mut v = row.data;
                rewrite_ids(&mut v, local, remote);
                Some(v)
            }
            _ => None,
        }
    }

    /// Row `(model, id)` of `remote` changed: it goes now, or when due.
    async fn fleet_mirror_touch(&self, m: &mut Mirror, remote: &str, model: &str, id: &str) {
        self.fleet_mirror_seed(m, remote).await;
        if model == models::CHAT_MESSAGE {
            m.chat.insert(id.to_string(), remote.to_string());
        }
        let key = (remote.to_string(), model.to_string(), id.to_string());
        if m.may_send(&key, self.0.deps.clock.now()) {
            self.fleet_mirror_out(m, key).await;
        }
    }

    /// Sends row `key` as it is now, unless that's what went last.
    async fn fleet_mirror_out(&self, m: &mut Mirror, key: Key) {
        let Some(local) = self
            .fleet()
            .hosted
            .get(&key.0)
            .map(|h| h.row.local_space.clone())
        else {
            return;
        };
        let (remote, model, id) = &key;
        if model == TURN_STEP {
            self.fleet_mirror_live_out(m, remote, &local, id).await;
            return;
        }
        let data = self.fleet_mirror_row(&local, remote, model, id).await;
        let host = self.fleet_name(&self.fleet_settings().await).await;
        let Some(data) = fit(model, id, data, &host) else {
            tracing::warn!(error.code = "fleet.mirror_too_big", %model, "a mirrored row didn't fit; not sent");
            return;
        };
        let hash = hash_of(&data);
        let before = m.sent.get(&key); // Never sent and gone: nothing for followers to forget.
        if before == Some(&hash) || (before.is_none() && data.is_none()) {
            return;
        }
        let gone = data.is_none();
        if !self.fleet_mirror_emit(remote, model, id, data, true).await {
            return;
        }
        if model == models::CHAT_MESSAGE && gone {
            m.chat.remove(id);
        }
        m.sent_at.insert(key.clone(), self.0.deps.clock.now());
        m.due.remove(&key);
        m.sent.insert(key, hash);
    }

    /// `mirror` event of `remote`, its next seq: journaled (only the latest
    /// per row kept) and sent; not journaled, the seq is stored with the
    /// hosted row so a restart doesn't reuse it. `false`: not started yet.
    async fn fleet_mirror_emit(
        &self,
        remote: &str,
        model: &str,
        id: &str,
        data: Option<Value>,
        journal: bool,
    ) -> bool {
        let (seq, row) = {
            let mut mem = self.fleet();
            let Some(h) = mem.hosted.get_mut(remote) else {
                return false;
            };
            if !h.data.track.started {
                return false;
            }
            h.data.track.seq += 1;
            let row = (!journal).then(|| {
                h.row.data = serde_json::to_value(&h.data).unwrap_or_default();
                h.row.clone()
            });
            (h.data.track.seq, row)
        };
        let event = RemoteSpaceEvent::Mirror {
            model: model.to_string(),
            id: id.to_string(),
            data,
        };
        if journal {
            if let Ok(value) = serde_json::to_value(&event) {
                let store = self.0.deps.store.clone();
                let (space, mdl, rid) = (remote.to_string(), model.to_string(), id.to_string());
                let kept = tokio::task::spawn_blocking(move || {
                    store.fleet_journal_put_mirror(
                        &space,
                        seq,
                        &value,
                        (&mdl, &rid),
                        DEVICE_JOURNAL,
                    )
                })
                .await;
                if let Ok(Err(e)) = kept {
                    tracing::warn!(error.code = e.code(), error = %e, "couldn't journal a mirrored row");
                }
            }
        } else if let Some(row) = row {
            self.fleet_put_hosted(&row).await;
        }
        self.fleet_send_event(remote, seq, event).await;
        true
    }

    /// Held rows that are due go now.
    pub(crate) async fn fleet_mirror_flush(&self, m: &mut Mirror) {
        for key in m.take_due(self.0.deps.clock.now()) {
            self.fleet_mirror_out(m, key).await;
        }
    }

    /// Every row of hosted space `remote`, as a change: the snapshot when
    /// hosting starts, and what a lagged or restarted observer missed (rows
    /// unchanged since they last went are skipped; known chat rows no
    /// longer there are deleted).
    pub(crate) async fn fleet_mirror_resync(&self, m: &mut Mirror, remote: &str) {
        let Some(local) = self
            .fleet()
            .hosted
            .get(remote)
            .filter(|h| h.data.track.started)
            .map(|h| h.row.local_space.clone())
        else {
            return;
        };
        self.fleet_mirror_touch(m, remote, models::SPACE, remote)
            .await;
        let store = self.0.deps.store.clone();
        let key = space_chat_key(&local).0;
        let rows =
            tokio::task::spawn_blocking(move || store.query(models::CHAT_MESSAGE, "pr", &key))
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default();
        let mut chat: Vec<(i64, String)> = rows
            .into_iter()
            .filter(|r| !r.archived)
            .map(|r| (r.data.get("at").and_then(Value::as_i64).unwrap_or(0), r.id))
            .collect();
        chat.sort();
        let here: HashSet<&str> = chat.iter().map(|(_, id)| id.as_str()).collect();
        let gone: Vec<String> = m
            .chat
            .iter()
            .filter(|(id, r)| r.as_str() == remote && !here.contains(id.as_str()))
            .map(|(id, _)| id.clone())
            .collect();
        for (_, id) in &chat {
            self.fleet_mirror_touch(m, remote, models::CHAT_MESSAGE, id)
                .await;
        }
        for id in gone {
            self.fleet_mirror_touch(m, remote, models::CHAT_MESSAGE, &id)
                .await;
        }
        self.fleet_mirror_resync_subs(m, remote, &local).await;
    }

    /// The hosted space whose tree space row action `a` is in (a sub-space
    /// of it, at any depth), if any: known already, or found from the
    /// row's parents when the action names a parent.
    async fn fleet_mirror_sub_of(
        &self,
        m: &mut Mirror,
        a: &theodore_contract::WireAction,
    ) -> Option<String> {
        if let Some(r) = m.subs.get(&a.model_id) {
            return Some(r.clone());
        }
        let names_parent = a
            .data
            .as_ref()
            .and_then(|d| d.get("parent"))
            .is_some_and(|p| !p.is_null());
        if !names_parent {
            return None;
        }
        let root = self.fleet_hosted_root(&a.model_id).await?;
        if root.local_space == a.model_id {
            return None;
        }
        m.subs.insert(a.model_id.clone(), root.space.clone());
        Some(root.space)
    }

    /// Every sub-space under hosted space `remote` (local `local`), as a
    /// change.
    async fn fleet_mirror_resync_subs(&self, m: &mut Mirror, remote: &str, local: &str) {
        let Ok(spaces) = self.local_spaces(None).await else {
            return;
        };
        let mut tree: HashSet<String> = HashSet::from([local.to_string()]);
        // Parents before children needn't hold in the list: grow until
        // nothing joins (a tree is a few levels deep).
        loop {
            let before = tree.len();
            for s in &spaces {
                if let Some(p) = &s.parent
                    && tree.contains(&p.space)
                {
                    tree.insert(s.id.clone());
                }
            }
            if tree.len() == before {
                break;
            }
        }
        tree.remove(local);
        for id in tree {
            m.subs.insert(id.clone(), remote.to_string());
            self.fleet_mirror_touch(m, remote, SUB_SPACE_MODEL, &id)
                .await;
        }
    }

    pub(crate) async fn fleet_mirror_resync_all(&self, m: &mut Mirror) {
        let remotes: Vec<String> = self.fleet().hosted.keys().cloned().collect();
        for r in remotes {
            self.fleet_mirror_resync(m, &r).await;
        }
    }

    /// The rows of hosted spaces `frame` changed.
    pub(crate) async fn fleet_mirror_frame(&self, m: &mut Mirror, frame: &SyncFrame) {
        let by_local = self.fleet_by_local();
        if !by_local.is_empty() {
            let mut touched: Vec<(String, &'static str, String)> = Vec::new();
            for a in &frame.actions {
                if a.model == models::SPACE {
                    if let Some(r) = by_local.get(&a.model_id) {
                        touched.push((r.clone(), models::SPACE, r.clone()));
                    } else if let Some(r) = self.fleet_mirror_sub_of(m, a).await {
                        touched.push((r, SUB_SPACE_MODEL, a.model_id.clone()));
                    }
                } else if a.model == models::CHAT_MESSAGE {
                    let pr = a
                        .data
                        .as_ref()
                        .and_then(|d| d.get("pr"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let pr = match pr {
                        Some(pr) => Some(pr),
                        // A partial update names only what changed.
                        None if m.chat.contains_key(&a.model_id)
                            || matches!(a.action, SyncCode::D | SyncCode::A) =>
                        {
                            None
                        }
                        None => {
                            let store = self.0.deps.store.clone();
                            let id = a.model_id.clone();
                            tokio::task::spawn_blocking(move || {
                                store.get(models::CHAT_MESSAGE, &id)
                            })
                            .await
                            .ok()
                            .and_then(Result::ok)
                            .flatten()
                            .and_then(|r| {
                                r.data.get("pr").and_then(Value::as_str).map(str::to_string)
                            })
                        }
                    };
                    let remote = pr
                        .as_deref()
                        .and_then(|p| p.strip_prefix("space:"))
                        .and_then(|l| by_local.get(l))
                        .cloned()
                        .or_else(|| m.chat.get(&a.model_id).cloned());
                    if let Some(r) = remote {
                        touched.push((r, models::CHAT_MESSAGE, a.model_id.clone()));
                    }
                }
            }
            for (remote, model, id) in touched {
                self.fleet_mirror_touch(m, &remote, model, &id).await;
            }
        }
        self.fleet_mirror_flush(m).await;
    }

    /// A live step of run `run`: sent as `turn_step`, never journaled (a
    /// finished turn's steps are in its reply's `activity`). The run's text
    /// row being written goes first, so followers keep the order.
    pub(crate) async fn fleet_mirror_step(&self, m: &mut Mirror, run: &str, step: &TurnStep) {
        let Some((local, remote)) = self.fleet_mirror_run(run) else {
            return;
        };
        self.fleet_mirror_text_end(m, run, &remote, &local).await;
        let id = mirrored_step_id(run, &local, &remote, m.next_step(run, &local));
        if let TurnStep::Tool { id: Some(call), .. } = step {
            m.tools.insert((run.to_string(), call.clone()), id.clone());
        }
        m.live.insert(id.clone(), (run.to_string(), step.clone()));
        self.fleet_mirror_live_out(m, &remote, &local, &id).await;
    }

    /// Tool call `call` of `run` ended or learned its summary: its step
    /// again, under the same id.
    pub(crate) async fn fleet_mirror_step_done(
        &self,
        m: &mut Mirror,
        run: &str,
        call: &str,
        done: (Option<bool>, Option<String>, bool),
    ) {
        let Some((local, remote)) = self.fleet_mirror_run(run) else {
            return;
        };
        let Some(id) = m.tools.get(&(run.to_string(), call.to_string())).cloned() else {
            return;
        };
        let (ok, summary, background) = done;
        if let Some((
            _,
            TurnStep::Tool {
                ok: o,
                summary: s,
                background: b,
                ..
            },
        )) = m.live.get_mut(&id)
        {
            if ok.is_some() {
                *o = ok;
            }
            if summary.is_some() {
                *s = summary;
            }
            *b |= background;
        }
        self.fleet_mirror_live_out(m, &remote, &local, &id).await;
    }

    /// More of `run`'s own text: its text row (a new one after a break or a
    /// step), held like any row so a stream goes at most once a second.
    pub(crate) async fn fleet_mirror_delta(&self, m: &mut Mirror, run: &str, text: &str) {
        let Some((local, remote)) = self.fleet_mirror_run(run) else {
            return;
        };
        let id = match m.text.get(run) {
            Some(id) => id.clone(),
            None => {
                let id = mirrored_step_id(run, &local, &remote, m.next_step(run, &local));
                m.text.insert(run.to_string(), id.clone());
                let row = TurnStep::Text {
                    text: String::new(),
                    parent: None,
                };
                m.live.insert(id.clone(), (run.to_string(), row));
                id
            }
        };
        if let Some((_, TurnStep::Text { text: t, .. })) = m.live.get_mut(&id) {
            t.push_str(text);
        }
        let key = (remote.clone(), TURN_STEP.to_string(), id.clone());
        if m.may_send(&key, self.0.deps.clock.now()) {
            self.fleet_mirror_live_out(m, &remote, &local, &id).await;
        }
    }

    /// The next text of `run` is a new row: the current one goes as it is.
    pub(crate) async fn fleet_mirror_text_break(&self, m: &mut Mirror, run: &str) {
        if let Some((local, remote)) = self.fleet_mirror_run(run) {
            self.fleet_mirror_text_end(m, run, &remote, &local).await;
        }
    }

    async fn fleet_mirror_text_end(&self, m: &mut Mirror, run: &str, remote: &str, local: &str) {
        let Some(id) = m.text.remove(run) else {
            return;
        };
        let key = (remote.to_string(), TURN_STEP.to_string(), id.clone());
        if m.due.contains_key(&key) {
            self.fleet_mirror_live_out(m, remote, local, &id).await;
        }
    }

    /// `run`'s `(local space, remote space)`, when it's a hosted space's.
    fn fleet_mirror_run(&self, run: &str) -> Option<(String, String)> {
        let local = run.strip_prefix("space:")?.split(':').next()?.to_string();
        let remote = self.fleet_by_local().get(&local).cloned()?;
        Some((local, remote))
    }

    /// Live step `id` as it is now: sent, not journaled.
    async fn fleet_mirror_live_out(&self, m: &mut Mirror, remote: &str, local: &str, id: &str) {
        let Some((_, step)) = m.live.get(id) else {
            return;
        };
        let Ok(mut data) = serde_json::to_value(step) else {
            return;
        };
        rewrite_ids(&mut data, local, remote);
        let host = self.fleet_name(&self.fleet_settings().await).await;
        let Some(data) = fit(TURN_STEP, id, Some(data), &host) else {
            return;
        };
        let key = (remote.to_string(), TURN_STEP.to_string(), id.to_string());
        m.due.remove(&key);
        m.sent_at.insert(key, self.0.deps.clock.now());
        self.fleet_mirror_emit(remote, TURN_STEP, id, data, false)
            .await;
    }
}

/// The mirrored id of step `n` of local run `run`: `<run as rs_>:<n>`.
fn mirrored_step_id(run: &str, local: &str, remote: &str, n: u32) -> String {
    let mut run_id = Value::String(run.to_string());
    rewrite_ids(&mut run_id, local, remote);
    format!("{}:{n}", run_id.as_str().unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ids_are_rewritten_and_local_parts_blanked() {
        let row = json!({
            "id": "s1", "run": "space:s1:m9", "worktree": "/w/s1", "ports": [4000],
            "agent_session": {"id": "x"}, "sent_feedback": [{"a": 1}],
            "review_pr": "space-review:s1", "remote": {"space": "rs_9"},
            "name": "space:s10 stays", "goal": "space:s1",
        });
        let v = mirror_space(row, "s1", "rs_1");
        assert_eq!(v["id"], "rs_1");
        assert_eq!(v["run"], "space:rs_1:m9");
        assert_eq!(v["goal"], "space:rs_1");
        assert_eq!(v["name"], "space:s10 stays");
        assert_eq!(v["worktree"], "");
        assert_eq!(v["ports"], json!([]));
        assert_eq!(v["agent_session"], Value::Null);
        assert_eq!(v["sent_feedback"], json!([]));
        assert_eq!(v["review_pr"], Value::Null);
        assert!(v.get("remote").is_none());
    }

    #[test]
    fn a_row_too_big_has_its_longest_text_cut_with_a_note() {
        let big = "é".repeat(40 * 1024);
        let row = json!({"id": "m1", "text": big, "other": "x".repeat(20_000)});
        let out = fit("chat_message", "m1", Some(row), "mac2")
            .unwrap()
            .unwrap();
        assert!(event_len("chat_message", "m1", Some(&out)) <= MIRROR_ROW_MAX_BYTES);
        let text = out["text"].as_str().unwrap();
        assert!(text.ends_with("… (cut, full text on mac2)"));
        assert!(text.len() > 10_000, "cut only as much as needed");
        assert_eq!(out["other"].as_str().unwrap().len(), 20_000);
        // Fits already: untouched.
        let small = json!({"id": "m1", "text": "hi"});
        assert_eq!(
            fit("chat_message", "m1", Some(small.clone()), "h"),
            Some(Some(small))
        );
        assert_eq!(fit("chat_message", "m1", None, "h"), Some(None));
    }

    #[test]
    fn many_short_texts_lose_their_oldest_items() {
        let steps: Vec<Value> = (0..2000)
            .map(|i| json!({"kind": "tool", "name": format!("step {i}")}))
            .collect();
        let row = json!({"id": "m1", "activity": steps});
        let out = fit("chat_message", "m1", Some(row), "h").unwrap().unwrap();
        assert!(event_len("chat_message", "m1", Some(&out)) <= MIRROR_ROW_MAX_BYTES);
        let kept = out["activity"].as_array().unwrap();
        assert!(!kept.is_empty());
        assert_eq!(kept.last().unwrap()["name"], "step 1999");
    }

    #[test]
    fn a_row_goes_at_most_once_a_second_and_the_latest_when_due() {
        let mut m = Mirror::default();
        let k: Key = ("rs_1".into(), "space".into(), "rs_1".into());
        assert!(m.may_send(&k, 1000));
        m.sent_at.insert(k.clone(), 1000);
        assert!(!m.may_send(&k, 1200));
        assert!(!m.may_send(&k, 1500));
        // Held once, due a second after it last went.
        assert_eq!(m.next_due(), Some(2000));
        assert!(m.take_due(1999).is_empty());
        assert_eq!(m.take_due(2000), vec![k.clone()]);
        assert_eq!(m.next_due(), None);
        assert!(m.may_send(&k, 2000));
    }

    #[test]
    fn steps_count_per_run_and_a_new_run_starts_over() {
        let mut m = Mirror::default();
        assert_eq!(m.next_step("space:s1:a", "s1"), 0);
        assert_eq!(m.next_step("space:s1:a", "s1"), 1);
        assert_eq!(m.next_step("space:s2:x", "s2"), 0);
        assert_eq!(m.next_step("space:s1:b", "s1"), 0);
        assert!(!m.steps.contains_key("space:s1:a"));
        assert!(m.steps.contains_key("space:s2:x"));
    }
}
