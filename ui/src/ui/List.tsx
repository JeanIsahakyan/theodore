import { useEffect, useState } from 'react';
import { Archive, Clock, CodePullRequest, Plus } from '@gravity-ui/icons';
import {
  Button,
  Card,
  Checkbox,
  Header,
  InputGroup,
  ListBox,
  TextField,
  Toolbar,
  Typography,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { Key, ReactNode } from 'react';
import type { InboxReason, PrId } from '../gen/contract';
import { markDone, openPr } from '../actions';
import { useRootStore, useUi } from '../stores/context';
import { Avatar, Btn, CheckIcon, Empty, Hints, K } from './bits';
import { PRIcon } from './StatusIcon';
import { useViewKeys } from './keys';

const REASON_LABEL: Record<InboxReason, string> = {
  review_requested: 'review requested',
  team_review_requested: 'team review requested',
  assigned: 'assigned',
  authored: 'authored',
  mentioned: 'mentioned',
  updated_after_review: 'updated after your review',
};

const SECTIONS: { id: string; title: string; reasons: InboxReason[] }[] = [
  {
    id: 'review',
    title: 'Needs your review',
    reasons: ['review_requested', 'team_review_requested'],
  },
  { id: 'assigned', title: 'Assigned to you', reasons: ['assigned'] },
  { id: 'mentioned', title: 'Mentions', reasons: ['mentioned'] },
  {
    id: 'updated',
    title: 'Updated since your review',
    reasons: ['updated_after_review'],
  },
  { id: 'authored', title: 'Authored by you', reasons: ['authored'] },
];

export function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function OpenPrField() {
  const store = useRootStore();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = () => {
    const u = url.trim();
    if (!u) return;
    setBusy(true);
    void openPr(store, u).finally(() => {
      setBusy(false);
      setUrl('');
    });
  };
  return (
    <TextField
      aria-label="Open a PR"
      value={url}
      onChange={setUrl}
      className="w-72"
    >
      <InputGroup fullWidth>
        <InputGroup.Input
          placeholder="Open a PR by URL…"
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <InputGroup.Suffix>
          <Button
            isIconOnly
            size="sm"
            aria-label="Open"
            isPending={busy}
            onPress={submit}
          >
            <Plus className="size-4" />
          </Button>
        </InputGroup.Suffix>
      </InputGroup>
    </TextField>
  );
}

export function ViewHeader({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children?: ReactNode;
}) {
  return (
    <Toolbar
      aria-label={title}
      className="view-h flex h-14 w-full shrink-0 items-center gap-3 border-b border-separator px-6"
    >
      <Typography.Heading level={6}>{title}</Typography.Heading>
      {count !== undefined && <span className="text-muted">{count}</span>}
      <span className="flex-1" />
      {children}
    </Toolbar>
  );
}

const rowCls = (sel: boolean, picked: boolean) =>
  `${sel ? 'sel' : ''} ${picked ? 'picked bg-accent-soft' : ''}`;

const PrRow = observer(function PrRow({
  id,
  sel,
  picked,
}: {
  id: PrId;
  sel: boolean;
  picked: boolean;
}) {
  const store = useRootStore();
  const ui = useUi();
  const p = store.models.prSummaries.get(id);
  if (!p) return null;
  return (
    <div
      id={`R-${id}`}
      className={`prrow group grid h-11 w-full items-center gap-3 ${rowCls(sel, picked)}`}
      style={{
        gridTemplateColumns:
          '16px 16px 72px minmax(200px,1.5fr) 150px minmax(0,1fr) 16px 20px 36px',
      }}
    >
      <Checkbox
        aria-label="select"
        isSelected={picked}
        onChange={() => ui.togglePick(id)}
        className={`pickbox ${picked ? '' : 'opacity-0 group-hover:opacity-100'}`}
      >
        <Checkbox.Content>
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
        </Checkbox.Content>
      </Checkbox>
      <PRIcon status={p.state} />
      <span className="text-xs tabular-nums text-muted">
        {p.pr.repo.name} #{p.pr.number}
      </span>
      <span className="truncate font-medium">{p.title}</span>
      <span className="flex gap-1 overflow-hidden">
        {p.reasons.slice(0, 2).map((r) => (
          <span
            key={r}
            className="chip rounded-full bg-default px-2 py-0.5 text-xs"
          >
            {REASON_LABEL[r]}
          </span>
        ))}
      </span>
      <span className="truncate text-xs text-muted">
        {p.approvals}/{p.required_approvals ?? '–'} approvals
      </span>
      <CheckIcon s={p.checks} />
      <Avatar person={p.author} size={22} />
      <span className="text-right text-xs text-muted">{ago(p.updated_at)}</span>
    </div>
  );
});

function BulkBar({
  n,
  onDone,
  onSnooze,
}: {
  n: number;
  onDone: () => void;
  onSnooze: () => void;
}) {
  return (
    <Card className="bulk absolute bottom-16 left-1/2 z-10 -translate-x-1/2 px-4 py-2.5 shadow-overlay">
      <Toolbar aria-label="Bulk actions" className="flex items-center gap-1.5">
        <span className="me-2 ps-1 font-medium tabular-nums">{n} selected</span>
        <Btn tone="tertiary" kbd="E" icon={<Archive />} onPress={onDone}>
          Done
        </Btn>
        <Btn tone="tertiary" kbd="H" icon={<Clock />} onPress={onSnooze}>
          Snooze
        </Btn>
      </Toolbar>
    </Card>
  );
}

/** Linear-style single-key verbs for the list. */
function useListKeys(order: PrId[]) {
  const store = useRootStore();
  const ui = useUi();
  useViewKeys(
    ui,
    (e) => {
      const i = ui.selected ? order.indexOf(ui.selected) : -1;
      const move = (d: number) => {
        const next = order[Math.max(0, Math.min(order.length - 1, i + d))];
        if (next) ui.select(next);
      };
      const targets = () =>
        ui.picked.length ? ui.picked : ui.selected ? [ui.selected] : [];
      switch (e.key) {
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
        case ' ':
          ui.togglePeek();
          break;
        case 'x':
          if (ui.selected) ui.togglePick(ui.selected);
          break;
        case 'e':
          markDone(store, targets());
          ui.clearPicked();
          break;
        case 'h':
          ui.openModal('snooze', targets());
          break;
        case 'Escape':
          if (!ui.picked.length) return false;
          ui.clearPicked();
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

  useEffect(() => {
    if (ui.selected)
      document
        .getElementById(`R-${ui.selected}`)
        ?.scrollIntoView({ block: 'nearest' });
  }, [ui.selected]);
}

export const Inbox = observer(function Inbox() {
  const store = useRootStore();
  const ui = useUi();
  const prs = store.models.prSummaries.all();
  const inboxStates = store.models.inboxStates.all();
  const stateOf = (id: PrId) => inboxStates.find((s) => s.pr === id);
  const active = prs.filter((p) => {
    const s = stateOf(p.id);
    return !s?.done && !s?.snooze;
  });
  const snoozed = prs.filter((p) => stateOf(p.id)?.snooze);
  const [showDone, setShowDone] = useState(false);
  const done = prs.filter((p) => stateOf(p.id)?.done);

  const groups = [
    ...SECTIONS.map((sec) => ({
      ...sec,
      items: active.filter((p) =>
        p.reasons.some((r) => sec.reasons.includes(r)),
      ),
    })).filter((g) => g.items.length),
    { id: 'snoozed', title: 'Snoozed', reasons: [], items: snoozed },
    ...(showDone
      ? [{ id: 'done', title: 'Done', reasons: [], items: done }]
      : []),
  ].filter((g) => g.items.length || g.id === 'snoozed');

  const order = groups.flatMap((g) => g.items.map((p) => p.id));
  useListKeys(order);

  return (
    <div className="view relative flex min-w-0 flex-1 flex-col">
      <ViewHeader title="Inbox" count={active.length}>
        <OpenPrField />
      </ViewHeader>
      <div className="flex min-h-0 flex-1">
        <ListBox
          aria-label="Pull requests"
          selectionMode="single"
          selectionBehavior="replace"
          disallowEmptySelection
          selectedKeys={ui.selected ? [ui.selected] : []}
          onSelectionChange={(keys) => {
            const k = keys === 'all' ? null : [...keys][0];
            if (k !== undefined && k !== null) ui.select(String(k));
          }}
          onAction={(k: Key) => ui.go({ name: 'review', pr: String(k) })}
          className="list min-w-0 flex-1 overflow-auto p-0 pb-20"
          renderEmptyState={() => (
            <Empty
              icon={<CodePullRequest />}
              title="Inbox is empty"
              text="Open a PR by URL above, or wait for a review request to show up here."
            />
          )}
        >
          {groups.map((g) => (
            <ListBox.Section key={g.id} id={g.id}>
              <Header className="ghead sticky top-0 z-[1] flex h-10 items-center gap-2 border-b border-separator bg-surface/95 pl-[18px] pr-6 text-sm backdrop-blur">
                <span className="font-medium">{g.title}</span>
                <span className="tabular-nums text-muted">
                  {g.items.length}
                </span>
                {g.id === 'done' && (
                  <Checkbox
                    isSelected={showDone}
                    onChange={() => setShowDone((v) => !v)}
                    className="ms-auto"
                  >
                    <Checkbox.Content>
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                      Show done
                    </Checkbox.Content>
                  </Checkbox>
                )}
              </Header>
              {g.items.map((p) => (
                <ListBox.Item
                  key={p.id}
                  id={p.id}
                  textValue={p.title}
                  className="min-h-0 rounded-none border-b border-separator px-6 py-0"
                >
                  <PrRow
                    id={p.id}
                    sel={ui.selected === p.id}
                    picked={ui.picked.includes(p.id)}
                  />
                </ListBox.Item>
              ))}
            </ListBox.Section>
          ))}
        </ListBox>
      </div>
      <Hints>
        <K>J</K>
        <K>K</K> navigate <K>⏎</K> open <K>X</K> select <K>E</K> done <K>H</K>{' '}
        snooze <K>⌘K</K> everything <K>⌘Z</K> undo
      </Hints>
      {ui.picked.length > 0 && (
        <BulkBar
          n={ui.picked.length}
          onDone={() => {
            markDone(store, ui.picked);
            ui.clearPicked();
          }}
          onSnooze={() => ui.openModal('snooze', ui.picked)}
        />
      )}
    </div>
  );
});
