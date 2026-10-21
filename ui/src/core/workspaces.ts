/**
 * Workspaces: "All projects" or one project. Pure rules for which rows a
 * workspace shows, where a route opens, switcher order, badges and keys —
 * the stores and the sidebar call into these.
 */
import type {
  InboxState,
  PrId,
  PrState,
  Project,
  RepoRef,
} from '../gen/contract';
import type { Route } from '../stores/UiStore';

/** The "All projects" workspace id; every other id is a `Project::id`. */
export const ALL = 'all';
export type WorkspaceId = string;

export type WorkspaceKind = 'all' | 'repo' | 'local';

export function sameRepo(a: RepoRef, b: RepoRef): boolean {
  return a.host === b.host && a.owner === b.owner && a.name === b.name;
}

/** The repo inside a PR id (`github:owner/name#12`) — for rows whose PR
 *  summary isn't loaded. Owners may contain `/` (GitLab groups). */
export function repoOfPrId(id: PrId): RepoRef | null {
  const m = /^([a-z]+):(.+)#\d+$/.exec(id);
  if (!m) return null;
  const slug = m[2]!;
  const cut = slug.lastIndexOf('/');
  if (cut <= 0 || cut === slug.length - 1) return null;
  return {
    host: m[1] as RepoRef['host'],
    owner: slug.slice(0, cut),
    name: slug.slice(cut + 1),
  };
}

export function ownerOf(
  projects: Project[],
  repo: RepoRef | null,
): Project | undefined {
  return repo ? projects.find((p) => sameRepo(p.repo, repo)) : undefined;
}

export function kindOf(ws: WorkspaceId, projects: Project[]): WorkspaceKind {
  if (ws === ALL) return 'all';
  const p = projects.find((x) => x.id === ws);
  return p?.repo.host === 'local' ? 'local' : 'repo';
}

/** Whether a row of `repo` shows in `ws`. All shows everything; a project
 *  shows its own repo only, so PRs from repos nobody added show under All. */
export function inWorkspace(
  ws: WorkspaceId,
  repo: RepoRef | null,
  projects: Project[],
): boolean {
  if (ws === ALL) return true;
  const p = projects.find((x) => x.id === ws);
  return !!p && !!repo && sameRepo(p.repo, repo);
}

/** Projects in switcher order: ids in `order` first, as stored, then any
 *  newer ones by when they were added. */
export function orderProjects(projects: Project[], order: string[]): Project[] {
  const at = new Map(order.map((id, i) => [id, i]));
  return [...projects].sort((a, b) => {
    const ia = at.get(a.id) ?? Infinity;
    const ib = at.get(b.id) ?? Infinity;
    if (ia !== ib) return ia - ib;
    return a.added_at - b.added_at;
  });
}

/** `ids` with `moved` dropped `before`/`after` `target`. Unknown ids and a
 *  drop onto one of the moved items leave the order as it was. */
export function reorderIds(
  ids: string[],
  moved: string[],
  target: string,
  position: 'before' | 'after',
): string[] {
  const set = new Set(moved.filter((id) => ids.includes(id)));
  if (!set.size || set.has(target)) return ids;
  const rest = ids.filter((id) => !set.has(id));
  const t = rest.indexOf(target);
  if (t < 0) return ids;
  const keep = ids.filter((id) => set.has(id));
  const at = position === 'before' ? t : t + 1;
  return [...rest.slice(0, at), ...keep, ...rest.slice(at)];
}

/** ⌃1…9 → the Nth project in switcher order, ⌃0 → All; `null` for any
 *  other key, or a digit past the last project. */
export function workspaceForKey(
  e: Pick<
    KeyboardEvent,
    'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'code'
  >,
  ordered: WorkspaceId[],
): WorkspaceId | null {
  if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
  const m = /^Digit([0-9])$/.exec(e.code);
  if (!m) return null;
  const n = Number(m[1]);
  return n === 0 ? ALL : (ordered[n - 1] ?? null);
}

/** Waiting for you: open, in the inbox for a reason, not done or snoozed. */
export function isWaiting(
  p: { state: PrState; reasons: unknown[] },
  s: Pick<InboxState, 'done' | 'snooze'> | undefined,
): boolean {
  if (p.state !== 'open' && p.state !== 'draft') return false;
  return p.reasons.length > 0 && !s?.done && !s?.snooze;
}

/** Waiting-PR count per workspace — All counts every PR, a project its own
 *  repo's. Projects with none are present with 0. One pass over the PRs. */
export function waitingCounts(
  prs: {
    id: PrId;
    state: PrState;
    reasons: unknown[];
    pr: { repo: RepoRef };
  }[],
  states: InboxState[],
  projects: Project[],
): Map<WorkspaceId, number> {
  const first = new Map<string, InboxState>();
  for (const s of states) if (!first.has(s.pr)) first.set(s.pr, s);
  const out = new Map<WorkspaceId, number>([[ALL, 0]]);
  for (const p of projects) out.set(p.id, 0);
  for (const p of prs) {
    if (!isWaiting(p, first.get(p.id))) continue;
    out.set(ALL, out.get(ALL)! + 1);
    const owner = ownerOf(projects, p.pr.repo);
    if (owner) out.set(owner.id, out.get(owner.id)! + 1);
  }
  return out;
}

/** Where a workspace starts, and where it falls back to once its last tab
 *  closes: the Inbox for All, Overview for a project. */
export function homeRoute(ws: WorkspaceId): Route {
  return ws === ALL ? { name: 'inbox' } : { name: 'project', id: ws };
}

const sameRoute = (a: Route, b: Route) =>
  JSON.stringify(a) === JSON.stringify(b);

export interface PlaceContext {
  current: WorkspaceId;
  currentTabs: Route[];
  projects: Project[];
  /** Saved tabs of another workspace, `null` when it has none saved. */
  tabsOf: (ws: WorkspaceId) => Route[] | null;
  repoOfPr: (pr: PrId) => RepoRef | null;
}

/** The workspace a navigation lands in, and the route it shows there.
 *
 * - review: stays if already a tab here; else goes to the workspace that
 *   already has it open (never two tabs of one PR); else stays in All; else
 *   the project owning its repo, or All when none does.
 * - project: that project's own workspace (its Overview).
 * - Inbox / My PRs in a local-folder workspace: its Overview instead.
 */
export function placeRoute(
  route: Route,
  ctx: PlaceContext,
): { ws: WorkspaceId; route: Route } {
  const { current, projects } = ctx;
  if (route.name === 'review') {
    if (ctx.currentTabs.some((t) => sameRoute(t, route)))
      return { ws: current, route };
    const ids = [ALL, ...projects.map((p) => p.id)];
    const open = ids.find(
      (id) =>
        id !== current && ctx.tabsOf(id)?.some((t) => sameRoute(t, route)),
    );
    if (open) return { ws: open, route };
    if (current === ALL) return { ws: ALL, route };
    const repo = ctx.repoOfPr(route.pr);
    if (!repo) return { ws: current, route };
    return { ws: ownerOf(projects, repo)?.id ?? ALL, route };
  }
  if (route.name === 'project') {
    const known = projects.some((p) => p.id === route.id);
    return { ws: known ? route.id : current, route };
  }
  if (
    (route.name === 'inbox' || route.name === 'mine') &&
    kindOf(current, projects) === 'local'
  ) {
    return { ws: current, route: homeRoute(current) };
  }
  return { ws: current, route };
}
