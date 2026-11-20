/**
 * A background task's row in the strip above the composer (`SpaceAgents`,
 * docs/spaces.md "Background tasks"): its kind, what it is, how it ended,
 * how long it has run, and Stop.
 *
 * ```text
 *   ⌘ pnpm test --watch            1m 12s   [Stop]
 *   ⚙ refactor auth       lost        12s
 * ```
 */
import { useEffect, useState } from 'react';
import { Cpu, Terminal } from '@gravity-ui/icons';
import { Button } from '@heroui/react';
import type { BackgroundTask } from '../../gen/contract';
import { api } from '../../core/api';
import { formatDuration } from '../turnRows';
import { endedLabel } from './backgroundTaskRows';

/** A running clock, while something on screen is timed or is about to go. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** Stop for one running task; a refusal is toasted by api.ts and the
 *  button comes back to try again. */
export function StopTask({
  space,
  task,
}: {
  space: string;
  task: Pick<BackgroundTask, 'id' | 'description'>;
}) {
  const [stopping, setStopping] = useState(false);
  const stop = () => {
    setStopping(true);
    void api
      .spaceStopTask(space, task.id)
      .catch(() => {})
      .finally(() => setStopping(false));
  };
  return (
    <Button
      size="sm"
      variant="ghost"
      className="background-task-stop h-5 min-w-0 shrink-0 px-1.5 text-xs"
      isDisabled={stopping}
      aria-label={`Stop ${task.description}`}
      onPress={stop}
    >
      Stop
    </Button>
  );
}

export function BackgroundTaskRow({
  space,
  task,
  now,
  canStop,
}: {
  space: string;
  task: BackgroundTask;
  now: number;
  /** A remote space's tasks run on its host: shown, not stopped. */
  canStop: boolean;
}) {
  const running = task.status === 'running';
  const Icon = task.kind === 'subagent' ? Cpu : Terminal;
  const elapsed = (task.ended_at ?? now) - task.started_at;
  return (
    <li
      data-status={task.status}
      className="background-task flex min-w-0 items-center gap-2 px-1 py-0.5"
      title={task.note ?? task.description}
    >
      <span className="grid size-3.5 shrink-0 place-items-center text-muted">
        <Icon className="size-3" />
      </span>
      <span className="min-w-0 flex-1 truncate">{task.description}</span>
      {!running && (
        <span
          className={`shrink-0 ${task.status === 'failed' || task.status === 'lost' ? 'text-danger' : 'text-muted'}`}
        >
          {endedLabel(task.status)}
        </span>
      )}
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted">
        {formatDuration(Math.max(0, elapsed))}
      </span>
      {running && canStop && <StopTask space={space} task={task} />}
    </li>
  );
}
