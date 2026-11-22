import { hydrateRoot } from 'react-dom/client';
import { App } from './app/App';
import type { PageData } from './app/data';
import { watchSystemTheme } from './app/theme';
import './styles.css';

watchSystemTheme();

const data: PageData = window.__THEODORE_DATA__ ?? {
  release: null,
  year: new Date().getFullYear(),
};

hydrateRoot(
  document.getElementById('root')!,
  <App initialPath={window.location.pathname} data={data} />,
);
