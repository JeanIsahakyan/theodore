# Live QA

Click-test the real app from a script: real webview, real core, real git.
An agent writes JS to a directory; the app runs it and writes back the result.

```
agent ──▶ $QA/driver/in/<id>.js ──(polled, 50 ms)──▶ main webview: eval
                                                          │
agent ◀── $QA/driver/out/<id>.json ◀── event `qa-result` ◀┘
          {"ok": <value>} | {"err": "<stack>"}

          $QA/driver/window   the window number, for `shot`
```

macOS only. `scripts/qa/`: `build.sh`, `kit.sh`, `qa`, `lib.js`. Driver:
`apps/desktop/src/qa_driver.rs`.

## Never in a shipped binary

The driver runs any JS with every Tauri command in reach.

```
cargo feature `qa-driver` ──off by default──▶ no module, no call, no string
        │ on
        ▼
build.rs: THEODORE_BUILD_ENV ── dev ──────────▶ builds
                              └ production, staging, nightly ──▶ build fails
```

- The app needs the feature **and** `THEODORE_QA_DRIVER` at run time.
- A test (`no_release_path_enables_the_qa_driver`) fails if a workflow or a
  release script names the feature or `--all-features`.
- `build.sh` stops if the driver isn't in the binary.
- Local builds aren't for real use (AGENTS.md, "Installing Theodore").

## Build

```sh
scripts/qa/build.sh    # app + CLI into ${THEODORE_QA_APP:-/tmp/theodore-qa/app}
```

One build serves every parallel run.

It is `Theodore QA.app`, `app.theodore.desktop.qa`: `build.sh` stops if the
result has any other identifier. Webview storage goes by identifier, so it is
apart from an installed Theodore's. It registers no URL scheme, so `theodore://`
still opens the installed app; sign-in and space links don't reach a QA build.

## Run

```sh
export QA=/tmp/theodore-qa/run1      # yours alone
. scripts/qa/kit.sh
start_sandbox                        # or start_live
q 'click("Pull requests"); await sleep(800); return text()'
shot pulls                           # $QA/pulls.png
stop_app
```

| Name | What |
| --- | --- |
| `start_sandbox` | simulated host, from `theodore sandbox init` |
| `start_live` | real GitHub; needs `THEODORE_QA_REPO` |
| `q '<js>'` | run a function body (`return …`), helpers in scope |
| `shot <name>` | capture the window to `$QA/<name>.png` |
| `screen_locked` | `locked` or `unlocked`: what a failed or blank capture means |
| `clear_ui_state` | forget this build's tabs, theme and UI state, and reload |
| `stop_app` | quit like ⌘Q |
| `qa_gh …` | `gh`, scoped to `THEODORE_QA_REPO` |

| Env | Default | |
| --- | --- | --- |
| `QA` | `/tmp/theodore-qa/run` | this run: driver, data, log, screenshots |
| `THEODORE_QA_APP` | `/tmp/theodore-qa/app` | where the build is |
| `THEODORE_QA_REPO` | none | live only: the one repo a run may write to |
| `QA_WAIT` | `400` | `q` timeout, tenths of a second |

Every `q` is logged with a timestamp to `$QA/driver/calls.log`: sent, answered or
timed out.

`lib.js` helpers: `click`, `fire`, `byText`, `clickables`, `context`, `key`,
`type`, `waitFor`, `text`, `inv`, `hover`, `escDrag`, `setSetting`,
`openRepoRow`; spaces and diffs: `ws`, `newSpace`, `composer`, `say`, `files`,
`card`, `hunkOf`; `sleep`.

## First steps on a fresh data dir

No project yet means New space's Create stays disabled. Add one, and pick a
cheap model before anything spends: opening a PR groups it, and skills run on
the global model.

```sh
git init -q "$QA/repo" && git -C "$QA/repo" commit -q --allow-empty -m init
q "return await inv('add_project', {req: {repo: null, path: '$QA/repo'}})"
q "return await setSetting('agents.claude.model', 'haiku')"
```

`ws()` only knows the sandbox's projects; for any other, click its name.

## Sandbox or live

| | sandbox | live |
| --- | --- | --- |
| host | simulated (docs/sandbox.md) | GitHub |
| writes land in | bare repos and a state file under `$QA/data` | `THEODORE_QA_REPO` |
| tokens | none | your `gh` / keychain login |
| CI, other people | timed, or `theodore sandbox …` | real |
| agents | agent CLIs, or `"agents": "replay"` | agent CLIs |
| rate limit | none | GitHub's, shared |
| use it for | every flow it can show | what only the real host can |

Real in both: the webview, the core, the store, the outbox, git, the agents.
Not real in either: the mouse and the keyboard (synthetic events), and the
production build (no account sign-in, no telemetry keys).

Drive the sandbox from outside with the same data dir:
`THEODORE_DATA_DIR=$QA/data "$THEODORE_CLI" sandbox push 101`.

## Isolation and parallel runs

Each run keeps its driver, data and log in its own `QA` dir; `$QA/data` is its
`THEODORE_DATA_DIR`, so a run never touches an installed Theodore.

Runs of one build do share its webview storage (localStorage: tabs, theme, UI
state). A run that reads any of it starts with `clear_ui_state`; parallel runs
shouldn't assert on it at all.

```
one build ($THEODORE_QA_APP) ──▶ QA=/tmp/theodore-qa/a   driver, data, log
                             ├─▶ QA=/tmp/theodore-qa/b   driver, data, log
                             └─▶ QA=/tmp/theodore-qa/c   driver, data, log
```

GitHub's API limit is per account, so parallel live runs share it. A run that
sees rate-limit errors has found the limit, not a bug. Prefer the sandbox for
all but one tester.

## Rules for a live run

| Rule | Held by |
| --- | --- |
| `THEODORE_QA_REPO=<owner/name>` is the only repo a run may write to | `start_live` refuses without it |
| Every `gh` call is scoped to it | `qa_gh` refuses what it can't scope |
| `report.github_repo` is set to it before any Report a problem | `start_live` sets and verifies it, else stops the app |
| Never click an Inbox or Pull requests row, or a PR's tab, unless the DOM names that repo (a row's `data-key="github:<owner>/<name>#<n>"`, a tab's is its route as JSON) | `await openRepoRow(row)` refuses any other, and opens the row or tab; never `fire` a row directly |
| Don't read or change `~/.theodore*`, tokens or credentials | `kit.sh` refuses a `QA` there; otherwise the tester |

The login is real, so the app can see every repo it can. Sticking to
`THEODORE_QA_REPO` is on the tester.

## Limits and workarounds

| Limit | Do |
| --- | --- |
| Judging layout | `shot` at key moments and read the image. It captures by window number: it never raises the window or touches the mouse, so someone can work on the same machine |
| `shot` fails, or the PNG is blank | `screen_locked`. `locked` (or asleep): fall back to DOM geometry (`getBoundingClientRect`) and say so in the report. `unlocked`: the capture itself failed, check the app and its window number |
| An occluded window may stop firing `requestAnimationFrame` | check first: `q 'return await rafAlive()'`. Only if `false`: `unthrottle()` (rAF on a timer, `scrollIntoView` forced to `behavior:'auto'`) and `finishAnims()` |
| A hidden or locked window throttles timers to about 1 Hz | sample what changes with a `MutationObserver`, not `setInterval` |
| A synthetic click on a draggable row starts a drag | `await escDrag()` after it, but never after opening something: Esc means back |
| A list row only gets selected by a click | Enter on it, or a double click; `openRepoRow` does it |
| A tab doesn't open on a synthetic click | `tab.focus()`, then `key('Enter', {}, tab)` |
| Synthetic Escape doesn't close a `keep` menu | don't count on Esc to dismiss one; assert on what's open before moving on |
| `shot` right after a theme change catches it mid-way | wait about 1 s first |
| A `q` that times out keeps running in the page | it isn't cancelled: read `$QA/driver/calls.log` before trusting later state |
| `inv` of an unknown command never answers | `q` gives up after 40 s; check the name in `ui/src/gen/bindings.ts` |
| No real pointer, so no hover | `hover(el)` |
| A driver-less build starts fine, then `q` times out | `build.sh` checks; `start_*` fail after 40 s with no window file |
