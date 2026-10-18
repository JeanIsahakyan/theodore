/**
 * Local-only UI state: navigation and tabs, selection, panel visibility.
 * Never synced, never persisted beyond a couple of `localStorage` prefs — a
 * desktop app has no address bar, so this plays the role a router would.
 */
import {
  makeObservable,
  observable,
  observableRef,
  observableShallow,
  runInAction,
  reaction,
} from 'mobx';
import type { PrId } from '../gen/contract';
import type { ContextMenuItem } from '../ui/ContextMenu';

export type SettingsPage = 'account' | 'agents' | 'updates' | 'about';

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export type Route =
  | { name: 'inbox' }
  | { name: 'mine' }
  | { name: 'tasks' }
  | { name: 'settings'; page: SettingsPage }
  | { name: 'review'; pr: PrId }
  /** A blank tab: paste a PR link to turn it into a review. */
  | { name: 'new'; id: string };

export type ModalName = 'help' | 'submit' | 'snooze' | 'cmdk';

export const sameRoute = (a: Route, b: Route): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

const LS_ONBOARDED = 'theodore-onboarded';
const LS_DIFF_VIEW = 'theodore-diff-view';
const LS_ASIDE = 'theodore-aside';
const LS_THEME = 'theodore-theme';
const LS_TABS = 'theodore-tabs';

/** Open tabs and the active one, restored on the next launch. */
function loadTabs(): { tabs: Route[]; route: Route } {
  try {
    const v = JSON.parse(localStorage.getItem(LS_TABS) ?? 'null') as {
      tabs: Route[];
      route: Route;
    } | null;
    if (v && Array.isArray(v.tabs) && v.tabs.length && v.route) return v;
  } catch {
    // corrupt value: start fresh
  }
  return { tabs: [{ name: 'inbox' }], route: { name: 'inbox' } };
}

export class UiStore {
  onboarded = localStorage.getItem(LS_ONBOARDED) === '1';
  route: Route = loadTabs().route;
  back: Route = { name: 'inbox' };
  tabs: Route[] = loadTabs().tabs;
  selected: PrId | null = null;
  picked: PrId[] = [];
  peek = true;
  sidebar = true;
  aside = localStorage.getItem(LS_ASIDE) !== '0';
  diffView: 'unified' | 'split' =
    localStorage.getItem(LS_DIFF_VIEW) === 'split' ? 'split' : 'unified';
  modal: ModalName | null = null;
  snoozeTargets: PrId[] = [];
  /** The one custom context menu, open at a pointer point — see `ContextMenu.tsx`. */
  contextMenu: ContextMenuState | null = null;

  constructor() {
    makeObservable(this, {
      onboarded: observable,
      route: observableRef,
      back: observableRef,
      tabs: observableShallow,
      selected: observable,
      picked: observableShallow,
      peek: observable,
      sidebar: observable,
      aside: observable,
      diffView: observable,
      modal: observableRef,
      snoozeTargets: observableShallow,
      contextMenu: observableRef,
    });
    reaction(
      () => ({ tabs: this.tabs, route: this.route }),
      (v) => localStorage.setItem(LS_TABS, JSON.stringify(v)),
    );
  }

  finishOnboarding(): void {
    localStorage.setItem(LS_ONBOARDED, '1');
    runInAction(() => {
      this.onboarded = true;
      this.go({ name: 'inbox' });
    });
  }

  /** Linear-style tabs: `review` always gets its own tab; other views replace
   *  the current tab unless `newTab` is asked for. */
  go(route: Route, opts: { newTab?: boolean } = {}): void {
    runInAction(() => {
      let tabs = this.tabs;
      if (!tabs.some((t) => sameRoute(t, route))) {
        const cur = tabs.findIndex((t) => sameRoute(t, this.route));
        const push =
          route.name === 'review' ||
          opts.newTab ||
          this.route.name === 'review' ||
          cur < 0;
        tabs = push
          ? [...tabs.slice(0, cur + 1), route, ...tabs.slice(cur + 1)]
          : tabs.map((t, i) => (i === cur ? route : t));
      }
      this.back = this.route.name === 'review' ? this.back : this.route;
      this.tabs = tabs;
      this.route = route;
      this.modal = null;
      this.picked = [];
    });
  }

  /** Open a blank tab (the `+` in the tab bar). */
  newTab(): void {
    this.go({ name: 'new', id: crypto.randomUUID() }, { newTab: true });
  }

  /** Swap `from` (e.g. a blank tab) for `to` in place. */
  replaceTab(from: Route, to: Route): void {
    runInAction(() => {
      const exists = this.tabs.some((t) => sameRoute(t, to));
      this.tabs = exists
        ? this.tabs.filter((t) => !sameRoute(t, from))
        : this.tabs.map((t) => (sameRoute(t, from) ? to : t));
      if (!this.tabs.length) this.tabs = [to];
      this.route = to;
    });
  }

  goBack(): void {
    this.go(this.back);
  }

  closeTab(route: Route): void {
    runInAction(() => {
      const i = this.tabs.findIndex((t) => sameRoute(t, route));
      if (i < 0) return;
      const tabs = this.tabs.filter((_, j) => j !== i);
      if (!tabs.length) tabs.push({ name: 'inbox' });
      const active = sameRoute(this.route, route)
        ? tabs[Math.min(i, tabs.length - 1)]!
        : this.route;
      this.tabs = tabs;
      this.route = active;
    });
  }

  switchTab(n: number): void {
    const t = this.tabs[n];
    if (t) this.go(t);
  }

  select(id: PrId | null): void {
    runInAction(() => {
      this.selected = id;
    });
  }

  togglePick(id: PrId): void {
    runInAction(() => {
      this.picked = this.picked.includes(id)
        ? this.picked.filter((x) => x !== id)
        : [...this.picked, id];
    });
  }

  clearPicked(): void {
    runInAction(() => {
      this.picked = [];
    });
  }

  togglePeek(): void {
    runInAction(() => {
      this.peek = !this.peek;
    });
  }

  toggleSidebar(): void {
    runInAction(() => {
      this.sidebar = !this.sidebar;
    });
  }

  toggleAside(open = !this.aside): void {
    localStorage.setItem(LS_ASIDE, open ? '1' : '0');
    runInAction(() => {
      this.aside = open;
    });
  }

  toggleDiffView(): void {
    const v = this.diffView === 'split' ? 'unified' : 'split';
    localStorage.setItem(LS_DIFF_VIEW, v);
    runInAction(() => {
      this.diffView = v;
    });
  }

  openModal(m: ModalName, targets: PrId[] = []): void {
    runInAction(() => {
      this.modal = m;
      this.snoozeTargets = targets;
    });
  }

  closeModal(): void {
    runInAction(() => {
      this.modal = null;
    });
  }

  openContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
    runInAction(() => {
      this.contextMenu = { x, y, items };
    });
  }

  closeContextMenu(): void {
    runInAction(() => {
      this.contextMenu = null;
    });
  }
}

export function toggleTheme(): void {
  const dark = !document.documentElement.classList.contains('dark');
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  localStorage.setItem(LS_THEME, dark ? 'dark' : 'light');
}

export function initialTheme(): void {
  const theme = localStorage.getItem(LS_THEME) ?? 'light';
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.dataset.theme = theme;
}
