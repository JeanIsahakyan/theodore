/** Native menu bar → the same actions as ⌘K. Review-local actions are
 *  forwarded as a `theodore:review` DOM event that `Review.tsx` handles. */
import type { RootStore } from '../stores/RootStore';
import { toggleTheme } from '../stores/UiStore';
import { refreshInbox } from '../actions';
import { api } from './api';
import { getTransport } from './transport';

export const REVIEW_EVENT = 'theodore:review';

export function runMenu(store: RootStore, id: string): void {
  const ui = store.ui;
  const review = () =>
    window.dispatchEvent(new CustomEvent(REVIEW_EVENT, { detail: id }));
  const step = (d: number) => {
    const i = ui.tabs.findIndex(
      (t) => JSON.stringify(t) === JSON.stringify(ui.route),
    );
    const n = ui.tabs.length;
    if (n) ui.go(ui.tabs[(i + d + n) % n]!);
  };
  switch (id) {
    case 'settings':
      return ui.go({ name: 'settings', page: 'agents' });
    case 'check-updates':
      return void api.checkUpdate().catch(() => {});
    case 'new-tab':
    case 'open-pr':
      return ui.newTab();
    case 'add-project':
      return ui.openModal('add-project');
    case 'close-tab':
      return ui.closeTab(ui.route);
    case 'toggle-sidebar':
      return ui.toggleSidebar();
    case 'toggle-aside':
      return ui.toggleAside();
    case 'toggle-theme':
      return toggleTheme();
    case 'palette':
      return ui.openModal('cmdk');
    case 'go-inbox':
      return ui.go({ name: 'inbox' });
    case 'go-mine':
      return ui.go({ name: 'mine' });
    case 'go-tasks':
      return ui.go({ name: 'tasks' });
    case 'next-tab':
      return step(1);
    case 'prev-tab':
      return step(-1);
    case 'go-back':
      return ui.goBack();
    case 'refresh-inbox':
      return void refreshInbox(store);
    case 'shortcuts':
      return ui.openModal('help');
    case 'report-issue':
      return void window.open(
        'https://github.com/JeanIsahakyan/theodore/issues/new',
        '_blank',
      );
    case 'submit-review':
      return ui.route.name === 'review' ? ui.openModal('submit') : undefined;
    default:
      // view-*, tour, mark-group-read, ask-agent, open-on-host
      review();
  }
}

export function listenMenu(store: RootStore): () => void {
  let off: (() => void) | null = null;
  let cancelled = false;
  void getTransport()
    .listen<string>('menu', (id) => runMenu(store, id))
    .then((un) => {
      if (cancelled) un();
      else off = un;
    })
    .catch(() => {});
  return () => {
    cancelled = true;
    off?.();
  };
}
