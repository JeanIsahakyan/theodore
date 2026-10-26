/**
 * Branches: the active project's branches — ahead / behind its default,
 * the PR each one belongs to, "Review branch". A local folder also shows
 * its working state: which branch is checked out, how many files are
 * uncommitted. Only under a single project; a local folder opens here.
 */
import { useEffect, useState } from 'react';
import { BranchesRight } from '@gravity-ui/icons';
import { Button, Chip } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type {
  LocalBranch,
  Project,
  ProjectWorkingState,
} from '../gen/contract';
import { openBranch } from '../actions';
import { api } from '../core/api';
import { useRootStore, useUi } from '../stores/context';
import { Empty, Hints, K } from './bits';
import { ViewHeader, ago } from './List';
import { RowsSkeleton } from './Loading';
import { branchPr } from './project/branches';
import { staleFetchedLabel, useProjectAutoRefresh } from './project/freshness';
import { isLocalFolder, workingStateParts } from './project/layout';
import { isBranchReview } from './project/sections';
import { sameRepo } from './Projects';
import { BranchReviewRow } from './PullRequests';
import { isSpaceReview } from './space/spaces';

// A fixed grid, not a table: columns keep their width at any window size
// and the commit column takes what's left (and truncates).
const COLS =
  'grid grid-cols-[minmax(160px,2fr)_minmax(0,3fr)_104px_56px_112px] items-center gap-3';
// A local folder has no host PRs: no PR column.
const COLS_LOCAL =
  'grid grid-cols-[minmax(160px,2fr)_minmax(0,3fr)_104px_112px] items-center gap-3';

const BranchList = observer(function BranchList({
  project,
  working,
}: {
  project: Project;
  working: ProjectWorkingState | null;
}) {
  const store = useRootStore();
  const ui = useUi();
  const [branches, setBranches] = useState<LocalBranch[] | 'unready' | null>(
    null,
  );
  const [opening, setOpening] = useState<string | null>(null);
  const items = store.models.prSummaries.where((p) =>
    sameRepo(p.pr.repo, project.repo),
  );
  // A space's review lives on its space page, not here.
  const reviews = items
    .filter((p) => isBranchReview(p) && !isSpaceReview(p))
    .sort((a, b) => b.updated_at - a.updated_at);
  const checkedOut = working?.current_branch ?? null;
  const dirty = working?.dirty_files ?? 0;
  const hasPrs = !isLocalFolder(project);
  const cols = hasPrs ? COLS : COLS_LOCAL;

  useEffect(() => {
    let live = true;
    void api
      .listBranches(project.id)
      .then((b) => live && setBranches(b))
      .catch(() => live && setBranches('unready'));
    return () => {
      live = false;
    };
  }, [project.id, project.last_fetched_at]);

  const review = (branch: LocalBranch) => {
    setOpening(branch.name);
    void openBranch(store, {
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
        text="This project's branches aren't available from the core yet."
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
    <div className="branches flex min-h-0 min-w-0 flex-1 flex-col overflow-auto pb-20">
      {reviews.length > 0 && (
        // Reviews of a branch with no host PR: the only list of them a local
        // folder has (it has no Pull requests page).
        <section aria-label="Branch reviews" className="flex flex-col pb-4">
          <h3 className="flex items-center gap-2 border-b border-separator px-6 py-2 text-xs text-muted">
            Branch reviews
            <span className="tabular-nums">{reviews.length}</span>
          </h3>
          {reviews.map((p) => (
            <div
              key={p.id}
              role="link"
              tabIndex={0}
              className="cursor-default border-b border-separator px-6 hover:bg-default/40"
              onClick={() => ui.go({ name: 'review', pr: p.id })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') ui.go({ name: 'review', pr: p.id });
              }}
            >
              <BranchReviewRow id={p.id} sel={false} />
            </div>
          ))}
        </section>
      )}
      <div
        className={`${cols} sticky top-0 z-[1] border-b border-separator bg-surface px-6 py-2 text-xs text-muted`}
      >
        <span>branch</span>
        <span>last commit</span>
        <span className="whitespace-nowrap pe-4 text-right">
          ahead / behind
        </span>
        {hasPrs && <span>PR</span>}
        <span />
      </div>
      {branches.map((b) => {
        const match = branchPr(b.name, project.repo, items);
        const here = b.name === checkedOut;
        // The default branch, or one with no commits of its own, has
        // nothing to review against the default branch.
        const reviewable = b.name !== project.default_branch && b.ahead > 0;
        return (
          <div
            key={b.name}
            className={`${cols} border-b border-separator px-6 py-2.5 last:border-b-0`}
          >
            <span
              className="flex min-w-0 items-center gap-1.5 font-mono text-sm"
              title={b.name}
            >
              <BranchesRight className="size-3.5 shrink-0 text-muted" />
              <span className="truncate">{b.name}</span>
              {here && (
                <Chip
                  size="sm"
                  variant="soft"
                  color="accent"
                  className="shrink-0"
                >
                  checked out
                </Chip>
              )}
              {here && dirty > 0 && (
                <Chip
                  size="sm"
                  variant="soft"
                  color="warning"
                  className="shrink-0"
                  aria-label={`${dirty} uncommitted`}
                >
                  {dirty} dirty
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
            <span className="whitespace-nowrap pe-4 text-right text-xs tabular-nums text-muted">
              +{b.ahead} / −{b.behind}
            </span>
            {hasPrs && (
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
            )}
            <span className="flex justify-end">
              {reviewable && (
                <Button
                  size="sm"
                  variant="tertiary"
                  className="whitespace-nowrap"
                  isPending={opening === b.name}
                  onPress={() => review(b)}
                >
                  Review branch
                </Button>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
});

export const Branches = observer(function Branches() {
  const store = useRootStore();
  const project = store.workspaces.active;
  const [working, setWorking] = useState<ProjectWorkingState | null>(null);
  const local = !!project && isLocalFolder(project);
  const ready = project?.status === 'ready';
  useProjectAutoRefresh(project);

  // Re-read after every refresh too: a refresh is when the user expects
  // the folder's state to be current.
  const id = project?.id;
  const fetchedAt = project?.last_fetched_at;
  useEffect(() => {
    if (!id || !local || !ready) return;
    let live = true;
    void api
      .projectWorkingState(id)
      .then((s) => live && setWorking(s))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id, local, ready, fetchedAt]);

  if (!project) {
    return (
      <div className="view relative flex min-w-0 flex-1 flex-col">
        <ViewHeader title="Branches" />
        <Empty
          icon={<BranchesRight />}
          title="Pick a project"
          text="Branches belong to one project: switch to it in the top-left corner."
        />
      </div>
    );
  }

  // The default branch already carries a "default" chip in the list; this
  // line is only for what the list can't say (a folder's path and working
  // state, a stale fetch).
  const meta = [
    ...(local ? workingStateParts(working, project.default_branch) : []),
    staleFetchedLabel(project.last_fetched_at, Date.now()),
  ].filter((s): s is string => !!s);

  return (
    <div className="view relative flex min-w-0 flex-1 flex-col">
      <ViewHeader title="Branches">
        {project.status === 'error' && (
          <span
            className="max-w-[220px] truncate text-xs text-danger"
            title={project.error ?? undefined}
          >
            {project.error ?? 'Failed to clone'}
          </span>
        )}
      </ViewHeader>
      {(local || meta.length > 0) && (
        // Every part may shrink (with an ellipsis) so a long path or branch
        // name never pushes the line past the window.
        <p className="flex min-w-0 shrink-0 items-center gap-1.5 overflow-hidden border-b border-separator px-6 py-2 text-xs text-muted">
          {local && (
            <span
              className="min-w-0 truncate font-mono"
              title={project.path ?? undefined}
            >
              {project.path}
            </span>
          )}
          {meta.map((part, i) => (
            <span
              key={part}
              className="min-w-0 truncate whitespace-nowrap"
              title={part}
            >
              {local || i > 0 ? '· ' : ''}
              {part}
            </span>
          ))}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        {project.status === 'cloning' ? (
          <RowsSkeleton />
        ) : (
          <BranchList key={project.id} project={project} working={working} />
        )}
      </div>
      <Hints>
        <K>⌘K</K> everything
      </Hints>
    </div>
  );
});
