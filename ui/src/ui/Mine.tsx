/**
 * "My PRs": pull requests authored by the signed-in host user (`viewer`),
 * grouped by what happens next — ported from the prototype's `nextStep` /
 * `mergeGates`, computed from `PrSummary` alone (no per-row `merge_info`
 * fetch): checks, approvals, `review_decision` and `conflicts` are all on
 * the summary already.
 */
import { useEffect, useState } from 'react';
import { CodePullRequest } from '@gravity-ui/icons';
import { Chip } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { PrId, PrSummary } from '../gen/contract';
import { loadViewer } from '../actions';
import { useRootStore, useUi } from '../stores/context';
import { Avatar, CheckIcon, Empty, Hints, K } from './bits';
import { RowsSkeleton } from './Loading';
import { RowList, ViewHeader, ago } from './List';
import { PRIcon, ReviewDecisionIcon } from './StatusIcon';
import { latinKey, useViewKeys } from './keys';

export type Step =
  'merge' | 'yours' | 'waiting' | 'draft' | 'merged' | 'closed';

const STEPS: { id: Step; title: string }[] = [
  { id: 'merge', title: 'Ready to merge' },
  { id: 'yours', title: 'Your move' },
  { id: 'waiting', title: 'Waiting on reviewers' },
  { id: 'draft', title: 'Drafts' },
  { id: 'merged', title: 'Merged' },
  { id: 'closed', title: 'Closed' },
];

export interface Gate {
  ok: boolean;
  label: string;
}

/** The merge gates a PR summary alone can answer, without `merge_info`. */
export function gatesFor(p: PrSummary): Gate[] {
  const gates: Gate[] = [
    {
      ok: p.checks !== 'fail',
      label:
        p.checks === 'fail'
          ? 'checks failing'
          : p.checks === 'pending'
            ? 'checks running'
            : 'checks passing',
    },
  ];
  if (p.required_approvals != null) {
    gates.push({
      ok: p.approvals >= p.required_approvals,
      label: `${p.approvals}/${p.required_approvals} approvals`,
    });
  }
  if (p.review_decision === 'changes_requested') {
    gates.push({ ok: false, label: 'changes requested' });
  }
  if (p.conflicts) {
    gates.push({ ok: false, label: 'conflicts with base' });
  }
  return gates;
}

export function nextStep(p: PrSummary): Step {
  if (p.state === 'merged') return 'merged';
  if (p.state === 'closed') return 'closed';
  if (p.state === 'draft') return 'draft';
  const blocked = gatesFor(p).some((g) => !g.ok);
  if (!blocked) return 'merge';
  const yours =
    p.checks === 'fail' ||
    p.conflicts ||
    p.review_decision === 'changes_requested';
  return yours ? 'yours' : 'waiting';
}

function MineRow({ id, sel }: { id: PrId; sel: boolean }) {
  const store = useRootStore();
  const p = store.models.prSummaries.get(id);
  if (!p) return null;
  const gates = gatesFor(p);
  const blockers = gates.filter((g) => !g.ok);
  return (
    <div
      id={`R-${id}`}
      className={`minerow grid h-12 w-full grid-cols-[16px_16px_72px_minmax(200px,1fr)_minmax(0,1.4fr)_22px_16px_40px] items-center gap-3 ${
        sel ? 'sel' : ''
      }`}
    >
      <PRIcon status={p.state} />
      <span className="flex items-center justify-center">
        {p.state === 'open' && p.review_decision && (
          <ReviewDecisionIcon decision={p.review_decision} />
        )}
      </span>
      <span
        className="truncate font-mono text-xs text-muted"
        title={`${p.pr.repo.owner}/${p.pr.repo.name}#${p.pr.number}`}
      >
        {p.pr.repo.name}#{p.pr.number}
      </span>
      <span className="min-w-0 truncate font-medium" title={p.title}>
        {p.title}
      </span>
      <span className="flex min-w-0 gap-1 overflow-hidden">
        {p.state === 'merged' ? (
          <span className="text-xs text-muted">merged</span>
        ) : blockers.length ? (
          blockers.map((b) => (
            <Chip
              key={b.label}
              size="sm"
              variant="soft"
              color="warning"
              className="blocker min-w-0 shrink truncate whitespace-nowrap"
            >
              {b.label}
            </Chip>
          ))
        ) : (
          <Chip size="sm" variant="soft" color="success">
            ready to merge
          </Chip>
        )}
      </span>
      <Avatar person={p.author} size={18} />
      <CheckIcon s={p.checks} />
      <span className="text-right text-xs text-muted">{ago(p.updated_at)}</span>
    </div>
  );
}

function useMineKeys(order: string[]) {
  const ui = useUi();
  useViewKeys(
    ui,
    (e) => {
      const i = ui.selected ? order.indexOf(ui.selected) : -1;
      const move = (d: number) => {
        const next = order[Math.max(0, Math.min(order.length - 1, i + d))];
        if (next) ui.select(next);
      };
      switch (latinKey(e)) {
        case 'j':
        case 'ArrowDown':
          move(1);
          break;
        case 'k':
        case 'ArrowUp':
          move(-1);
          break;
        case 'Enter':
          if (ui.selected) ui.go({ name: 'review', pr: ui.selected });
          break;
        default:
          return false;
      }
    },
    [order.join()],
  );

  useEffect(() => {
    if (order.length && (!ui.selected || !order.includes(ui.selected)))
      ui.select(order[0]!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.join()]);
}

export const Mine = observer(function Mine() {
  const store = useRootStore();
  const ui = useUi();
  const [closed, setClosed] = useState<Record<string, boolean>>({
    merged: true,
    closed: true,
  });

  useEffect(() => {
    void loadViewer(store);
  }, [store]);

  const viewer = store.ephemeral.viewer;
  const mine = viewer
    ? store.models.prSummaries
        .all()
        .filter((p) => p.author.login === viewer.login)
    : [];
  const groups = STEPS.map((s) => ({
    ...s,
    items: mine.filter((p) => nextStep(p) === s.id),
  })).filter((g) => g.items.length);
  const order = groups.flatMap((g) =>
    closed[g.id] ? [] : g.items.map((p) => p.id),
  );
  useMineKeys(order);

  return (
    <div className="view relative flex min-w-0 flex-1 flex-col">
      <ViewHeader
        title="My PRs"
        count={mine.filter((p) => p.state !== 'merged').length}
      />
      <div className="flex min-h-0 flex-1">
        <RowList
          groups={groups}
          sel={ui.selected}
          closed={closed}
          toggle={(id) => setClosed((c) => ({ ...c, [id]: !c[id] }))}
          onSelect={(id) => ui.select(id)}
          onOpen={(id) => ui.go({ name: 'review', pr: id })}
          row={(id) => <MineRow id={id} sel={ui.selected === id} />}
          empty={
            !viewer && store.ephemeral.viewerLoading ? (
              <RowsSkeleton rows={6} />
            ) : (
              <Empty
                icon={<CodePullRequest />}
                title={viewer ? 'No PRs of yours' : 'Not signed in'}
                text={
                  viewer
                    ? 'When you open a PR you authored, it shows up here with a checklist to merge.'
                    : 'Connect GitHub in Settings → Account to see your PRs.'
                }
              />
            )
          }
        />
      </div>
      <Hints>
        <K>J</K>
        <K>K</K> navigate <K>⏎</K> open <K>⌘K</K> everything
      </Hints>
    </div>
  );
});
