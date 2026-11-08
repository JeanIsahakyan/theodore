# Screenshots

Taken in the sandbox (`docs/sandbox.md`) — a simulated `acme/storefront` and
`acme/billing`, no real data — with real Claude runs for the grouping, the AI
answers, the skill findings, the task fix and the spaces. 1452×864 window,
Retina, macOS window shadow, WebP.

| | |
| --- | --- |
| ![Inbox](01-inbox.webp) **Inbox** — review requests, assignments and mentions in sections; the preview shows a PR with its actions. | ![Pull requests](02-pull-requests.webp) **Pull requests** — every PR of the workspace, filtered All / Mine / Drafts / Merged; Mine groups your PRs by what each needs to merge; one status mark per PR. |
| ![Grouped review](03-review-grouped.webp) **Review, grouped by meaning** — titled groups with a why, a risk and a checklist, read in order; a progress line counts the groups read. | ![AI panel](04-ai-panel.webp) **AI panel** — ask about the change; the agent reads the diff through the review tools; attach files; vote or report a reply. |
| ![Split diff with a draft](05-split-diff-draft.webp) **Split diff and a draft** — a comment on a line, sent with the review; threads reply and resolve on the host. | ![Command palette](06-command-palette.webp) **⌘K** — every action and PR, with its key. |
| ![Workspace switcher](07-workspace-switcher.webp) **Workspaces** — All projects or one project, ⌃0 / ⌃1…9; each keeps its own tabs. | ![Branches](08-branches.webp) **Branches** — ahead / behind, the PR a branch belongs to, a local review of any branch. |
| ![Skill findings](09-skill-findings.webp) **Skills** — findings from a real `/bugs` run; findings become drafts or tasks. | ![Task with an agent fix](10-tasks-agent-fix.webp) **Tasks** — delegated to an agent, the fix comes back as a patch to accept or reject. |
| ![New space](11-new-space.webp) **New space** — say what to change; agent, model, effort and mode are this space's own. | ![A blank new space](24-new-space-blank.webp) **A blank space** — Create with nothing typed, or `/` for a skill; the first message names it. |
| ![A space](12-space.webp) **A space** — the conversation beside the live diff, then Open PR. | ![Space app and logs](15-space-run-logs.webp) **Run the app** — the project config's `run` command, Open app in the browser, the setup / run / check logs. |
| ![A command's output](19-space-command-output.webp) **Tool rows open** — a command in full, its exit code and output. | ![A subagent](20-space-subagent.webp) **Subagents** — the prompt, its steps, the report. |
| ![File hover](21-file-hover.webp) **Hover a file** — its diff in that turn. | ![Report from a chat](23-report-from-chat.webp) **Report this** — from a chat reply, with exactly what would be posted. |
| ![My reports](22-my-reports.webp) **My reports** — Settings → About: the issues you opened, followed until the fix ships. | ![Project config](13-project-config.webp) **Project settings → Config** — created from your settings, checked as you type, saved to the repo (as a PR), locally or globally. |
| ![Pinned file header](25-review-pinned-header.webp) **A pinned file header** — the file you're in stays named while its diff scrolls. | ![Overview](17-overview.webp) **Overview** — the full title, branches, reviewers and approvals, labels and the description. |
| ![Colour swatches](16-colour-swatches.webp) **Colour swatches** — every colour literal in code gets one; hover for hex, rgb and hsl. | ![Labs](18-labs.webp) **Labs** — features in progress, off by default: Linear, GitLab, Bitbucket. |
| ![Dark theme](14-review-dark.webp) **Dark theme** — or System, which follows macOS. | |

Retake them with the sandbox and the QA kit (`docs/live-qa.md`): real agent runs
on a cheap model, and before each capture the production accent set through
the page (`document.documentElement.dataset.build`, and the store's
`AppInfo.build_env` for the logo).
