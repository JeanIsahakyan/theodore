# theodore

Theodore is a standalone productivity app for code review. It runs AI agents
locally to reorganize a pull request by meaning, so you read it as a set of
logical steps instead of an alphabetical list of files. The agents help; the
reviewer decides.

```
                    git diff (file order)          theodore (meaning order)
                    ─────────────────────          ────────────────────────
                    api/handler.ts                 1. new data model
                    db/migration.sql                  db/migration.sql
                    model/user.ts         ──▶         model/user.ts
                    tests/user.test.ts             2. API using it
                    ui/profile.tsx                    api/handler.ts
                                                      ui/profile.tsx
                                                   3. tests
                                                      tests/user.test.ts
```

## Review flow

```
Inbox ──▶ open PR ──▶ agents pre-review ──▶ groups ①…⑥ ──▶ read / tour ──▶ drafts ──▶ Submit
  │       (worktree)   group + risks          why · checklist · risk          │
  │                                                                           ▼
  │                                                      one GitHub review; each comment
  │                                                      becomes a task for the author
  └─ snooze «until push» / «until checks green» — wakes on a GitHub event
```

## Core ideas

| Idea | What it means |
| --- | --- |
| Groups by meaning | Every hunk belongs to exactly one group. A group has a title, a *why*, a checklist and a risk. Mechanical changes are marked *skim*; lockfiles and generated code are *hidden*. |
| Outliers | In a large mechanical change, only the hunks that break the pattern are shown up front. |
| Hunk-level read state | GitHub keeps *Viewed* per file. Theodore tracks each hunk and marks the file *Viewed* on GitHub only after all its hunks are read, across groups. |
| Re-review shows the delta | After a push, only new or changed hunks are flagged, with an interdiff. A push while you read shows a banner; the diff never moves under you. |
| Findings from many agents | Agents run review skills in parallel and report findings in one format. Matching findings merge ("both found it"). A finding becomes a draft comment, a task or a proposed fix. |
| GitHub is written on click | Nothing is posted until you submit. The review goes out as one GitHub review. |
| Tasks close the loop | Each submitted comment becomes a task for the author. An agent can fix a task in the PR worktree; accepting the fix resolves the thread. |
| Keyboard first | Inbox driven from the keyboard, ⌘K for every action, `?` lists every key. |

## How agents run

Theodore does not ship its own model or store an API key by default. It runs the
agent CLIs you already have installed and logged into, on your machine, inside a
git worktree of the PR.

```
┌──────────── Theodore (desktop app) ─────────────┐
│ UI ◀──IPC──▶ core: git, GitHub, review state    │
│                     │ spawn, JSON lines         │
│                     ▼                           │
│               agent runner ──▶ claude / codex / gemini CLI
│                     ▲              │  cwd = PR worktree
│                     │              ▼
│               MCP "review-tools" ◀─ tool calls  │
└─────────────────────────────────────────────────┘
```

- **Agents.** Claude Code (`claude -p --output-format stream-json`), Codex
  (`codex exec --json`) and Gemini CLI (`gemini -p --output-format json`). Each
  runs as a subprocess, and its output is streamed to the UI.
- **Credentials.** Agents use their own existing login (subscription or API key).
  Any secret Theodore needs, such as the GitHub token, lives in the OS keychain.
- **Workspace.** Theodore keeps one bare clone per repo and one worktree per PR
  (`pull/<n>/head`). Agents read code there, never in your working copy.
- **Tools.** Theodore exposes an MCP server, `review-tools`, to every agent:
  `get_pr_context`, `get_group`, `read_file`, `grep`,
  `add_finding(file, line, severity, title, body)`. All agents report findings
  through it, so one format covers all of them.
- **Skills.** Review skills are `SKILL.md` files from `~/.claude/skills` or the
  repo's `.claude/skills`. Claude loads them natively; other agents get the
  skill text in the prompt.
- **Cost.** Each run reports tokens and cost, and each PR has an AI budget.
