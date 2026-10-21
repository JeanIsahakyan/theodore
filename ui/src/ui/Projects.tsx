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
  ArrowUpRightFromSquare,
  BranchesRight,
  Check,
  ChartColumn,
  Clock,
  CodeMerge,
  CodePullRequest,
  CodePullRequestXmark,
  FolderPlus,
  LayoutColumns,
  LayoutList,
  Lock,
  Magnifier,
  Sliders,
  Xmark,
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
  Tabs,
  Tag,
  TagGroup,
  ToggleButton,
  ToggleButtonGroup,
  Toolbar,
  Tooltip,
  Typography,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type {
  HostRepo,
  LocalBranch,
  PrState,
  Project,
  ProjectWorkingState,
  RepoRef,
} from '../gen/contract';
import {
  addProject,
  openBranch as openBranchAction,
  pickFolder,
} from '../actions';
import { api } from '../core/api';
import { useRootStore, useUi } from '../stores/context';
import { Avatar, CheckIcon, Empty, Hints, K, Shell, Spinner } from './bits';
import { useContextMenu, type ContextMenuItem } from './ContextMenu';
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
import { Peek } from './Peek';
import { projectActivity } from './project/activity';
import { branchPr } from './project/branches';
import { branchReviewMenu, closeBranchReview } from './project/closeReview';
import {
  needsAutoRefresh,
  refreshProjectTracked,
  refreshingProjects,
  staleFetchedLabel,
} from './project/freshness';
import {
  hasPullRequests,
  isLocalFolder,
  projectTabs,
  workingStateParts,
  type ProjectTab,
} from './project/layout';
import { noOpenPrsBanner, projectStats } from './project/stats';
import {
  failingChecksCount,
  mergesPerWeek,
  oldestOpenPrAge,
  topAuthors,
} from './project/summary';
import {
  isBranchReview,
  projectPrSections,
  type ProjectPrSort,
} from './project/sections';
import { PRIcon, prStatusLabel } from './StatusIcon';
import { latinKey, useViewKeys } from './keys';

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
export function filterHostRepos(repos: HostRepo[], query: string): HostRepo[] {
  const q = query.trim().toLowerCase();
  if (!q) return repos;
  return repos.filter((r) =>
    `${r.repo.owner}/${r.repo.name}`.toLowerCase().includes(q),
  );
}

export interface ProjectDisplay {
  layout: 'list' | 'board';
  sort: ProjectPrSort;
  props: RowProp[];
}

// A function, not a constant: List.tsx and Projects.tsx import each other
// (through Modals), so ROW_PROPS isn't initialised yet at module load.
export const defaultProjectDisplay = (): ProjectDisplay => ({
  layout: 'list',
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

/** The external host URL for a repo project — `null` for a local folder,
 *  which has no host to link to. */
export function hostRepoUrl(repo: RepoRef): string | null {
  switch (repo.host) {
    case 'github':
      return `https://github.com/${repo.owner}/${repo.name}`;
    case 'gitlab':
      return `https://gitlab.com/${repo.owner}/${repo.name}`;
    case 'bitbucket':
      return `https://bitbucket.org/${repo.owner}/${repo.name}`;
    case 'local':
      return null;
  }
}

/** Board columns: always by status, regardless of the list's sections. */
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
  repos: HostRepo[],
): { owner: string; repos: HostRepo[] }[] {
  // Most recently pushed first, inside an owner and across owners: the
  // repos someone works in now, not ones last touched years ago.
  const pushed = (r: HostRepo) => r.pushed_at ?? 0;
  const byOwner = new Map<string, HostRepo[]>();
  for (const r of repos) {
    const list = byOwner.get(r.repo.owner) ?? [];
    list.push(r);
    byOwner.set(r.repo.owner, list);
  }
  return [...byOwner.entries()]
    .map(([owner, list]) => ({
      owner,
      repos: [...list].sort((a, b) => pushed(b) - pushed(a)),
    }))
    .sort((a, b) => pushed(b.repos[0]!) - pushed(a.repos[0]!));
}

/** PRs the signed-in user is already involved in, in this repo — the
 *  "N PRs with you" chip. */
export function prsWithYou(items: InboxPr[], repo: RepoRef): number {
  return items.filter((p) => sameRepo(p.pr.repo, repo)).length;
}

/** GitHub serves an owner/org's avatar at this fixed URL — no such
 *  convention for other hosts. `null` in sandbox mode: a sandbox window
 *  makes no network requests. */
export function ownerAvatarUrl(
  host: string,
  owner: string,
  sandbox: boolean,
): string | null {
  return host === 'github' && !sandbox
    ? `https://github.com/${owner}.png`
    : null;
}

/** One repo row in the picker: a disabled "Added" row for repos that are
 *  already a project, otherwise a checkbox — description, visibility and
 *  last push come straight off `HostRepo`. */
function RepoRow({
  r,
  already,
  prCount,
}: {
  r: HostRepo;
  already: boolean;
  prCount: number;
}) {
  const sub = [
    r.description,
    r.pushed_at != null ? `pushed ${ago(r.pushed_at)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const body = (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
        <span className="min-w-0 truncate">{r.repo.name}</span>
        {r.private && <Lock className="size-3.5 shrink-0 text-muted" />}
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
      value={repoKey(r.repo)}
      // `.checkbox-group` puts mt-4 on every checkbox; rows here are spaced
      // by the list, like the non-checkbox "Added" rows.
      className="mt-0 rounded-2xl px-3 py-2 hover:bg-default/50"
    >
      <Checkbox.Content className="w-full">
        <Checkbox.Control>
          <Checkbox.Indicator />
        </Checkbox.Control>
        {body}
        {prCount > 0 && (
          <Chip size="sm" variant="soft" color="accent" className="shrink-0">
            {prCount} {prCount === 1 ? 'PR' : 'PRs'} with you
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
  const [repos, setRepos] = useState<HostRepo[] | 'unready' | null>(null);
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
      .then((path) => (path ? addProject(store, { repo: null, path }) : null))
      .then((p) => p && onAdded?.(p))
      .finally(() => setAddingFolder(false));
  };

  const addPicked = async () => {
    setAddingPicked(true);
    for (const r of shown.filter((r) => picked.includes(repoKey(r.repo)))) {
      const p = await addProject(store, { repo: r.repo, path: null });
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
                        avatar_url: ownerAvatarUrl(
                          group[0]!.repo.host,
                          owner,
                          store.ephemeral.sandbox !== null,
                        ),
                      }}
                      size={16}
                    />
                    {owner}
                  </div>
                  {group.map((r) => (
                    <RepoRow
                      key={repoKey(r.repo)}
                      r={r}
                      already={addedKeys.has(repoKey(r.repo))}
                      prCount={prsWithYou(prItems, r.repo)}
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
          {picked.length
            ? `Add ${picked.length} project${picked.length === 1 ? '' : 's'}`
            : 'Add projects'}
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
  items,
}: {
  items: InboxPr[];
}) {
  const store = useRootStore();
  const ui = useUi();
  const viewerLogin = store.ephemeral.viewer?.login ?? null;
  const [display, setDisplayState] = useState<ProjectDisplay>(
    defaultProjectDisplay(),
  );
  const setDisplay = (patch: Partial<ProjectDisplay>) =>
    setDisplayState((d) => ({ ...d, ...patch }));

  const sections = projectPrSections(items, viewerLogin, display.sort);
  const groups = sections.filter((g) => g.items.length);
  const [closed, setClosed] = useState<Record<string, boolean>>(() => {
    const seed: Record<string, boolean> = {};
    for (const g of sections) if (g.collapsedByDefault) seed[g.id] = true;
    return seed;
  });
  const banner = noOpenPrsBanner(items);
  const branchReviewIds = new Set(
    items.filter(isBranchReview).map((p) => p.id),
  );
  const order =
    display.layout === 'board'
      ? boardColumns(items, display.sort).flatMap((c) =>
          c.items.map((p) => p.id),
        )
      : groups.flatMap((g) => (closed[g.id] ? [] : g.items.map((p) => p.id)));

  useViewKeys(
    ui,
    (e) => {
      const i = ui.selected ? order.indexOf(ui.selected) : -1;
      const move = (d: number) => {
        const next = order[Math.max(0, Math.min(order.length - 1, i + d))];
        if (next) ui.select(next);
      };
      switch (latinKey(e)) {
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
      {banner && (
        <div className="mx-6 my-2 flex shrink-0 items-center gap-2 rounded-xl bg-default/60 px-3 py-2 text-xs text-muted">
          <Clock className="size-3.5" />
          No open PRs · last merge {ago(banner.mergedAt)} ago (#{banner.number})
        </div>
      )}
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
            closed={closed}
            toggle={(id) => setClosed((c) => ({ ...c, [id]: !c[id] }))}
            onSelect={(id) => ui.select(id)}
            onOpen={(id) => ui.go({ name: 'review', pr: id })}
            row={(id) =>
              branchReviewIds.has(id) ? (
                <BranchReviewRow id={id} sel={ui.selected === id} />
              ) : (
                <PrRow
                  id={id}
                  sel={ui.selected === id}
                  picked={false}
                  props={display.props}
                />
              )
            }
            empty={
              <Empty
                icon={<CodePullRequest />}
                title="No pull requests"
                text="Pull requests of this project show up here once they're open."
              />
            }
          />
        )}
        {ui.peek &&
          (ui.selected
            ? items.some((p) => p.id === ui.selected) && (
                <Peek id={ui.selected} context="project" />
              )
            : // Merges, authors, checks: all zero without host PRs.
              hasPullRequests(items) && (
                <RepoSummaryPeek items={items} now={Date.now()} />
              ))}
      </div>
    </div>
  );
});

/** A branch review in the project list: not a host PR, so none of
 *  `PrRow`'s inbox actions (done, snooze, copy URL) — just the branch, its
 *  last commit, and a Close review × on hover / in the context menu. */
const BranchReviewRow = observer(function BranchReviewRow({
  id,
  sel,
}: {
  id: string;
  sel: boolean;
}) {
  const store = useRootStore();
  const p = store.models.prSummaries.get(id);
  const menu = useContextMenu(() => branchReviewMenu(store, id));
  if (!p) return null;
  return (
    <div
      id={`R-${id}`}
      className={`prrow group flex h-11 w-full min-w-0 items-center gap-3 ${sel ? 'sel' : ''}`}
      onContextMenu={menu}
    >
      <BranchesRight className="size-4 shrink-0 text-muted" />
      <span
        className="min-w-0 max-w-[45%] truncate font-mono text-sm"
        title={p.head_ref}
      >
        {p.head_ref}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-muted">
        {p.title}
      </span>
      <span className="shrink-0 text-xs text-muted">
        vs {p.base_ref} · {ago(p.updated_at)}
      </span>
      <Tooltip>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label="Close review"
          className="size-6 min-w-6 shrink-0 rounded-xl text-muted opacity-0 group-hover:opacity-100"
          onPress={() => void closeBranchReview(store, id)}
        >
          <Xmark className="size-3.5" />
        </Button>
        <Tooltip.Content>Close review</Tooltip.Content>
      </Tooltip>
    </div>
  );
});

/** Repo-summary peek (plan "the projects page isn't very informative"):
 *  shown instead of the usual per-PR `Peek` when nothing is selected —
 *  merges per week, top authors, failing checks, oldest open PR. */
function RepoSummaryPeek({ items, now }: { items: InboxPr[]; now: number }) {
  const weeks = mergesPerWeek(items, now);
  const maxWeek = Math.max(1, ...weeks);
  const authors = topAuthors(items);
  const failing = failingChecksCount(items);
  const oldest = oldestOpenPrAge(items, now);

  return (
    <Surface className="peek flex w-[clamp(280px,32vw,384px)] shrink-0 flex-col gap-5 overflow-auto rounded-none border-l border-separator p-6 pb-20">
      <header className="flex flex-col gap-1">
        <Typography.Heading level={5}>Repo summary</Typography.Heading>
        <span className="text-xs text-muted">
          From the pull requests loaded for this project.
        </span>
      </header>

      <section className="flex flex-col gap-2">
        <Label className="text-xs font-medium text-muted">
          Merges per week
        </Label>
        <div className="flex h-16 items-end gap-2">
          {weeks.map((n, i) => (
            <div key={i} className="flex flex-1 flex-col items-center gap-1">
              <div
                className="w-full rounded-t bg-accent/70"
                style={{ height: `${Math.max(4, (n / maxWeek) * 48)}px` }}
              />
              <span className="text-[10px] tabular-nums text-muted">{n}</span>
            </div>
          ))}
        </div>
      </section>

      <Separator />

      <section className="flex flex-col gap-2">
        <Label className="text-xs font-medium text-muted">Top authors</Label>
        {authors.length === 0 ? (
          <span className="text-xs text-muted">No authors yet.</span>
        ) : (
          <ul className="flex flex-col gap-2">
            {authors.map((a) => (
              <li key={a.login} className="flex items-center gap-2 text-sm">
                <Avatar
                  person={{ login: a.login, name: null, avatar_url: null }}
                  size={18}
                />
                <span className="min-w-0 flex-1 truncate">{a.login}</span>
                <span className="tabular-nums text-xs text-muted">
                  {a.count}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Separator />
      <dl className="grid grid-cols-[1fr_auto] items-center gap-y-2 text-sm [&>dt]:text-muted">
        <dt>Failing checks</dt>
        <dd className={failing > 0 ? 'text-danger' : ''}>{failing}</dd>
        <dt>Oldest open PR</dt>
        <dd>
          {oldest ? `#${oldest.number} · ${ago(now - oldest.ageMs)}` : '—'}
        </dd>
      </dl>
    </Surface>
  );
}

const ProjectBranches = observer(function ProjectBranches({
  project,
  items,
  checkedOut,
}: {
  project: Project;
  items: InboxPr[];
  /** A local folder's checked-out branch. */
  checkedOut: string | null;
}) {
  const store = useRootStore();
  const ui = useUi();
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
  // A fixed grid, not a table: columns keep their width at any window size
  // and the commit column takes what's left (and truncates).
  const cols =
    'grid grid-cols-[minmax(200px,2fr)_minmax(0,3fr)_88px_56px_124px] items-center gap-3';
  return (
    <div className="branches flex min-h-0 min-w-0 flex-1 flex-col overflow-auto px-6 pb-20">
      <div
        className={`${cols} sticky top-0 z-[1] border-b border-separator bg-background py-2 text-xs text-muted`}
      >
        <span>branch</span>
        <span>last commit</span>
        <span className="whitespace-nowrap text-right">ahead / behind</span>
        <span>PR</span>
        <span />
      </div>
      {branches.map((b) => {
        const match = branchPr(b.name, project.repo, items);
        return (
          <div
            key={b.name}
            className={`${cols} border-b border-separator py-2.5 last:border-b-0`}
          >
            <span
              className="flex min-w-0 items-center gap-1.5 font-mono text-sm"
              title={b.name}
            >
              <BranchesRight className="size-3.5 shrink-0 text-muted" />
              <span className="truncate">{b.name}</span>
              {b.name === checkedOut && (
                <Chip
                  size="sm"
                  variant="soft"
                  color="accent"
                  className="shrink-0"
                >
                  checked out
                </Chip>
              )}
              {b.name === project.default_branch && (
                <Chip size="sm" variant="soft" className="shrink-0">
                  default
                </Chip>
              )}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm" title={b.subject}>
                {b.subject}
              </span>
              <span className="truncate text-xs text-muted">
                {b.author || 'unknown'} · {ago(b.updated_at)}
              </span>
            </span>
            <span className="whitespace-nowrap text-right text-xs tabular-nums text-muted">
              +{b.ahead} / −{b.behind}
            </span>
            <span className="text-xs">
              {match ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 font-mono text-xs"
                  onPress={() => ui.go({ name: 'review', pr: match.id })}
                >
                  #{match.pr.number}
                </Button>
              ) : (
                <span className="text-muted">—</span>
              )}
            </span>
            <span className="flex justify-end">
              <Button
                size="sm"
                variant="tertiary"
                isPending={opening === b.name}
                onPress={() => open(b)}
              >
                Review branch
              </Button>
            </span>
          </div>
        );
      })}
    </div>
  );
});

export const ProjectView = observer(function ProjectView({
  id,
}: {
  id: string;
}) {
  const store = useRootStore();
  const [tab, setTab] = useState<ProjectTab | null>(null);
  const [working, setWorking] = useState<ProjectWorkingState | null>(null);
  const refreshing = refreshingProjects.has(id);
  const project = store.models.projects.get(id);
  const items = project
    ? store.models.prSummaries.where((p) => sameRepo(p.pr.repo, project.repo))
    : [];
  const local = !!project && isLocalFolder(project);
  const ready = project?.status === 'ready';

  // Re-read after every refresh too: a refresh is when the user expects
  // the folder's state to be current.
  useEffect(() => {
    if (!local || !ready) return;
    let live = true;
    void api.projectWorkingState(id).then((s) => live && setWorking(s));
    return () => {
      live = false;
    };
  }, [id, local, ready, project?.last_fetched_at]);

  const refresh = () => void refreshProjectTracked(store, id);

  // Opening a page that's more than a few minutes old refreshes it.
  useEffect(() => {
    if (ready && needsAutoRefresh(project?.last_fetched_at, Date.now())) {
      refresh();
    }
    // Once per page open, not on every `last_fetched_at` change the refresh
    // itself causes. A page opened mid-clone is left alone: the core
    // refreshes a project itself as soon as its clone is ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!project) {
    return (
      <div className="view relative flex min-w-0 flex-1 flex-col">
        <ViewHeader title="Project" />
        <RowsSkeleton />
      </div>
    );
  }

  const ghUrl = hostRepoUrl(project.repo);
  const viewerLogin = store.ephemeral.viewer?.login ?? null;
  const stats = projectStats(items, viewerLogin, Date.now());
  const tabs = projectTabs(local, items);
  const shown = tab && tabs.includes(tab) ? tab : tabs[0]!;
  const meta = [
    // A local folder's branches go on the working-state line below.
    local ? null : project.default_branch,
    staleFetchedLabel(project.last_fetched_at, Date.now()),
  ].filter((s): s is string => !!s);
  const workingLine = local
    ? workingStateParts(working, project.default_branch)
    : [];

  return (
    <div className="view relative flex min-w-0 flex-1 flex-col">
      <div className="flex h-14 w-full min-w-0 shrink-0 items-center gap-3 px-6">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <Typography.Heading
            level={6}
            className="shrink-0 truncate"
            title={projectLabel(project)}
          >
            {projectLabel(project)}
          </Typography.Heading>
          <ProjectStatusDot p={project} />
          {project.private && (
            <Tooltip>
              <Tooltip.Trigger>
                <Lock className="size-3.5 shrink-0 text-muted" />
              </Tooltip.Trigger>
              <Tooltip.Content>Private repository</Tooltip.Content>
            </Tooltip>
          )}
          {meta.length > 0 && (
            <span className="min-w-0 truncate text-xs text-muted">
              {meta.join(' · ')}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {project.status === 'error' && (
            <span className="text-xs text-danger">
              {project.error ?? 'Failed to clone'}
            </span>
          )}
          {ghUrl && (
            <Button
              size="sm"
              variant="tertiary"
              className="gap-1.5"
              onPress={() => window.open(ghUrl, '_blank')}
            >
              <ArrowUpRightFromSquare className="size-4" />
              GitHub
            </Button>
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
              {refreshing ? (
                <Spinner />
              ) : (
                <ArrowRotateLeft className="size-4" />
              )}
            </Button>
            <Tooltip.Content>Refresh project</Tooltip.Content>
          </Tooltip>
        </div>
      </div>
      {project.description && (
        <p
          className="truncate px-6 pb-1 text-xs text-muted"
          title={project.description}
        >
          {project.description}
        </p>
      )}
      {local && (
        <p className="flex min-w-0 items-center gap-1.5 px-6 pb-1 text-xs text-muted">
          <span
            className="min-w-0 shrink truncate font-mono"
            title={project.path ?? undefined}
          >
            {project.path}
          </span>
          {workingLine.map((part) => (
            <span key={part} className="shrink-0 whitespace-nowrap">
              · {part}
            </span>
          ))}
        </p>
      )}
      {!local && (
        <div className="flex shrink-0 gap-2 px-6 py-3">
          <StatCard label="Open" value={stats.open} />
          <StatCard label="Needs your review" value={stats.needsReview} />
          <StatCard label="Yours" value={stats.yours} />
          <StatCard
            label="Failing checks"
            value={stats.failingChecks}
            danger={stats.failingChecks > 0}
          />
          <StatCard label="Merged 7d" value={stats.merged7d} />
        </div>
      )}
      <Tabs
        selectedKey={shown}
        onSelectionChange={(k) => setTab(k as ProjectTab)}
        className="px-6 pb-3 pt-2"
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label="Project sections">
            {tabs.map((t) => (
              <Tabs.Tab key={t} id={t} className="gap-1.5">
                {t === 'prs' ? (
                  <CodePullRequest className="size-4" />
                ) : t === 'branches' ? (
                  <BranchesRight className="size-4" />
                ) : (
                  <ChartColumn className="size-4" />
                )}
                {t === 'prs'
                  ? local
                    ? 'Branch reviews'
                    : 'Pull requests'
                  : t === 'branches'
                    ? 'Branches'
                    : 'Activity'}
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs>
      <div className="flex min-h-0 flex-1">
        {shown === 'prs' ? (
          <ProjectPrs items={items} />
        ) : shown === 'branches' ? (
          <ProjectBranches
            project={project}
            items={items}
            checkedOut={working?.current_branch ?? null}
          />
        ) : (
          <ActivityTab items={items} />
        )}
      </div>
      <Hints>
        <K>J</K>
        <K>K</K> navigate <K>⏎</K> open <K>⌘K</K> everything
      </Hints>
    </div>
  );
});

/** One stat card under the project header. */
function StatCard({
  label,
  value,
  danger,
}: {
  label: string;
  value: number;
  danger?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-2xl bg-default/60 px-3 py-2">
      <span className="truncate text-xs text-muted">{label}</span>
      <span
        className={`text-lg font-semibold tabular-nums ${danger ? 'text-danger' : ''}`}
      >
        {value}
      </span>
    </div>
  );
}

const ACTIVITY_LABEL: Record<'opened' | 'merged' | 'closed', string> = {
  opened: 'opened',
  merged: 'merged',
  closed: 'closed',
};

function ActivityIcon({ kind }: { kind: 'opened' | 'merged' | 'closed' }) {
  if (kind === 'merged') return <CodeMerge className="size-4 text-accent" />;
  if (kind === 'closed') {
    return <CodePullRequestXmark className="size-4 text-muted" />;
  }
  return <CodePullRequest className="size-4 text-success" />;
}

/** Activity tab: a reverse-chronological feed derived from the PR rows this
 *  project has loaded — see `project/activity.ts` for exactly what that
 *  does and doesn't mean. */
function ActivityTab({ items }: { items: InboxPr[] }) {
  const ui = useUi();
  const events = projectActivity(items);
  if (!events.length) {
    return (
      <Empty
        icon={<ChartColumn />}
        title="No activity yet"
        text="PR activity for this project shows up here."
      />
    );
  }
  return (
    <ul className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-auto p-3">
      {events.map((e) => (
        <li key={e.id}>
          <button
            type="button"
            className="flex w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-default/50"
            onClick={() => ui.go({ name: 'review', pr: e.id })}
          >
            <ActivityIcon kind={e.kind} />
            <Avatar person={e.pr.author} size={18} />
            <span className="min-w-0 flex-1 truncate text-sm">
              <b className="font-medium">{e.pr.author.login}</b>{' '}
              {ACTIVITY_LABEL[e.kind]}{' '}
              <span className="text-muted">#{e.pr.pr.number}</span> {e.pr.title}
            </span>
            <span className="shrink-0 text-xs text-muted">{ago(e.at)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
