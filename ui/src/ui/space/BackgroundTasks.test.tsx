/** Background tasks: which ones show, and their rows in the strip above the
 *  composer (`SpaceAgents`). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { click, mount, settle, type Mounted } from '../../test/dom';
import type { BackgroundTask, Space, SpaceRemote } from '../../gen/contract';
import { setTransport } from '../../core/transport';
import { RootStore } from '../../stores/RootStore';
import { RootStoreProvider } from '../../stores/context';
import { FakeTransport } from '../../test/fakeTransport';
import { SpaceAgents } from './SpaceAgents';
import { ENDED_SHOW_MS, runningCalls, shownTasks } from './backgroundTaskRows';

let m: Mounted | null = null;
let transport: FakeTransport;
let store: RootStore;

beforeEach(() => {
  transport = new FakeTransport();
  setTransport(transport);
  store = new RootStore();
});

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

let n = 0;
/** A fresh id each: the strip stays open or closed per space. */
const space = (
  background_tasks: BackgroundTask[],
  remote: SpaceRemote | null = null,
): Space =>
  ({
    id: `s${++n}`,
    status: 'idle',
    agent: 'claude',
    updated_at: 0,
    background_tasks,
    remote,
  }) as unknown as Space;

async function render(s: Space) {
  m = await mount(
    <RootStoreProvider store={store}>
      <SpaceAgents space={s} />
    </RootStoreProvider>,
  );
}

const toggle = () =>
  m!.host.querySelector<HTMLButtonElement>('button[aria-expanded]')!;

describe('background tasks', () => {
  it('shows what runs, and lets go of what ended', () => {
    const now = 100_000;
    const ended = task({ id: 'b', status: 'completed', ended_at: now - 1000 });
    const old = task({
      id: 'c',
      status: 'completed',
      ended_at: now - ENDED_SHOW_MS - 1,
    });
    const shown = shownTasks(space([task({}), ended, old]), now);
    expect(shown.map((t) => t.id)).toEqual(['t1', 'b']);
    // Cut or lost stays until the next turn clears it.
    const lost = task({ id: 'l', status: 'lost', ended_at: 1 });
    expect(shownTasks(space([lost]), now).map((t) => t.id)).toEqual(['l']);
  });

  it('knows which calls are still running', () => {
    expect(
      runningCalls(
        space([task({}), task({ id: 't2', status: 'stopped', call: 'c2' })]),
      ),
    ).toEqual(new Set(['c1']));
  });

  it('shows nothing with no tasks, or only long-ended ones', async () => {
    await render(space([]));
    expect(m!.host.textContent).toBe('');
    m!.unmount();
    await render(
      space([task({ status: 'completed', started_at: 1, ended_at: 2 })]),
    );
    expect(m!.host.textContent).toBe('');
  });

  it('opens to its Background rows and stops one task', async () => {
    transport.onCall('space_stop_task', () => null);
    const s = space([
      task({ started_at: Date.now() - 65_000 }),
      task({ id: 't2', kind: 'subagent', description: 'refactor auth' }),
    ]);
    await render(s);
    expect(m!.host.textContent).toContain(
      '1 agent running · 1 command running',
    );
    // Something runs: the line spins.
    expect(toggle().dataset.busy).toBe('true');
    await click(toggle());
    expect(m!.host.textContent).toContain('Background');
    const rows = [...m!.host.querySelectorAll('li')];
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
    ).toEqual([{ space: s.id, task: 't1' }]);
  });

  it('says how a task ended', async () => {
    await render(
      space([
        task({ status: 'cut', ended_at: 1, note: 'cut off' }),
        task({ id: 't2', status: 'lost', ended_at: 1 }),
      ]),
    );
    expect(m!.host.textContent).toContain('1 command lost');
    await click(toggle());
    expect(m!.host.querySelectorAll('.background-task-stop')).toHaveLength(0);
    expect(m!.host.textContent).toContain('cut off');
    expect(m!.host.textContent).toContain('lost');
  });

  it("a remote space's tasks are shown, not stopped", async () => {
    await render(
      space([task({})], {
        space: 'rs_1',
        host_device: 'd',
        host_name: 'Box',
        project_name: 'app',
        started_here: true,
      }),
    );
    await click(toggle());
    expect(m!.host.textContent).toContain('sleep 300');
    expect(m!.host.querySelectorAll('.background-task-stop')).toHaveLength(0);
  });
});
