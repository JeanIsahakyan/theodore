import {
  BranchesRight,
  CircleXmark,
  CodePullRequest,
  Gear,
  Keyboard,
  LayoutSideContentLeft,
  ListCheck,
  Magnifier,
  Moon,
  Pencil,
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
import { useRootStore, useUi } from '../stores/context';
import { sameRoute, toggleTheme, type Route } from '../stores/UiStore';
import { Avatar, K, Spinner } from './bits';
import { inInbox } from './List';
import { openPrCount } from './prs/filters';
import { sectionsOf, type Section } from '../core/workspaces';
import { SandboxBadge } from './sandbox/SandboxBadge';
import { SyncStatus } from './shell/SyncStatus';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { spaceSeen } from './space/seen';
import { isBuildMode } from './space/mode';
import {
  spaceGlyph,
  spaceTitle,
  spacesIn,
  type SpaceGlyph,
} from './space/spaces';

interface NavItem {
  key: string;
  icon: ReactNode;
  label: string;
  n?: number;
  route?: Route;
  /** An action instead of a route, e.g. "New space". */
  onPress?: () => void;
}

interface NavGroup {
  id: string;
  title?: string;
  items: NavItem[];
}

const routeKey = (r: Route) => JSON.stringify(r);

/** A space's run state at a glance (docs/spaces.md §3). */
function SpaceGlyphIcon({ g }: { g: SpaceGlyph }) {
  switch (g) {
    case 'running':
      return <Spinner />;
    case 'unseen':
      return (
        <span
          className="size-2 rounded-full bg-accent"
          aria-label="Turn finished"
        />
      );
    case 'failed':
      return <CircleXmark className="text-danger" aria-label="Failed" />;
    case 'idle':
      return <Pencil />;
  }
}

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

/** Linear's sidebar as one HeroUI ListBox: single selection = current route. */
export const Sidebar = observer(function Sidebar() {
  const store = useRootStore();
  const ui = useUi();
  // ── workspaces: sections of the selected workspace ──────────────────
  // Everything below the switcher is scoped to the active workspace; a
  // local folder has no Inbox or Pull requests, and only a single project
  // has Branches. The switcher itself (All projects + every project) is
  // `WorkspaceSwitcher`, rendered above this list.
  const ws = store.workspaces;
  const prs = ws.scopePrs(store.models.prSummaries.all());
  const inboxStates = store.models.inboxStates.all();
  // First state per PR, as `find` would pick — one pass, not one per row.
  const stateByPr = new Map<string, (typeof inboxStates)[number]>();
  for (const s of inboxStates) if (!stateByPr.has(s.pr)) stateByPr.set(s.pr, s);
  const stateOf = (pr: string) => stateByPr.get(pr);
  const inboxCount = prs.filter((p) => {
    if (!inInbox(p)) return false;
    const s = stateOf(p.id);
    return !s?.done && !s?.snooze;
  }).length;
  const tasksOpen = ws.scopeTasks(
    store.models.tasks.where((t) => t.status !== 'done'),
  ).length;
  const viewer = store.ephemeral.viewer;

  const all: Record<Section, NavItem> = {
    inbox: {
      key: routeKey({ name: 'inbox' }),
      icon: <Tray />,
      label: 'Inbox',
      n: inboxCount,
      route: { name: 'inbox' },
    },
    prs: {
      key: routeKey({ name: 'prs' }),
      icon: <CodePullRequest />,
      label: 'Pull requests',
      n: openPrCount(prs),
      route: { name: 'prs' },
    },
    branches: {
      key: routeKey({ name: 'branches' }),
      icon: <BranchesRight />,
      label: 'Branches',
      route: { name: 'branches' },
    },
    tasks: {
      key: routeKey({ name: 'tasks' }),
      icon: <ListCheck />,
      label: 'Tasks',
      n: tasksOpen,
      route: { name: 'tasks' },
    },
    skills: {
      key: routeKey({ name: 'skills' }),
      icon: <Sparkles />,
      label: 'Skills',
      route: { name: 'skills' },
    },
  };
  // Spaces (docs/spaces.md): only with build mode on.
  const spaces = isBuildMode(store)
    ? spacesIn(ui.workspace, store.models.spaces.all())
    : null;
  const groups: NavGroup[] = [
    { id: 'main', items: sectionsOf(ws.kind).map((k) => all[k]) },
    ...(spaces
      ? [
          {
            id: 'spaces',
            title: 'Spaces',
            items: [
              ...spaces.map(
                (s): NavItem => ({
                  key: routeKey({ name: 'space', id: s.id }),
                  icon: (
                    <SpaceGlyphIcon g={spaceGlyph(s, spaceSeen.get(s.id))} />
                  ),
                  label: spaceTitle(s),
                  route: { name: 'space', id: s.id },
                }),
              ),
              {
                key: 'new-space',
                icon: <Plus />,
                label: 'New space',
                onPress: () => ui.openModal('new-space'),
              },
            ],
          },
        ]
      : []),
  ];
  const items = groups.flatMap((g) => g.items);
  // ── /workspaces ─────────────────────────────────────────────────────────
  const current = items.find((i) => i.route && sameRoute(i.route, ui.route));

  return (
    <aside className="sidebar flex w-64 shrink-0 flex-col overflow-hidden border-r border-separator bg-background">
      <Toolbar
        aria-label="Workspace"
        data-tauri-drag-region
        className="flex w-full items-center gap-1.5 pb-3 pe-4 ps-3.5 pt-11"
      >
        <WorkspaceSwitcher />
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
        // Navigation, not a selection: every press acts, the current route
        // is just styled. A selection list swallowed the first press after
        // a dialog closed (it only moved focus there).
        selectionMode="none"
        onAction={(k) => {
          const it = items.find((i) => i.key === String(k));
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
                aria-current={current?.key === i.key ? 'page' : undefined}
                className={`nav group gap-3 px-3 text-sm ${current?.key === i.key ? 'bg-default font-medium' : ''}`}
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
        className="flex w-full items-center gap-2 px-5 pt-2.5"
      >
        <SyncStatus />
        <span className="flex-1" />
        <SandboxBadge />
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
            Not signed in
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
