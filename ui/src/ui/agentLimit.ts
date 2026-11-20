/**
 * Agent accounts' usage limits in words (docs/plan.md "Agent accounts and
 * limits"): the chip in Settings → Agents, a space's notice rows and its
 * paused row. Times are the local wall clock, as the core's `reset_time`
 * writes them.
 */
import type { AgentLimit, ChatNotice } from '../gen/contract';

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

const pad = (n: number) => String(n).padStart(2, '0');

/** `ms` as the local clock: `18:00` today, `Nov 20 18:00` another day. */
export function resetTime(ms: number, now: number): string {
  const at = new Date(ms);
  const today = new Date(now);
  const hm = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();
  return sameDay ? hm : `${MONTHS[at.getMonth()]} ${at.getDate()} ${hm}`;
}

/** Whether `limit` still refuses runs at `now`: a limit whose reset passed
 *  has reset. */
export function isLimited(
  limit: AgentLimit | null | undefined,
  now: number,
): boolean {
  if (limit?.status !== 'limited') return false;
  return limit.resets_at == null || limit.resets_at > now;
}

/** The chip's words: `ok`, `near limit · 85%`, `limited until 18:00`;
 *  `null`: nothing reported yet. */
export function limitLabel(
  limit: AgentLimit | null | undefined,
  now: number,
): string | null {
  if (!limit) return null;
  switch (limit.status) {
    case 'ok':
      return 'ok';
    case 'warning':
      return limit.used_pct != null
        ? `near limit · ${Math.round(limit.used_pct)}%`
        : 'near limit';
    case 'limited':
      if (!isLimited(limit, now)) return 'ok';
      return limit.resets_at != null
        ? `limited until ${resetTime(limit.resets_at, now)}`
        : 'limited';
  }
}

/** A space's notice row in words, as the core's `notice_text`. */
export function noticeText(notice: ChatNotice, now: number): string {
  const resets = (at: number | null) =>
    at != null ? ` (resets ${resetTime(at, now)})` : '';
  switch (notice.kind) {
    case 'account_switch': {
      const then = notice.continued ? 'continuing on' : 'the next turn runs on';
      return `${notice.from} hit its limit${resets(notice.resets_at)}: ${then} ${notice.to}`;
    }
    case 'limit_hit':
      return `${notice.account} hit its limit${resets(notice.resets_at)}`;
    case 'remote_dropped':
      return `A message queued from ${notice.from} was dropped: ${notice.reason}`;
  }
}

/** A paused space's row: `Paused: limits reset at 18:00 · continues
 *  automatically`; with no reset known, `Paused: usage limits reached`. */
export function pauseText(until: number | null, now: number): string {
  if (until == null) return 'Paused: usage limits reached';
  return `Paused: limits reset at ${resetTime(until, now)} · continues automatically`;
}
