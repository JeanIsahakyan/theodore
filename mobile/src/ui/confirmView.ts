/**
 * What the confirm card and the auto control say, as plain strings (no
 * React Native), so the wording is tested and the same everywhere
 * (docs/fleet.md "Requests from Claude via the cloud", "Auto mode").
 *
 * ```text
 * Claude via cloud wants to start an Edit space in theodore on Studio
 * <the goal or the message, plain text>
 * Unanswered by 18:05, it is refused            (Deny) (Allow)
 * ```
 */
import type { FleetMode, McpAuto } from '../gen/fleet';
import type { ConfirmView } from '../fleet/types';
import { MODE_LABEL } from './logic';

/** "an Edit", "a Plan". */
const withArticle = (mode: FleetMode): string => {
  const label = MODE_LABEL[mode];
  return `${/^[AEIOU]/.test(label) ? 'an' : 'a'} ${label}`;
};

/** What the request would do, after "wants to". */
export function confirmWhat(
  c: Pick<ConfirmView, 'action' | 'mode' | 'projectName' | 'spaceName'>,
): string {
  const mode = MODE_LABEL[c.mode];
  const space = c.spaceName || 'a space';
  switch (c.action) {
    case 'start':
      return `start ${withArticle(c.mode)} space in ${c.projectName || 'a project'}`;
    case 'send':
      return `send to ${space} in ${mode}`;
    case 'approve_plan':
      return `approve the plan in ${space} (${mode})`;
    case 'merge':
      return `merge a sub-space into ${space}`;
  }
}

/** The card's first line. */
export const confirmTitle = (
  c: Pick<
    ConfirmView,
    'action' | 'mode' | 'projectName' | 'spaceName' | 'hostName'
  >,
): string => `Claude via cloud wants to ${confirmWhat(c)} on ${c.hostName}`;

const pad = (n: number) => String(n).padStart(2, '0');

/** "18:05", local time. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The card's deadline line. */
export const confirmDeadline = (expiresAtMs: number): string =>
  `Unanswered by ${clock(expiresAtMs)}, it is refused`;

export const AUTO_CHOICES: readonly { value: McpAuto; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'edit', label: 'Auto Edit' },
  { value: 'full', label: 'Full auto' },
];

export type AutoDuration = 'hour' | 'day' | 'forever';

export const AUTO_DURATIONS: readonly { value: AutoDuration; label: string }[] =
  [
    { value: 'hour', label: '1 hour' },
    { value: 'day', label: 'Until end of day' },
    { value: 'forever', label: 'Until I turn it off' },
  ];

/** `until_ms` for a duration picked at `now`: `null` until turned off. */
export function autoUntil(
  d: AutoDuration,
  now: number = Date.now(),
): number | null {
  switch (d) {
    case 'hour':
      return now + 60 * 60 * 1000;
    case 'day': {
      const end = new Date(now);
      end.setHours(23, 59, 59, 999);
      return end.getTime();
    }
    case 'forever':
      return null;
  }
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * How long it stays on: "until 18:00" (today), "until Nov 21, 18:00",
 * "until turned off"; "" when off.
 */
export function autoExpiry(
  auto: McpAuto,
  untilMs: number | null,
  now: number,
): string {
  if (auto === 'off') return '';
  if (untilMs === null) return 'until turned off';
  const a = new Date(untilMs);
  const b = new Date(now);
  const sameDay =
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  return sameDay
    ? `until ${clock(untilMs)}`
    : `until ${MONTHS[a.getMonth()]} ${a.getDate()}, ${clock(untilMs)}`;
}

/** The one warning line under the control; `null` when off. */
export function autoWarning(auto: McpAuto): string | null {
  if (auto === 'off') return null;
  const what = auto === 'full' ? 'edit and run commands' : 'edit';
  return `Its key is held by the Theodore cloud: with auto on, the cloud could make this computer ${what} without you.`;
}
