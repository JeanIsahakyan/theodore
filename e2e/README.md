# UI e2e

WebdriverIO driving the real Theodore app (Tauri 2) through `tauri-driver`,
on the fixture adapters (plan §12, §12.1). Not a mock UI: the same `app` +
`domain` core as production, with `theodore_runtime::RuntimeConfig::fixtures`
pointed at `crates/fixtures/data/demo`.

## Why Linux only

`tauri-driver` has no WebDriver backend for WKWebView (macOS). It only
drives:

- Linux: WebKitWebDriver (`webkit2gtk`)
- Windows: Microsoft Edge WebDriver

So these specs run on Linux (CI: `ubuntu-latest`, see the `ui-e2e` job in
`.github/workflows/ci.yml`), not on a macOS dev machine. On macOS, the only
thing to check locally is that this package and the specs compile:

```sh
cd e2e
pnpm install
pnpm typecheck
```

## Running on Linux

1. System packages (the CI job installs these; see the workflow for exact
   package names per Ubuntu version):
   - `webkit2gtk-4.1` (the webview Tauri 2 uses) and its WebDriver,
     `webkit2gtk-driver`
   - `xvfb` (no real display in CI)
2. `tauri-driver`, built once and cached:
   ```sh
   cargo install tauri-driver --locked
   ```
3. Build a debug app binary (no need to package a `.app`/`.deb`; the raw
   binary is enough for WebDriver):
   ```sh
   cd apps/desktop
   cargo tauri build --debug
   ```
   This also runs `pnpm -C ../../ui build` per `beforeBuildCommand` in
   `tauri.conf.json`, so the UI bundle is current.
4. From `e2e/`, with the binary path and the fixtures directory both set:
   ```sh
   cd e2e
   pnpm install
   export TAURI_APP_BINARY="$(realpath ../target/debug/Theodore)"
   export THEODORE_FIXTURES="$(realpath ../crates/fixtures/data/demo)"
   xvfb-run --auto-servernum pnpm test
   ```
   `wdio.conf.ts` spawns `tauri-driver` itself (`onPrepare`/`onComplete`);
   `tauri-driver` in turn spawns `$TAURI_APP_BINARY`, inheriting this
   shell's environment — that's how `THEODORE_FIXTURES` reaches the app
   without any WebDriver-specific plumbing.

## Specs

| File | Covers |
| --- | --- |
| `specs/inbox.e2e.ts` | Inbox lists both demo PRs |
| `specs/open-pr-groups.e2e.ts` | Opening a PR shows the fixture's grouping |
| `specs/mark-group-read.e2e.ts` | "Mark as read" flips a group's hunks |
| `specs/draft-and-submit.e2e.ts` | Comment → draft → `Submit review` → thread |
| `specs/run-skill-finding.e2e.ts` | `/security` → a real MCP `add_finding` → a finding card |

`specs/helpers.ts` holds the steps shared across all of them (onboarding,
opening PR #101, switching to the grouped view).

## Selector note

Every selector here was written by reading the component source
(`ui/src/ui/*.tsx`), not by running the app — this environment has no
`tauri-driver` for WKWebView, so nothing here has been confirmed end to end
against a live window. The structure (ARIA labels, class names like
`.prrow`/`.grp`/`.draft`/`.thread`/`.finding`, button text) is exactly what
the current components render, but a first CI run is the real check;
expect to adjust a selector or a wait if the markup has since moved.
