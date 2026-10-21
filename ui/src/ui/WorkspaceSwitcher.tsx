/**
 * The workspace switcher at the top of the sidebar: "All projects" and
 * every project, always expanded, one selected. Click switches; drag
 * reorders (the order ⌃1…9 follow); right-click for refresh, settings
 * and remove.
 */
import { House, Plus } from '@gravity-ui/icons';
import { ListBox } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import { useDragAndDrop } from 'react-aria-components';
import { refreshProject, removeProject } from '../actions';
import { ALL } from '../core/workspaces';
import { FEATURES } from '../features';
import { useRootStore, useUi, useWorkspaces } from '../stores/context';
import { contextMenuHandler, type ContextMenuItem } from './ContextMenu';
import { ProjectStatusDot, projectContextMenu, projectLabel } from './Projects';

const ADD = 'add-project';
/** The active workspace is highlighted, not just bold. */
const ITEM =
  'nav gap-3 px-3 text-sm data-[selected=true]:bg-default data-[selected=true]:font-medium';

function Row({
  icon,
  label,
  sub,
  n,
  keys,
}: {
  icon: ReactNode;
  label: string;
  sub?: string;
  n?: number;
  keys?: string;
}) {
  return (
    <>
      <span className="grid size-4 shrink-0 place-items-center text-muted [&>svg]:size-4">
        {icon}
      </span>
      <span
        className="min-w-0 flex-1 truncate"
        title={keys ? `${label}  ${keys}` : label}
      >
        {label}
        {sub && <span className="ms-1.5 text-xs text-muted">{sub}</span>}
      </span>
      {!!n && (
        <span
          className="shrink-0 text-xs tabular-nums text-muted"
          aria-label={`${n} waiting`}
        >
          {n}
        </span>
      )}
    </>
  );
}

export const WorkspaceSwitcher = observer(function WorkspaceSwitcher() {
  const store = useRootStore();
  const ui = useUi();
  const ws = useWorkspaces();
  const projects = ws.projects;
  const badges = ws.badges;

  const { dragAndDropHooks } = useDragAndDrop({
    getItems: (keys) =>
      [...keys]
        .filter((k) => k !== ALL && k !== ADD)
        .map((k) => ({ 'text/plain': String(k) })),
    onReorder: (e) => {
      const ids = ws.projects.map((p) => p.id);
      let target: string | undefined = String(e.target.key);
      let pos: 'before' | 'after' =
        e.target.dropPosition === 'before' ? 'before' : 'after';
      // All and Add project stay put: a drop on them means first / last.
      if (target === ALL) [target, pos] = [ids[0], 'before'];
      else if (target === ADD) [target, pos] = [ids.at(-1), 'after'];
      if (target) ws.reorder([...e.keys].map(String), target, pos);
    },
  });

  const menuFor = (id: string): ContextMenuItem[] => {
    const p = store.models.projects.get(id);
    if (!p) return [];
    const [refresh, remove] = projectContextMenu({
      onRefresh: () => void refreshProject(store, id),
      onRemove: () => {
        if (
          window.confirm(
            `Remove ${projectLabel(p)}? Its local clone is deleted; your own folder (if local) is untouched.`,
          )
        ) {
          void removeProject(store, id);
        }
      },
    });
    return [
      refresh!,
      {
        id: 'settings',
        label: 'Project settings',
        onAction: () => ui.go({ name: 'settings', page: 'projects' }),
      },
      remove!,
    ];
  };

  return (
    <ListBox
      aria-label="Workspaces"
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[ui.workspace]}
      onSelectionChange={(keys) => {
        const k = keys === 'all' ? undefined : [...keys][0];
        if (k === ADD) ui.openModal('add-project');
        else if (k !== undefined) ws.switchTo(String(k));
      }}
      dragAndDropHooks={dragAndDropHooks}
      className="nav-list max-h-[40vh] shrink-0 overflow-auto px-2 pb-2"
    >
      <ListBox.Item id={ALL} textValue="All projects" className={ITEM}>
        <Row
          icon={<House />}
          label="All projects"
          n={badges.get(ALL)}
          keys="⌃0"
        />
      </ListBox.Item>
      {projects.map((p, i) => (
        <ListBox.Item
          key={p.id}
          id={p.id}
          textValue={projectLabel(p)}
          onContextMenu={contextMenuHandler(ui, menuFor(p.id))}
          className={ITEM}
        >
          <Row
            icon={<ProjectStatusDot p={p} />}
            label={projectLabel(p)}
            sub={p.repo.host === 'local' ? 'local' : undefined}
            n={badges.get(p.id)}
            keys={i < 9 ? `⌃${i + 1}` : undefined}
          />
        </ListBox.Item>
      ))}
      <ListBox.Item
        id={ADD}
        textValue="Add project"
        isDisabled={!FEATURES.projects}
        className="nav gap-3 px-3 text-sm text-muted"
      >
        <Row icon={<Plus />} label="Add project" />
      </ListBox.Item>
    </ListBox>
  );
});
