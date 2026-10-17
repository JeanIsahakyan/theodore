import {
  Gear,
  LayoutSideContentLeft,
  ListCheck,
  Plus,
  Tray,
  Xmark,
} from '@gravity-ui/icons';
import { Button, Tabs, Toolbar, Tooltip } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import { useRootStore, useUi } from '../stores/context';
import type { Route } from '../stores/UiStore';
import { K } from './bits';
import { PRIcon } from './StatusIcon';

function useLabel(r: Route): { icon: ReactNode; title: string } {
  const store = useRootStore();
  switch (r.name) {
    case 'inbox':
      return { icon: <Tray />, title: 'Inbox' };
    case 'tasks':
      return { icon: <ListCheck />, title: 'Tasks' };
    case 'settings':
      return { icon: <Gear />, title: 'Settings' };
    case 'review': {
      const p = store.models.prSummaries.get(r.pr);
      return {
        icon: <PRIcon status={p?.state ?? 'open'} />,
        title: p ? `#${p.pr.number} ${p.title}` : r.pr,
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
  return (
    <Toolbar
      aria-label="Tabs"
      className="tabbar flex h-12 w-full shrink-0 items-center gap-2 border-b border-separator bg-background px-3"
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
        selectedKey={key(ui.route)}
        onSelectionChange={(k) => {
          const t = ui.tabs.find((x) => key(x) === k);
          if (t) ui.go(t);
        }}
        className="min-w-0 shrink"
      >
        <Tabs.List
          aria-label="Open tabs"
          className="w-fit max-w-full overflow-x-auto scrollbar-none"
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
      </Tabs>
      <span className="flex-1" />
      <Tooltip>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label="Open"
          onPress={() => ui.openModal('cmdk')}
        >
          <Plus className="size-4" />
        </Button>
        <Tooltip.Content>
          Open <K>⌘K</K>
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
    <Tabs.Tab id={key(t)} className="tab group max-w-64 gap-2 text-sm">
      {i > 0 && <Tabs.Separator />}
      <span className="grid size-4 shrink-0 place-items-center [&>svg]:size-4">
        {l.icon}
      </span>
      <span
        className="truncate"
        title={`${l.title}${i < 9 ? `  ⌥${i + 1}` : ''}`}
      >
        {l.title}
      </span>
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
