/**
 * Pure logic for @-mention autocomplete in a comment composer: finding the
 * `@query` under the caret, filtering candidates against it, moving the
 * selected index on arrow keys, and building the replacement text once one
 * is picked. No React, no store, no network.
 */

export interface MentionQuery {
  /** Index of the `@` itself. */
  start: number;
  /** Index right after the query text — the caret, when the query is live. */
  end: number;
  query: string;
}

/** The `@word` immediately before `caret`, if any. The `@` must start the
 *  text or follow whitespace (so an email-like `a@b` never triggers it),
 *  and the query itself holds no whitespace — once the reviewer types a
 *  space the mention is "finished" and the menu closes, even if the caret
 *  is still inside that same word on a later edit. */
export function mentionQueryAt(
  text: string,
  caret: number,
): MentionQuery | null {
  const before = text.slice(0, caret);
  const m = /(?:^|\s)@([\w-]*)$/.exec(before);
  if (!m) return null;
  const query = m[1] ?? '';
  return { start: caret - query.length - 1, end: caret, query };
}

/** Login-prefix match, case-insensitive, viewer excluded, capped — a
 *  reviewer can't mention themselves and the menu stays short enough to
 *  scan without scrolling. */
export function filterMentions<T extends { login: string }>(
  people: readonly T[],
  query: string,
  viewerLogin?: string | null,
  limit = 6,
): T[] {
  const q = query.toLowerCase();
  return people
    .filter((p) => p.login !== viewerLogin)
    .filter((p) => p.login.toLowerCase().startsWith(q))
    .slice(0, limit);
}

/** Next selected index on an arrow key, clamped (not wrapped) — Down past
 *  the last option, or Up past the first, stays put. */
export function moveMentionIndex(
  count: number,
  index: number,
  delta: 1 | -1,
): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, index + delta));
}

/** Replaces the `@query` under the caret with `@login `, and the caret
 *  position right after it, so a later keystroke continues in the right
 *  place instead of before the inserted mention. */
export function insertMention(
  text: string,
  q: MentionQuery,
  login: string,
): { text: string; caret: number } {
  const insert = `@${login} `;
  return {
    text: text.slice(0, q.start) + insert + text.slice(q.end),
    caret: q.start + insert.length,
  };
}
