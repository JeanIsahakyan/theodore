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

## What works today

### Inbox and triage
- PR inbox split into sections: review requested, assigned, authored, mentioned.
- Snooze until a push, until checks go green, or for a fixed time; wakes automatically.
- Triage a review request: take, decline or reassign it.
- Keyboard-first: full list navigation, ⌘K command palette, `?` for shortcuts.

### My PRs
- A view of PRs you authored, filtered by the signed-in host account.

### Projects and branch reviews
- Add, browse and remove projects from any configured host.
- Open a local review of a branch against its project's base, with no hosted PR; stays out of PR counts.
- Groupings are versioned; reopening after an algorithm change or a push offers a Regroup.

### The review screen
- Diff grouped by meaning into titled groups, each with a *why*, a checklist and a risk; a tour bar steps through them.
- Keyboard-driven reading, with per-hunk read state.
- Interdiff: after a push, only new/changed hunks are flagged, with a "what changed" view.
- Markdown diffs render as rendered Markdown, not raw text; image diffs render side by side.
- A per-file symbol outline via `git grep` — not a language server, so no cross-file go-to-definition.

### Comments, suggestions and reactions
- Threads: reply, resolve — written back to the host.
- Draft comments, submitted together as one review.
- Suggested-change blocks, applied as a commit on the branch.
- Reactions.

### The AI panel
- Chat scoped to a PR, a group, or a single line.
- Skills: `SKILL.md` files — three built in (`bugs`, `security`, `tests`), plus `~/.claude/skills`
  and the repo's own `.claude/skills`. Several configured agents run in sequence; findings merge.
- Findings turn into draft comments, tasks, or get a proposed fix attached.
- Tasks: delegate to an agent, which edits inside the PR worktree. Accepting commits+pushes (your
  own or a local PR) or drafts a suggestion (someone else's PR); rejecting resets the worktree.
- A per-PR USD budget, checked before every agent run. Claude's cost is tracked in real dollars;
  Codex and Gemini report tokens but not cost yet.

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

### Settings and budget
- Per-host sign-in, agent selection split by task (grouping, chat, skills,
  fix — default Claude for each), live AI spend per PR against a configured
  limit.

### Updates
- Checks for a new build on launch and every 6 hours, on a stable or beta
  channel. Restarts only once no agent is running and the outbox is empty.
  (No signed release has shipped yet — see **Not yet**.)

## How it works

```
UI (React + MobX object pool, resource() cache for immutable data)
   │   Tauri IPC: commands / events
   ▼
Rust core — same code inside the desktop app and the `theodore` CLI
   contract → app (use cases, sync engine, outbox, poller)
                │
              domain (pure logic: groups, anchors, interdiff,
                      findings, tasks, snooze, budget — no I/O)
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
worktree per PR under `wt/`, and `theodore.db` (SQLite).

CLI:

```sh
theodore group <pr-url> [--agent claude|codex|gemini] [--model <name>] [--json] [--save <dir>]
theodore eval <fixtures-dir> [--agent claude|codex|gemini] [--model <name>]
theodore mcp-bridge --url <mcp-url>   # stdio↔HTTP bridge for CLIs without HTTP MCP
```

## Develop

```
crates/
  domain/         models, invariants, diff/interdiff, anchors, grouping, snooze, budget
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
- Cost tracking for Codex and Gemini runs (tokens are recorded, USD is not).
- Accounts, billing, telemetry.
