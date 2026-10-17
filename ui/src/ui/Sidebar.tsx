import {
  Gear,
  Keyboard,
  LayoutSideContentLeft,
  ListCheck,
  Magnifier,
  Moon,
  Tray,
} from '@gravity-ui/icons';
import { Button, ListBox, Separator, Toolbar, Tooltip } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import { useRootStore, useUi } from '../stores/context';
import { sameRoute, toggleTheme, type Route } from '../stores/UiStore';
import { K } from './bits';

interface NavItem {
  key: string;
  icon: ReactNode;
  label: string;
  n?: number;
  route: Route;
}

const routeKey = (r: Route) => JSON.stringify(r);

function IconBtn({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={label}
        className="size-7 min-w-7 text-muted"
        onPress={onPress}
      >
        {children}
      </Button>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip>
  );
}

/** Linear's sidebar as one HeroUI ListBox: sections, single selection = current route. */
export const Sidebar = observer(function Sidebar() {
  const store = useRootStore();
  const ui = useUi();
  const prs = store.models.prSummaries.all();
  const inboxStates = store.models.inboxStates.all();
  const stateOf = (pr: string) => inboxStates.find((s) => s.pr === pr);
  const inboxCount = prs.filter((p) => {
    const s = stateOf(p.id);
    return !s?.done && !s?.snooze;
  }).length;
  const tasksOpen = store.models.tasks.where((t) => t.status !== 'done').length;

  const items: NavItem[] = [
    {
      key: routeKey({ name: 'inbox' }),
      icon: <Tray />,
      label: 'Inbox',
      n: inboxCount,
      route: { name: 'inbox' },
    },
    {
      key: routeKey({ name: 'tasks' }),
      icon: <ListCheck />,
      label: 'Tasks',
      n: tasksOpen,
      route: { name: 'tasks' },
    },
  ];
  const current = items.find((i) => sameRoute(i.route, ui.route));

  return (
    <aside className="sidebar flex w-64 shrink-0 flex-col overflow-hidden border-r border-separator bg-background">
      <Toolbar
        aria-label="Workspace"
        className="flex w-full items-center gap-2.5 px-5 pb-3 pt-4"
      >
        <span className="grid size-6 place-items-center rounded-xl bg-foreground text-xs font-semibold text-background">
          T
        </span>
        <span className="flex-1 font-semibold">Theodore</span>
        <Tooltip>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Commands"
            className="h-7 gap-1.5 px-2 text-muted"
            onPress={() => ui.openModal('cmdk')}
          >
            <Magnifier className="size-4" />
            <K>⌘K</K>
          </Button>
          <Tooltip.Content>Find a command</Tooltip.Content>
        </Tooltip>
      </Toolbar>

      <ListBox
        aria-label="Navigation"
        selectionMode="single"
        selectedKeys={current ? [current.key] : []}
        onSelectionChange={(keys) => {
          const k = keys === 'all' ? undefined : [...keys][0];
          const it = items.find((i) => i.key === k);
          if (it) ui.go(it.route);
        }}
        className="nav-list min-h-0 flex-1 overflow-auto px-2 pb-3"
      >
        {items.map((i) => (
          <ListBox.Item
            key={i.key}
            id={i.key}
            textValue={i.label}
            className="nav gap-3 px-3 text-sm data-[selected=true]:font-medium"
          >
            <span className="grid size-4 place-items-center text-muted [&>svg]:size-4">
              {i.icon}
            </span>
            <span className="min-w-0 flex-1 truncate">{i.label}</span>
            {i.n !== undefined && i.n !== 0 && (
              <span className="text-xs tabular-nums text-muted">{i.n}</span>
            )}
          </ListBox.Item>
        ))}
      </ListBox>

      <Separator />
      <Toolbar
        aria-label="App"
        className="flex w-full items-center gap-1 px-5 py-3"
      >
        <span className="ms-1.5 min-w-0 flex-1 truncate text-sm text-muted">
          local core
        </span>
        <IconBtn
          label="Settings  G S"
          onPress={() => ui.go({ name: 'settings', page: 'agents' })}
        >
          <Gear className="size-4" />
        </IconBtn>
        <IconBtn label="Dark / light theme" onPress={toggleTheme}>
          <Moon className="size-4" />
        </IconBtn>
        <IconBtn
          label="Keyboard shortcuts"
          onPress={() => ui.openModal('help')}
        >
          <Keyboard className="size-4" />
        </IconBtn>
        <IconBtn label="Collapse sidebar  [" onPress={() => ui.toggleSidebar()}>
          <LayoutSideContentLeft className="size-4" />
        </IconBtn>
      </Toolbar>
    </aside>
  );
});
