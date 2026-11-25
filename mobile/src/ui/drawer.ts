/**
 * The drawer's list of spaces ("chats"): newest activity first, grouped by
 * day, filtered by the search field. Pure, so the tests read it.
 *
 * ```text
 * Today            activeAt since local midnight
 * Yesterday        the local day before
 * Previous 7 days  the 7 days before that
 * Older            the rest, and spaces with no activity time
 * On your computers  the trusted computers' other spaces (`list_spaces`),
 *                    newest first; each opens like a sub-space
 * ```
 */
import type { ComputerSpaceView, SpaceView } from '../fleet/types';
import { isSheetPath, spaceIdFromPath } from '../shell/paths';
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

/**
 * Whether a route change `from` ─▶ `to` closes an open drawer. A pick in the
 * drawer (a space, Devices, Settings) opens a page: the drawer closes. A
 * sheet opened from it (the Accounts sheet; iOS: a formSheet route) shows
 * over the open drawer, and coming back from one leaves it as it was: only
 * a pick that switches account closes it then (`useAccountsSheet`), or a
 * tap outside / a swipe.
 *
 * ```text
 * /  ─▶ /space/rs_1      closes       /  ─▶ /accounts-sheet   stays open
 * /accounts-sheet ─▶ /   stays open   /  ─▶ /                 nothing
 * ```
 */
export function drawerClosesOn(from: string, to: string): boolean {
  if (from === to) return false;
  return !isSheetPath(to) && !isSheetPath(from);
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

export const COMPUTERS_SECTION = 'On your computers';

export interface ComputerSection {
  title: typeof COMPUTERS_SECTION;
  data: ComputerSpaceView[];
}

/** A computer's own space matches on its title, name, project or computer. */
export function matchesComputerQuery(
  s: ComputerSpaceView,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [s.title, s.name, s.project, s.hostName].some((x) =>
    x.toLowerCase().includes(q),
  );
}

/** The computers' own spaces as one section after the days; none: empty. */
export function computerSections(
  list: readonly ComputerSpaceView[],
  query = '',
): ComputerSection[] {
  const data = list.filter((s) => matchesComputerQuery(s, query));
  return data.length ? [{ title: COMPUTERS_SECTION, data }] : [];
}

/** The dot of a computer's own space, from its listed status. */
export function computerSpaceDot(s: ComputerSpaceView): SpaceDot | null {
  if (s.status === 'question' || s.status === 'waiting') return 'waiting';
  if (s.status === 'running' || s.status === 'setting_up') return 'running';
  if (s.status === 'failed') return 'failed';
  return null;
}

/** "2 sub-spaces, 1 running" under a computer's own space; `null`: none. */
export function computerSubSummary(s: ComputerSpaceView): string | null {
  const n = s.subSpaces.length;
  if (!n) return null;
  const running = s.subSpaces.filter(
    (c) => c.status === 'running' || c.status === 'setting_up',
  ).length;
  const head = n === 1 ? '1 sub-space' : `${n} sub-spaces`;
  return running ? `${head}, ${running} running` : head;
}

/** While the list shows, the computers are asked again this often. */
export const COMPUTERS_REFRESH_MS = 60_000;
