/**
 * The agent's background tasks, above the composer: a compact "2 running in
 * background" that opens to a list, each with its kind, what it is, how long
 * it has run, and Stop (docs/spaces.md "Background tasks").
 *
 * ```text
 * ◌ 2 running in background ▾
 *   ▸ ⌘ pnpm test --watch     1m 12s   [Stop]
 *   ▸ ⚙ refactor auth         12s      [Stop]
 * ```
 */
import { useEffect, useState } from 'react';
import { ChevronDown, Cpu, Terminal } from '@gravity-ui/icons';
import { Button } from '@heroui/react';
import type { BackgroundTask, Space } from '../../gen/contract';
import { api } from '../../core/api';
import { Spinner } from '../bits';
import { formatDuration } from '../turnRows';
import { endedLabel, headline, shownTasks } from './backgroundTaskRows';

/** A running clock, while something on screen is timed or is about to go. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export function BackgroundTasks({ space }: { space: Space }) {
  const [open, setOpen] = useState(false);
  const any = (space.background_tasks?.length ?? 0) > 0;
  const now = useNow(any);
  const tasks = shownTasks(space, now);
  if (!tasks.length) return null;
  const running = tasks.some((t) => t.status === 'running');
  return (
    <div
      className="background-tasks flex min-w-0 flex-col gap-1 rounded-lg border border-separator px-3 py-1.5 text-xs"
      aria-label="Background tasks"
    >
      <button
        type="button"
        aria-expanded={open}
        className="flex min-w-0 items-center gap-2 text-left text-muted"
        onClick={() => setOpen(!open)}
      >
        {running && (
          <span className="inline-flex size-3 items-center justify-center">
            <Spinner />
          </span>
        )}
        <span className="min-w-0 truncate">{headline(tasks)}</span>
        <ChevronDown
          className={`ml-auto size-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <ul className="flex flex-col gap-0.5">
          {tasks.map((t) => (
            <TaskRow key={t.id} space={space.id} task={t} now={now} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TaskRow({
  space,
  task,
  now,
}: {
  space: string;
  task: BackgroundTask;
  now: number;
}) {
  const [stopping, setStopping] = useState(false);
  const running = task.status === 'running';
  const Icon = task.kind === 'subagent' ? Cpu : Terminal;
  const elapsed = (task.ended_at ?? now) - task.started_at;
  const stop = () => {
    setStopping(true);
    void api
      .spaceStopTask(space, task.id)
      .catch(() => {
        // Toasted by api.ts; the row stays live to try again.
      })
      .finally(() => setStopping(false));
  };
  return (
    <li
      data-status={task.status}
      className="background-task flex min-w-0 items-center gap-2"
      title={task.note ?? task.description}
    >
      <Icon className="size-3 shrink-0 text-muted" />
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
      {running && (
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
      )}
    </li>
  );
}
