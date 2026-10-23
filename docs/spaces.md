# Spaces — the stage before a pull request

A **space** is a change while it is being made. You open one in a project, say
what you want, and an agent writes the code in an isolated worktree while you
watch the diff, review it by meaning, and send comments back. When it is good,
the space becomes a pull request — its turns squashed into one commit by
you on its own branch — and Theodore's existing review, inbox and merge flow
takes over. In a local folder it is merged into the checked-out branch
instead, or kept as a branch.

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
         "Open PR" ▾ draft         └──────────────────────────────┘
         (host project)
         "Merge locally"   ─────────────────────────────────────────▶ merged ──▶ archived
         ▾ "Keep as branch" ────────────────────────────────────────▶ branch ──▶ archived
         (local folder)
```

The PR is the space's continuation, not a copy: `space.pr` points at it, the
space page shows its state, reviewer threads become agent tasks in the same
space, and a push from the space updates the PR.

| Stage | Space shows | Who acts | Ends when |
| --- | --- | --- | --- |
| Drafting | chat · live diff vs base | you + the agent | Open PR / Merge locally / Keep as branch |
| In review | the same, plus the PR (opened from the header) | reviewers → you → the agent | merged or closed on the host |
| Done | transcript and final diff | — | archived (auto, `spaces.auto_archive_days` after merge, merge locally or keep) |

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
Open PR                ──▶  squash checkpoints ─▶ one commit by you
                            push it to <login>/fix-login ─▶ outbox create_space_pr
                            space.pr = github:o/r#123 ─▶ PR row, inbox, polling
reviewer comments      ──▶  thread ─▶ "Send to agent" ─▶ turn ─▶ Push ─▶ PR updated
not what you wanted    ──▶  "Undo" ─▶ worktree + ref back to the previous checkpoint
merged                 ──▶  space.done_at ─▶ archive after spaces.auto_archive_days
```

---

## 3. Where spaces live in the UI

**Decision: a "Spaces" section in every workspace's sidebar, below its
sections (Overview · Inbox · My PRs · Tasks · Skills), plus a "Drafting"
group at the top of My PRs.** Two views over one object, not
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
│ Branch     ada/retry-export-429   from  main ▾  │
│ Agent      claude ▾   Mode  Edit ▾              │
│                              [Cancel] [Start ⏎] │
└─────────────────────────────────────────────────┘
```

"Start" creates the worktree and sends the goal as the first message — the
first turn starts immediately. Name and branch are derived from the goal and
editable.

| Goal | Name |
| --- | --- |
| Retry the export job on 429s | `retry-the-export-job-on` (first five words) |
| исправить логин | `ispravit-login` (Cyrillic transliterated) |
| Crème brûlée für Straße | `creme-brulee-fur-strasse` (accents dropped) |
| 修复登录 | `space` (other scripts only break words) |
| a second "исправить логин" in the project | `ispravit-login-2`, and so its branch |

### Space page — drafting

Chat left, changes right. The diff is the whole branch vs its base, the same
`DiffPane` the review uses, refreshed after every turn.

```
┌ ◐ fix-login-redirect ── ada/fix-login-redirect ← main ── Drafting ── $0.42 / $5.00 ┐
│ claude                             [Review] [Open PR ▾] [Archive]                │
├──────────── chat ──────────────────┬──────────── changes ────────────────────────┤
│ you  The login page should send    │ 3 files  +42 −7   vs main · after turn 2    │
│      people back where they were…  │ ▾ src/auth/redirect.ts               +30 −5  │
│                                    │   @@ -10,6 +10,12 @@                         │
│ claude  I added a `next` param…    │   + const next = safeNext(params.get(…      │
│   ▸ 6 tool calls          [Undo]   │ ▾ src/routes/login.tsx               +12 −2  │
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

**Undo last turn**: the Undo button on the agent's last reply (and ⌘K "Undo
last turn") moves the worktree and the checkpoint ref back to where that
turn started. The turn stays in the chat, dimmed and marked *undone*, and the
next turns' prompts leave it out. Pressing it again walks back one more turn.
Refused while a turn runs, on an archived space, and once the turn shipped
(pushed, merged locally, or kept as a branch) — then ask the agent to revert
it instead.

```
turn 1 ─▶ ckpt A ─▶ turn 2 ─▶ ckpt B          Undo: worktree + ref → A
                                │              turn 2 kept, marked undone
                                └─ shipped? ── refused
```

### Space page — in review

The header gains the PR; the right pane gains Threads and Checks tabs
(planned; today the PR opens in the normal review). Reviewer threads carry
"Send to agent"; after the agent's turn, "Push" updates the PR.

```
┌ ○ rate-limits ── PR #123 ⎇ ada/rate-limits ── In review ── ✓ 9/9 ── 2 threads ───┐
│ claude ▾  Edit ▾                         [Review ▸] [Push 1 turn] [Open on host] │
├──────────── chat ──────────────────┬── Changes │ Threads 2 │ Checks ─────────────┤
│ …                                  │ ● anna · limiter.ts:41                      │
│ ◆ turn 4 · 9f8e7d · pushed         │   "Should this be per-token, not global?"   │
│ ◆ turn 5 · 1c2d3e · not pushed     │   [Send to agent] [Reply] [Resolve]         │
│                                    │ ● ci-bot · README.md:12                     │
│                                    │   [Send to agent] …                         │
└────────────────────────────────────┴─────────────────────────────────────────────┘
```

**Send to agent** sits next to a thread's Resolve, a draft's edit/delete and
a finding's Add to review — in the diff and in the side panel — but only when
the PR is the space's (`space.pr`) or is the space's own branch review
(`space.review_pr`). It starts the space's next turn with a message that
quotes the comment and where it is:

```
Address this review feedback on the change.

Review thread on src/limiter.ts:41:
anna wrote:
> Should this be per-token, not global?

Change the code where the feedback applies. If you disagree with a point,
leave the code and say why. End with what you changed.
```

Several items (`space_send_feedback` takes a list) are numbered in one
message. Removed lines read `path:7 (old side, removed lines)`; outdated
comments say so; `<!-- … -->` metadata is dropped. The draft or thread itself
is left as it was.

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

Today each draft and finding has its own "Send to agent" (above). The
footer that sends them all as one turn is planned, and so is tracking each
item as a `task` assigned to the space's agent that moves to `review` when
the turn ends.

### Notifications

| Event | Space open | Elsewhere in the app | App in background |
| --- | --- | --- | --- |
| turn finished | diff refreshes | toast "fix-login: turn done" [Open] + ● | notification "fix-login: turn finished" |
| turn failed | error in chat | error toast [Open] + ✕ | notification "fix-login: turn failed" + the error |
| PR checks / reviews | header + tabs | existing inbox | existing |

"In the background" = the window isn't focused. The notification goes
through the shell's notification plugin (permissions: notify and its
permission check only) and respects `spaces.notify` (Settings → Labs,
default on). Coming back to the window after one — clicking it does that —
opens the space it was about. The dock badge counts the spaces whose last
turn ended after you last looked at them (finished or failed); a space only
counts as seen while the window has focus.

---

### Setup, run, check, archive

A space can be set up for its project by the `spaces:` section of the project
config — files copied in, free ports, env, and `setup` / `run` / `check` /
`archive` commands. See `docs/config.md`.

## 4. What makes it Theodore's

- **Review is the product.** The agent's diff is reviewed with the same
  grouping, read state, tour, findings and skills as a teammate's PR. A
  space's review is an ordinary branch review (`open_branch` plumbing) whose
  head is the space's checkpoint.
- **Comments are instructions.** Drafts, findings and reviewer threads go to
  the space's agent as its next turn, quoted with their `path:line`. The
  loop "read → comment → agent fixes → read what changed" runs on the
  review you already use; tracking each as a `task` is planned.
- **Stages, not modes.** Writing code and reviewing it are one lifecycle;
  nothing is exported from one tool into another.

---

## 5. Agent control

| Mode | The agent may | Port mapping |
| --- | --- | --- |
| Ask | read, grep, MCP; no writes | `AgentMode::ReadOnly` |
| Edit (default) | + edit files in the space | `AgentMode::Edit` |
| Run | + any shell command (tests, installs), no prompts | `AgentMode::Run`: Claude `--permission-mode bypassPermissions`; Codex `workspace-write` with network access; Gemini `--approval-mode yolo`. No sandbox of Theodore's own (§12 #4) |

Mode is picked next to Send (Ask · Edit · Run) and sticky per space. Edit
is unchanged from before: Claude's Edit already pre-approves Bash, Codex's
`workspace-write` already runs commands in its own sandbox; Run lifts the
remaining prompts and limits.

- **Stop** cancels the run (SIGTERM → 5 s → SIGKILL, existing lifecycle), then
  checkpoints whatever was edited as "turn N (stopped)". Nothing is lost.
- **Resume** = send another message. Each turn gets the goal and the recent
  transcript, so a crash, a stop, or a different agent picks up where the
  last one left off. v2: native session resume when the agent stays the same
  (session id stored per run).
- **Switch agent or model** per message (picker in the header).
- **Context**: `@path` mentions (stored as refs), paste a PR link to attach
  its description and diff stats, `/skill` runs a skill as the turn's
  instructions. The space's own commands come as MCP tools (below); a
  `get_space_context` (goal, diff stat, open tasks) is v2.
- **Scripts**: repo settings `spaces.setup` (v2; once, after create — e.g.
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

### Tools the agent gets

Every turn, in every mode, gets the `space-tools` MCP server: the space's
configured commands, never a shell of the agent's choosing.

| Tool | Does |
| --- | --- |
| `run_check` | the project's `check`, now: exit code + last lines |
| `start_app` / `stop_app` / `app_status` | the `run` command: start, stop, running?, ports, `http://localhost:<port>` |
| `read_logs` | the tail of `setup`, `run`, `check` or `archive` output (bounded) |
| `space_info` | name, branch, base, worktree, ports, env variable names (not values), which commands are set |

```
turn ─▶ token for this space ─▶ agent ─▶ run_check ─▶ check ─▶ result ─▶ agent fixes ─▶ …
  │                                  └─▶ start_app ─▶ run   ─▶ URLs   ─▶ agent tries it
  └─ agent exits ─▶ token revoked
```

- The system prompt names them: use `run_check` after changes, `start_app`
  to try the app.
- Trust holds: a repo command not allowed yet is refused with "not allowed
  by the user yet" and never runs.
- The turn lists its tool calls while it runs and after (this session),
  Theodore's own by what they do.
- Review chat, skills and fixes on a space's PR also get the read-only
  `read_logs` and `app_status` next to `review-tools`.

Details, limits and errors: `docs/config.md` §7.

---

## 6. Git model

```
~/.theodore/repos/<host>/<owner>/<repo>.git    bare cache
   ├─ refs/heads/*                ◀── force-fetched from the remote, pruned
   └─ refs/theodore/spaces/<id>   ──▶ last checkpoint   (Theodore's own ref)
~/.theodore/spaces/<id>/          detached worktree at the checkpoint + live edits

turn ends ─▶ git add -A ─▶ commit "turn N" ─▶ update-ref refs/theodore/spaces/<id> HEAD
Ship      ─▶ commit-tree <checkpoint tree> -p <base> (author: you) ─▶ refs/theodore/shipped/<id>
Open PR   ─▶ git push origin <shipped>:refs/heads/<login>/<slug>   (never forced)
Push      ─▶ commit-tree <checkpoint tree> -p <last shipped> ─▶ push (fast-forward)
Merge     ─▶ (local folder) fetch <cache> <shipped ref> ─▶ git merge into its checked-out branch
Keep      ─▶ (local folder) fetch <cache> <shipped ref>:refs/heads/space/<slug>
Keep      ─▶ (local folder) git -C <folder> fetch <cache> <ref>:refs/heads/<branch>
```

Why detached plus a private ref, not a real branch in the cache:

| A branch under `refs/heads/` would… | Because |
| --- | --- |
| break every project refresh | `fetch +refs/heads/*:refs/heads/*` refuses to update a branch checked out in a worktree |
| be deleted before it is pushed | the same fetch runs with `--prune` |

Every turn is a commit, so the diff is commit-to-commit (cacheable, same as a
PR's revisions), "undo last turn" is a ref move plus `reset --hard` and
`clean -fd` in the worktree (ignored files such as installed deps stay), and the agent's own
`git commit`s are simply kept. Checkpoints are authored by Theodore and never
leave the cache; what ships is one squashed commit authored by you (§12 #2).

**Shipping, step by step**

- *Author*: `user.name` / `user.email` as git resolves them (a local
  folder's own config first, then the cache's, i.e. your global one); on
  GitHub without either, your login with its noreply address. Unsigned:
  Theodore can't answer a passphrase prompt. Message: the title (editable
  in the confirm popover, default the goal's first line), then the goal
  when it says more.
- *Open PR*: the commit's parent is the base. If the branch name is
  already taken on the host, nothing is pushed. After the push the outbox
  item `create_space_pr` asks the host for an open PR from that branch
  first and only then creates one; a create the host refuses as a
  duplicate is looked up again. So a retry — after a timeout, a crash, or
  clicking Open PR again after a failure — never opens a second PR, and a
  retry with no new turns pushes nothing.
- *Push*: one more commit on top of the last pushed one, so reviewers'
  history and comments stay put. No force push, ever:

  | PR branch on the host | the new commit |
  | --- | --- |
  | where the last push left it | parent = last push, tree = latest checkpoint |
  | moved (someone pushed to it) | parent = their tip, tree = their tip + the turns since the last push (three-way, no worktree); refused if that conflicts |
  | gone | parent = last push, pushed again |

- *Merge locally*: refused, folder untouched, on a dirty working tree
  (untracked files count), a detached `HEAD`, or a merge that would
  conflict (checked first with `git merge-tree`, before the index or any
  file changes). Otherwise a normal `git merge` (fast-forward when it can
  be) with the user's own hooks; a merge that still fails is aborted. The
  objects come over with `fetch --no-write-fetch-head`: no `FETCH_HEAD`,
  no extra ref. A second merge after more turns brings only those turns.
- *Keep as branch*: writes `refs/heads/space/<slug>` in the folder and
  nothing else; refused if that branch exists.

---

## 7. Lifecycle and data

New synced model `space` (core-owned, written only by commands):

| Field | |
| --- | --- |
| `id`, `project`, `name`, `goal` | `goal` is the first message |
| `branch`, `base`, `base_sha`, `head_sha` | `branch` (`<login>/<slug>`, `space/<slug>` without a login) is pushed on Open PR; `head_sha` = last checkpoint |
| `worktree` | absolute path |
| `status` | `idle · running · failed · archived` |
| `agent`, `model`, `mode` | sticky per space |
| `review_pr` | the branch review the diff and Review use |
| `pr` | the host PR, once opened — the link from drafting to review |
| `usage`, `turns`, `error`, `created_at`, `updated_at` | |
| `shipped` | the last ship: `how` (`pr · merged_locally · branch`), `branch`, `sha` (the squashed commit), `head` (the checkpoint it came from — later turns are "not pushed"), `pushes`, `at` |
| `done_at` | set when the PR merges (seen by the poller's spaces sweep) or on Merge locally / Keep as branch |
| `turn_log` | per turn: your message and the reply (`chat_message` ids), checkpoint `before` / `after`, `undone` |

| Data | Where |
| --- | --- |
| Transcript | `chat_message` rows with `pr = "space:<id>"` — the chat model, bootstrap and UI already work on it |
| Streaming text, tool lines | `Ephemeral::AgentDelta` / `RunLog` with run id `space:<id>:<msg>`; not persisted |
| A turn | on the space row: `status`, `turns`, `head_sha`, and an entry in `turn_log` (what undo moves back to). Later: `space_run` rows (agent, mode, usage, session id) for per-turn diffs and native resume |
| Code | the worktree and `refs/theodore/spaces/<id>` |

**Archive** checkpoints any uncommitted edits, removes the worktree, keeps the
ref and the rows. The space page's Archive button does it at any time (not
while a turn runs). **Unarchive** (the archived banner's button, or ⌘K) recreates the
worktree from the ref and reopens the live diff; archived spaces are found
by searching ⌘K. A done space starts its auto-archive countdown again from
the unarchive. If the ref is gone the worktree starts over at the base and
the space says so (`failed`, "the checkpoints were gone").
**Auto-archive**: once a minute the poller re-fetches each in-review space's
PR, sets `done_at` when it has merged, and archives spaces done for
`spaces.auto_archive_days` (default 7, `0` = never; Settings → Labs). A PR
closed without merging leaves the space alone. Space worktrees live outside
`~/.theodore/wt`, so the PR worktree sweep never touches them.

Not built yet: **Delete** (archive plus deleting the ref and the chat rows);
**GC** (archived spaces whose branch was never pushed lose their ref after
`spaces.gc_days`, 30); removing a project archiving its spaces first.

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

## 9. Commands

| Command | Does |
| --- | --- |
| `create_space` | worktree + ref at the base, `space` row; sends `goal` as turn 1 when given |
| `list_spaces` | rows of one project or all (the UI reads the synced rows) |
| `space_send` | chat row, then an Edit-mode turn in the worktree; checkpoint; refresh the diff |
| `space_stop` | cancels the running turn |
| `space_review` | opens (or refreshes) the space's branch review; `group: true` also groups it |
| `archive_space` | checkpoint, remove the worktree, keep the ref |
| `unarchive_space` | recreate the worktree from the ref, reopen the live diff |
| `undo_space_turn` | worktree and ref back to the last live turn's `before`; the turn is marked undone |
| `space_send_feedback` | threads / drafts / findings of the space's PR or own review, quoted as one turn |
| `ship_space` | `open_pr` · `open_draft_pr` · `push` (host project) or `merge_locally` · `keep_branch` (local folder), with an optional title (§6) |

## 10. The flag

| | flag off (default) | flag on |
| --- | --- | --- |
| Sidebar section, route, palette items, keys | absent | present |
| Settings → Labs | absent unless a `labs.build_mode` setting row exists | present |
| Core commands | registered, unused | used |

On = `FEATURES.buildMode || setting labs.build_mode = true` (user scope).
To turn it on without a rebuild, create the row once with Theodore closed,
then use Settings → Labs:

```sh
sqlite3 ~/.theodore/theodore.db "INSERT INTO models (model, id, data) VALUES
  ('setting', 'user:labs.build_mode',
   '{\"key\":\"labs.build_mode\",\"scope\":\"user\",\"value\":false}')"
```

---

## 11. Phasing

| Phase | Scope |
| --- | --- |
| **Built** | `space` model; create / send / stop / review / archive; transcript in chat rows; checkpoint per turn; sidebar section; space page with chat + diff; Review opens the grouped review; crash → failed. Shipping: squash into one commit by you; Open PR / Open as draft (`HostAdapter::create_pr` + `find_open_pr` on GitHub, GitLab, Bitbucket, sandbox and fixtures, through the outbox, idempotent by head branch) and Push (never forced); branch `<login>/<slug>`; Merge locally and Keep as branch for local folders; modes Ask / Edit / Run; Archive button and `spaces.auto_archive_days`. "Send to agent" on a space PR's / own review's threads, drafts and findings; Undo last turn (`turn_log`); Unarchive; background notifications and the dock badge (`spaces.notify`); names transliterated from Cyrillic and accented goals, `-2` for repeats |
| **v2** | My PRs "Drafting" group and the sidebar's `⎇ #n` glyph; "Send all to agent" footer and feedback tracked as tasks; Threads / Checks tabs on the space page; `space_run` rows and per-turn diffs; setup/check scripts; Delete and ref GC; queue + `max_parallel` |
| **Later** | native session resume per CLI; OS sandbox for agents; live diff during a turn (snapshot the working tree through a temporary index); signed shipped commits; spaces started from an issue or a failing check; several agents racing one goal, pick the best diff |

## 12. Decisions (owner, 2026-10-21)

| # | Question | Decision |
| --- | --- | --- |
| 1 | Branch name on ship | `<login>/<slug>` (the host login; `space/<slug>` when there is none) |
| 2 | Checkpoint commits on ship | squashed into one commit, authored by you, message from the goal |
| 3 | Draft or ready | **Open PR** opens a ready PR; its dropdown offers *Open as draft* (and any other modes) |
| 4 | Run mode safety | no extra sandbox: Run mode trusts the agent CLI as configured |
| 5 | Local folder end state | **Merge locally**: a normal merge of the squashed commit into the folder's checked-out branch, instead of a PR; *Keep as branch* stays as the alternative |
| 6 | Budget | none: budgets, and showing spend at all, were dropped by the owner on 2026-10-22. Nothing is limited, no cost is shown, and an old `budget.*` setting is ignored |
| 7 | Archive | a setting `spaces.auto_archive_days` (default 7, `0` = never) plus an **Archive** button on the space at any time |
