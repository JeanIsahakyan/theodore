# Project config

One YAML file, in three layers. Later layers win, key by key; a list
replaces the earlier list instead of extending it.

```
~/.theodore/config.yaml                 global   your defaults, every project
<repo>/.theodore/config.yaml            repo     in the repo, shared with the team
<repo>/.theodore/config.local.yaml      local    personal, gitignored
```

```
global ──▶ repo ──▶ local ──▶ effective config
             │
             └─ commands here need your approval (§5)
```

- **Global** sits in Theodore's data directory (`THEODORE_DATA_DIR`, by
  default `~/.theodore`). Settings → Labs → Global config shows its path
  and opens it in your editor, creating it from a commented template if
  it is missing.
- **Repo** is committed. For a local folder project it is read from the
  folder's working copy. A host project has no checkout, so the file is read
  as committed: at the space's base for a space, at the PR's head for a
  review.
- **Local** is yours. Add it to `.gitignore`:

  ```gitignore
  .theodore/config.local.yaml
  ```

  It is read only from a local folder project's own checkout, never from a
  space's worktree (where the agent could write it). A host project has no
  local layer: use the global file.

Settings → Labs → Global config also shows each project's effective config
read-only: every value and the file it came from, unknown keys, and whether
the repo's commands are allowed.

**Legacy path.** `<repo>/.review/config.yaml` is still read as the repo
layer when `.theodore/config.yaml` is absent. It is deprecated: Theodore
warns once per session, and the file is ignored as soon as
`.theodore/config.yaml` exists. Its flat keys (`agents.grouping: codex`)
and a top-level `agents:` map both mean `review.agents`.

**Problems are warnings, not errors.** An unknown key, a file that isn't
valid YAML, or a section with a value of the wrong type is shown once per
session as a toast. The broken file or section is skipped; everything else
applies.

---

## 1. `review:`

```yaml
review:
  agents:
    grouping: claude        # claude | codex | gemini
    chat: codex
    skills: [claude, codex]
    fix: claude
```

`review.agents.*` are the per-task agents of Settings → Agents. A value from
any config file wins over the Settings choice for that project; remove the
line and the Settings choice applies again.

### Review rules

```yaml
review:
  instructions: Prefer small functions. Flag any new dependency.
  context: [docs/architecture.md, "docs/adr/*.md"]
  hide: ["gen/**", "*.min.js"]
  skim: ["**/*.snap", "locales/"]
  checklist:
    "migrations/**": Is there a down migration?
    "api/**": [Is the change versioned?, Are the docs updated?]
    "**/*.sql": Is it safe to run twice?
  auto_skills: [security-review]
  ignore_findings: ["vendor/**", "*.pb.go"]
```

| Key | Type | Does |
| --- | --- | --- |
| `instructions` | text | appended to the system prompt of every agent run on the repo: grouping, chat, skills, fixes, space turns |
| `context` | list of paths or globs | named in that same prompt as "read these first" (not inlined); at most 20 |
| `hide` | list of globs | matching files go to the Hidden group, like generated files; never sent to the agent |
| `skim` | list of globs | every hunk of a matching file is flagged to the grouping agent as a skim candidate |
| `checklist` | glob → item or list of items | after grouping, each group holding a matching file gets the items in its "What to check" list |
| `auto_skills` | list of skill ids | each runs once, through the normal skill run, the first time a PR is opened at a head |
| `ignore_findings` | list of globs | a finding anchored on a matching path is dropped when reported, and counted |

```
config ─┬─ instructions, context ─▶ system prompt of every agent run
        ├─ hide, skim ────────────▶ grouping pre-pass ─▶ Hidden group / skim hints
        ├─ checklist ─────────────▶ after grouping ─▶ "What to check" items
        ├─ auto_skills ───────────▶ PR opened at a new head ─▶ skill runs
        └─ ignore_findings ───────▶ finding reported ─▶ dropped, counted on its run
```

**Globs.** Paths are relative to the repo root.

| Pattern | Matches |
| --- | --- |
| `*.lock` | no `/`: the file name, at any depth (`Cargo.lock`, `ui/yarn.lock`) |
| `gen/**` | a `/` anchors at the root; `**` is any number of directories |
| `locales/` | a trailing `/`: everything under it |
| `src/*.rs` | `*` and `?` stay inside one path segment |
| `**/*.{ts,tsx}` | `{a,b}` alternatives |

Quote a pattern that starts with `*` or contains `{` (`"*.lock"`): YAML
reads it differently otherwise. A `.` inside a `checklist` key is part of
the glob, not a nested key.

- **Which config.** A review reads the PR's repo layer from the PR's
  checkout (its head), plus your global file; a local folder project reads
  its own working copy and personal file instead, whichever review of it is
  open. A space reads its project's config at the space's base. The files
  are read on every use and re-merged only when their text changes, so an
  edit applies to the next agent run without a restart.
- **`context`** is resolved against the PR's checkout (a space's worktree
  for a space). A plain path that doesn't exist, a glob that matches
  nothing and a path leaving the repo are left out (a debug log line says
  so). Duplicates count once; the first 20 files are kept.
- **`hide`, `skim`, `checklist` and the grouping.** A grouping is stored
  with a hash of these three keys. Opening a PR whose stored grouping was
  made under other values regroups it from scratch, and so does Regroup
  (a push after a change doesn't continue the old groups either). Changing
  `instructions`, `context`, `auto_skills` or `ignore_findings` doesn't
  regroup. After a push, new hunks of a hidden file go straight to the
  Hidden group.
- **`checklist`** items come after the agent's own, globs in sorted order,
  each glob's items as listed; an item a group already has isn't added
  again. A hidden file's items go to the Hidden group.
- **`auto_skills`** run with the Settings → Agents skills agents. Once per
  head: reopening the PR at the same head (in this session or after a
  restart) doesn't run them again; a push and a later open at the new head
  does. Not for a merged or closed PR. A sandbox replaying agents
  (docs/sandbox.md) runs them only when its scenario sets
  `"auto_skills": true`. A skill that doesn't start (no agent installed) is
  a toast.
- **`ignore_findings`** matches the finding's anchor path. The AI panel
  shows "N findings hidden by config" under the skill run that reported
  them. Each dropped report counts, so two agents reporting the same
  finding count two.
- **Trust.** These keys run no commands, so a repo's file applies them
  without asking (§5). It can still steer the agents and hide files from
  the grouping: read a repo's `review:` before relying on it.

---

## 2. `spaces:`

Spaces are hidden behind build mode (`docs/spaces.md` §10). Everything here
applies to a space of the project.

```yaml
spaces:
  copy: [.env, .env.local]
  ports: 2
  env:
    APP_URL: "http://localhost:$THEODORE_PORT"
    COMPOSE_PROJECT_NAME: "$THEODORE_SPACE"
  setup: |
    pnpm install
    docker compose up -d
  run: pnpm dev --port $THEODORE_PORT
  check: pnpm lint && pnpm test
  archive: docker compose -p $THEODORE_SPACE down
  timeout_s: { setup: 600, check: 600, archive: 120 }
```

| Key | Default | Does |
| --- | --- | --- |
| `copy` | `[]` | paths copied from the project's local folder into the new space's worktree (§3) |
| `ports` | `0` | free TCP ports reserved for the space's life (at most 16) |
| `env` | `{}` | extra environment for the space's commands and agent turns; values expand variables (§4) |
| `setup` | — | runs once after create, before the first agent turn |
| `run` | — | long-running (a dev server): Run / Stop in the space header, `⇧R` |
| `check` | — | runs after each agent turn that changed files; the result is attached to the turn |
| `archive` | — | runs before the space's worktree is removed |
| `timeout_s.setup` | `600` | seconds before `setup` is stopped |
| `timeout_s.check` | `600` | seconds before `check` is stopped |
| `timeout_s.archive` | `120` | seconds before `archive` is stopped |

Every command runs as `sh -c '<command>'` with the space's worktree as its
working directory, in its own process group. Stop, a timeout or Theodore
quitting sends SIGTERM to the whole group, then SIGKILL 5 s later. Output
lines are capped at 8 KB each; the last 2000 lines per space are kept in
memory for the logs drawer, and a check keeps its last 60 lines on the turn.
Commands inherit your environment without Theodore's own `THEODORE_*`
variables, then get the space's variables and `env`.

### A space's life

```
create ─▶ worktree ─▶ copy ─▶ ports ─▶ setup ──ok──▶ turn 1 (the goal)
                                         │ └─fail─▶ Retry · Continue without setup
                                         └─ from the repo, not allowed ─▶ "Run commands from this repo?"
turn ─▶ checkpoint ─▶ files changed? ─▶ check ─▶ ✓ / ✗ on the turn
                                                  └─ ✗: its output goes into the next prompt
Run ─▶ run … Stop
archive ─▶ stop run ─▶ checkpoint ─▶ archive ─▶ remove worktree ─▶ release ports
```

- **Setup.** The space page shows "Setting up…" with the live log. The goal
  waits; sending a message is refused until setup ends. On failure (non-zero
  exit, timeout) the page offers **Retry** and **Continue without setup**.
  Notes from copying (a missing file, a path outside the project) are shown
  with it.
- **Check** is part of the turn: the space stays running until it ends, and
  Stop stops it too. A turn that changed nothing runs no check. Passed /
  failed shows as a chip on the turn, expandable to the output.
- **Run** has no timeout. It stops on Stop, on archive, and when Theodore
  quits; after a restart a run that was going is shown as stopped.
- **Archive** failing is a warning; the space is archived anyway. Unarchive
  reserves fresh ports.

## 3. `copy`

Each entry is a path relative to the project's folder: a file, a directory
(copied whole), or a `*` / `?` glob in its last segment (`.env*`). Absolute
paths, `..`, `.git` and symlinks are skipped with a note. Copying needs the
project's own checkout: a host project has none, so `copy` is skipped there
with a note.

## 4. Variables

Set for every command and agent turn of a space:

| Variable | Value |
| --- | --- |
| `THEODORE_SPACE` | the space's name as a slug (`fix-login-redirect`) |
| `THEODORE_SPACE_ID` | the space's id |
| `THEODORE_PORT` | the first reserved port (same as `THEODORE_PORT_0`) |
| `THEODORE_PORT_<n>` | the n-th reserved port, from 0 |
| `THEODORE_ROOT` | the project's local folder; unset for a host project |
| `THEODORE_WORKTREE` | the space's worktree (the working directory) |
| `THEODORE_BRANCH` | the branch the space ships as |

In `env` values, `$NAME` and `${NAME}` expand to these variables or to your
environment; an unknown name expands to nothing, `$$` is a literal `$`. A
value can't refer to another `env` key, and `env` can't override a
`THEODORE_*` variable. Commands themselves are expanded by `sh`, so use the
variables there directly.

## 5. Trust

A repo's file is written by whoever can push to the repo, so commands from
the **repo** layer run only after you allow them. Gated: `spaces.setup`,
`spaces.run`, `spaces.check`, `spaces.archive` and every `spaces.env` key,
whenever their effective value comes from the repo layer. Commands set in
your global or local file run without asking.

```
repo commands in effect ─▶ sha256 ─▶ allowed for this project? ─yes─▶ run
                                         │
                                         └─no─▶ space shows the commands:
                                                "Run commands from this repo?"
                                                  Allow   ─▶ hash stored for the project, run
                                                  Not now ─▶ skipped in this space, with a note
```

- The approval is stored per project against a hash of the exact set. Any
  change to a gated value — a new command, an edited one, a new `env` key —
  asks again.
- **Not now** applies to that space only: its repo commands (and repo
  `env`) are skipped, everything else works, and the space shows that they
  were skipped with a way to review and allow them later.
- A value your local or global file overrides is not part of the set.

## 6. Global template

What "Open in editor" creates when `~/.theodore/config.yaml` is missing:
every line commented, the layers explained, an example of each section.
