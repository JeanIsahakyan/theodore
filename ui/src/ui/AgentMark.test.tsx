/** The agent's indicator on every surface: what it shows, that a one-shot
 *  plays once, that it doesn't cost rows a render on every step. */
import { act, Profiler, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage as Message, Space, TurnStep } from '../gen/contract';
import { setTransport } from '../core/transport';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { mount, settle, type Mounted } from '../test/dom';
import { FakeTransport } from '../test/fakeTransport';
import { DWELL_MS, ONE_SHOT_MS } from './agentIndicator';
import {
  PrMark,
  ReviewAgentStatus,
  RunIndicator,
  SpaceMark,
  TurnEndMark,
} from './AgentMark';
import { ChatLive, ChatMessage } from './ChatTurn';
import { Sidebar } from './Sidebar';
import { TabBar } from './TabBar';

let m: Mounted | null = null;
let store: RootStore;

beforeEach(() => {
  localStorage.clear();
  setTransport(new FakeTransport());
  store = new RootStore();
});

afterEach(() => {
  m?.unmount();
  m = null;
  vi.useRealTimers();
});

async function render(node: ReactNode) {
  m?.unmount();
  m = await mount(<RootStoreProvider store={store}>{node}</RootStoreProvider>);
}

const fakeTime = () =>
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
const pass = (ms: number) => act(() => vi.advanceTimersByTime(ms));

const mark = () => m!.host.querySelector<HTMLElement>('.pn');
const stateOf = () => mark()?.dataset.state;

const space = (over: Partial<Space> & { id: string }): Space => ({
  project: 'local:app',
  name: over.id,
  goal: '',
  branch: `theo/${over.id}`,
  base: 'main',
  base_sha: 'b',
  head_sha: 'h',
  worktree: `/tmp/${over.id}`,
  status: 'idle',
  agent: 'claude',
  model: null,
  mode: 'edit',
  review_pr: null,
  pr: null,
  turns: 0,
  run: null,
  error: null,
  created_at: 0,
  updated_at: 0,
  ...over,
});

const reply = (over: Partial<Message> = {}): Message =>
  ({
    id: 'reply',
    pr: 'p',
    author: { kind: 'agent', agent: 'claude' },
    text: 'Done.',
    at: 1,
    run: 'r1',
    ...over,
  }) as Message;

const step = (run: string, s: TurnStep) =>
  act(() => store.ephemeral.handle({ type: 'run_step', run, step: s }));
const read = (ok: boolean | null = null): TurnStep => ({
  kind: 'tool',
  name: 'Read',
  target: null,
  ok,
  id: 't1',
});

describe('a running chat turn', () => {
  it('shows the indicator 20 px beside the time, not dots', async () => {
    await render(<ChatLive run="r1" timeline since={1} />);
    const root = mark()!;
    expect(root.style.width).toBe('20px');
    expect(stateOf()).toBe('thinking');
    const line = root.parentElement!;
    expect(line.querySelector('.turn-timer')).not.toBeNull();
    expect(line.className).toContain('chat-status');
  });

  it('names it only while nothing else shows the agent is at work', async () => {
    await render(<ChatLive run="r1" />);
    expect(mark()!.getAttribute('aria-label')).toBe('Agent is thinking');
    act(() => {
      store.ephemeral.handle({
        type: 'agent_delta',
        run: 'r1',
        agent: 'claude',
        text: 'hi',
      });
      store.ephemeral.flushDeltas();
    });
    expect(mark()!.getAttribute('aria-hidden')).toBe('true');
  });

  it('follows the latest step, held long enough to read', async () => {
    fakeTime();
    await render(<RunIndicator run="r1" />);
    step('r1', read());
    expect(stateOf()).toBe('reading');
    step('r1', {
      kind: 'tool',
      name: 'Bash',
      target: 'ls',
      ok: null,
      id: 't2',
    });
    expect(stateOf()).toBe('reading');
    pass(DWELL_MS);
    expect(stateOf()).toBe('loading');
  });

  it('text pieces re-render nothing once the state is writing', async () => {
    let commits = 0;
    await render(
      <Profiler id="status" onRender={() => (commits += 1)}>
        <RunIndicator run="r1" />
      </Profiler>,
    );
    const delta = (text: string) =>
      act(() => {
        store.ephemeral.handle({
          type: 'agent_delta',
          run: 'r1',
          agent: 'claude',
          text,
        });
        store.ephemeral.flushDeltas();
      });
    delta('one');
    expect(stateOf()).toBe('writing');
    const before = commits;
    delta(' two');
    delta(' three');
    expect(commits).toBe(before);
  });

  it('a chat that says stalled shows no thinking', async () => {
    await render(<ChatLive run="r1" />);
    act(() =>
      store.ephemeral.handle({
        type: 'run_stalled',
        run: 'r1',
        agent: 'claude',
      }),
    );
    expect(stateOf()).toBe('idle');
  });
});

describe('TurnEndMark', () => {
  const live = async () => {
    await render(<RunIndicator run="r9" />);
  };

  it('done once on a reply that just ended here, then gone', async () => {
    fakeTime();
    await live();
    await render(<TurnEndMark run="r9" end="done" />);
    expect(stateOf()).toBe('done');
    pass(ONE_SHOT_MS.done);
    expect(mark()).toBeNull();
  });

  it('a remounted row does not replay it', async () => {
    fakeTime();
    await render(<RunIndicator run="r2" />);
    await render(<TurnEndMark run="r2" end="done" />);
    expect(stateOf()).toBe('done');
    await render(<TurnEndMark run="r2" end="done" />);
    expect(mark()).toBeNull();
  });

  it('an old reply scrolled into view plays nothing', async () => {
    await render(<TurnEndMark run="never-watched" end="done" />);
    expect(mark()).toBeNull();
  });

  it('not a turn that ended long ago on another page', async () => {
    fakeTime();
    await render(<RunIndicator run="r3" />);
    m!.unmount();
    m = null;
    pass(60_000);
    await render(<TurnEndMark run="r3" end="done" />);
    expect(mark()).toBeNull();
  });

  it('a fresh failure: error on the failed reply', async () => {
    await render(<RunIndicator run="fail1" />);
    await render(
      <ChatMessage
        m={reply({ run: 'fail1', failed: 'boom', text: '' })}
        onRetryFailed={() => {}}
      />,
    );
    expect(stateOf()).toBe('error');
  });

  it('a stopped turn: neither', async () => {
    await render(<RunIndicator run="stopped1" />);
    await render(
      <ChatMessage
        m={reply({ run: 'stopped1', failed: 'stopped', text: '' })}
      />,
    );
    expect(mark()).toBeNull();
  });

  it('done shows on a reply that came out of a live row', async () => {
    await render(<RunIndicator run="ok1" />);
    await render(<ChatMessage m={reply({ run: 'ok1' })} />);
    expect(stateOf()).toBe('done');
  });
});

describe('SpaceMark', () => {
  const put = (over: Partial<Space>) =>
    act(() => store.sync.pool.put('space', 's1', space({ id: 's1', ...over })));
  const glyph = <span data-testid="fallback">glyph</span>;

  it('a running space: the indicator, 16 px', async () => {
    put({ status: 'running', run: 'r' });
    await render(<SpaceMark spaceId="s1" fallback={glyph} />);
    expect(mark()!.style.width).toBe('16px');
    expect(stateOf()).toBe('thinking');
  });

  it('a question waiting: your turn', async () => {
    put({
      status: 'running',
      run: 'r',
      question: { id: 'q', run: 'r', questions: [] } as never,
    });
    await render(<SpaceMark spaceId="s1" fallback={glyph} />);
    expect(stateOf()).toBe('turn');
  });

  it('a plan to approve: your turn', async () => {
    put({
      status: 'idle',
      turn_log: [
        { message: 'u', reply: 'r', before: 'a', after: 'a', plan: 'do x' },
      ],
    });
    await render(<SpaceMark spaceId="s1" fallback={glyph} />);
    expect(stateOf()).toBe('turn');
  });

  it("anything else is the surface's own mark", async () => {
    put({ status: 'idle' });
    await render(<SpaceMark spaceId="s1" fallback={glyph} />);
    expect(mark()).toBeNull();
    expect(m!.host.querySelector('[data-testid=fallback]')).not.toBeNull();
  });

  it('done once when its turn ends well, then its own mark', async () => {
    fakeTime();
    put({ status: 'running', run: 'r' });
    await render(<SpaceMark spaceId="s1" fallback={glyph} />);
    put({ status: 'idle', run: null });
    expect(stateOf()).toBe('done');
    pass(ONE_SHOT_MS.done);
    expect(mark()).toBeNull();
    expect(m!.host.querySelector('[data-testid=fallback]')).not.toBeNull();
  });

  it('error once when its turn fails, then its own mark', async () => {
    fakeTime();
    put({ status: 'running', run: 'r' });
    await render(<SpaceMark spaceId="s1" fallback={glyph} />);
    put({ status: 'failed', run: null, error: 'no' });
    expect(stateOf()).toBe('error');
    pass(ONE_SHOT_MS.error);
    expect(mark()).toBeNull();
  });

  it('stopped by you: no done', async () => {
    fakeTime();
    put({ status: 'running', run: 'r' });
    await render(<SpaceMark spaceId="s1" fallback={glyph} />);
    act(() => store.ephemeral.markStopping('r', true));
    put({ status: 'idle', run: null });
    pass(DWELL_MS);
    expect(mark()).toBeNull();
  });

  it('a space already idle plays nothing when it mounts', async () => {
    put({ status: 'idle' });
    await render(<SpaceMark spaceId="s1" fallback={glyph} />);
    expect(mark()).toBeNull();
  });
});

describe('a PR', () => {
  it('its tab: the indicator while grouping, its own icon after', async () => {
    const icon = <span data-testid="pr-icon" />;
    await render(<PrMark pr="p" fallback={icon} />);
    expect(m!.host.querySelector('[data-testid=pr-icon]')).not.toBeNull();
    act(() =>
      store.ephemeral.handle({
        type: 'grouping',
        pr: 'p',
        running: true,
        error: null,
      }),
    );
    expect(stateOf()).toBe('loading');
    expect(mark()!.style.width).toBe('16px');
  });

  it('its review header: 20 px beside what it is, only while it runs', async () => {
    await render(<ReviewAgentStatus pr="p" />);
    expect(mark()).toBeNull();
    act(() =>
      store.ephemeral.handle({
        type: 'grouping',
        pr: 'p',
        running: true,
        error: null,
      }),
    );
    expect(mark()!.style.width).toBe('20px');
    expect(m!.host.textContent).toContain('Grouping');
  });
});

describe('the sidebar', () => {
  const rows = () => [
    ...m!.host.querySelectorAll<HTMLElement>('[role=option]'),
  ];
  const rowOf = (name: string) =>
    rows().find((r) => r.textContent?.startsWith(name))!;

  it('keeps unread and failed marks; replaces the running spinner', async () => {
    act(() => {
      store.sync.pool.put(
        'space',
        'run',
        space({ id: 'run', status: 'running', run: 'r', updated_at: 9 }),
      );
      store.sync.pool.put(
        'space',
        'unread',
        space({ id: 'unread', turns: 1, attention_at: 5, updated_at: 5 }),
      );
      store.sync.pool.put(
        'space',
        'broke',
        space({ id: 'broke', status: 'failed', updated_at: 3 }),
      );
    });
    await render(<Sidebar />);
    await settle();
    const running = rowOf('run');
    expect(running.querySelector('.pn')).not.toBeNull();
    expect(running.querySelector('[data-slot=spinner]')).toBeNull();
    expect(
      rowOf('unread').querySelector('[aria-label="Turn finished"]'),
    ).not.toBeNull();
    expect(rowOf('unread').querySelector('.pn')).toBeNull();
    expect(
      rowOf('broke').querySelector('[aria-label="Failed"]'),
    ).not.toBeNull();
  });
});

describe('the tab bar', () => {
  it('a space tab shows the indicator while its agent works', async () => {
    act(() => {
      store.sync.pool.put(
        'space',
        's9',
        space({ id: 's9', status: 'running', run: 'r' }),
      );
      store.ui.go({ name: 'space', id: 's9' });
    });
    await render(<TabBar showOpen={false} />);
    await settle();
    const tab = m!.host.querySelector('.tab .pn') as HTMLElement | null;
    expect(tab).not.toBeNull();
    expect(tab!.style.width).toBe('16px');
  });
});
