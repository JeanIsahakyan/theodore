/**
 * Switches for UI that has no backing command yet (see `.context/commands.md`).
 * The component stays, wired to call the command the moment it exists —
 * until then the action is hidden behind the matching flag here.
 *
 * Flip a flag to `true` once the command lands; don't delete the UI.
 */
export const FEATURES = {
  /** `merge_info` / `merge_pr` / `assignable_users` / `set_reviewers` /
   *  `set_draft` / `update_branch` land this wave: merge, auto-merge, merge
   *  queue, reviewer picker, "Ready for review" / "Convert to draft", update
   *  branch. Still no command for conflict resolution — that stays gated
   *  locally where it's rendered. */
  hostWrites: true,
  /** `triage` (take / decline / reassign a review request) and
   *  `rerun_check` land this wave. */
  triage: true,
  /** `viewer` returns the authenticated host user — the Mine filter uses it. */
  currentUser: true,
  /** `list_host_repos` / `add_project` / `remove_project` / `refresh_project`
   *  land this wave — projects can be added, browsed and removed. */
  projects: true,
  /** `find_symbol`: go-to-definition / find-references via `git grep`,
   *  not a real language server. */
  symbolPeek: true,
  /** `set_linear_token` / `linear_status` / `linear_issues` — Settings →
   *  Integrations, and issue chips in Peek/Review. Shown only once the
   *  `labs.linear` setting is on too (Settings → Labs, `isLinearOn`). */
  linear: true,
  /** `reply_thread` / `resolve_thread` send to the host; the comment lands
   *  back in `pr_detail.threads` on the next sync frame. */
  threadWrites: true,
  /** `pr_detail` rows (body, commits, checks, reviewers, assignees, labels)
   *  sync like any other model — Checks/Commits tabs, the reviewer strip and
   *  the description disclosure in Review read them. */
  prDetail: true,
  /** Spaces (docs/spaces.md): an agent writes a change in its own worktree
   *  before it becomes a PR. On for everyone unless the `labs.build_mode`
   *  setting turns them off (Settings → Spaces); `true` here forces them on.
   *  Off means no route, sidebar section, modal or key for them. */
  buildMode: false,
} as const;
