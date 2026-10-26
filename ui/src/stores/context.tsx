import { createContext, useContext, type ReactNode } from 'react';
import { RootStore } from './RootStore';

const RootStoreContext = createContext<RootStore | null>(null);

export function RootStoreProvider({
  store,
  children,
}: {
  store: RootStore;
  children: ReactNode;
}) {
  return (
    <RootStoreContext.Provider value={store}>
      {children}
    </RootStoreContext.Provider>
  );
}

export function useRootStore(): RootStore {
  const store = useContext(RootStoreContext);
  if (!store) throw new Error('useRootStore() outside <RootStoreProvider>');
  return store;
}

export const useUi = () => useRootStore().ui;
export const useModels = () => useRootStore().models;
export const useEphemeral = () => useRootStore().ephemeral;
export const useSync = () => useRootStore().sync;
export const useWorkspaces = () => useRootStore().workspaces;
