# Theodore — build plan

Theodore is a standalone desktop app for code review. Local AI agents regroup a
pull request by meaning, so the reviewer reads it as logical steps, not as an
alphabetical list of files. The agents help; the reviewer decides.

---

## 1. Decisions

| # | Decision | Status |
| --- | --- | --- |
| D1 | Everything in Rust except the UI | decided |
| D2 | UI = React + HeroUI | decided |
| D3 | Shell = Tauri 2; no Node sidecar | decided |
| D4 | UI ⇄ core is local-first sync: transactions up, sync log deltas down | decided |
| D5 | No server in v1. The "backend" is the local Rust core | decided |
| D6 | Code hosts behind a `HostAdapter` with capabilities; GitHub first | decided |
| D7 | Own HTTP client for hosts (`reqwest` + `cynic`); `gh` only as a token source | decided |
| D8 | Agents = the user's installed CLIs (`claude`, `codex`, `gemini`), spawned by core | decided |
| D9 | MCP `review-tools` served by core over localhost HTTP, one token per run; stdio bridge for CLIs without HTTP MCP | decided |
| D10 | git through the git CLI, not libgit2 | decided |
| D11 | SQLite for state; OS keychain for secrets | decided |
| D12 | macOS (Apple Silicon) first | decided |
| D13 | UI state = MobX object pool + a small `resource()` cache; no TanStack Query, no router | decided |
| D14 | UI runs only inside Tauri; no browser mode, no fake core — dev and e2e use the real core with fixture adapters | decided |
| D15 | Agent per task is a setting (grouping, chat, skills, fixes), default Claude | decided |
| D16 | Auto-update from this repo's GitHub Releases, built in from the first version | decided |
| D17 | Data lives in `~/.theodore` | decided |
| D18 | Later, not v1: accounts and billing, telemetry, Linux and Windows | decided |
| D19 | Tooling: `specta` + `tauri-specta` for TS types and typed commands, `rusqlite` for SQLite, `pnpm` for the UI | decided |
| D20 | No Apple Developer ID yet: releases are ad-hoc signed, not notarized; CI adds Developer ID signing + notarization once secrets exist | decided |

---

## 2. Architecture

### 2.1 Layers

```
┌─ shell ───────── Tauri 2: windows, menus, updater, deep links, signing
│
├─ ui ──────────── React + HeroUI + MobX object pool
│        │  knows only the contract — no fetch, no fs
│        ▼
├─ contract ────── commands, sync actions, ephemeral events → generated TS types
│        ▼
├─ app ─────────── use cases: openPr, group, runSkill, submitReview, onPush …
│        │         sync engine (apply → sync log → deltas), outbox, scheduler
│        ▼
├─ domain ──────── pure logic, no I/O, unit-tested
│                  groups + invariants, read → viewed, anchors, interdiff,
│                  findings merge, task lifecycle, snooze, budget
│        ▲
├─ ports ───────── traits: Host · Git · Agent · Store · Secrets · Clock
│        ▲
└─ adapters ────── host-github · git-cli · agent CLIs · mcp · sqlite · keychain
```

Rules:
- `domain` depends on nothing but std/serde. No tokio, no I/O.
- `app` depends on `domain` and `ports` only. Adapters are injected.
- The core is headless: the same `app` runs inside Tauri and inside the CLI.
  The UI runs only inside the Tauri app; there is no browser mode.

### 2.2 Processes

```
┌──────────────── Theodore.app ─────────────────┐
│ WKWebView (ui) ◀── Tauri IPC ──▶ Rust core     │
│                                   │  │  │      │
└───────────────────────────────────┼──┼──┼──────┘
                                    │  │  └──▶ GitHub API (HTTPS)
                                    │  └─────▶ git CLI ──▶ ~/.theodore/{repos,wt}
                                    ▼
                    claude / codex / gemini CLI   (cwd = PR worktree)
                                    │
                                    └──▶ http://127.0.0.1:<port>/mcp  (review-tools)
```

### 2.3 Repository layout

```
crates/
  domain/        models, invariants, diff/interdiff, anchors
  contract/      command + sync types; specta generates ui/src/gen/*.ts
  app/           use cases, sync engine, outbox, scheduler
  ports/         port traits: HostAdapter, GitPort, AgentPort, Store, Secrets, Clock
  host-http/     shared HTTP client for host adapters: auth, ETag, limits, retry
  host-github/   GraphQL (cynic) + REST, notifications polling, ETag
  host-gitlab/   M7
  linear/        read-only GraphQL client for Linear (issue linking, §6.10)
  git/           clone, worktree, diff → hunks, blobs
  agents/        CLI runners, stream parsers, process lifecycle, cost
  grouping/      grouping pipeline: pre-pass, prompt, validation, repair, eval
  mcp/           review-tools server (rmcp), stdio bridge
  store/         SQLite schema, migrations, sync log
  secrets/       keychain
apps/
  desktop/       Tauri app
  cli/           `theodore …` headless commands (grouping eval, debugging)
ui/              React app + sync client
docs/
```

---

## 3. Sync model (UI ⇄ core)

### 3.1 Flow

```
UI                                   core                                   GitHub
──                                   ────                                   ──────
edit ─▶ ObjectPool (instant)
   └─▶ TransactionQueue ──invoke──▶ validate (domain) ─▶ SQLite + sync log N
                                       │
   ◀── event sync{actions, N} ─────────┤
                                       └─▶ outbox ──────────────────────▶ mutation
                                              ◀── ok: mark done
                                              ◀── fail: compensating action N+1 ─▶ UI
agent / poller ──────────────────────▶ same apply path ─▶ sync log ─▶ UI
```

- Every change — user, agent, GitHub poll — becomes a `SyncAction` with a
  monotonically increasing `syncId`. The UI has one model and one inbound stream.
- UI reload: bootstrap from core, then catch up from `lastSyncId`.
- Undo/redo: an undo queue that replays inverse changes as new transactions.

### 3.2 What goes through the sync log

| Synced (mutable, persisted) | Not synced |
| --- | --- |
| PR list rows, inbox state, snooze | Diff hunks and file contents — immutable per commit, fetched by query |
| Read state per hunk, Viewed per file | Agent token stream — ephemeral `agent:delta` events; only the final message is synced |
| Groups (and regroupings) | Skill run log lines — ephemeral, last N kept in memory |
| Threads, comments, drafts | Syntax highlighting — computed in UI |
| Findings, fixes, tasks | |
| Chat messages (final), skill run status, usage | |
| Settings | |

### 3.3 Sync design choices

| Choice | Why |
| --- | --- |
| No client-side database | core is local; bootstrap over IPC is fast |
| Tauri IPC and events as the only transport | one process boundary, no network stack between UI and core |
| Subscription per open PR | PR models load lazily, only when opened |
| Single window | no cross-tab locking needed |
| Sync log + apply path in Rust (`app` + `store`) on SQLite | core is the single source of truth |
| MobX models, object pool, transaction queue, undo queue in `ui/src/sync` | instant UI, per-object re-render |
| `resource(key, load)` for immutable data (hunks, file contents): dedup, loading/error, LRU | data keyed by sha never needs invalidation, so no query library |
| Navigation = tab state in the pool, no router | a desktop app has no address bar |

### 3.4 External truth

GitHub owns threads, comments, Viewed, reviews, checks. Core applies the local
change first, sends it through the outbox, and reconciles:
- success → nothing to do (or merge server ids into the model);
- user-visible failure → compensating action + toast;
- conflict on poll (someone else changed it) → GitHub wins, UI gets the delta.

Offline / 401 / rate limit → outbox pauses; reads come from SQLite.

---

## 4. Domain model

```
Repo 1─* Pr ─* PrRevision (head sha) ─* File ─* Hunk ─(group)─▶ Group
              │                               ▲
              │                               └─ HunkRead (per user, per hunk)
              ├─* Thread ─* Comment          Anchor = revision + path + side + line[..line]
              ├─* Draft ─────────────────────▶ Anchor
              ├─* Finding ─▶ Anchor, agents[], skill, severity, Fix?
              ├─* Task ─▶ Anchor?, Thread?, assignee (human | agent)
              ├─* SkillRun, ChatMessage, Usage
              └── Snooze, Baseline (last reviewed revision)
```

Key rules (all in `domain`, all unit-tested):

| Rule | Detail |
| --- | --- |
| Hunk in exactly one group | Grouping output is rejected unless it is a partition of the hunk ids |
| Viewed from reads | A file is Viewed only when every hunk of it is read, across groups |
| Push dismisses | A changed hunk loses its read mark; its file goes `DISMISSED` |
| Anchor is host-neutral | `rev`, `path`, `side` (old/new), `line`, `start?`; adapters map it to the host's position format (§6.3) |
| Anchors move | After a push, anchors are remapped through the old→new diff; a deleted line makes the anchor outdated |
| Findings merge | Same file + overlapping lines + similar title → one finding, `agents[]` grows |
| Task lifecycle | `todo → progress → review → done`; accept resolves the linked thread |
| Fix target | Own or local PR → commit + push; someone else's PR → suggestion draft |

Hunk identity across revisions: `(path, normalized content hash)`, with a
fallback match by overlapping new-side range. Needed for read state, groups and
anchors to survive pushes.

---

## 5. Grouping (core risk)

This is the part the product stands on, and the least proven. Build and
measure it first, before any UI work.

### 5.1 Pipeline

```
diff ─▶ hunks with ids
   ─▶ deterministic pre-pass
        • hidden: lockfiles, linguist-generated, vendored, snapshots
        • skim candidates: pure renames, formatting-only, import-only
   ─▶ agent call (PR title, body, commits, hunk list) ─▶ JSON
   ─▶ validate (partition, known ids, order, required fields)
        ├─ ok ─▶ groups
        └─ errors ─▶ one repair call with the error list
                       └─ still bad ─▶ leftovers go to group "Other"
```

Output schema per group: `id` (stable slug), `title`, `why`, `kind`
(`normal | skim | hidden`), `risk?`, `check[]`, `hunks[]`, `outliers[]`, plus a
global reading order.

### 5.2 Large PRs

- Hunk list sent as headers + a few lines each; the agent reads full code with
  its own read/grep tools in the PR worktree when it needs to.
- Above a size threshold: split by top-level directory, group each part, then a
  merge pass over group summaries.

### 5.3 Re-grouping after a push

Unchanged hunks keep their group. Only new and changed hunks are sent, together
with the existing groups, and the agent assigns them or proposes new groups.
Group ids stay stable.

### 5.4 Eval harness (`apps/cli`)

```
theodore group <pr-url> [--agent claude] [--json] [--save fixtures/]
theodore eval fixtures/            # replays saved PRs, prints a table
```

| Metric | Target for M1 exit |
| --- | --- |
| Valid partition on first call | ≥ 90 % |
| Valid after repair | 100 % (with "Other" fallback) |
| Latency, PR ≤ 50 files | ≤ 60 s |
| Cost per PR | recorded; budget decided after M1 |
| Human rating 1–5 on 10 real PRs | ≥ 4 average |

---

## 6. Code hosts

### 6.1 Crates

```
app ──▶ host::HostAdapter (traits, host-neutral models, capabilities)
            │
            ├─ host-github     GraphQL (cynic, typed against the schema) + REST
            ├─ host-gitlab     REST v4 (+ GraphQL where it is simpler)   — M7
            └─ host-bitbucket  REST 2.0                                 — M7.1
            │
            └─ host::http   one client for GitHub and GitLab:
                 auth injection · ETag cache · rate limiter · retry/backoff ·
                 token redaction in logs
```

`host-bitbucket` owns a second, smaller HTTP client rather than sharing
`host::http`: that one only ever sends `Authorization: Bearer`, and
Bitbucket's app-password flow needs Basic auth instead (§6.8).

`reqwest` + `cynic`, no `octocrab`: we need full control over ETags, limits and
retries, and would use a fraction of it.

### 6.2 Adapter

Split by area, not one monolith:

```
HostAdapter
  ├─ capabilities() ─▶ { viewed, pending_review, suggestions, merge_queue, auto_merge, … }
  ├─ inbox      changed_since(cursor) · search(section)
  ├─ pulls      get(ref, etag) · files · commits · checks
  ├─ reviews    submit(ReviewDraft) · set_viewed
  ├─ threads    reply · resolve · edit · delete · react
  └─ merge      merge · enqueue · auto_merge · update_branch
```

- A missing feature returns `Unsupported`; the UI hides it up front from
  `capabilities()`.
- The interface is validated against GitLab before it is frozen (M7), not
  derived from GitHub alone.

### 6.3 Host-neutral models

The adapter translates both ways; the domain never sees host formats.

| Domain | GitHub | GitLab | Bitbucket |
| --- | --- | --- | --- |
| `Anchor{rev, path, side, line, start?}` | `commit_id, path, side, line, start_line, start_side` | `position{base_sha, start_sha, head_sha, old/new_path, old/new_line}` | `inline{path, from, to}` |
| `PrRef` | node id + `owner/repo#n` | project id + iid | workspace/repo + id |

Host ids are opaque strings inside the domain.

### 6.4 Capabilities by host

| Feature | GitHub | GitLab | Bitbucket Cloud |
| --- | --- | --- | --- |
| Viewed per file on the server | `markFileAsViewed` | no (kept locally) | no (kept locally) |
| Batched review (drafts → submit) | pending review | draft notes + bulk publish | no — comments post immediately, approve/request-changes is a separate call |
| Resolve thread | yes | yes (discussions) | yes |
| Suggestions | yes | yes | no |
| Merge queue | yes | merge trains | no |
| Checks | checks + statuses | pipelines | build statuses |

Where the host has no server-side Viewed, it is stored locally and does not
sync with the host's web UI.

### 6.5 GitHub operations

| Area | Calls |
| --- | --- |
| Read | GraphQL `pullRequest{files{viewerViewedState} reviewThreads reviewRequests commits statusCheckRollup}`, `search` for inbox sections |
| Viewed | `markFileAsViewed`, `unmarkFileAsViewed` |
| Review | one `addPullRequestReview` with all `threads` inline → `submitPullRequestReview` |
| Threads | `addPullRequestReviewThreadReply`, `resolveReviewThread`, `unresolveReviewThread`; REST edit/delete/react |
| Suggestions | `createCommitOnBranch` («Apply N suggestions») |
| People | `requestReviews`, REST remove requested reviewer |
| Merge | `mergePullRequest`, `enqueuePullRequest`, `enable/disablePullRequestAutoMerge`, `updatePullRequestBranch`, `markPullRequestReadyForReview` |
| Checks | REST rerequest check run, commit status |

Sending all threads in one mutation avoids N calls and the secondary limit on
content creation.

### 6.6 Change detection (no webhooks)

```
GitHub:    GET /notifications  (If-Modified-Since, honours X-Poll-Interval)
              └─ something changed ─▶ GraphQL for the changed PRs only
           open PR: GET /pulls/{n} with ETag every 10–30 s (304s are free)
GitLab:    ?updated_after=<cursor>
Bitbucket: re-lists the viewer's involved PRs every poll — no indexed
           "updated after" filter cheap enough to use as a real delta probe
```

GraphQL is POST, so it has no conditional requests: polling the inbox through
GraphQL `search` is expensive, notifications are nearly free.

The notifications API needs a classic token (`gh`, OAuth app, classic PAT) with
`notifications` or `repo` scope; fine-grained PATs and GitHub App tokens don't
get it. For those, fall back to GraphQL `search` on a slow interval.

### 6.7 Outbox, idempotency, errors

- Every host write goes through the outbox as resumable steps. Where the host
  has no batch (Bitbucket), comments are posted one by one and the outbox
  resumes from the last confirmed step.
- No idempotency keys on GitHub: each comment body carries
  `<!-- theodore:<draft-id> -->` (invisible when rendered). After a timeout the
  outbox looks for it before retrying, so nothing is posted twice.
- One error type for all adapters:
  `Auth · RateLimited{reset_at} · NotFound · Conflict · Validation · Network · Unsupported`.
  The outbox decides from it: wait, retry, or roll back with a compensating action.

### 6.8 Auth (no server)

| Host | Method |
| --- | --- |
| GitHub | `gh auth token` if present → else OAuth device flow (client id only) → else PAT |
| GitLab | OAuth + PKCE or PAT |
| Bitbucket Cloud | app password (Basic, `username:app_password`) or an access token (Bearer) |

Tokens live in the keychain. Never in `.git/config`, never in process arguments,
never in the webview.

#### GitHub device-flow client id

The "Sign in with GitHub" button (Onboarding and Settings → Account) runs
GitHub's OAuth device flow — no pasted token, no `gh` required — but it needs
an OAuth app's client id. Theodore never ships one; the owner creates a GitHub
OAuth App (device flow enabled, no client secret needed) and configures its
client id one of two ways, checked in this order:

1. The `THEODORE_GITHUB_CLIENT_ID` environment variable.
2. The `host.github.client_id` setting (Settings → Account writes this
   indirectly today only through `THEODORE_GITHUB_CLIENT_ID`; setting it
   directly is a `transact` on the `setting` model, scope `user`).

With neither set, `host_status`'s `device_login_available` is `false`, the
button is hidden, and sign-in falls back to `gh`'s own login or a pasted
token — nothing else about auth changes.

### 6.9 Tests

- One contract test suite, run against every adapter on recorded HTTP fixtures
  (wiremock).
- Opt-in live smoke test against a sandbox repo.

### 6.10 Linear (read-only)

A separate integration, not a `HostAdapter`: Linear isn't a code host, and its
personal API keys authenticate with a bare `Authorization: <key>` header (no
`Bearer` prefix) — the opposite of every host adapter's convention — so the
`linear` crate talks to `reqwest` directly instead of building on `host::http`.

```
app ──▶ linear::LinearClient ──▶ https://api.linear.app/graphql
            │
            ├─ viewer()          validates a token, returns the user + workspace
            └─ issue(identifier) one issue by its key ("ABC-123")
```

- **Linking.** PR titles, head branch names and bodies are scanned for issue
  keys (`[A-Z][A-Z0-9]+-\d+`); every match is looked up and returned by
  `linear_issues`. With no token stored this returns an empty list, never an
  error — the feature is additive, not a gate.
- **Caching.** Results are kept in memory per PR for about five minutes:
  Peek and the Review header both ask on every render, and Linear's API has
  no conditional-GET story the way GitHub's ETags do.
- **Token.** `set_linear_token` validates the key against `viewer` before
  storing it (mirrors `set_host_token`); `linear_status` reports
  connected/user/workspace for Settings → Integrations.
- **Scope.** Read-only. Creating or updating a Linear issue from Theodore is
  future work, not covered here.

### 6.11 Bitbucket

`PrRef.repo.owner`/`.name` are the workspace and repo slug directly — unlike
GitLab's nested namespaces, Bitbucket slugs are always one path segment, so
there is no project-id lookup to cache.

Bitbucket's `/pullrequests/{id}` endpoint returns a flat list with no
"discussion" object; a thread is reconstructed by walking each comment's
`parent` id up to its root, and the root's `resolution` field (present once a
thread is resolved) carries the thread's resolved state. Comments anchor to a
diff with `inline{path, to, from}` — one line per comment, so a multi-line
`Anchor` collapses to its end point on write and never round-trips back as a
range.

`merge_strategy` is one of `merge_commit` / `squash` / `fast_forward`;
`MergeMethod::Rebase` maps to `fast_forward`, the closest analogue to a true
rebase-and-merge Bitbucket has (it fails outright if the branches diverged,
rather than rebasing).

Capabilities: `resolve_threads` only. No server-side Viewed, no pending/draft
review, no suggestions, no merge queue, no auto-merge, no reactions — the UI
hides those from `capabilities()` the same way it does for any other host
gap. `merge_status`, reviewer management and draft-state toggling stay
`Unsupported` for now; `viewer`, `search`/`search_repo`, `get_pr`,
`submit_review`, the thread operations, `list_repos` and `merge` are real.

---

## 7. Git

```
~/.theodore/
  repos/<host>/<owner>/<repo>.git      bare clone
  wt/<host>-<owner>-<repo>-<n>/        worktree per PR at pull/<n>/head
  theodore.db                          SQLite
```

- All via `git` CLI under `tokio::process`, with `GIT_TERMINAL_PROMPT=0` and a
  credential helper that reads the token from core (`git -c credential.helper=…`).
- `diff --no-color --find-renames -U<n> base...head` parsed into files and hunks;
  binary, LFS, submodule and generated files flagged, not dropped.
- Size limits per file and per PR; oversize files collapsed with a reason.
- Never: hard reset of user branches, deleting unmerged branches, writing tokens
  to disk.
- Worktree GC: drop worktrees of closed PRs after N days; locked while an agent
  runs in it.

---

## 8. Agents

### 8.1 Runners

| Agent | Invocation | Stream |
| --- | --- | --- |
| Claude Code | `claude -p --output-format stream-json --verbose --mcp-config <json>` | JSON lines |
| Codex | `codex exec --json` (+ MCP config) | JSON lines |
| Gemini CLI | `gemini -p --output-format stream-json` (+ MCP settings) | JSON lines |

Exact flags and MCP-over-HTTP support per CLI are verified in M1/M4. If a CLI
only speaks stdio MCP, it gets `theodore mcp-bridge --url … --token …` — our own
binary as a stdio→HTTP proxy.

Each runner normalizes its stream into one event type:
`Text · Thinking · ToolCall · ToolResult · Usage · Done · Error`.

### 8.2 Lifecycle

```
spawn (cwd = worktree) ─▶ stream ─▶ Done
   │                                      │
   ├─ cancel ─▶ SIGTERM ─▶ 5 s ─▶ SIGKILL │
   ├─ silent 90 s ─▶ stalled (UI: restart / switch agent)
   └─ exit ≠ 0 ─▶ failed with stderr tail
```

- Credentials: each CLI uses its own login. Core does not read or copy them.
- Reading code: agents use their own read/grep tools in the worktree; MCP adds
  only what the worktree cannot give (PR context, groups, base files, findings).
- Env: Theodore's own secrets are removed from the child env; the agent's own
  auth variables (e.g. `ANTHROPIC_API_KEY`) are passed through.
- Permissions: review runs are read-only (tool allowlist: read, grep, MCP).
  Fix runs may edit, only inside the PR worktree.
- Pinned minimum CLI versions; stream parsers covered by recorded fixtures.

### 8.3 MCP `review-tools`

| Tool | Returns / does |
| --- | --- |
| `get_pr_context()` | title, body, commits, files, groups |
| `get_group(id)` | group with its hunks |
| `get_base_file(path)` | file at the base revision (the worktree has only head) |
| `add_finding(file, line, severity, title, body)` | creates a finding → sync log → UI |
| `propose_patch(file, before, after, note)` | attaches a fix to a finding |

### 8.4 Skills, chat, cost

- Skills: `SKILL.md` from `~/.claude/skills` and the repo's `.claude/skills`.
  Claude loads them natively; other agents get the text in the prompt.
- A skill can run on several agents in parallel; findings merge (§4).
- Chat: questions about the PR, a group, or a line; replies stream as ephemeral
  events and are stored when complete.
- Usage: tokens and USD per run, per PR budget, hard stop at the limit.

### 8.5 Agent selection

Which agent does what is a setting, layered user → repo:

| Setting | Default | Notes |
| --- | --- | --- |
| `agents.grouping` | `claude` | one agent |
| `agents.chat` | `claude` | switchable per message in the UI |
| `agents.skills` | `[claude]` | a list: skills can run on several agents at once |
| `agents.fix` | `claude` | one agent; edits only in the PR worktree |
| `agents.<id>.enabled`, `.path`, `.model` | detected on onboarding | CLI path and model override |

`theodore group --agent <id>` overrides the setting for evals. M1 ships the
Claude runner; the others follow in M4 behind the same runner trait.

---

## 9. Storage and secrets

- SQLite via `rusqlite` (WAL), migrations in `store`, applied on start; one DB
  per user profile.
- Tables: models from §4 + `sync_log(id, model, model_id, action, data)` +
  `outbox(id, op, payload, attempts, status)`.
- Keychain: one item for all Theodore secrets (one prompt). On macOS through
  `/usr/bin/security` so the prompt survives rebuilds; secret passed on stdin,
  not as an argument.

---

## 10. UI

| Part | Plan |
| --- | --- |
| Screens | Inbox + peek, My PRs, All PRs (list ↔ board), Tasks, Review (groups │ diff │ AI/tasks/threads), Settings, Onboarding |
| Look | HeroUI, own colour tokens, Shiki highlighting, Geist fonts, Gravity UI icons |
| Types | generated from the Rust contract, never hand-written |
| State | MobX object pool fed by the sync stream; `resource()` for immutable data; no business logic in the UI |
| Actions | every action is a transaction or a command; nothing is faked with timers |
| Dev and e2e | the real Rust core with fixture adapters (§12.1); no fake core in TS |

Every component subscribes to the objects it reads, not to the whole state.

---

## 11. Shell, packaging, release

- Tauri 2, one main window, `titleBarStyle: Overlay`.
- Strict CSP (no remote scripts; Shiki and fonts bundled). Capabilities scoped
  to the commands the UI needs.
- Deep link `theodore://` for OAuth callbacks and "open PR in Theodore".

### 11.1 Updates (from the first version)

The updater ships in M0, so every build ever released can update itself.

```
git tag v0.3.0 ──▶ CI release workflow
                    build .app ─▶ sign ─▶ [notarize] ─▶ DMG ─▶ sign ─▶ [notarize]
                    .app.tar.gz + .sig (updater key)
                    latest.json {version, notes, url, signature}
                    └─▶ GitHub Release v0.3.0 on JeanIsahakyan/theodore (public)

app ──▶ on launch + every 6 h
        GET github.com/JeanIsahakyan/theodore/releases/latest/download/latest.json
        newer? ─▶ download in background ─▶ verify signature
               ─▶ "Restart to update" (never forced)
               ─▶ restart waits until: no agent running, outbox empty
```

| Topic | Rule |
| --- | --- |
| Mechanism | `tauri-plugin-updater` + `tauri-plugin-process`; manifest from GitHub Releases, no server |
| Signing key | generated once, private key + password in CI secrets, public key in `tauri.conf.json`. **Never rotated**: a new key orphans every installed build |
| Channels | `stable` = `/releases/latest/` (GitHub skips pre-releases there); `beta` = a fixed pre-release tag `channel-beta` whose `latest.json` is overwritten. Setting `updates.channel` |
| Versioning | semver; the tag must equal the version in `Cargo.toml` and `tauri.conf.json` (CI check) |
| Tags | never re-tag a published release; ship a new patch instead |
| Data | SQLite migrations forward-only; DB copied to `theodore.db.bak-<version>` before migrating; downgrade not supported |
| UX | Settings → About: version, channel, "Check now", release notes of the pending update |
| Failure | download or signature failure → keep the current version, retry next check, show nothing scary |
| Test | every release workflow run also tests the update path: install N-1, update to N, app starts |

Platform: `darwin-aarch64` only in v1; the manifest format already allows more
platforms later.

### 11.2 Signing without an Apple Developer ID (now)

| Step | Now (ad-hoc) | With Developer ID (later) |
| --- | --- | --- |
| Code signature | `codesign -s -` (ad-hoc, required on Apple Silicon) | Developer ID Application + hardened runtime |
| Notarization | none | `notarytool` + staple, app and DMG |
| First install | Gatekeeper blocks it: System Settings → Privacy & Security → "Open Anyway", or `xattr -dr com.apple.quarantine /Applications/Theodore.app` | opens normally |
| Updates | work: the updater downloads outside the browser, so no quarantine flag, and checks its own signature | same |
| Keychain prompt after update | none: secrets go through Apple-signed `/usr/bin/security`, not our changing signature | same |

- The release workflow has the Developer ID and notarization steps from day one,
  skipped while the secrets are absent. Adding the secrets turns them on; no
  other change.
- Switching to Developer ID later does not break the update chain: the updater
  trusts its own key, not the Apple identity.
- README gets an "Install" section with the first-launch steps until then.

---

## 12. Quality gates

| Part | Checks |
| --- | --- |
| Rust | `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` |
| UI | `tsc --noEmit`, lint, Prettier, unit tests |
| E2E | the Tauri app on the real core with fixture adapters (§12.1) |
| Contract | generated TS is up to date (CI diff check) |
| Grouping | `theodore eval fixtures/` — no regression in validity |
| Agents | stream parser fixture tests per CLI version |

All wired into lefthook pre-push and CI.

### 12.1 Fixture adapters

Dev runs and e2e use the real `app` + `domain` with adapters swapped by config:

```
Tauri app ──▶ app + domain (real)
               ├─ host:   fixture — PRs, threads, checks from JSON
               ├─ git:    recorded repos in fixtures/
               ├─ agents: replay of recorded CLI streams
               └─ clock:  controlled time (snooze, polling, stalls)
```

Demo events (author push, checks green, agent crash) are fixture triggers, not
UI code. E2E drives the app through `tauri-driver` (WebDriver). It has no macOS
driver for WKWebView, so e2e runs on Linux CI.

---

## 13. Milestones

```
M0 scaffold ─▶ M1 grouping spike ─▶ M2 core + sync + UI ─▶ M3 GitHub ─▶ M4 agents
                                                               │
                         M7 GitLab ◀─ M6 ship ◀─ M5 re-review ◀┘
```

| M | Scope | Exit | Sessions |
| --- | --- | --- | --- |
| M0 | Cargo workspace, `ui/` package, Tauri hello window, contract codegen, checks in lefthook, updater + release workflow | `cargo test` + `tsc` green; window opens; v0.0.1 → v0.0.2 updates itself from GitHub Releases | 1–2 |
| M1 | `domain` diff model, `git` (clone, worktree, diff), minimal GitHub read (token from `gh`), minimal Claude runner (JSON in the final message, no MCP yet), grouping + validation, `theodore group/eval` | §5.4 targets on 10 real PRs | 1–2 |
| M2 | `store`, sync engine, `app` skeleton, Tauri wiring, UI with MobX object pool, fixture adapters | real PR opens read-only in the app, grouped | 2 |
| M3 | Inbox sections, Viewed sync, threads, drafts → submit, notifications + ETag polling, outbox, offline | full review round-trip on a real PR | 1–2 |
| M4 | MCP server, skill runs on several agents, findings merge, chat, fixes, tasks, budget | skill → findings → draft/task/fix works on claude + codex | 1–2 |
| M5 | Push detection, interdiff, DISMISSED, incremental regroup, anchor remap, snooze by event | author push handled without losing reads or comments | 1 |
| M6 | Onboarding, layered settings UI, keychain, beta channel, big-PR performance | signed DMG installs and updates on a clean Mac | 1–2 |
| M7 | GitLab adapter; freeze `HostAdapter` | same review round-trip on GitLab | 1 |
| M7.1 | Bitbucket Cloud adapter (§6.10) | same review round-trip on Bitbucket | 1 |

Total: ~11–14 sessions to v1 on GitHub, +1 for GitLab, +1 for Bitbucket.

Later: LSP go-to-definition, Linear integration, merge queue UI, org settings
via repo file, Windows/Linux, accounts and billing, telemetry.

Spaces — the stage before a pull request, where an agent writes the change in
its own worktree and you review it by meaning before it becomes a PR — are
designed in `docs/spaces.md` and ship hidden behind `FEATURES.buildMode`.

---

## 14. Risks

| Risk | Mitigation |
| --- | --- |
| Grouping quality, latency or cost is not good enough | M1 is a gate: measure before building the rest |
| CLI output formats change | pinned minimum versions, fixture tests, one normalizer per CLI |
| A CLI lacks HTTP MCP | stdio bridge in our binary |
| GitHub rate limits with many PRs | notifications + ETag (304s are free), adaptive poll intervals, one-mutation reviews |
| Huge PRs (10k+ lines) freeze the UI | virtualized diff, size limits, lazy hunk loading |
| Anchors drift after force-push | remap via diff; fall back to "outdated" like GitHub |
| Agents touching files they shouldn't | read-only allowlist for review, edits only in the worktree |
| No WebDriver for WKWebView on macOS | e2e on Linux CI (WebKitGTK); manual smoke on macOS per release |

---

## 15. Open questions

None right now.
