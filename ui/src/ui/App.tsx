import { useEffect } from 'react';
import { Surface, Toast, toast } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import { useRootStore, useUi } from '../stores/context';
import { ask } from '../actions';
import { ContextMenuHost, useContextMenu } from './ContextMenu';
import { Inbox } from './List';
import { Mine } from './Mine';
import { Modals } from './Modals';
import { useGlobalKeys } from './Palette';
import { Review } from './Review';
import { Sidebar } from './Sidebar';
import { SettingsNav, SettingsPage } from './Settings';
import { TabBar } from './TabBar';
import { Tasks } from './Tasks';
import { Onboarding } from './Onboarding';

/** Fallback for any surface with no menu of its own: inputs get Cut/Copy/
 *  Paste/Select all, a text selection gets Copy + "Ask agent about
 *  selection", everything else gets nothing (no custom items to show). */
function useRootContextMenu() {
  const store = useRootStore();
  const ui = useUi();
  return useContextMenu(() => {
    const el = document.activeElement as HTMLElement | null;
    const isField =
      !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
    if (isField) {
      const input = el as HTMLInputElement | HTMLTextAreaElement;
      return [
        { id: 'cut', label: 'Cut', onAction: () => document.execCommand('cut') },
        {
          id: 'copy',
          label: 'Copy',
          onAction: () => document.execCommand('copy'),
        },
        {
          id: 'paste',
          label: 'Paste',
          onAction: () => document.execCommand('paste'),
        },
        {
          id: 'select-all',
          label: 'Select all',
          onAction: () => input.select(),
        },
      ];
    }
    const text = document.getSelection()?.toString();
    if (text) {
      return [
        {
          id: 'copy',
          label: 'Copy',
          onAction: () => void navigator.clipboard.writeText(text),
        },
        {
          id: 'ask-agent',
          label: 'Ask agent about selection',
          isDisabled: ui.route.name !== 'review',
          onAction: () => {
            if (ui.route.name !== 'review') return;
            void ask(store, {
              pr: ui.route.pr,
              question: text,
              about: null,
              group: null,
              agent: null,
            }).catch(() => {
              // toasted by api.ts
            });
          },
        },
      ];
    }
    return [];
  });
}

const Toasts = observer(function Toasts() {
  const store = useRootStore();
  useEffect(() => {
    // HeroUI's imperative toast API: fire once per new entry, then drop it.
    for (const t of store.ephemeral.toasts) {
      toast(t.text, { timeout: 3200 });
      store.ephemeral.dismissToast(t.id);
    }
  }, [store, store.ephemeral.toasts]);
  return null;
});

export const App = observer(function App() {
  const ui = useUi();
  useGlobalKeys();
  const onContextMenu = useRootContextMenu();

  if (!ui.onboarded) {
    return (
      <>
        <Onboarding />
        <Toast.Provider placement="bottom end" maxVisibleToasts={3} />
      </>
    );
  }

  const r = ui.route;
  return (
    <div
      className="flex h-full flex-col bg-background text-sm text-foreground"
      onContextMenu={onContextMenu}
    >
      <div className="flex min-h-0 flex-1">
        {ui.sidebar &&
          (r.name === 'settings' ? <SettingsNav page={r.page} /> : <Sidebar />)}
        <Surface className="flex min-w-0 flex-1 flex-col rounded-none">
          <TabBar showOpen={!ui.sidebar} />
          <div className="flex min-h-0 flex-1">
            {r.name === 'inbox' ? (
              <Inbox />
            ) : r.name === 'mine' ? (
              <Mine />
            ) : r.name === 'tasks' ? (
              <Tasks />
            ) : r.name === 'settings' ? (
              <SettingsPage page={r.page} />
            ) : (
              <Review key={r.pr} pr={r.pr} />
            )}
          </div>
        </Surface>
      </div>
      <Modals />
      <Toasts />
      <ContextMenuHost />
      <Toast.Provider placement="bottom end" maxVisibleToasts={3} />
    </div>
  );
});
