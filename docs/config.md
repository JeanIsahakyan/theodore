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

### Coming next

These keys are parsed and checked today, but nothing uses them yet:

| Key | Type | Will do |
| --- | --- | --- |
| `instructions` | text | fed to every agent run on this repo |
| `context` | list of paths | repo files the agent reads first |
| `hide` | list of globs | files collapsed in the diff |
| `skim` | list of globs | files shown as skimmable |
| `checklist` | glob → item or list of items | items shown when a matching file changes |
| `auto_skills` | list of skill ids | skills run when a PR is opened |
| `ignore_findings` | list of globs | findings on matching paths dropped |

```yaml
review:
  instructions: Prefer small functions. Flag any new dependency.
  context: [docs/architecture.md]
  hide: ["**/*.lock", "gen/**"]
  skim: ["**/*.snap"]
  checklist:
    "migrations/**": Is there a down migration?
    "api/**": [Is the change versioned?, Are the docs updated?]
  auto_skills: [security-review]
  ignore_findings: ["vendor/**"]
```

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

## 7. Tools the agent gets

Each agent turn in a space gets the `space-tools` MCP server: the space's
configured commands as tools, and nothing else. No tool runs a command the
agent writes; there is no shell tool.

| Tool | Does |
| --- | --- |
| `run_check` | runs `check` now; returns `passed`, `exit_code`, `timed_out`, a one-line `summary` and the last 60 lines of `output` |
| `start_app` | starts `run` unless it is running; returns the status |
| `stop_app` | stops `run`, waits up to 10 s for it to exit; returns the status |
| `app_status` | `running`, `ports`, `urls` (`http://localhost:<port>` each), whether `run` is set and allowed, how the last run ended |
| `read_logs` | the last `tail` lines (default 100, at most 400) of one `kind`: `setup`, `run`, `check` or `archive`; stderr lines start with `! ` |
| `space_info` | name, branch, base, worktree, ports and URLs, the **names** of the variables a command gets (§4, `env`) — never their values — and which commands are set and allowed |

```
agent ─▶ run_check / start_app ─▶ set? ─no──▶ error: no `spaces.check` command is configured
                                    │
                                    └─yes─▶ allowed (§5)? ─no──▶ error: not allowed by the user yet
                                                │                (nothing runs)
                                                └─yes─▶ the command, as the space runs it
```

- **Trust holds.** A repo command you haven't allowed — or said Not now to —
  is refused with "not allowed by the user yet", and never runs. The agent
  is told to ask you.
- **Same commands, same state.** A tool's `check` or `run` is the space's:
  same worktree, variables and timeouts, same logs drawer, same Run / Stop
  in the header. The turn's Stop also stops a `run_check` in flight. An app
  the agent started keeps running after the turn, until Stop, archive or
  quit.
- **Scoped to the space.** Each turn gets its own token, revoked when the
  agent exits; it reaches only that space. The agent never names a space.
- **Told in the prompt.** The turn's system prompt lists the tools: use
  `run_check` after changes, `start_app` to try the app.
- **A space's PR.** Chat, skills and fixes on a space's review (or the PR
  it shipped as) keep `review-tools` and also get the read-only `read_logs`
  and `app_status`. Any other PR is unchanged.
- **In the turn.** The turn lists its tool calls; these read as what they
  do ("run the check", "start the app").

Claude and Gemini get the server over HTTP, Codex through its
`mcp_servers.space-tools` override. A CLI that only speaks stdio MCP uses
`theodore mcp-bridge`, same as `review-tools`.
