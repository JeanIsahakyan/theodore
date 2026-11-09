/**
 * Things too frequent for an event each — a tool row opened, a file hovered.
 * Counted here and sent together as one `ui_counts` (docs/telemetry.md).
 *
 * ```text
 * use ─▶ count + 1 ─┬─ 5 minutes after the first ─▶ ui_counts, back to zero
 *                   └─ window hidden first ───────▶ ui_counts, back to zero
 * ```
 */
import { api } from './api';

const FLUSH_MS = 5 * 60_000;

const counts = { tool_rows: 0, file_hovers: 0 };
let timer: ReturnType<typeof setTimeout> | null = null;
let listening = false;

export type CountedUse = keyof typeof counts;

export function countUse(what: CountedUse): void {
  counts[what] += 1;
  timer ??= setTimeout(flushUseCounts, FLUSH_MS);
  if (!listening) {
    listening = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushUseCounts();
    });
  }
}

/** Sends what was counted since the last flush; nothing if nothing was. */
export function flushUseCounts(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const { tool_rows, file_hovers } = counts;
  if (!tool_rows && !file_hovers) return;
  counts.tool_rows = 0;
  counts.file_hovers = 0;
  void api.trackUi({ event: 'ui_counts', tool_rows, file_hovers });
}
