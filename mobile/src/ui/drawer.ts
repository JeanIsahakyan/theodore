/**
 * The drawer's list of spaces ("chats"): newest activity first, grouped by
 * day, filtered by the search field. Pure, so the tests read it.
 *
 * ```text
 * Today            activeAt since local midnight
 * Yesterday        the local day before
 * Previous 7 days  the 7 days before that
 * Older            the rest, and spaces with no activity time
 * ```
 */
import type { SpaceView } from '../fleet/types';
import { spaceIdFromPath } from '../shell/paths';
import { spaceTitle } from './logic';

/**
 * Whether a swipe on the content at `path` opens the drawer: on the
 * top-level screens, Home and a space (the header has ☰, no Back, no system
 * back swipe). Pushed screens (Devices, Settings and its pages, a sub-space)
 * keep their left edge for the system's back swipe.
 */
export function swipeOpensOn(path: string): boolean {
  return path === '/' || spaceIdFromPath(path) !== null;
}

export type DayGroup = 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older';

export const DAY_GROUPS: readonly DayGroup[] = [
  'Today',
  'Yesterday',
  'Previous 7 days',
  'Older',
];

export interface SpaceSection {
  title: DayGroup;
  data: SpaceView[];
}

const DAY = 24 * 60 * 60 * 1000;

/** Local midnight of `now`'s day. */
function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dayGroup(at: number | undefined, now: number): DayGroup {
  if (!at) return 'Older';
  const today = startOfDay(now);
  if (at >= today) return 'Today';
  if (at >= today - DAY) return 'Yesterday';
  if (at >= today - 8 * DAY) return 'Previous 7 days';
  return 'Older';
}

/** Matches the title, project or host, case-insensitively. */
export function matchesQuery(s: SpaceView, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [spaceTitle(s), s.projectName, s.hostName].some((x) =>
    x.toLowerCase().includes(q),
  );
}

/** Non-empty day sections, each newest first (store order on ties). */
export function spaceSections(
  spaces: readonly SpaceView[],
  now: number,
  query = '',
): SpaceSection[] {
  const sorted = spaces
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => matchesQuery(s, query))
    .sort((a, b) => (b.s.activeAt ?? 0) - (a.s.activeAt ?? 0) || a.i - b.i)
    .map(({ s }) => s);
  const by = new Map<DayGroup, SpaceView[]>();
  for (const s of sorted) {
    const g = dayGroup(s.activeAt, now);
    const list = by.get(g);
    if (list) list.push(s);
    else by.set(g, [s]);
  }
  return DAY_GROUPS.filter((g) => by.has(g)).map((g) => ({
    title: g,
    data: by.get(g)!,
  }));
}

/** The small dot after a row's title; `null`: none. */
export type SpaceDot = 'running' | 'waiting' | 'failed';

export function spaceDot(s: SpaceView): SpaceDot | null {
  if (s.question || s.status === 'waiting') return 'waiting';
  if (s.status === 'running' || s.status === 'starting') return 'running';
  if (s.status === 'failed') return 'failed';
  return null;
}

/** "Jean Isahakyan" → "JI"; an email's first letter; "?" for nothing. */
export function initials(name: string | null | undefined, email = ''): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2)
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (email.trim()[0] ?? '?').toUpperCase();
}
