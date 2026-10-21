# Spaces — the stage before a pull request

A **space** is a change while it is being made. You open one in a project, say
what you want, and an agent writes the code in an isolated worktree while you
watch the diff, review it by meaning, and send comments back. When it is good,
the space becomes a pull request — the same branch, the same history — and
Theodore's existing review, inbox and merge flow takes over.

Ships hidden: `FEATURES.buildMode = false`, turned on per machine by the
`labs.build_mode` setting (Settings → Labs, §10).

---

## 1. One object, three stages

```
              DRAFTING                         IN REVIEW                    DONE
┌──────────────────────────────┐   ┌──────────────────────────────┐
│ New space ─▶ agent turns ──┐ │   │ PR #123 (inbox, checks,      │
│     ▲        (checkpoints) │ │   │ reviewers, merge)            │
│     └── review · comments ◀┘ │──▶│     ▲            │           │──▶ merged ──▶ archived
└──────────────────────────────┘   │     └─ threads ◀─┘ → agent   │
         "Open PR"                 └──────────────────────────────┘
         (host project)
         "Keep as branch"  ─────────────────────────────────────────▶ branch ──▶ archived
         (local folder)
```

The PR is the space's continuation, not a copy: `space.pr` points at it, the
space page shows its state, reviewer threads become agent tasks in the same
space, and a push from the space updates the PR.

| Stage | Space shows | Who acts | Ends when |
| --- | --- | --- | --- |
| Drafting | chat · live diff vs base · spend | you + the agent | Open PR / Keep as branch |
| In review | the same, plus PR checks, reviews, threads | reviewers → you → the agent | merged or closed on the host |
| Done | read-only transcript and final diff | — | archived (auto, 7 days after merge) |

## 2. The core loop

```
you                         Theodore core                              agent CLI
───                         ─────────────                              ─────────
New space "fix-login"  ──▶  worktree ~/.theodore/spaces/<id> @ main
"make the redirect…"   ──▶  chat_message(me) · status=running ──spawn─▶ edits in cwd
   ◀── streaming text ────  Ephemeral AgentDelta ◀────────────────────── stream
                            turn ends: git add -A · commit "turn 1"
                            refs/theodore/spaces/<id> ─▶ checkpoint
   ◀── live diff ─────────  branch review row (base...checkpoint), no grouping
Review ▸               ──▶  same review, grouped by meaning (existing pipeline)
comment on a line      ──▶  draft ─▶ "Send to agent" ─▶ next turn ─▶ checkpoint 2
Open PR                ──▶  push <ref>:refs/heads/theo/fix-login ─▶ outbox create_pr
                            space.pr = github:o/r#123 ─▶ PR row, inbox, polling
reviewer comments      ──▶  thread ─▶ "Send to agent" ─▶ turn ─▶ Push ─▶ PR updated
merged                 ──▶  space stage = done ─▶ archive after 7 days
```

---

## 3. Where spaces live in the UI

**Decision: a "Spaces" section in every workspace's sidebar, under My PRs,
plus a "Drafting" group at the top of My PRs.** Two views over one object, not
a separate feature island.

- The sidebar is "what needs you now". Agents run in parallel and finish at
  unpredictable times; their state must be visible at a glance without
  opening anything — the same job the Inbox count does for review requests.
- My PRs is "all my changes, by stage": Drafting · In review · Merged. A space
  moves down that list as it moves through its stages.
- ⌘K "New space…" and the section's `+` both open the same dialog. ⌘K alone
  would hide running work.
- In "All projects" the section lists every project's spaces, prefixed with
  the project name; "New space" asks which project.
- A local-folder workspace has no Inbox or My PRs; its Spaces section is the
  only list, and Overview → Branches shows each space's branch.

### Sidebar

```
┌ ● migratro ▾ ──── ⌘K ┐
│ Overview             │
│ Inbox              2 │
│ My PRs             1 │
│ Tasks                │
│ Skills               │
│                      │
│ Spaces             + │
│ ◐ fix-login-redirect │  running
│ ● add-csv-export     │  turn done, not seen yet
│ ○ tidy-config        │  idle
│ ✕ bump-deps          │  failed
│ ⎇ #123 rate-limits ✓ │  in review: PR number + checks
└──────────────────────┘
```

| Glyph | Meaning | Source |
| --- | --- | --- |
| ◐ | agent running | `space.status = running` |
| ● | turn finished since you last looked | `space.updated_at` > last seen (UI-local) |
| ○ | idle | `idle` |
| ✕ | last turn failed or was interrupted | `failed` |
| ⎇ #n | PR open; tinted by checks | `space.pr` + its `pr` row |

### New space

```
┌ New space ──────────────────────────────────────┐
│ Project    migratro                        ▾    │
│ What should change?                             │
│ ┌─────────────────────────────────────────────┐ │
│ │ Retry the export job on 429s with backoff   │ │
│ └─────────────────────────────────────────────┘ │
│ Name       retry-export-429   (from the goal)   │
│ Branch     theo/retry-export-429  from  main ▾  │
│ Agent      claude ▾   Mode  Edit ▾              │
│                              [Cancel] [Start ⏎] │
└─────────────────────────────────────────────────┘
```

"Start" creates the worktree and sends the goal as the first message — the
first turn starts immediately. Name and branch are derived from the goal and
editable.

### Space page — drafting

Chat left, changes right. The diff is the whole branch vs its base, the same
`DiffPane` the review uses, refreshed after every turn.

```
┌ ◐ fix-login-redirect ── theo/fix-login-redirect ← main ── Drafting ── $0.42 / $5 ─┐
│ claude ▾  Edit ▾                                   [Review ▸] [Open PR] [⋯]      │
├──────────── chat ──────────────────┬──────────── changes ────────────────────────┤
│ you  The login page should send    │ 3 files  +42 −7   vs main · after turn 2    │
│      people back where they were…  │ ▾ src/auth/redirect.ts               +30 −5  │
│                                    │   @@ -10,6 +10,12 @@                         │
│ claude  I added a `next` param…    │   + const next = safeNext(params.get(…      │
│   ▸ 6 tool calls                   │ ▾ src/routes/login.tsx               +12 −2  │
│   ◆ turn 1 · a1b2c3 · 2 files      │   …                                         │
│                                    │                                             │
│ you  Also reject absolute URLs.    │                                             │
│ claude  ⠋ editing redirect.ts…     │                                             │
│                                    │                                             │
│ ┌────────────────────────────────┐ │                                             │
│ │ Ask the agent…  @file  /skill  │ │                                             │
│ └──────────────────── [Stop ⎋] ──┘ │                                             │
└────────────────────────────────────┴─────────────────────────────────────────────┘
```

### Space page — in review

The header gains the PR; the right pane gains Threads and Checks tabs.
Reviewer threads carry "Send to agent"; after the agent's turn, "Push" updates
the PR.

```
┌ ○ rate-limits ── PR #123 ⎇ theo/rate-limits ── In review ── ✓ 9/9 ── 2 threads ──┐
│ claude ▾  Edit ▾                         [Review ▸] [Push 1 turn] [Open on host] │
├──────────── chat ──────────────────┬── Changes │ Threads 2 │ Checks ─────────────┤
│ …                                  │ ● anna · limiter.ts:41                      │
│ ◆ turn 4 · 9f8e7d · pushed         │   "Should this be per-token, not global?"   │
│ ◆ turn 5 · 1c2d3e · not pushed     │   [Send to agent] [Reply] [Resolve]         │
│                                    │ ● ci-bot · README.md:12                     │
│                                    │   [Send to agent] …                         │
│                                    │                        [Send all to agent] │
└────────────────────────────────────┴─────────────────────────────────────────────┘
```

### Review of a space

"Review ▸" opens the normal Review tab for the space — groups by meaning, read
marks, tour, findings, skills. One difference while drafting:

```
┌ Review · fix-login-redirect (your space) ───────────────────────────────────────┐
│ Groups           │ diff …                                         │ AI · Tasks   │
│ 1 Redirect guard │ + if (!isSameOrigin(next)) return '/'          │              │
│ 2 Login wiring   │   💬 "also handle //evil.com" (draft)           │              │
├──────────────────┴────────────────────────────────────────────────┴──────────────┤
│ 3 drafts · 1 finding               [Send 4 to agent ▸]   (replaces Submit review) │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Drafts and accepted findings become one agent turn: each is a `task` with its
anchor, assigned to the space's agent. When the turn ends the tasks move to
`review`, and the next diff shows what changed since (the existing interdiff).

### Notifications

| Event | Space open | Elsewhere in the app | App in background (v2) |
| --- | --- | --- | --- |
| turn finished | diff refreshes | toast "fix-login: turn done · 3 files" [Open] + ● | macOS notification, dock badge = waiting spaces |
| turn failed | error card in chat | error toast [Open] + ✕ | notification |
| budget reached | composer locked, banner | toast | — |
| PR checks / reviews | header + tabs | existing inbox | existing |

---

## 4. What makes it Theodore's

- **Review is the product.** The agent's diff is reviewed with the same
  grouping, read state, tour, findings and skills as a teammate's PR. A
  space's review is an ordinary branch review (`open_branch` plumbing) whose
  head is the space's checkpoint.
- **Comments are instructions.** Drafts, findings and reviewer threads all
  turn into `task` rows aimed at the space's agent. The loop "read → comment →
  agent fixes → read what changed" uses tasks and interdiff, which already
  exist.
- **Budget per space.** `budget.per_space_usd` (repo-scoped, falls back to
  `budget.per_pr_usd`). Spend is summed from the space's chat rows, shown in
  the header and the sidebar tooltip; the composer locks at the limit.
- **Stages, not modes.** Writing code and reviewing it are one lifecycle;
  nothing is exported from one tool into another.

---

## 5. Agent control

| Mode | The agent may | Port mapping |
| --- | --- | --- |
| Ask | read, grep, MCP; no writes | `AgentMode::ReadOnly` |
| Edit (default) | + edit files in the space | `AgentMode::Edit` |
| Run | + shell commands (tests, installs) | needs a third `AgentMode`: today Claude's Edit already allows Bash, Codex's `workspace-write` runs commands in its own sandbox |

Mode is chosen per message and sticky per space.

- **Stop** cancels the run (SIGTERM → 5 s → SIGKILL, existing lifecycle), then
  checkpoints whatever was edited as "turn N (stopped)". Nothing is lost.
- **Resume** = send another message. Each turn gets the goal and the recent
  transcript, so a crash, a stop, or a different agent picks up where the
  last one left off. v2: native session resume when the agent stays the same
  (session id stored per run).
- **Switch agent or model** per message (picker in the header). Spend is
  tracked per message, so mixed spaces still add up.
- **Context**: `@path` mentions (stored as refs), paste a PR link to attach
  its description and diff stats, `/skill` runs a skill as the turn's
  instructions. MCP gets space-scoped tools in v2 (`get_space_context`: goal,
  base, diff stat, open tasks).
- **Scripts**: repo settings `spaces.setup` (once, after create — e.g.
  `pnpm i`) and `spaces.check` (after each turn; a failing check is fed into
  the next turn). Output streams as run log lines.
- **Safety**:
  - The agent's cwd is `~/.theodore/spaces/<id>`, a worktree of Theodore's own
    cache. The user's checkout and its `.git` are never written. A local
    folder project uses the existing mirror.
  - Theodore never pushes, opens a PR or writes into a local folder without
    an explicit click.
  - The prompt tells the agent to stay in its directory and not to push or
    switch branches. After each turn Theodore points the space ref at
    whatever `HEAD` is; a `HEAD` that no longer descends from the base is
    flagged instead of silently recorded.
  - Theodore's secrets are stripped from the agent env (existing).
  - Not an OS sandbox: a CLI with shell access can still leave its directory.
    Later: run agents under a macOS sandbox profile that only allows writes
    inside the space (open question 4).

---

## 6. Git model

```
~/.theodore/repos/<host>/<owner>/<repo>.git    bare cache
   ├─ refs/heads/*                ◀── force-fetched from the remote, pruned
   └─ refs/theodore/spaces/<id>   ──▶ last checkpoint   (Theodore's own ref)
~/.theodore/spaces/<id>/          detached worktree at the checkpoint + live edits

turn ends ─▶ git add -A ─▶ commit "turn N" ─▶ update-ref refs/theodore/spaces/<id> HEAD
Open PR   ─▶ git push origin refs/theodore/spaces/<id>:refs/heads/<branch>
Keep      ─▶ (local folder) git -C <folder> fetch <cache> <ref>:refs/heads/<branch>
```

Why detached plus a private ref, not a real branch in the cache:

| A branch under `refs/heads/` would… | Because |
| --- | --- |
| break every project refresh | `fetch +refs/heads/*:refs/heads/*` refuses to update a branch checked out in a worktree |
| be deleted before it is pushed | the same fetch runs with `--prune` |

Every turn is a commit, so the diff is commit-to-commit (cacheable, same as a
PR's revisions), "undo last turn" is a ref move (v2), and the agent's own
`git commit`s are simply kept. Checkpoints are authored by Theodore; "Open PR"
may squash them into one commit authored by you (open question 2).

---

## 7. Lifecycle and data

New synced model `space` (core-owned, written only by commands):

| Field | |
| --- | --- |
| `id`, `project`, `name`, `goal` | `goal` is the first message |
| `branch`, `base`, `base_sha`, `head_sha` | `branch` is pushed on Open PR; `head_sha` = last checkpoint |
| `worktree` | absolute path |
| `status` | `idle · running · failed · archived` |
| `agent`, `model`, `mode` | sticky per space |
| `review_pr` | the branch review the diff and Review use |
| `pr` | the host PR, once opened — the link from drafting to review |
| `usage`, `turns`, `error`, `created_at`, `updated_at` | |

| Data | Where |
| --- | --- |
| Transcript | `chat_message` rows with `pr = "space:<id>"` — the chat model, bootstrap, budget and UI already work on it |
| Streaming text, tool lines | `Ephemeral::AgentDelta` / `RunLog` with run id `space:<id>:<msg>`; not persisted |
| A turn | MVP: folded into the space row (`status`, `turns`, `head_sha`). v2: `space_run` rows (agent, mode, usage, checkpoint before/after, session id) for per-turn diffs, undo and resume |
| Code | the worktree and `refs/theodore/spaces/<id>` |

**Archive** checkpoints any uncommitted edits, removes the worktree, keeps the
ref and the rows; unarchive recreates the worktree from the ref. **Delete** is
archive plus deleting the ref and the chat rows. **GC**: archived spaces whose
branch was never pushed lose their ref after `spaces.gc_days` (30); removing
a project archives its spaces first. Space worktrees live outside
`~/.theodore/wt`, so the PR worktree sweep never touches them.

**Crash recovery**

| Found on start | Action |
| --- | --- |
| `status = running` | → `failed` "interrupted: Theodore was closed" |
| dirty worktree | kept; the next turn (or archive) checkpoints it first |
| worktree dir missing | recreated from `refs/theodore/spaces/<id>` |
| ref missing too | `failed`, transcript kept, "Restart from base" offered |

---

## 8. Concurrency

One run per space at a time; a send while running is refused (v2: queued).
Spaces run in parallel, each in its own worktree. v2: `spaces.max_parallel`
(default 3) queues the rest.

## 9. Commands (MVP)

| Command | Does |
| --- | --- |
| `create_space` | worktree + ref at the base, `space` row; sends `goal` as turn 1 when given |
| `list_spaces` | rows of one project or all (the UI reads the synced rows) |
| `space_send` | chat row, then an Edit-mode turn in the worktree; checkpoint; refresh the diff |
| `space_stop` | cancels the running turn |
| `space_review` | opens (or refreshes) the space's branch review; `group: true` also groups it |
| `archive_space` | checkpoint, remove the worktree, keep the ref |

## 10. The flag

| | flag off (default) | flag on |
| --- | --- | --- |
| Sidebar section, route, palette items, keys | absent | present |
| Settings → Labs | absent unless a `labs.build_mode` setting row exists | present |
| Core commands | registered, unused | used |

On = `FEATURES.buildMode || setting labs.build_mode = true`. To turn it on:
create the setting once (Settings → Labs appears), then flip the toggle.

---

## 11. Phasing

| Phase | Scope |
| --- | --- |
| **MVP** (this skeleton) | `space` model; create / send / stop / review / archive; Edit mode; transcript in chat rows; checkpoint per turn; sidebar section; space page with chat + diff; Review opens the grouped review; per-space spend shown; crash → failed |
| **v2** | Open PR (`HostAdapter::create_pr` + outbox, idempotent by head branch) and Push; Keep as branch for local folders; My PRs "Drafting" group; drafts/findings/threads → "Send to agent"; `space_run` rows, per-turn diffs, undo turn; modes Ask/Run; `budget.per_space_usd` enforced; setup/check scripts; notifications + dock badge; unarchive; queue + `max_parallel` |
| **Later** | native session resume per CLI; OS sandbox for agents; live diff during a turn (snapshot the working tree through a temporary index); squash on ship; spaces started from an issue or a failing check; several agents racing one goal, pick the best diff |

## 12. Open questions for the owner

1. **Branch prefix.** `theo/<slug>`, or configurable per repo (default `<login>/<slug>`)?
2. **Checkpoint commits on ship.** Push them as is (honest history, noisy), or squash into one commit authored by you?
3. **Open PR as draft?** Default draft, so CI runs before reviewers are pinged?
4. **Shell access.** Ship Run mode only behind an OS sandbox, or trust the CLI's own sandboxing (Codex has one, Claude does not)?
5. **Local folder end state.** "Keep as branch" writes a ref into your repo (never the working tree). Is "Merge locally" into your checked-out branch wanted at all, given the rule never to touch your checkout?
6. **Budget.** Separate `budget.per_space_usd`, or one budget shared by the space and its PR's review runs?
7. **Auto-archive.** 7 days after merge — or immediately, with the transcript still reachable from the PR?
