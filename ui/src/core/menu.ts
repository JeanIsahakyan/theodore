/** Native menu bar → the same actions as ⌘K. Review-local actions are
 *  forwarded as a `theodore:review` DOM event that `Review.tsx` handles. */
import { openExternal } from './openExternal';
import type { RootStore } from '../stores/RootStore';
import { toggleTheme } from '../stores/UiStore';
import { refreshInbox } from '../actions';
import { getTransport } from './transport';
import { MENU_WHILE_LOCKED } from './accountGate';
import { checkForUpdates } from './updateCheck';

export const REVIEW_EVENT = 'theodore:review';

export function runMenu(store: RootStore, id: string): void {
  // Behind the account gate only a few items do anything (plan §6.12).
  if (store.ephemeral.accountGate !== 'open' && !MENU_WHILE_LOCKED.has(id))
    return;
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
      return void checkForUpdates(store);
    case 'new-tab':
    case 'open-pr':
      return ui.newTab();
    case 'add-project':
      return ui.openModal('add-project');
    case 'close-tab':
      return ui.requestCloseTab(ui.route);
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
    case 'go-prs':
      return ui.goPrs();
    case 'go-mine':
      return ui.goPrs('mine');
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
    case 'report-problem':
      return ui.openModal('report-problem');
    case 'report-issue':
      return void openExternal(
        'https://github.com/JeanIsahakyan/theodore/issues/new',
      );
    case 'submit-review': {
      if (ui.route.name !== 'review') return;
      const state = store.models.prSummaries.get(ui.route.pr)?.state;
      // A merged or closed PR takes no more reviews.
      if (state === 'merged' || state === 'closed') return;
      return ui.openModal('submit');
    }
    default:
      // view-*, mark-group-read, ask-agent, open-on-host
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
