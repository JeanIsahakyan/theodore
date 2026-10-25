# Screenshots

Taken in the sandbox (`docs/sandbox.md`) — a simulated `acme/storefront` and
`acme/billing`, no real data — with real Claude runs for the grouping, the AI
answers, the skill findings, the task fix and the space. 1452×864 window,
Retina, macOS window shadow, WebP.

| | |
| --- | --- |
| ![Inbox](01-inbox.webp) **Inbox** — review requests, assignments and mentions in sections; the preview shows a PR with its actions. | ![Pull requests](02-pull-requests.webp) **Pull requests** — every PR of the workspace, filtered All / Mine / Drafts / Merged; Mine groups your PRs by what each needs to merge; one status mark per PR. |
| ![Grouped review](03-review-grouped.webp) **Review, grouped by meaning** — titled groups with a why, a risk and a checklist, read in order; a progress line counts the groups read. | ![AI panel](04-ai-panel.webp) **AI panel** — ask about the change; the agent reads the diff through the review tools. |
| ![Split diff with a thread](05-split-diff-draft.webp) **Split diff and a thread** — reply or resolve; it goes back to the host. | ![Command palette](06-command-palette.webp) **⌘K** — every action and PR, with its key. |
| ![Workspace switcher](07-workspace-switcher.webp) **Workspaces** — All projects or one project, ⌃0 / ⌃1…9; each keeps its own tabs. | ![Branches](08-branches.webp) **Branches** — ahead / behind, the PR a branch belongs to, a local review of any branch. |
| ![Skill findings](09-skill-findings.webp) **Skills** — findings from a real `/bugs` run; colour literals get swatches; findings become drafts or tasks. | ![Task with an agent fix](10-tasks-agent-fix.webp) **Tasks** — delegated to an agent, the fix comes back as a patch to accept or reject. |
| ![New space](11-new-space.webp) **New space** — say what to change; the agent works in its own worktree. | ![A space](12-space.webp) **A space** — the conversation beside the live diff, then Open PR. |
| ![Space app and logs](15-space-run-logs.webp) **Run the app** — the project config's `run` command, Open app in the browser, the setup / run / check logs. | ![Project config](13-project-config.webp) **Project config** — created from your settings, checked as you type, saved to the repo (as a PR), locally or globally. |
| ![Overview](17-overview.webp) **Overview** — the full title, branches, reviewers and approvals, labels and the description. | ![Colour swatches](16-colour-swatches.webp) **Colour swatches** — every colour literal in code gets one; hover for hex, rgb and hsl. |
| ![Labs](18-labs.webp) **Labs** — features in progress, off by default: Linear, GitLab, Bitbucket. | ![Dark theme](14-review-dark.webp) **Dark theme** — or System, which follows macOS. |

Retake them with the sandbox: `theodore sandbox init <dir>`, then run the app
with `THEODORE_SANDBOX=<dir>` and `"agents": "real"` in `scenario.json`.
