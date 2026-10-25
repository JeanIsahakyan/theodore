import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import {
  Archive,
  ArrowRotateRight,
  ArrowUpRightFromSquare,
  Clock,
  CodeMerge,
  Eye,
  PersonPlus,
  PersonXmark,
  Persons,
  Sparkles,
} from '@gravity-ui/icons';
import {
  Chip,
  Dropdown,
  Label,
  ListBox,
  Separator,
  Surface,
  Toolbar,
  Typography,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type {
  Person,
  PrId,
  PrSummary,
  RepoRef,
  StackInfo,
} from '../gen/contract';
import {
  delegateTask,
  markDone,
  setDraft,
  setReviewers,
  triage,
  unsnooze,
} from '../actions';
import { api } from '../core/api';
import { FEATURES } from '../features';
import { useRootStore, useUi } from '../stores/context';
import { AgentTag, Avatar, Btn, CheckIcon } from './bits';
import { ReviewerPicker } from './Checks';
import { LinearChips } from './linear/LinearChips';
import { prIdFor } from './List';
import { MergeDialog } from './Merge';
import { gatesFor as mergeGatesFor } from './prs/mine';
import { isBranchReview } from './project/sections';
import { readProgress } from './review/progress';
import {
  PrStatusIcon,
  TaskIcon,
  prProblems,
  prStatusLabel,
} from './StatusIcon';

const Sec = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="flex flex-col gap-2">
    <Label className="text-xs font-medium text-muted">{title}</Label>
    {children}
  </section>
);

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** "stacked on #n" / "n stacked" chips (plan "Stack"): same relation List's
 *  row chip shows, spelled out in full since Peek has the room for it. */
function StackChips({ repo, stack }: { repo: RepoRef; stack: StackInfo }) {
  const ui = useUi();
  const open = (number: number) =>
    ui.go({ name: 'review', pr: prIdFor(repo, number) });
  if (stack.base_pr == null && stack.children.length === 0) return null;
  return (
    <div className="stack-chips flex flex-wrap items-center gap-1.5 text-xs">
      {stack.base_pr != null && (
        <Btn
          tone="ghost"
          className="stack-chip h-6 rounded-full px-2 text-xs"
          onPress={() => open(stack.base_pr!)}
        >
          stacked on #{stack.base_pr}
        </Btn>
      )}
      {stack.children.length === 1 && (
        <Btn
          tone="ghost"
          className="stack-chip h-6 rounded-full px-2 text-xs"
          onPress={() => open(stack.children[0]!)}
        >
          #{stack.children[0]} is stacked on this
        </Btn>
      )}
      {stack.children.length > 1 && (
        <Dropdown>
          <Btn
            tone="ghost"
            className="stack-chip h-6 rounded-full px-2 text-xs"
          >
            {stack.children.length} stacked on this
          </Btn>
          <Dropdown.Popover placement="bottom start">
            <Dropdown.Menu
              aria-label="Stacked PRs"
              onAction={(k) => open(Number(k))}
            >
              {stack.children.map((n) => (
                <Dropdown.Item key={n} id={String(n)} textValue={`#${n}`}>
                  #{n}
                </Dropdown.Item>
              ))}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      )}
    </div>
  );
}

/** "Reassign" (plan "Triage"): hands the review to someone else, from the
 *  same `assignable_users` pool the full reviewer picker uses. */
function ReassignMenu({ pr }: { pr: PrId }) {
  const store = useRootStore();
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<Person[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || users) return;
    let live = true;
    void api
      .assignableUsers(pr)
      .then((u) => live && setUsers(u))
      .catch(() => live && setUsers([]));
    return () => {
      live = false;
    };
  }, [open, pr, users]);

  return (
    <Dropdown isOpen={open} onOpenChange={setOpen}>
      <Btn
        tone="tertiary"
        icon={<Persons />}
        isPending={busy}
        className="reassign"
      >
        Reassign
      </Btn>
      <Dropdown.Popover placement="bottom end">
        {users === null ? (
          <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted">
            Loading…
          </div>
        ) : (
          <Dropdown.Menu
            aria-label="Reassign to"
            onAction={(login) => {
              setBusy(true);
              void triage(store, pr, {
                action: 'reassign',
                to: [String(login)],
              }).finally(() => setBusy(false));
            }}
          >
            {users.map((u) => (
              <Dropdown.Item key={u.login} id={u.login} textValue={u.login}>
                {u.login}
              </Dropdown.Item>
            ))}
          </Dropdown.Menu>
        )}
      </Dropdown.Popover>
    </Dropdown>
  );
}

export type PeekHostAction = 'merge' | 'reviewers';

/** Peek's host actions, the same on every page: Merge only when the PR is
 *  open and the gates a summary can answer (checks, approvals, changes
 *  requested, conflicts) all pass; Reviewers on any unfinished host PR. A
 *  local or branch review has no host PR, so it gets neither. */
export function peekHostActions(
  p: PrSummary,
  hostWrites: boolean,
): PeekHostAction[] {
  const hostPr = p.pr.repo.host !== 'local' && !isBranchReview(p);
  const actions: PeekHostAction[] = [];
  if (hostPr && p.state === 'open' && !mergeGatesFor(p).some((g) => !g.ok)) {
    actions.push('merge');
  }
  if (hostPr && hostWrites && (p.state === 'open' || p.state === 'draft')) {
    actions.push('reviewers');
  }
  return actions;
}

/** Side panel that previews a PR without fully opening it — toggled by
 *  `ui.peek` / Space, shown next to `Inbox`'s list. Ported from the
 *  prototype's `Peek`: sections that had no backing data at all (Linear,
 *  stack, precomputed pre-review groups/risks, merge gates, activity feed)
 *  are dropped rather than faked; see the file's final report. */
export const Peek = observer(function Peek({ id }: { id: PrId }) {
  const store = useRootStore();
  const ui = store.ui;
  const p = store.models.prSummaries.get(id);
  const [busy, setBusy] = useState<
    'ready' | 'rerequest' | 'take' | 'decline' | null
  >(null);
  const [merging, setMerging] = useState(false);
  if (!p) return null;
  const detail = store.models.prDetails.get(id);
  const tasks = store.models.tasks.byPr(id);
  const inboxState = store.models.inboxStates.get(id);
  const viewer = store.ephemeral.viewer;
  const mine = !!viewer && viewer.login === p.author.login;
  // No PR on the host behind it: a local folder's or a branch review.
  const local = p.pr.repo.host === 'local' || isBranchReview(p);
  const host = peekHostActions(p, FEATURES.hostWrites);
  const requested =
    p.reasons.includes('review_requested') ||
    p.reasons.includes('team_review_requested');
  const reviewers = detail?.reviewers ?? [];
  const changesRequestedBy = reviewers
    .filter((r) => r.state === 'changes_requested' && !r.team)
    .map((r) => r.person.login);
  const openMine = tasks.filter(
    (t) =>
      t.status === 'todo' &&
      t.assignee.kind === 'human' &&
      !!viewer &&
      t.assignee.id === viewer.login,
  );

  return (
    <Surface className="peek flex w-[clamp(280px,32vw,384px)] shrink-0 flex-col gap-5 overflow-auto rounded-none border-l border-separator p-6 pb-20">
      <header className="flex flex-col gap-2">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted">
          <PrStatusIcon summary={p} progress={readProgress(store, id)} />
          {prProblems(p).length ? (
            <span className="min-w-0 truncate text-danger">
              {prProblems(p).join(' · ')}
            </span>
          ) : (
            <span className="shrink-0">
              {prStatusLabel[p.state]}
              {p.state === 'open' && p.review_decision === 'approved' && (
                <> · approved</>
              )}
            </span>
          )}
          <span className="flex-1" />
          <span
            className="min-w-0 truncate font-mono"
            title={`${p.pr.repo.name}#${p.pr.number}`}
          >
            {p.pr.repo.name}#{p.pr.number}
          </span>
        </div>
        <Typography.Heading level={5} className="peek-title">
          {p.title}
        </Typography.Heading>
        {FEATURES.linear && (
          <div className="flex flex-wrap items-center gap-1.5">
            <LinearChips pr={id} />
          </div>
        )}
        <div className="flex items-center gap-1.5 text-xs text-muted">
          <Avatar person={p.author} size={18} /> {mine ? 'you' : p.author.login}{' '}
          · {ago(p.updated_at)} ·{' '}
          <span className="text-success">+{p.additions}</span>{' '}
          <span className="text-danger">−{p.deletions}</span>
        </div>
        {p.stack && <StackChips repo={p.pr.repo} stack={p.stack} />}
      </header>

      <Toolbar
        aria-label="Actions"
        className="peek-actions flex flex-wrap items-center gap-2"
      >
        <Btn
          tone="primary"
          kbd="⏎"
          icon={<ArrowUpRightFromSquare />}
          onPress={() => ui.go({ name: 'review', pr: id })}
        >
          Open
        </Btn>
        {host.includes('merge') && (
          <Btn
            tone="primary"
            icon={<CodeMerge />}
            onPress={() => setMerging(true)}
          >
            Merge
          </Btn>
        )}
        {requested && (
          <>
            <Btn
              icon={<PersonPlus />}
              isPending={busy === 'take'}
              onPress={() => {
                setBusy('take');
                void triage(store, id, { action: 'take' }).finally(() =>
                  setBusy(null),
                );
              }}
            >
              Take
            </Btn>
            <ReassignMenu pr={id} />
            <Btn
              tone="tertiary"
              icon={<PersonXmark />}
              isPending={busy === 'decline'}
              onPress={() => {
                setBusy('decline');
                void triage(store, id, { action: 'decline' }).finally(() =>
                  setBusy(null),
                );
              }}
            >
              Decline
            </Btn>
          </>
        )}
        {!local && mine && p.state === 'draft' && (
          <Btn
            icon={<Eye />}
            isPending={busy === 'ready'}
            onPress={() => {
              setBusy('ready');
              void setDraft(store, { pr: id, draft: false }).finally(() =>
                setBusy(null),
              );
            }}
          >
            Ready for review
          </Btn>
        )}
        {!local && mine && changesRequestedBy.length > 0 && (
          <Btn
            icon={<ArrowRotateRight />}
            isPending={busy === 'rerequest'}
            onPress={() => {
              setBusy('rerequest');
              void setReviewers(store, {
                pr: id,
                add: changesRequestedBy,
                add_teams: [],
                remove: [],
              }).finally(() => setBusy(null));
            }}
          >
            Re-request review
          </Btn>
        )}
        {host.includes('reviewers') && <ReviewerPicker pr={id} />}
        {mine && openMine.length > 0 && (
          <Btn
            icon={<Sparkles />}
            onPress={() =>
              openMine.forEach((t) => void delegateTask(store, t.id, 'codex'))
            }
          >
            Tasks ({openMine.length}) → codex
          </Btn>
        )}
        {inboxState?.snooze ? (
          <Btn
            tone="tertiary"
            icon={<Clock />}
            onPress={() => unsnooze(store, id)}
          >
            Snoozed · wake up
          </Btn>
        ) : (
          <Btn
            tone="tertiary"
            kbd="H"
            icon={<Clock />}
            onPress={() => ui.openModal('snooze', [id])}
          >
            Snooze
          </Btn>
        )}
        {!inboxState?.done && (
          <Btn
            tone="tertiary"
            kbd="E"
            icon={<Archive />}
            onPress={() => markDone(store, [id])}
          >
            Done
          </Btn>
        )}
        {merging && <MergeDialog pr={id} onClose={() => setMerging(false)} />}
      </Toolbar>

      <Separator />
      <dl className="props grid grid-cols-[96px_1fr] items-center gap-x-3 gap-y-3 text-sm [&>dt]:text-muted">
        <dt>Opened</dt>
        <dd>{ago(p.created_at ?? p.updated_at)} ago</dd>
        <dt>Checks</dt>
        <dd className="flex items-center gap-1.5">
          <CheckIcon s={p.checks} />
          {p.checks === 'fail'
            ? 'failed'
            : p.checks === 'pending'
              ? 'running'
              : p.checks === 'pass'
                ? 'green'
                : '—'}
        </dd>
        <dt>Approvals</dt>
        <dd>
          {p.required_approvals != null
            ? `${p.approvals}/${p.required_approvals}`
            : p.approvals}
        </dd>
        {reviewers.length > 0 && (
          <>
            <dt>Reviewers</dt>
            <dd className="flex flex-wrap gap-1.5">
              {reviewers.map((r) => (
                <Chip
                  key={r.team ?? r.person.login}
                  size="sm"
                  variant="secondary"
                  className="gap-1"
                >
                  {r.team ? null : <Avatar person={r.person} size={16} />}
                  {r.team
                    ? `team:${r.team}`
                    : viewer && r.person.login === viewer.login
                      ? 'you'
                      : r.person.login}
                  <span
                    className={
                      r.state === 'approved'
                        ? 'text-success'
                        : r.state === 'changes_requested'
                          ? 'text-danger'
                          : 'text-muted'
                    }
                  >
                    {r.state === 'approved'
                      ? '✓'
                      : r.state === 'changes_requested'
                        ? '✗'
                        : r.state === 'requested'
                          ? '· pending'
                          : ''}
                  </span>
                </Chip>
              ))}
            </dd>
          </>
        )}
      </dl>

      {tasks.length > 0 && (
        <>
          <Separator />
          <Sec
            title={`Tasks ${tasks.filter((t) => t.status === 'done').length}/${tasks.length}`}
          >
            <ListBox aria-label="PR tasks" selectionMode="none" className="p-0">
              {tasks.map((t) => (
                <ListBox.Item
                  key={t.id}
                  id={t.id}
                  textValue={t.title}
                  className="min-h-0 gap-2 px-0 py-1"
                >
                  <TaskIcon status={t.status} />
                  <span className="flex-1">{t.title}</span>
                  {t.assignee.kind === 'agent' ? (
                    <AgentTag id={t.assignee.id} />
                  ) : (
                    <span className="text-xs text-muted">{t.assignee.id}</span>
                  )}
                </ListBox.Item>
              ))}
            </ListBox>
          </Sec>
        </>
      )}
    </Surface>
  );
});
