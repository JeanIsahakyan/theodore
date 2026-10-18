import { useEffect } from 'react';
import { Surface, Toast, toast } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import { useRootStore, useUi } from '../stores/context';
import { Inbox } from './List';
import { Modals } from './Modals';
import { useGlobalKeys } from './Palette';
import { Review } from './Review';
import { Sidebar } from './Sidebar';
import { SettingsNav, SettingsPage } from './Settings';
import { TabBar } from './TabBar';
import { Tasks } from './Tasks';
import { Onboarding } from './Onboarding';

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
    <div className="flex h-full flex-col bg-background text-sm text-foreground">
      <div className="flex min-h-0 flex-1">
        {ui.sidebar &&
          (r.name === 'settings' ? <SettingsNav page={r.page} /> : <Sidebar />)}
        <Surface className="flex min-w-0 flex-1 flex-col rounded-none">
          <TabBar showOpen={!ui.sidebar} />
          <div className="flex min-h-0 flex-1">
            {r.name === 'inbox' ? (
              <Inbox />
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
      <Toast.Provider placement="bottom end" maxVisibleToasts={3} />
    </div>
  );
});
