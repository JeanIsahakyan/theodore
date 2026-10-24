import type { Route } from './stores/UiStore';
/**
 * Every user action as a transaction or a direct command — nothing here is
 * faked with a timer. Functions take the `RootStore` explicitly so they are
 * easy to call from components and from tests alike.
 */
import { api } from './core/api';
import { NO_ACCOUNT } from './core/accountGate';
import type {
  AddProjectRequest,
  AgentId,
  Anchor,
  AskRequest,
  CommentId,
  DraftStateRequest,
  HunkId,
  MergeRequest,
  OpenBranchRequest,
  PrId,
  Project,
  RerunCheckRequest,
  ReviewEvent,
  ReviewersRequest,
  SaveSkillRequest,
  SkillBody,
  SnoozeUntil,
  TaskStatus,
  TriageAction,
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

/** Sends a reply to the host; the comment lands in `pr_detail.threads` once
 *  sync catches up, so there's nothing to apply optimistically here. A
 *  rejection already shows a toast (`api.ts`); this just stops it short of
 *  an unhandled rejection in the caller. */
export async function replyThread(
  _store: RootStore,
  pr: PrId,
  thread: string,
  body: string,
): Promise<void> {
  try {
    await api.replyThread({ pr, thread, body });
  } catch {
    // toasted by api.ts
  }
}

export async function resolveThread(
  _store: RootStore,
  pr: PrId,
  thread: string,
  resolved: boolean,
): Promise<void> {
  try {
    await api.resolveThread({ pr, thread, resolved });
  } catch {
    // toasted by api.ts
  }
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

export function findingToTask(
  store: RootStore,
  pr: PrId,
  finding: { id: string; anchor: Anchor; title: string; body: string },
): void {
  const id = crypto.randomUUID();
  void store.sync.queue.transact([
    {
      op: 'create',
      model: 'task',
      id,
      data: {
        id,
        pr,
        title: finding.title,
        body: finding.body,
        anchor: finding.anchor,
        thread: null,
        status: 'todo',
        // Yours: your host login, so Tasks → Mine finds it. `me` only
        // before the login is known (Tasks treats it as yours too).
        assignee: { kind: 'human', id: store.ephemeral.viewer?.login ?? 'me' },
        fix: null,
        created_at: Date.now(),
      },
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
  store.sync.undo.run(() => {
    void store.sync.queue.transact([
      {
        op: 'update',
        model: 'task',
        id,
        data: { assignee, status: 'progress' },
      },
    ]);
  });
  toastWithUndo(store, `Assigned to ${assignee.id}`);
}

/** Hands a task to an agent CLI, which fixes it in the PR worktree (Edit
 *  mode). The task's own status moves to `progress`/`review` via sync, not
 *  locally — this only kicks the run off. Returns the run id, or `null` on
 *  a graceful failure (toast, no crash). */
export async function delegateTask(
  _store: RootStore,
  task: string,
  agent: AgentId | null = null,
): Promise<string | null> {
  try {
    return await api.delegateTask({ task, agent });
  } catch {
    return null; // toasted by api.ts
  }
}

/** Accept: own/local PR commits + pushes the fix, else drafts it as a
 *  suggestion; resolves the linked thread. Reject: back to `todo`, `reason`
 *  goes to the agent on the next attempt. */
export async function decideTask(
  _store: RootStore,
  task: string,
  accept: boolean,
  reason: string | null = null,
): Promise<void> {
  try {
    await api.decideTask({ task, accept, reason });
  } catch {
    // toasted by api.ts
  }
}

// ── inbox triage ─────────────────────────────────────────────────────────────

/** Pops up a toast whose action re-runs `store.sync.undo.undo()` — shared by
 *  every Done/Snooze/Archive-type action below, all of which are one undo
 *  step (wrapped in `undo.run`) by the time this fires. */
function toastWithUndo(store: RootStore, text: string): void {
  store.ephemeral.toast(text, 'info', {
    label: 'Undo',
    onAction: () => void store.sync.undo.undo(),
  });
}

export function markDone(store: RootStore, ids: PrId[]): void {
  store.sync.undo.run(() => {
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
  });
  toastWithUndo(
    store,
    ids.length === 1 ? 'Marked done' : `Marked ${ids.length} done`,
  );
}

export function snoozePrs(
  store: RootStore,
  ids: PrId[],
  until: SnoozeUntil,
): void {
  store.sync.undo.run(() => {
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
  });
  toastWithUndo(
    store,
    ids.length === 1 ? 'Snoozed' : `Snoozed ${ids.length} PRs`,
  );
}

export function unsnooze(store: RootStore, pr: PrId): void {
  store.sync.undo.run(() => {
    void store.sync.queue.transact([
      { op: 'update', model: 'inbox_state', id: pr, data: { snooze: null } },
    ]);
  });
  toastWithUndo(store, 'Unsnoozed');
}

// ── inbox / viewer ───────────────────────────────────────────────────────────

/** Asks the core to run the inbox searches again; rows land via `sync`.
 *  A command the core doesn't have yet degrades to a toast, not a crash. */
export async function refreshInbox(store: RootStore): Promise<void> {
  store.ephemeral.setInboxLoading(true);
  try {
    await api.refreshInbox();
  } catch {
    // toasted by api.ts
  } finally {
    store.ephemeral.setInboxLoading(false);
  }
}

/** Fetches and caches the authenticated host user, for the Mine filter and "you" labels. */
export async function loadViewer(store: RootStore): Promise<void> {
  if (store.ephemeral.viewer || store.ephemeral.viewerLoading) return;
  // Behind the account gate the core turns it away; it runs once open.
  if (store.ephemeral.accountGate !== 'open') return;
  store.ephemeral.setViewerLoading(true);
  try {
    store.ephemeral.setViewer(await api.viewer());
  } catch {
    // No host connected yet (onboarding not finished) — Mine stays empty.
  } finally {
    store.ephemeral.setViewerLoading(false);
  }
}

/** `account_status` into the store: at startup (the gate waits on it) and
 *  whenever a command is turned away for want of a sign-in. A failure
 *  leaves the UI open; the core still enforces the gate. */
export async function loadAccount(store: RootStore): Promise<void> {
  try {
    store.ephemeral.setAccount(await api.accountStatus());
  } catch {
    if (!store.ephemeral.account) store.ephemeral.setAccount(NO_ACCOUNT);
  }
}

/** `app_info` once at startup — version, channel, and whether this window
 *  runs against the sandbox host (the SANDBOX badge and Settings page). */
export async function loadAppInfo(store: RootStore): Promise<void> {
  try {
    store.ephemeral.setAppInfo(await api.appInfo());
  } catch {
    // Already toasted by `api.ts`; the badge just stays hidden.
  }
}

// ── opening a PR ─────────────────────────────────────────────────────────────

/** `null` on a rejected `open_pr` (bad URL, no access, …) — already toasted
 *  by `api.ts`; nothing left for the caller but to stop spinning. */
export async function openPr(
  store: RootStore,
  url: string,
  /** A blank tab to turn into this review. */
  replace?: Route,
): Promise<PrId | null> {
  try {
    const res = await api.openPr({ url });
    await store.sync.openPr(res.pr);
    const to: Route = { name: 'review', pr: res.pr };
    if (replace) store.ui.replaceTab(replace, to);
    else store.ui.go(to);
    return res.pr;
  } catch {
    return null;
  }
}

// ── projects ─────────────────────────────────────────────────────────────────

/** `null` on a rejected `add_project` (bad path, no access, already added, a
 *  command the core doesn't have yet …) — already toasted by `api.ts`. */
export async function addProject(
  _store: RootStore,
  req: AddProjectRequest,
): Promise<Project | null> {
  try {
    return await api.addProject(req);
  } catch {
    return null;
  }
}

export async function removeProject(
  store: RootStore,
  id: string,
): Promise<void> {
  try {
    await api.removeProject(id);
    store.workspaces.forget(id);
  } catch {
    // toasted by api.ts
  }
}

export async function refreshProject(
  _store: RootStore,
  id: string,
): Promise<void> {
  try {
    await api.refreshProject(id);
  } catch {
    // toasted by api.ts
  }
}

/** Opens a local branch as a review with no host PR (`HostKind::Local`),
 *  same shape as `openPr`. */
export async function openBranch(
  store: RootStore,
  req: OpenBranchRequest,
): Promise<PrId | null> {
  try {
    const res = await api.openBranch(req);
    await store.sync.openPr(res.pr);
    store.ui.go({ name: 'review', pr: res.pr });
    return res.pr;
  } catch {
    return null;
  }
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

// ── host writes: merge, reviewers, draft state ──────────────────────────────

export async function mergePr(
  _store: RootStore,
  req: MergeRequest,
): Promise<boolean> {
  try {
    await api.mergePr(req);
    return true;
  } catch {
    return false; // toasted by api.ts
  }
}

export async function updateBranch(_store: RootStore, pr: PrId): Promise<void> {
  try {
    await api.updateBranch(pr);
  } catch {
    // toasted by api.ts
  }
}

export async function setReviewers(
  _store: RootStore,
  req: ReviewersRequest,
): Promise<void> {
  try {
    await api.setReviewers(req);
  } catch {
    // toasted by api.ts
  }
}

export async function setDraft(
  _store: RootStore,
  req: DraftStateRequest,
): Promise<void> {
  try {
    await api.setDraft(req);
  } catch {
    // toasted by api.ts
  }
}

export async function rerunCheck(
  store: RootStore,
  req: RerunCheckRequest,
): Promise<void> {
  try {
    await api.rerunCheck(req);
    store.ephemeral.toast('Re-running check…', 'info');
  } catch {
    // toasted by api.ts
  }
}

/** Take, decline, or reassign a review request straight from the inbox
 *  (plan "Triage") — no need to open the PR first. */
export async function triage(
  _store: RootStore,
  pr: PrId,
  action: TriageAction,
): Promise<void> {
  try {
    await api.triage({ pr, action });
  } catch {
    // toasted by api.ts
  }
}

// ── review: reactions, edit/delete, suggestion batch ────────────────────────

/** Toggles one reaction on a comment. `currentlyReacted` is the caller's
 *  already-merged view (server `Comment.reactions` plus any still-pending
 *  override) — this flips it optimistically via
 *  `EphemeralStore.reactionOverride`, sends the host call, and rolls the
 *  override back on failure. The override is dropped once a synced
 *  `Comment` agrees with it (`Comments.tsx`'s `Reactions`), not here. */
export async function reactToComment(
  store: RootStore,
  pr: PrId,
  comment: CommentId,
  emoji: string,
  currentlyReacted: boolean,
): Promise<void> {
  const on = !currentlyReacted;
  store.ephemeral.setReactionOverride(comment, emoji, on);
  try {
    await api.react({ pr, comment, emoji, on });
  } catch {
    store.ephemeral.setReactionOverride(comment, emoji, currentlyReacted); // roll back
  }
}

export async function editComment(
  _store: RootStore,
  pr: PrId,
  comment: CommentId,
  body: string,
): Promise<void> {
  try {
    await api.editComment({ pr, comment, body });
  } catch {
    // toasted by api.ts
  }
}

export async function deleteComment(
  _store: RootStore,
  pr: PrId,
  comment: CommentId,
): Promise<void> {
  try {
    await api.editComment({ pr, comment, body: null });
  } catch {
    // toasted by api.ts
  }
}

/** Applies every ```suggestion block of `comments` as one commit, pushed to
 *  the PR branch (own PRs only — the core rejects otherwise). */
export async function commitSuggestions(
  store: RootStore,
  pr: PrId,
  comments: CommentId[],
): Promise<boolean> {
  const message =
    comments.length === 1
      ? 'Apply suggested change'
      : `Apply ${comments.length} suggested changes`;
  try {
    await api.commitSuggestions({ pr, comments, message });
    store.ephemeral.clearBatch(pr, comments);
    return true;
  } catch {
    return false; // toasted by api.ts
  }
}

// ── skills: edit / save ──────────────────────────────────────────────────────

export async function getSkill(
  _store: RootStore,
  id: string,
  pr: PrId | null,
): Promise<SkillBody | null> {
  try {
    return await api.getSkill(id, pr);
  } catch {
    return null; // toasted by api.ts
  }
}

export async function saveSkill(
  _store: RootStore,
  req: SaveSkillRequest,
): Promise<boolean> {
  try {
    await api.saveSkill(req);
    return true;
  } catch {
    return false; // toasted by api.ts
  }
}

// ── folder picker ────────────────────────────────────────────────────────────

export async function pickFolder(_store: RootStore): Promise<string | null> {
  try {
    return await api.pickFolder();
  } catch {
    return null; // rejected/unknown command — caller falls back to the text field
  }
}
