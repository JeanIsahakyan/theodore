import { afterEach, describe, expect, it } from 'vitest';
import { click, mount, settle, type Mounted } from '../../test/dom';
import type { BackgroundTask, Space } from '../../gen/contract';
import { setTransport } from '../../core/transport';
import { FakeTransport } from '../../test/fakeTransport';
import { BackgroundTasks } from './BackgroundTasks';
import {
  ENDED_SHOW_MS,
  headline,
  runningCalls,
  shownTasks,
} from './backgroundTaskRows';

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

const task = (over: Partial<BackgroundTask>): BackgroundTask => ({
  id: 't1',
  kind: 'command',
  description: 'sleep 300',
  started_at: 0,
  status: 'running',
  ended_at: null,
  note: null,
  run: 'r1',
  call: 'c1',
  ...over,
});

const space = (background_tasks: BackgroundTask[]): Space =>
  ({ id: 's1', status: 'idle', background_tasks }) as unknown as Space;

describe('background tasks', () => {
  it('counts what runs, and lets go of what ended', () => {
    const now = 100_000;
    const ended = task({ id: 'b', status: 'completed', ended_at: now - 1000 });
    const old = task({
      id: 'c',
      status: 'completed',
      ended_at: now - ENDED_SHOW_MS - 1,
    });
    const shown = shownTasks(space([task({}), ended, old]), now);
    expect(shown.map((t) => t.id)).toEqual(['t1', 'b']);
    expect(headline(shown)).toBe('1 running in background');
    // Cut or lost stays until the next turn clears it.
    const lost = task({ id: 'l', status: 'lost', ended_at: 1 });
    expect(shownTasks(space([lost]), now).map((t) => t.id)).toEqual(['l']);
    expect(headline([lost])).toBe('1 background task lost');
  });

  it('knows which calls are still running', () => {
    expect(
      runningCalls(
        space([task({}), task({ id: 't2', status: 'stopped', call: 'c2' })]),
      ),
    ).toEqual(new Set(['c1']));
  });

  it('shows nothing with no tasks', async () => {
    m = await mount(<BackgroundTasks space={space([])} />);
    expect(m.host.textContent).toBe('');
  });

  it('opens to a list and stops one task', async () => {
    const transport = new FakeTransport();
    setTransport(transport);
    transport.onCall('space_stop_task', () => null);
    m = await mount(
      <BackgroundTasks
        space={space([
          task({ started_at: Date.now() - 65_000 }),
          task({ id: 't2', kind: 'subagent', description: 'refactor auth' }),
        ])}
      />,
    );
    expect(m.host.textContent).toContain('2 running in background');
    await click(m.host.querySelector('button')!);
    const rows = [...m.host.querySelectorAll('li')];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('sleep 300');
    expect(rows[0]!.textContent).toContain('1m');
    expect(rows[1]!.dataset.status).toBe('running');
    await click(
      rows[0]!.querySelector<HTMLButtonElement>('.background-task-stop')!,
    );
    await settle();
    expect(
      transport.calls
        .filter((c) => c.cmd === 'space_stop_task')
        .map((c) => c.args),
    ).toEqual([{ space: 's1', task: 't1' }]);
  });

  it('says how a task ended', async () => {
    m = await mount(
      <BackgroundTasks
        space={space([
          task({ status: 'cut', ended_at: 1, note: 'cut off' }),
          task({ id: 't2', status: 'lost', ended_at: 1 }),
        ])}
      />,
    );
    expect(m.host.textContent).toContain('1 background task lost');
    await click(m.host.querySelector('button')!);
    expect(m.host.querySelectorAll('.background-task-stop')).toHaveLength(0);
    expect(m.host.textContent).toContain('cut off');
    expect(m.host.textContent).toContain('lost');
  });
});
