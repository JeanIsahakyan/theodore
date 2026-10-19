import {
  CodePullRequest,
  Folder,
  Gear,
  LayoutSideContentLeft,
  ListCheck,
  Link,
  Plus,
  Tray,
  Xmark,
} from '@gravity-ui/icons';
import { Button, Tabs, Toolbar, Tooltip } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, type ReactNode } from 'react';
import { useRootStore, useUi } from '../stores/context';
import type { Route } from '../stores/UiStore';
import { K } from './bits';
import { projectLabel } from './Projects';
import { PRIcon } from './StatusIcon';

function useLabel(r: Route): {
  icon: ReactNode;
  title: string;
  drafts?: number;
} {
  const store = useRootStore();
  switch (r.name) {
    case 'inbox':
      return { icon: <Tray />, title: 'Inbox' };
    case 'mine':
      return { icon: <CodePullRequest />, title: 'My PRs' };
    case 'tasks':
      return { icon: <ListCheck />, title: 'Tasks' };
    case 'settings':
      return { icon: <Gear />, title: 'Settings' };
    case 'new':
      return { icon: <Link />, title: 'New tab' };
    case 'project': {
      const p = store.models.projects.get(r.id);
      return { icon: <Folder />, title: p ? projectLabel(p) : r.id };
    }
    case 'review': {
      const p = store.models.prSummaries.get(r.pr);
      const drafts = store.models.drafts.where((d) => d.pr === r.pr).length;
      return {
        icon: <PRIcon status={p?.state ?? 'open'} />,
        title: p ? `#${p.pr.number} ${p.title}` : r.pr,
        drafts,
      };
    }
  }
}

const key = (r: Route) => JSON.stringify(r);

/** Linear-style tabs: every opened PR stays one click away. */
export const TabBar = observer(function TabBar({
  showOpen,
}: {
  showOpen: boolean;
}) {
  const ui = useUi();
  const closable = ui.tabs.length > 1;
  const listRef = useRef<HTMLDivElement>(null);
  const selectedKey = key(ui.route);
  // Many tabs open + a short list width: keep the one you just switched to
  // in view instead of leaving it scrolled off either edge.
  useEffect(() => {
    const el = listRef.current?.querySelector(
      '[aria-selected="true"]',
    ) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedKey]);
  return (
    <Toolbar
      aria-label="Tabs"
      data-tauri-drag-region
      className={`tabbar flex h-12 w-full shrink-0 items-center gap-2 border-b border-separator bg-background px-3 ${showOpen ? 'ps-20' : ''}`}
    >
      {showOpen && (
        <Tooltip>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label="Expand sidebar"
            onPress={() => ui.toggleSidebar()}
          >
            <LayoutSideContentLeft className="size-4" />
          </Button>
          <Tooltip.Content>
            Sidebar <K>[</K>
          </Tooltip.Content>
        </Tooltip>
      )}
      <Tabs
        selectedKey={selectedKey}
        onSelectionChange={(k) => {
          const t = ui.tabs.find((x) => key(x) === k);
          if (t) ui.go(t);
        }}
        className="min-w-0 shrink"
      >
        {/* `display: contents` — a plain ref anchor to query the selected
         *  tab from, without affecting the flex layout below it. */}
        <div ref={listRef} className="contents">
          <Tabs.List
            aria-label="Open tabs"
            className="flex w-fit max-w-full overflow-x-auto scrollbar-none"
          >
            {ui.tabs.map((t, i) => (
              <TabItem
                key={key(t)}
                t={t}
                i={i}
                closable={closable}
                onClose={() => ui.closeTab(t)}
              />
            ))}
          </Tabs.List>
        </div>
      </Tabs>
      <span className="flex-1" />
      <Tooltip>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label="New tab"
          onPress={() => ui.newTab()}
        >
          <Plus className="size-4" />
        </Button>
        <Tooltip.Content>
          New tab — paste a PR link <K>⌘T</K>
        </Tooltip.Content>
      </Tooltip>
    </Toolbar>
  );
});

const TabItem = observer(function TabItem({
  t,
  i,
  closable,
  onClose,
}: {
  t: Route;
  i: number;
  closable: boolean;
  onClose: () => void;
}) {
  const l = useLabel(t);
  return (
    <Tabs.Tab
      id={key(t)}
      // Tabs shrink to fit (title truncates); past their minimum the list scrolls.
      className="tab group min-w-28 max-w-64 shrink gap-2 text-sm"
    >
      {i > 0 && <Tabs.Separator />}
      <span className="grid size-4 shrink-0 place-items-center [&>svg]:size-4">
        {l.icon}
      </span>
      <span
        className="min-w-0 truncate"
        title={`${l.title}${i < 9 ? `  ⌥${i + 1}` : ''}`}
      >
        {l.title}
      </span>
      {!!l.drafts && (
        <span
          className="size-1.5 shrink-0 rounded-full bg-warning"
          aria-label={`${l.drafts} pending comments`}
        />
      )}
      {closable && (
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label="close tab"
          className="tab-x -me-1 size-5 min-w-5 rounded-xl opacity-0 group-hover:opacity-100 group-data-[selected=true]:opacity-100"
          onPress={onClose}
        >
          <Xmark className="size-3.5" />
        </Button>
      )}
      <Tabs.Indicator />
    </Tabs.Tab>
  );
});
