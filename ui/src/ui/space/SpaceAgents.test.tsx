/** The strip above a space's composer (agents, background tasks, sub-spaces) and "from <parent>" link, and a subagent's timeline row answering a reveal. */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentModel,
  BackgroundTask,
  ChatMessage,
  Space,
  TurnStep,
} from '../../gen/contract';
import { setTransport } from '../../core/transport';
import { RootStore } from '../../stores/RootStore';
import { RootStoreProvider } from '../../stores/context';
import { FakeTransport } from '../../test/fakeTransport';
import { click, mount, settle, type Mounted } from '../../test/dom';
import { pendingReveal, revealCall } from '../rowState';
import { TurnActivity } from '../TurnTimeline';
import { resetAgentModels } from '../useAgentModels';
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

const model = (id: string, label: string): AgentModel => ({
  id,
  label,
  description: null,
  efforts: [],
  default_effort: null,
  older: false,
});
const CATALOG = [
  model('claude-opus-5-5', 'Opus 5.5'),
  model('claude-sonnet-5', 'Sonnet 5'),
];

const task = (over: Partial<BackgroundTask>): BackgroundTask => ({
  id: 't',
  kind: 'subagent',
  description: 'x',
  started_at: Date.now() - 5000,
  status: 'running',
  ended_at: null,
  note: null,
  run: 'r1',
  call: null,
  ...over,
});

let m: Mounted | null = null;
let store: RootStore;
let transport: FakeTransport;

beforeEach(() => {
  localStorage.clear();
  transport = new FakeTransport();
  transport.onCall('tool_payload', (args) => {
    // Asked for an alias; ran a listed model; ran one the catalog lacks.
    if (args?.call === 'x1') {
      return { input: { value: { model: 'sonnet' } }, result: null };
    }
    const ran = { x2: 'claude-opus-5-5', x3: 'claude-weird-1' }[
      String(args?.call)
    ];
    return ran ? { input: null, result: { resolved_model: ran } } : null;
  });
  transport.onCall('agent_models', () => CATALOG);
  resetAgentModels();
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

describe('the strip', () => {
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
    // Its model, from the call's payload, by the name the model chip uses.
    expect(line.querySelector('.space-subagent-model')?.textContent).toBe(
      'Sonnet 5',
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

  it('lists each thing once: a background subagent of the turn is its row', async () => {
    transport.onCall('space_stop_task', () => null);
    const a = space('a', {
      status: 'running',
      run: 'r1',
      background_tasks: [
        task({ id: 't2', call: 'x2', description: 'Explore x2' }),
        task({ id: 't3', kind: 'command', description: 'pnpm dev' }),
        task({ id: 't4', call: 'old', description: 'Old research' }),
      ],
    });
    put(a);
    store.sync.pool.put('chat_message', 'm1', msg('m1', {}));
    act(() => {
      for (const step of [
        agent('x2', { background: true }),
        agent('x3', { ok: true }),
      ]) {
        store.ephemeral.handle({ type: 'run_step', run: 'r1', step });
      }
    });
    await render(<SpaceAgents space={a} />);
    const host = m!.host;
    // x2 (its task) and t4 run; x3 is done; one command.
    expect(host.textContent).toContain('2 agents running · 1 command running');
    await openPanel();
    await settle();
    const turn = [...host.querySelectorAll('.space-subagent')];
    expect(turn.map((r) => r.textContent?.includes('Explore x2'))).toEqual([
      true,
      false,
    ]);
    expect(turn[0]!.textContent).toContain('running in background');
    expect(
      [...host.querySelectorAll('.background-task')].map((r) => r.textContent),
    ).toEqual([
      expect.stringContaining('pnpm dev'),
      expect.stringContaining('Old research'),
    ]);
    expect(host.textContent!.split('Explore x2')).toHaveLength(2);
    expect(host.textContent).toContain('Background');
    // Models by name; an id the catalog lacks as itself.
    expect(
      turn.map((r) => r.querySelector('.space-subagent-model')?.textContent),
    ).toEqual(['Opus 5.5', 'claude-weird-1']);
    expect(
      turn[1]!.querySelector('.space-subagent-model')!.className,
    ).not.toContain('font-mono');
    // The turn row's Stop is its task's.
    await click(turn[0]!.querySelector('.background-task-stop'));
    await settle();
    expect(
      transport.calls
        .filter((c) => c.cmd === 'space_stop_task')
        .map((c) => c.args),
    ).toEqual([{ space: 'a', task: 't2' }]);
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
