# Theodore

Theodore is a local-first desktop app for reviewing pull requests. It runs AI
agent CLIs you already have installed — Claude Code, Codex, Gemini CLI — on
your machine, inside a git worktree of the PR, to group the diff by meaning,
find issues, and propose fixes. The agents help; you decide what goes out as
a review.

```
                    git diff (file order)          Theodore (meaning order)
                    ─────────────────────          ─────────────────────────
                    api/handler.ts                 1. new data model
                    db/migration.sql                  db/migration.sql
                    model/user.ts         ──▶         model/user.ts
                    tests/user.test.ts             2. API using it
                    ui/profile.tsx                    api/handler.ts
                                                       ui/profile.tsx
                                                    3. tests
                                                       tests/user.test.ts
```

![Review grouped by meaning](docs/screenshots/03-review-grouped.webp)

More in [docs/screenshots](docs/screenshots/README.md).

## What works today

### Inbox and triage
- PR inbox split into sections: review requested, assigned, authored, mentioned.
- Snooze until a push, until checks go green, or for a fixed time; wakes automatically.
- Triage a review request: take, decline or reassign it.
- Keyboard-first: full list navigation, ⌘K command palette, `?` for shortcuts.

### Pull requests and branches
- One list of the workspace's PRs, filtered to All (open), Mine (grouped by what each needs to merge), Drafts or Merged.
- A Branches page per project: ahead/behind, the PR a branch belongs to, and a local folder's checked-out branch and uncommitted files.

### Projects and workspaces
- Add, browse and remove projects from any configured host, or a local folder.
- A switcher in the sidebar's corner scopes the whole app to *All projects* or one project; each keeps
  its own tabs, filters and position, restored on switch. ⌃0 / ⌃1…9 switch without the menu; drag
  projects in Settings → Projects to set that order.
- Open a local review of a branch against its project's base, with no hosted PR; it takes no host
  actions and stays out of PR counts.

### The review screen
- Diff grouped by meaning into titled groups, each with a *why*, a checklist and a risk; a tour bar steps through them.
- Groupings are versioned: a grouping from an older algorithm is redone automatically on open; ↻ regroups from scratch.
- Keyboard-driven reading, with per-hunk read state.
- Interdiff: after a push, only new/changed hunks are flagged, with a "what changed" view.
- Markdown diffs have a rendered Preview next to the code; image diffs show side by side, swipe or onion skin.
- ⌘-click an identifier for definitions and references across the worktree, found with `git grep` and per-language patterns — not a language server.
- Narrow windows: Peek hides itself beside lists, and the review header goes icon-only.

### Comments, suggestions and reactions
- Threads: reply, resolve — written back to the host.
- Draft comments, submitted together as one review.
- Suggested-change blocks, applied as a commit on the branch.
- Reactions.

### The AI panel
- Chat scoped to a PR, a group, or a single line. The agent reads what the PR changed through the
  review tools (the worktree holds only the head), so answers are about the diff.
- Skills: `SKILL.md` files — three built in (`bugs`, `security`, `tests`), plus `~/.claude/skills`
  and the repo's own `.claude/skills`. Several configured agents run in sequence; findings merge.
- Findings turn into draft comments, tasks, or get a proposed fix attached.
- Tasks: delegate to an agent, which edits inside the PR worktree. Accepting commits+pushes (your
  own or a local PR) or drafts a suggestion (someone else's PR); rejecting resets the worktree.
- No cost display, budget or limit in the app (owner, 2026-10-22). The grouping eval harness
  (`theodore eval`) still reports what its runs cost.

### Merge, checks and conflicts
- Merge, enqueue, auto-merge, update branch; reviewer and draft-state changes; re-running a check.
- Conflicts computed locally against the current base branch tip with `git merge-tree --write-tree`,
  not read from the host's (possibly stale) mergeability flag.

### Hosts
| | GitHub | GitLab | Bitbucket Cloud |
| --- | --- | --- | --- |
| Server-side viewed state | yes | no | no |
| Batched review (drafts → submit) | yes | yes | no — posts immediately |
| Resolve thread | yes | yes | yes |
| Suggestions | yes | yes | no |
| Merge queue / auto-merge | yes | no queue, has auto-merge | no |
| Reactions | yes | yes | no |
| Auth | keychain → `gh auth token` → `GITHUB_TOKEN` → OAuth device flow | personal access token | app password or access token |

GitHub is the most complete adapter. GitLab and Bitbucket are real, tested
implementations too, not stubs — just narrower, matching each host's API.

### Linear (read-only)
- Issue keys found in a PR's title, branch name or body are looked up and
  shown as chips in Peek and Review. No token stored means an empty list,
  never an error. No write-back.

### Settings
- Per-host sign-in, agent selection split by task (grouping, chat, skills,
  fix — default Claude for each).

### Theodore account (required where configured)
- Where the account is configured, signing in is required: until then the window shows only the
  sign-in, and the core turns away every command that does work (`account_required`) and holds
  the poller and outbox. On first launch it's the first onboarding step, with no Skip.
- Your email opens the hosted sign-in page on its code step and Theodore picks the sign-in up
  when you finish; a device code covers signing in from another machine. Client-only (PKCE, no
  secret in the app): the installed app gets the sign-in back through `theodore://callback`, a
  dev run through a loopback redirect. Session in the keychain.
- Offline is fine: a stored session keeps the app usable, and only a definitive rejection of
  the session signs you out ("Your session ended — sign in again"). Signing out (Settings →
  Account) brings the sign-in back; local data is never deleted.
- The client id comes from `THEODORE_WORKOS_CLIENT_ID` (env, or compiled into release and
  nightly builds) or the `account.workos.client_id` setting. A dev build without one has no
  account and no sign-in; sandbox and fixture modes never have one. Setup in `docs/plan.md`
  §6.12.

### Labs: spaces (hidden)
- A *space* is a change before it is a PR: an agent writes it in its own worktree while you
  chat, watch the diff and review it grouped, then ship it — **Open PR** (one squashed commit on
  `<login>/<slug>`, ready or draft), **Push** further turns, or for a local folder **Merge
  locally** / **Keep as branch**. Auto-archive. Off by default; design and switch in
  `docs/spaces.md`.

### Project config
- `.theodore/config.yaml` in the repo (shared), `.theodore/config.local.yaml` (yours) and
  `~/.theodore/config.yaml` (global), layered. `review:` picks agents per task; `spaces:` sets up a
  space — files to copy, free ports, env, and `setup` / `run` / `check` / `archive` commands.
  Commands from a repo run only after you allow them. Every key: `docs/config.md`.
- `review:` also feeds the repo's instructions and files to every agent run, hides or marks
  files skimmable in the grouping, adds checklist items, auto-runs skills and drops findings by path.
  A review reads it from the base branch, so a PR can't change how itself is reviewed.
- Settings → Projects → ⟨project⟩ → Config creates the file from your current settings, checks it
  as you type, and saves it to the repo (a PR for a host project), your local file or the global one.

### Updates
- Checks for a new build on launch and every 6 hours, on a stable or beta
  channel. Restarts only once no agent is running and the outbox is empty.
  (No signed release has shipped yet — see **Not yet**.)

### Logs, error reports and usage data
- Everything is logged locally to `~/.theodore/logs/theodore.jsonl` (JSON lines, rotated, ≤ 50 MB),
  redacted first: tokens, emails, the home directory, and never diff, file or comment text.
  `THEODORE_LOG=debug` for more; `jq` recipes in `docs/telemetry.md`.
- Two remote sinks, off unless the build or settings configure them *and* you opt in (onboarding's
  "Help improve Theodore", or Settings → About & updates): error reports over OTLP (e.g. New
  Relic) and typed product events to PostHog. Both use a random install id, not your account;
  repository names are hashed.
- **Report a problem** (Help menu, Settings, the error screen) zips the redacted logs and app info
  for you to attach; nothing is uploaded. Events, codes, rules and settings: `docs/telemetry.md`.

## How it works

```
UI (React + MobX object pool, resource() cache for immutable data)
   │   Tauri IPC: commands / events
   ▼
Rust core — same code inside the desktop app and the `theodore` CLI
   contract → app (use cases, sync engine, outbox, poller)
                │
              domain (pure logic: groups, anchors, interdiff,
                      findings, tasks, snooze — no I/O)
                ▲
              ports (Host · Git · Agent · Store · Secrets · Clock)
                ▲
   ┌────────────┼───────────────┬──────────────┬───────────┐
host-github   git (CLI;     agents (claude/   mcp           store
host-gitlab   one worktree  codex/gemini      "review-tools" (SQLite)
host-bitbucket per PR;      runners; stream   HTTP server +  secrets
(+ host-http:  conflicts    parsing, cancel/  per-run token; (keychain)
 ETag, retry,  via          stall, cost)      stdio bridge
 rate limit)   merge-tree)                    for stdio-only CLIs
```

**Local-first sync.**

```
UI edit ──▶ transaction ──▶ core validates (domain) ──▶ SQLite + sync log (id N)
                                   │
UI  ◀── sync{actions, N} event ────┤
                                   └──▶ outbox ──▶ host write (resumable, idempotent)

poller (ETag poll of open PRs, cursor poll of the inbox) ──▶ same apply path ──▶ sync log ──▶ UI
```

Every change — yours, an agent's, or something the poller noticed — becomes
one `SyncAction` with a monotonically increasing id. The UI has one inbound
stream and one object pool fed by it. Host writes go through an outbox:
resumable steps, an idempotency marker so a retried comment isn't posted
twice, backoff that depends on the error kind.

**Grouping.**

```
diff ─▶ hunks ─▶ pre-pass (hide lockfiles/generated/vendored; flag pure
                 renames/whitespace-only/import-only as skim candidates)
      ─▶ split by top-level directory, up to 3 chunks in flight
      ─▶ one agent call per chunk ─▶ validate (must partition all hunk ids)
             ├─ ok ──────────────────────────▶ groups
             └─ invalid ─▶ one repair call ─▶ still invalid ─▶ "Other"
      ─▶ merge pass (order across chunks) ─▶ coarsen (merge tiny groups)
```

Each stored grouping carries an algorithm version (`ALGO_VERSION`, currently
`2`). Reopening a PR or a push past a version bump regroups automatically;
the Review screen's Regroup button forces it on demand.

## Run it

Prerequisites:
- Rust stable (edition 2024, `rust-version = "1.90"`, pinned in `rust-toolchain.toml`).
- `pnpm` for the `ui/` workspace.
- `git` ≥ 2.38 — conflict detection needs `merge-tree --write-tree`.
- `cargo install tauri-cli --version "^2" --locked`, for `cargo tauri …`.
- At least one agent CLI, installed and logged in: `claude`, `codex`, or `gemini`. Claude Code's
  runner is the best-tested; Gemini's flags are unverified against a real install.

Dev:

```sh
cd apps/desktop
cargo tauri dev --no-watch
```

Release build:

```sh
cargo tauri build
```

Auth: GitHub tries, in order, a keychain token, `gh auth token`, the `GITHUB_TOKEN` env var, then
the "Sign in with GitHub" OAuth device flow once `THEODORE_GITHUB_CLIENT_ID` (or the
`host.github.client_id` setting) is set. GitLab and Bitbucket take a pasted token or app password
(`GITLAB_TOKEN` / `BITBUCKET_TOKEN`) — no device flow for those yet.

Data lives in `~/.theodore`: a bare clone per repo under `repos/`, one git
worktree per PR under `wt/`, one per space under `spaces/`, and `theodore.db` (SQLite).

Sandbox: `theodore sandbox init <dir>` then `THEODORE_SANDBOX=<dir>` runs the app against a
simulated host with its own data in `~/.theodore-sandbox` — faults, offline, scripted agents
(`docs/sandbox.md`).

Local nightly: `scripts/nightly-build.sh` builds a DMG numbered by commit count
(`docs/releasing.md`).

CLI:

```sh
theodore group <pr-url> [--agent claude|codex|gemini] [--model <name>] [--json] [--save <dir>]
theodore eval <fixtures-dir> [--agent claude|codex|gemini] [--model <name>]
theodore mcp-bridge --url <mcp-url>   # stdio↔HTTP bridge for CLIs without HTTP MCP
```

## Develop

```
crates/
  domain/         models, invariants, diff/interdiff, anchors, grouping, snooze
  contract/       command + sync types; generates ui/src/gen/*.ts
  app/            use cases, sync engine, outbox, poller, settings, built-in skills
  ports/          trait definitions: HostAdapter, GitPort, AgentPort, Store, Secrets, Clock
  host-http/      shared HTTP client for GitHub/GitLab: auth, ETag, rate limit, retry, redaction
  host-github/    GraphQL + REST adapter, device-flow auth
  host-gitlab/    REST v4 adapter
  host-bitbucket/ REST adapter, its own HTTP transport (Basic or Bearer auth)
  linear/         read-only GraphQL client (issue linking)
  git/            clone, worktree, diff → hunks, conflict detection
  agents/         claude / codex / gemini CLI runners, stream parsers, process lifecycle
  grouping/       grouping pipeline: pre-pass, prompt, validation, repair, coarsen, eval
  mcp/            "review-tools" MCP server + stdio bridge
  store/          SQLite schema, migrations, sync log, outbox
  secrets/        keychain (shells to /usr/bin/security)
  runtime/        host token resolution (keychain → gh/env fallback)
  fixtures/       recorded PRs, diffs and agent streams for tests and eval
apps/
  desktop/        the Tauri app
  cli/            `theodore` — grouping eval, debugging, the MCP stdio bridge
ui/               React app, MobX sync client, gen/ (generated TS types)
e2e/              WebDriver specs against the real core with fixture adapters
```

Checks (see `lefthook.yml` and `.github/workflows/ci.yml`):

| Part | Command |
| --- | --- |
| Rust format | `cargo fmt --all --check` |
| Rust lint | `cargo clippy --workspace --all-targets -- -D warnings` |
| Rust tests | `cargo test --workspace` |
| UI | `pnpm -C ui typecheck`, `pnpm -C ui lint`, `pnpm -C ui test`, `pnpm -C ui build` |
| Contract bindings up to date | regenerate (below), then `git diff --exit-code -- ui/src/gen` |
| Grouping quality | `theodore eval apps/cli/fixtures/` — fails below the M1 targets |
| E2E | `tauri-driver` against the real core with fixture adapters, on Linux |

Regenerating generated TS bindings:

```sh
cargo run -p theodore-contract --bin export-ts
cargo run -p theodore-desktop -- --export-bindings
```

Git hooks (`lefthook install` once per clone):
- **pre-commit** — trailing whitespace / conflict markers (`git diff --cached --check`), a large-file check, `cargo fmt --check` on staged Rust files.
- **commit-msg** — Conventional Commits format.
- **pre-push** — `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, `pnpm -C ui typecheck`, `pnpm -C ui lint`.

## Not yet

- Signed releases: the updater's signing key is still a placeholder in
  `tauri.conf.json`; every build so far is ad-hoc signed only.
- Notarization and a Developer ID (release workflow has the steps, no
  secrets configured yet).
- Linux and Windows builds — macOS (Apple Silicon) only.
- `theodore://` deep links for OAuth callbacks (planned, not wired into the
  Tauri config).
- GitLab OAuth/PKCE sign-in — personal access token only today.
- Skills running on several agents at once in parallel (they run in
  sequence; findings still merge).
- A Theodore server: the account sign-in is client-only; billing, sync and uploading problem
  reports need it (reports are local zips for now).
- Spaces beyond shipping: "Send to agent" from review threads, undo a turn, setup/check scripts,
  notifications.
