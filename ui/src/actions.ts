/**
 * Every user action as a transaction or a direct command — nothing here is
 * faked with a timer. Functions take the `RootStore` explicitly so they are
 * easy to call from components and from tests alike.
 */
import { api } from './core/api';
import { FEATURES } from './features';
import type {
  AgentId,
  Anchor,
  AskRequest,
  HunkId,
  PrId,
  ReviewEvent,
  SnoozeUntil,
  TaskStatus,
} from './gen/contract';
import type { RootStore } from './stores/RootStore';

const hunkReadId = (pr: PrId, hunk: HunkId) => `${pr}:${hunk}`;
const fileViewedId = (pr: PrId, path: string) => `${pr}:${path}`;
const settingId = (scope: string, key: string) => `${scope}:${key}`;

// ── review: read state ─────────────────────────────────────────────────────

export function markHunkRead(store: RootStore, pr: PrId, hunk: HunkId): void {
  const id = hunkReadId(pr, hunk);
  const exists = !!store.models.hunkReads.get(id);
  void store.sync.queue.transact([
    {
      op: exists ? 'update' : 'create',
      model: 'hunk_read',
      id,
      data: { pr, hunk },
    },
  ]);
}

export function markGroupRead(
  store: RootStore,
  pr: PrId,
  hunkIds: HunkId[],
): void {
  for (const h of hunkIds) markHunkRead(store, pr, h);
}

export function setFileViewed(
  store: RootStore,
  pr: PrId,
  path: string,
  viewed: boolean,
): void {
  const id = fileViewedId(pr, path);
  const exists = !!store.models.fileViews.get(id);
  void store.sync.queue.transact([
    {
      op: exists ? 'update' : 'create',
      model: 'file_viewed',
      id,
      data: { pr, path, state: viewed ? 'viewed' : 'unviewed' },
    },
  ]);
}

// ── review: threads, drafts ─────────────────────────────────────────────────

export function addDraft(
  store: RootStore,
  pr: PrId,
  anchor: Anchor,
  body: string,
  source: { kind: 'me' } | { kind: 'agent'; agent: AgentId } = { kind: 'me' },
): void {
  const id = crypto.randomUUID();
  void store.sync.queue.transact([
    {
      op: 'create',
      model: 'draft',
      id,
      data: { id, pr, anchor, body, source },
    },
  ]);
}

export function editDraft(store: RootStore, id: string, body: string): void {
  void store.sync.queue.transact([
    { op: 'update', model: 'draft', id, data: { body } },
  ]);
}

export function removeDraft(store: RootStore, id: string): void {
  void store.sync.queue.transact([{ op: 'delete', model: 'draft', id }]);
}

export function replyThread(
  store: RootStore,
  thread: string,
  pr: PrId,
  author: { kind: 'me' } | { kind: 'agent'; agent: AgentId },
  body: string,
): void {
  const t = store.models.threads.get(thread);
  if (!t) return;
  void store.sync.queue.transact([
    {
      op: 'update',
      model: 'thread',
      id: thread,
      data: {
        comments: [
          ...t.comments,
          {
            id: crypto.randomUUID(),
            author,
            body,
            created_at: Date.now(),
            edited: false,
          },
        ],
      },
    },
  ]);
}

export function resolveThread(
  store: RootStore,
  thread: string,
  resolved: boolean,
): void {
  void store.sync.queue.transact([
    { op: 'update', model: 'thread', id: thread, data: { resolved } },
  ]);
}

// A brand-new thread (GitHub's "single comment", outside a review) has no
// backing command — threads are host state (plan.md §3.4); the UI only
// replies to or resolves ones that already exist, and adds new comments as
// `Draft`s that `submit_review` turns into threads on the host.

// ── review: findings ────────────────────────────────────────────────────────

export function ignoreFinding(store: RootStore, id: string): void {
  void store.sync.queue.transact([
    { op: 'update', model: 'finding', id, data: { state: 'ignored' } },
  ]);
}

export function findingToDraft(
  store: RootStore,
  pr: PrId,
  finding: { id: string; anchor: Anchor; title: string; body: string },
): void {
  addDraft(store, pr, finding.anchor, `**${finding.title}** — ${finding.body}`);
  void store.sync.queue.transact([
    {
      op: 'update',
      model: 'finding',
      id: finding.id,
      data: { state: 'drafted' },
    },
  ]);
}

// ── review: skills, chat, grouping ──────────────────────────────────────────

export async function runSkill(
  _store: RootStore,
  pr: PrId,
  skill: string,
  agents: AgentId[] = [],
): Promise<string> {
  return api.runSkill({ pr, skill, agents });
}

export async function ask(_store: RootStore, req: AskRequest): Promise<string> {
  return api.ask(req);
}

export async function cancelRun(store: RootStore, run: string): Promise<void> {
  await api.cancelRun(run);
  store.ephemeral.clearRun(run);
}

export async function regroup(_store: RootStore, pr: PrId): Promise<void> {
  await api.regroup(pr);
}

export async function submitReview(
  _store: RootStore,
  pr: PrId,
  event: ReviewEvent,
  body: string,
): Promise<void> {
  await api.submitReview({ pr, event, body });
}

// ── tasks ────────────────────────────────────────────────────────────────────

export function setTaskStatus(
  store: RootStore,
  id: string,
  status: TaskStatus,
): void {
  void store.sync.queue.transact([
    { op: 'update', model: 'task', id, data: { status } },
  ]);
}

export function assignTask(
  store: RootStore,
  id: string,
  assignee: { kind: 'human'; id: string } | { kind: 'agent'; id: AgentId },
): void {
  void store.sync.queue.transact([
    { op: 'update', model: 'task', id, data: { assignee, status: 'progress' } },
  ]);
}

// ── inbox triage ─────────────────────────────────────────────────────────────

export function markDone(store: RootStore, ids: PrId[]): void {
  for (const pr of ids) {
    const exists = !!store.models.inboxStates.get(pr);
    void store.sync.queue.transact([
      {
        op: exists ? 'update' : 'create',
        model: 'inbox_state',
        id: pr,
        data: { pr, done: true, snooze: null },
      },
    ]);
  }
}

export function snoozePrs(
  store: RootStore,
  ids: PrId[],
  until: SnoozeUntil,
): void {
  for (const pr of ids) {
    const exists = !!store.models.inboxStates.get(pr);
    void store.sync.queue.transact([
      {
        op: exists ? 'update' : 'create',
        model: 'inbox_state',
        id: pr,
        data: { pr, done: false, snooze: until },
      },
    ]);
  }
}

export function unsnooze(store: RootStore, pr: PrId): void {
  void store.sync.queue.transact([
    { op: 'update', model: 'inbox_state', id: pr, data: { snooze: null } },
  ]);
}

// ── opening a PR ─────────────────────────────────────────────────────────────

export async function openPr(store: RootStore, url: string): Promise<PrId> {
  const res = await api.openPr({ url });
  await store.sync.openPr(res.pr);
  store.ui.go({ name: 'review', pr: res.pr });
  return res.pr;
}

// ── settings ─────────────────────────────────────────────────────────────────

export function setSetting(
  store: RootStore,
  scope: string,
  key: string,
  value: unknown,
): void {
  const id = settingId(scope, key);
  const exists = !!store.models.settings.get(id);
  void store.sync.queue.transact([
    {
      op: exists ? 'update' : 'create',
      model: 'setting',
      id,
      data: { key, scope, value },
    },
  ]);
}

// ── host writes with no command yet (merge, reassign, take, …) ─────────────
// Kept as a single switch so every call site that needs one of these is
// forced to acknowledge FEATURES.hostWrites rather than silently no-op.
export function requireHostWrites(): boolean {
  return FEATURES.hostWrites;
}
