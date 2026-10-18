/**
 * Switches for UI that has no backing command yet (see `.context/commands.md`).
 * The component stays, wired to call the command the moment it exists —
 * until then the action is hidden behind the matching flag here.
 *
 * Flip a flag to `true` once the command lands; don't delete the UI.
 */
export const FEATURES = {
  /** No host-write commands exist yet: take/decline/reassign/merge/auto-merge,
   *  "Ready for review", re-request review, update branch, conflict resolution. */
  hostWrites: false,
  /** No command returns "who am I" — My PRs can't tell mine from anyone's. */
  currentUser: false,
  /** No command adds/clones a project/repo; PRs arrive only via `open_pr`. */
  projects: false,
  /** No go-to-definition / find-references command (LSP was mock-only). */
  symbolPeek: false,
  /** No Linear integration command. */
  linear: false,
  /** Threads live inside `pr_detail` (host truth); no reply/resolve command
   *  sends them to the host yet. */
  threadWrites: false,
  /** `pr_detail` rows (body, commits, checks, reviewers, assignees, labels)
   *  sync like any other model — Checks/Commits tabs, the reviewer strip and
   *  the description disclosure in Review read them. */
  prDetail: true,
} as const;
