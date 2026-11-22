/** Used by scripts/prerender.mjs: one page's HTML and head, for a path, and
 *  the parsers it bakes GitHub's answers with. */
import { renderToString } from 'react-dom/server';
import { App } from './app/App';
import type { PageData } from './app/data';
import { headTags } from './app/head';
import { routeFor } from './app/routes';
import './styles.css';

export { ROUTES, NOT_FOUND } from './app/routes';
export { parseRelease } from './download/release';
export { toReleaseNote, sortReleases } from './releases/notes';

export function render(path: string, data: PageData) {
  const route = routeFor(path);
  const html = renderToString(<App initialPath={route.path} data={data} />);
  return { html, head: headTags(route) };
}
