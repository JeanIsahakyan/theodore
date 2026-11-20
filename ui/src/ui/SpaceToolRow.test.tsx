/** A parent's timeline rows for the local-space tools: the child by name
 *  with its stage, live; a wait's counts as the children move; a merge's
 *  lines and conflicts; an ask's answer when opened; and a finished turn
 *  keeps them in view instead of folding them away. */
import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { click, mount, settle, type Mounted } from '../test/dom';
import type { Space, ToolPayload, TurnStep } from '../gen/contract';
import { setTransport } from '../core/transport';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { FakeTransport } from '../test/fakeTransport';
import { TimelineRows, TurnActivity } from './TurnTimeline';
import { ToolRunContext, forgetToolPayloads } from './toolPayload';

let m: Mounted | null = null;
let transport: FakeTransport;
let store: RootStore;
let RUN = '';
let runs = 0;
/** What `tool_payload` answers, per call id. */
let payloads: Record<string, ToolPayload | null> = {};

beforeEach(() => {
  transport = new FakeTransport();
  payloads = {};
  transport.onCall(
    'tool_payload',
    (args) => payloads[String(args?.call)] ?? null,
  );
  setTransport(transport);
  store = new RootStore();
  forgetToolPayloads();
  runs += 1;
  RUN = `space-run-${runs}`;
});

afterEach(() => {
  m?.unmount();
  m = null;
});

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

const put = (s: Space) =>
  act(() => {
    store.sync.pool.put('space', s.id, s);
  });

const tool = (
  name: string,
  id: string,
  ok: boolean | null,
  target: string | null = null,
): TurnStep => ({ kind: 'tool', name, id, target, ok });

const payload = (
  input: Record<string, unknown>,
  result?: unknown,
  ok = true,
): ToolPayload => ({
  input: { value: input },
  result:
    result === undefined
      ? null
      : {
          ok,
          output: {
            text: typeof result === 'string' ? result : JSON.stringify(result),
          },
          stdout: null,
          stderr: null,
          exit_code: null,
          duration_ms: null,
        },
});

function tree(node: ReactNode) {
  return (
    <RootStoreProvider store={store}>
      <ToolRunContext.Provider value={RUN}>{node}</ToolRunContext.Provider>
    </RootStoreProvider>
  );
}

async function render(node: ReactNode) {
  m?.unmount();
  m = await mount(tree(node));
  await settle();
}

const row = () => m!.host.querySelector<HTMLElement>('.turn-space-tool')!;
const rows = () => [
  ...m!.host.querySelectorAll<HTMLElement>('.turn-space-tool'),
];
const line = (r: HTMLElement = row()) =>
  r.querySelector('.turn-tool-line')!.getAttribute('title');

describe('space_start', () => {
  it('the goal while it starts, then the child by name with its stage, live', async () => {
    const input = { goal: 'Port the parser', mode: 'edit' };
    payloads.x1 = payload(input);
    await render(
      <TimelineRows steps={[tool('start a sub-space', 'x1', null)]} running />,
    );
    expect(row().getAttribute('data-kind')).toBe('space');
    expect(line()).toBe('Starting a sub-space: Port the parser');
    expect(row().querySelector('.turn-space-name button')).toBeNull();

    put(space('c1', { title: 'Port parser', status: 'running', turns: 0 }));
    payloads.x1 = payload(input, { space: 'c1', title: 'Port the parser' });
    await render(
      <TimelineRows steps={[tool('start a sub-space', 'x1', true)]} running />,
    );
    expect(line()).toBe('Sub-space started: Port parser');
    const stage = () => row().querySelector('.turn-space-stage')!;
    expect(stage().textContent).toBe('running');
    expect(row().querySelector('.turn-tool-note')!.textContent).toBe('Edit');

    // The child moves on; the row follows without a new step.
    put(space('c1', { title: 'Port parser', status: 'idle', turns: 1 }));
    expect(stage().textContent).toBe('done');
    put(
      space('c1', {
        title: 'Port parser',
        turns: 1,
        shipped: {
          how: 'merged_into_parent',
          branch: 'theo/p',
          sha: 'h',
          head: 'h',
          pushes: 0,
          at: 1,
        },
      }),
    );
    expect(stage().textContent).toBe('merged');

    // The name opens the child; the row itself opens its details.
    await click(row().querySelector('.turn-space-name button'));
    expect(store.ui.route).toEqual({ name: 'space', id: 'c1' });
    expect(row().querySelector('.turn-tool-details')).toBeNull();
    await click(row().querySelector('.turn-tool-line'));
    await settle();
    expect(row().querySelector('.turn-tool-details')).not.toBeNull();
  });

  it('a turn stored before payloads still names the tool', async () => {
    await render(
      <TimelineRows
        steps={[tool('mcp__space-tools__space_start', 's', true)]}
      />,
    );
    expect(line()).toBe('Sub-space started');
  });
});

describe('space_wait', () => {
  it('counts the children it waits on as they move, then what settled', async () => {
    put(space('a', { title: 'A', status: 'running' }));
    put(space('b', { title: 'B', status: 'running' }));
    payloads.w1 = payload({ spaces: ['a', 'b'] });
    await render(
      <TimelineRows
        steps={[tool('wait for sub-spaces', 'w1', null)]}
        running
      />,
    );
    const note = () => row().querySelector('.turn-tool-note')?.textContent;
    expect(line()).toBe('Waiting for 2 sub-spaces');
    expect(note()).toBe('2 running');
    put(space('a', { title: 'A', status: 'idle' }));
    expect(note()).toBe('1 done · 1 running');

    payloads.w1 = payload(
      { spaces: ['a', 'b'] },
      { settled: ['a'], spaces: [{ space: 'a', title: 'A', status: 'idle' }] },
    );
    await render(
      <TimelineRows
        steps={[tool('wait for sub-spaces', 'w1', true)]}
        running
      />,
    );
    expect(line()).toBe('Waited for 2 sub-spaces');
    expect(note()).toBe('A done');
  });
});

describe('space_merge', () => {
  it('the child, its lines and conflicts; opened, each file', async () => {
    put(space('c1', { title: 'Port parser' }));
    payloads.g1 = payload(
      { space: 'c1' },
      {
        space: { space: 'c1', title: 'Port parser' },
        files: [
          { path: 'src/a.rs', additions: 10, deletions: 2 },
          { path: 'src/b.rs', additions: 3, deletions: 0 },
        ],
        additions: 13,
        deletions: 2,
        conflicts: ['src/b.rs'],
        note: 'Resolve the conflicts, then check.',
      },
    );
    await render(
      <TimelineRows steps={[tool('merge a sub-space', 'g1', true, 'c1')]} />,
    );
    expect(line()).toBe('Merged Port parser');
    expect(row().querySelector('.turn-added')!.textContent).toBe('+13');
    expect(row().querySelector('.turn-removed')!.textContent).toBe('−2');
    expect(row().querySelector('.turn-space-conflicts')!.textContent).toBe(
      '1 conflict to resolve',
    );
    await click(row().querySelector('.turn-tool-line'));
    await settle();
    const files = [...row().querySelectorAll('.turn-space-files li')];
    expect(files.map((f) => f.textContent)).toEqual([
      'src/a.rs+10−2',
      'src/b.rs+3−0conflict',
    ]);
    expect(row().textContent).toContain('Resolve the conflicts, then check.');
  });
});

describe('space_ask', () => {
  it('the question on the row, the answer when opened', async () => {
    put(space('s1', { title: 'Fix login' }));
    payloads.q1 = payload(
      { space: 's1', question: 'Which store holds sessions?' },
      { answer: 'Redis, via `SessionStore`.', agent: 'claude', how: 'fork' },
    );
    await render(
      <TimelineRows steps={[tool('ask a space', 'q1', true, 's1')]} />,
    );
    expect(line()).toBe('Asked Fix login: Which store holds sessions?');
    expect(row().querySelector('.turn-space-text')!.textContent).toBe(
      'Which store holds sessions?',
    );
    expect(row().querySelector('.turn-space-answer')).toBeNull();
    await click(row().querySelector('.turn-tool-line'));
    await settle();
    expect(row().querySelector('.turn-space-answer')!.textContent).toContain(
      'Redis',
    );
    expect(row().textContent).toContain('claude · fork');
  });
});

describe('a finished turn', () => {
  it('keeps what it did with other spaces in view; reads fold', async () => {
    const steps: TurnStep[] = [
      tool('Read', 'r1', true, 'a.rs'),
      tool('read a space', 'p1', true, 's1'),
      tool('list the spaces', 'p2', true),
      tool('start a sub-space', 's2', true),
      tool('Bash', 'b1', true, 'ls'),
      tool('Bash', 'b2', true, 'pwd'),
      tool('Bash', 'b3', true, 'cargo test'),
      tool('merge a sub-space', 'g2', true, 'c9'),
      { kind: 'text', text: 'Done.' },
    ];
    await render(<TurnActivity reply="rep-space" steps={steps} />);
    expect(rows().map((r) => r.getAttribute('data-tool'))).toEqual([
      'start',
      'merge',
    ]);
    const folds = m!.host.querySelectorAll('.turn-fold');
    expect(folds).toHaveLength(2);
  });
});
