import type { ComponentProps, ReactNode } from 'react';
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
  Label,
  ListBox,
  Separator,
  Surface,
  Toolbar,
  Tooltip,
  Typography,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { PrId } from '../gen/contract';
import { delegateTask, markDone, unsnooze } from '../actions';
import { FEATURES } from '../features';
import { useRootStore } from '../stores/context';
import { AgentTag, Avatar, Btn, CheckIcon } from './bits';
import { PRIcon, TaskIcon, prStatusLabel } from './StatusIcon';

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

/** Fraction of this PR's loaded (non-hidden) hunks already read — same
 *  computation `Review.tsx` keeps locally for its own header chip. */
function progressOf(store: ReturnType<typeof useRootStore>, pr: PrId): number {
  const reads = store.models.hunkReads.where((r) => r.pr === pr);
  const groups = store.models.groups.all().filter((g) => g.kind !== 'hidden');
  const hunks = groups.flatMap((g) => g.hunks);
  if (!hunks.length) return 0;
  const readSet = new Set(reads.map((r) => r.hunk));
  return hunks.filter((h) => readSet.has(h)).length / hunks.length;
}

/** Wraps a `Btn` whose backing command doesn't exist yet: disabled, with a
 *  tooltip explaining why — never deleted, per `features.ts`. */
function GatedBtn({ children, ...rest }: ComponentProps<typeof Btn>) {
  if (FEATURES.hostWrites) return <Btn {...rest}>{children}</Btn>;
  const { kbd: _kbd, ...disabledRest } = rest;
  return (
    <Tooltip>
      <Btn {...disabledRest} isDisabled>
        {children}
      </Btn>
      <Tooltip.Content>Not available yet</Tooltip.Content>
    </Tooltip>
  );
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
  if (!p) return null;
  const detail = store.models.prDetails.get(id);
  const tasks = store.models.tasks.where((t) => t.pr === id);
  const inboxState = store.models.inboxStates.get(id);
  const viewer = store.ephemeral.viewer;
  const mine = !!viewer && viewer.login === p.author.login;
  const requested =
    p.reasons.includes('review_requested') ||
    p.reasons.includes('team_review_requested');
  const reviewers = detail?.reviewers ?? [];
  const openMine = tasks.filter(
    (t) =>
      t.status === 'todo' &&
      t.assignee.kind === 'human' &&
      !!viewer &&
      t.assignee.id === viewer.login,
  );

  return (
    <Surface className="peek flex w-96 shrink-0 flex-col gap-5 overflow-auto rounded-none border-l border-separator p-6 pb-20">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs text-muted">
          <PRIcon status={p.state} progress={progressOf(store, id)} />
          {prStatusLabel[p.state]}
          <span className="flex-1" />
          <span className="font-mono">
            {p.pr.repo.name}#{p.pr.number}
          </span>
        </div>
        <Typography.Heading level={5} className="peek-title">
          {p.title}
        </Typography.Heading>
        <div className="flex items-center gap-1.5 text-xs text-muted">
          <Avatar person={p.author} size={18} /> {mine ? 'you' : p.author.login}{' '}
          · {ago(p.updated_at)} ·{' '}
          <span className="text-success">+{p.additions}</span>{' '}
          <span className="text-danger">−{p.deletions}</span>
        </div>
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
        {p.state === 'open' && (
          <GatedBtn tone="success" icon={<CodeMerge />}>
            Merge
          </GatedBtn>
        )}
        {requested && (
          <>
            <GatedBtn icon={<PersonPlus />}>Take</GatedBtn>
            <GatedBtn icon={<Persons />}>Reassign</GatedBtn>
            <GatedBtn tone="tertiary" icon={<PersonXmark />}>
              Decline
            </GatedBtn>
          </>
        )}
        {mine && p.state === 'draft' && (
          <GatedBtn icon={<Eye />}>Ready for review</GatedBtn>
        )}
        {mine && reviewers.some((r) => r.state === 'changes_requested') && (
          <GatedBtn icon={<ArrowRotateRight />}>Re-request review</GatedBtn>
        )}
        {mine && p.state !== 'merged' && (
          <GatedBtn icon={<PersonPlus />}>Reviewer</GatedBtn>
        )}
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
      </Toolbar>

      <Separator />
      <dl className="props grid grid-cols-[96px_1fr] items-center gap-x-3 gap-y-3 text-sm [&>dt]:text-muted">
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
          {p.approvals}/{p.required_approvals ?? '–'}
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
