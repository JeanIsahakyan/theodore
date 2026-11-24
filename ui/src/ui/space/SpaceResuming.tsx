/**
 * A space whose turn Theodore paused to restart (docs/spaces.md §7 "Restart
 * with turns running"), above the composer until the next launch resumes
 * it: "Paused for update · resuming…", then nothing more.
 */
import type { RestartReason, Space } from '../../gen/contract';

/** The strip's text, by why Theodore restarted. */
export function resumingText(reason: RestartReason): string {
  return reason.kind === 'update'
    ? 'Paused for update · resuming…'
    : 'Paused for restart · resuming…';
}

export function SpaceResuming({ space }: { space: Space }) {
  const pause = space.restart_pause;
  if (!pause || space.status === 'archived' || space.status === 'running')
    return null;
  return (
    <div
      role="status"
      className="space-resuming flex items-center gap-2 px-2 text-xs text-muted"
    >
      <span className="min-w-0 flex-1 truncate">
        {resumingText(pause.reason)}
      </span>
    </div>
  );
}
