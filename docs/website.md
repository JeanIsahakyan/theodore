# Website: theodore.cloud

The public site in `site/`: a Vite + React + TypeScript app in the desktop's
look (HeroUI v3, Tailwind, Geist, the same tokens as `ui/src/styles.css`),
prerendered to static HTML and served by Cloudflare Pages.

```
site/
  index.html            the template: theme script, favicon, <!--app-head-->, <!--app-html-->
  src/app/              App, the tiny router, routes + meta, head tags, theme (as the desktop's)
  src/pages/            Home, Download, Releases, Privacy, Terms, Space (/s/<id>), NotFound
  src/demo/             the hero story: an agent asks, the phone answers, a PR opens
  src/mocks/            product UI built from the app's pieces (chat, review, spaces, phone)
  src/releases/         the changelog's entries: which releases count, a markdown renderer
  src/shared/           LogoArt and Ring, copied from ui/src (no store); colours from @desktop
  src/download/         platform detection, the latest GitHub release
  src/space/            the space link page's logic: id, channel, which buttons (tested)
  scripts/prerender.mjs one HTML per route, 404.html, sitemap.xml, releases.json, fonts
                        preloaded; the latest release, the stars and the changelog baked in
  public/               favicon, og.png, robots.txt, _headers, _redirects, .well-known/
  deploy/pages.yml      the GitHub Actions workflow, to move into .github/workflows/
```

| Page | Path | Content |
| --- | --- | --- |
| Home | `/` | the night band: hero + live demo, trust strip; Spaces, Review, Your phone (each with a live mock), the rest as a list, open source, CTA |
| Download | `/download` | the visitor's platform first; every asset of the latest release; iOS / Android / web status |
| Changelog | `/releases` | every app release (`v*` tags, no drafts or pre-releases), newest first, notes rendered from markdown; the newest ten open, older ones folded |
| Privacy | `/privacy` | the privacy policy for the desktop, the phone app and the cloud (the App Store listing links it) |
| Terms | `/terms` | terms for the open-source apps and the hosted cloud |
| Space link | `/s/<id>` | "Opening this space in Theodore…": opens the space in the app for the visitor's platform ("Space links" below); `noindex`, not in the sitemap |

## Build

```sh
pnpm -C site install
pnpm -C site dev                  # http://localhost:4173
pnpm -C site typecheck && pnpm -C site lint && pnpm -C site format:check && pnpm -C site test
pnpm -C site build                # site/dist: client build, SSR build, prerender
```

`test` is vitest over the pure modules (`src/space/open.test.ts`: which
buttons each platform gets, the staging channel, what counts as a space
id); pages are not rendered in tests.

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
- The look is the desktop's: HeroUI's tokens (background, surfaces,
  separators, greys, the accent and its buttons), light or dark. The site
  adds only `--ink-2` (body text, darker than `--muted`), soft layered
  shadows instead of borders, and the app's `--warning` as the attention
  dot where the agent waits for you.
- Scenes (`src/demo/useScene.ts`): the hero and the three mocks play when
  scrolled into view and again when they come back, pause off screen and in
  a hidden tab, and keep their final frame for the server, no JavaScript
  and reduced motion. The hero loops (~13 s) from its key frame (the
  question on the computer, the push on the phone). Motion is transform and
  opacity (plus one progress ring), ease-out entrances, one short overshoot
  on things that land.
- Release notes are rendered by `src/releases/markdown.ts`, which escapes
  every string and emits only its own tags; a release whose notes are empty
  or only GitHub's generated "What's Changed" list shows as "Maintenance
  release".

## Space links

`https://theodore.cloud/s/<id>` is what a space's PR footer carries
(docs/spaces.md §6 "PR body") and what Theodore writes wherever it shares
a space link: one address that opens the space on the desktop, the phone
or the web app. The page knows the id and nothing else — it fetches
nothing and shows no space data; it says so: "Only devices signed in to
your organization and trusted by your computer can open it."

```
GET /s/<id>  ─▶ public/_redirects: /s/* /s/index.html 200 ─▶ the prerendered shell (src/pages/Space.tsx)
  browser ─▶ id from the address (src/space/open.ts: [A-Za-z0-9_-]{1,64}, else "This isn't a space link")
          ─▶ platform (src/download/platform.ts) ─▶ channel (the host: theodore.cloud = production,
             anything else = staging: theodore-staging://, app-staging.theodore.cloud)
  iPhone / Android ─▶ with Theodore Code installed the OS opened the app before this page
  │                   (Universal Links / App Links, below); here: Open in Theodore Code
  │                   (theodore-mobile://space/<id>) · Open in the web app · Get the app
  macOS / Linux    ─▶ location = theodore://space/<id> at once; after 1.5 s, the page still here:
  │                   Open in Theodore · Open in the web app (app.theodore.cloud/space/<id>) · Download Theodore
  other            ─▶ Open in the web app · Download Theodore
```

The server renders the waiting state only; the browser adds the buttons
after it mounts, so hydration matches whatever the id is. The route is
`noindex` and left out of the sitemap.

**Universal Links and App Links** (`public/.well-known/`, served by Pages
as is; `public/_headers` gives both `Content-Type: application/json` — the
Apple file has no extension):

| File | Names | Paths |
| --- | --- | --- |
| `/.well-known/apple-app-site-association` | `J33CB2C73P.app.theodore.mobile` (team + the bundle id in `mobile/app.json`) | `/s/*` |
| `/.well-known/assetlinks.json` | package `app.theodore.mobile`, its signing certificate's SHA-256 | all (`handle_all_urls`; the intent filter limits it to `/s/`) |

The Android fingerprint is **a placeholder until the owner fills it in**
(`PLACEHOLDER_ANDROID_SIGNING_CERT_SHA256_REPLACE_ME`): the signing key
lives on EAS, not in the repo — `eas credentials -p android` shows the
SHA-256 of the app signing key (for Play, the Play Console's "App
signing" key). Until then Android verification fails and the link opens
in the browser, whose page offers the app; iOS needs nothing more than the
file and the entitlement (`ios.associatedDomains` in `mobile/app.json`,
docs/mobile.md "Space links"). The staging site serves the same files, so
a staging build's links (`applinks:staging.theodore.cloud`) verify too.

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
| Headers | `public/_headers`: immutable cache for `/assets`, nosniff, referrer policy, no framing; `application/json` for the two `.well-known` files |
| Rewrites | `public/_redirects`: `/s/*` to the space link shell, status 200 |

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
- The space link page's schemes and hosts (`src/space/open.ts`) follow
  `identity::url_scheme` (`theodore`, `theodore-staging`), `mobile/app.json`
  (`theodore-mobile`) and docs/cloud.md "Hosts on theodore.cloud"
  (`app[-staging].theodore.cloud`); the association files follow
  `mobile/app.json` (`mobile/test/routes.test.ts` checks them against it).

## Staging

A push to `staging` that touches `site/` deploys the Pages branch `staging`:
https://staging.theodore-site.pages.dev, and https://staging.theodore.cloud
(a proxied CNAME `staging` → `staging.theodore-site.pages.dev` in the
theodore.cloud zone). Production (`main`) stays https://theodore.cloud.
