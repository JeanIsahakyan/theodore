// Prerenders every route to its own HTML file in dist/, after the client and
// SSR builds (package.json `build`): /download becomes dist/download/index.html,
// so each page is served as static HTML and works without JavaScript. Also
// writes 404.html, sitemap.xml and releases.json, and bakes the latest
// release, the GitHub stars and (into /releases) every release into the page.
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const ssr = join(root, 'dist-ssr');
const SITE_URL = 'https://theodore.cloud';
const API = 'https://api.github.com/repos/JeanIsahakyan/theodore';

const template = await readFile(join(dist, 'index.html'), 'utf8');
const { render, ROUTES, NOT_FOUND, parseRelease, toReleaseNote, sortReleases } =
  await import(join(ssr, 'entry-server.js'));

/** GitHub's API; a token (CI's GITHUB_TOKEN) lifts the anonymous rate limit. */
async function github(path) {
  const headers = { Accept: 'application/vnd.github+json' };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { headers });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res;
}

/** The latest release, so the download page has its version and links in
 *  the HTML itself. Offline or rate-limited: null, the page links to the
 *  release page and the browser asks again. */
async function latestRelease() {
  try {
    return parseRelease(await (await github('/releases/latest')).json());
  } catch (e) {
    console.warn('latest release not fetched:', e.message);
    return null;
  }
}

/** Every release, newest first, following the API's pages. Offline: an
 *  empty list, and the page says so. */
async function allReleases() {
  const out = [];
  try {
    for (let page = 1; page < 50; page++) {
      const res = await github(`/releases?per_page=100&page=${page}`);
      const list = await res.json();
      for (const r of list) {
        const note = toReleaseNote(r);
        if (note) out.push(note);
      }
      if (!/rel="next"/.test(res.headers.get('link') ?? '')) break;
    }
  } catch (e) {
    console.warn('releases not fetched:', e.message);
  }
  return sortReleases(out);
}

async function stars() {
  try {
    const repo = await (await github('')).json();
    return typeof repo.stargazers_count === 'number'
      ? repo.stargazers_count
      : null;
  } catch (e) {
    console.warn('stars not fetched:', e.message);
    return null;
  }
}

/** Preload the two text fonts (latin, variable), so the first paint uses
 *  them; the hashed names come from the build. */
async function fontPreloads() {
  const files = await readdir(join(dist, 'assets'));
  const wanted = files.filter((f) =>
    /^geist(-mono)?-latin-wght-normal-.*\.woff2$/.test(f),
  );
  return wanted
    .map(
      (f) =>
        `<link rel="preload" href="/assets/${f}" as="font" type="font/woff2" crossorigin />`,
    )
    .join('\n    ');
}

const [release, releases, starCount] = await Promise.all([
  latestRelease(),
  allReleases(),
  stars(),
]);
const common = { release, stars: starCount, year: new Date().getFullYear() };
const preloads = await fontPreloads();

const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

function page(path) {
  const data = path === '/releases' ? { ...common, releases } : common;
  const { html, head } = render(path, data);
  return template
    .replace('<!--app-head-->', `${head}\n    ${preloads}`)
    .replace('<!--app-html-->', html)
    .replace(
      '<!--app-data-->',
      `<script>window.__THEODORE_DATA__=${json(data)}</script>`,
    );
}

for (const r of ROUTES) {
  const out =
    r.path === '/'
      ? join(dist, 'index.html')
      : join(dist, r.path, 'index.html');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, page(r.path));
  console.log('prerendered', r.path);
}
// Cloudflare Pages serves 404.html for any path that has no file.
await writeFile(join(dist, '404.html'), page(NOT_FOUND.path));
// The changelog, for a visit that navigates to /releases from another page.
await writeFile(join(dist, 'releases.json'), JSON.stringify(releases));

const today = new Date().toISOString().slice(0, 10);
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${ROUTES.filter((r) => !r.noindex)
  .map(
    (r) =>
      `  <url><loc>${SITE_URL}${r.path === '/' ? '/' : r.path}</loc><lastmod>${today}</lastmod></url>`,
  )
  .join('\n')}
</urlset>
`;
await writeFile(join(dist, 'sitemap.xml'), sitemap);

// The SSR bundle isn't deployed.
await rm(ssr, { recursive: true, force: true });
console.log(
  release ? `release ${release.version} baked in` : 'no release baked in',
  `· ${releases.length} releases`,
  `· ${starCount ?? 'no'} stars`,
);
