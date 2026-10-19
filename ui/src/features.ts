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
  /** `viewer` returns the authenticated host user — My PRs filters on it. */
  currentUser: true,
  /** `list_host_repos` / `add_project` / `remove_project` / `refresh_project`
   *  land this wave — projects can be added, browsed and removed. */
  projects: true,
  /** No go-to-definition / find-references command (LSP was mock-only). */
  symbolPeek: false,
  /** No Linear integration command. */
  linear: false,
  /** `reply_thread` / `resolve_thread` send to the host; the comment lands
   *  back in `pr_detail.threads` on the next sync frame. */
  threadWrites: true,
  /** `pr_detail` rows (body, commits, checks, reviewers, assignees, labels)
   *  sync like any other model — Checks/Commits tabs, the reviewer strip and
   *  the description disclosure in Review read them. */
  prDetail: true,
} as const;
