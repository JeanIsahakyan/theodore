/**
 * Projects: connected repositories (GitHub/GitLab/local folders).
 * `ProjectPicker` is the search + multi-select repo list (grouped by
 * owner/org) plus a one-shot local folder add, shared by the sidebar's Add
 * project dialog and onboarding's Projects step.
 */
import { useEffect, useState } from 'react';
import {
  Check,
  CodePullRequest,
  FolderPlus,
  Lock,
  Magnifier,
} from '@gravity-ui/icons';
import {
  Button,
  Checkbox,
  CheckboxGroup,
  Chip,
  ScrollShadow,
  SearchField,
  Separator,
  Tooltip,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { HostRepo, Project, RepoRef } from '../gen/contract';
import { addProject, pickFolder } from '../actions';
import { api } from '../core/api';
import { useRootStore, useUi } from '../stores/context';
import { Avatar, Empty, Shell, Spinner } from './bits';
import type { ContextMenuItem } from './ContextMenu';
import { ago, type InboxPr } from './List';
import { RowsSkeleton } from './Loading';

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
