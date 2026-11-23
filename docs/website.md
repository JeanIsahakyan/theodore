# Website: theodore.cloud

The public site in `site/`: a Vite + React + TypeScript app in the desktop's
look (HeroUI v3, Tailwind, Geist, the same tokens as `ui/src/styles.css`),
prerendered to static HTML and served by Cloudflare Pages.

```
site/
  index.html            the template: theme script, favicon, <!--app-head-->, <!--app-html-->
  src/app/              App, the tiny router, routes + meta, head tags, theme (as the desktop's)
  src/pages/            Home, Download, Releases, Privacy, Terms, NotFound
  src/demo/             the hero story: an agent asks, the phone answers, a PR opens
  src/mocks/            product UI built from the app's pieces (chat, review, spaces, phone)
  src/releases/         the changelog's entries: which releases count, a markdown renderer
  src/shared/           LogoArt and Ring, copied from ui/src (no store); colours from @desktop
  src/download/         platform detection, the latest GitHub release
  scripts/prerender.mjs one HTML per route, 404.html, sitemap.xml, releases.json, fonts
                        preloaded; the latest release, the stars and the changelog baked in
  public/               favicon, og.png, robots.txt, _headers
  deploy/pages.yml      the GitHub Actions workflow, to move into .github/workflows/
```

| Page | Path | Content |
| --- | --- | --- |
| Home | `/` | the night band: hero + live demo, trust strip; Spaces, Review, Your phone (each with a live mock), the rest as a list, open source, CTA |
| Download | `/download` | the visitor's platform first; every asset of the latest release; iOS / Android / web status |
| Changelog | `/releases` | every app release (`v*` tags, no drafts or pre-releases), newest first, notes rendered from markdown; the newest ten open, older ones folded |
| Privacy | `/privacy` | the privacy policy for the desktop, the phone app and the cloud (the App Store listing links it) |
| Terms | `/terms` | terms for the open-source apps and the hosted cloud |

## Build

```sh
pnpm -C site install
pnpm -C site dev                  # http://localhost:4173
pnpm -C site typecheck && pnpm -C site lint && pnpm -C site format:check
pnpm -C site build                # site/dist: client build, SSR build, prerender
```

`build` renders every route with `react-dom/server` into its own
`index.html`, writes `404.html` (Pages serves it for unknown paths),
`sitemap.xml` and `releases.json`, and asks GitHub's API for the latest
release (so `/download` and the hero's "What's new" carry the version and
links without JavaScript), the stargazer count (the trust strip; hidden
when unknown) and every release (`/releases`; paginated). Offline, the
download links fall back to the release page, the changelog says the notes
are on GitHub, and the browser asks GitHub again on load. `GITHUB_TOKEN` in
the environment lifts the anonymous rate limit (CI sets it). Routes inside
the page then navigate in place; `/releases` reached that way loads
`releases.json`.

- `@desktop/*` is `ui/src/*`: only pure modules (today `ui/logoColors.ts`).
  Presentational pieces with store or Tauri imports are copied into
  `src/shared/` with a note saying where from.
- The theme is the desktop's rule: `theodore-theme` in localStorage, else
  the system; the `.dark` class HeroUI reads, applied by an inline script
  before the first paint.
- The look: the desktop's tokens, plus the site's own "night shift"
  identity in `styles.css`: the deep blue band (`--night`) with paper text,
  a brand (ink / paper) button, and signal yellow (`--signal`) used only
  where the agent waits for you. Soft layered shadows instead of borders;
  body text 17–18 px in `--ink-2`.
- The hero loop starts at its key frame (the question on the computer, the
  push on the phone): that is what the server renders and what reduced
  motion keeps. It pauses off screen and in a hidden tab.
- Release notes are rendered by `src/releases/markdown.ts`, which escapes
  every string and emits only its own tags; a release whose notes are empty
  or only GitHub's generated "What's Changed" list shows as "Maintenance
  release".

## Deploy

```
push main, site/** ──▶ pages.yml: checks ──▶ build ──▶ wrangler pages deploy site/dist
                                                        --project-name theodore-site --branch main
PR touching site/  ──▶ the same ──▶ --branch <pr branch> ──▶ a preview URL, commented on the PR
```

| | |
| --- | --- |
| Pages project | `theodore-site`, production branch `main` |
| Domains | `theodore.cloud`, `www.theodore.cloud` (custom domains on the project; `theodore-site.pages.dev` stays) |
| Secrets | `CLOUDFLARE_API_TOKEN` (Cloudflare Pages: Edit), `CLOUDFLARE_ACCOUNT_ID`, as `cloud.yml` |
| Headers | `public/_headers`: immutable cache for `/assets`, nosniff, referrer policy, no framing |

The workflow file is `.github/workflows/pages.yml`; it belongs at
`.github/workflows/pages.yml` (a token without the `workflow` scope can't
push it there).

## Keep it true

- The Download page's platform list and notes follow `docs/releasing.md`
  ("Linux builds") and the README's Install section; asset names are
  matched in `src/download/release.ts`.
- The iOS / Android status lines come from `docs/mobile.md` ("App Store
  submission", "One-time, by the owner"): change them when the apps are
  public.
- The privacy policy mirrors `mobile/public/privacy.html` and
  `docs/telemetry.md`; change both when data handling changes. The phone
  app links `https://theodore.cloud/privacy` (`mobile/src/config.ts`).
- Feature copy comes from `README.md`, `docs/plan.md`, `docs/spaces.md`,
  `docs/fleet.md`, `docs/mobile.md`: nothing the docs don't say.

## Staging

A push to `staging` that touches `site/` deploys the Pages branch `staging`:
https://staging.theodore-site.pages.dev, and https://staging.theodore.cloud
(a proxied CNAME `staging` → `staging.theodore-site.pages.dev` in the
theodore.cloud zone). Production (`main`) stays https://theodore.cloud.
