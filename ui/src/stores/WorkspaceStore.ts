/**
 * The workspace switcher: which workspaces exist and in what order, what
 * the active one shows, and where a navigation lands. The per-workspace UI
 * state itself lives in `UiStore` (`switchWorkspace`).
 */
import { computed, makeObservable, observableRef, runInAction } from 'mobx';
import type { PrId, Project, RepoRef, Task } from '../gen/contract';
import type { ModelAccessors } from '../sync';
import {
  ALL,
  inWorkspace,
  kindOf,
  orderProjects,
  placeRoute,
  reorderIds,
  repoOfPrId,
  waitingCounts,
  workspaceForKey,
  type WorkspaceId,
  type WorkspaceKind,
} from '../core/workspaces';
import { STORAGE_NS, type UiStore } from './UiStore';

const LS_ORDER = `${STORAGE_NS}theodore-workspace-order`;

function loadOrder(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(LS_ORDER) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export class WorkspaceStore {
  /** Project ids in switcher order, as dragged; new projects go last. */
  order: string[] = loadOrder();

  constructor(
    private readonly models: ModelAccessors,
    private readonly ui: UiStore,
  ) {
    makeObservable(this, {
      order: observableRef,
      projects: computed,
      active: computed,
      kind: computed,
      badges: computed,
    });
    ui.place = (route) =>
      placeRoute(route, {
        current: ui.workspace,
        currentTabs: ui.tabs,
        projects: this.projects,
        tabsOf: (ws) => ui.tabsOf(ws),
        repoOfPr: (pr) => this.repoOfPr(pr),
      });
  }

  /** Projects in switcher order. */
  get projects(): Project[] {
    return orderProjects(this.models.projects.all(), this.order);
  }

  get id(): WorkspaceId {
    return this.ui.workspace;
  }

  /** The active project, `null` under All (or while projects load). */
  get active(): Project | null {
    const id = this.ui.workspace;
    if (id === ALL) return null;
    return this.models.projects.get(id) ?? null;
  }

  get kind(): WorkspaceKind {
    return kindOf(this.ui.workspace, this.models.projects.all());
  }

  /** Waiting-PR count per workspace id, `ALL` included. */
  get badges(): Map<WorkspaceId, number> {
    return waitingCounts(
      this.models.prSummaries.all(),
      this.models.inboxStates.all(),
      this.models.projects.all(),
    );
  }

  repoOfPr(pr: PrId): RepoRef | null {
    return this.models.prSummaries.get(pr)?.pr.repo ?? repoOfPrId(pr);
  }

  /** Whether a row of this repo shows in the active workspace. */
  shows(repo: RepoRef | null): boolean {
    return inWorkspace(this.ui.workspace, repo, this.models.projects.all());
  }

  /** PR rows the active workspace shows. */
  scopePrs<T extends { pr: { repo: RepoRef } }>(prs: T[]): T[] {
    if (this.ui.workspace === ALL) return prs;
    return prs.filter((p) => this.shows(p.pr.repo));
  }

  /** Tasks of PRs the active workspace shows. */
  scopeTasks<T extends Pick<Task, 'pr'>>(tasks: T[]): T[] {
    if (this.ui.workspace === ALL) return tasks;
    return tasks.filter((t) => this.shows(this.repoOfPr(t.pr)));
  }

  switchTo(ws: WorkspaceId): void {
    this.ui.switchWorkspace(ws);
  }

  /** ⌃1…9 / ⌃0; `true` when the key switched. */
  switchForKey(e: KeyboardEvent): boolean {
    const ws = workspaceForKey(
      e,
      this.projects.map((p) => p.id),
    );
    if (!ws) return false;
    this.switchTo(ws);
    return true;
  }

  /** A drag in the switcher: `moved` dropped before/after `target`. */
  reorder(moved: string[], target: string, position: 'before' | 'after'): void {
    const ids = this.projects.map((p) => p.id);
    const next = reorderIds(ids, moved, target, position);
    if (next === ids) return;
    localStorage.setItem(LS_ORDER, JSON.stringify(next));
    runInAction(() => {
      this.order = next;
    });
  }

  /** A project was removed: forget its state and its place in the order. */
  forget(id: string): void {
    this.ui.forgetWorkspace(id);
    const next = this.order.filter((x) => x !== id);
    localStorage.setItem(LS_ORDER, JSON.stringify(next));
    runInAction(() => {
      this.order = next;
    });
  }
}
