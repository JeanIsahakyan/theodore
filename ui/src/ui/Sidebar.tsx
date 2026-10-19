import {
  BranchesRight,
  CodePullRequest,
  Gear,
  Keyboard,
  LayoutSideContentLeft,
  ListCheck,
  Magnifier,
  Moon,
  Plus,
  Sparkles,
  Tray,
} from '@gravity-ui/icons';
import {
  Button,
  Header,
  ListBox,
  Separator,
  Toolbar,
  Tooltip,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import { refreshProject, removeProject } from '../actions';
import { FEATURES } from '../features';
import { useRootStore, useUi } from '../stores/context';
import { sameRoute, toggleTheme, type Route } from '../stores/UiStore';
import { Avatar, K } from './bits';
import { contextMenuHandler, type ContextMenuItem } from './ContextMenu';
import { ProjectStatusDot, projectContextMenu, projectLabel } from './Projects';
import { SyncStatus } from './shell/SyncStatus';

interface NavItem {
  key: string;
  icon: ReactNode;
  label: string;
  n?: number;
  route?: Route;
  isDisabled?: boolean;
  onPress?: () => void;
  contextMenu?: ContextMenuItem[];
}

interface NavGroup {
  id: string;
  title?: string;
  items: NavItem[];
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
  // First state per PR, as `find` would pick — one pass, not one per row.
  const stateByPr = new Map<string, (typeof inboxStates)[number]>();
  for (const s of inboxStates) if (!stateByPr.has(s.pr)) stateByPr.set(s.pr, s);
  const stateOf = (pr: string) => stateByPr.get(pr);
  const inboxCount = prs.filter((p) => {
    const s = stateOf(p.id);
    return !s?.done && !s?.snooze;
  }).length;
  const tasksOpen = store.models.tasks.where((t) => t.status !== 'done').length;

  const viewer = store.ephemeral.viewer;
  const mineOpen = prs.filter(
    (p) => viewer && p.author.login === viewer.login && p.state !== 'merged',
  ).length;

  const localBranches = prs.filter((p) => p.pr.repo.host === 'local');
  const projects = store.models.projects.all();

  const groups: NavGroup[] = [
    {
      id: 'main',
      items: [
        {
          key: routeKey({ name: 'inbox' }),
          icon: <Tray />,
          label: 'Inbox',
          n: inboxCount,
          route: { name: 'inbox' },
        },
        ...(FEATURES.currentUser
          ? [
              {
                key: routeKey({ name: 'mine' }),
                icon: <CodePullRequest />,
                label: 'My PRs',
                n: mineOpen,
                route: { name: 'mine' } as Route,
              },
            ]
          : []),
        {
          key: routeKey({ name: 'tasks' }),
          icon: <ListCheck />,
          label: 'Tasks',
          n: tasksOpen,
          route: { name: 'tasks' },
        },
        {
          key: routeKey({ name: 'skills' }),
          icon: <Sparkles />,
          label: 'Skills',
          route: { name: 'skills' },
        },
      ],
    },
    {
      id: 'projects',
      title: 'Projects',
      items: [
        ...projects.map((p): NavItem => ({
          key: routeKey({ name: 'project', id: p.id }),
          icon: <ProjectStatusDot p={p} />,
          label: projectLabel(p),
          route: { name: 'project', id: p.id },
          contextMenu: projectContextMenu({
            onRefresh: () => void refreshProject(store, p.id),
            onRemove: () => {
              if (
                window.confirm(
                  `Remove ${projectLabel(p)}? Its local clone is deleted; your own folder (if local) is untouched.`,
                )
              ) {
                void removeProject(store, p.id);
              }
            },
          }),
        })),
        {
          key: 'add-project',
          icon: <Plus />,
          label: 'Add project',
          isDisabled: !FEATURES.projects,
          onPress: () => ui.openModal('add-project'),
        },
      ],
    },
    ...(localBranches.length
      ? [
          {
            id: 'local',
            title: 'Local branches',
            items: localBranches.map((p) => ({
              key: routeKey({ name: 'review', pr: p.id }),
              icon: <BranchesRight />,
              label: p.head_ref,
              route: { name: 'review', pr: p.id } as Route,
            })),
          },
        ]
      : []),
  ];
  const allItems = groups.flatMap((g) => g.items);
  const current = allItems.find((i) => i.route && sameRoute(i.route, ui.route));

  return (
    <aside className="sidebar flex w-64 shrink-0 flex-col overflow-hidden border-r border-separator bg-background">
      <Toolbar
        aria-label="Workspace"
        data-tauri-drag-region
        className="flex w-full items-center gap-2.5 pb-3 pe-5 ps-5 pt-11"
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
          const it = allItems.find((i) => i.key === k);
          if (it?.route) ui.go(it.route);
          else it?.onPress?.();
        }}
        className="nav-list min-h-0 flex-1 overflow-auto px-2 pb-3"
      >
        {groups.map((g) => (
          <ListBox.Section key={g.id} id={g.id}>
            {g.title && (
              <Header className="px-3 pb-1.5 pt-6 text-xs text-muted">
                {g.title}
              </Header>
            )}
            {g.items.map((i) => (
              <ListBox.Item
                key={i.key}
                id={i.key}
                textValue={i.label}
                isDisabled={i.isDisabled}
                onContextMenu={
                  i.contextMenu && contextMenuHandler(ui, i.contextMenu)
                }
                className="nav gap-3 px-3 text-sm data-[selected=true]:font-medium"
              >
                <span className="grid size-4 shrink-0 place-items-center text-muted [&>svg]:size-4">
                  {i.icon}
                </span>
                <span className="min-w-0 flex-1 truncate" title={i.label}>
                  {i.label}
                </span>
                {i.n !== undefined && i.n !== 0 && (
                  <span className="shrink-0 text-xs tabular-nums text-muted">
                    {i.n}
                  </span>
                )}
              </ListBox.Item>
            ))}
          </ListBox.Section>
        ))}
      </ListBox>

      <Separator />
      <Toolbar
        aria-label="Sync status"
        className="flex w-full items-center px-5 pt-2.5"
      >
        <SyncStatus />
      </Toolbar>
      <Toolbar
        aria-label="App"
        className="flex w-full items-center gap-1 px-5 pb-3 pt-1.5"
      >
        {viewer ? (
          <>
            <Avatar person={viewer} size={24} />
            <span
              className="ms-1.5 min-w-0 flex-1 truncate text-sm"
              title={viewer.name ?? viewer.login}
            >
              {viewer.login}
            </span>
          </>
        ) : (
          <span className="ms-1.5 min-w-0 flex-1 truncate text-sm text-muted">
            local core
          </span>
        )}
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
