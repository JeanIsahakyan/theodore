/**
 * Projects: connected repositories (GitHub/GitLab/local folders).
 * `ProjectPicker` is the search + multi-select repo list (grouped by
 * owner/org) plus a one-shot local folder add, shared by the sidebar's Add
 * project dialog and onboarding's Projects step.
 * `ProjectView` is the repo view opened from the sidebar: header, Pull
 * requests (list ↔ board, Display popover — ported from the prototype's
 * `PRView`) and Branches.
 */
import { useEffect, useState } from 'react';
import {
  ArrowRotateLeft,
  BranchesRight,
  Check,
  CodePullRequest,
  FolderPlus,
  LayoutColumns,
  LayoutList,
  Lock,
  Magnifier,
  Sliders,
} from '@gravity-ui/icons';
import {
  Button,
  Card,
  Checkbox,
  CheckboxGroup,
  Chip,
  Label,
  Popover,
  ScrollShadow,
  SearchField,
  Separator,
  Surface,
  Table,
  Tabs,
  Tag,
  TagGroup,
  ToggleButton,
  ToggleButtonGroup,
  Toolbar,
  Tooltip,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { LocalBranch, PrState, Project, RepoRef } from '../gen/contract';
import {
  addProject,
  openBranch as openBranchAction,
  pickFolder,
  refreshProject,
} from '../actions';
import { api } from '../core/api';
import { useRootStore, useUi } from '../stores/context';
import { Avatar, CheckIcon, Empty, Hints, K, Shell, Spinner } from './bits';
import type { ContextMenuItem } from './ContextMenu';
import {
  DisplayRow,
  PeekToggle,
  Picker,
  PROP_LABEL,
  PrRow,
  ROW_PROPS,
  RowList,
  STATUS_ORDER,
  ViewHeader,
  ago,
  type InboxPr,
  type RowProp,
} from './List';
import { RowsSkeleton } from './Loading';
import { PRIcon, prStatusLabel } from './StatusIcon';
import { useViewKeys } from './keys';

// ── pure helpers (tested) ───────────────────────────────────────────────

export function repoKey(r: RepoRef): string {
  return `${r.host}:${r.owner}/${r.name}`;
}

export function sameRepo(a: RepoRef, b: RepoRef): boolean {
  return a.host === b.host && a.owner === b.owner && a.name === b.name;
}

/** "owner/name" for a host repo, or the folder name for a local one. */
export function projectLabel(p: Project): string {
  return p.repo.host === 'local'
    ? p.repo.name
    : `${p.repo.owner}/${p.repo.name}`;
}

/** Repos matching a search query on "owner/name", case-insensitive. */
export function filterHostRepos(repos: RepoRef[], query: string): RepoRef[] {
  const q = query.trim().toLowerCase();
  if (!q) return repos;
  return repos.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(q));
}

export interface ProjectDisplay {
  layout: 'list' | 'board';
  groupBy: 'status' | 'none';
  sort: 'activity' | 'size';
  props: RowProp[];
}

// A function, not a constant: List.tsx and Projects.tsx import each other
// (through Modals), so ROW_PROPS isn't initialised yet at module load.
export const defaultProjectDisplay = (): ProjectDisplay => ({
  layout: 'list',
  groupBy: 'status',
  sort: 'activity',
  props: ROW_PROPS,
});

function sortProjectPrs(
  items: InboxPr[],
  sort: ProjectDisplay['sort'],
): InboxPr[] {
  const by =
    sort === 'size'
      ? (p: InboxPr) => -(p.additions + p.deletions)
      : (p: InboxPr) => -p.updated_at;
  return [...items].sort((a, b) => by(a) - by(b));
}

/** Grouping for the list layout: by status, or one flat group. */
export function groupProjectPrs(
  items: InboxPr[],
  d: Pick<ProjectDisplay, 'groupBy' | 'sort'>,
): { id: string; title: string; items: InboxPr[] }[] {
  const sorted = sortProjectPrs(items, d.sort);
  if (d.groupBy === 'none') return [{ id: 'all', title: 'All', items: sorted }];
  return STATUS_ORDER.map((st) => ({
    id: st,
    title: prStatusLabel[st],
    items: sorted.filter((p) => p.state === st),
  }));
}

/** Board columns: always by status, regardless of `groupBy`. */
export function boardColumns(
  items: InboxPr[],
  sort: ProjectDisplay['sort'],
): { status: PrState; title: string; items: InboxPr[] }[] {
  const sorted = sortProjectPrs(items, sort);
  return STATUS_ORDER.map((st) => ({
    status: st,
    title: prStatusLabel[st],
    items: sorted.filter((p) => p.state === st),
  }));
}

// ── Add project: search + multi-select repos, grouped by owner ─────────

/** Repos grouped by owner/org, in first-seen order — the picker's section
 *  headers. */
export function groupByOwner(
  repos: RepoRef[],
): { owner: string; repos: RepoRef[] }[] {
  const order: string[] = [];
  const byOwner = new Map<string, RepoRef[]>();
  for (const r of repos) {
    if (!byOwner.has(r.owner)) {
      order.push(r.owner);
      byOwner.set(r.owner, []);
    }
    byOwner.get(r.owner)!.push(r);
  }
  return order.map((owner) => ({ owner, repos: byOwner.get(owner)! }));
}

/** PRs the signed-in user is already involved in, in this repo — the
 *  "N PRs with you" chip. */
export function prsWithYou(items: InboxPr[], repo: RepoRef): number {
  return items.filter((p) => sameRepo(p.pr.repo, repo)).length;
}

/** GitHub serves an owner/org's avatar at this fixed URL — no such
 *  convention for other hosts. */
function ownerAvatarUrl(host: string, owner: string): string | null {
  return host === 'github' ? `https://github.com/${owner}.png` : null;
}

/** One repo row in the picker: a disabled "Added" row for repos that are
 *  already a project, otherwise a checkbox — `RepoRef` doesn't carry
 *  `description` / `private` / `pushed_at` yet, so those render only when
 *  a future contract change adds them. */
function RepoRow({
  r,
  already,
  prCount,
}: {
  r: RepoRef;
  already: boolean;
  prCount: number;
}) {
  const extra = r as Partial<{
    description: string;
    private: boolean;
    pushed_at: number;
  }>;
  const sub = [
    extra.description,
    extra.pushed_at != null ? `pushed ${ago(extra.pushed_at)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const body = (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex items-center gap-2 text-sm font-medium">
        <span className="truncate">{r.name}</span>
        {extra.private && <Lock className="size-3.5 shrink-0 text-muted" />}
      </span>
      {sub && <span className="truncate text-xs text-muted">{sub}</span>}
    </span>
  );

  if (already) {
    return (
      <div className="flex items-center gap-3 rounded-2xl px-3 py-2 opacity-70">
        <span className="grid size-[18px] shrink-0 place-items-center rounded-md border border-separator text-muted">
          <Check className="size-3" />
        </span>
        {body}
        <Chip size="sm" variant="soft" className="shrink-0">
          Added
        </Chip>
      </div>
    );
  }

  return (
    <Checkbox
      value={repoKey(r)}
      className="rounded-2xl px-3 py-2 hover:bg-default/50"
    >
      <Checkbox.Content className="w-full">
        <Checkbox.Control>
          <Checkbox.Indicator />
        </Checkbox.Control>
        {body}
        {prCount > 0 && (
          <Chip size="sm" variant="soft" color="accent" className="shrink-0">
            {prCount} PRs with you
          </Chip>
        )}
      </Checkbox.Content>
    </Checkbox>
  );
}

/** Add project: search + multi-select GitHub repos (grouped by owner, with
 *  a bulk "Add N projects"), plus a one-shot local folder add. Shared by
 *  the sidebar's Add project dialog and onboarding's Projects step. */
export const ProjectPicker = observer(function ProjectPicker({
  onAdded,
}: {
  onAdded?: (p: Project) => void;
}) {
  const store = useRootStore();
  const [repos, setRepos] = useState<RepoRef[] | 'unready' | null>(null);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [addingFolder, setAddingFolder] = useState(false);
  const [addingPicked, setAddingPicked] = useState(false);

  useEffect(() => {
    void api
      .listHostRepos()
      .then(setRepos)
      .catch(() => setRepos('unready'));
  }, []);

  const addedKeys = new Set(
    store.models.projects.all().map((p) => repoKey(p.repo)),
  );
  const prItems = store.models.prSummaries.all();
  const shown =
    repos === null || repos === 'unready' ? [] : filterHostRepos(repos, q);
  const groups = groupByOwner(shown);

  const addLocalFolder = () => {
    setAddingFolder(true);
    void pickFolder(store)
      .then((path) =>
        path ? addProject(store, { repo: null, path }) : null,
      )
      .then((p) => p && onAdded?.(p))
      .finally(() => setAddingFolder(false));
  };

  const addPicked = async () => {
    setAddingPicked(true);
    for (const r of shown.filter((r) => picked.includes(repoKey(r)))) {
      const p = await addProject(store, { repo: r, path: null });
      if (p) onAdded?.(p);
    }
    setPicked([]);
    setAddingPicked(false);
  };

  return (
    <div className="flex flex-col gap-3">
      <SearchField
        aria-label="Find repository"
        value={q}
        onChange={setQ}
        fullWidth
      >
        <SearchField.Group>
          <SearchField.SearchIcon>
            <Magnifier />
          </SearchField.SearchIcon>
          <SearchField.Input placeholder="owner/repo" />
          <SearchField.ClearButton />
        </SearchField.Group>
      </SearchField>

      {repos === null ? (
        <div className="flex flex-col gap-1 py-1">
          <RowsSkeleton rows={5} />
        </div>
      ) : repos === 'unready' ? (
        <Empty
          icon={<CodePullRequest />}
          title="Can't list repositories yet"
          text="Connect GitHub in Settings → Account, then try again."
        />
      ) : (
        <ScrollShadow className="-mx-3 max-h-[360px] px-3" hideScrollBar>
          {groups.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted">
              No repositories match "{q}".
            </p>
          ) : (
            <CheckboxGroup
              aria-label="Repositories"
              value={picked}
              onChange={setPicked}
              className="repo-list flex flex-col gap-1"
            >
              {groups.map(({ owner, repos: group }) => (
                <div key={owner} className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2 px-3 pb-1 pt-3 text-xs font-medium text-muted first:pt-1">
                    <Avatar
                      person={{
                        login: owner,
                        name: null,
                        avatar_url: ownerAvatarUrl(group[0]!.host, owner),
                      }}
                      size={16}
                    />
                    {owner}
                  </div>
                  {group.map((r) => (
                    <RepoRow
                      key={repoKey(r)}
                      r={r}
                      already={addedKeys.has(repoKey(r))}
                      prCount={prsWithYou(prItems, r)}
                    />
                  ))}
                </div>
              ))}
            </CheckboxGroup>
          )}
        </ScrollShadow>
      )}

      <Separator />
      <div className="flex items-center justify-between gap-3">
        <Button
          variant="tertiary"
          isPending={addingFolder}
          onPress={addLocalFolder}
        >
          <FolderPlus className="size-4" />
          Add local folder…
        </Button>
        <Button
          isDisabled={picked.length === 0}
          isPending={addingPicked}
          onPress={() => void addPicked()}
        >
          Add {picked.length} project{picked.length === 1 ? '' : 's'}
        </Button>
      </div>
    </div>
  );
});

export const AddProjectModal = observer(function AddProjectModal() {
  const ui = useUi();
  return (
    <Shell title="Add project" size="lg" onClose={() => ui.closeModal()}>
      <ProjectPicker onAdded={() => ui.closeModal()} />
    </Shell>
  );
});

// ── sidebar status dot ──────────────────────────────────────────────────

export function ProjectStatusDot({ p }: { p: Project }) {
  if (p.status === 'cloning') return <Spinner />;
  if (p.status === 'error') {
    return (
      <Tooltip>
        <Tooltip.Trigger>
          <span className="size-2 rounded-full bg-danger" />
        </Tooltip.Trigger>
        <Tooltip.Content>{p.error ?? 'Failed to add project'}</Tooltip.Content>
      </Tooltip>
    );
  }
  return <span className="size-2 rounded-full bg-success" />;
}

export function projectContextMenu(opts: {
  onRefresh: () => void;
  onRemove: () => void;
}): ContextMenuItem[] {
  return [
    { id: 'refresh', label: 'Refresh', onAction: opts.onRefresh },
    {
      id: 'remove',
      label: 'Remove project',
      danger: true,
      onAction: opts.onRemove,
    },
  ];
}

// ── repo view: header + Pull requests / Branches ────────────────────────

function Board({
  items,
  sort,
  sel,
  onSelect,
  onOpen,
}: {
  items: InboxPr[];
  sort: ProjectDisplay['sort'];
  sel: string | null;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const cols = boardColumns(items, sort);
  return (
    <Surface
      variant="secondary"
      className="board flex min-w-0 flex-1 gap-4 overflow-auto rounded-none px-6 pb-20 pt-4"
    >
      {cols.map((col) => (
        <div
          key={col.status}
          className={`col flex w-64 shrink-0 flex-col gap-2 ${col.status === 'merged' ? 'opacity-70' : ''}`}
        >
          <div className="col-h flex h-8 items-center gap-2 px-1 text-sm">
            <PRIcon status={col.status} />
            <b className="font-medium">{col.title}</b>
            <span className="text-muted">{col.items.length}</span>
          </div>
          {col.items.map((p) => (
            <Card
              key={p.id}
              id={`R-${p.id}`}
              className={`card cursor-default gap-2 p-3 ${sel === p.id ? 'sel ring-2 ring-accent' : ''}`}
              onClick={() => onSelect(p.id)}
              onDoubleClick={() => onOpen(p.id)}
            >
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-xs text-muted">
                  #{p.pr.number}
                </span>
                <span className="flex-1" />
                <CheckIcon s={p.checks} />
                <Avatar person={p.author} size={16} />
              </div>
              <Card.Title className="text-sm font-medium leading-snug">
                {p.title}
              </Card.Title>
              <div className="flex flex-wrap items-center gap-1.5">
                {(p.state === 'open' || p.state === 'draft') &&
                  p.required_approvals != null && (
                    <span className="text-xs text-muted">
                      {p.approvals}/{p.required_approvals} ✓
                    </span>
                  )}
              </div>
            </Card>
          ))}
        </div>
      ))}
    </Surface>
  );
}

function ProjectDisplayButton({
  display,
  setDisplay,
}: {
  display: ProjectDisplay;
  setDisplay: (d: Partial<ProjectDisplay>) => void;
}) {
  return (
    <Popover>
      <Button size="sm" variant="tertiary" className="gap-1.5">
        <Sliders className="size-4" />
        Display
      </Button>
      <Popover.Content
        placement="bottom end"
        offset={8}
        className="w-[340px] p-0"
      >
        <Popover.Dialog className="display-pop flex flex-col gap-0 p-0">
          <div className="flex items-center justify-between px-4 py-3">
            <Popover.Heading className="text-sm font-semibold">
              Display
            </Popover.Heading>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2 text-xs text-muted"
              onPress={() => setDisplay(defaultProjectDisplay())}
            >
              Reset
            </Button>
          </div>
          <div className="px-4 pb-3">
            <ToggleButtonGroup
              size="sm"
              fullWidth
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={new Set([display.layout])}
              onSelectionChange={(keys) =>
                setDisplay({ layout: [...keys][0] as ProjectDisplay['layout'] })
              }
            >
              <ToggleButton id="list" className="gap-1.5">
                <LayoutList className="size-4" />
                List
              </ToggleButton>
              <ToggleButton id="board" className="gap-1.5">
                <ToggleButtonGroup.Separator />
                <LayoutColumns className="size-4" />
                Board
              </ToggleButton>
            </ToggleButtonGroup>
          </div>
          <Separator />
          <div className="flex flex-col gap-3 px-4 py-3">
            <DisplayRow label="Grouping">
              <Picker
                label="Grouping"
                value={display.groupBy}
                onChange={(v) => setDisplay({ groupBy: v })}
                options={[
                  ['status', 'By status'],
                  ['none', 'No grouping'],
                ]}
              />
            </DisplayRow>
            <DisplayRow label="Ordering">
              <Picker
                label="Ordering"
                value={display.sort}
                onChange={(v) => setDisplay({ sort: v })}
                options={[
                  ['activity', 'By activity'],
                  ['size', 'By size'],
                ]}
              />
            </DisplayRow>
          </div>
          {display.layout === 'list' && (
            <>
              <Separator />
              <div className="flex flex-col gap-2.5 px-4 pb-4 pt-3">
                <Label className="text-sm text-muted">Row properties</Label>
                <TagGroup
                  aria-label="Row properties"
                  size="sm"
                  selectionMode="multiple"
                  selectionBehavior="toggle"
                  escapeKeyBehavior="none"
                  selectedKeys={new Set(display.props)}
                  onSelectionChange={(keys) =>
                    setDisplay({
                      props: ROW_PROPS.filter(
                        (p) => keys === 'all' || keys.has(p),
                      ),
                    })
                  }
                >
                  <TagGroup.List className="flex flex-wrap gap-1.5">
                    {ROW_PROPS.map((p) => (
                      <Tag key={p} id={p} textValue={PROP_LABEL[p]}>
                        {PROP_LABEL[p]}
                      </Tag>
                    ))}
                  </TagGroup.List>
                </TagGroup>
              </div>
            </>
          )}
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}

const ProjectPrs = observer(function ProjectPrs({
  project,
}: {
  project: Project;
}) {
  const store = useRootStore();
  const ui = useUi();
  const [display, setDisplayState] = useState<ProjectDisplay>(
    defaultProjectDisplay(),
  );
  const setDisplay = (patch: Partial<ProjectDisplay>) =>
    setDisplayState((d) => ({ ...d, ...patch }));

  const items = store.models.prSummaries.where((p) =>
    sameRepo(p.pr.repo, project.repo),
  );
  const groups = groupProjectPrs(items, display).filter((g) => g.items.length);
  const order =
    display.layout === 'board'
      ? boardColumns(items, display.sort).flatMap((c) =>
          c.items.map((p) => p.id),
        )
      : groups.flatMap((g) => g.items.map((p) => p.id));

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

  return (
    <div className="view relative flex min-w-0 flex-1 flex-col">
      <Toolbar
        aria-label="Pull requests view"
        className="flex h-10 w-full shrink-0 items-center gap-3 border-b border-separator px-6"
      >
        <span className="text-xs text-muted">{items.length} PRs</span>
        <span className="flex-1" />
        <ProjectDisplayButton display={display} setDisplay={setDisplay} />
        <PeekToggle on={ui.peek} toggle={() => ui.togglePeek()} />
      </Toolbar>
      <div className="flex min-h-0 flex-1">
        {display.layout === 'board' ? (
          <Board
            items={items}
            sort={display.sort}
            sel={ui.selected}
            onSelect={(id) => ui.select(id)}
            onOpen={(id) => ui.go({ name: 'review', pr: id })}
          />
        ) : (
          <RowList
            groups={groups}
            sel={ui.selected}
            closed={{}}
            toggle={() => {}}
            onSelect={(id) => ui.select(id)}
            onOpen={(id) => ui.go({ name: 'review', pr: id })}
            row={(id) => (
              <PrRow
                id={id}
                sel={ui.selected === id}
                picked={false}
                props={display.props}
              />
            )}
            empty={
              <Empty
                icon={<CodePullRequest />}
                title="No pull requests"
                text="Pull requests of this project show up here once they're open."
              />
            }
          />
        )}
      </div>
    </div>
  );
});

const ProjectBranches = observer(function ProjectBranches({
  project,
}: {
  project: Project;
}) {
  const store = useRootStore();
  const [branches, setBranches] = useState<LocalBranch[] | 'unready' | null>(
    null,
  );
  const [opening, setOpening] = useState<string | null>(null);

  const load = () => {
    setBranches(null);
    void api
      .listBranches(project.id)
      .then(setBranches)
      .catch(() => setBranches('unready'));
  };
  useEffect(load, [project.id]);

  const open = (branch: LocalBranch) => {
    setOpening(branch.name);
    void openBranchAction(store, {
      project: project.id,
      branch: branch.name,
      base: null,
    }).finally(() => setOpening(null));
  };

  if (branches === null) return <RowsSkeleton />;
  if (branches === 'unready') {
    return (
      <Empty
        icon={<BranchesRight />}
        title="Can't list branches yet"
        text="This command isn't available from the core yet."
      />
    );
  }
  if (branches.length === 0) {
    return (
      <Empty
        icon={<BranchesRight />}
        title="No branches"
        text="Branches of this project show up here."
      />
    );
  }
  return (
    <Table className="m-4">
      <Table.ScrollContainer>
        <Table.Content aria-label="Branches">
          <Table.Header>
            <Table.Column isRowHeader>branch</Table.Column>
            <Table.Column>last commit</Table.Column>
            <Table.Column>ahead / behind</Table.Column>
            <Table.Column>updated</Table.Column>
          </Table.Header>
          <Table.Body>
            {branches.map((b) => (
              <Table.Row
                key={b.name}
                id={b.name}
                onAction={() => open(b)}
                className="cursor-pointer"
              >
                <Table.Cell className="font-mono text-sm">
                  <span className="inline-flex items-center gap-1.5">
                    <BranchesRight className="size-3.5 text-muted" />
                    {b.name}
                    {opening === b.name && <Spinner />}
                  </span>
                </Table.Cell>
                <Table.Cell className="truncate text-xs text-muted">
                  {b.subject}
                </Table.Cell>
                <Table.Cell className="text-xs tabular-nums text-muted">
                  +{b.ahead} / -{b.behind}
                </Table.Cell>
                <Table.Cell className="text-xs text-muted">
                  {ago(b.updated_at)}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
});

type ProjectTab = 'prs' | 'branches';

export const ProjectView = observer(function ProjectView({
  id,
}: {
  id: string;
}) {
  const store = useRootStore();
  const [tab, setTab] = useState<ProjectTab>('prs');
  const [refreshing, setRefreshing] = useState(false);
  const project = store.models.projects.get(id);

  const refresh = () => {
    setRefreshing(true);
    void refreshProject(store, id).finally(() => setRefreshing(false));
  };

  if (!project) {
    return (
      <div className="view relative flex min-w-0 flex-1 flex-col">
        <ViewHeader title="Project" />
        <RowsSkeleton />
      </div>
    );
  }

  return (
    <div className="view relative flex min-w-0 flex-1 flex-col">
      <ViewHeader title={projectLabel(project)}>
        <ProjectStatusDot p={project} />
        {project.status === 'error' && (
          <span className="text-xs text-danger">
            {project.error ?? 'Failed to clone'}
          </span>
        )}
        <Tooltip>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label="Refresh"
            isPending={refreshing}
            onPress={refresh}
          >
            <ArrowRotateLeft className="size-4" />
          </Button>
          <Tooltip.Content>Refresh project</Tooltip.Content>
        </Tooltip>
      </ViewHeader>
      <Tabs
        selectedKey={tab}
        onSelectionChange={(k) => setTab(k as ProjectTab)}
        className="border-b border-separator px-6"
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label="Project sections">
            <Tabs.Tab id="prs" className="gap-1.5">
              <CodePullRequest className="size-4" />
              Pull requests
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="branches" className="gap-1.5">
              <BranchesRight className="size-4" />
              Branches
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs>
      <div className="flex min-h-0 flex-1">
        {tab === 'prs' ? (
          <ProjectPrs project={project} />
        ) : (
          <ProjectBranches project={project} />
        )}
      </div>
      <Hints>
        <K>J</K>
        <K>K</K> navigate <K>⏎</K> open <K>⌘K</K> everything
      </Hints>
    </div>
  );
});
