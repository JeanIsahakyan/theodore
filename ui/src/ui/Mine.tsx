/** "My PRs": pull requests authored by the signed-in host user (`viewer`). */
import { useEffect } from 'react';
import { CodePullRequest } from '@gravity-ui/icons';
import { Header, ListBox } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { Key } from 'react';
import type { PrState } from '../gen/contract';
import { loadViewer } from '../actions';
import { useRootStore, useUi } from '../stores/context';
import { Empty, Hints, K } from './bits';
import { PrRow, ViewHeader } from './List';
import { useViewKeys } from './keys';

const SECTIONS: { id: PrState; title: string }[] = [
  { id: 'draft', title: 'Drafts' },
  { id: 'open', title: 'Open' },
  { id: 'merged', title: 'Merged' },
  { id: 'closed', title: 'Closed' },
];

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

  useEffect(() => {
    void loadViewer(store);
  }, [store]);

  const viewer = store.ephemeral.viewer;
  const mine = viewer
    ? store.models.prSummaries
        .all()
        .filter((p) => p.author.login === viewer.login)
    : [];
  const groups = SECTIONS.map((s) => ({
    ...s,
    items: mine.filter((p) => p.state === s.id),
  })).filter((g) => g.items.length);
  const order = groups.flatMap((g) => g.items.map((p) => p.id));
  useMineKeys(order);

  return (
    <div className="view relative flex min-w-0 flex-1 flex-col">
      <ViewHeader title="My PRs" count={mine.length} />
      <div className="flex min-h-0 flex-1">
        <ListBox
          aria-label="My pull requests"
          selectionMode="single"
          selectionBehavior="replace"
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
              title={viewer ? 'No PRs of yours' : 'Not signed in'}
              text={
                viewer
                  ? 'When you open a PR you authored, it shows up here.'
                  : 'Connect GitHub in Settings → Account to see your PRs.'
              }
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
              </Header>
              {g.items.map((p) => (
                <ListBox.Item
                  key={p.id}
                  id={p.id}
                  textValue={p.title}
                  className="min-h-0 rounded-none border-b border-separator px-6 py-0"
                >
                  <PrRow id={p.id} sel={ui.selected === p.id} picked={false} />
                </ListBox.Item>
              ))}
            </ListBox.Section>
          ))}
        </ListBox>
      </div>
      <Hints>
        <K>J</K>
        <K>K</K> navigate <K>⏎</K> open <K>⌘K</K> everything
      </Hints>
    </div>
  );
});
