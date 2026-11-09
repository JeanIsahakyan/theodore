/**
 * What the composer's background-task line shows (docs/spaces.md "Background
 * tasks"). Running tasks always; one that ended a moment ago, briefly, so its
 * outcome is seen; a cut or lost one stays until the next turn clears it.
 */
import type {
  BackgroundTask,
  BackgroundTaskStatus,
  Space,
} from '../../gen/contract';

/** How long a finished task's row stays once it ended. */
export const ENDED_SHOW_MS = 8000;

/** Ended rows worth keeping visible until the next turn clears them. */
const STICKY: readonly BackgroundTaskStatus[] = ['cut', 'lost'];

export function backgroundTasks(space: Space): BackgroundTask[] {
  return space.background_tasks ?? [];
}

export const runningTasks = (space: Space): BackgroundTask[] =>
  backgroundTasks(space).filter((t) => t.status === 'running');

/** The ids of running tasks' tool calls: the rows that link up with them. */
export const runningCalls = (space: Space): Set<string> =>
  new Set(runningTasks(space).flatMap((t) => (t.call ? [t.call] : [])));

/** What the line shows at `now`: running first, then what ended lately. */
export function shownTasks(space: Space, now: number): BackgroundTask[] {
  const all = backgroundTasks(space);
  const running = all.filter((t) => t.status === 'running');
  const ended = all.filter(
    (t) =>
      t.status !== 'running' &&
      (STICKY.includes(t.status) ||
        (t.ended_at != null && now - t.ended_at < ENDED_SHOW_MS)),
  );
  return [...running, ...ended];
}

/** The word a row ends on, once it's no longer running. */
export function endedLabel(status: BackgroundTaskStatus): string {
  switch (status) {
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'stopped';
    case 'cut':
      return 'cut off';
    case 'lost':
      return 'lost';
    case 'running':
      return '';
  }
}

/** The compact line, from what's shown. */
export function headline(shown: BackgroundTask[]): string {
  const running = shown.filter((t) => t.status === 'running').length;
  if (running > 0) return `${running} running in background`;
  const lost = shown.filter((t) => t.status === 'lost').length;
  if (lost > 0) {
    return `${lost} background task${lost === 1 ? '' : 's'} lost`;
  }
  const cut = shown.filter((t) => t.status === 'cut').length;
  if (cut > 0) return `${cut} background task${cut === 1 ? '' : 's'} cut off`;
  return `${shown.length} background task${shown.length === 1 ? '' : 's'} ended`;
}
