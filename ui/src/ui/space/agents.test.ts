import { describe, expect, it } from 'vitest';
import type {
  BackgroundTask,
  ChatMessage,
  Space,
  TurnStep,
} from '../../gen/contract';
import { modelName } from '../agentModel';
import {
  backgroundRows,
  spaceBusy,
  stripHeadline,
  subagentElapsed,
  subagentStatusLabel,
  subagentsOf,
  turnSource,
} from './agents';
import { spaceChatKey } from './spaces';
import { childStage, type ChildStage } from './subspaces';

const agent = (
  id: string,
  over: Partial<Extract<TurnStep, { kind: 'tool' }>> = {},
): TurnStep => ({
  kind: 'tool',
  name: 'Agent',
  target: null,
  ok: null,
  id,
  detail: `Agent ${id}`,
  ...over,
});

const task = (over: Partial<BackgroundTask>): BackgroundTask => ({
  id: 't',
  kind: 'subagent',
  description: 'x',
  started_at: 100,
  status: 'running',
  ...over,
});

describe('subagents of a turn', () => {
  const steps: TurnStep[] = [
    { kind: 'text', text: 'Looking around.' },
    agent('a1', { ok: true }),
    {
      kind: 'tool',
      name: 'Read',
      target: 'a.rs',
      ok: true,
      id: 'r1',
      parent: 'a1',
    },
    agent('a2'),
    agent('a3', { ok: false }),
    // A subagent's own subagent stays in its row.
    agent('nested', { parent: 'a2' }),
    { kind: 'tool', name: 'Bash', target: 'ls', ok: null, id: 'b1' },
    agent('bg', { ok: true, background: true }),
  ];

  it('lists only top-level Agent/Task calls, with where each stands', () => {
    const list = subagentsOf(steps, { running: true });
    expect(list.map((a) => [a.call, a.status])).toEqual([
      ['a1', 'done'],
      ['a2', 'running'],
      ['a3', 'failed'],
      ['bg', 'background'],
    ]);
    expect(list[0]!.description).toBe('Agent a1');
  });

  it('a finished turn: done, unless its background task still runs', () => {
    const list = subagentsOf(steps, {
      running: false,
      tasks: [task({ call: 'bg', started_at: 50 })],
    });
    expect(list.map((a) => a.status)).toEqual([
      'done',
      'done',
      'failed',
      'background',
    ]);
    expect(list[3]!.startedAt).toBe(50);
    expect(subagentElapsed(list[3]!, 1050)).toBe(1000);
  });

  it('times a subagent from what this window saw, else not at all', () => {
    const list = subagentsOf([agent('a1', { ok: true }), agent('a2')], {
      running: true,
      times: (call) =>
        call === 'a1' ? { start: 10, end: 70 } : { start: 40, end: null },
    });
    expect(subagentElapsed(list[0]!, 999)).toBe(60);
    expect(subagentElapsed(list[1]!, 100)).toBe(60);
    const untimed = subagentsOf([agent('a1', { ok: true })], {
      running: false,
    });
    expect(subagentElapsed(untimed[0]!, 999)).toBeNull();
  });

  it("a background one's row says how its task ended", () => {
    const [bg] = subagentsOf([agent('bg', { ok: true, background: true })], {
      running: false,
      tasks: [task({ call: 'bg', status: 'lost', ended_at: 200 })],
    });
    expect(bg!.task?.status).toBe('lost');
    expect(subagentStatusLabel(bg!)).toBe('lost');
    const [live] = subagentsOf([agent('bg', { background: true })], {
      running: false,
      tasks: [task({ call: 'bg' })],
    });
    expect(subagentStatusLabel(live!)).toBe('running in background');
    const [plain] = subagentsOf([agent('a1', { ok: false })], {
      running: false,
    });
    expect(subagentStatusLabel(plain!)).toBe('failed');
  });
});

describe('the strip', () => {
  const cmd = (over: Partial<BackgroundTask>) =>
    task({ kind: 'command', description: 'pnpm dev', ...over });
  const steps: TurnStep[] = [
    agent('a1', { ok: true }),
    agent('bg', { background: true }),
  ];

  it('lists a background subagent of the turn once: as its turn row', () => {
    const tasks = [
      task({ id: 't1', call: 'bg' }),
      task({ id: 't2', call: 'old', description: 'an earlier turn' }),
      cmd({ id: 't3', call: 'c1' }),
    ];
    const agents = subagentsOf(steps, { running: false, tasks });
    expect(agents.map((a) => [a.call, a.task?.id ?? null])).toEqual([
      ['a1', null],
      ['bg', 't1'],
    ]);
    expect(backgroundRows(tasks, agents).map((t) => t.id)).toEqual([
      't2',
      't3',
    ]);
    // With no turn listed, every task is a Background row.
    expect(backgroundRows(tasks, []).map((t) => t.id)).toEqual([
      't1',
      't2',
      't3',
    ]);
  });

  it('says it all in one line', () => {
    const subs: ChildStage[] = ['running', 'done'];
    const turn = subagentsOf(steps, { running: false });
    expect(turn.map((a) => a.status)).toEqual(['done', 'done']);
    expect(stripHeadline(turn, [], [])).toBe('2 agents');
    expect(stripHeadline(turn, [cmd({})], subs.slice(1))).toBe(
      '2 agents · 1 sub-space · 1 command running',
    );
    // A background subagent counts as an agent; a running one runs.
    expect(
      stripHeadline(turn, [task({}), cmd({}), cmd({ id: 'c2' })], subs),
    ).toBe('1 agent running · 2 sub-spaces, 1 running · 2 commands running');
    expect(stripHeadline([], [], ['done'])).toBe('1 sub-space');
    // Merged ones: how many of them, while one still runs or not; one
    // waiting for you runs.
    expect(stripHeadline([], [], ['merged', 'merged', 'asking'])).toBe(
      '3 sub-spaces, 1 running, 2 of 3 merged',
    );
    // Merged, then changed since: not counted.
    const changed = childStage({
      status: 'idle',
      question: null,
      turns: 2,
      head_sha: 'h2',
      shipped: { how: 'merged_into_parent', head: 'h' } as Space['shipped'],
    });
    expect(stripHeadline([], [], [changed])).toBe('1 sub-space');
    // Ended commands: the worst outcome, else that they ended.
    expect(
      stripHeadline([], [cmd({ status: 'lost' }), cmd({ status: 'cut' })], []),
    ).toBe('1 command lost');
    expect(stripHeadline([], [cmd({ status: 'cut' })], [])).toBe(
      '1 command cut off',
    );
    expect(stripHeadline([], [cmd({ status: 'completed' })], [])).toBe(
      '1 command ended',
    );
  });
});

describe("a model's name", () => {
  const m = (id: string, label: string, older = false) => ({
    id,
    label,
    description: null,
    efforts: [],
    default_effort: null,
    older,
  });
  const catalog = [
    m('claude-opus-5-5', 'Opus 5.5'),
    m('claude-sonnet-5', 'Sonnet 5'),
    m('claude-opus-5', 'Opus 5', true),
  ];

  it('reads the catalog, an alias as its newest, else the id', () => {
    expect(modelName(catalog, 'claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelName(catalog, 'claude-opus-5')).toBe('Opus 5');
    expect(modelName(catalog, 'opus')).toBe('Opus 5.5');
    expect(modelName(catalog, 'claude-haiku-5-5')).toBe('claude-haiku-5-5');
    expect(modelName(undefined, 'claude-opus-5-5')).toBe('claude-opus-5-5');
  });
});

const msg = (id: string, over: Partial<ChatMessage>): ChatMessage => ({
  id,
  pr: spaceChatKey('s'),
  author: { kind: 'me' },
  text: '',
  refs: [],
  at: 1,
  failed: null,
  ...over,
});

describe('the turn the panel reads', () => {
  const reply = (id: string, at: number, activity: TurnStep[]) =>
    msg(id, {
      author: { kind: 'agent', agent: 'claude' },
      at,
      activity,
      run: `space:s:${id}`,
    });

  it('a running turn: its live steps, in the last row', () => {
    const live = [agent('x')];
    const src = turnSource(
      { status: 'running', run: 'r9' },
      [msg('m1', { at: 1 }), reply('p1', 2, []), msg('m2', { at: 3 })],
      (run) => (run === 'r9' ? live : undefined),
      (id) => (id === 'm2' ? 'k2' : id),
    );
    expect(src).toEqual({ run: 'r9', turn: 'k2', steps: live, running: true });
  });

  it('else the last reply with steps, and the row it is in', () => {
    const steps = [agent('y', { ok: true })];
    const src = turnSource(
      { status: 'idle', run: null },
      [
        msg('m1', { at: 1 }),
        reply('p1', 2, steps),
        msg('m2', { at: 3 }),
        reply('p2', 4, []),
      ],
      () => undefined,
    );
    expect(src).toEqual({
      run: 'space:s:p1',
      turn: 'm1',
      steps,
      running: false,
    });
    expect(turnSource({ status: 'idle' }, [], () => undefined)).toBeNull();
  });
});

describe('a busy space', () => {
  const s = (id: string, over: Partial<Space> = {}): Space =>
    ({ id, status: 'idle', updated_at: 0, ...over }) as Space;

  it('a background task counts as busy, an ended one not', () => {
    expect(spaceBusy(s('a', { background_tasks: [task({})] }))).toBe(true);
    expect(
      spaceBusy(s('a', { background_tasks: [task({ status: 'completed' })] })),
    ).toBe(false);
  });
});
