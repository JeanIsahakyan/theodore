---
name: live-qa
description: Click-test the real Theodore app from a script, against the sandbox or a real GitHub repo, and report what works and what is broken. Use when asked to test, click through, QA or smoke-test the app or a change in it, or to run several testers in parallel. Tests only; it never fixes code.
---

# Live QA

How it works, the helpers and the limits: `docs/live-qa.md`. Read it first.

## Build and run

```sh
scripts/qa/build.sh                  # one build per commit, shared by all runs
export QA=/tmp/theodore-qa/<run>     # your own
. scripts/qa/kit.sh
start_sandbox                        # default; start_live only if the item needs GitHub
q 'return text()'
shot <name>                          # then read $QA/<name>.png to judge layout
stop_app
```

Prefer the sandbox. Go live only for what it can't show.

Before anything spends, on a run that starts agents: `q "return await setSetting('agents.claude.model', 'haiku')"`. Opening a PR groups it and skills run on the global model. A fresh data dir starts with `clear_ui_state` (or onboarding is skipped and stale tabs appear) and has no project: `docs/live-qa.md`, "First steps". Runs of one build share tabs, theme and UI state: `clear_ui_state` first if yours reads them. Consent dialogs need a local PostHog sink, a non-sandbox run and a faked sign-in: `docs/live-qa.md`, "Consent checks".

`q` runs your JS in its own function scope, so a `const nav` shadows the helper. A syntax error in your JS shows up as a 40 s `driver timeout`; the SyntaxError is only in `$QA/app.log`.

## Rules

- **Never fix code while testing.** Report it.
- A live run needs `THEODORE_QA_REPO=<owner/name>` from whoever asked. None given: don't go live. It is the only repo you may write to.
- `gh` only as `qa_gh`.
- `report.github_repo` must be set first; `start_live` does it. Never open Report a problem otherwise.
- Open Inbox and Pull requests rows, and PR tabs, only with `await openRepoRow(row)`.
- Don't read or change `~/.theodore*`, tokens or credentials.
- Never raise the window, change the frontmost app or move the mouse: someone may be working on the same machine.
- A local build is not for real use (AGENTS.md).

## Report

Conclusion first, in one line. Then:

| Item | Works | Broken | Partly |
| --- | --- | --- | --- |

For each defect:

- **Steps**
- **Expected**
- **Got**
- **DOM evidence**: the `q` output, or the screenshot
- **Likely code location**

End with:

- What was left behind: issues, PRs, branches, comments in the test repo; run dirs.
- What wasn't verified, and why. If capture failed and you judged layout from DOM geometry, say so.

## Parallel testers

```
main ──▶ scripts/qa/build.sh (once)
  ├──▶ tester A   QA=/tmp/theodore-qa/a   items 1-4
  ├──▶ tester B   QA=/tmp/theodore-qa/b   items 5-8
  └──▶ tester C   QA=/tmp/theodore-qa/c   items 9-12
```

Each brief says: its `QA` dir, the build's `THEODORE_QA_APP`, its items, sandbox or live, `THEODORE_QA_REPO` if live, and this skill. Items don't overlap. GitHub's API limit is shared, so at most one tester goes live unless the items need more.
