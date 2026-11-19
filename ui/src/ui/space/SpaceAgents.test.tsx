/** The space page's Agents panel and "from <parent>" link, the Agents view,
 *  and a subagent's timeline row answering a reveal. */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Space, TurnStep } from '../../gen/contract';
import { setTransport } from '../../core/transport';
import { RootStore } from '../../stores/RootStore';
import { RootStoreProvider } from '../../stores/context';
import { FakeTransport } from '../../test/fakeTransport';
import { click, mount, settle, type Mounted } from '../../test/dom';
import { pendingReveal, revealCall } from '../rowState';
import { TurnActivity } from '../TurnTimeline';
import { AgentsPage } from './AgentsPage';
import { ParentLink, SpaceAgents } from './SpaceAgents';
import { spaceChatKey } from './spaces';

Element.prototype.scrollIntoView ??= function () {};

const space = (id: string, over: Partial<Space> = {}): Space => ({
  id,
  project: 'local:app',
  name: id,
  goal: `Goal ${id}`,
  branch: `theo/${id}`,
  base: 'main',
  base_sha: 'b',
  head_sha: 'h',
  worktree: `/tmp/${id}`,
  status: 'idle',
  agent: 'claude',
  model: null,
  mode: 'edit',
  review_pr: null,
  pr: null,
  turns: 1,
  run: null,
  error: null,
  created_at: 0,
  updated_at: 0,
  ...over,
});

const agent = (id: string, over: Partial<TurnStep> = {}): TurnStep =>
  ({
    kind: 'tool',
    name: 'Agent',
    target: null,
    ok: null,
    id,
    detail: `Explore ${id}`,
    ...over,
  }) as TurnStep;

const msg = (id: string, over: Partial<ChatMessage>): ChatMessage => ({
  id,
  pr: spaceChatKey('a'),
  author: { kind: 'me' },
  text: '',
  refs: [],
  at: 1,
  failed: null,
  ...over,
});

let m: Mounted | null = null;
let store: RootStore;
let transport: FakeTransport;

beforeEach(() => {
  localStorage.clear();
  transport = new FakeTransport();
  transport.onCall('tool_payload', (args) =>
    args?.call === 'x1'
      ? { input: { value: { model: 'sonnet' } }, result: null }
      : null,
  );
  setTransport(transport);
  store = new RootStore();
});

afterEach(() => {
  m?.unmount();
  m = null;
});

const put = (s: Space) => store.sync.pool.put('space', s.id, s);

async function render(node: React.ReactNode) {
  m = await mount(<RootStoreProvider store={store}>{node}</RootStoreProvider>);
}

/** Open stays open per space for the window's life: open it if it isn't. */
async function openPanel() {
  const toggle = m!.host.querySelector('button[aria-expanded]')!;
  if (toggle.getAttribute('aria-expanded') !== 'true') await click(toggle);
}

describe('the Agents panel', () => {
  it('shows nothing when the space started nothing', async () => {
    const a = space('a');
    put(a);
    await render(<SpaceAgents space={a} />);
    expect(m!.host.textContent).toBe('');
  });

  it("lists the running turn's subagents and the sub-spaces, live", async () => {
    const a = space('a', { status: 'running', run: 'r1' });
    put(a);
    put(
      space('c', {
        parent: { space: 'a', depth: 1 },
        status: 'running',
        turns: 3,
      }),
    );
    put(space('d', { parent: { space: 'a', depth: 1 }, mode: 'plan' }));
    store.sync.pool.put('chat_message', 'm1', msg('m1', {}));
    act(() => {
      store.ephemeral.handle({
        type: 'run_step',
        run: 'r1',
        step: agent('x1'),
      });
    });
    await render(<SpaceAgents space={a} />);
    const host = m!.host;
    expect(host.textContent).toContain(
      '1 agent running · 2 sub-spaces, 1 running',
    );
    await openPanel();
    await settle();
    expect(host.textContent).toContain('This turn');
    const line = host.querySelector('.space-subagent')!;
    expect(line.textContent).toContain('Explore x1');
    expect(line.textContent).toContain('running');
    // Its model, from the call's payload.
    expect(line.querySelector('.space-subagent-model')?.textContent).toBe(
      'sonnet',
    );
    const subs = [...host.querySelectorAll('.space-subspace')].map(
      (r) => r.textContent,
    );
    expect(subs).toEqual([
      'Goal cclaude · Edit · 3 turnsrunning',
      'Goal dclaude · Plan · 1 turn',
    ]);

    // It ends: the line says so, without a reload.
    act(() => {
      store.ephemeral.handle({
        type: 'run_step_done',
        run: 'r1',
        id: 'x1',
        ok: true,
        summary: 'found it',
      });
    });
    expect(host.querySelector('.space-subagent')!.textContent).toContain(
      'done',
    );
  });

  it('a subagent asks for its timeline row; a sub-space opens', async () => {
    const a = space('a', { status: 'running', run: 'r1' });
    put(a);
    put(space('c', { parent: { space: 'a', depth: 1 } }));
    store.sync.pool.put('chat_message', 'm1', msg('m1', {}));
    act(() => {
      store.ephemeral.handle({
        type: 'run_step',
        run: 'r1',
        step: agent('x1'),
      });
    });
    const scrollToKey = vi.fn(() => true);
    const log = { current: { scrollToKey, jumpToLatest: () => {} } };
    await render(<SpaceAgents space={a} log={log} />);
    await openPanel();
    await click(m!.host.querySelector('.space-subagent button'));
    expect(scrollToKey).toHaveBeenCalledWith('m1', 'start');
    expect(pendingReveal()).toMatchObject({
      call: 'x1',
      space: 'a',
      turn: 'm1',
    });
    await click(m!.host.querySelector('.space-subspace button'));
    expect(store.ui.route).toEqual({ name: 'space', id: 'c' });
  });
});

describe('"from <parent>"', () => {
  it('links to the space that started it', async () => {
    put(space('p', { title: 'Parent work' }));
    const c = space('c', { parent: { space: 'p', depth: 1 } });
    put(c);
    await render(<ParentLink space={c} />);
    const link = m!.host.querySelector<HTMLButtonElement>('.space-parent')!;
    expect(link.textContent).toBe('from Parent work');
    await click(link);
    expect(store.ui.route).toEqual({ name: 'space', id: 'p' });
  });

  it('says so when that one is gone, and nothing for a top-level space', async () => {
    const c = space('c', { parent: { space: 'gone', depth: 1 } });
    await render(
      <>
        <ParentLink space={c} />
        <ParentLink space={space('top')} />
      </>,
    );
    expect(m!.host.textContent).toBe('from a removed space');
    expect(m!.host.querySelector('button')).toBeNull();
  });
});

describe('the Agents view', () => {
  it('says nothing runs when nothing does', async () => {
    put(space('a'));
    await render(<AgentsPage />);
    expect(m!.host.textContent).toContain('No agents running');
  });

  it('lists each busy tree: turn, subagents, background tasks, sub-spaces', async () => {
    put(space('a', { status: 'running', run: 'r1', updated_at: 5 }));
    put(
      space('k', {
        parent: { space: 'a', depth: 1 },
        background_tasks: [
          {
            id: 't1',
            kind: 'command',
            description: 'pnpm test --watch',
            started_at: Date.now() - 2000,
            status: 'running',
          },
        ],
      }),
    );
    put(space('idle'));
    act(() => {
      store.ephemeral.handle({
        type: 'run_step',
        run: 'r1',
        step: agent('x1'),
      });
    });
    await render(<AgentsPage />);
    const trees = m!.host.querySelectorAll('.agents-tree');
    expect(trees.length).toBe(1);
    const text = trees[0]!.textContent!;
    expect(text).toContain('Goal a');
    expect(text).toContain('Explore x1');
    expect(text).toContain('Goal k');
    expect(text).toContain('pnpm test --watch');
    expect(m!.host.textContent).not.toContain('Goal idle');

    // A subagent opens its space on its row.
    await click(trees[0]!.querySelector('.space-subagent button'));
    expect(store.ui.route).toEqual({ name: 'space', id: 'a' });
    expect(pendingReveal()?.call).toBe('x1');
  });
});

describe("a subagent's timeline row", () => {
  it('opens the fold it is in and glows when asked for', async () => {
    const steps: TurnStep[] = [
      { kind: 'tool', name: 'Read', target: 'a.rs', ok: true, id: 'r1' },
      { kind: 'tool', name: 'Read', target: 'b.rs', ok: true, id: 'r2' },
      agent('x9', { ok: true, summary: 'done' }),
      { kind: 'tool', name: 'Bash', target: 'ls', ok: true, id: 'b1' },
      { kind: 'tool', name: 'Bash', target: 'pwd', ok: true, id: 'b2' },
      { kind: 'text', text: 'All good.' },
    ];
    await render(<TurnActivity reply="rep1" steps={steps} />);
    expect(m!.host.querySelector('[data-call="x9"]')).toBeNull();
    act(() => revealCall({ call: 'x9' }));
    await settle();
    const row = m!.host.querySelector('[data-call="x9"]');
    expect(row).not.toBeNull();
    expect(row!.classList.contains('reveal-flash')).toBe(true);
    // Shown: nobody else acts on it.
    expect(pendingReveal()).toBeNull();
  });
});
