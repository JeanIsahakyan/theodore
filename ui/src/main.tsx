import { createRoot } from 'react-dom/client';
import { loadShiki } from './highlight';
import { initialTheme } from './stores/UiStore';
import { RootStore } from './stores/RootStore';
import { RootStoreProvider } from './stores/context';
import { App } from './ui/App';
import './styles.css';

initialTheme();
loadShiki();

const store = new RootStore();
void store.start();

createRoot(document.getElementById('root')!).render(
  <RootStoreProvider store={store}>
    <App />
  </RootStoreProvider>,
);
