/** Pure computations for the repo-summary peek shown when nothing is
 *  selected (plan "the projects page isn't very informative"). `PrSummary`
 *  carries no history — no `merged_at`, no `created_at` — so these read
 *  `updated_at` off the PR rows we already have rather than inventing a
 *  field; each function's doc says exactly what it approximates. */
import type { InboxPr } from '../List';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Merged PRs per week for the last 4 weeks, oldest first. Uses
 *  `updated_at` as the merge time (a merged PR's last host-side update) —
 *  accurate for anything merged through the normal flow, not for a PR
 *  re-touched after merging (e.g. a label change), which there's no way
 *  to tell apart from here. */
export function mergesPerWeek(items: InboxPr[], now: number): number[] {
  const weeks = [0, 0, 0, 0];
  for (const p of items) {
    if (p.state !== 'merged') continue;
    const age = now - p.updated_at;
    if (age < 0 || age >= 4 * WEEK_MS) continue;
    weeks[3 - Math.floor(age / WEEK_MS)]!++;
  }
  return weeks;
}

export interface AuthorCount {
  login: string;
  count: number;
}

/** Most active authors across every PR row this project has loaded (open
 *  plus the last 14 days of merged/closed) — highest count first, ties
 *  broken alphabetically for a stable order. */
export function topAuthors(items: InboxPr[], limit = 5): AuthorCount[] {
  const counts = new Map<string, number>();
  for (const p of items) {
    counts.set(p.author.login, (counts.get(p.author.login) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([login, count]) => ({ login, count }))
    .sort((a, b) => b.count - a.count || a.login.localeCompare(b.login))
    .slice(0, limit);
}

export function failingChecksCount(items: InboxPr[]): number {
  return items.filter(
    (p) => (p.state === 'open' || p.state === 'draft') && p.checks === 'fail',
  ).length;
}

/** The least-recently-updated open PR, and how long it's been since that
 *  update — the closest proxy available for "how long has this been open"
 *  without a true open timestamp. `null` with nothing open. */
export function oldestOpenPrAge(
  items: InboxPr[],
  now: number,
): { number: number; ageMs: number } | null {
  const open = items.filter((p) => p.state === 'open' || p.state === 'draft');
  if (!open.length) return null;
  const oldest = [...open].sort((a, b) => a.updated_at - b.updated_at)[0]!;
  return { number: oldest.pr.number, ageMs: now - oldest.updated_at };
}
