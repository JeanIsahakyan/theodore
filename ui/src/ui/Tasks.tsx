import { useEffect } from 'react';
import { Disclosure, Header, ListBox } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { Key } from 'react';
import { ArrowUturnCcwLeft, Check, ListCheck } from '@gravity-ui/icons';
import type { Task, TaskStatus } from '../gen/contract';
import { setTaskStatus } from '../actions';
import { useRootStore, useUi } from '../stores/context';
import { AgentTag, Btn, Empty, Hints, K, Spinner } from './bits';
import { PatchView } from './Patch';
import { ViewHeader } from './List';
import { useViewKeys } from './keys';
import { TaskIcon } from './StatusIcon';

const ORDER: TaskStatus[] = ['review', 'todo', 'progress', 'done'];
const TITLE: Record<TaskStatus, string> = {
  review: 'To verify',
  todo: 'Todo',
  progress: 'In progress',
  done: 'Done',
};

export const TaskRow = observer(function TaskRow({
  t,
  sel,
  compact,
}: {
  t: Task;
  sel?: boolean;
  compact?: boolean;
}) {
  const store = useRootStore();
  const ui = useUi();
  const pr = store.models.prSummaries.get(t.pr);
  return (
    <div
      id={`T-${t.id}`}
      className={`taskrow group flex min-h-12 w-full items-center gap-2.5 py-1.5 ${compact ? 'flex-wrap' : ''} ${sel ? 'sel' : ''}`}
    >
      <TaskIcon status={t.status} />
      <div className="min-w-0 flex-1">
        <div
          className={`font-medium ${t.status === 'done' ? 'text-muted' : ''}`}
        >
          {t.title}
        </div>
        {!compact && pr && (
          <div className="mt-0.5 flex items-center gap-2.5 text-xs text-muted">
            <span
              className="inline-flex cursor-pointer items-center gap-1 font-mono hover:text-accent"
              onClick={(e) => {
                e.stopPropagation();
                ui.go({ name: 'review', pr: t.pr });
              }}
            >
              #{pr.pr.number} {pr.title}
            </span>
          </div>
        )}
        {t.fix?.patch && t.status === 'review' && (
          <Disclosure
            className="task-patch mt-1.5"
            onClick={(e) => e.stopPropagation()}
          >
            <Disclosure.Heading>
              <Disclosure.Trigger className="flex items-center gap-1.5 text-xs text-accent">
                View fix
                <Disclosure.Indicator />
              </Disclosure.Trigger>
            </Disclosure.Heading>
            <Disclosure.Content>
              <Disclosure.Body className="max-w-[720px] pb-1 pt-2">
                <PatchView patch={t.fix.patch} />
              </Disclosure.Body>
            </Disclosure.Content>
          </Disclosure>
        )}
      </div>
      <span
        className={`task-act flex gap-1 ${t.status === 'review' || sel ? '' : 'opacity-0 group-hover:opacity-100'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {t.status === 'review' && (
          <>
            <Btn
              tone="success"
              kbd="Y"
              icon={<Check />}
              onPress={() => setTaskStatus(store, t.id, 'done')}
            >
              Accept
            </Btn>
            <Btn
              tone="tertiary"
              icon={<ArrowUturnCcwLeft />}
              onPress={() => setTaskStatus(store, t.id, 'todo')}
            >
              Send back
            </Btn>
          </>
        )}
      </span>
      <span className="flex min-w-[50px] items-center justify-end gap-1.5">
        {t.status === 'progress' && <Spinner />}
        {t.assignee.kind === 'agent' ? (
          <AgentTag id={t.assignee.id} />
        ) : (
          <span className="text-xs text-muted">{t.assignee.id}</span>
        )}
      </span>
    </div>
  );
});

function useTaskKeys(order: string[]) {
  const store = useRootStore();
  const ui = useUi();
  useViewKeys(
    ui,
    (e) => {
      const i = ui.selected ? order.indexOf(ui.selected) : -1;
      const t = store.models.tasks.get(ui.selected ?? '');
      const move = (d: number) => {
        const next = order[Math.max(0, Math.min(order.length - 1, i + d))];
        if (next) ui.select(next);
      };
      if (e.key === 'j' || e.key === 'ArrowDown') move(1);
      else if (e.key === 'k' || e.key === 'ArrowUp') move(-1);
      else if (e.key === 'Enter' && t) ui.go({ name: 'review', pr: t.pr });
      else if (e.key === 'y' && t?.status === 'review')
        setTaskStatus(store, t.id, 'done');
      else return false;
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
        .getElementById(`T-${ui.selected}`)
        ?.scrollIntoView({ block: 'nearest' });
  }, [ui.selected]);
}

export const Tasks = observer(function Tasks() {
  const store = useRootStore();
  const ui = useUi();
  const items = store.models.tasks.all();
  const order = ORDER.flatMap((st) =>
    items.filter((t) => t.status === st).map((t) => t.id),
  );
  useTaskKeys(order);
  return (
    <div className="view flex min-w-0 flex-1 flex-col">
      <ViewHeader title="Tasks" count={items.length} />
      <ListBox
        aria-label="Tasks"
        selectionMode="single"
        selectedKeys={ui.selected ? [ui.selected] : []}
        onSelectionChange={(keys) => {
          const k = keys === 'all' ? null : [...keys][0];
          if (k !== undefined && k !== null) ui.select(String(k));
        }}
        onAction={(k: Key) => {
          const t = store.models.tasks.get(String(k));
          if (t) ui.go({ name: 'review', pr: t.pr });
        }}
        className="min-w-0 flex-1 overflow-auto p-0 pb-20"
        renderEmptyState={() => (
          <Empty
            icon={<ListCheck />}
            title="No tasks"
            text="Tasks come from skill findings, threads, and your review comments."
          />
        )}
      >
        {ORDER.filter((st) => items.some((t) => t.status === st)).map((st) => (
          <ListBox.Section key={st} id={st}>
            <Header className="flex h-10 items-center gap-2 border-b border-separator bg-surface/95 pl-[18px] pr-6 text-sm backdrop-blur">
              <TaskIcon status={st} />
              <span className="font-medium">{TITLE[st]}</span>
              <span className="tabular-nums text-muted">
                {items.filter((t) => t.status === st).length}
              </span>
            </Header>
            {items
              .filter((t) => t.status === st)
              .map((t) => (
                <ListBox.Item
                  key={t.id}
                  id={t.id}
                  textValue={t.title}
                  className="min-h-0 rounded-none border-b border-separator px-6 py-0"
                >
                  <TaskRow t={t} sel={ui.selected === t.id} />
                </ListBox.Item>
              ))}
          </ListBox.Section>
        ))}
      </ListBox>
      <Hints>
        <K>J</K>
        <K>K</K> navigate <K>⏎</K> open PR <K>Y</K> accept fix <K>⌘K</K>{' '}
        everything
      </Hints>
    </div>
  );
});
