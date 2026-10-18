import { createRoot } from 'react-dom/client';
import { configure } from 'mobx';
import { loadShiki } from './highlight';
import { initialTheme } from './stores/UiStore';
import { RootStore } from './stores/RootStore';
import { RootStoreProvider } from './stores/context';
import { App } from './ui/App';
import './styles.css';

// Every mutation to observable state must go through an action — catches
// stray direct writes (e.g. `this.modal = x` outside `runInAction`) as a
// console warning instead of letting them silently skip reactivity.
configure({ enforceActions: 'observed' });

initialTheme();
loadShiki();

// Our own ContextMenu replaces the webview's native one everywhere; in dev,
// ⌥+right-click is left alone so it still opens the devtools inspector.
window.addEventListener('contextmenu', (e) => {
  if (import.meta.env.DEV && e.altKey) return;
  e.preventDefault();
});

const store = new RootStore();
void store.start();

createRoot(document.getElementById('root')!).render(
  <RootStoreProvider store={store}>
    <App />
  </RootStoreProvider>,
);
