// Prerenders every route to its own HTML file in dist/, after the client and
// SSR builds (package.json `build`): /download becomes dist/download/index.html,
// so each page is served as static HTML and works without JavaScript. Also
// writes 404.html, sitemap.xml, and bakes the latest release into the page.
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const ssr = join(root, 'dist-ssr');
const SITE_URL = 'https://theodore.cloud';

const template = await readFile(join(dist, 'index.html'), 'utf8');
const { render, ROUTES, NOT_FOUND } = await import(
  join(ssr, 'entry-server.js')
);

/** The latest release, so the download page has its version and links in
 *  the HTML itself. Offline or rate-limited: null, the page links to the
 *  release page and the browser asks again. */
async function latestRelease() {
  try {
    const res = await fetch(
      'https://api.github.com/repos/JeanIsahakyan/theodore/releases/latest',
      { headers: { Accept: 'application/vnd.github+json' } },
    );
    if (!res.ok) return null;
    const r = await res.json();
    const patterns = {
      'mac-arm64-dmg': /^Theodore_.+_aarch64\.dmg$/,
      'linux-x64-appimage': /^Theodore_.+_x86_64\.AppImage$/,
      'linux-x64-deb': /^Theodore_.+_amd64\.deb$/,
      'linux-arm64-appimage': /^Theodore_.+_aarch64\.AppImage$/,
      'linux-arm64-deb': /^Theodore_.+_arm64\.deb$/,
    };
    const assets = {};
    for (const a of r.assets ?? []) {
      for (const [key, re] of Object.entries(patterns)) {
        if (re.test(a.name))
          assets[key] = { url: a.browser_download_url, size: a.size };
      }
    }
    return {
      version: String(r.tag_name).replace(/^v/, ''),
      publishedAt: r.published_at,
      url: r.html_url,
      assets,
    };
  } catch {
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

const data = { release: await latestRelease(), year: new Date().getFullYear() };
const preloads = await fontPreloads();
const dataTag = `<script>window.__THEODORE_DATA__=${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;

function page(path) {
  const { html, head } = render(path, data);
  return template
    .replace('<!--app-head-->', `${head}\n    ${preloads}`)
    .replace('<!--app-html-->', html)
    .replace('<!--app-data-->', dataTag);
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
void cp;
console.log(
  data.release
    ? `release ${data.release.version} baked in`
    : 'no release baked in',
);
