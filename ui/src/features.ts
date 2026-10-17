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
  /** No command returns `PrDetail` (body, commits, checks list, reviewers,
   *  assignees, labels) — only the `PrSummary` rollup and the diff (`Revision`)
   *  are reachable today. Checks/commits tabs and the reviewer strip are
   *  parked behind this until such a command exists. */
  prDetail: false,
} as const;
