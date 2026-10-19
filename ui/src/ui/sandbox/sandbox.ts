/** Pure helpers for sandbox mode (docs/sandbox.md): the SANDBOX badge, the
 *  window title, and Settings → Sandbox. Kept free of React so they're simple
 *  to unit-test. */
import type { SandboxInfo } from '../../gen/contract';

/** How often Settings → Sandbox re-reads `sandbox_status` while mounted —
 *  the scripted timeline fires on its own, so the page has to follow it. */
export const SANDBOX_POLL_MS = 2000;

export const SANDBOX_TITLE_PREFIX = '[SANDBOX] ';

export interface SandboxBadge {
  label: string;
  tooltip: string;
}

/** `null` outside sandbox mode — no badge at all. */
export function sandboxBadge(info: SandboxInfo | null): SandboxBadge | null {
  if (!info) return null;
  return {
    label: 'SANDBOX',
    tooltip: `Simulated host — scenario "${info.scenario}", data in ${info.data_dir}`,
  };
}

/** `title` with the `[SANDBOX] ` prefix in sandbox mode and without it
 *  otherwise; idempotent, so re-applying never stacks prefixes. */
export function windowTitle(title: string, info: SandboxInfo | null): string {
  const base = title.startsWith(SANDBOX_TITLE_PREFIX)
    ? title.slice(SANDBOX_TITLE_PREFIX.length)
    : title;
  return info ? SANDBOX_TITLE_PREFIX + base : base;
}

/** `SandboxEvent.at_ms` as a due time: "at 45s", "at 2m 5s", or "manual"
 *  for an event that only fires on demand. */
export function formatDue(atMs: number | null): string {
  if (atMs === null) return 'manual';
  const total = Math.max(0, Math.round(atMs / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `at ${s}s`;
  return s === 0 ? `at ${m}m` : `at ${m}m ${s}s`;
}

/** Settings pages to list: the `sandbox` page only in sandbox mode. */
export function visibleSettingsPages<T extends { id: string }>(
  pages: readonly T[],
  info: SandboxInfo | null,
): T[] {
  return pages.filter((p) => p.id !== 'sandbox' || info !== null);
}

/** Applies responses in request order only: a poll that started before a
 *  toggle but resolved after it must not roll the toggle back on screen. */
export function latestOnly() {
  let issued = 0;
  let applied = 0;
  return {
    /** Call when a request starts; pass the ticket to `accept` on reply. */
    next: () => ++issued,
    /** `true` if this reply is newer than any already applied. */
    accept: (ticket: number) => {
      if (ticket <= applied) return false;
      applied = ticket;
      return true;
    },
  };
}
